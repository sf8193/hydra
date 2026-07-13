import { parseDuration } from './util.js'
import { createStateMachine, type TransitionTable } from './state-machine.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoleDef = Record<string, string>

type PhaseTransitions = Record<string, string>

type PhaseDef = {
  actor: string
  half?: 'top' | 'bottom'
  on: PhaseTransitions
}

type WindowDef = Record<string, string>
type GraceDef = Record<string, string>

type SeedContext = {
  name: string
  sessionId: string
  threadId: string
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
  decisions?: Record<string, {
    phase: string
    actor: string
    options: readonly string[]
  }>
  seed?: Partial<Record<keyof Roles, SeedFn>>
  completion?: readonly string[]
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
  machine: ReturnType<typeof createStateMachine<Phase, Event>>
  windowMs: (phase: string) => number | undefined
  graceMs: (role: string) => number | undefined
  sentinel: (phase: string) => string | undefined
  decisions: Record<string, { phase: string; actor: string; options: readonly string[] }>
  seed: (role: string, ctx: SeedContext) => string | undefined
  completion: readonly string[]
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

  // Build transition table
  const table: Record<string, Record<string, string>> = {}
  for (const [phaseName, phase] of Object.entries(spec.phases)) {
    table[phaseName] = { ...phase.on }
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

  const initialPhase = phaseNames[0]

  return Object.freeze({
    name,
    emoji: spec.emoji,
    display: spec.display,
    roles: spec.roles,
    phases: spec.phases as Record<string, PhaseDef>,
    initialPhase,
    machine: createStateMachine(name, table as TransitionTable<string, string>),
    windowMs: (phase: string) => windows.get(phase),
    graceMs: (role: string) => grace.get(role),
    sentinel: (_phase: string) => undefined,
    decisions,
    seed: (role: string, ctx: SeedContext) => spec.seed?.[role as keyof R]?.(ctx),
    completion: spec.completion ?? ['thread', 'outcome', 'transcript'],
  })
}
