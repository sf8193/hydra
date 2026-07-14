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
}

export type BehaviorContext = {
  postStatusLine: (run: RunState) => void
  resetTimeout: (run: RunState) => void
  afterTransition: (run: RunState, prevPhase: string, content: string) => void
  safeSend: (threadId: string, text: string) => Promise<string[]>
  sendToActor: (run: RunState, content: string) => void
  transition: (run: RunState, event: string) => { ok: boolean; to?: string }
}

export type PhaseBehaviorFn = (run: RunState, prevPhase: string, content: string, ctx: BehaviorContext) => boolean
