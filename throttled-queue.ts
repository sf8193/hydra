// ---------------------------------------------------------------------------
// SerialQueue — FIFO rate-limited queue for sequential API calls.
//
// Each add() call enqueues a promise-returning function and returns a Promise
// that resolves/rejects with the function's result. Calls are executed one at
// a time with at least `minIntervalMs` between the START of each call. This
// limits throughput to 1/minIntervalMs without coalescing (all calls go through).
// ---------------------------------------------------------------------------

export class SerialQueue {
  private queue: Array<() => Promise<unknown>> = []
  private lastRunAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private minIntervalMs: number) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()) } catch (err) { reject(err as Error) }
      })
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.timer !== null) return
    const now = Date.now()
    const delay = Math.max(0, this.lastRunAt + this.minIntervalMs - now)
    this.timer = setTimeout(() => { this.run() }, delay)
  }

  private run(): void {
    this.timer = null
    const fn = this.queue.shift()
    if (!fn) return
    this.lastRunAt = Date.now()
    fn().finally(() => {
      if (this.queue.length > 0) this.schedule()
    })
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
