// ---------------------------------------------------------------------------
// SlackThrottle — per-method rate-limiting queue for outbound Slack API calls.
//
// ThrottledQueue (throttled-queue.ts) coalesces by key (latest-value-wins),
// which suits dashboard-update patterns but drops independent API calls.
// CallQueue here serializes calls strictly: every enqueued call runs once,
// in order, with a minimum interval between completions.
//
// Slack tier mapping used (conservative — per-workspace, not per-channel):
//   chat.postMessage / chat.update : 1 per second  (Special/Tier 3 in practice)
//   views.publish / reactions.add  : 3 per second  (20 per minute → 3000ms)
//   default                        : 1 per second
//
// On 429: the Slack web-api client throws WebAPIRateLimitedError with a
// numeric `retryAfter` field (seconds). We re-queue the item at the front
// and wait before retrying.
// ---------------------------------------------------------------------------

// How long to wait between successive calls for each tier (milliseconds).
const TIER_INTERVAL_MS: Record<string, number> = {
  'chat.postMessage': 1_000,
  'chat.update':      1_000,
  'views.publish':    3_000,
  'reactions.add':    3_000,
}
const DEFAULT_INTERVAL_MS = 1_000

type QueueItem<T> = {
  fn: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

class CallQueue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pending: Array<QueueItem<any>> = []
  private running = false

  constructor(
    readonly method: string,
    private intervalMs: number,
    private onRetry?: () => void,
  ) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ fn, resolve, reject })
      if (!this.running) this.runNext()
    })
  }

  get depth(): number { return this.pending.length }

  private async runNext(): Promise<void> {
    if (this.pending.length === 0) { this.running = false; return }
    this.running = true
    const item = this.pending.shift()!
    try {
      const result = await item.fn()
      item.resolve(result)
    } catch (err: unknown) {
      const retryAfter = extractRetryAfter(err)
      if (retryAfter !== null) {
        // Re-queue at front and pause
        this.pending.unshift(item)
        this.onRetry?.()
        const waitMs = retryAfter * 1_000
        process.stderr.write(
          `slack-throttle: 429 on ${this.method} — waiting ${retryAfter}s (Retry-After)\n`,
        )
        await sleep(waitMs)
        await sleep(this.intervalMs)
        await this.runNext()
        return
      }
      item.reject(err)
    }
    await sleep(this.intervalMs)
    await this.runNext()
  }
}

function extractRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as Record<string, unknown>
  // @slack/web-api throws WebAPIRateLimitedError with numeric retryAfter
  if (typeof e['retryAfter'] === 'number') return e['retryAfter'] as number
  // Fallback: HTTP status 429 with Retry-After header
  if ((e['status'] === 429 || (e as any)?.data?.status === 429)) {
    const header = (e as any)?.headers?.['retry-after']
    if (header) {
      const n = parseInt(String(header), 10)
      if (!isNaN(n)) return n
    }
    return 1
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ThrottleStats = {
  queues: Record<string, { depth: number; intervalMs: number }>
  totalCalls: number
  totalRetries: number
}

export class SlackThrottle {
  private queues = new Map<string, CallQueue>()
  private _totalCalls = 0
  private _totalRetries = 0

  private getQueue(method: string): CallQueue {
    let q = this.queues.get(method)
    if (!q) {
      const intervalMs = TIER_INTERVAL_MS[method] ?? DEFAULT_INTERVAL_MS
      q = new CallQueue(method, intervalMs, () => this.noteRetry())
      this.queues.set(method, q)
    }
    return q
  }

  /** Enqueue an API call. Returns a Promise that resolves with the API result. */
  call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    this._totalCalls++
    return this.getQueue(method).enqueue(fn)
  }

  getStats(): ThrottleStats {
    const queues: Record<string, { depth: number; intervalMs: number }> = {}
    for (const [method, q] of this.queues) {
      queues[method] = { depth: q.depth, intervalMs: (q as any).intervalMs }
    }
    return { queues, totalCalls: this._totalCalls, totalRetries: this._totalRetries }
  }

  /** Increment retry counter (called from queue on re-enqueue after 429). */
  noteRetry(): void { this._totalRetries++ }
}

/** Singleton — one throttle per process, shared across all gateway calls. */
export const slackThrottle = new SlackThrottle()
