// Shared types between protocol-dsl.ts and protocol-runner.ts.
// Keeps only what inline behaviors need — no dependency on Protocol or runner internals.

export type RunState = {
  readonly id: string
  readonly threadId: string
  readonly ownerSessionId: string
  phase: string
  currentRound: number
  readonly rounds: number
  readonly params: Record<string, unknown>
  readonly participants: Map<string, string>
  readonly sessionToRole: Map<string, string>
  readonly decisions: Array<{ phase: string; role: string; value: string; because: string }>
  readonly messageIds: string[]
  readonly statusHistory: string[]
}

export type BehaviorContext = {
  postStatusLine: (run: RunState) => Promise<void>
  resetTimeout: (run: RunState) => void
  afterTransition: (run: RunState, prevPhase: string, content: string) => Promise<void>
  fireTransition: (run: RunState, event: string, content: string, reason: string) => Promise<void>
  safeSend: (threadId: string, text: string) => Promise<string[]>
  sendToActor: (run: RunState, content: string) => void
}

/** Return true to suppress the default notify/reset after this phase entry. All behaviors in the chain still run regardless — true does not halt the chain. */
export type PhaseBehaviorFn = (run: RunState, prevPhase: string, content: string, ctx: BehaviorContext) => boolean | Promise<boolean>

/**
 * Emitted on every non-terminal phase transition of a live run.
 *
 * Carries no authority — only enough to decide whether the event is yours, and
 * a "run state moved" nudge. Anything about the run's position, the round
 * counter included, is read from the run itself: a copy here would be a second
 * source of truth with nobody keeping it honest.
 */
export type PhaseChangeEvent = {
  protocol: string
  threadId: string
  phase: string
}

export type CompletionEvent = {
  protocol: string
  threadId: string
  topic?: string
  rounds: { completed: number; requested: number }
  outcome: 'complete' | 'cancelled'
  reason?: string
  decisions: Array<{ phase: string; role: string; value: string; because: string }>
  durationMs: number
  transcriptPath?: string
  // Owner's closing summary posted in the cleanup phase (present on 'complete' only).
  // Verdict-less advances aren't recorded as decisions, so this is the only channel
  // for the cleanup content — consumers can't recover it from `decisions`.
  summary?: string
  // Which path the run took to its summary. 'normal' is the protocol as
  // designed; 'fallback' means a participant died and the owner finished the
  // work; 'direct' means the caller asked for the owner-run path up front.
  // Absent on 'cancelled' — a cancelled run never reached a summary, so it took
  // no path there. Consumers that treat every completion alike would otherwise
  // report an owner's self-review as an adversarial one.
  via?: 'normal' | 'fallback' | 'direct'
  // What the non-normal path gave up, in the protocol's own words (its
  // `fallbackDegradation`). Present only when `via` is set and not 'normal'.
  degradation?: string
}
