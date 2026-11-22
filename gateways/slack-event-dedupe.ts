// A tag in a channel the bot is in reaches the gateway twice: as a `message` event (with the message's files) and as an
// `app_mention` event (without them), both under the same channel and ts. One of the two is delivered, and it is the `message` one.
// A leaf: no Bolt, no daemon.

/** How long a mention waits for its `message` copy before it is delivered alone (a channel the bot is not in sends only the mention). */
export const MENTION_GRACE_MS = 1000
/** How long a delivered event is remembered, and how many are kept. Slack sends the two copies within moments of each other. */
const SEEN_TTL_MS = 10 * 60_000
const SEEN_CAP = 2000

type Seen = { state: 'message' | 'mention' | 'waiting'; expires: number; timer?: ReturnType<typeof setTimeout> }

export class SlackEventDedupe {
  private seen = new Map<string, Seen>()

  constructor(private graceMs: number = MENTION_GRACE_MS, private now: () => number = Date.now) {}

  /** The key of a message event: its channel and ts. */
  static key(channel: string, ts: string): string { return `${channel}:${ts}` }

  /** A `message` event arrived. True: deliver it. False: this message was already delivered (by either event). */
  claimMessage(key: string): boolean {
    const e = this.live(key)
    if (e && e.state !== 'waiting') return false
    if (e?.timer) clearTimeout(e.timer)
    this.set(key, { state: 'message', expires: this.now() + SEEN_TTL_MS })
    return true
  }

  /** An `app_mention` event arrived. `deliver` runs once the grace passes with no `message` copy; never when one came, or came already. */
  holdMention(key: string, deliver: () => void): void {
    if (this.live(key)) return
    const timer = setTimeout(() => {
      this.set(key, { state: 'mention', expires: this.now() + SEEN_TTL_MS })
      deliver()
    }, this.graceMs)
    timer.unref?.()
    this.set(key, { state: 'waiting', expires: this.now() + SEEN_TTL_MS, timer })
  }

  /** Drops the waiting timers (a stopped gateway delivers nothing more). */
  clear(): void {
    for (const e of this.seen.values()) if (e.timer) clearTimeout(e.timer)
    this.seen.clear()
  }

  private live(key: string): Seen | undefined {
    const e = this.seen.get(key)
    if (e && e.expires <= this.now()) { this.seen.delete(key); return undefined }
    return e
  }

  private set(key: string, e: Seen): void {
    this.seen.delete(key)
    this.seen.set(key, e)
    // Insertion order is (nearly) expiry order: the oldest are at the front. Lookups re-check expiry, so only the bound depends on it.
    for (const [k, v] of this.seen) {
      if (this.seen.size <= SEEN_CAP && v.expires > this.now()) break
      this.seen.delete(k)
    }
  }
}
