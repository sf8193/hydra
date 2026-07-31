import { parseDuration } from './util.js'
import { createStateMachine, type TransitionTable } from './state-machine.js'
import type { PhaseBehaviorFn, RunState } from './protocol-types.js'
import { mechanicsBlock } from './prompts/mechanics.js'

export type { PhaseBehaviorFn, RunState, BehaviorContext } from './protocol-types.js'
export { mechanicsBlock }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoleDef = Record<string, string>

type PhaseTransitions = Record<string, string>

export type PhaseBehaviorName = 'killNonOwner' | 'backstopTimer' | 'notifyOwnerSummary'
export type PhaseBehavior = PhaseBehaviorName | PhaseBehaviorFn

type PhaseDef = {
  // Singular: one actor per phase. Fan-out (parallel actors) requires actor: string | string[]
  // with concurrent token tracking — the flat FSM becomes a Petri net. Known ceiling.
  actor: string
  half?: 'top' | 'bottom'
  on: PhaseTransitions
  replyEvent?: string
  finalRoundEvent?: string
  onEnter?: PhaseBehavior[]
}

type WindowDef = Record<string, string>
type GraceDef = Record<string, string>

export type RoleConfig = {
  cadence: 'one-message' | 'per-round' | 'per-phase'
  waits: boolean
  orient?: string
}

const DEFAULT_ROLE_CONFIG: Readonly<RoleConfig> = Object.freeze({ cadence: 'per-round', waits: false })

export type PhaseInteraction = {
  mode: 'sentinel' | 'decide' | 'both'
  tag?: string
}

export type SeedContext = {
  name: string
  sessionId: string
  threadId: string
  rounds: number
  topic?: string
  task?: string
  model?: string
  protocol: Protocol
  [key: string]: unknown
}

type SeedFn = (ctx: SeedContext) => string

export type ProtocolSpec<
  Roles extends RoleDef = RoleDef,
  Phases extends Record<string, PhaseDef> = Record<string, PhaseDef>,
> = {
  emoji: string
  display: string
  roles: Roles
  phases: Phases
  windows: WindowDef
  grace?: GraceDef
  sentinels?: Record<string, string>
  owner?: keyof Roles & string
  initialPhase?: keyof Phases & string
  cleanupPhase?: keyof Phases & string
  cancelPhase?: keyof Phases & string
  decisions?: Record<string, {
    phase: string
    actor: string
    options: readonly string[]
    descriptions?: Partial<Record<string, string>>
    events?: Record<string, string>
    finalEvent?: string
  }>
  roleConfig?: Partial<Record<keyof Roles & string, Partial<RoleConfig>>>
  seed?: Partial<Record<keyof Roles, SeedFn>>
  initState?: (params: Record<string, unknown>) => Record<string, unknown>
  summaryFormat?: (run: RunState) => string[]
  ownerKickoff?: (params: Record<string, unknown>) => string
  decisionContext?: (run: RunState) => string | undefined
  turnNotification?: (run: RunState, prevContent: string) => string
}

export type Protocol<
  Phase extends string = string,
  Event extends string = string,
> = {
  name: string
  emoji: string
  display: string
  roles: RoleDef
  phases: Record<string, PhaseDef>
  initialPhase: Phase
  cleanupPhase?: string
  cancelPhase?: string
  machine: ReturnType<typeof createStateMachine<Phase, Event>>
  windowMs: (phase: string) => number | undefined
  graceMs: (role: string) => number | undefined
  sentinel: (phase: string) => string | undefined
  ownerRole: string
  decisions: Record<string, { phase: string; actor: string; options: readonly string[]; descriptions?: Partial<Record<string, string>>; events?: Record<string, string>; finalEvent?: string }>
  phaseInteraction: (phase: string) => PhaseInteraction | undefined
  roleConfig: (role: string) => RoleConfig
  seed: (role: string, ctx: Omit<SeedContext, 'protocol'> & { protocol?: Protocol }) => string | undefined
  initState: (params: Record<string, unknown>) => Record<string, unknown>
  summaryFormat: (run: RunState) => string[]
  ownerKickoff: ((params: Record<string, unknown>) => string) | undefined
  decisionContext: ((run: RunState) => string | undefined) | undefined
  turnNotification: ((run: RunState, prevContent: string) => string) | undefined
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function protocol<
  R extends RoleDef,
  P extends Record<string, PhaseDef>,
>(name: string, spec: ProtocolSpec<R, P>): Protocol {
  const phaseNames = Object.keys(spec.phases)
  const roleNames = Object.keys(spec.roles)

  if (phaseNames.length === 0) throw new Error(`protocol "${name}": at least one phase required`)
  if (roleNames.length === 0) throw new Error(`protocol "${name}": at least one role required`)

  // Validate actors reference real roles
  for (const [phaseName, phase] of Object.entries(spec.phases)) {
    if (!roleNames.includes(phase.actor)) {
      throw new Error(`protocol "${name}": phase "${phaseName}" actor "${phase.actor}" is not a declared role`)
    }
    for (const [event, target] of Object.entries(phase.on)) {
      if (!phaseNames.includes(target)) {
        throw new Error(`protocol "${name}": phase "${phaseName}" event "${event}" → "${target}" targets an unknown phase`)
      }
    }
  }

  // Build transition table + validate cancel transitions
  const hasCancelEvent = Object.values(spec.phases).some(p => 'cancel' in p.on)
  if (hasCancelEvent && !spec.cancelPhase) {
    throw new Error(`protocol "${name}": phases declare cancel events but no cancelPhase is set`)
  }

  const table: Record<string, Record<string, string>> = {}
  for (const [phaseName, phase] of Object.entries(spec.phases)) {
    table[phaseName] = { ...phase.on }
    const isTerminal = Object.keys(phase.on).length === 0
    if (!isTerminal && !phase.on.cancel && !phase.on.timeout) {
      process.stderr.write(`protocol "${name}": warning — phase "${phaseName}" has no cancel or timeout transition\n`)
    }
  }

  // Parse windows
  const windows = new Map<string, number>()
  for (const [phase, dur] of Object.entries(spec.windows)) {
    if (!phaseNames.includes(phase)) throw new Error(`protocol "${name}": window on unknown phase "${phase}"`)
    const ms = parseDuration(dur)
    if (ms == null) throw new Error(`protocol "${name}": invalid duration "${dur}" for phase "${phase}"`)
    windows.set(phase, ms)
  }

  // Parse grace
  const grace = new Map<string, number>()
  for (const [role, dur] of Object.entries(spec.grace ?? {})) {
    if (!roleNames.includes(role)) throw new Error(`protocol "${name}": grace for unknown role "${role}"`)
    const ms = parseDuration(dur)
    if (ms == null) throw new Error(`protocol "${name}": invalid grace duration "${dur}" for role "${role}"`)
    grace.set(role, ms)
  }

  // Validate decisions
  const decisions = spec.decisions ?? {}
  const phaseDecisionCount = new Map<string, string>()
  for (const [decName, dec] of Object.entries(decisions)) {
    if (!phaseNames.includes(dec.phase)) throw new Error(`protocol "${name}": decision "${decName}" references unknown phase "${dec.phase}"`)
    if (!roleNames.includes(dec.actor)) throw new Error(`protocol "${name}": decision "${decName}" references unknown role "${dec.actor}"`)
    const existing = phaseDecisionCount.get(dec.phase)
    if (existing) throw new Error(`protocol "${name}": phase "${dec.phase}" has multiple decisions ("${existing}" and "${decName}")`)
    phaseDecisionCount.set(dec.phase, decName)
    if (dec.descriptions) {
      for (const key of Object.keys(dec.descriptions)) {
        if (!dec.options.includes(key)) throw new Error(`protocol "${name}": decision "${decName}" description key "${key}" is not a declared option`)
      }
    }
  }

  // Parse roleConfig
  const roleConfigs = new Map<string, RoleConfig>()
  for (const [role, cfg] of Object.entries(spec.roleConfig ?? {})) {
    if (!roleNames.includes(role)) throw new Error(`protocol "${name}": roleConfig for unknown role "${role}"`)
    const resolved = { ...DEFAULT_ROLE_CONFIG, ...cfg }
    if (resolved.cadence === 'per-phase' && !resolved.orient) {
      throw new Error(`protocol "${name}": roleConfig for "${role}" has cadence "per-phase" but no orient`)
    }
    roleConfigs.set(role, resolved)
  }

  const ownerRole = spec.owner ?? roleNames[roleNames.length - 1]
  if (!roleNames.includes(ownerRole)) throw new Error(`protocol "${name}": owner role "${ownerRole}" is not a declared role`)

  const initialPhase = (spec.initialPhase as string) ?? phaseNames[0]
  if (!phaseNames.includes(initialPhase)) throw new Error(`protocol "${name}": initialPhase "${initialPhase}" is not a declared phase`)

  if (spec.cleanupPhase && !phaseNames.includes(spec.cleanupPhase as string)) {
    throw new Error(`protocol "${name}": cleanupPhase "${spec.cleanupPhase}" is not a declared phase`)
  }

  if (spec.cancelPhase && !phaseNames.includes(spec.cancelPhase as string)) {
    throw new Error(`protocol "${name}": cancelPhase "${spec.cancelPhase}" is not a declared phase`)
  }

  if (spec.sentinels) {
    for (const phase of Object.keys(spec.sentinels)) {
      if (!phaseNames.includes(phase)) throw new Error(`protocol "${name}": sentinel on unknown phase "${phase}"`)
    }
  }

  if (spec.cleanupPhase) {
    const cleanupKey = spec.cleanupPhase as keyof P
    const cleanupDef = spec.phases[cleanupKey] as (PhaseDef & { onEnter?: string[] }) | undefined
    if (cleanupDef && !cleanupDef.onEnter) {
      ;(spec.phases as Record<string, PhaseDef>)[cleanupKey as string] = { ...cleanupDef, onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] }
    }
  }

  // Pre-compute phase interaction classification — the single derivation
  // consumed by resolveEvent, onRunReply, expectedTag, protocolSeed, and warnings.
  const interactions = new Map<string, PhaseInteraction>()
  for (const phaseName of phaseNames) {
    const phaseDef = (spec.phases as Record<string, PhaseDef>)[phaseName]
    if (!phaseDef || Object.keys(phaseDef.on).length === 0) continue

    const sentinel = spec.sentinels?.[phaseName]
    const decision = Object.values(decisions).find(d => d.phase === phaseName)

    if (decision) {
      const decisionEvents = new Set(Object.values(decision.events ?? {}))
      if (decision.finalEvent) decisionEvents.add(decision.finalEvent)
      const replyCoexists = phaseDef.replyEvent && !decisionEvents.has(phaseDef.replyEvent)

      if (replyCoexists) {
        interactions.set(phaseName, { mode: 'both', tag: sentinel })
      } else {
        interactions.set(phaseName, { mode: 'decide', tag: sentinel })
      }
    } else if (sentinel) {
      if (!phaseDef.replyEvent) {
        throw new Error(`protocol "${name}": phase "${phaseName}" has sentinel "${sentinel}" but no replyEvent or decision — the sentinel would be inert`)
      }
      interactions.set(phaseName, { mode: 'sentinel', tag: sentinel })
    }
  }


  const built: Protocol = {
    name,
    emoji: spec.emoji,
    display: spec.display,
    roles: spec.roles,
    phases: spec.phases as Record<string, PhaseDef>,
    initialPhase,
    cleanupPhase: spec.cleanupPhase as string | undefined,
    cancelPhase: spec.cancelPhase as string | undefined,
    ownerRole,
    machine: createStateMachine(name, table as TransitionTable<string, string>),
    windowMs: (phase: string) => windows.get(phase),
    graceMs: (role: string) => grace.get(role),
    sentinel: (phase: string) => spec.sentinels?.[phase],
    decisions,
    phaseInteraction: (phase: string) => interactions.get(phase),
    roleConfig: (role: string) => roleConfigs.get(role) ?? DEFAULT_ROLE_CONFIG,
    seed: (role: string, ctx: Omit<SeedContext, 'protocol'> & { protocol?: Protocol }) => {
      const fullCtx: SeedContext = { ...ctx, protocol: ctx.protocol ?? built }
      const fn = spec.seed?.[role as keyof R]
      if (fn) return fn(fullCtx)
      // Default: generate from protocol declarations when the role has sentinels or decisions
      const hasSentinels = Object.entries(built.phases).some(([p, def]) => def.actor === role && built.phaseInteraction(p)?.tag)
      const hasDecisions = Object.values(decisions).some(d => d.actor === role)
      if (hasSentinels || hasDecisions) {
        return protocolSeed(built, role, fullCtx)
      }
      return undefined
    },
    initState: spec.initState ?? (() => ({})),
    summaryFormat: spec.summaryFormat ?? ((run) => [
      `**${spec.emoji} ${spec.display} Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
      ``,
      `Post your closing summary.`,
    ]),
    ownerKickoff: spec.ownerKickoff ?? undefined,
    decisionContext: spec.decisionContext ?? undefined,
    turnNotification: spec.turnNotification ?? undefined,
  }
  return Object.freeze(built)
}

// ---------------------------------------------------------------------------
// Protocol-derived seed generation
// ---------------------------------------------------------------------------

export function protocolSeed(proto: Protocol, role: string, ctx: SeedContext): string {
  const cfg = proto.roleConfig(role)

  // Derive sentinel tags from phaseInteraction for phases where this role acts
  const actorPhases = Object.entries(proto.phases)
    .filter(([, def]) => def.actor === role)
    .map(([phase]) => { const ia = proto.phaseInteraction(phase); return { phase, tag: ia?.tag } })
    .filter((t): t is { phase: string; tag: string } => !!t.tag)

  if (actorPhases.length === 0) {
    const roleDecisions = Object.values(proto.decisions).filter(d => d.actor === role)
    if (roleDecisions.length === 0) {
      throw new Error(`protocolSeed: role "${role}" has no sentinels and no decisions in protocol "${proto.name}"`)
    }
  }

  const tag: string | ReadonlyArray<{ phase: string; tag: string }> | undefined =
    actorPhases.length === 0 ? undefined :
    actorPhases.length === 1 ? actorPhases[0].tag : actorPhases

  const block = mechanicsBlock({
    tmuxName: ctx.name,
    role,
    protocol: `${ctx.rounds}-round ${proto.display.toLowerCase()}`,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    tag,
    cadence: cfg.cadence,
    waits: cfg.waits ? true : undefined,
    orient: cfg.orient,
  })

  // Derive decide instructions from protocol decisions targeting this role.
  // A role may have decisions in multiple phases — generate instructions for all.
  const roleDecisions = Object.values(proto.decisions).filter(d => d.actor === role)
  if (roleDecisions.length === 0) return block

  const sections: string[] = []
  for (const dec of roleDecisions) {
    const ia = proto.phaseInteraction(dec.phase)
    const optionLines = dec.options.map(o => {
      const desc = dec.descriptions?.[o]
      return desc ? `- \`decide('${o}', '${desc}')\`` : `- \`decide('${o}', 'reason')\``
    }).join('\n')

    if (ia?.mode === 'both' && ia.tag) {
      sections.push(`Post \`${ia.tag}\` for progress. When ready to advance, use the \`decide\` tool:\n${optionLines}`)
    } else {
      const sentinelTag = ia?.tag
      const sentinelNote = sentinelTag
        ? `\nPosting \`${sentinelTag}\` alone does NOT advance — the \`decide\` call is required.`
        : ''
      sections.push(`You MUST use the \`decide\` tool to advance the protocol:\n${optionLines}${sentinelNote}`)
    }
  }

  return block + `\n\n**How to advance:** ${sections.join('\n\n')}`
}
