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
  advanceEvent?: string
  finalAdvanceEvent?: string
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
  verdict: 'none' | 'required' | 'optional'
  options?: readonly string[]
  descriptions?: Partial<Record<string, string>>
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
  owner?: keyof Roles & string
  initialPhase?: keyof Phases & string
  cleanupPhase?: keyof Phases & string
  cancelPhase?: keyof Phases & string
  // What a protocol gives up when the fallback path runs instead of the normal
  // one, in the protocol's own words — e.g. "subagent self-review (no
  // adversarial tension)". Rides on every non-normal CompletionEvent so a
  // consumer can tell the caller what the result is worth without knowing
  // anything about this protocol. Required once a protocol opts into fallback.
  fallbackDegradation?: string
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
  summaryFormat?: (run: RunState) => string[]
  notifications?: {
    onKickoff?: Partial<Record<keyof Roles & string, (run: RunState) => string | null>>
    onTurn?: (run: RunState, prevContent: string) => string
    onPhaseChange?: (run: RunState, from: string, to: string) => string
    onDisconnect?: (run: RunState, role: string, reason: string) => string
    onExit?: (run: RunState, outcome: 'complete' | 'cancelled', reason?: string) => string
    onFallback?: (run: RunState, ctx: FallbackContext) => string
  }
}

// Passed to notifications.onFallback — the runner-computed context a protocol
// needs to compose its fallback instructions without reaching into RunState
// internals it can't see (the dead participant's label, resume attempts).
//
// Three shapes, because there are three ways to reach the same owner-run phase,
// and each knows a different amount. A union rather than optional fields: the
// hook should not be able to render a fact the path never had.
//
//   death   — the participant exited and auto-resume is exhausted. Only here is
//             `resumeAttempts` a number anyone should print.
//   silence — the participant is alive but its phase window elapsed with nothing
//             posted. The runner retires it the same way, but it did not die,
//             and saying so in the thread would misstate the run's central event.
//   direct  — the caller asked for the owner-run phase up front (`+subagent`).
//             There is no participant at all, hence no role to name.
export type FallbackContext =
  | {
      mode: 'fallback'
      cause: 'death'
      deadRole: string
      deadLabel: string
      resumeAttempts: number
      completedRounds: number
    }
  | {
      mode: 'fallback'
      cause: 'silence'
      deadRole: string
      deadLabel: string
      completedRounds: number
    }
  | { mode: 'direct' }

/** Why a run left the normal path for the fallback phase. */
export type FallbackCause = 'death' | 'silence'

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
  fallbackDegradation?: string
  machine: ReturnType<typeof createStateMachine<Phase, Event>>
  windowMs: (phase: string) => number | undefined
  graceMs: (role: string) => number | undefined
  ownerRole: string
  decisions: Record<string, { phase: string; actor: string; options: readonly string[]; descriptions?: Partial<Record<string, string>>; events?: Record<string, string>; finalEvent?: string }>
  phaseInteraction: (phase: string) => PhaseInteraction | undefined
  roleConfig: (role: string) => RoleConfig
  seed: (role: string, ctx: Omit<SeedContext, 'protocol'> & { protocol?: Protocol }) => string | undefined
  summaryFormat: (run: RunState) => string[]
  notifications: {
    onKickoff?: Partial<Record<string, (run: RunState) => string | null>>
    onTurn?: (run: RunState, prevContent: string) => string
    onPhaseChange?: (run: RunState, from: string, to: string) => string
    onDisconnect?: (run: RunState, role: string, reason: string) => string
    onExit?: (run: RunState, outcome: 'complete' | 'cancelled', reason?: string) => string
    onFallback?: (run: RunState, ctx: FallbackContext) => string
  }
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

  // Fallback is a three-part opt-in, and a partial one is dead config: the
  // runner will not fire a fallback without the owner instructions, and a
  // degraded completion has nothing to call itself without the label. Both
  // halves are refused at registration for the same reason cancel-events-without
  // -a-cancelPhase is, a few lines down — a transition that can never fire is a
  // claim the protocol makes and cannot keep.
  const hasFallbackTransition = Object.values(spec.phases).some(p => 'fallback' in p.on)
  if (hasFallbackTransition && !spec.notifications?.onFallback) {
    throw new Error(`protocol "${name}": declares an on.fallback transition but no notifications.onFallback — the runner requires the hook to fire a fallback, so the transition could never be taken`)
  }
  if (hasFallbackTransition && !spec.fallbackDegradation) {
    throw new Error(`protocol "${name}": declares an on.fallback transition but no fallbackDegradation — a fallback completion would have no name for what it gave up`)
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

  if (spec.cleanupPhase) {
    const cleanupKey = spec.cleanupPhase as keyof P
    const cleanupDef = spec.phases[cleanupKey] as (PhaseDef & { onEnter?: string[] }) | undefined
    if (cleanupDef && !cleanupDef.onEnter) {
      ;(spec.phases as Record<string, PhaseDef>)[cleanupKey as string] = { ...cleanupDef, onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] }
    }
  }

  // Pre-compute phase interaction classification — the single derivation
  // consumed by resolveAdvanceEvent, onRunAdvance, protocolSeed, and warnings.
  const interactions = new Map<string, PhaseInteraction>()
  for (const phaseName of phaseNames) {
    const phaseDef = (spec.phases as Record<string, PhaseDef>)[phaseName]
    if (!phaseDef || Object.keys(phaseDef.on).length === 0) continue

    const decisionEntry = Object.entries(decisions).find(([, d]) => d.phase === phaseName)
    const decision = decisionEntry?.[1]

    if (decision) {
      if (decision.actor !== phaseDef.actor) {
        throw new Error(`protocol "${name}": decision "${decisionEntry![0]}" actor "${decision.actor}" does not match phase "${phaseName}" actor "${phaseDef.actor}"`)
      }

      const decisionEvents = new Set(Object.values(decision.events ?? {}))
      if (decision.finalEvent) decisionEvents.add(decision.finalEvent)
      const advanceCoexists = phaseDef.advanceEvent && !decisionEvents.has(phaseDef.advanceEvent)

      if (advanceCoexists) {
        interactions.set(phaseName, { verdict: 'optional', options: decision.options, descriptions: decision.descriptions })
      } else {
        interactions.set(phaseName, { verdict: 'required', options: decision.options, descriptions: decision.descriptions })
      }
    } else if (phaseDef.advanceEvent) {
      interactions.set(phaseName, { verdict: 'none' })
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
    fallbackDegradation: spec.fallbackDegradation,
    ownerRole,
    machine: createStateMachine(name, table as TransitionTable<string, string>),
    windowMs: (phase: string) => windows.get(phase),
    graceMs: (role: string) => grace.get(role),
    decisions,
    phaseInteraction: (phase: string) => interactions.get(phase),
    roleConfig: (role: string) => roleConfigs.get(role) ?? DEFAULT_ROLE_CONFIG,
    seed: (role: string, ctx: Omit<SeedContext, 'protocol'> & { protocol?: Protocol }) => {
      const fullCtx: SeedContext = { ...ctx, protocol: ctx.protocol ?? built }
      const fn = spec.seed?.[role as keyof R]
      if (fn) return fn(fullCtx)
      // Default: generate from protocol declarations when the role has active phases
      const hasAdvancePhases = Object.entries(built.phases).some(([p, def]) => def.actor === role && built.phaseInteraction(p))
      if (hasAdvancePhases) {
        return protocolSeed(built, role, fullCtx)
      }
      return undefined
    },
    summaryFormat: spec.summaryFormat ?? ((run) => [
      `**${spec.emoji} ${spec.display} Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
      ``,
      `Post your closing summary.`,
    ]),
    notifications: spec.notifications ?? {},
  }
  return Object.freeze(built)
}

// ---------------------------------------------------------------------------
// Protocol-derived seed generation
// ---------------------------------------------------------------------------

export function protocolSeed(proto: Protocol, role: string, ctx: SeedContext): string {
  const cfg = proto.roleConfig(role)

  const block = mechanicsBlock({
    tmuxName: ctx.name,
    role,
    protocol: `${ctx.rounds}-round ${proto.display.toLowerCase()}`,
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    cadence: cfg.cadence,
    waits: cfg.waits ? true : undefined,
    orient: cfg.orient,
  })

  // Derive advance() instructions from phase interactions and decisions.
  const sections: string[] = []

  const actorPhases = Object.entries(proto.phases)
    .filter(([, def]) => def.actor === role)
    .map(([phase]) => ({ phase, ia: proto.phaseInteraction(phase) }))
    .filter((t): t is { phase: string; ia: PhaseInteraction } => !!t.ia)

  const formatVerdictOptions = (options: readonly string[], descriptions?: Partial<Record<string, string>>) =>
    options.map(o => {
      const desc = descriptions?.[o]
      return desc ? `  - \`advance({ content: "...", verdict: "${o}" })\` — ${desc}` : `  - \`advance({ content: "...", verdict: "${o}" })\``
    }).join('\n')

  for (const { phase, ia } of actorPhases) {
    if (ia.verdict === 'optional' && ia.options) {
      sections.push(`**${phase}:** Call \`advance({ content: "your progress" })\` for checkpoints. To finish:\n${formatVerdictOptions(ia.options, ia.descriptions)}`)
    } else if (ia.verdict === 'required' && ia.options) {
      sections.push(`**${phase}:** You MUST include a verdict:\n${formatVerdictOptions(ia.options, ia.descriptions)}`)
    } else if (ia.verdict === 'none') {
      sections.push(`**${phase}:** Call \`advance({ content: "your deliverable" })\` to post and advance.`)
    }
  }

  if (sections.length === 0) return block

  return block + `\n\n**How to advance:** Use the \`advance\` tool — it posts your deliverable to the thread AND fires the protocol transition. \`reply()\` is conversational only; it never advances the protocol.\n\n${sections.join('\n\n')}`
}
