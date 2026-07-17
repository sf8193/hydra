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
  readonly decisions: Array<{ phase: string; role: string; value: string; because: string; context?: string }>
  ext: Record<string, unknown>
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
