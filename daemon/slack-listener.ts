import { App, LogLevel } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import { SocketSupervisor, START_TIMEOUT_MS, type SocketEmitter } from '../shared/socket-supervisor.js'
import { catchUp, toEvent, type CatchUpResult, type RawMessage, type SlackApi } from './slack-catchup.js'
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync } from 'fs'
import { dirname } from 'path'
import { routedChannels, hearsDms, unresolvedPlaces, NO_DIRECTORY, SLACK_LIMITS, type SlackDirectory, type SlackWatchConfig, type SlackWatcher } from './slack-watch.js'
import type { HydraConfig } from '../config/types.js'

/**
 * The Slack connector: one Socket Mode connection that feeds `message` events to the watcher, and the catch-up pass
 * that replays what the connection missed. Its writes are reactions (the `ack`, and 🚫) and a specialist's replies,
 * posted only into the conversation they answer (`post`).
 * What the connection learns (the bot's own ids, the workspace, channel names) joins hydra.toml in `view()`, which is
 * what the watcher routes with.
 *
 * It lives in the Discord daemon but is its own thing: its own Slack app connection,
 * supervised by the shared SocketSupervisor with a *degrade* policy. A dead Slack
 * token must not take the Discord daemon down, so exhausted reconnects are recorded
 * and surfaced (health, an alert in the specialist's thread), and the supervisor keeps trying.
 *
 * Slack does not replay events missed while disconnected, so every reconnect and every
 * ten minutes a deep catch-up pass runs. That same pass is what bounds the damage if
 * another process ever holds a connection on the same app (Slack splits events across
 * connections): nothing is lost, it only arrives late, and the pass reports having
 * recovered messages the live stream never delivered.
 */

/** Slack errors a retry cannot fix, each with what to do about it. */
export const PERMANENT_SLACK_ERRORS: [RegExp, string][] = [
  [/missing_scope/, 'the bot token lacks a scope. Add the scope named above (channels:history for public channels, groups:history for private ones), reinstall the app, put the new bot token in the variable [connectors.slack] bot_token_env names, and restart the daemon.'],
  [/invalid_auth|not_authed|token_revoked|token_expired|account_inactive/, 'Slack does not accept the bot token. Put a valid bot token in the variable [connectors.slack] bot_token_env names, and restart the daemon.'],
  [/not_in_channel|channel_not_found/, 'the bot cannot see a channel hydra.toml names. Invite it to the channel, or correct the place.'],
]

/** Slack's `missing_scope` names the scope it needed and the ones the token has; the SDK's message drops both. */
export function explainSlackError(err: unknown): Error {
  const data = (err as { data?: { error?: string; needed?: string; provided?: string } } | null)?.data
  if (data?.error === 'missing_scope') return new Error(`missing_scope: the token needs ${data.needed ?? '(unnamed)'} and has ${data.provided ?? '(unknown)'}`)
  return err instanceof Error ? err : new Error(String(err))
}

/** One post's deadline. Past it the post's outcome is unknown: it may have landed. */
export const POST_TIMEOUT_MS = 30_000
export const CATCH_UP_INTERVAL_MS = 10 * 60_000
export const CATCH_UP_RETRY_MS = 60_000
export const ALERT_CHECK_MS = 60_000
export const DOWN_ALERT_AFTER_MS = 5 * 60_000
export const CATCH_UP_STALE_AFTER_MS = CATCH_UP_INTERVAL_MS * 2.5
const MISSED_LIVE_ALERT_EVERY_MS = 60 * 60_000

/** What the Slack SDK offers the listener, narrowed so the rest is testable without it. */
export type SlackAppLike = {
  onMessage(handler: (event: RawEvent) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  emitter(): SocketEmitter | null
  authTest(): Promise<{ botId?: string; userId?: string; url?: string; scopes?: string[] }>
  /** Every channel the bot can see, by id and name (conversations.list). Needs channels:read or groups:read. */
  channels(): Promise<{ id: string; name: string }[]>
  /** A channel was renamed (the channel_rename event). */
  onRename(handler: (id: string, name: string) => void): void
  userName(userId: string): Promise<string | undefined>
  /** A message in a channel, or in a thread when `threadTs` is set. Resolves to its ts. */
  post(channel: string, threadTs: string | undefined, text: string): Promise<string>
  /** Reactions (the ack, and 🚫). */
  react(channel: string, ts: string, name: string): Promise<void>
  /** A file's bytes, to `dest` at mode 0600 (its directory 0700). Throws past `maxBytes`. */
  download(url: string, dest: string, maxBytes: number): Promise<void>
  api: SlackApi
}

/** The scopes each enabled option needs, so a missing one is a read at startup rather than a guess later. */
export function scopesNeeded(h: HydraConfig): { option: string; any: string[] }[] {
  const places = [...Object.values(h.specialists).flatMap(s => s.listens), ...h.rules.map(r => r.at)].filter(p => p.startsWith('slack:'))
  const slackOpts = Object.entries(h.places).filter(([p]) => p.startsWith('slack:')).map(([, o]) => o)
  return [
    ...(places.some(p => p !== 'slack:dm') ? [{ option: 'channels', any: ['channels:history', 'groups:history'] }] : []),
    ...(places.some(p => p.startsWith('slack:#')) ? [{ option: 'channel names (slack:#name)', any: ['channels:read', 'groups:read'] }] : []),
    { option: 'sender names', any: ['users:read'] },
    ...(hearsDms({ hydra: h }) ? [{ option: 'dms', any: ['im:history'] }, { option: 'catching up DMs opened while disconnected', any: ['im:read'] }] : []),
    ...(slackOpts.some(o => o.files) ? [{ option: 'files', any: ['files:read'] }] : []),
    { option: 'ack and 🚫 reactions', any: ['reactions:write'] },
    { option: 'replies', any: ['chat:write'] },
  ]
}

/** Channel names by id and back, from conversations.list. Replaced whole on each refresh; a rename updates one. */
class Directory implements SlackDirectory {
  private names = new Map<string, string>()
  private ids = new Map<string, string>()
  nameOf(id: string) { return this.names.get(id) }
  idOf(name: string) { return this.ids.get(name) }
  replace(list: { id: string; name: string }[]) {
    this.names = new Map(list.map(c => [c.id, c.name]))
    this.ids = new Map(list.map(c => [c.name, c.id]))
  }
  rename(id: string, name: string) {
    const old = this.names.get(id)
    if (old !== undefined && this.ids.get(old) === id) this.ids.delete(old)
    this.names.set(id, name)
    this.ids.set(name, id)
  }
}

/** A Slack `message` event as Bolt hands it over. */
export type RawEvent = RawMessage & { channel?: string; channel_type?: string }

export type ListenerState = 'off' | 'connecting' | 'up' | 'down' | 'exhausted'
export type ListenerHealth = {
  state: ListenerState
  /** Minutes without a connection; null while up. */
  downMin: number | null
  lastActivityAgeMin: number | null
  catchUp: { ageMin: number; ok: boolean; accepted: number; reason?: string } | null
  lastOkCatchUpAgeMin: number | null
}

export type ListenerDeps = {
  watcher: SlackWatcher
  /** hydra.toml as loaded now. Slack is connected only while it has [connectors.slack]. */
  hydra: () => HydraConfig
  tokens: () => { app?: string; bot?: string }
  createApp: (tokens: { app: string; bot: string }) => SlackAppLike
  /** A plain message to the specialist's thread (not a session turn). */
  alert: (text: string) => void
  log: (line: string) => void
  now?: () => number
  healthUrl?: string
  /** First delay before retrying a failed first connection; doubles up to 5 minutes. */
  firstRetryBaseMs?: number
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>
}

export class SlackListener {
  private readonly now: () => number
  private app: SlackAppLike | null = null
  private sup: SocketSupervisor | null = null
  private started = false
  private startedAt = 0
  private generation = 0
  private everConnected = false
  private reconnectedSincePass = false
  private catching = false
  private rerun: boolean | null = null
  private lastCatchUp: { at: number; result: CatchUpResult } | null = null
  private lastOkCatchUpAt: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private firstTimer: ReturnType<typeof setTimeout> | undefined
  private firstAttempts = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private alerted: { down: boolean; catchUp: boolean; permanent: string | null } = { down: false, catchUp: false, permanent: null }
  private lastMissedLiveAlertAt = 0
  private identity: { botUserId: string; botId?: string; workspaceUrl?: string } | null = null
  private readonly directory = new Directory()
  private directoryRead = false
  private namesWarned = false

  constructor(private readonly d: ListenerDeps) {
    this.now = d.now ?? Date.now
  }

  /** What the watcher routes with: hydra.toml joined with what this connection learned. Null until connected once. */
  view(): SlackWatchConfig | null {
    const hydra = this.d.hydra()
    if (!hydra.connectors.slack || !this.identity) return null
    return { hydra, ...this.identity, directory: this.directoryRead ? this.directory : NO_DIRECTORY, ...SLACK_LIMITS }
  }

  /** A specialist's reply, into its conversation. Throws when Slack isn't connected. */
  async post(channel: string, threadTs: string | undefined, text: string): Promise<string> {
    if (!this.app || !this.sup?.state.connected) throw new Error('Slack is not connected; try again once it is (hydra health shows the listener)')
    return this.app.post(channel, threadTs, text)
  }

  /** Channel names, read again. A failure keeps the last list; the missing scope is said once. */
  private async refreshDirectory(app: SlackAppLike): Promise<void> {
    try {
      this.directory.replace(await app.channels())
      this.directoryRead = true
    } catch (err) {
      if (this.namesWarned) return
      this.namesWarned = true
      const needed = unresolvedPlaces({ hydra: this.d.hydra(), directory: this.directoryRead ? this.directory : NO_DIRECTORY })
      this.d.log(`daemon: slack listener: WARN channel names can't be read (${err instanceof Error ? err.message : err}): add channels:read and groups:read and reinstall the app, or name channels by id (slack:C…)${needed.length ? `; ${needed.join(', ')} ${needed.length === 1 ? 'hears' : 'hear'} nothing until then` : ''}\n`)
    }
  }

  /** False, with a log line naming what is missing, when Slack watching is not configured. */
  async start(): Promise<boolean> {
    const slack = this.d.hydra().connectors.slack
    const t = this.d.tokens()
    if (!slack || !t.app || !t.bot) {
      this.d.log(`daemon: slack listener off (${!slack ? 'hydra.toml has no [connectors.slack]' : !t.bot ? `${slack.botTokenEnv} is not set` : slack.appTokenEnv ? `${slack.appTokenEnv} is not set` : '[connectors.slack] needs app_token_env for Socket Mode'})\n`)
      return false
    }
    if (this.started) return true
    this.started = true
    this.startedAt = this.now()
    this.sup = new SocketSupervisor({
      name: 'slack listener',
      start: () => this.connect(),
      emitter: () => this.app?.emitter() ?? null,
      healthUrl: this.d.healthUrl ?? 'https://slack.com/api/api.test',
      // Degrade, never exit: the supervisor keeps trying at its capped backoff, and health and the alert say so.
      onExhausted: n => this.d.log(`daemon: slack listener: ${n} reconnect attempts failed; still trying, see health\n`),
      now: this.now,
      fetch: this.d.fetch,
      log: this.d.log,
    })
    try {
      await this.boundedConnect()
    } catch (err) {
      this.d.log(`daemon: slack listener: first connection failed, will keep trying: ${err instanceof Error ? err.message : err}\n`)
      this.scheduleFirstRetry()
    }
    this.sup.begin()
    for (const [fn, ms] of [[() => { void this.runCatchUp(true, 'periodic') }, CATCH_UP_INTERVAL_MS], [() => { void this.checkAlerts() }, ALERT_CHECK_MS]] as const) {
      const timer = setInterval(fn, ms)
      ;(timer as { unref?: () => void }).unref?.()
      this.timers.push(timer)
    }
    if (this.app && this.sup.state.connected) await this.runCatchUp(true, 'boot')
    return true
  }

  stop(): void {
    this.started = false
    if (this.firstTimer) clearTimeout(this.firstTimer)
    for (const t of this.timers.splice(0)) clearInterval(t)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.sup?.stop()
    void this.app?.stop().catch(() => {})
    this.app = null
  }

  /** The SDK's start can hang, so the first connection is bounded the way the supervisor bounds a reconnect. */
  private async boundedConnect(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`start() timed out after ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS) })
    try { await Promise.race([this.connect(), timeout]) } finally { clearTimeout(timer) }
  }

  /**
   * The supervisor only steps in once a connection that was up goes down, so a first connection
   * that never came up is retried here, with its backoff and network check, until one succeeds.
   */
  private scheduleFirstRetry(): void {
    if (!this.started || this.everConnected || this.firstTimer) return
    const delay = Math.min((this.d.firstRetryBaseMs ?? 10_000) * 2 ** this.firstAttempts++, 5 * 60_000)
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined
      void (async () => {
        if (!this.started || this.everConnected || !this.sup) return
        await this.sup.reconnect()
        if (this.sup.state.connected) void this.runCatchUp(true, 'boot')
        else this.scheduleFirstRetry()
      })()
    }, delay)
    ;(this.firstTimer as { unref?: () => void }).unref?.()
  }

  /** (Re)create the connection. Also what the supervisor calls to reconnect. */
  private async connect(): Promise<void> {
    const t = this.d.tokens()
    const h = this.d.hydra()
    if (!t.app || !t.bot || !h.connectors.slack) throw new Error('slack listener is not configured')
    if (this.app) { try { await this.app.stop() } catch {} }
    const app = this.d.createApp({ app: t.app, bot: t.bot })
    app.onMessage(raw => this.onMessage(raw))
    app.onRename((id, name) => { this.directory.rename(id, name); this.d.log(`daemon: slack listener: channel ${id} is now #${name}\n`) })
    this.app = app
    this.sup!.attach() // before start, so the first `connected` is seen
    const gen = ++this.generation
    app.emitter()?.on('connected', () => {
      if (gen !== this.generation) return
      const was = this.everConnected
      this.everConnected = true
      // Every connection after the first follows a gap, however short: Slack replays nothing.
      if (was) { this.reconnectedSincePass = true; void this.runCatchUp(true, 'reconnected') }
    })
    // Who the bot is and what the channels are called, before the socket opens: routing needs both for the first event.
    const auth = await app.authTest().catch(err => { this.d.log(`daemon: slack listener: auth.test failed: ${err}\n`); return {} as { botId?: string; userId?: string; url?: string; scopes?: string[] } })
    if (auth.userId) this.identity = { botUserId: auth.userId, ...(auth.botId && { botId: auth.botId }), ...(auth.url && { workspaceUrl: auth.url.replace(/\/+$/, '') }) }
    // Without its own id, a tag can't be told from chatter: no connection is better than one that hears wrong.
    if (!this.identity) throw new Error('auth.test gave no bot user id, so tags cannot be recognized')
    if (auth.botId) this.d.watcher.setBotId(auth.botId)
    await this.refreshDirectory(app)
    // Hold every cursor before the socket opens: a live message must not move a cursor past the downtime gap the
    // catch-up pass that follows has yet to read. Each pass releases what it reads.
    const view = this.view()
    this.d.watcher.beginCatchUp([...routedChannels(view), ...(hearsDms(view) ? this.d.watcher.dmChannels() : [])])
    await app.start()
    const needed = scopesNeeded(h)
    this.d.log(`daemon: slack listener: enabled options need: ${needed.map(n => `${n.option} → ${n.any.join(' or ')}`).join('; ')}\n`)
    if (auth.scopes) {
      // Scopes are not secret; the token is. Logging them turns "missing_scope" from a guess into a read.
      this.d.log(`daemon: slack listener: bot token scopes: ${auth.scopes.join(', ') || '(none)'}\n`)
      for (const n of needed) {
        if (!n.any.some(sc => auth.scopes!.includes(sc))) {
          this.d.log(`daemon: slack listener: WARN ${n.option} needs ${n.any.join(' or ')}, which the bot token lacks; add it and reinstall the app\n`)
        }
      }
    }
    this.d.watcher.setNameResolver(id => app.userName(id))
    this.d.watcher.setSlackActions({ react: (c, ts, name) => app.react(c, ts, name), download: (url, dest, max) => app.download(url, dest, max) })
    this.sup!.touch()
  }

  private onMessage(raw: RawEvent): void {
    this.sup?.touch()
    try {
      if (!raw.channel) return
      const ev = toEvent(raw.channel, raw)
      if (ev) this.d.watcher.handle(ev)
    } catch (err) {
      this.d.log(`daemon: slack listener: handling a message failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
    }
  }

  /** One catch-up pass at a time; a request that arrives during one runs once more when it ends. */
  async runCatchUp(deep: boolean, why: string): Promise<CatchUpResult | null> {
    if (!this.view() || !this.app) return null
    if (this.catching) { this.rerun = (this.rerun ?? false) || deep; return null }
    this.catching = true
    const afterReconnect = this.reconnectedSincePass
    if (why !== 'periodic') this.reconnectedSincePass = false
    let result: CatchUpResult | null = null
    try {
      // Names first: a channel renamed or joined since the last pass is scanned under its current name.
      await this.refreshDirectory(this.app)
      result = await catchUp(this.d.watcher, this.app.api, this.view()!, { deep, now: this.now, log: this.d.log })
      this.lastCatchUp = { at: this.now(), result }
      if (result.complete) { this.lastOkCatchUpAt = this.now(); this.alerted.catchUp = false; this.alerted.permanent = null }
      else this.alertIfPermanent(result.reason)
      this.d.log(`daemon: slack catch-up (${why}${deep ? ', deep' : ''}): ${result.complete ? 'done' : 'incomplete'}, ${result.calls} call(s), ${result.accepted} message(s) the live stream had not delivered\n`)
      // A quiet pass should find nothing. Finding messages with no reconnect since the last pass means the live
      // stream is losing events, e.g. another process holds a connection on this Slack app.
      if (why === 'periodic' && !afterReconnect && result.accepted > 0 && this.now() - this.lastMissedLiveAlertAt > MISSED_LIVE_ALERT_EVERY_MS) {
        this.lastMissedLiveAlertAt = this.now()
        this.d.alert(`⚠️ The Slack catch-up pass found ${result.accepted} message(s) the live stream never delivered, with no reconnect in between. Is another process connected to this Slack app (for example sir-not-slop's Bolt server)? Slack splits events across connections; nothing is lost, but it arrives up to ${CATCH_UP_INTERVAL_MS / 60_000} minutes late.`)
      }
    } catch (err) {
      this.d.log(`daemon: slack catch-up crashed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
    } finally {
      this.catching = false
    }
    if (!result?.complete && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.runCatchUp(true, 'retry') }, CATCH_UP_RETRY_MS)
      ;(this.retryTimer as { unref?: () => void }).unref?.()
    }
    if (this.rerun !== null) { const again = this.rerun; this.rerun = null; void this.runCatchUp(again, 'queued') }
    return result
  }

  /** A refusal that retrying cannot fix is said once, at once, in the specialist's thread, with what to do. */
  private alertIfPermanent(reason: string | undefined): void {
    const hit = reason ? PERMANENT_SLACK_ERRORS.find(([re]) => re.test(reason)) : undefined
    if (!hit || this.alerted.permanent === hit[1]) return
    this.alerted.permanent = hit[1]
    this.d.alert(`⚠️ Slack refused the catch-up read: ${reason}. Retrying will not fix it: ${hit[1]}`)
  }

  health(): ListenerHealth {
    const now = this.now()
    const min = (ms: number) => Math.max(0, Math.round(ms / 60_000))
    const s = this.sup?.state
    let state: ListenerState = 'off'
    if (this.started && s) state = s.connected ? 'up' : s.exhausted ? 'exhausted' : s.downSince !== null ? 'down' : 'connecting'
    const downSince = s?.downSince ?? (state === 'connecting' ? this.startedAt : null)
    return {
      state,
      downMin: state === 'up' || state === 'off' || downSince === null ? null : min(now - downSince),
      lastActivityAgeMin: s ? min(now - s.lastActivityAt) : null,
      catchUp: this.lastCatchUp ? { ageMin: min(now - this.lastCatchUp.at), ok: this.lastCatchUp.result.complete, accepted: this.lastCatchUp.result.accepted, ...(this.lastCatchUp.result.reason && { reason: this.lastCatchUp.result.reason }) } : null,
      lastOkCatchUpAgeMin: this.lastOkCatchUpAt === null ? null : min(now - this.lastOkCatchUpAt),
    }
  }

  /** Tell the specialist's thread when the listener has been down or catch-up has stalled, and when the listener is back. Once per episode. */
  async checkAlerts(): Promise<void> {
    if (!this.started) return
    const h = this.health()
    const now = this.now()
    if (h.state !== 'up' && h.downMin !== null && h.downMin * 60_000 >= DOWN_ALERT_AFTER_MS && !this.alerted.down) {
      this.alerted.down = true
      this.d.alert(`⚠️ The Slack listener has been ${h.state} for ${h.downMin} min. Mentions are not arriving live; the catch-up pass replays them once it reconnects.`)
    } else if (h.state === 'up' && this.alerted.down) {
      this.alerted.down = false
      this.d.alert('✅ The Slack listener is connected again.')
    }
    const sinceOk = this.lastOkCatchUpAt === null ? now - this.startedAt : now - this.lastOkCatchUpAt
    if (sinceOk >= CATCH_UP_STALE_AFTER_MS && !this.alerted.catchUp) {
      this.alerted.catchUp = true
      this.d.alert(`⚠️ The Slack catch-up pass has not completed for ${Math.round(sinceOk / 60_000)} min${h.catchUp?.reason ? ` (${h.catchUp.reason})` : ''}. Live delivery is unaffected, but a gap would not be filled.`)
    }
  }
}

// ---------------------------------------------------------------------------
// The real Slack app. Thin on purpose: everything above is tested against a fake.
// ---------------------------------------------------------------------------

export function boltApp(tokens: { app: string; bot: string }): SlackAppLike {
  const app = new App({ token: tokens.bot, appToken: tokens.app, socketMode: true, logLevel: LogLevel.ERROR })
  let handler: (event: RawEvent) => void = () => {}
  app.message(async ({ message }) => { handler(message as RawEvent) })
  // Posting never retries behind the caller's back, and gives up at a hard deadline: a retry landing after the caller
  // was told "unknown" would post twice. Reading keeps the SDK's patient retries.
  const poster = new WebClient(tokens.bot, { retryConfig: { retries: 0 }, timeout: POST_TIMEOUT_MS, logLevel: LogLevel.ERROR })
  let renamed: (id: string, name: string) => void = () => {}
  app.event('channel_rename', async ({ event }) => { const c = (event as { channel?: { id?: string; name?: string } }).channel; if (c?.id && c.name) renamed(c.id, c.name) })
  const client = app.client
  const page = (r: { messages?: unknown[]; response_metadata?: { next_cursor?: string } }) => ({
    messages: (r.messages ?? []) as RawMessage[],
    ...(r.response_metadata?.next_cursor && { next: r.response_metadata.next_cursor }),
  })
  return {
    onMessage: h => { handler = h },
    onRename: h => { renamed = h },
    channels: async () => {
      const out: { id: string; name: string }[] = []
      let cursor: string | undefined
      for (let i = 0; i < 20; i++) {
        const r = await client.conversations.list({ token: tokens.bot, types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, ...(cursor && { cursor }) }).catch(e => { throw explainSlackError(e) })
        for (const c of (r.channels ?? []) as { id?: string; name?: string }[]) if (c.id && c.name) out.push({ id: c.id, name: c.name })
        cursor = r.response_metadata?.next_cursor || undefined
        if (!cursor) break
      }
      return out
    },
    start: async () => { await app.start() },
    stop: async () => { await app.stop() },
    emitter: () => (app as unknown as { receiver?: { client?: SocketEmitter } }).receiver?.client ?? null,
    authTest: async () => {
      const r = await client.auth.test({ token: tokens.bot })
      const scopes = (r as { response_metadata?: { scopes?: string[] } }).response_metadata?.scopes
      return { botId: r.bot_id, userId: r.user_id, ...(r.url && { url: r.url }), ...(scopes && { scopes }) }
    },
    react: async (channel, ts, name) => { await client.reactions.add({ token: tokens.bot, channel, timestamp: ts, name }) },
    post: async (channel, threadTs, text) => {
      const r = await poster.chat.postMessage({ channel, text, ...(threadTs && { thread_ts: threadTs }) }).catch(e => { throw explainSlackError(e) })
      if (!r.ts) throw new Error('Slack accepted the message but returned no ts')
      return r.ts
    },
    download: async (url, dest, maxBytes) => {
      // Only Slack's own hosts ever get the bot token, including across redirects.
      const slackHost = (u: string) => { try { const h = new URL(u); return h.protocol === 'https:' && (h.hostname === 'slack.com' || h.hostname.endsWith('.slack.com')) } catch { return false } }
      let res: Response | undefined
      for (let hop = 0; hop < 3; hop++) {
        if (!slackHost(url)) throw new Error('not a Slack file URL')
        res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.bot}` }, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
        const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
        if (!next) break
        url = new URL(next, url).toString()
      }
      if (!res?.ok || !res.body) throw new Error(`HTTP ${res?.status}`)
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error(`over ${maxBytes / 1024 / 1024} MB`)
      // Without files:read Slack answers with its login page, not an error. Saving that under the file's name would be a quiet lie.
      if (/^text\/html/i.test(res.headers.get('content-type') ?? '') && !/\.html?$/i.test(dest)) throw new Error('Slack sent a web page instead of the file; does the bot token have files:read?')
      // Streamed to disk, never held whole; a partial file never takes the real name.
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
      const part = `${dest}.part`
      const fd = openSync(part, 'w', 0o600)
      try {
        let size = 0
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length
          if (size > maxBytes) throw new Error(`over ${maxBytes / 1024 / 1024} MB`)
          writeSync(fd, chunk)
        }
        closeSync(fd)
        renameSync(part, dest)
      } catch (err) {
        try { closeSync(fd) } catch {}
        rmSync(part, { force: true })
        throw err
      }
    },
    userName: async id => {
      const r = await client.users.info({ token: tokens.bot, user: id })
      return r.user?.profile?.display_name || r.user?.real_name || r.user?.name || undefined
    },
    api: {
      history: async a => page(await client.conversations.history({ token: tokens.bot, channel: a.channel, oldest: a.oldest, limit: 200, ...(a.cursor && { cursor: a.cursor }) }).catch(e => { throw explainSlackError(e) })),
      dms: async () => {
        const out: { channel: string; user?: string }[] = []
        let cursor: string | undefined
        for (let i = 0; i < 5; i++) {
          const r = await client.users.conversations({ token: tokens.bot, types: 'im', limit: 200, ...(cursor && { cursor }) }).catch(e => { throw explainSlackError(e) })
          for (const c of (r.channels ?? []) as { id?: string; user?: string }[]) if (c.id) out.push({ channel: c.id, ...(c.user && { user: c.user }) })
          cursor = r.response_metadata?.next_cursor || undefined
          if (!cursor) break
        }
        return out
      },
      replies: async a => page(await client.conversations.replies({ token: tokens.bot, channel: a.channel, ts: a.ts, oldest: a.oldest, inclusive: a.inclusive, limit: 200, ...(a.cursor && { cursor: a.cursor }) }).catch(e => { throw explainSlackError(e) })),
    },
  }
}
