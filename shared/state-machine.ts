// ---------------------------------------------------------------------------
// Generic state machine for multi-agent workflows (build, review, etc.)
// ---------------------------------------------------------------------------

export type TransitionTable<Phase extends string, Event extends string> =
  Record<Phase, Partial<Record<Event, Phase>>>

export type TransitionResult<Phase extends string> =
  | { ok: true; from: Phase; to: Phase }
  | { ok: false; from: Phase; reason: string }

export function createStateMachine<Phase extends string, Event extends string>(
  name: string,
  transitions: TransitionTable<Phase, Event>,
) {
  return {
    transition(currentPhase: Phase, event: Event): TransitionResult<Phase> {
      const allowed = transitions[currentPhase]
      if (!allowed) {
        const result = { ok: false as const, from: currentPhase, reason: `no transitions defined for phase "${currentPhase}"` }
        process.stderr.write(`daemon: ${name}: invalid transition ${currentPhase} + ${event} — ${result.reason}\n`)
        return result
      }

      const next = allowed[event]
      if (!next) {
        const result = { ok: false as const, from: currentPhase, reason: `event "${event}" not valid in phase "${currentPhase}"` }
        process.stderr.write(`daemon: ${name}: rejected ${currentPhase} + ${event} — ${result.reason}\n`)
        return result
      }

      process.stderr.write(`daemon: ${name}: ${currentPhase} → ${next} (${event})\n`)
      return { ok: true, from: currentPhase, to: next }
    },

    /** Check if an event is valid for the current phase without executing */
    canTransition(currentPhase: Phase, event: Event): boolean {
      return !!transitions[currentPhase]?.[event]
    },

    /** Get all valid events for a phase */
    validEvents(currentPhase: Phase): Event[] {
      const allowed = transitions[currentPhase]
      return allowed ? Object.keys(allowed) as Event[] : []
    },
  }
}
