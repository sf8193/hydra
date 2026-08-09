// ---------------------------------------------------------------------------
// SerialRateLimiter — serializes promise-returning calls with a min interval.
//
// Unlike ThrottledQueue, this preserves return values and call order. Each
// call is queued and executed after the previous one completes, with a
// minimum delay of drainMs between completions. Designed for Slack API calls
// where we need both rate-limiting and the return value (e.g., message ts).
// ---------------------------------------------------------------------------

export class SerialRateLimiter {
  private queue: Array<{
    fn: () => Promise<unknown>
    resolve: (v: unknown) => void
    reject: (e: unknown) => void
  }> = []
  private running = false
  private lastFinishedAt = 0

  constructor(private minIntervalMs: number) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn: fn as () => Promise<unknown>, resolve, reject })
      if (!this.running) this.drain()
    })
  }

  private drain(): void {
    const next = this.queue.shift()
    if (!next) { this.running = false; return }

    this.running = true
    const delay = Math.max(0, this.minIntervalMs - (Date.now() - this.lastFinishedAt))
    setTimeout(async () => {
      try {
        const result = await next.fn()
        next.resolve(result)
      } catch (err) {
        next.reject(err)
      } finally {
        this.lastFinishedAt = Date.now()
        this.drain()
      }
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// ThrottledQueue — coalescing queue with retry.
//
// Coalesces by key (latest value wins), drains one item per interval,
// respects priority ordering (high before normal). On action failure,
// re-enqueues the value (up to maxRetries) so transient errors don't
// permanently lose updates. A fresh enqueue for the same key supersedes
// any pending retry — the newest value always wins.
// ---------------------------------------------------------------------------

export class ThrottledQueue<V> {
  private queue = new Map<string, { value: V; priority: 'high' | 'normal' }>()
  private retries = new Map<string, number>()
  private draining = false

  constructor(
    private action: (key: string, value: V) => Promise<void>,
    private drainMs: number,
    private maxRetries: number = 3,
  ) {}

  enqueue(key: string, value: V, priority: 'high' | 'normal' = 'normal'): void {
    const existing = this.queue.get(key)
    const effectivePriority = priority === 'high' ? 'high' : (existing?.priority ?? 'normal')
    this.queue.set(key, { value, priority: effectivePriority })
    this.retries.delete(key)
    if (!this.draining) this.drain()
  }

  private drain(): void {
    if (this.queue.size === 0) { this.draining = false; return }
    this.draining = true

    let nextKey: string | undefined
    for (const [key, entry] of this.queue) {
      if (entry.priority === 'high') { nextKey = key; break }
    }
    if (!nextKey) nextKey = this.queue.keys().next().value!
    const { value, priority } = this.queue.get(nextKey)!
    this.queue.delete(nextKey)

    this.action(nextKey, value).catch(err => {
      const attempts = (this.retries.get(nextKey!) ?? 0) + 1
      if (attempts < this.maxRetries && !this.queue.has(nextKey!)) {
        process.stderr.write(`throttled-queue: action failed (retry ${attempts}/${this.maxRetries}): ${err instanceof Error ? err.message : String(err)}\n`)
        this.queue.set(nextKey!, { value, priority })
        this.retries.set(nextKey!, attempts)
      } else {
        process.stderr.write(`throttled-queue: action failed (dropped${this.queue.has(nextKey!) ? ', newer value queued' : ''}): ${err instanceof Error ? err.message : String(err)}\n`)
        this.retries.delete(nextKey!)
      }
    }).finally(() => {
      setTimeout(() => this.drain(), this.drainMs)
    })
  }
}
