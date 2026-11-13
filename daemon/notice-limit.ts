// One rate limit for every notice hydra posts into a thread about a start or a delivery it refused: the same cause is said at
// most once a minute. A revive tries three tiers and each is refused for the same cause; a sender may message a drifted
// session every second. The map is bounded, so a long-running daemon does not keep every cause it ever heard.

export const NOTICE_REPEAT_MS = 60_000
const MAX_CAUSES = 500

export class NoticeLimiter {
  private readonly told = new Map<string, number>()
  private readonly windowMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(opts: { windowMs?: number; max?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? NOTICE_REPEAT_MS
    this.max = opts.max ?? MAX_CAUSES
    this.now = opts.now ?? Date.now
  }

  get size(): number { return this.told.size }

  /** Whether this cause may be said now. Saying it is recorded: the next `allow` of the same cause inside the window is false. */
  allow(cause: string): boolean {
    const now = this.now()
    const last = this.told.get(cause)
    if (last !== undefined && now - last < this.windowMs) return false
    this.told.delete(cause)   // re-inserted last: insertion order is age order
    this.told.set(cause, now)
    this.trim(now)
    return true
  }

  private trim(now: number): void {
    if (this.told.size <= this.max) return
    for (const [k, at] of this.told) if (now - at >= this.windowMs) this.told.delete(k)
    // Still over: the oldest go first (a Map iterates in insertion order).
    for (const k of this.told.keys()) { if (this.told.size <= this.max) break; this.told.delete(k) }
  }

  clear(): void { this.told.clear() }
}

/** The thread notices of daemon/session-lifecycle.ts and specialists/specialist-deliver.ts share this one. */
export const threadNotices = new NoticeLimiter()
