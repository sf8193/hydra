import { parseDuration } from './util.js'
import { createStateMachine, type TransitionTable } from './state-machine.js'
import type { PhaseBehaviorFn, RunState } from './protocol-types.js'

export type { PhaseBehaviorFn, RunState, BehaviorContext } from './protocol-types.js'
export { mechanicsBlock } from './prompts/mechanics.js'

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

export type SeedContext = {
  name: string
  sessionId: string
  threadId: string
  rounds: number
  topic?: string
  task?: string
  model?: string
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
    events?: Record<string, string>
    finalEvent?: string
  }>
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
  decisions: Record<string, { phase: string; actor: string; options: readonly string[]; events?: Record<string, string>; finalEvent?: string }>
  seed: (role: string, ctx: SeedContext) => string | undefined
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
  for (const [decName, dec] of Object.entries(decisions)) {
    if (!phaseNames.includes(dec.phase)) throw new Error(`protocol "${name}": decision "${decName}" references unknown phase "${dec.phase}"`)
    if (!roleNames.includes(dec.actor)) throw new Error(`protocol "${name}": decision "${decName}" references unknown role "${dec.actor}"`)
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
    const cleanupDef = spec.phases[spec.cleanupPhase as keyof P] as PhaseDef | undefined
    if (cleanupDef && !cleanupDef.onEnter) {
      (cleanupDef as any).onEnter = ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary']
    }
  }

  return Object.freeze({
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
    seed: (role: string, ctx: SeedContext) => spec.seed?.[role as keyof R]?.(ctx),
    initState: spec.initState ?? (() => ({})),
    summaryFormat: spec.summaryFormat ?? ((run) => [
      `**${spec.emoji} ${spec.display} Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
      ``,
      `Post your closing summary.`,
    ]),
    ownerKickoff: spec.ownerKickoff ?? undefined,
    decisionContext: spec.decisionContext ?? undefined,
    turnNotification: spec.turnNotification ?? undefined,
  })
}
