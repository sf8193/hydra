import { App, LogLevel } from '@slack/bolt'
import { SocketSupervisor, START_TIMEOUT_MS, type SocketEmitter } from '../shared/socket-supervisor.js'
import { catchUp, toEvent, type CatchUpResult, type RawMessage, type SlackApi } from './slack-catchup.js'
import type { SlackWatchConfig, SlackWatcher } from './slack-watch.js'

/**
 * The Slack side of Slack watching: one read-only Socket Mode connection that feeds
 * `message` events to the watcher, and the catch-up pass that replays what the
 * connection missed. It never posts to Slack.
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
  [/missing_scope/, 'the bot token lacks a scope. Add the scope named above (channels:history for public channels, groups:history for private ones), reinstall the app, put the new bot token in SLOPBOT_SLACK_BOT_TOKEN, and restart the daemon.'],
  [/invalid_auth|not_authed|token_revoked|token_expired|account_inactive/, 'Slack does not accept the bot token. Put a valid bot token in SLOPBOT_SLACK_BOT_TOKEN and restart the daemon.'],
  [/not_in_channel|channel_not_found/, 'the bot cannot see a channel listed in slack-watch.json. Invite it to the channel, or correct the channel id.'],
]

/** Slack's `missing_scope` names the scope it needed and the ones the token has; the SDK's message drops both. */
export function explainSlackError(err: unknown): Error {
  const data = (err as { data?: { error?: string; needed?: string; provided?: string } } | null)?.data
  if (data?.error === 'missing_scope') return new Error(`missing_scope: the token needs ${data.needed ?? '(unnamed)'} and has ${data.provided ?? '(unknown)'}`)
  return err instanceof Error ? err : new Error(String(err))
}

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
  authTest(): Promise<{ botId?: string; userId?: string; scopes?: string[] }>
  userName(userId: string): Promise<string | undefined>
  api: SlackApi
}

/** A Slack `message` event as Bolt hands it over. */
export type RawEvent = RawMessage & { channel?: string }

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
  config: () => SlackWatchConfig | null
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

  constructor(private readonly d: ListenerDeps) {
    this.now = d.now ?? Date.now
  }

  /** False, with a log line naming what is missing, when Slack watching is not configured. */
  async start(): Promise<boolean> {
    const cfg = this.d.config()
    const t = this.d.tokens()
    if (!cfg || !t.app || !t.bot) {
      this.d.log(`daemon: slack listener off (${!cfg ? 'no valid slack-watch.json' : `${!t.app ? 'SLOPBOT_SLACK_APP_TOKEN' : 'SLOPBOT_SLACK_BOT_TOKEN'} is not set`})\n`)
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
    const cfg = this.d.config()
    if (!t.app || !t.bot || !cfg) throw new Error('slack listener is not configured')
    if (this.app) { try { await this.app.stop() } catch {} }
    const app = this.d.createApp({ app: t.app, bot: t.bot })
    app.onMessage(raw => this.onMessage(raw))
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
    await app.start()
    const auth = await app.authTest().catch(err => { this.d.log(`daemon: slack listener: auth.test failed: ${err}\n`); return {} as { botId?: string; userId?: string; scopes?: string[] } })
    if (auth.botId) this.d.watcher.setBotId(auth.botId)
    if (auth.userId && auth.userId !== cfg.botUserId) {
      this.d.log(`daemon: slack listener: WARN connected as ${auth.userId} but slack-watch.json names botUserId ${cfg.botUserId}\n`)
    }
    if (auth.scopes) {
      // Scopes are not secret; the token is. Logging them turns "missing_scope" from a guess into a read.
      this.d.log(`daemon: slack listener: bot token scopes: ${auth.scopes.join(', ') || '(none)'}\n`)
      if (!auth.scopes.some(sc => sc === 'channels:history' || sc === 'groups:history')) {
        this.d.log('daemon: slack listener: WARN the bot token has neither channels:history nor groups:history, so no message can be read; add the one that matches your channels and reinstall the app\n')
      }
    }
    this.d.watcher.setNameResolver(id => app.userName(id))
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
    const cfg = this.d.config()
    if (!cfg || !this.app) return null
    if (this.catching) { this.rerun = (this.rerun ?? false) || deep; return null }
    this.catching = true
    const afterReconnect = this.reconnectedSincePass
    if (why !== 'periodic') this.reconnectedSincePass = false
    let result: CatchUpResult | null = null
    try {
      result = await catchUp(this.d.watcher, this.app.api, cfg, { deep, now: this.now, log: this.d.log })
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
  const client = app.client
  const page = (r: { messages?: unknown[]; response_metadata?: { next_cursor?: string } }) => ({
    messages: (r.messages ?? []) as RawMessage[],
    ...(r.response_metadata?.next_cursor && { next: r.response_metadata.next_cursor }),
  })
  return {
    onMessage: h => { handler = h },
    start: async () => { await app.start() },
    stop: async () => { await app.stop() },
    emitter: () => (app as unknown as { receiver?: { client?: SocketEmitter } }).receiver?.client ?? null,
    authTest: async () => {
      const r = await client.auth.test({ token: tokens.bot })
      const scopes = (r as { response_metadata?: { scopes?: string[] } }).response_metadata?.scopes
      return { botId: r.bot_id, userId: r.user_id, ...(scopes && { scopes }) }
    },
    userName: async id => {
      const r = await client.users.info({ token: tokens.bot, user: id })
      return r.user?.profile?.display_name || r.user?.real_name || r.user?.name || undefined
    },
    api: {
      history: async a => page(await client.conversations.history({ token: tokens.bot, channel: a.channel, oldest: a.oldest, limit: 200, ...(a.cursor && { cursor: a.cursor }) }).catch(e => { throw explainSlackError(e) })),
      replies: async a => page(await client.conversations.replies({ token: tokens.bot, channel: a.channel, ts: a.ts, oldest: a.oldest, inclusive: a.inclusive, limit: 200, ...(a.cursor && { cursor: a.cursor }) }).catch(e => { throw explainSlackError(e) })),
    },
  }
}
