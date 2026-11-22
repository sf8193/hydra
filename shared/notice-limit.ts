// One rate limit for every notice hydra posts into a thread about a start or a delivery it refused: the same cause is said at
// most once a minute. A revive tries three tiers and each is refused for the same cause; a sender may message a drifted
// session every second. The map is bounded, so a long-running daemon does not keep every cause it ever heard.

export const NOTICE_REPEAT_MS = 60_000
const MAX_CAUSES = 500

export class NoticeLimiter {
  private readonly said = new Map<string, number>()
  private readonly windowMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(opts: { windowMs?: number; max?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? NOTICE_REPEAT_MS
    this.max = opts.max ?? MAX_CAUSES
    this.now = opts.now ?? Date.now
  }

  get size(): number { return this.said.size }

  /** Whether this cause was said inside the window, without saying it now. */
  told(cause: string): boolean {
    const last = this.said.get(cause)
    return last !== undefined && this.now() - last < this.windowMs
  }

  /** Whether this cause may be said now. Saying it is recorded: the next `allow` of the same cause inside the window is false. */
  allow(cause: string): boolean {
    const now = this.now()
    const last = this.said.get(cause)
    if (last !== undefined && now - last < this.windowMs) return false
    this.said.delete(cause)   // re-inserted last: insertion order is age order
    this.said.set(cause, now)
    this.trim(now)
    return true
  }

  private trim(now: number): void {
    if (this.said.size <= this.max) return
    for (const [k, at] of this.said) if (now - at >= this.windowMs) this.said.delete(k)
    // Still over: the oldest go first (a Map iterates in insertion order).
    for (const k of this.said.keys()) { if (this.said.size <= this.max) break; this.said.delete(k) }
  }

  clear(): void { this.said.clear() }
}

/** The thread notices of app/session-lifecycle.ts and specialists/specialist-deliver.ts share this one. */
export const threadNotices = new NoticeLimiter()

/** The cause a refusal notice is limited by: one thread, one reason. Every place that tells a thread about a refused delivery builds it here. */
export const refusalNoticeKey = (threadId: string, reason: string): string => `${threadId}\n${reason}`
