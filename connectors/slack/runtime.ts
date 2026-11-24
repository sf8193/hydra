import { ConversationTable, namedChannels, cantRead, NOT_A_MEMBER, cmpTs, slackWatchesPath, unresolvedPlaces, conversationId, placeName, isDm, appOfEntry, TOP_LEVEL, NO_DIRECTORY, SLACK_LIMITS, heldBySession, type BoundBy, type ConversationConfig, type ConversationEntry, type ConversationStats, type LateOwed, type RouteTarget } from './watch.js'
import { archiveUrl, parseConversation, THREAD_TS } from '../../shared/slack-conversation.js'
import { ConnectedApps, type AppIdentity } from './apps.js'
import { getSpecialist, conversationSpecialistOf, specialistOf, boundAs } from '../../sessions/specialists.js'
import { registry } from '../../sessions/registry.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { occupied } from '../../sessions/occupancy.js'
import type { SessionInfo } from '../../sessions/registry.js'
import type { DeliverOutcome, Target } from '../../app/targets.js'
import type * as targets from '../../app/targets.js'

/** What the Slack runtime calls back into app/targets.ts, which sits above it. daemon.ts binds it once at boot. */
type Delivery = Pick<typeof targets, 'deliverToTarget' | 'conversationSessionName' | 'conversationSessionRunning' | 'placesFree'>
let delivery!: Delivery
export function bindSlackDelivery(d: Delivery): void { delivery = d }
import { on } from '../../infra/event-bus.js'
import { SlackListener, boltApp, POST_TIMEOUT_MS, OWED_LATE_AFTER_MS, type ToldScopes, type MessageAuthor, type Writer, type ReadMessage } from './listener.js'
import { SlackConnections, slackTokens, type AppHealth } from './connections.js'
import { STATE_DIR } from '../../infra/config.js'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { safeSend, atomicWriteFileSync } from '../../infra/util.js'
import { HYDRA_ACTOR, BIND_WHY_MAX } from '../../shared/events.js'
import { mainChannel } from '../../sessions/main.js'
import { gateway } from '../../infra/config.js'
import { currentHydraConfig, onHydraConfigLoad } from '../../infra/hydra-config.js'
import { isRestricted } from '../../shared/policy-record.js'
import { isRestrictedSession, isWriteConfinedSession } from '../../sessions/tool-surface.js'
import { MAIN, currentId, isSessionThread, slackSpecialistsOf } from '../../routing/route.js'
import { chunk } from '../../infra/util.js'
import { resolveLineEmoji, postedLine } from './lines.js'
import { routeThreadId } from '../../sessions/thread-route.js'
import { DEFAULT_SLACK_APP, coversAny, homePlaceOf, isChannelName, isRouter, routerOf, placeKey, placeOf, placesAnsweredBy, samePlace, slackConfigured, type Place, type HydraConfig, type SlackApp } from '../../config/types.js'
import { speaksAsOf, noSuchApp } from '../../config/pins.js'
import { notServedBy } from '../../routing/route.js'
import { NO_SLACK_APP, SLACK_APP_NEEDS, appKey, appName, notConnected } from './app.js'
import { timed } from '../../shared/loop-watch.js'
import { registerSlackChannelNames } from '../../shared/link-previews.js'
import { bareOf, readTarget } from '../../shared/target-kind.js'
import { placeInInbox } from '../../infra/confined-inbox.js'
import { oneLine } from '../../shared/untrusted-text.js'
import { checkUploads, uploadLine, type Upload, type UploadResult } from './files.js'

const log = (line: string) => { process.stderr.write(line) }


/**
 * Test seams: one app's view of hydra.toml (that app's listener's, once it has connected), and posting to Slack through
 * one app. An absent `app` is `default`.
 */
export const slackRuntimeDeps = {
  view: (app: string = DEFAULT_SLACK_APP): ConversationConfig | null => connections.listener(app)?.view() ?? null,
  /** A place freed under max: catch-up refetches what waits, the oldest waiter first, through the apps that have waiters. */
  wake: (apps?: string[], why = 'a place freed'): void => { for (const [id, l] of connections.listeners()) if (!apps || apps.includes(id)) void l.runCatchUp(false, why) },
  post: (channel: string, threadTs: string | undefined, text: string, app: string = DEFAULT_SLACK_APP): Promise<string> => {
    const l = connections.listener(app)
    if (!l) return Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
    return l.post(channel, threadTs, text)
  },
  /** A reply's checked files, shared into a conversation after its text, through one app. */
  upload: (channel: string, threadTs: string | undefined, files: readonly Upload[], app: string = DEFAULT_SLACK_APP): Promise<UploadResult> => {
    const l = connections.listener(app)
    return l ? l.upload(channel, threadTs, files) : Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
  },
  /** Whose a message is, to one app: its own bot's, the operator's, or someone else's. Read from Slack. */
  author: (channel: string, ts: string, threadTs: string | undefined, app: string = DEFAULT_SLACK_APP): Promise<MessageAuthor> => {
    const l = connections.listener(app)
    if (!l) return Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
    return l.author(channel, ts, threadTs)
  },
  /** Rewrites a message through one app: with its bot's token, or the operator's. */
  edit: (channel: string, ts: string, text: string, app: string = DEFAULT_SLACK_APP, as: Writer = 'app'): Promise<void> => {
    const l = connections.listener(app)
    if (!l) return Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
    return l.edit(channel, ts, text, as)
  },
  /** A conversation's newest messages, oldest first, read through one app; with `asOperator`, a thread its bot is not in with the operator's token. */
  read: (channel: string, threadTs: string | undefined, limit: number, app: string = DEFAULT_SLACK_APP, asOperator = false): Promise<ReadMessage[]> => {
    const l = connections.listener(app)
    if (!l) return Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
    return l.read(channel, threadTs, limit, asOperator)
  },
  /** Deletes a message through one app: with its bot's token, or the operator's. */
  remove: (channel: string, ts: string, app: string = DEFAULT_SLACK_APP, as: Writer = 'app'): Promise<void> => {
    const l = connections.listener(app)
    if (!l) return Promise.reject(new Error(notConnected(hydraConfig().slackApps, app)))
    return l.remove(channel, ts, as)
  },
  /**
   * Who can read a thread now, through one app: its bot, the operator's user token, or (null) nobody can be asked because
   * that app isn't connected. Throws Slack's refusal when neither token can read it.
   */
  readThread: async (channel: string, threadTs: string, app: string = DEFAULT_SLACK_APP): Promise<'bot' | 'user' | null> => {
    const api = connections.listener(app)?.api
    if (!api) return null
    // A tool call must not wait out the SDK's retries: past the deadline the bind is made unchecked, as when disconnected.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), READ_THREAD_TIMEOUT_MS) })
    try {
      const r = await Promise.race([api.replies({ channel, ts: threadTs, oldest: threadTs, inclusive: true, limit: 1 }), late])
      return r ? r.via ?? 'bot' : null
    } finally { clearTimeout(timer) }
  },
}
const hydraConfig = () => currentHydraConfig()
/** How long bind_conversation waits for Slack to say who can read a thread. */
const READ_THREAD_TIMEOUT_MS = 10_000

/** What the watcher routes with for one app: hydra.toml plus what that app's connection learned. Null until it has connected. */
function config(app?: string): ConversationConfig | null {
  return slackRuntimeDeps.view(app)
}

/** Without a connection, the tools still name channels by id; `#name` places resolve once the app is up. */
function offlineView(app?: string): Pick<ConversationConfig, 'hydra' | 'directory' | 'app'> {
  return config(app) ?? { hydra: hydraConfig(), directory: NO_DIRECTORY, ...(app && { app }) }
}

const SWEEP_INTERVAL_MS = 60 * 60_000

/**
 * A plain message (not a session turn) to the thread of the specialist it concerns. With none named, it goes to the specialists
 * the app it concerns serves and that hear Slack (`slackSpecialistsOf`); for an app hydra.toml no longer declares, or one no
 * specialist uses, to main's channel; for trouble that concerns no app (no `app`), to every specialist that hears Slack. Main's
 * channel also hears it when none of those has a thread to post in yet.
 */
function alert(text: string, to?: string, app?: string): void {
  const h = hydraConfig()
  const audience = app === undefined ? slackSpecialistsOf(h) : Object.hasOwn(h.slackApps, app) ? slackSpecialistsOf(h, app) : []
  const targets = to && alertChannel(to) ? [to] : audience
  const post = (ts: string[]): boolean => {
    let sent = false
    for (const t of ts) {
      const where = alertChannel(t)
      if (where) { void safeSend(where, text); sent = true }
    }
    return sent
  }
  // A notice addressed to a session thread tells that session something about its own bindings: the post is the record, the input is the telling.
  if (to && isSessionThread(to)) tellSession(to, text)
  if (post(targets) || post([MAIN])) return
  log(`daemon: slack connector alert, logged only: there is no Slack thread to post it in (a specialist has one once it has started; main has one once its channel is set), so nothing in Slack shows it. Start the specialist or main, and alerts are posted from then on: ${text}\n`)
}

/**
 * Gives a live session the notice as input, as every `[system]` notice reaches one (`deliverToTarget` lands it by the session's adapter, queued
 * while its bridge reconnects). A session that is gone (a kill, a deleted thread) refuses it and is not revived: its thread has the post.
 * Specialist and main alerts are not told this way: they are the operator's, about the connector, not about a binding the session holds.
 */
function tellSession(threadId: string, text: string): void {
  void delivery.deliverToTarget({ to: `thread:${threadId}` }, `[system] ${text}`, { initiator: 'slack-watch', source: 'slack-watch', queue: true })
    .then(r => { if (!r.ok) log(`daemon: slack connector: the session in thread ${threadId} was not told (${r.reason}); its thread has the notice\n`) })
    .catch(err => log(`daemon: slack connector: telling the session in thread ${threadId} failed: ${err}\n`))
}

/** Where a binding's alerts are posted: main's channel for `main`, a session's own thread, else the specialist's thread. */
function alertChannel(to: string): string | undefined {
  return to === MAIN ? mainChannel() || undefined : isSessionThread(to) ? to : getSpecialist(to)?.threadId
}

let watcher: ConversationTable | undefined
let sweepTimer: ReturnType<typeof setInterval> | undefined

/** A downloaded file's path for a recipient: a copy in its own inbox when it is write-confined (it cannot read the state folder the download is in), else undefined (the download's path stands). */
export const placeFileFor = (specialist: { canOnlyWriteTo?: unknown; workdir: string } | undefined, src: string, name: string): string | undefined =>
  specialist?.canOnlyWriteTo ? placeInInbox(specialist.workdir, src, name) : undefined

/**
 * The daemon's one watcher, wired to the state dir and to specialist delivery.
 * Built on first use, not at import. A "duplicate" answer from the specialist means
 * the daemon already delivered this key: that counts as delivered.
 */
export function getConversationTable(): ConversationTable {
  return watcher ??= new ConversationTable({
    now: Date.now,
    file: slackWatchesPath(),
    filesDir: join(STATE_DIR, 'slack-files'),
    // A write-confined specialist cannot read the state folder: its files are copied into its own inbox (<workdir>/.inbox). Any other specialist reads the download where it is.
    placeFile: (to, src, name) => placeFileFor(hydraConfig().specialists[to], src, name),
    log,
    config: app => config(app),
    apps: () => hydraConfig().slackApps,
    alert,
    hosted: threadId => !!registry.getByThread(threadId),
    line: (threadId, make) => showLine(threadId, make),
    speaksIn: threadId => { const id = registry.getByThread(threadId); return isPlainSession(id, id ? registry.get(id) : undefined) },
    deliver: deliverForSlack,
  })
}

/**
 * The Slack connector's delivery: the conversation's target, after the connector's own turn order for per-conversation places.
 * The outcome is targets.ts's, unchanged.
 */
export async function deliverForSlack(target: RouteTarget, message: string, idempotencyKey: string): Promise<DeliverOutcome> {
  const t = targetFor(target.to, target.conversation)
  // First come, first served, when places are short: a newer conversation without a session takes a place only if
  // one is left over after every older waiter has had theirs.
  if ('perConversation' in t && !delivery.conversationSessionRunning(t.perConversation, t.conversation)) {
    const h = hydraConfig()
    const waiters = getConversationTable().waiters(id => currentId(h, id) === t.perConversation)
    const ahead = waiters.findIndex(e => conversationId(e) === t.conversation)
    const before = ahead === -1 ? waiters.length : ahead
    if (before > 0 && delivery.placesFree(t.perConversation) <= before) return { ok: false, exit: 5, reason: `${t.perConversation} is at max with ${before} conversation${before === 1 ? '' : 's'} waiting ahead of ${t.conversation}`, wait: true }
  }
  return delivery.deliverToTarget(t, message, { initiator: 'slack-watch', idempotencyKey, source: 'slack-watch' })
}

/**
 * A line in a session's own thread about its Slack traffic (lines.ts): subtext, no link preview, never into Slack. The emoji is picked here, where the
 * gateway is known; a line that cannot be posted is logged and dropped, since it is a notice and never the delivery or the reply it describes.
 */
export function showLine(threadId: string, make: (emoji: string) => string): void {
  if (!gateway.isThreadId(threadId)) return
  const line = make(resolveLineEmoji(hydraConfig().slackLineEmoji, gateway))
  void safeSend(threadId, line, { subtext: true, unfurl: false })
}

/** A per-conversation specialist gives the conversation its own session (targets.ts counts `max_sessions`); any other is one target. */
export function targetFor(to: string, conversation: string | undefined): Target {
  const s = hydraConfig().specialists[to]
  return s?.sessions === 'per-conversation' && conversation ? { perConversation: to, conversation } : { to }
}

/** Where each app's bot ids are kept, so a restart still recognises a tag of an app that has not joined yet. Absent: nothing is known. */
const identitiesPath = () => join(STATE_DIR, 'slack-apps.json')
function savedIdentities(): Record<string, AppIdentity> {
  try { return existsSync(identitiesPath()) ? JSON.parse(readFileSync(identitiesPath(), 'utf8')) as Record<string, AppIdentity> : {} } catch { return {} }
}
const newSharedApps = () => {
  const apps = new ConnectedApps({
    apps: () => hydraConfig().slackApps,
    alert: (text, app) => alert(text, undefined, app), log,
    persist: ids => { try { atomicWriteFileSync(identitiesPath(), JSON.stringify(ids, null, 2) + '\n') } catch (err) { log(`daemon: slack connector: saving bot ids failed: ${err}\n`) } },
  })
  apps.seedIdentities(savedIdentities())
  return apps
}

/** Where the scopes already said to be missing are kept, per app, so a restart does not say them again (an episode lasts until the token is complete). */
const toldPath = () => join(STATE_DIR, 'slack-scopes-told.json')
const scopesTold: ToldScopes = {
  get: app => { try { return existsSync(toldPath()) ? (JSON.parse(readFileSync(toldPath(), 'utf8')) as Record<string, string>)[app] : undefined } catch { return undefined } },
  set: (app, key) => {
    try {
      const all: Record<string, string> = existsSync(toldPath()) ? JSON.parse(readFileSync(toldPath(), 'utf8')) : {}
      if (key === null) delete all[app]; else all[app] = key
      atomicWriteFileSync(toldPath(), JSON.stringify(all, null, 2) + '\n')
    } catch (err) { log(`daemon: slack connector: saving what was said failed: ${err}\n`) }
  },
}

/** The daemon's Slack connections: one listener per declared app, what they share, and each app's record. */
const connections = new SlackConnections({
  hydra: hydraConfig,
  tokens: app => slackTokens(app),
  newShared: newSharedApps,
  makeListener: (app, shared) => new SlackListener({
    app: app.id,
    apps: shared,
    watcher: getConversationTable(),
    hydra: hydraConfig,
    told: scopesTold,
    tokens: slackTokens,
    createApp: boltApp,
    log,
    alert: text => alert(text, undefined, app.id),
  }),
  alert: (text, app) => alert(text, undefined, app),
  log,
  onConfigLoad: fn => { onHydraConfigLoad(fn) },
  oldWatchFileLeft: () => existsSync(join(STATE_DIR, 'slack-watch.json')),
})
// A place named `slack:#name` is found by the names the connected apps have read (shared/link-previews.ts).
registerSlackChannelNames(channel => { for (const [, l] of connections.listeners()) { const n = l.view()?.directory.nameOf(channel); if (n) return n } return undefined })

/**
 * Connects to Slack, one connection per app hydra.toml declares, and begins feeding the watcher. Called once boot recovery
 * has finished, so a specialist refill never races it. The tokens come from the scrubbed environment: only this module ever
 * sees them, never a session. An app with no tokens is skipped, and said so by name; the others connect. It runs again on every
 * hydra.toml load: an app added there connects, one taken out disconnects, with no restart.
 */
export function startSlackListener(): Promise<void> { return connections.start() }

export function stopSlackListener(): void { connections.stop() }

let unsubscribe: (() => void) | undefined

/**
 * Starts the watch's own clock: the idle sweep. Called at boot next to `startPrWatcher()`,
 * which owns the same kind of timer for PR watches.
 */
export function startConversationTable(): void {
  if (sweepTimer) return
  const w = getConversationTable()
  reconcileVacancy()
  w.sweep(false)   // not yet releasing vacant threads: recovery is about to revive sessions, whose registering stops the clock
  void unbindDeletedThreads()
  sweepTimer = setInterval(() => timed('slack-watch-sweep', () => { reconcileVacancy(); w.sweep(); void unbindDeletedThreads() }), SWEEP_INTERVAL_MS)
  ;(sweepTimer as { unref?: () => void }).unref?.()
  // A conversation session ending frees a place: the waiters are offered it at once (catch-up refetches them, oldest first).
  const freed = ({ tmuxName }: { tmuxName: string }) => {
    const to = conversationSpecialistOf(tmuxName)
    const h = hydraConfig()
    const waiting = to ? getConversationTable().waiters(id => currentId(h, id) === to) : []
    if (waiting.length) slackRuntimeDeps.wake([...new Set(waiting.map(appOfEntry))])
  }
  // A session thread keeps its bound conversations while no session is in it (a kill, a handoff, a respawn): what arrives stays
  // owed, and is delivered when a session's bridge registers there. They end on unbind, when the thread is deleted, when Slack
  // can no longer read the conversation, when idle a week, or when no session has been in the thread for VACANT_RELEASE_MS (a day).
  const offRegistered = on('session:bridge-registered', ({ threadId }) => { getConversationTable().occupy(threadId); deliverOwedIn(threadId) }, 'slack connector: a session is in the thread again: stop its vacancy clock, and deliver what it is owed')
  // A deleted thread is found by asking the platform (the gateway's `threadExists`): when its session ends, at start, and at each sweep.
  // What the operator ends ends: a killed session takes its thread's subscriptions with it, said once in the thread. A crash, a handoff or a respawn does not.
  const offDeleted = on('session:death', ({ threadId, deliberate, sessionId }) => { if (deliberate) unbindOnKill(threadId); else { void unbindIfThreadDeleted(threadId); reconcileVacancy(threadId, sessionId) } }, 'slack connector: unbind a killed session thread\'s conversations, or those of a deleted one')
  const offDestroyed = on('thread:destroyed', ({ threadId }) => { void unbindIfThreadDeleted(threadId) }, 'slack connector: unbind the conversations of a thread destroyed with no session in it')
  const offDeath = on('session:death', freed, 'slack connector: wake conversations waiting at max')
  const offDead = on('session:marked-dead', freed, 'slack connector: wake conversations waiting at max (found dead)')
  // After a sleep the socket is likely dead and Slack replays nothing: replace it and catch up now, not when a timer notices.
  const offResumed = on('clock:resumed', () => { for (const l of connections.listeners().values()) l.onResume() }, 'slack connector: replace the socket and catch up after a resume')
  unsubscribe = () => { offRegistered(); offDeleted(); offDestroyed(); offDeath(); offDead(); offResumed() }
}

/** A session registered in this thread: the conversations bound to it that owe messages are refetched and delivered now, not at the next periodic catch-up. */
function deliverOwedIn(threadId: string): void {
  const owing = getConversationTable().list().filter(e => e.specialist === threadId && e.owed?.length)
  if (owing.length) slackRuntimeDeps.wake([...new Set(owing.map(appOfEntry))], 'a session registered in the thread')
}

/** The session was killed: its thread's conversations are unbound at once (what they owed is dropped and counted), and the thread is told once how to resume. */
function unbindOnKill(threadId: string | undefined): void {
  if (!threadId || !isSessionThread(threadId)) return
  const bound = getConversationTable().list().filter(e => e.specialist === threadId)
  if (!bound.length) return
  const owed = bound.reduce((n, e) => n + (e.owed?.length ?? 0), 0)
  for (const e of bound) getConversationTable().unwatch(e.channel, e.threadTs, e.app, true, { by: HYDRA_ACTOR, reason: 'killed' })
  alert(`ℹ️ This session was killed, so it stopped listening to ${bound.map(conversationId).join(', ')}${owed ? ` (${owed} owed dropped)` : ''}. Bind again with \`bind_conversation\` to resume.`, threadId)
}

/**
 * Starts or stops the vacancy clock of each session thread that conversations are bound to (of one, when given): vacant when no live session is in it.
 * `leaving`: a session that is dying, not counted as in the thread. The clock keeps its first start, so a restart neither resets nor doubles it.
 */
function reconcileVacancy(only?: string, leaving?: string): void {
  const w = getConversationTable()
  for (const t of only ? [only] : boundThreads()) {
    const home = [...registry.values()].some(s => s.threadId === t && s.sessionType !== 'thread_guest' && s.deadAt === undefined && s.sessionId !== leaving)
    if (home) w.occupy(t); else w.vacate(t)
  }
}

/** The session threads that conversations are bound to. */
const boundThreads = (): string[] => [...new Set(getConversationTable().list().map(e => e.specialist).filter((id): id is string => !!id && isSessionThread(id)))]

/** If the platform says the session thread is deleted, its conversations are unbound, each logged (what they owed is dropped and counted). Any other answer keeps them. */
async function unbindIfThreadDeleted(threadId: string | undefined): Promise<void> {
  if (!threadId || !isSessionThread(threadId) || !getConversationTable().list().some(e => e.specialist === threadId)) return
  if (await gateway.threadExists(threadId).catch(() => true)) return
  for (const e of getConversationTable().list().filter(e => e.specialist === threadId)) {
    log(`daemon: slack connector: unbound ${conversationId(e)}: its session thread ${threadId} was deleted\n`)
    getConversationTable().unwatch(e.channel, e.threadTs, e.app, false, { by: HYDRA_ACTOR, reason: 'thread-gone' })
  }
}

const unbindDeletedThreads = async (): Promise<void> => { for (const t of boundThreads()) await unbindIfThreadDeleted(t) }

/**
 * Shutdown: stop the clock and write the store. Nothing is delivered on the way out
 * (that could spawn a session mid-teardown): what is waiting was already persisted as
 * owed, and the catch-up pass delivers it after the restart.
 */
export function stopConversationTable(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined }
  unsubscribe?.()
  unsubscribe = undefined
  stopSlackListener()
  watcher?.close()
}

// -- conversations: what the bridge tools and the CLI do ---------------------------

export { parseConversation }

/** The app a conversation went through, checked against hydra.toml: its name, or why there is no such app. */
function declaredApp(h: HydraConfig, app: string): void {
  if (!Object.hasOwn(h.slackApps, app)) throw new Error(noSuchApp(app, Object.keys(h.slackApps)))
}

/** Whether this session is one conversation's own session, rather than a specialist's shared one. */
const isConversationSession = (caller: Partial<Pick<SessionInfo, 'tmuxName'>> | undefined): boolean => !!conversationSpecialistOf(caller?.tmuxName)

/** Whether `to` answers every message in this channel (`placesAnsweredBy`): a rule there with a `person` doesn't count, it takes chosen people's messages, not the place. */
function answersIn(v: Pick<ConversationConfig, 'hydra' | 'directory'>, to: string, channel: string): boolean {
  const s = v.hydra.specialists[to]
  const name = v.directory.nameOf(channel)
  const at = [placeOf('slack', 'channel', channel), ...(name ? [placeOf('slack', 'channel', `#${name}`)] : [])]
  return !!s && placesAnsweredBy(v.hydra, to).some(p => coversAny(p, at))
}

/** Conversations one specialist may hold by its own hand at once: the tool must not be a way to fill the table. */
export const TOOL_BIND_MAX = 10
/** Conversations a router may hand on at once, per app: a stranger who can reach the router must not be able to fill the table through it. */
export const ROUTER_BIND_MAX = 10

/**
 * `bind_conversation`: a session binds a Slack thread to itself (boundAs): a specialist's session to the specialist,
 * at a place it hears; any other session to its own thread, wherever the bot, or the operator, can read. It may bind
 * one that is unbound or already its own. Moving another's conversation is the operator's (`hydra conversations bind`).
 */
export async function bindConversation(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>> | undefined, conversation: unknown, to?: { target?: unknown; why?: unknown; callerSessionId?: string }): Promise<string> {
  if (to?.target !== undefined || to?.why !== undefined) return bindToSession(caller, conversation, to.target, to.why, to.callerSessionId === 'main')
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const v = offlineView(app)
  if (!slackConfigured(v.hydra)) throw new Error(`Slack is not connected: ${NO_SLACK_APP}`)
  declaredApp(v.hydra, app)
  const me = boundAs(caller, v.hydra)
  if (!me) throw new Error('this session has no thread to bind a conversation to')
  // A DM, or a place's top level, is routing's to hand out: a tool never takes one, least of all the operator's DM from main.
  if (isDm(c.channel) || c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} is not a thread in a channel: only a thread can be bound by hand`)
  if (getConversationTable().isHosted(c.channel, c.threadTs)) throw new Error(`${conversationId(c)} is a hydra session's own thread: its messages already reach that session`)
  // A specialist pinned to other apps can't be reached through this one: its answers would never be heard.
  const apart = notServedBy(v.hydra, me, app, 'this conversation is through')
  if (apart) throw new Error(`not bound: ${conversationId(c)}: ${apart}`)
  if (!isSessionThread(me) && !answersIn(v, me, c.channel)) throw new Error(`${me} doesn't answer ${placeName(v, c.channel)}: it binds only threads in a place it answers (a \`[[rules]]\` entry with that place and no person)`)
  // Asked of Slack, not assumed: a bind nobody can read would say "listening" and deliver nothing.
  const via = await slackRuntimeDeps.readThread(c.channel, c.threadTs, app).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`not bound: ${conversationId(c)}: ${cantRead(v.hydra.slackApps, app, placeName(v, c.channel), why, config(app)?.botUserId)}`)
  })
  // A specialist answers in its threads: one only the operator can read is one it could never post in.
  if (via === 'user' && !isSessionThread(me)) throw new Error(`not bound: ${conversationId(c)}: the bot isn't in ${placeName(v, c.channel)}, so ${me} could not answer there. Ask the operator to invite it, then bind again`)
  // From here to the bind nothing waits: the table checks and the bind can't interleave with another call.
  const w = getConversationTable()
  const bound = w.get(c.channel, c.threadTs, app)?.specialist
  // A specialist answers where it answers: a session only listening to the thread gives it way, and is told.
  const takeover = !!bound && isSessionThread(bound) && !isSessionThread(me)
  if (bound && currentId(v.hydra, bound) !== me && !takeover) throw new Error(`${conversationId(c)} is bound to ${bound}; only the operator moves it (hydra conversations bind)`)
  // Counted unless this conversation already counts for it: binding a thread routing opened makes it its own, and counted (`heldBySession`).
  const entry = w.get(c.channel, c.threadTs, app)
  const counted = !!entry && heldBySession(entry) && bound !== undefined && currentId(v.hydra, bound) === me
  if (!counted && w.list().filter(e => heldBySession(e) && e.specialist && currentId(v.hydra, e.specialist) === me).length >= TOOL_BIND_MAX) {
    throw new Error(`${me} already holds ${TOOL_BIND_MAX} conversations it opened itself; unbind one first`)
  }
  if (!w.bind(c.channel, c.threadTs, me, 'tool', app, { by: me })) throw new Error(`the conversation table is full (${SLACK_LIMITS.maxConversations}); unbind one first`)
  if (via) w.setVia(c.channel, c.threadTs, via, app)
  if (takeover) alert(`ℹ️ ${conversationId(c)} was bound to this session to listen; ${me} took it, since it answers there. This session no longer hears it.`, bound!)
  const place = placeName(v, c.channel)
  const how = via === 'bot' ? `live: the bot is in ${place}`
    : via === 'user' ? `live, read as the operator: the bot isn't in ${place}`
    : isSessionThread(me) ? "not checked: Slack isn't connected; if the thread can't be read, the next deep catch-up lets it go and says so here"
    : "not checked: Slack isn't connected"
  if (isSessionThread(me)) return `${conversationId(c)} is bound to this session (${how}): each new message in it is delivered here until it has been idle a week, saying whether ${appName(v.hydra.slackApps, app)} was tagged and by whom. Answer in it with reply (chat_id ${conversationId(c)}) when the operator or an approved person (declared in [people]) tags ${appName(v.hydra.slackApps, app)} and asks you something; otherwise listen${via === 'user' ? `. While the bot isn't in ${place}, a reply goes to the operator's DM with a link to the thread` : ''}`
  return `${conversationId(c)} is bound to ${me} (${how})`
}

/**
 * `bind_conversation` with a `target`: the power of main and of the router (the specialist an app's `router` names, `isRouter`): hand a
 * conversation delivered to it on to another session, with the reason. It is `hydra conversations bind <conversation> thread:<id> --why`,
 * notice in the Slack thread included, and only for a conversation bound to the caller: it hands on what it was given, never what is
 * another's. The router's own session is never the target: a conversation handed to it would be the router's again.
 */
async function bindToSession(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>> | undefined, conversation: unknown, target: unknown, why: unknown, isMain: boolean): Promise<string> {
  const h = hydraConfig()
  const me = isMain ? MAIN : boundAs(caller, h)
  if (!me || (me !== MAIN && !isRouter(h, me))) throw new Error("only main and the router (the specialist an app's `router` in hydra.toml names) may bind a conversation to another session; bind_conversation without a target binds it to you")
  if (typeof target !== 'string' || !target.trim()) throw new Error('target must name a session: its name (list_sessions) or thread:<thread id>')
  if (typeof why !== 'string' || !why.trim()) throw new Error('why is required: one line saying why this session, posted in the Slack thread')
  const name = target.trim().replace(/^thread:/, '')
  const session = [...registry.values()].filter(s => s.deadAt === undefined && (s.threadId === name || s.tmuxName === name)).sort((a, b) => Number(a.sessionType === 'thread_guest') - Number(b.sessionType === 'thread_guest'))[0]
  if (!session?.threadId || !occupied(occupancy(session))) throw new Error(`no live session "${name}": name one from list_sessions, or spawn one for this thread`)
  const fills = specialistOf(session, h)
  // A session whose reach is cut down, or that sits in another's thread, is no place to send a stranger's thread: `reachable_by` is not asked of a session's own thread.
  if (session.sessionType === 'thread_guest' || isRestricted(session) || (fills !== undefined && (h.specialists[fills]?.restricted || h.specialists[fills]?.canOnlyWriteTo))) throw new Error(`${session.tmuxName} is a restricted, write-confined or guest session: name another session, or spawn one`)
  if (session.threadId === caller?.threadId || (fills !== undefined && isRouter(h, fills))) throw new Error(`${session.tmuxName} is the router: a conversation bound to it comes back to it. Name another session, or spawn one`)
  const c = parseConversation(conversation)
  // A DM, or a place's top level, is routing's to hand out: a tool never moves one, least of all the operator's DM from main.
  if (isDm(c.channel) || c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} is not a thread in a channel: only a thread can be handed on`)
  // A router hands on only what its own app's tag brought it.
  if (me !== MAIN && routerOf(h, appOfEntry(c)) !== me) throw new Error(`${conversationId(c)} is through ${appOfEntry(c)}, whose router is not ${me}: a router hands on only conversations of the app that names it`)
  const boundTo = getConversationTable().get(c.channel, c.threadTs, appOfEntry(c))?.specialist
  if (!boundTo || currentId(h, boundTo) !== me) throw new Error(`${conversationId(c)} is ${boundTo ? `bound to ${boundTo}` : 'not an open conversation'}, not to ${me}: ${me} hands on only a conversation delivered to it`)
  // main speaks for the operator (the CLI's hand); a router's hand-offs are counted and capped like a session's own binds.
  if (me === MAIN) return operatorBind(conversationId(c), `thread:${session.threadId}`, why, me)
  const handed = getConversationTable().list().filter(e => e.boundBy === 'router' && appOfEntry(e) === appOfEntry(c) && conversationId(e) !== conversationId(c)).length
  if (handed >= ROUTER_BIND_MAX) throw new Error(`${me} already holds ${ROUTER_BIND_MAX} conversations it handed on; none is its to unbind now, so wait for a session to let one go, or ask the operator to unbind one (hydra conversations unbind)`)
  return operatorBind(conversationId(c), `thread:${session.threadId}`, why, me, 'router')
}

/** `unbind_conversation`: a session lets go of one of its own conversations. */
export function unbindConversation(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>> | undefined, conversation: unknown): string {
  const me = boundAs(caller)
  if (!me) throw new Error('this session has no thread, so it holds no conversations')
  const c = parseConversation(conversation)
  const e = getConversationTable().get(c.channel, c.threadTs, appOfEntry(c))
  if (!e) return `${conversationId(c)} was not bound`
  if (!e.specialist || currentId(hydraConfig(), e.specialist) !== me) throw new Error(`${conversationId(c)} is bound to ${e.specialist ?? 'no one yet'}, not ${me}`)
  const owed = e.owed?.length ?? 0
  // A session that unbinds learns of its drop from this result; a specialist's drop is alerted in its thread.
  const own = isSessionThread(me)
  getConversationTable().unwatch(c.channel, c.threadTs, appOfEntry(c), own, { by: me })
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped${own ? '' : ' (and alerted)'}` : ''}`
}

/** Slack's own advice is to keep a message under 4,000 characters; longer ones are split. */
const SLACK_CHUNK = 3900
/** Errors that say a post did not happen: a platform refusal (`An API error occurred: …`), a rate limit, no connection. */
const CLEANLY_REFUSED = /An API error occurred|rate.?limit|not connected/i
/** A backstop past the posting client's own deadline (it neither retries nor waits longer). */
const POST_BACKSTOP_MS = POST_TIMEOUT_MS + 5_000

/**
 * Whether the caller answers this conversation: a per-conversation session answers its own conversation and no other; a
 * shared session, any conversation bound to its specialist. `bound` is who the conversation is bound to (current id), `me` who the caller acts for.
 */
function mayAnswerConversation(h: HydraConfig, caller: SessionInfo | undefined, me: string | undefined, bound: string | undefined, id: string): boolean {
  const ownSession = !!caller && !!bound && [bound, ...(h.specialists[bound]?.renamedFrom ?? [])].some(sid => caller.tmuxName === delivery.conversationSessionName(sid, id))
  return isConversationSession(caller) ? ownSession : (!!me && bound === me)
}

/** What a session does in a conversation it must answer: the one rule below holds each, and names it in a refusal. */
export type OwnUse = 'a reply' | 'a read' | 'an edit' | 'a delete' | 'a reaction' | 'a download'
const OWN_VERB: Readonly<Record<OwnUse, string>> = { 'a reply': 'answer', 'a read': 'read', 'an edit': 'edit', 'a delete': 'delete', 'a reaction': 'react to', 'a download': 'download' }

/**
 * Why `conversation` is not one the caller may use as `use` (assertOwnConversation), or undefined when it is. Never throws: an id that parses
 * to nothing, or is not open, is not theirs. The dispatcher holds a restricted or write-confined session's every tool to this.
 */
export function ownConversationRefusal(callerSessionId: string | undefined, conversation: unknown, use: OwnUse = 'a reply'): string | undefined {
  try { assertOwnConversation(hydraConfig(), callerSessionId, conversation, use); return undefined } catch (err) { return err instanceof Error ? err.message : String(err) }
}

/**
 * Throws unless `conversation` is an open conversation the caller answers, and returns it: bound to the caller's specialist (a conversation's own
 * session: that conversation only); a conversation bound to a session's own thread, only for that session, and only a plain one. The one ownership rule: `reply` holds every session to it, and
 * the dispatcher holds a restricted or write-confined session's every tool to it (`ownConversationRefusal`), `fetch_messages`, `edit_message`
 * and `delete_message` among them. It never counts the specialist's `home_place` (`reply` posts there on its own path).
 *
 * A read never reaches a channel's top level. Its conversation (`messages = "all"`) is only the untagged top-level messages, but Slack's
 * `history` returns every one, those routing gave to another specialist or app too. A DM's top level is the DM's alone, and stays readable.
 */
function assertOwnConversation(h: HydraConfig, callerSessionId: string | undefined, conversation: unknown, use: OwnUse): { c: ReturnType<typeof parseConversation>; app: string; id: string; entry: ConversationEntry; bound: string | undefined; caller: SessionInfo | undefined; me: string | undefined; plain: boolean } {
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const id = conversationId(c)
  if (use === 'a read' && c.threadTs === TOP_LEVEL && !isDm(c.channel)) {
    throw new Error(`${id} is a channel's top level, which holds every top-level message there, others' too: a read goes only to a thread bound to your specialist (${conversationId({ ...c, threadTs: '<thread ts>' })}) or a DM`)
  }
  const entry = getConversationTable().get(c.channel, c.threadTs, app)
  if (!entry) throw new Error(`${id} is not an open conversation, so there is nothing there to ${OWN_VERB[use]}`)
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  const me = callerSessionId === 'main' ? MAIN : boundAs(caller, h)
  const plain = isPlainSession(callerSessionId, caller)
  return { c, app, id, entry, bound: answeredBy(h, caller, me, plain, entry, id, use), caller, me, plain }
}

/**
 * A plain session: one with a record, not main, and neither restricted nor write-confined (by its record or its bridge's declaration). It alone
 * speaks in a thread bound to its own thread; a restricted or write-confined session speaks only where its specialist answers.
 */
function isPlainSession(callerSessionId: string | undefined, caller: SessionInfo | undefined): boolean {
  return !!callerSessionId && callerSessionId !== 'main' && !!caller && !isRestrictedSession(callerSessionId) && !isWriteConfinedSession(callerSessionId)
}

/** Throws unless the caller answers this open conversation (assertOwnConversation's rule, for an entry already in hand); returns who it is bound to. */
function answeredBy(h: HydraConfig, caller: SessionInfo | undefined, me: string | undefined, plain: boolean, entry: ConversationEntry, entryId: string, use: OwnUse): string | undefined {
  const bound = entry.specialist ? currentId(h, entry.specialist) : undefined
  // A thread bound to a session's own thread is that session's: a plain session speaks in it (mayAnswerConversation: bound === me), any other only listens.
  if (bound && isSessionThread(bound) && bound === me && !plain) throw new Error(`${entryId} is bound to this session's thread to listen to: a restricted or write-confined session uses Slack only in a conversation bound to its specialist`)
  if (!mayAnswerConversation(h, caller, me, bound, entryId)) throw new Error(`${entryId} is bound to ${bound ?? 'no one yet'}${me ? `, not ${me}` : ''}: ${use} goes only to a conversation bound to your specialist${isConversationSession(caller) ? ', and from a conversation\'s own session only to that conversation' : ''}`)
  return bound
}

/** `edit_message` and `delete_message` with a conversation id as their chat_id. */
export const editInConversation = (callerSessionId: string | undefined, conversation: unknown, messageId: unknown, text: string): Promise<string> => amendInConversation(callerSessionId, conversation, messageId, { text })
export const deleteInConversation = (callerSessionId: string | undefined, conversation: unknown, messageId: unknown): Promise<string> => amendInConversation(callerSessionId, conversation, messageId, undefined)

/**
 * `fetch_messages` with a conversation id as its channel: the conversation's newest `limit` messages, oldest first, read through the app the id
 * names (`default` when it names none), as `reply` posts through it. Who may read is the dispatcher's: a restricted or write-confined session is
 * held there to its own conversations (assertOwnConversation, before this runs); any other session (and main) reads what that app's bot can read.
 * The operator's token, which also reads the operator's own DMs and groups, reads only a conversation hydra holds (in the conversation table), the
 * reach catch-up has: a thread the bot is not in is read as the operator once it is bound, and refused before then.
 */
export async function fetchInConversation(conversation: unknown, limit: number): Promise<ReadMessage[]> {
  const h = hydraConfig()
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const id = conversationId(c)
  declaredApp(h, app)
  const bound = !!getConversationTable().get(c.channel, c.threadTs, app)
  const threadTs = c.threadTs === TOP_LEVEL ? undefined : c.threadTs
  try {
    return await slackRuntimeDeps.read(c.channel, threadTs, limit, app, bound)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (threadTs && !bound && NOT_A_MEMBER.test(why)) {
      const place = placeName(offlineView(app), c.channel)
      // Binding helps only where the operator's token can read: it is what a bind is checked with too.
      const how = h.slackApps[app]?.operatorTokenEnv
        ? `Bind it first (bind_conversation(conversation="${id}")), then read it: a bound thread is read as the operator, and its new messages are delivered to this session until it is idle a week. Or ask the operator to invite the bot to ${place}`
        : `Ask the operator to invite the bot to ${place}`
      throw new Error(`fetch_messages: ${id} can't be read through ${appName(h.slackApps, app)}: its bot isn't in ${place} (${why}), and the operator's token reads only a conversation hydra holds. ${how}`)
    }
    throw new Error(`fetch_messages failed for ${id} through ${appName(h.slackApps, app)}: ${why}`)
  }
}

/** The user scope the operator's own messages are rewritten with. */
const OPERATOR_WRITE_SCOPE = SLACK_APP_NEEDS.operatorWriteScope

/**
 * Whose a message is, and through which app. A named app is asked alone. With none named, every declared app is asked, the conversation's own
 * first: the app whose bot wrote it is the one to rewrite it, and the operator's own message goes through the app that holds the operator's token.
 * An app that cannot read the message is passed over unless none can.
 */
async function authorAcross(h: HydraConfig, c: ReturnType<typeof parseConversation>, named: boolean, first: string, ts: string): Promise<{ app: string; author: MessageAuthor }> {
  const apps = named ? [first] : [...new Set([first, ...Object.keys(h.slackApps)])]
  const threadTs = c.threadTs === TOP_LEVEL ? undefined : c.threadTs
  let failure: unknown
  let asked = false
  for (const app of apps) {
    try {
      const author = await slackRuntimeDeps.author(c.channel, ts, threadTs, app)
      if (author !== 'other') return { app, author }
      asked = true
    } catch (err) { failure ??= err }
  }
  if (!asked && failure !== undefined) throw failure
  return { app: first, author: 'other' }
}

/**
 * Rewrites or deletes one Slack message. Whose message it is is asked of Slack, and decides the token: an app's bot's, with that app's bot token,
 * and the operator's, with the operator's user token. Anyone else's is refused before Slack is asked to touch it. `change` is the new text, or absent to delete.
 * A session that is not a restricted specialist (and main) may do this in any conversation, bound or not. A restricted specialist only
 * touches its own app's posts, never the operator's, and only in a conversation bound to it: the dispatcher holds it there before this runs
 * (assertOwnConversation), and this holds it again once Slack has been asked, since the conversation may have moved meanwhile.
 */
async function amendInConversation(callerSessionId: string | undefined, conversation: unknown, messageId: unknown, change: { text: string } | undefined): Promise<string> {
  const verb = change ? 'edit' : 'delete'
  const done = verb === 'edit' ? 'edited' : 'deleted'
  const h = hydraConfig()
  const c = parseConversation(conversation)
  const named = typeof conversation === 'string' && /^slack:[a-z][a-z0-9_-]{0,34}:/.test(conversation.trim())
  const id = conversationId(c)
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  const restricted = callerSessionId !== 'main' && (!caller || isRestricted(caller))
  const me = callerSessionId === 'main' ? MAIN : boundAs(caller, h)
  const what: OwnUse = verb === 'edit' ? 'an edit' : 'a delete'
  // Exactly Slack's form: a destructive call never completes a ts into a different message.
  if (typeof messageId !== 'string' || !/^\d{1,12}\.\d{6}$/.test(messageId)) throw new Error(`message_id ${String(messageId)} is not a Slack message ts (like 1793732224.093059, six digits after the point): copy it from the delivery`)
  const ts = messageId
  if (change && (typeof change.text !== 'string' || !change.text.trim())) throw new Error('nothing to edit to: the text is empty (delete_message removes a message)')
  // An edit is one message: it cannot be split as a reply is.
  if (change && change.text.length > SLACK_CHUNK) throw new Error(`an edit is one message: ${change.text.length} characters is over ${SLACK_CHUNK}. Shorten it, or edit to a short text and reply with the rest`)
  const { app, author } = await authorAcross(h, c, named || restricted, appOfEntry(c), ts)
  if (author === 'other') throw new Error(`${ts} in ${id} was written by neither ${named || restricted ? `${appName(h.slackApps, app)}'s` : 'any hydra app\'s'} bot nor the operator, so it is not hydra's to ${verb}${restricted ? `: a restricted specialist may ${verb} only its own app's posts` : ' (an app knows the operator\'s only with `operator_token_env`)'}`)
  if (author === 'operator' && restricted) throw new Error(`${ts} in ${id} is the operator's own message: a restricted specialist may ${verb} only its own app's posts`)
  if (restricted) {
    // Slack was asked in between: a conversation moved away meanwhile gets no write (reply checks before every part too).
    const now = getConversationTable().get(c.channel, c.threadTs, app)
    if (!now) throw new Error(`${id} is no longer an open conversation: nothing was ${done}`)
    answeredBy(hydraConfig(), caller, me, false, now, id, what)
  }
  try {
    if (change) await slackRuntimeDeps.edit(c.channel, ts, change.text, app, author)
    else await slackRuntimeDeps.remove(c.channel, ts, app, author)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (author === 'operator' && /missing_scope/.test(why)) throw new Error(`the operator token of ${appName(h.slackApps, app)} lacks the user scope ${OPERATOR_WRITE_SCOPE}, so its owner's messages cannot be ${done}: add ${OPERATOR_WRITE_SCOPE} under User Token Scopes (\`hydra slack manifest ${app}\` lists it) and reinstall the app (${why})`)
    throw new Error(`${verb} failed: ${why}`)
  }
  return `${done} ${ts} in ${id}`
}

/**
 * `reply` with a conversation id as its chat_id: the specialist answers a Slack conversation. Hydra posts the text
 * as given, and only into a conversation bound to the caller's specialist (with `replyTo`, in a DM, into the thread of that message, bound to the caller): a reply goes back where its question came from. A thread
 * bound to a session's own thread is that session's to answer when it is a plain session (assertOwnConversation); when the bot isn't in its channel,
 * the answer goes to the operator's DM with a link, as main's does.
 */
export async function replyInConversation(callerSessionId: string | undefined, conversation: unknown, text: string, files: string[] = [], replyTo?: string): Promise<string> {
  if (!text.trim()) throw new Error('nothing to post: the text is empty')
  // Checked before anything posts; shared after the text, in the same place, and a file that fails says why without taking the text with it.
  const uploads = checkUploads(files)
  const attach = async (app: string, channel: string, thread: string | undefined, allowed: () => boolean) => !uploads.length ? '' : !allowed() ? '; the files were not attached: it is no longer yours to answer'
    : `; ${await slackRuntimeDeps.upload(channel, thread, uploads, app).then(uploadLine, (err: unknown) => `the files did not attach: ${oneLine(err instanceof Error ? err.message : String(err), 300)}`)}`
  const h = hydraConfig()
  const me = callerSessionId === 'main' ? MAIN : boundAs(callerSessionId ? registry.get(callerSessionId) : undefined, h)
  // Its own `home_place` (a schedule's reply has no conversation): a new thread there, bound to it, so answers come back to it.
  // The app it posts as with no message to answer: hydra.toml's loader has checked it is declared and can reach the specialist.
  const spec = me ? h.specialists[me] : undefined
  const speaks = spec ? speaksAsOf(spec, Object.keys(h.slackApps)) : undefined
  const homePlaceId = me ? homePlaceChannel(h, me, speaks) : undefined
  if (homePlaceId && (conversation === h.specialists[me!]?.homePlace || conversation === `slack:${homePlaceId}` || conversation === conversationId({ app: speaks, channel: homePlaceId, threadTs: TOP_LEVEL }))) {
    if (replyTo) throw new Error(`reply_to cannot be used on a post to ${me}'s home_place: it opens a thread of its own`)
    if (!speaks) throw new Error(`${me} has no Slack app to post as: set \`speaks_as\` in [specialists.${me}]`)
    declaredApp(h, speaks)
    const where = `${me}'s home_place (${h.specialists[me!]!.homePlace})`
    // Its thread is a conversation bound to it as soon as the first part lands (whatever becomes of the rest).
    let unbound: string | undefined
    const bindThread = (ts: string) => { unbound = bindOpenedThread(h, me!, homePlaceId, ts, speaks, 'post to its home_place', 'home') }
    const stillHome = () => homePlaceChannel(hydraConfig(), me!, speaks) === homePlaceId
    const { first } = await postParts(speaks!, homePlaceId, undefined, text, where, true, stillHome, bindThread)
    const filed = await attach(speaks!, homePlaceId, first, stillHome)
    return unbound ? `posted to ${where}${filed}, but its thread is not bound to ${me}: ${unbound}` : `posted to ${where}${filed}; replies in its thread come back to ${me}`
  }
  // Who it is bound to, which `stillMine` holds it to before every part.
  const { c, app, id, caller, bound, plain } = assertOwnConversation(h, callerSessionId, conversation, 'a reply')
  // Which thread the post goes in. A thread conversation is its one thread (Slack threads are flat: no message inside one can be answered on its own);
  // a top-level conversation (only a DM has one) is answered in the thread of the message `reply_to` names, else at its top level.
  let thread = c.threadTs === TOP_LEVEL ? undefined : c.threadTs
  let how = ''
  let opened: string | undefined
  let nested: ConversationEntry | undefined
  if (replyTo) {
    const ts = THREAD_TS.test(replyTo) ? replyTo.replace(/\.(\d+)$/, (_, f: string) => `.${f.padEnd(6, '0')}`) : undefined
    if (!ts) throw new Error(`reply_to ${replyTo} is not a Slack message ts (like 1793732224.093059): nothing was posted. Copy the ts of the message you are answering from the delivery`)
    if (c.threadTs !== TOP_LEVEL) {
      if (ts !== c.threadTs) how = `; reply_to ${ts} is not this thread's first message, and a Slack reply cannot answer one message inside a thread, so it was posted to the thread as a whole`
    } else {
      // Its thread is a new conversation, with a session of its own when the specialist runs one per conversation: not this one's to open.
      if (isConversationSession(caller)) throw new Error(`reply_to cannot open a thread from a conversation's own session: the thread would be a new conversation with a session of its own. Nothing was posted; answer ${id} without reply_to`)
      nested = getConversationTable().get(c.channel, ts, app)
      if (nested) answeredBy(h, caller, me, plain, nested, conversationId({ ...c, threadTs: ts }), 'a reply')
      thread = ts
      opened = nested ? undefined : ts
      how = `, in the thread of message ${ts}`
    }
  }
  // Checked again before every part: a conversation moved away mid-reply gets no more of it.
  const stillBound = (channel: string, threadTs: string, was: string | undefined) => { const now = getConversationTable().get(channel, threadTs, app)?.specialist; return !!now && currentId(hydraConfig(), now) === was }
  const nestedBound = nested?.specialist ? currentId(h, nested.specialist) : undefined
  const stillMine = () => stillBound(c.channel, c.threadTs, bound) && (!nested || stillBound(nested.channel, nested.threadTs, nestedBound))
  // Through the app that heard the conversation, and no other. A thread opened under a message is bound to the replier as its first part lands,
  // so the person's answer in it comes back to the session that asked, not to whoever the rules name for that place.
  let unbound: string | undefined
  let posted: number
  try {
    ({ posted } = await postParts(app, c.channel, thread, text, id, false, stillMine, opened ? () => { unbound = bindOpenedThread(h, me!, c.channel, opened!, app, `reply in the thread of message ${opened}`, 'tool') } : undefined))
  } catch (err) {
    // A restricted specialist's words go only where its conversation is: never to the operator's DM in its place.
    if (!(err instanceof NotInChannel) || (me !== MAIN && h.specialists[me ?? '']?.restricted)) throw err
    const dm = await toOperatorDm(app, id, err.message, text, stillMine, `From ${me === MAIN ? 'main' : me && isSessionThread(me) ? sessionNameIn(me) ?? `the session in thread ${me}` : me ?? 'a session'}`)
    return uploads.length ? `${dm}; the files were not attached anywhere` : dm
  }
  if (posted) {
    getConversationTable().touch(c.channel, c.threadTs, app)
    // 📤 in the replier's own thread, where 📨 is shown: a conversation bound to a plain session's own thread (a specialist's conversation gets neither).
    const own = plain && bound && isSessionThread(bound) && caller ? routeThreadId(caller) : undefined
    const link = slackConversationLink(id)
    if (own) showLine(own, emoji => postedLine(emoji, link, text))
  }
  const said = `posted ${posted} message${posted === 1 ? '' : 's'} to ${id}${how}${await attach(app, c.channel, thread, stillMine)}`
  return opened ? (unbound ? `${said}; its thread is not bound to ${me}: ${unbound}, so replies in it go to whoever the rules name here` : `${said}; replies in it come back to ${me}`) : said
}

/**
 * A thread this session opened by answering under a message is a conversation bound to it, counted with the ones it binds by hand so a loop
 * can't fill the table. Returns why it is not bound (alerting unless the thread is a hydra session's own), or nothing.
 */
function bindOpenedThread(h: HydraConfig, me: string, channel: string, ts: string, app: string, what: string, by: 'home' | 'tool'): string | undefined {
  const w = getConversationTable()
  if (w.isHosted(channel, ts)) return `it is a hydra session's own thread`
  // A thread the person answered into while the first part was posting may already be bound by the rules: never taken from whoever holds it.
  const open = w.get(channel, ts, app)
  if (open?.specialist && currentId(h, open.specialist) !== me) return `it is already bound to ${open.specialist}`
  // The bot's own post may have opened it first (routing's, evictable): binding it makes it this session's by hand, counted like any other.
  const held = w.list().filter(e => heldBySession(e) && e.specialist && currentId(h, e.specialist) === me).length
  if ((held < TOOL_BIND_MAX || (!!open && heldBySession(open))) && w.bind(channel, ts, me, by, app)) return undefined
  const why = held >= TOOL_BIND_MAX ? `${me} already holds ${TOOL_BIND_MAX} conversations it opened itself` : 'the conversation table is full'
  alert(`⚠️ ${me}'s ${what} opened no conversation (${why}): replies under it go to whoever hears there, not back to ${me}.`, me)
  return why
}

/** A link to a Slack conversation (`slack:[app:]C…[:ts]`), when the app that heard it knows the workspace's address; undefined otherwise. */
export function slackConversationLink(conversation: string): string | undefined {
  try {
    const c = parseConversation(conversation)
    const url = config(appOfEntry(c))?.workspaceUrl
    if (!url) return undefined
    return archiveUrl(url, c.channel, c.threadTs === TOP_LEVEL ? undefined : c.threadTs)
  } catch { return undefined }
}

/** A specialist's `home_place`, when it names a Slack place: that channel's id (a `#name` resolved once names are read, through the app it speaks as). */
function homePlaceChannel(h: HydraConfig, id: string, app?: string): string | undefined {
  const home = homePlaceOf(h.specialists[id] ?? {})
  if (home?.platform !== 'slack' || home.kind !== 'channel') return undefined
  return isChannelName(home) ? offlineView(app).directory.idOf(home.ref.slice(1)) : home.ref
}

/** Slack refused a post because the bot is not in the channel: nothing was posted there. */
export class NotInChannel extends Error {}

const errText = (err: unknown): string => err instanceof Error ? err.message : String(err)

/**
 * One part, as the app's bot: never as the operator, and the bot never joins a channel to post. An app with the operator's token hears
 * threads in channels its bot is not in: Slack's refusal there is `NotInChannel`, so the caller can take the words to the operator instead.
 * An app without the token is a member wherever it hears, so its refusal stands as Slack gave it.
 */
async function postPart(app: string, channel: string, thread: string | undefined, part: string): Promise<string> {
  try { return await slackRuntimeDeps.post(channel, thread, part, app) } catch (err) {
    // A DM or a group DM between people never takes a bot's post: that refusal is not a channel the bot could be invited to.
    if (NOT_A_MEMBER.test(errText(err)) && !isDm(channel) && !config(app)?.directory.isGroupDm?.(channel) && hydraConfig().slackApps[app]?.operatorTokenEnv) throw new NotInChannel(`the bot isn't in that channel (${errText(err)}); invite it to the channel to post there`)
    throw err
  }
}

/** The operator's Slack user id, from hydra.toml: where an answer goes that could not be posted where it was meant to. */
function operatorSlackUser(h: HydraConfig): string | undefined {
  const a = h.operator ? h.people[h.operator]?.addresses.find(x => x.startsWith('slack:')) : undefined
  return a?.slice('slack:'.length)
}

/**
 * An answer the bot could not post in `id` (it is not in the channel and could not join): posted instead in the operator's DM with the
 * app, under a line that links the thread and says why. Throws when the operator has no Slack address, or that post fails too.
 */
async function toOperatorDm(app: string, id: string, why: string, text: string, allowed: () => boolean, from: string): Promise<string> {
  const h = hydraConfig()
  const user = operatorSlackUser(h)
  if (!user) throw new Error(`nothing was posted to ${id}: ${why}, and hydra.toml gives the operator no Slack address to send it to instead`)
  const where = `the operator's DM with ${appName(h.slackApps, app)}`
  const link = slackConversationLink(id)
  const { posted } = await postParts(app, user, undefined, `${from}, not posted in ${link ?? id}: ${why}. Here instead:\n\n${text}`, where, true, allowed)
  return `not posted to ${id}: ${why}. Posted ${posted} message${posted === 1 ? '' : 's'} to ${where} instead, with a link to the thread`
}

/**
 * The text as written, split under Slack's limit, posted part by part while `allowed()` still holds. `thread` undefined:
 * the first part at the top level, and with `threadRest` the others in its thread. Posting never retries on its own, so
 * a part either landed, failed, or (past the deadline) is unknown: said as such, so a resend is the caller's choice.
 */
async function postParts(app: string, channel: string, thread: string | undefined, text: string, where: string, threadRest: boolean, allowed: () => boolean, onFirst?: (ts: string) => void): Promise<{ first: string; posted: number }> {
  const parts = chunk(text, SLACK_CHUNK, 'markdown')
  let posted = 0
  let first: string | undefined
  for (const part of parts) {
    if (!allowed()) throw new Error(`stopped after ${posted} of ${parts.length} message(s) to ${where}: it is no longer yours to answer`)
    let timer: ReturnType<typeof setTimeout> | undefined
    let ts: string
    try {
      ts = await Promise.race([
        postPart(app, channel, thread, part),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POST_BACKSTOP_MS) }),
      ]).finally(() => clearTimeout(timer))
    } catch (err) {
      // Nothing of it posted, and Slack said why: the caller may take the words elsewhere.
      if (err instanceof NotInChannel && posted === 0) throw err
      const why = err instanceof Error ? err.message : String(err)
      // Only an answer that says it didn't post counts as not posted: Slack refusing it outright, a rate limit, or no
      // connection at all. Anything else (fatal_error, a 5xx, a timeout, a dropped socket) may have half succeeded.
      const unknown = !CLEANLY_REFUSED.test(why) || /fatal_error/.test(why)
      throw new Error(unknown
        ? `${posted} of ${parts.length} message(s) posted to ${where}; part ${posted + 1}'s outcome is unknown (no answer from Slack: it may have posted). Check ${where} before sending the rest.`
        : `reply failed after ${posted} of ${parts.length} message(s) posted to ${where}: ${why}. Part ${posted + 1} did not post; send from there.`)
    }
    if (first === undefined) { first = ts; onFirst?.(ts) }
    if (threadRest) thread ??= ts
    posted++
  }
  return { first: first!, posted }
}

/** How long a bind's reason may be: one line in the notice. */

/**
 * `hydra conversations bind`: the operator (or main, for them) binds or moves a conversation to any declared specialist, main, or a
 * session's thread (a plain session there answers in it). To a session's thread, the notice (which session, a link to its thread, `why` when given, and the
 * conversation's permalink) goes to that thread, privately: nothing is posted in the Slack conversation, whose audience is outside hydra. The bind holds if the notice fails; the result says so.
 */
export async function operatorBind(conversation: string, target: string, why?: string, by = 'operator', hand: BoundBy = 'cli'): Promise<string> {
  const h = hydraConfig()
  // The target must say its kind (a bare `ops` is an error); a binding stores the bare form.
  const ref = readTarget(target, id => Object.hasOwn(h.specialists, id))
  if (!ref.ok) throw new Error(ref.error ?? `no specialist "${ref.undeclared}" in hydra.toml (or a session's thread id)`)
  if (why !== undefined && ref.ref.kind !== 'thread') throw new Error(`--why gives the reason in the notice that a bind to a session's thread (thread:<id>) posts in that thread; a bind to ${target} posts no notice`)
  const to = bareOf(ref.ref)
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  declaredApp(h, app)
  // A specialist pinned to other apps can't be reached through this one (`main` and a session's thread are exempt).
  const apart = notServedBy(h, to, app, 'this conversation is through')
  if (apart) throw new Error(`${conversationId(c)} can't be bound to ${to}: ${apart}`)
  // A channel has no top-level conversation: every one is a thread (a DM's top level is one, and may be moved).
  if (!isDm(c.channel) && c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} names a channel, not a conversation: add the thread's ts`)
  if (getConversationTable().isHosted(c.channel, c.threadTs)) throw new Error(`${conversationId(c)} is a hydra session's own thread: nothing new can be bound to it`)
  if (!getConversationTable().bind(c.channel, c.threadTs, to, hand, app, { by, ...(why?.trim() && { why: why.trim() }) })) throw new Error('the conversation table is full')
  const bound = `${conversationId(c)} → ${to}`
  if (ref.ref.kind !== 'thread') return bound
  return `${bound}; ${await bindNotice(c, to, why)}`
}

/**
 * The notice a bind to a session's thread posts: in that session's own thread, never in the Slack conversation (whose audience is outside hydra: a
 * Discord link or an internal session name has no place there; the app's 👀 on the tag is the people's acknowledgement). It says which session took the
 * conversation, a link to the session's thread, `why`, and the conversation's permalink. Where that thread cannot be posted in, the operator's DM with
 * the app gets it instead, which is private. Never throws, and logs every outcome: a notice never fails silently.
 */
async function bindNotice(c: ReturnType<typeof parseConversation>, threadId: string, why: string | undefined): Promise<string> {
  const app = appOfEntry(c)
  const id = conversationId(c)
  const session = [...registry.values()].find(s => s.threadId === threadId && s.deadAt === undefined)
  let url = session?.threadUrl
  if (!url) { try { url = await gateway.getThreadUrl(threadId) } catch { url = undefined } }
  const reason = why ? oneLine(why, BIND_WHY_MAX) : ''
  const text = `→ ${session?.tmuxName ?? `thread ${threadId}`}${url ? ` ${url}` : ''}${reason ? `: ${reason}` : ''}\nSlack conversation: ${slackConversationLink(id) ?? id}`
  const note = (outcome: string): string => { log(`daemon: slack connector: bind notice for ${id} → ${threadId}: ${outcome}\n`); return outcome }
  // Posted only while the conversation is still bound to that thread.
  const stillThere = () => getConversationTable().get(c.channel, c.threadTs, app)?.specialist === threadId
  if (!stillThere()) return note('not posted: the conversation was moved before the notice went out')
  try {
    await gateway.send(threadId, text, { unfurl: false })
    return note(`posted in the session's thread ${threadId}: ${text}`)
  } catch (err) {
    const failure = errText(err)
    try { return note(`${await toOperatorDm(app, id, `the session's thread ${threadId} could not be posted in (${failure})`, text, stillThere, 'The bind notice')} (the bind notice)`) } catch (dmErr) { return note(`not posted: ${failure}; the operator's DM did not take it either: ${errText(dmErr)}`) }
  }
}

export function operatorUnbind(conversation: string): string {
  const c = parseConversation(conversation)
  const owed = getConversationTable().get(c.channel, c.threadTs, appOfEntry(c))?.owed?.length ?? 0
  if (!getConversationTable().unwatch(c.channel, c.threadTs, appOfEntry(c), false, { by: 'operator' })) return `${conversationId(c)} was not bound`
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped (and alerted)` : ''}`
}

/** The live session in a thread, by name. */
const sessionNameIn = (threadId: string): string | undefined => [...registry.values()].find(s => s.threadId === threadId && s.deadAt === undefined)?.tmuxName

const line = (v: Pick<ConversationConfig, 'hydra' | 'directory'>, e: ConversationEntry, now: number): string => {
  const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
  const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
  const via = e.via === 'user' ? ' · read as the operator' : ''
  const to = e.specialist && isSessionThread(e.specialist) ? `${sessionNameIn(e.specialist) ?? 'no session'} (its thread ${e.specialist})` : e.specialist
  return `${conversationId(e)} (${placeName(v, e.channel)}) → ${to ?? '(unbound: its next message binds it)'} · idle ${idle}h${owed}${via}`
}

/** The operator's view: every conversation. */
export function formatConversations(now = Date.now(), only?: (e: ConversationEntry) => boolean): string[] {
  return getConversationTable().list().filter(e => !only || only(e)).map(e => line(offlineView(appOfEntry(e)), e, now))
}

/** The conversations a session may see: those bound to it (boundAs). One session never reads another's. */
export function formatConversationsFor(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>>, now = Date.now()): string[] {
  const me = boundAs(caller)
  const h = hydraConfig()
  return me ? formatConversations(now, e => !!e.specialist && currentId(h, e.specialist) === me) : []
}

/**
 * For `hydra health` and `hydra conversations`: null when Slack isn't configured. Refusals and drops count since the daemon started.
 * `apps` is every declared app's health by id (its listener's, `off` when it has none, with its tokens and connection);
 * `listener` is the same fact for the app `default` (else the first connected), kept as an alias.
 */
export function slackConversationHealth(now = Date.now()): ({ places: { place: string; to: string; note?: string }[]; conversations: number; readAsOperator: number; owed: number; oldestOwedAgeMin: number | null; owedLate: LateOwed[]; owedLateAfterMin: number; listener?: AppHealth; apps: Record<string, AppHealth> } & ConversationStats) | null {
  const h = hydraConfig()
  if (!slackConfigured(h)) return null
  const entries = getConversationTable().list()
  const owed = entries.flatMap(e => e.owed ?? [])
  const oldest = owed.sort(cmpTs)[0]
  // A name no connected app that reaches the place can resolve: each app reads its own workspace's channel names.
  const views = [...connections.listeners().keys()].map(a => offlineView(a))
  const unresolved = (place: Place): boolean => {
    if (!views.length) return unresolvedPlaces(offlineView()).some(q => samePlace(q, place))
    const reaching = views.filter(v => namedChannels(v.hydra, v.app).some(q => samePlace(q, place)))
    return reaching.length > 0 && reaching.every(v => unresolvedPlaces(v).some(q => samePlace(q, place)))
  }
  const places = Object.values(h.specialists).flatMap(s => placesAnsweredBy(h, s.id).filter(p => p.platform === 'slack').map(place => ({
    place: placeKey(place), to: s.id,
    ...(unresolved(place) && { note: 'no channel answers to this name (not joined, renamed, or names unreadable without channels:read)' }),
  })))
  const apps = connections.health()
  const live = connections.listeners()
  const alias = live.has(DEFAULT_SLACK_APP) ? DEFAULT_SLACK_APP : [...live.keys()][0]
  return {
    places,
    conversations: entries.length,
    readAsOperator: entries.filter(e => e.via === 'user').length,
    owed: owed.length,
    oldestOwedAgeMin: oldest ? Math.max(0, Math.round((now / 1000 - parseFloat(oldest)) / 60)) : null,
    owedLate: getConversationTable().lateOwed(OWED_LATE_AFTER_MS, now),
    owedLateAfterMin: OWED_LATE_AFTER_MS / 60_000,
    ...getConversationTable().stats(),
    ...(alias && { listener: apps[alias] }),
    apps,
  }
}

/** For `hydra route`: the names a place goes by, most specific first, as the watcher would see them. */
export function placeAliases(place: Place, app?: string): Place[] {
  const v = offlineView(app)
  if (place.platform !== 'slack') return [place]
  if (place.kind === 'channel' && isChannelName(place)) {
    const id = v.directory.idOf(place.ref.slice(1))
    return id ? [placeOf('slack', 'channel', id), place] : [place]
  }
  // A group DM is also a channel by its id, and by its name when it has one (`placesOf`).
  const id = place.kind === 'channel' || place.kind === 'group-dm' ? place.ref : undefined
  const name = id && id !== '*' ? v.directory.nameOf(id) : undefined
  const byName = name ? [placeOf('slack', 'channel', `#${name}`)] : []
  if (place.kind === 'group-dm' && id !== '*') return [placeOf('slack', 'channel', id!), ...byName, place]
  return [place, ...byName]
}

