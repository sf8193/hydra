import { LogLevel } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import { SocketSupervisor, START_TIMEOUT_MS, type SocketEmitter } from '../../shared/socket-supervisor.js'
import { catchUp, toEvent, BIND_SKEW_S, type CatchUpResult, type Page, type RawMessage, type SlackApi } from './catchup.js'
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync } from 'fs'
import { dirname } from 'path'
import { linkPreviewsOff } from '../../shared/link-previews.js'
import { routedChannels, hearsDms, dmsDeclared, namedChannels, unresolvedPlaces, isDm, type SlackReactionEvent, mentionedApps, NOT_A_MEMBER, OPERATOR_TOKEN_REFUSED, NO_DIRECTORY, SLACK_LIMITS, type AppConversations, type DmOtherParty, type SlackDirectory, type ConversationConfig, type ConversationTable } from './watch.js'
import { DEFAULT_SLACK_APP, mustParsePlace, placeCovers, placeKey, isChannelName, placeOf, placesAnsweredBy, samePlace, type HydraConfig, type SlackApp } from '../../config/types.js'
import { reachableBy } from '../../routing/route.js'
import { SLACK_APP_NEEDS, NO_SLACK_APP, appKey, appName, appSuffix, type Apps, type ScopeNeed } from './app.js'
import { ConnectedApps } from './apps.js'
import { timed } from '../../shared/loop-watch.js'
import { awakeSince, suspendedSince, describeCause, type ResumeDetector } from '../../shared/resume.js'
import { buildSocketApp, parseAuth, unfurlFields } from '../../shared/slack-client.js'

/**
 * The Slack connector for one app: one Socket Mode connection that feeds `message` events to the watcher, and the catch-up pass
 * that replays what the connection missed. Each app hydra.toml declares has a listener of its own (runtime.ts), all feeding one watcher. Its writes are reactions (the `ack`, and 🚫) and a specialist's replies,
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

/** Slack errors a retry cannot fix, each with what to do about it, for one app. */
export const permanentSlackErrors = (apps: Apps, app: string): [RegExp, string][] => [
  [/missing_scope/, 'the bot token lacks a scope. Add the scope named above (channels:history for public channels, groups:history for private ones), reinstall the app, put the new bot token in the variable the ' + appKey(apps, app, 'bot_token_env') + ' names (in `.env`), and restart the daemon.'],
  [/invalid_auth|not_authed|token_revoked|token_expired|account_inactive/, 'Slack does not accept the bot token. Put a valid bot token in the variable the ' + appKey(apps, app, 'bot_token_env') + ' names (in `.env`), and restart the daemon.'],
  [/not_in_channel|channel_not_found/, 'the bot cannot see a channel hydra.toml names. Invite the bot to the channel named above, or correct the place in hydra.toml.'],
]

/** Slack's `missing_scope` names the scope it needed and the ones the token has; the SDK's message drops both. */
export function explainSlackError(err: unknown): Error {
  const data = (err as { data?: { error?: string; needed?: string; provided?: string } } | null)?.data
  if (data?.error === 'missing_scope') return new Error(`missing_scope: the token needs ${data.needed ?? '(unnamed)'} and has ${data.provided ?? '(unknown)'}`)
  return err instanceof Error ? err : new Error(String(err))
}

/** The operator can't read the thread either: settled, as gone. */
const OPERATOR_CANT = /not_in_channel|channel_not_found|thread_not_found|message_not_found/
/** The operator's token itself is refused: no thread is at fault, and none is let go for it. */
const OPERATOR_TOKEN_BAD = /missing_scope|invalid_auth|not_authed|token_revoked|token_expired|account_inactive/

/**
 * A thread is read by the bot; where the bot is not a member and an operator token is set, as the operator: reading only,
 * never posting. The bot is always asked first, so an invite moves the thread back. When the operator can't read it
 * either, the bot's "not a member" is kept in the error, so catch-up lets go of that one thread. A refused operator
 * token is said as such, so catch-up skips the thread and keeps it; a passing failure is thrown as itself.
 */
export async function readReplies(read: (token: string) => Promise<Page>, tokens: { bot: string; user?: string }): Promise<Page> {
  try { return await read(tokens.bot) } catch (e) {
    const botErr = e instanceof Error ? e : new Error(String(e))
    if (!tokens.user || !NOT_A_MEMBER.test(botErr.message)) throw botErr
    try { return { ...await read(tokens.user), via: 'user' } } catch (e2) {
      const why = e2 instanceof Error ? e2.message : String(e2)
      if (OPERATOR_TOKEN_BAD.test(why)) throw new Error(`${OPERATOR_TOKEN_REFUSED} (${why})`)
      if (!OPERATOR_CANT.test(why)) throw e2 instanceof Error ? e2 : new Error(why)
      throw new Error(`${botErr.message}; as the operator: ${why}`)
    }
  }
}

/** Whose a message is, to one app: its own bot's, the operator's, or someone else's. */
export type MessageAuthor = 'app' | 'operator' | 'other'
/** Whose token rewrites a message: the app's bot, or the operator. */
export type Writer = Exclude<MessageAuthor, 'other'>
/** One message of a conversation as `fetch_messages` shows it: `mine` when this app's bot wrote it; `author` a display name, else the Slack id. */
export type ReadMessage = { ts: string; author: string; mine: boolean; text: string; files: number }
/** Pages of a thread read to reach its newest messages (Slack lists a thread oldest first, 200 a page): past them a read is refused, never cut short. */
export const READ_MAX_PAGES = 10

/** One post's deadline. Past it the post's outcome is unknown: it may have landed. */
export const POST_TIMEOUT_MS = 30_000
export const CATCH_UP_INTERVAL_MS = 10 * 60_000
export const CATCH_UP_RETRY_MS = 60_000
export const ALERT_CHECK_MS = 60_000
/** After a failed read of the bot's DM list, how long before the next: one read per window, however many DMs wait. */
export const DM_LIST_BACKOFF_MS = 60_000

export const DOWN_ALERT_AFTER_MS = 5 * 60_000
export const CATCH_UP_STALE_AFTER_MS = CATCH_UP_INTERVAL_MS * 2.5
/** An owed message that two catch-up passes have not delivered is stuck: `hydra health` lists it with its cause. */
export const OWED_LATE_AFTER_MS = CATCH_UP_INTERVAL_MS * 2
const MISSED_LIVE_ALERT_EVERY_MS = 60 * 60_000
/**
 * Periodic passes that find messages the socket never delivered, while it held and with no live event since, before the
 * connector says Slack has switched the app's events off. One such pass is a quiet stretch of a split stream as often as not;
 * three are at least half an hour of messages that all came by catch-up and none live.
 */
export const EVENTS_OFF_AFTER_PASSES = 3
/** The longest a message waits to learn which apps are in its channel. */
export const MEMBERSHIP_WAIT_MS = 5_000

/** What the Slack SDK offers the listener, narrowed so the rest is testable without it. */
/** `unfurl: false` posts without link previews (a place's `link_previews = false`); absent, Slack's own default. */
export type PostOptions = { unfurl?: false }

/** The chat.postMessage arguments for one reply: the thread when there is one, and unfurling off exactly when asked. */
export function postPayload(channel: string, threadTs: string | undefined, text: string, opts?: PostOptions): Record<string, unknown> {
  return { channel, text, ...(threadTs && { thread_ts: threadTs }), ...unfurlFields(opts?.unfurl === false) }
}

export type SlackAppLike = {
  onMessage(handler: (event: RawEvent) => void): void
  /** Every message event the socket delivers, before Bolt's own filters (`ignoreSelf` among them) see it. Absent: not offered. */
  onWire?(handler: (event: RawEvent, via: WireVia) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  emitter(): SocketEmitter | null
  authTest(): Promise<{ botId?: string; userId?: string; url?: string; scopes?: string[] }>
  /** Every channel the bot can see, by id and name (conversations.list). Needs channels:read or groups:read. */
  channels(): Promise<{ id: string; name: string }[]>
  /** A channel was renamed (channel_rename, or group_rename for a private one). */
  onRename(handler: (id: string, name: string) => void): void
  /** A person (or a bot) reacted to a message (reaction_added). Subscribed only where a place's `reactions` asks for it. */
  onReaction?(handler: (event: SlackReactionEvent) => void): void
  /** Whether the bot is a member of a channel (conversations.info). Needs channels:read or groups:read. Asked only while several apps are connected. */
  isMember?(channel: string): Promise<boolean>
  /** Someone joined or left a channel (member_joined_channel, member_left_channel): who is in it may have changed. Subscribed only with several apps. */
  onMembership?(handler: (channel: string) => void): void
  userName(userId: string): Promise<string | undefined>
  /** A message in a channel, or in a thread when `threadTs` is set. Resolves to its ts. */
  post(channel: string, threadTs: string | undefined, text: string, opts?: PostOptions): Promise<string>
  /** Rewrites a message (chat.update), as its bot or as the operator (user token, scope chat:write). Absent: not offered. */
  edit?(channel: string, ts: string, text: string, as: Writer): Promise<void>
  /** Deletes a message (chat.delete), as its bot or as the operator. Absent: not offered. */
  remove?(channel: string, ts: string, as: Writer): Promise<void>
  /** The operator's own user id (auth.test with the user token); undefined with no user token. */
  operatorUserId?(): Promise<string | undefined>
  /** Reactions (the ack, and 🚫). */
  react(channel: string, ts: string, name: string): Promise<void>
  /** A file's bytes, to `dest` at mode 0600 (its directory 0700). Throws past `maxBytes`. */
  download(url: string, dest: string, maxBytes: number): Promise<void>
  api: SlackApi
}

/**
 * The scopes the options of one app need (from `SLACK_APP_NEEDS`), so a missing one is a read at startup rather than a guess later.
 * Each app is asked only for what it does (`reachableBy`): channel history when it reads a named channel, serves a rule for any
 * place, or serves a specialist that hears no place (it answers only threads bound to it); DMs when something it serves names
 * `slack:app-dm:<app>` or `slack:app-dm:*`, or the operator has a Slack address; files when a place it reaches has them; the private-channel read only when one of
 * its places is private. One app's missing scope is never another's.
 */
export function scopesNeeded(h: HydraConfig, app: string = DEFAULT_SLACK_APP): ScopeNeed[] {
  const several = Object.keys(h.slackApps).length > 1
  const r = reachableBy(h, app)
  const places = namedChannels(h, app)
  const dms = hearsDms({ hydra: h, app })
  const everyPlace = r.rules.some(x => x.place === undefined)
  const channels = places.length > 0 || everyPlace || r.specialists.some(sp => placesAnsweredBy(h, sp.id).length === 0)
  const groupDms = r.rules.some(x => x.place?.kind === 'group-dm')
  const mine = placeOf('slack', 'app-dm', app)
  const slackOpts = Object.entries(h.places).flatMap(([key, o]) => {
    const p = mustParsePlace(key)
    return p.platform === 'slack' && (everyPlace || places.some(q => samePlace(q, p)) || (p.kind === 'app-dm' && dms && placeCovers(p, mine)) || (p.kind === 'group-dm' && groupDms)) ? [o] : []
  })
  const s = SLACK_APP_NEEDS.botScopes
  return [
    ...(channels ? [s.channels] : []),
    ...(places.some(isChannelName) ? [s.channelNames] : []),
    s.senderNames,
    ...(dms ? [s.dms, s.dmCatchUp] : []),
    ...(groupDms ? [s.groupDms] : []),
    ...(slackOpts.some(o => o.files) ? [s.files] : []),
    s.reactions,
    ...(slackOpts.some(o => o.reactions !== 'off') ? [s.reactionsRead] : []),
    s.replies,
    ...(several && channels ? [SLACK_APP_NEEDS.membership.public, ...(places.some(p => p.ref.startsWith('G')) ? [SLACK_APP_NEEDS.membership.private] : [])] : []),
  ]
}

/**
 * The options of `scopesNeeded` that only the operator's own Slack address asks for (their DMs to `main`), because nothing
 * declares a DM with the bot (`slack:app-dm:…`). A token without them still runs everything that was declared, so they are shown in health, never alerted:
 * a hydra.toml that ran before must not start paging for an option nobody asked for.
 */
export function implicitScopeOptions(h: HydraConfig, app: string = DEFAULT_SLACK_APP): string[] {
  const view = { hydra: h, app }
  return hearsDms(view) && !dmsDeclared(view) ? [SLACK_APP_NEEDS.botScopes.dms.option, SLACK_APP_NEEDS.botScopes.dmCatchUp.option] : []
}

/** What a listener remembers across daemon restarts about what it has told the operator: per app, the scopes it said were missing. */
export type ToldScopes = { get(app: string): string | undefined; set(app: string, key: string | null): void }

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
export type RawEvent = RawMessage & { channel?: string; channel_type?: string; type?: string }

/** Which token an event came for: Slack's `authorizations` says whether the install it reached the app through is a bot's. */
export type WireVia = 'bot' | 'user' | 'unknown'

export type ListenerState = 'off' | 'connecting' | 'up' | 'down' | 'exhausted'
export type ListenerHealth = {
  state: ListenerState
  /** Minutes without a connection; null while up. */
  downMin: number | null
  lastActivityAgeMin: number | null
  catchUp: { ageMin: number; ok: boolean; accepted: number; reason?: string } | null
  lastOkCatchUpAgeMin: number | null
  /** Slack has probably switched this app's events off: said once, until a live event arrives. */
  eventsOff: boolean
  /** The scopes this app's bot token lacks for what hydra.toml has it do, by option; empty when it has them all. Null when Slack did not say what the token holds (or it has not connected yet). */
  missingScopes: { option: string; any: string[] }[] | null
}

export type ListenerDeps = {
  watcher: ConversationTable
  /** The app this listener is, by its id in hydra.toml. Absent: `default`. It connects only while hydra.toml declares it. */
  app?: string
  /** What the connections share: each app's bot ids, and which apps are in which channel. Absent: this listener's own. */
  apps?: ConnectedApps
  /** hydra.toml as loaded now. */
  hydra: () => HydraConfig
  /** The scopes already said to be missing, kept across restarts so a boot does not say them again. Absent: remembered for this listener's life only. */
  told?: ToldScopes
  /** The tokens of one app, read from the variables it names. */
  tokens: (app: SlackApp) => { app?: string; bot?: string; user?: string }
  createApp: (tokens: { app: string; bot: string; user?: string }) => SlackAppLike
  /** A plain message to the specialist's thread (not a session turn). */
  alert: (text: string) => void
  log: (line: string) => void
  now?: () => number
  /** Time the daemon was suspended (shared/resume.ts): the catch-up alarm and the supervisor age by awake time. */
  resumes?: Pick<ResumeDetector, 'awakeSince' | 'suspendedSince'>
  healthUrl?: string
  /** The longest a message waits to learn which apps are in its channel. Default `MEMBERSHIP_WAIT_MS`. */
  membershipWaitMs?: number
  /** First delay before retrying a failed first connection; doubles up to 5 minutes. */
  firstRetryBaseMs?: number
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>
}

/**
 * One list of the operator's DMs, read one read at a time and shared by every DM waiting on it. `settle` answers whether a channel is on it:
 * 'known' (it is), 'absent' (it is not, on a read that began after the channel's message arrived: final), or 'unknown' (a read failed or
 * is backing off). A channel missing from a read that began before its message arrived (a DM opened while that read was in flight) is read
 * for again once, so a brand-new DM is never left nameless. A failed read is not tried again for `DM_LIST_BACKOFF_MS`.
 */
class DmList {
  private listing: { done: Promise<boolean>; startedAt: number } | null = null
  private failedAt = -Infinity
  private loggedAt = -Infinity
  constructor(private readonly now: () => number, private readonly fetch: () => Promise<void>, private readonly onFail: (err: string) => void) {}

  /** Read the list now, or join the read in flight. False when it failed or is backing off. */
  read(): Promise<boolean> { return this.start()?.done ?? Promise.resolve(false) }

  private start(): { done: Promise<boolean>; startedAt: number } | null {
    if (this.now() - this.failedAt < DM_LIST_BACKOFF_MS) return null
    this.listing ??= (() => {
      const startedAt = this.now()
      const done = (async () => {
        try { await this.fetch(); return true } catch (err) {
          this.failedAt = this.now()
          // Said once an hour: the cause (a missing scope) does not change between messages.
          if (this.now() - this.loggedAt >= 60 * 60_000) { this.loggedAt = this.now(); this.onFail(err instanceof Error ? err.message : String(err)) }
          return false
        } finally { this.listing = null }
      })()
      return { done, startedAt }
    })()
    return this.listing
  }

  async settle(channel: string, arrivedAt: number, isKnown: () => boolean): Promise<'known' | 'absent' | 'unknown'> {
    for (let reads = 0; reads < 2; reads++) {
      if (isKnown()) return 'known'
      const read = this.start()
      if (!read || !await read.done) return 'unknown'
      if (isKnown()) return 'known'
      if (read.startedAt >= arrivedAt) return 'absent'
    }
    return 'unknown'
  }
}

export class SlackListener {
  private readonly now: () => number
  private readonly resumes: Pick<ResumeDetector, 'awakeSince' | 'suspendedSince'>
  private app: SlackAppLike | null = null
  private sup: SocketSupervisor | null = null
  private started = false
  private startedAt = 0
  private generation = 0
  private everConnected = false
  /** The latest moment the live stream was known not to be delivering: a drop, or the reconnect that ended one. */
  private lastGapAt = 0
  /** A resume asked for a fresh socket: the catch-up pass that follows is the resume's, whether a socket came up or not. */
  private resumePassOwed = false
  /** When the last complete catch-up pass started: everything before it has been read. Null until one completes. */
  private lastOkCatchUpStartedAt: number | null = null
  private catching = false
  private rerun: boolean | null = null
  private lastCatchUp: { at: number; result: CatchUpResult } | null = null
  private lastOkCatchUpAt: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private firstTimer: ReturnType<typeof setTimeout> | undefined
  private firstAttempts = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private alerted: { down: boolean; catchUp: boolean; permanent: string | null; eventsOff: boolean } = { down: false, catchUp: false, permanent: null, eventsOff: false }
  private readonly told: ToldScopes
  private missingScopes: { option: string; any: string[] }[] | null = null
  private lastMissedLiveAlertAt = 0
  /** When the socket last delivered an event (a message, a reaction, a rename or a membership change). */
  private lastLiveAt = 0
  /** Passes since the last live event that found messages the socket never delivered while it held: the evidence that Slack switched this app's events off. */
  private silentPasses = 0
  private identity: { botUserId: string; botId?: string; workspaceUrl?: string } | null = null
  private readonly directory = new Directory()
  private directoryRead = false
  private namesWarned = false
  readonly id: string
  private readonly apps: ConnectedApps
  private readonly w: AppConversations
  /** Per channel, the events waiting for who is in it to be read, in the order they came: none is handled ahead of one before it. A channel with nothing waiting never queues. */
  private readonly queues = new Map<string, Promise<void>>()
  /** With the operator's user token: the bot's own DM channels (from the bot's list, or the bot posting in one), and who is on the other end of the rest (a DM's two ends never change, so an answer is final). */
  private readonly botDms = new Set<string>()
  private readonly otherParties = new Map<string, string>()
  /** DM channels on neither list, read after their message arrived: they go by no name. */
  private readonly absentDms = new Set<string>()
  private botDmList!: DmList
  private userDmList!: DmList
  /** Channels an event called a group DM (`channel_type` mpim): their id looks like a channel's. */
  private readonly groupDms = new Set<string>()

  constructor(private readonly d: ListenerDeps) {
    this.now = d.now ?? Date.now
    this.resumes = d.resumes ?? { awakeSince, suspendedSince }
    this.id = d.app ?? DEFAULT_SLACK_APP
    this.apps = d.apps ?? new ConnectedApps({ now: this.now, log: d.log, alert: t => d.alert(t) })
    this.w = d.watcher.forApp(this.id)
    const absorb = (list: { channel: string; user?: string }[]) => {
      const bot = this.identity?.botUserId
      for (const x of list) if (x.user) { if (x.user === bot) this.botDms.add(x.channel); else this.otherParties.set(x.channel, x.user) }
    }
    this.botDmList = new DmList(this.now, async () => (await this.app?.api.dms?.() ?? []).forEach(x => this.botDms.add(x.channel)), err => this.d.log(`daemon: slack connector: listing the bot's DMs failed, so a DM with the bot is not known (tried again in ${DM_LIST_BACKOFF_MS / 1000}s): ${err}\n`))
    this.userDmList = new DmList(this.now, async () => absorb(await this.app?.api.otherParties?.() ?? []), err => this.d.log(`daemon: slack connector: listing the operator's DMs failed (it needs im:read on the user token), so a DM with a person names no place and is dropped until it works (tried again in ${DM_LIST_BACKOFF_MS / 1000}s): ${err}\n`))
    const mine = new Map<string, string>()
    this.told = d.told ?? { get: app => mine.get(app), set: (app, key) => { if (key === null) mine.delete(app); else mine.set(app, key) } }
  }

  /** This app as hydra.toml declares it. */
  private declared(): SlackApp | undefined { const a = this.d.hydra().slackApps; return Object.hasOwn(a, this.id) ? a[this.id] : undefined }

  /** Every app hydra.toml declares: what a message needs to name this one. */
  private declaredApps(): Apps { return this.d.hydra().slackApps }

  /** ` for Sales desk`: said in alerts only when there is more than one app to tell apart. */
  private appSuffix(): string { return appSuffix(this.declaredApps(), this.id) }

  /** The command that prints this app's manifest: a lone `default` needs no name. */
  private manifestCommand(): string { return this.id === DEFAULT_SLACK_APP && Object.keys(this.d.hydra().slackApps).length <= 1 ? 'hydra slack manifest' : `hydra slack manifest ${this.id}` }

  /** What the watcher routes with: hydra.toml joined with what this connection learned. Null until connected once. */
  view(): ConversationConfig | null {
    const hydra = this.d.hydra()
    if (!this.declared() || !this.identity) return null
    return {
      hydra, app: this.id, ...this.identity,
      identities: this.apps.identities(),
      heardBy: channel => this.apps.heardBy(channel, this.id),
      unread: (channel, apps) => this.apps.unread(channel, apps),
      connected: () => this.apps.connectedApps(),
      // With one app connected there is nothing to tell apart, and nothing to remember.
      ...(this.apps.several() && { decideOwningApp: (channel: string, ts: string, decide: () => string) => this.apps.decideOwningApp(channel, ts, decide) }),
      directory: this.directoryView(), ...SLACK_LIMITS,
    }
  }

  /** Slack's read calls, for a check outside catch-up (bind_conversation's). Null before the first connect attempt. */
  get api(): SlackApi | null { return this.app?.api ?? null }

  /** A specialist's reply, into its conversation. Throws when Slack isn't connected. */
  async post(channel: string, threadTs: string | undefined, text: string): Promise<string> {
    if (!this.app || !this.sup?.state.connected) throw new Error(`Slack is not connected${this.appSuffix()}; try again once it is (hydra health shows the slack connector)`)
    // The same predicate the gateway asks (shared/link-previews.ts), with this app's own view of hydra.toml and channel names.
    const unfurl = linkPreviewsOff('slack', [channel], { config: this.d.hydra(), slackName: id => this.directory.nameOf(id), app: this.id }) ? { unfurl: false as const } : undefined
    return this.app.post(channel, threadTs, text, unfurl)
  }

  private live(): SlackAppLike {
    if (!this.app || !this.sup?.state.connected) throw new Error(`Slack is not connected${this.appSuffix()}; try again once it is (hydra health shows the slack connector)`)
    return this.app
  }

  /** Whose a message is: this app's bot's, the operator's (known only with the operator's token), or someone else's. Read from Slack, never assumed. */
  async author(channel: string, ts: string, threadTs: string | undefined): Promise<MessageAuthor> {
    const app = this.live()
    // Slack puts a thread's first message ahead of the page, so the one asked for may be the second: two are read, and it is found by ts.
    const page = await app.api.replies({ channel, ts: threadTs ?? ts, oldest: ts, inclusive: true, limit: 2 })
    const m = page.messages.find(x => x.ts === ts)
    if (!m) throw new Error(`message ${ts} was not found in ${channel}`)
    // A conversation with no thread ts is the top level: a message inside one of its threads is that thread's conversation, not this one.
    if (threadTs === undefined && m.thread_ts && m.thread_ts !== m.ts) throw new Error(`message ${ts} is a reply inside the thread ${m.thread_ts}: name that thread's conversation (slack:…:${channel}:${m.thread_ts}) instead`)
    if (this.identity && (m.user === this.identity.botUserId || (!!m.bot_id && m.bot_id === this.identity.botId))) return 'app'
    const operator = await app.operatorUserId?.()
    return operator && m.user === operator ? 'operator' : 'other'
  }

  /** Rewrites a message as its bot or as the operator. Slack's refusal is thrown as it came. */
  async edit(channel: string, ts: string, text: string, as: Writer): Promise<void> {
    const app = this.live()
    if (!app.edit) throw new Error('this Slack client cannot edit messages')
    await app.edit(channel, ts, text, as)
  }

  /**
   * A conversation's newest `limit` messages, oldest first: a thread's (read to its end, so its newest are reached; a thread longer than
   * READ_MAX_PAGES pages is refused, not answered with its oldest), or, with no `threadTs`, a channel's or a DM's top level. Read with this app's bot
   * token; with `asOperator`, a thread the bot is not in with the operator's, as catch-up reads it (the caller says when: the operator's token
   * reaches the operator's own DMs and groups). Slack's refusal is thrown as it came.
   */
  async read(channel: string, threadTs: string | undefined, limit: number, asOperator: boolean): Promise<ReadMessage[]> {
    const app = this.live()
    let raw: RawMessage[] = []
    if (threadTs) {
      let cursor: string | undefined
      const seen = new Set<string | undefined>()
      for (let pages = 0; ; pages++) {
        if (pages === READ_MAX_PAGES) throw new Error(`the thread ${threadTs} is longer than ${READ_MAX_PAGES * 200} messages, more than fetch_messages reads: its newest can't be reached`)
        const page = await app.api.replies({ channel, ts: threadTs, oldest: threadTs, inclusive: true, limit: 200, botOnly: !asOperator, ...(cursor && { cursor }) })
        // Each page may lead with the thread's first message again: a message is kept once.
        raw = [...raw, ...page.messages.filter(m => !seen.has(m.ts) && !!seen.add(m.ts))].slice(-limit)
        cursor = page.next
        if (!cursor) break
      }
    } else {
      // History is newest first.
      raw = (await app.api.history({ channel, oldest: '0' })).messages.slice(0, limit).reverse()
    }
    const names = new Map<string, Promise<string | undefined>>()
    const nameOf = (user: string) => { let n = names.get(user); if (!n) names.set(user, n = app.userName(user).catch(() => undefined)); return n }
    const out: ReadMessage[] = []
    for (const m of raw) {
      if (!m.ts) continue
      const mine = !!this.identity && (m.user === this.identity.botUserId || (!!m.bot_id && m.bot_id === this.identity.botId))
      const author = mine ? 'me' : m.user ? (await nameOf(m.user)) ?? m.user : m.bot_id ?? 'unknown'
      out.push({ ts: m.ts, author, mine, text: m.text ?? '', files: m.files?.length ?? 0 })
    }
    return out
  }

  /** Deletes a message as its bot or as the operator. Slack's refusal is thrown as it came. */
  async remove(channel: string, ts: string, as: Writer): Promise<void> {
    const app = this.live()
    if (!app.remove) throw new Error('this Slack client cannot delete messages')
    await app.remove(channel, ts, as)
  }

  /** Channel names, read again. A failure keeps the last list; the missing scope is said once. */
  private async refreshDirectory(app: SlackAppLike): Promise<void> {
    try {
      this.directory.replace(await app.channels())
      this.directoryRead = true
      this.namesWarned = false   // read again: a later failure is a new episode
    } catch (err) {
      if (this.namesWarned) return
      this.namesWarned = true
      const needed = unresolvedPlaces({ hydra: this.d.hydra(), directory: this.directoryRead ? this.directory : NO_DIRECTORY, app: this.id })
      const why = err instanceof Error ? err.message : String(err)
      this.d.log(`daemon: slack connector: WARN channel names can't be read (${why}): add channels:read and groups:read and reinstall the app, or name channels by id (slack:C…)${needed.length ? `; ${needed.map(placeKey).join(', ')} ${needed.length === 1 ? 'hears' : 'hear'} nothing until then` : ''}\n`)
      // Said to the specialists this app serves only when a `#name` it needs is unresolved: otherwise the ids work without names.
      if (needed.length) this.d.alert(`⚠️ Hydra can't read channel names${this.appSuffix()} (${why}), so ${needed.map(placeKey).join(', ')} ${needed.length === 1 ? 'hears' : 'hear'} nothing. Add channels:read and groups:read to the app (\`${this.manifestCommand()}\` prints them), reinstall it, put the new bot token in the variable the ${appKey(this.declaredApps(), this.id, 'bot_token_env')} names (in \`.env\`), and restart the daemon; or name the channels by id (slack:C…).`)
    }
  }

  /** False, with a log line naming what is missing, when Slack watching is not configured. */
  async start(): Promise<boolean> {
    const slack = this.declared()
    const t = slack ? this.d.tokens(slack) : {}
    if (!slack || !t.app || !t.bot) {
      this.d.log(`daemon: slack connector${this.appSuffix()} off (${!slack ? (Object.keys(this.d.hydra().slackApps).length ? `hydra.toml has no app named \`${this.id}\`` : NO_SLACK_APP) : !t.bot ? `${slack.botTokenEnv} is not set` : slack.socketTokenEnv ? `${slack.socketTokenEnv} is not set` : `${appKey(this.declaredApps(), this.id, 'socket_token_env')} is not set, and Socket Mode needs it`})\n`)
      return false
    }
    if (this.started) return true
    this.started = true
    this.startedAt = this.now()
    this.sup = new SocketSupervisor({
      name: `slack connector${this.appSuffix()}`,
      start: () => this.connect(),
      emitter: () => this.app?.emitter() ?? null,
      healthUrl: this.d.healthUrl ?? 'https://slack.com/api/api.test',
      // Degrade, never exit: the supervisor keeps trying at its capped backoff, and health and the alert say so.
      onExhausted: n => this.d.log(`daemon: slack connector: ${n} reconnect attempts failed; still trying, see health\n`),
      now: this.now,
      resumes: this.resumes,
      fetch: this.d.fetch,
      log: this.d.log,
    })
    try {
      await this.boundedConnect()
    } catch (err) {
      this.d.log(`daemon: slack connector: first connection failed, will keep trying: ${err instanceof Error ? err.message : err}\n`)
      this.apps.failedToJoin(this.id)   // the other apps do not wait on it; it joins when it connects
      this.scheduleFirstRetry()
    }
    this.sup.begin()
    for (const [name, fn, ms] of [['slack-catch-up', () => { void this.runCatchUp(true, 'periodic') }, CATCH_UP_INTERVAL_MS], ['slack-alerts', () => { void this.checkAlerts() }, ALERT_CHECK_MS]] as const) {
      const timer = setInterval(() => timed(name, fn), ms)
      ;(timer as { unref?: () => void }).unref?.()
      this.timers.push(timer)
    }
    if (this.app && this.sup.state.connected) await this.runCatchUp(true, 'boot')
    return true
  }

  stop(): void {
    this.started = false
    this.generation++   // a connect still in flight finds itself stale, and stops what it made
    if (this.firstTimer) clearTimeout(this.firstTimer)
    for (const t of this.timers.splice(0)) clearInterval(t)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.sup?.stop()
    void this.app?.stop().catch(() => {})
    this.app = null
    this.apps.leave(this.id)   // not joining, no identity, no probe
    this.w.setSlackActions(undefined)
    this.w.setNameResolver(undefined)
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
    const h = this.d.hydra()
    const slack = this.declared()
    const t = slack ? this.d.tokens(slack) : {}
    if (!t.app || !t.bot || !slack) throw new Error(`slack connector${this.appSuffix()} is not configured`)
    const gen = ++this.generation
    // Stopped (or replaced) while this was waiting: what it made is let go, and nothing of it is left registered.
    const stale = async (made?: SlackAppLike): Promise<void> => {
      if (gen === this.generation && this.started) return
      if (made) { try { await made.stop() } catch {} ; if (this.app === made) this.app = null }
      throw new Error('stopped while connecting')
    }
    if (this.app) { try { await this.app.stop() } catch {} }
    await stale()
    const app = this.d.createApp({ app: t.app, bot: t.bot, ...(t.user && { user: t.user }) })
    app.onMessage(raw => { if (gen === this.generation) this.onMessage(raw) })
    // The socket's own view, ahead of every Bolt filter: told apart from `heard` below, it says whether a lost DM never arrived or was dropped after.
    app.onWire?.((raw, via) => {
      if (gen !== this.generation || !raw.channel || !(isDm(raw.channel) || raw.channel_type === 'im' || raw.channel_type === 'mpim')) return
      this.d.log(`daemon: slack connector: ${this.id} socket received message in ${raw.channel} (${raw.ts ?? '-'}) from ${raw.user ?? '-'} subtype=${raw.subtype ?? '-'} bot_id=${raw.bot_id ?? '-'} via ${via} token\n`)
    })
    app.onReaction?.(r => { if (gen === this.generation) { this.sup?.touch(); this.heardLive(); this.w.handleReaction(r) } })
    app.onRename((id, name) => { if (gen === this.generation) this.heardLive(); this.directory.rename(id, name); this.d.log(`daemon: slack connector: channel ${id} is now #${name}\n`) })
    app.onMembership?.(channel => { if (gen === this.generation) this.heardLive(); this.apps.changed(channel, this.id); this.w.reactionsMayWork(channel) })
    this.app = app
    this.sup!.attach() // before start, so the first `connected` is seen
    app.emitter()?.on('connected', () => {
      if (gen !== this.generation) return
      const was = this.everConnected
      this.everConnected = true
      // Every connection after the first follows a gap, however short: Slack replays nothing.
      if (was) { this.noteGap(); void this.runCatchUp(true, this.takeResumePass() ? 'resumed' : 'reconnected') }
    })
    // Who the bot is and what the channels are called, before the socket opens: routing needs both for the first event.
    const auth = await app.authTest().catch(err => { this.d.log(`daemon: slack connector: auth.test failed: ${err}\n`); return {} as { botId?: string; userId?: string; url?: string; scopes?: string[] } })
    await stale(app)
    if (auth.userId) this.identity = { botUserId: auth.userId, ...(auth.botId && { botId: auth.botId }), ...(auth.url && { workspaceUrl: auth.url.replace(/\/+$/, '') }) }
    // Without its own id, a tag can't be told from chatter: no connection is better than one that hears wrong.
    if (!this.identity) throw new Error('auth.test gave no bot user id, so tags cannot be recognized')
    if (auth.botId) this.w.setBotId(auth.botId)
    // Known to every connection from here: its bot's ids (so a tag of it is recognised), and whether it is in a channel (so exactly one app answers where several are).
    this.apps.join(this.id, { botUserId: this.identity.botUserId, ...(this.identity.botId && { botId: this.identity.botId }) }, channel => app.isMember ? app.isMember(channel) : Promise.reject(new Error('this Slack client cannot read channel membership')))
    await this.refreshDirectory(app)
    await stale(app)
    // With the operator's token, whose each DM is: known before the first event and the first catch-up read.
    if (this.hasOperatorToken()) { await Promise.all([this.botDmList.read(), this.userDmList.read()]); await stale(app) }
    // Hold every cursor before the socket opens: a live message must not move a cursor past the downtime gap the
    // catch-up pass that follows has yet to read. Each pass releases what it reads.
    const view = this.view()
    this.w.beginCatchUp([...routedChannels(view), ...this.w.taggedChannels(), ...(hearsDms(view) ? this.w.dmChannels() : [])])
    await app.start()
    await stale(app)
    const needed = scopesNeeded(h, this.id)
    this.d.log(`daemon: slack connector: enabled options need: ${needed.map(n => `${n.option} → ${n.any.join(' or ')}`).join('; ')}\n`)
    if (auth.scopes) {
      // Scopes are not secret; the token is. Logging them turns "missing_scope" from a guess into a read.
      this.d.log(`daemon: slack connector: bot token scopes: ${auth.scopes.join(', ') || '(none)'}\n`)
      const missing = needed.filter(n => !n.any.some(sc => auth.scopes!.includes(sc)))
      for (const n of missing) this.d.log(`daemon: slack connector: WARN ${n.option} needs ${n.any.join(' or ')}, which the bot token lacks; add it and reinstall the app\n`)
      this.missingScopes = missing.map(n => ({ option: n.option, any: [...n.any] }))
      const implicit = implicitScopeOptions(h, this.id)
      this.alertMissingScopes(missing.filter(n => !implicit.includes(n.option)))
    }
    this.w.setNameResolver(id => app.userName(id))
    this.w.setSlackActions({ react: (c, ts, name) => app.react(c, ts, name), download: (url, dest, max) => app.download(url, dest, max) })
    this.sup!.touch()
  }

  /**
   * With one app connected a message is handled at once. With several, which of them is in its channel decides who answers, so
   * a message in a channel where that is not known waits (a few seconds at most) for it, queued behind the earlier ones of that
   * channel only: a DM, or a channel that is settled, never waits on another. A message still undecidable because a started app
   * has not joined is not answered: its channel's cursor is held and a catch-up pass reads it once the app has joined.
   */
  private onMessage(raw: RawEvent): void {
    try {
      this.sup?.touch()
      this.heardLive()
      const channel = raw.channel
      if (!channel) { this.d.log(`daemon: slack connector: dropped: event with no channel (type=${raw.type ?? '-'} subtype=${raw.subtype ?? '-'} ts=${raw.ts ?? '-'})\n`); return }
      // A DM's arrival is said, so a message that is later passed over (`dropped …`) or never arrives is told apart.
      if (isDm(channel)) this.d.log(`daemon: slack connector: ${this.id} heard a message in ${channel} (${raw.ts}) from ${raw.user ?? raw.bot_id ?? 'unknown'}\n`)
      const tagged = this.taggedElsewhere(raw.text)
      const arrivedAt = this.now()
      // A DM or a group DM is this app's alone: no other app's membership decides it. With the operator's token, a DM
      // not yet known to be the bot's waits (briefly) to learn whose it is.
      const chat = isDm(channel) || raw.channel_type === 'mpim'
      if (!this.queues.has(channel) && !this.unknownDm(channel) && (chat || this.apps.settled(channel, this.id, tagged))) { this.ingest(raw); return }
      const behind = this.queues.get(channel) ?? Promise.resolve()
      const next: Promise<void> = behind.then(async () => {
        if (this.unknownDm(channel)) await this.learnDm(channel, raw.ts, arrivedAt)
        await this.knowMembers(chat ? [] : [channel], tagged)
        this.ingestOrHold(raw, channel)
      }).catch(err => {
        this.d.log(`daemon: slack connector: handling a message failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
      }).finally(() => { if (this.queues.get(channel) === next) this.queues.delete(channel) })
      this.queues.set(channel, next)
    } catch (err) {
      this.d.log(`daemon: slack connector: handling a message failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
    }
  }

  /** The other apps a text tags: the ones whose membership a decision must read fresh. */
  private taggedElsewhere(text: string | undefined): string[] {
    return this.apps.several() ? mentionedApps(this.apps.identities(), text).filter(a => a !== this.id) : []
  }

  /** Handle a message, or, when an app that was started has not yet joined, leave it unanswered: held (the cursor stays) and read again by a catch-up pass once it has. */
  private ingestOrHold(raw: RawEvent, channel: string): void {
    if (this.apps.isJoining() && routedChannels(this.view()).includes(channel)) {
      this.d.log(`daemon: slack connector: held ${channel} ${raw.ts}: an app is still joining, so who answers is not known; a catch-up pass reads it once every app has joined\n`)
      this.w.beginCatchUp([channel])
      void this.apps.allJoined().then(() => this.runCatchUp(false, 'apps joined'))
      return
    }
    this.ingest(raw)
  }

  /** Whether this app hears DMs between the operator and others: it has the operator's user token. Only then does a DM's other party need asking. */
  private hasOperatorToken(): boolean { return !!this.declared()?.operatorTokenEnv }

  /** A DM that is not known to be the bot's, nor to be with a named other party, nor found on neither list: its message waits (briefly) to learn whose it is. */
  private unknownDm(channel: string): boolean {
    return this.hasOperatorToken() && isDm(channel) && !this.botDms.has(channel) && !this.otherParties.has(channel) && !this.absentDms.has(channel)
  }

  /**
   * Whose a DM is, from two lists that answer two questions. The BOT token's list (`users.conversations`, which has only the bot's own
   * DMs, scope `im:read` on the bot) says whether it is the bot's: that DM is `slack:app-dm:<app>`. For one that is not, the USER token's list
   * (scope `im:read` on the user token) says who is on the other end, which is how `slack:person-dm:<person>` is found. An app without that user
   * scope loses only the second: the bot's DM still works, and a DM with a person goes by no name. Each list is read one read at a time
   * (see `DmList`); a DM on neither, after a read that began after its message arrived, goes by no name for good.
   */
  private async learnDm(channel: string, ts: string | undefined, arrivedAt: number): Promise<void> {
    this.d.log(`daemon: slack connector: holding ${channel} ${ts ?? '-'} to learn whose DM it is\n`)
    const released = (how: string) => this.d.log(`daemon: slack connector: released ${channel} ${ts ?? '-'}: ${how}\n`)
    if (await this.botDmList.settle(channel, arrivedAt, () => this.botDms.has(channel)) === 'known') return released('the bot\'s own DM')
    const found = await this.userDmList.settle(channel, arrivedAt, () => this.botDms.has(channel) || this.otherParties.has(channel))
    if (found === 'absent') this.absentDms.add(channel)
    released(found === 'known' ? (this.botDms.has(channel) ? 'the bot\'s own DM' : 'a DM with someone else') : found === 'absent' ? 'on neither list, so it goes by no name' : 'a list read failed or is backing off, so it goes by no name for now')
  }

  /** The directory this app routes with: channel names, and (with the operator's token) whose each DM is and which channels are group DMs. */
  private directoryView(): SlackDirectory {
    const base = this.directoryRead ? this.directory : NO_DIRECTORY
    return {
      nameOf: id => base.nameOf(id),
      idOf: name => base.idOf(name),
      isGroupDm: channel => this.groupDms.has(channel),
      ...(this.hasOperatorToken() && { otherPartyOf: (dm: string): DmOtherParty | undefined => this.botDms.has(dm) ? 'bot' : this.otherParties.has(dm) ? { user: this.otherParties.get(dm)! } : undefined }),
    }
  }

  /** Catch-up's reads. The bot's own DM list is the bot's DMs, so each is known to be the bot's. */
  private catchUpApi(): SlackApi {
    const api = this.app!.api
    const dms = api.dms
    return dms ? { ...api, dms: async () => { const list = await dms.call(api); for (const d of list) this.botDms.add(d.channel); return list } } : api
  }

  private ingest(raw: RawEvent): void {
    try {
      if (!raw.channel) return
      const ev = toEvent(raw.channel, raw)
      if (!ev) { if (isDm(raw.channel)) this.d.log(`daemon: slack connector: dropped ${raw.channel}: the event has no timestamp\n`); return }
      // The bot posting in a DM proves it is the bot's; the event says when a channel is a group DM.
      if (isDm(raw.channel) && this.identity && (raw.user === this.identity.botUserId || (!!raw.bot_id && raw.bot_id === this.identity.botId))) this.botDms.add(raw.channel)
      if (raw.channel_type === 'mpim') this.groupDms.add(raw.channel)
      this.w.handle(ev)
    } catch (err) {
      this.d.log(`daemon: slack connector: handling a message failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
    }
  }

  /** Which connected apps are in these channels, read where not known. Bounded: a slow Slack must not hold a message back for long (it is then decided on what is known). */
  private async knowMembers(channels: string[], tagged: string[] = []): Promise<void> {
    const wanted = [...new Set(channels)].filter(c => !isDm(c) && !this.apps.settled(c, this.id, tagged))
    if (!wanted.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>(resolve => { timer = setTimeout(resolve, this.d.membershipWaitMs ?? MEMBERSHIP_WAIT_MS) })
    try { await Promise.race([Promise.all(wanted.map(c => this.apps.ensure(c, this.id, tagged))), late]) } finally { clearTimeout(timer) }
  }

  /** The live stream may have missed something now. The one place a gap is recorded, whatever its source. */
  private noteGap(): void {
    this.lastGapAt = this.now()
  }

  /**
   * The daemon ran again after a sleep (or a minute or more held). The socket is likely dead though nothing has said so
   * yet, and Slack replays nothing: record the gap, ask the supervisor to replace the socket (it waits for the network),
   * and catch up. The new socket's `connected` runs that pass; if none came up, it runs anyway, and retries until one
   * completes. A reconnect already in flight is not replaced: its own `connected` may then run a second pass
   * (`reconnected`) after this one, which is harmless: a pass reads only what the cursors have not.
   */
  onResume(): void {
    if (!this.started || !this.sup) return
    this.noteGap()
    this.resumePassOwed = true
    void this.sup.reconnect().finally(() => { if (this.takeResumePass()) void this.runCatchUp(true, 'resumed') })
  }

  private takeResumePass(): boolean {
    const owed = this.resumePassOwed
    this.resumePassOwed = false
    return owed
  }

  /**
   * Whether the live stream has held since `t`: the socket is up now (the supervisor's view, so an unhooked emitter
   * never counts as up and the alert stays off), and no gap fell after `t`. A gap at `t` itself is covered: a pass
   * that starts at a reconnect reads what the gap missed.
   */
  private streamHeldSince(t: number | null): boolean {
    return t !== null && this.sup?.state.connected === true && this.lastGapAt <= t
  }

  /** One catch-up pass at a time; a request that arrives during one runs once more when it ends. */
  async runCatchUp(deep: boolean, why: string): Promise<CatchUpResult | null> {
    if (!this.view() || !this.app) return null
    if (this.catching) { this.rerun = (this.rerun ?? false) || deep; return null }
    this.catching = true
    const startedAt = this.now()
    let result: CatchUpResult | null = null
    try {
      // Names first: a channel renamed or joined since the last pass is scanned under its current name.
      await this.refreshDirectory(this.app)
      // Which apps are in each channel this pass will read, known before it hands a message to routing.
      await this.knowMembers([...routedChannels(this.view()), ...this.w.list().map(e => e.channel)])
      result = await catchUp(this.w, this.catchUpApi(), this.view()!, { deep, now: this.now, log: this.d.log })
      this.lastCatchUp = { at: this.now(), result }
      // What this pass found was posted after the last complete pass started. Only a complete pass moves that mark:
      // an incomplete one may have left a channel unread.
      const windowStart = this.lastOkCatchUpStartedAt
      if (result.complete) { this.lastOkCatchUpAt = this.now(); this.lastOkCatchUpStartedAt = startedAt; this.alerted.catchUp = false; this.alerted.permanent = null }
      else this.alertIfPermanent(result.reason)
      // `result.accepted` counts everything the pass took, including an old message a read brings back with its thread;
      // only what was posted from the window's start on can have been missed live. Slack's clock and ours differ a little, so the
      // window opens BIND_SKEW_S early, as a thread is reread from that long before its bind.
      const missed = windowStart === null ? 0 : result.acceptedTs.filter(ts => Number(ts) * 1000 >= windowStart - BIND_SKEW_S * 1000).length
      this.d.log(`daemon: slack connector: catch-up (${why}${deep ? ', deep' : ''}): ${result.complete ? 'done' : 'incomplete'}, ${result.calls} call(s), ${result.accepted} message(s) the live stream had not delivered${windowStart === null ? '' : ` (${missed} posted since the last complete pass began)`}\n`)
      // A quiet pass should find nothing. Finding messages while the stream held from the last complete pass's start to
      // this pass's end means it is losing events. Judged now, at the end, so a gap that lands while this pass runs counts.
      if (why === 'periodic' && windowStart !== null && this.streamHeldSince(windowStart) && missed > 0) this.missedLive(windowStart, missed)
    } catch (err) {
      this.d.log(`daemon: slack connector: catch-up crashed: ${err instanceof Error ? err.stack ?? err.message : err}\n`)
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

  /**
   * A pass found `accepted` messages the socket never delivered, though it held since `windowStart`. With live events in that
   * window the stream is split: another process holds a connection on this app, and Slack shares the events between them.
   * With none since, the stream is off: Slack switches an app's events off after too many failed deliveries (every stretch
   * with the socket down fails some), and says so only by email. Said once, after EVENTS_OFF_AFTER_PASSES such passes.
   */
  private missedLive(windowStart: number, accepted: number): void {
    if (this.lastLiveAt >= windowStart) {
      if (this.now() - this.lastMissedLiveAlertAt <= MISSED_LIVE_ALERT_EVERY_MS) return
      this.lastMissedLiveAlertAt = this.now()
      this.d.alert(`⚠️ The Slack catch-up pass${this.appSuffix()} found ${accepted} message(s) the live stream never delivered, though the connection stayed up since the previous complete pass began. Another process is probably connected to this Slack app (another Bolt server, for instance): stop it, since Slack splits events across connections. Nothing is lost, but it arrives up to ${CATCH_UP_INTERVAL_MS / 60_000} minutes late.`)
      return
    }
    if (++this.silentPasses < EVENTS_OFF_AFTER_PASSES || this.alerted.eventsOff) return
    this.alerted.eventsOff = true
    this.d.alert(`⚠️ Slack has probably switched off live events for ${appName(this.declaredApps(), this.id)}: ${this.silentPasses} catch-up passes found messages the socket never delivered while it stayed connected, and nothing has arrived live since before the first. Slack does this after too many failed deliveries. Fix: in the app's settings at api.slack.com/apps, open Event Subscriptions and turn **Enable Events** back on (Socket Mode needs no Request URL). Until then nothing is lost, but every message arrives through catch-up, up to ${CATCH_UP_INTERVAL_MS / 60_000} minutes late. If it is already on, another process is probably connected to this app and taking its events.`)
  }

  /**
   * The socket delivered an event: live events are on. After passes that found it silent, the stream has just come back, so
   * what it missed until now is a gap's, for the next pass to fill, not a sign of a split. Ends an episode of them off, and says so.
   */
  private heardLive(): void {
    this.lastLiveAt = this.now()
    if (this.silentPasses > 0) this.noteGap()
    this.silentPasses = 0
    if (!this.alerted.eventsOff) return
    this.alerted.eventsOff = false
    this.d.alert(`✅ Live events are arriving again for ${appName(this.declaredApps(), this.id)}.`)
  }

  /**
   * What this app's token lacks of what hydra.toml declared, said once per episode, in this app's name alone. An episode runs from
   * the first time a set of scopes is missing until the token is complete again: a restart or a reconnect inside it says nothing.
   */
  private alertMissingScopes(missing: ScopeNeed[]): void {
    const key = missing.length ? missing.map(n => n.option).sort().join('|') : null
    if (key === (this.told.get(this.id) ?? null)) return
    this.told.set(this.id, key)
    if (!missing.length) return
    this.d.alert(`⚠️ The Slack bot token${this.appSuffix()} lacks ${missing.map(n => `${n.any.join(' or ')} (${n.option})`).join('; ')}. Add ${missing.length === 1 ? 'it' : 'them'} to the app (\`${this.manifestCommand()}\` prints the full list), reinstall it, put the new bot token in the variable the ${appKey(this.declaredApps(), this.id, 'bot_token_env')} names (in \`.env\`), and restart the daemon.`)
  }

  /** A refusal that retrying cannot fix is said once, at once, in the specialist's thread, with what to do. */
  private alertIfPermanent(reason: string | undefined): void {
    const hit = reason ? permanentSlackErrors(this.declaredApps(), this.id).find(([re]) => re.test(reason)) : undefined
    if (!hit || this.alerted.permanent === hit[1]) return
    this.alerted.permanent = hit[1]
    this.d.alert(`⚠️ Slack refused the catch-up read${this.appSuffix()}: ${reason}. Retrying will not fix it: ${hit[1]}`)
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
      // Awake time: a socket that closed before the lid did has not been down while the machine slept.
      downMin: state === 'up' || state === 'off' || downSince === null ? null : min(this.resumes.awakeSince(downSince, now)),
      lastActivityAgeMin: s ? min(now - s.lastActivityAt) : null,
      catchUp: this.lastCatchUp ? { ageMin: min(now - this.lastCatchUp.at), ok: this.lastCatchUp.result.complete, accepted: this.lastCatchUp.result.accepted, ...(this.lastCatchUp.result.reason && { reason: this.lastCatchUp.result.reason }) } : null,
      lastOkCatchUpAgeMin: this.lastOkCatchUpAt === null ? null : min(now - this.lastOkCatchUpAt),
      eventsOff: this.alerted.eventsOff,
      missingScopes: this.missingScopes,
    }
  }

  /** Tell the specialist's thread when the listener has been down or catch-up has stalled, and when the listener is back. Once per episode. */
  async checkAlerts(): Promise<void> {
    if (!this.started) return
    const h = this.health()
    const now = this.now()
    if (h.state !== 'up' && h.downMin !== null && h.downMin * 60_000 >= DOWN_ALERT_AFTER_MS && !this.alerted.down) {
      this.alerted.down = true
      this.d.alert(`⚠️ The Slack connector${this.appSuffix()} has been ${h.state} for ${h.downMin} min awake. Mentions are not arriving live; the catch-up pass replays them once it reconnects. Check the tokens and the app's Socket Mode setting at api.slack.com/apps; \`hydra health\` shows its state.`)
    } else if (h.state === 'up' && this.alerted.down) {
      this.alerted.down = false
      this.d.alert(`✅ The Slack connector${this.appSuffix()} is connected again.`)
    }
    // Overdue by awake time: no pass can complete while the machine sleeps, so a sleep is named, not counted.
    const since = this.lastOkCatchUpAt ?? this.startedAt
    const overdue = this.resumes.awakeSince(since, now)
    if (overdue >= CATCH_UP_STALE_AFTER_MS && !this.alerted.catchUp) {
      this.alerted.catchUp = true
      const away = this.resumes.suspendedSince(since, now)
      const notes = [...(away ? [`${describeCause(away.cause)} for ${Math.round(away.ms / 60_000)} min`] : []), ...(h.catchUp?.reason ? [h.catchUp.reason] : [])]
      this.d.alert(`⚠️ The Slack catch-up pass${this.appSuffix()} has not completed for ${Math.round(overdue / 60_000)} min${away ? ' awake' : ''}${notes.length ? ` (${notes.join('; ')})` : ''}. Live delivery is unaffected, but a gap would not be filled. \`hydra health\` shows the last pass and why it failed.`)
    }
  }
}

// ---------------------------------------------------------------------------
// The real Slack app. Thin on purpose: everything above is tested against a fake.
// ---------------------------------------------------------------------------

export function boltApp(tokens: { app: string; bot: string; user?: string }): SlackAppLike {
  const { app } = buildSocketApp({ appToken: tokens.app, botToken: tokens.bot })
  let handler: (event: RawEvent) => void = () => {}
  app.message(async ({ message }) => { handler(message as RawEvent) })
  // Bolt 4.7.3 registers its `ignoreSelf` in the App constructor, so it runs before any `app.use` we could add (and drops an event whose
  // `user` is the bot). The receiver is ahead of it: the Socket Mode client says every event it gets, so it is listened to there.
  let wire: (event: RawEvent, via: WireVia) => void = () => {}
  const socket = (app as unknown as { receiver?: { client?: { on(event: string, fn: (args: { body?: { type?: string; event?: RawEvent; authorizations?: { is_bot?: boolean }[] } }) => void): unknown } } }).receiver?.client
  socket?.on('slack_event', ({ body }) => {
    const event = body?.event
    if (body?.type !== 'event_callback' || event?.type !== 'message') return
    const bot = body.authorizations?.[0]?.is_bot
    wire(event, bot === undefined ? 'unknown' : bot ? 'bot' : 'user')
  })
  // Posting never retries behind the caller's back, and gives up at a hard deadline: a retry landing after the caller
  // was told "unknown" would post twice. Reading keeps the SDK's patient retries.
  const poster = new WebClient(tokens.bot, { retryConfig: { retries: 0 }, timeout: POST_TIMEOUT_MS, logLevel: LogLevel.ERROR })
  // The operator writes (edit, delete) only through this one: reading with the user token stays in `readReplies`, and nothing posts with it.
  const operator = tokens.user ? new WebClient(tokens.user, { retryConfig: { retries: 0 }, timeout: POST_TIMEOUT_MS, logLevel: LogLevel.ERROR }) : undefined
  const writer = (as: Writer): WebClient => { const w = as === 'operator' ? operator : poster; if (!w) throw new Error('this app has no operator token (operator_token_env)'); return w }
  let operatorId: Promise<string | undefined> | undefined
  let renamed: (id: string, name: string) => void = () => {}
  let reacted: (r: SlackReactionEvent) => void = () => {}
  app.event('reaction_added', async ({ event }) => {
    const e = event as { user?: string; reaction?: string; item_user?: string; event_ts?: string; item?: { type?: string; channel?: string; ts?: string } }
    if (e.item?.type === 'message' && e.item.channel && e.item.ts && e.user && e.reaction && e.event_ts) reacted({ channel: e.item.channel, itemTs: e.item.ts, ...(e.item_user && { itemUser: e.item_user }), reaction: e.reaction, user: e.user, eventTs: e.event_ts })
  })
  let membership: (channel: string) => void = () => {}
  for (const name of SLACK_APP_NEEDS.membership.botEvents) app.event(name, async ({ event }) => { const c = (event as { channel?: string }).channel; if (c) membership(c) })
  for (const name of SLACK_APP_NEEDS.botEvents.renames) app.event(name, async ({ event }) => { const c = (event as { channel?: { id?: string; name?: string } }).channel; if (c?.id && c.name) renamed(c.id, c.name) })
  const client = app.client
  const page = (r: { messages?: unknown[]; response_metadata?: { next_cursor?: string } }) => ({
    messages: (r.messages ?? []) as RawMessage[],
    ...(r.response_metadata?.next_cursor && { next: r.response_metadata.next_cursor }),
  })
  return {
    onMessage: h => { handler = h },
    onWire: h => { wire = h },
    onReaction: h => { reacted = h },
    onRename: h => { renamed = h },
    onMembership: h => { membership = h },
    // conversations.info says `is_member` for a channel the bot can see; a private channel it is not in is `channel_not_found`: not a member.
    isMember: async channel => {
      try {
        const r = await client.conversations.info({ token: tokens.bot, channel })
        return !!(r.channel as { is_member?: boolean } | undefined)?.is_member
      } catch (e) {
        const x = explainSlackError(e)
        if (/channel_not_found/.test(x.message)) return false
        throw x
      }
    },
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
      return { ...parseAuth(r), ...(scopes && { scopes }) }
    },
    edit: async (channel, ts, text, as) => { await writer(as).chat.update({ channel, ts, text }).catch(e => { throw explainSlackError(e) }) },
    remove: async (channel, ts, as) => { await writer(as).chat.delete({ channel, ts }).catch(e => { throw explainSlackError(e) }) },
    operatorUserId: () => {
      if (!operator) return Promise.resolve(undefined)
      // Kept once known; a failed read is asked again next time.
      return operatorId ??= operator.auth.test().then(r => r.user_id, e => { operatorId = undefined; throw explainSlackError(e) })
    },
    react: async (channel, ts, name) => { await client.reactions.add({ token: tokens.bot, channel, timestamp: ts, name }) },
    post: async (channel, threadTs, text, opts) => {
      const r = await poster.chat.postMessage(postPayload(channel, threadTs, text, opts) as any).catch(e => { throw explainSlackError(e) })
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
      ...(tokens.user && { otherParties: async () => {
        const out: { channel: string; user?: string }[] = []
        let cursor: string | undefined
        for (let i = 0; i < 25; i++) {
          const r = await client.users.conversations({ token: tokens.user, types: 'im', limit: 200, ...(cursor && { cursor }) }).catch(e => { throw explainSlackError(e) })
          for (const c of (r.channels ?? []) as { id?: string; user?: string }[]) if (c.id) out.push({ channel: c.id, ...(c.user && { user: c.user }) })
          cursor = r.response_metadata?.next_cursor || undefined
          if (!cursor) break
        }
        return out
      } }),
      replies: a => readReplies(token => client.conversations.replies({ token, channel: a.channel, ts: a.ts, oldest: a.oldest, inclusive: a.inclusive, limit: a.limit ?? 200, ...(a.cursor && { cursor: a.cursor }) })
        .then(page, e => { throw explainSlackError(e) }), a.botOnly ? { bot: tokens.bot } : tokens),
    },
  }
}
