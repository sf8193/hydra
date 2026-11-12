// What the Slack connections share, in one daemon: who each app's bot is, which apps' bots are in which channel, and who owns
// each message. A leaf over Slack's calls (injected), so it is tested without Slack.
//
// Several apps in one channel all hear every message in it, and exactly one answers (routing/route.ts `owningApp`). Each
// connection decides for itself, from the same facts, and the first connection to decide a message fixes its owner for the
// others (`decideOwner`), so "exactly one" holds by construction, not by the facts staying still between two copies.

export type AppIdentity = { botUserId: string; botId?: string }

/** How long a read that says an app's bot is in a channel is believed, unless a join or a leave says otherwise. */
export const MEMBER_TTL_MS = 10 * 60_000
/** How long a read that says it is not in a channel is believed: short, since an invite is the common change. */
export const NOT_MEMBER_TTL_MS = 30_000
/** After a failed read, the last good answer stands, and Slack is asked again no sooner than this. */
export const PROBE_RETRY_MS = 30_000
/** A message that tags an app reads that app's membership again, unless it was read this recently. */
export const TAG_REPROBE_MS = 5_000
/** Membership reads (conversations.info) in flight at once, across every app. */
export const PROBE_CONCURRENCY = 5
/** How long a message's owner is remembered for the other connections' copies of it. */
export const OWNER_TTL_MS = 2 * 60_000
/** How long an app that was started may take to join before it counts as not joining (see `failedToJoin`). */
export const JOIN_GRACE_MS = 30_000

/** Whether an app's bot is in a channel. Throws when Slack won't say (a missing scope, a rate limit). */
export type MemberProbe = (channel: string) => Promise<boolean>

type Fact = {
  /** The last answer Slack gave: kept through failed reads. */
  good?: { member: boolean; at: number }
  /** A read failed: believed as it stands until then. */
  retryAt?: number
  /** When it was last read (for tags), good or not. */
  probedAt?: number
}

export type ConnectedAppsDeps = {
  now?: () => number
  alert?: (text: string) => void
  log?: (line: string) => void
  /** Called when an app's bot ids become known or change: written to the state dir so a restart still recognises a tag of an app that has not joined yet. */
  persist?: (ids: Record<string, AppIdentity>) => void
}

export class ConnectedApps {
  /** Bot ids of every app seen connected, now or in a previous run (`seedIdentities`). */
  private readonly ids = new Map<string, AppIdentity>()
  private readonly probes = new Map<string, MemberProbe>()
  private readonly facts = new Map<string, Fact>()   // `<app>\0<channel>`
  private readonly flights = new Map<string, Promise<void>>()
  private readonly said = new Set<string>()
  private readonly owners = new Map<string, { app: string; at: number }>()   // `<channel>\0<ts>`
  /** Apps that have reported a channel join or leave: they are subscribed to those events. */
  private readonly reporting = new Set<string>()
  /** Apps started and not yet joined: until each has joined (or failed to), who is in a channel is not settled. */
  private readonly joining = new Set<string>()
  private joinWaiters: (() => void)[] = []
  private slots = PROBE_CONCURRENCY
  private slotWaiters: (() => void)[] = []

  constructor(private readonly deps: ConnectedAppsDeps = {}) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }

  // -- who has joined ------------------------------------------------------------------------------------------------

  /** These apps were started: nothing is settled about who is in a channel until each has joined, failed to, or taken `graceMs`. */
  expectJoin(apps: string[], graceMs = JOIN_GRACE_MS): void {
    for (const a of apps) {
      if (this.probes.has(a)) continue
      this.joining.add(a)
      const timer = setTimeout(() => this.failedToJoin(a), graceMs)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  /** An app's first connection failed. It may still join later; until then it is in no channel. */
  failedToJoin(app: string): void { this.joining.delete(app); this.settleJoined() }

  /** Whether some app is started and has not yet joined or failed to. */
  isJoining(): boolean { return this.joining.size > 0 }

  /** Resolves once every started app has joined or failed to. */
  allJoined(): Promise<void> { return this.joining.size === 0 ? Promise.resolve() : new Promise(resolve => { this.joinWaiters.push(resolve) }) }

  private settleJoined(): void {
    if (this.joining.size) return
    for (const w of this.joinWaiters.splice(0)) w()
  }

  /** An app connected: its bot, and how to ask whether that bot is in a channel. */
  join(app: string, identity: AppIdentity, probe: MemberProbe): void {
    this.joining.delete(app)
    const known = this.ids.get(app)
    this.ids.set(app, identity)
    if (!known || known.botUserId !== identity.botUserId || known.botId !== identity.botId) this.deps.persist?.(this.identities())
    this.probes.set(app, probe)
    this.forget(app)
    this.settleJoined()
  }

  /** An app disconnected or was removed from hydra.toml: it is in no channel, it is no longer joining, and it is no one's to tag. */
  leave(app: string): void {
    this.joining.delete(app)
    this.ids.delete(app)
    this.probes.delete(app)
    this.reporting.delete(app)
    this.forget(app)
    this.settleJoined()
  }

  private forget(app: string): void {
    for (const k of [...this.facts.keys()]) if (k.startsWith(`${app}\0`)) this.facts.delete(k)
  }

  /** The apps with a live connection. */
  connectedApps(): string[] { return [...this.probes.keys()] }

  /** Bot ids a previous run saw, so a tag of an app that has not joined yet is still recognised. A connected app's own ids replace them. */
  seedIdentities(ids: Record<string, AppIdentity>): void {
    for (const [app, id] of Object.entries(ids)) if (!this.ids.has(app)) this.ids.set(app, id)
  }

  /** Every known app's bot ids, by app id: what tells which app a `<@…>` in a text tags. */
  identities(): Record<string, AppIdentity> { return Object.fromEntries(this.ids) }

  /** Whether membership matters: more than one app is connected. With one, it is in every channel it hears, and nothing is asked. */
  several(): boolean { return this.probes.size > 1 }

  // -- who is in a channel -------------------------------------------------------------------------------------------

  private current(f: Fact | undefined): boolean {
    if (!f) return false
    if (f.retryAt !== undefined && this.now() < f.retryAt) return true   // a read failed: what is known stands until the retry
    return !!f.good && this.now() - f.good.at < (f.good.member ? MEMBER_TTL_MS : NOT_MEMBER_TTL_MS)
  }

  private recentlyRead(f: Fact | undefined): boolean { return f?.probedAt !== undefined && this.now() - f.probedAt < TAG_REPROBE_MS }

  /**
   * Whether who is in this channel is known well enough to decide a message the app `heard` received: no app is still
   * joining, and every other connected app's membership is current, with each app the text tags (`tagged`) read just now or
   * known to be in. An app never needs to read itself: it is in the channel it heard.
   */
  settled(channel: string, heard: string, tagged: string[] = []): boolean {
    if (this.joining.size) return false
    if (!this.several()) return true
    for (const a of this.probes.keys()) {
      if (a === heard) continue
      const f = this.facts.get(`${a}\0${channel}`)
      if (!this.current(f)) return false
      if (tagged.includes(a) && !(f?.good?.member && this.current(f)) && !this.recentlyRead(f)) return false
    }
    return true
  }

  /** The connected apps whose bot is in the channel, from what is known now. `heard` (the app that received the message) is always one. */
  heardBy(channel: string, heard: string): string[] {
    const out = [heard]
    if (!this.several()) return out
    for (const a of this.probes.keys()) if (a !== heard && this.facts.get(`${a}\0${channel}`)?.good?.member) out.push(a)
    return out
  }

  /** Read what is not known (or no longer current) about every other connected app and this channel, and each tagged app again. */
  async ensure(channel: string, heard: string, tagged: string[] = []): Promise<void> {
    await this.allJoined()
    if (!this.several()) return
    await Promise.all([...this.probes.keys()].filter(a => a !== heard).map(a => this.ask(a, channel, tagged.includes(a))))
  }

  private ask(app: string, channel: string, tagged: boolean): Promise<void> {
    const key = `${app}\0${channel}`
    const f = this.facts.get(key)
    if (tagged ? (f?.good?.member && this.current(f)) || this.recentlyRead(f) : this.current(f)) return Promise.resolve()
    const running = this.flights.get(key)
    if (running) return running
    const probe = this.probes.get(app)
    if (!probe) return Promise.resolve()
    const flight = this.slot().then(async release => {
      try {
        const member = await probe(channel)
        const was = f?.good
        this.facts.set(key, { good: { member, at: this.now() }, probedAt: this.now() })
        // Invited, and nothing said so: the app is not reporting joins, so its cached "not in" went stale unseen.
        if (tagged && member && was && !was.member && !this.reporting.has(app)) this.noReports(app)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        // An error is not an answer: the last good one stands, and Slack is asked again later.
        this.facts.set(key, { ...(f?.good && { good: f.good }), retryAt: this.now() + PROBE_RETRY_MS, probedAt: this.now() })
        if (!f?.good) this.cantRead(app, why)
        else this.deps.log?.(`daemon: slack apps: reading whether the app named ${app} is in ${channel} failed (${why}); the last answer stands\n`)
      } finally { release() }
    }).finally(() => { this.flights.delete(key) })
    this.flights.set(key, flight)
    return flight
  }

  private slot(): Promise<() => void> {
    const take = () => { this.slots--; return () => { this.slots++; this.slotWaiters.shift()?.() } }
    if (this.slots > 0) return Promise.resolve(take())
    return new Promise(resolve => { this.slotWaiters.push(() => resolve(take())) })
  }

  /** A join or a leave in a channel, reported by the app `via`: everything believed about it is read again at the next message. */
  changed(channel: string, via?: string): void {
    if (via) this.reporting.add(via)
    for (const k of [...this.facts.keys()]) if (k.endsWith(`\0${channel}`)) this.facts.delete(k)
  }

  // -- who owns a message --------------------------------------------------------------------------------------------

  /**
   * The app that owns a message, fixed by the first connection to ask: every other connection's copy of it (and a catch-up
   * pass's) gets the same answer, whatever the facts have become. Remembered briefly.
   */
  decideOwner(channel: string, ts: string, decide: () => string): string {
    const key = `${channel}\0${ts}`
    const now = this.now()
    const known = this.owners.get(key)
    if (known && now - known.at < OWNER_TTL_MS) return known.app
    const app = decide()
    this.owners.set(key, { app, at: now })
    if (this.owners.size > 5000) {
      for (const [k, v] of this.owners) if (now - v.at >= OWNER_TTL_MS) this.owners.delete(k)
      // Map order is insertion order: past the cap, the oldest go.
      for (const k of this.owners.keys()) { if (this.owners.size <= 4000) break; this.owners.delete(k) }
    }
    return app
  }

  // -- what is said ----------------------------------------------------------------------------------------------------

  /** Said once per app: which apps are in a channel can't be read, so in a channel several are in, the one that receives a message answers it. */
  private cantRead(app: string, why: string): void {
    this.deps.log?.(`daemon: slack apps: can't tell whether the app named ${app} is in a channel: ${why}\n`)
    if (this.said.has(`read:${app}`)) return
    this.said.add(`read:${app}`)
    this.deps.alert?.(`⚠️ Hydra can't tell which channels the app named \`${app}\` is in (${why}), so in a channel that several apps are in, each may answer. Add the scope channels:read (public channels) and groups:read (private ones) to the app, reinstall it, put the new bot token in the variable its \`bot_token_env\` names, and restart the daemon.`)
  }

  private noReports(app: string): void {
    if (this.said.has(`events:${app}`)) return
    this.said.add(`events:${app}`)
    this.deps.alert?.(`⚠️ The app named \`${app}\` was invited to a channel and Hydra was not told: it does not send member_joined_channel and member_left_channel. Add both under Event Subscriptions of every app (\`hydra slack manifest <app>\` lists them once several apps are declared), and reinstall each. Until then a join is noticed only when a tag asks, or within ${MEMBER_TTL_MS / 60_000} minutes.`)
  }
}
