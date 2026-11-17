import { ConversationTable, namedChannels, cantRead, cmpTs, slackWatchesPath, unresolvedPlaces, conversationId, placeName, isDm, appOfEntry, TOP_LEVEL, NO_DIRECTORY, SLACK_LIMITS, type ConversationConfig, type ConversationEntry, type ConversationStats, type LateOwed } from './watch.js'
import { parseConversation, THREAD_TS } from './conversation.js'
import { ConnectedApps, type AppIdentity } from './apps.js'
import { getSpecialist, conversationSpecialistOf, specialistOf, boundAs } from '../../specialists/specialists.js'
import { registry } from '../../daemon/sessions.js'
import type { SessionInfo } from '../../daemon/sessions.js'
import { pushToolSurface } from '../../daemon/tool-surface.js'
import { deliverToTarget, conversationSessionName, conversationSessionRunning, placesFree, type Target } from '../../specialists/targets.js'
import { on } from '../../daemon/event-bus.js'
import { SlackListener, boltApp, POST_TIMEOUT_MS, OWED_LATE_AFTER_MS, type ToldScopes } from './listener.js'
import { SlackConnections, type AppHealth } from './connections.js'
import { STATE_DIR } from '../../daemon/config.js'
import { ENV_NAME_RE, capturedSpawnVars, scrubbedSpawnVars, tokenVarRefusal } from '../../shared/spawn-env.js'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { safeSend, atomicWriteFileSync } from '../../daemon/util.js'
import { mainChannel } from '../../daemon/main-session.js'
import { gateway } from '../../daemon/config.js'
import { currentHydraConfig, onHydraConfigLoad } from '../../daemon/hydra-config.js'
import { MAIN, currentId, isSessionThread, slackSpecialistsOf } from '../../routing/route.js'
import { chunk } from '../../daemon/util.js'
import { DEFAULT_SLACK_APP, coversAny, homePlaceOf, isChannelName, placeKey, placeOf, placesAnsweredBy, samePlace, slackConfigured, type Place, type HydraConfig, type SlackApp } from '../../config/types.js'
import { speaksAsOf, noSuchApp } from '../../config/pins.js'
import { notServedBy } from '../../routing/route.js'
import { NO_SLACK_APP, appKey, notConnected } from './app.js'
import { timed } from '../../shared/loop-watch.js'
import { registerSlackChannelNames } from '../../shared/link-previews.js'
import { bareOf, readTarget } from '../../shared/target-kind.js'

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
      if (where) { void safeSend(where, text).catch(() => {}); sent = true }
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
  void deliverToTarget({ to: `thread:${threadId}` }, `[system] ${text}`, { initiator: 'slack-watch', source: 'slack-watch', queue: true })
    .then(r => { if (!r.ok) log(`daemon: slack connector: the session in thread ${threadId} was not told (${r.reason}); its thread has the notice\n`) })
    .catch(err => log(`daemon: slack connector: telling the session in thread ${threadId} failed: ${err}\n`))
}

/** Where a binding's alerts are posted: main's channel for `main`, a session's own thread, else the specialist's thread. */
function alertChannel(to: string): string | undefined {
  return to === MAIN ? mainChannel() || undefined : isSessionThread(to) ? to : getSpecialist(to)?.threadId
}

let watcher: ConversationTable | undefined
let sweepTimer: ReturnType<typeof setInterval> | undefined

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
    log,
    config: app => config(app),
    apps: () => hydraConfig().slackApps,
    alert,
    hosted: threadId => !!registry.getByThread(threadId),
    deliver: async (target, message, idempotencyKey) => {
      const t = targetFor(target.to, target.conversation)
      // First come, first served, when places are short: a newer conversation without a session takes a place only if
      // one is left over after every older waiter has had theirs.
      if ('perConversation' in t && !conversationSessionRunning(t.perConversation, t.conversation)) {
        const h = hydraConfig()
        const waiters = getConversationTable().waiters(id => currentId(h, id) === t.perConversation)
        const ahead = waiters.findIndex(e => conversationId(e) === t.conversation)
        const before = ahead === -1 ? waiters.length : ahead
        if (before > 0 && placesFree(t.perConversation) <= before) return { ok: false, error: `${t.perConversation} is at max with ${before} conversation${before === 1 ? '' : 's'} waiting ahead of ${t.conversation}`, wait: true }
      }
      const r = await deliverToTarget(t, message, { initiator: 'slack-watch', idempotencyKey, source: 'slack-watch' })
      if (!r.ok && r.atMax) return { ok: false, error: r.reason, wait: true }
      if (r.ok) return { ok: true, ...(r.duplicate && { duplicate: true }) }
      return { ok: false, error: r.reason, exit: r.exit, ...(r.permanent && { permanent: true }), ...(r.malformed && { malformed: true }) }
    },
  })
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
 * One app's tokens, each read from the variable the app names for it. A token is read only from a variable the daemon
 * keeps from every session it starts: a token anywhere else would reach them all. hydra.toml's loader rejects a name
 * that is not one, and the daemon adds the ones it names to those; a name still not kept is refused here, saying which
 * key and why, and that app stays off.
 */
export function slackTokens(app: SlackApp, env: Readonly<Record<string, string>> = capturedSpawnVars(), warn: (line: string) => void = log): { app?: string; bot?: string; user?: string } {
  const read = (key: 'bot_token_env' | 'socket_token_env' | 'operator_token_env', name: string | undefined): string | undefined => {
    if (!name) return undefined
    if (!scrubbedSpawnVars().includes(name)) {
      const why = !ENV_NAME_RE.test(name) ? 'is not an environment variable name' : tokenVarRefusal(name) ?? 'is not among the variables kept from sessions (the daemon adds the ones hydra.toml names when it loads it)'
      warn(`daemon: slack connector: refusing to read the token in ${name}, the ${appKey({ [app.id]: app }, app.id, key)}: it ${why}, so a token there would reach every session hydra starts. Name a variable only the daemon needs, like CONNECTOR_SLACK_BOT_TOKEN.\n`)
      return undefined
    }
    return env[name]
  }
  const user = read('operator_token_env', app.operatorTokenEnv)
  return { bot: read('bot_token_env', app.botTokenEnv), app: read('socket_token_env', app.socketTokenEnv), ...(user && { user }) }
}

/**
 * Connects to Slack, one connection per app hydra.toml declares, and begins feeding the watcher. Called once boot recovery
 * has finished, so a specialist refill never races it. The tokens come from the scrubbed environment: only this module ever
 * sees them, never a session. An app with no tokens is skipped, and said so by name; the others connect. It runs again on every
 * hydra.toml load: an app added there connects, one taken out disconnects, with no restart.
 */
export function startSlackListener(): Promise<void> { return connections.start() }

export function stopSlackListener(): void { connections.stop() }

let lastSpecialists: string[] = []
let lastConnected: boolean | undefined
/**
 * Tell each session whose tools changed: a hydra.toml edit can add or remove a Slack specialist, and connecting or
 * disconnecting Slack gives or takes every thread session's conversation tools.
 */
export function refreshSlackSpecialistSurface(): void {
  const connected = slackConfigured(hydraConfig())
  if (lastConnected !== undefined && connected !== lastConnected) for (const s of registry.values()) pushToolSurface(s.sessionId)
  lastConnected = connected
  const now = slackSpecialistsOf(hydraConfig())
  const all = [...new Set([...now, ...lastSpecialists])]
  lastSpecialists = now
  for (const to of all) {
    const thread = getSpecialist(to)?.threadId
    const id = thread ? registry.getByThread(thread) : undefined
    if (id) pushToolSurface(id)
  }
}

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
  refreshSlackSpecialistSurface()
  const offConfig = onHydraConfigLoad(() => queueMicrotask(refreshSlackSpecialistSurface))
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
  const offDeath = on('session:death', freed, 'slack connector: wake conversations waiting at max')
  const offDead = on('session:marked-dead', freed, 'slack connector: wake conversations waiting at max (found dead)')
  // After a sleep the socket is likely dead and Slack replays nothing: replace it and catch up now, not when a timer notices.
  const offResumed = on('clock:resumed', () => { for (const l of connections.listeners().values()) l.onResume() }, 'slack connector: replace the socket and catch up after a resume')
  unsubscribe = () => { offConfig(); offRegistered(); offDeleted(); offDeath(); offDead(); offResumed() }
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
  for (const e of bound) getConversationTable().unwatch(e.channel, e.threadTs, e.app, true)
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
    getConversationTable().unwatch(e.channel, e.threadTs, e.app)
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

/**
 * `bind_conversation`: a session binds a Slack thread to itself (boundAs): a specialist's session to the specialist,
 * at a place it hears; any other session to its own thread, wherever the bot, or the operator, can read. It may bind
 * one that is unbound or already its own. Moving another's conversation is the operator's (`hydra conversations bind`).
 */
export async function bindConversation(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>> | undefined, conversation: unknown): Promise<string> {
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const v = offlineView(app)
  if (!slackConfigured(v.hydra)) throw new Error(`Slack is not connected: ${NO_SLACK_APP}`)
  declaredApp(v.hydra, app)
  const me = boundAs(caller, v.hydra)
  if (!me) throw new Error('this session has no thread to bind a conversation to')
  // A DM, or a place's top level, is routing's to hand out: a tool never takes one, least of all the operator's DM from main.
  if (isDm(c.channel) || c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} is not a thread in a channel: only a thread can be bound by hand`)
  if (registry.getByThread(`${c.channel}:${c.threadTs}`)) throw new Error(`${conversationId(c)} is a hydra session's own thread: its messages already reach that session`)
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
  if (!bound && w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(v.hydra, e.specialist) === me).length >= TOOL_BIND_MAX) {
    throw new Error(`${me} already holds ${TOOL_BIND_MAX} conversations it opened itself; unbind one first`)
  }
  if (!w.bind(c.channel, c.threadTs, me, 'tool', app)) throw new Error(`the conversation table is full (${SLACK_LIMITS.maxConversations}); unbind one first`)
  if (via) w.setVia(c.channel, c.threadTs, via, app)
  if (takeover) alert(`ℹ️ ${conversationId(c)} was bound to this session to listen; ${me} took it, since it answers there. This session no longer hears it.`, bound!)
  const place = placeName(v, c.channel)
  const how = via === 'bot' ? `live: the bot is in ${place}`
    : via === 'user' ? `live, read as the operator: the bot isn't in ${place}`
    : isSessionThread(me) ? "not checked: Slack isn't connected; if the thread can't be read, the next deep catch-up lets it go and says so here"
    : "not checked: Slack isn't connected"
  if (isSessionThread(me)) return `${conversationId(c)} is bound to this session, listen-only (${how}): each new message in it is delivered here until it has been idle a week`
  return `${conversationId(c)} is bound to ${me} (${how})`
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
  getConversationTable().unwatch(c.channel, c.threadTs, appOfEntry(c), own)
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
  const ownSession = !!caller && !!bound && [bound, ...(h.specialists[bound]?.renamedFrom ?? [])].some(sid => caller.tmuxName === conversationSessionName(sid, id))
  return isConversationSession(caller) ? ownSession : (!!me && bound === me)
}

/**
 * Whether `conversation` is an open conversation the caller answers: bound to its specialist (a conversation's own session:
 * its own). Never throws: an id that parses to nothing, or is not open, is not theirs. Unlike `reply`, this does not count
 * the specialist's `home_place`: a restricted session's tools are held to this.
 */
export function conversationBelongsTo(callerSessionId: string | undefined, conversation: unknown): boolean {
  try {
    const h = hydraConfig()
    const caller = callerSessionId ? registry.get(callerSessionId) : undefined
    const me = boundAs(caller, h)
    const c = parseConversation(conversation)
    const e = getConversationTable().get(c.channel, c.threadTs, appOfEntry(c))
    if (!e) return false
    const bound = e.specialist ? currentId(h, e.specialist) : undefined
    if (bound && isSessionThread(bound)) return false
    return mayAnswerConversation(h, caller, me, bound, conversationId(c))
  } catch { return false }
}

/**
 * `reply` with a conversation id as its chat_id: the specialist answers a Slack conversation. Hydra posts the text
 * as given, and only into a conversation bound to the caller's specialist (with `replyTo`, in a DM, into the thread of that message, bound to the caller): a reply goes back where its question came from. A thread
 * bound to a session's own thread is listen-only.
 */
export async function replyInConversation(callerSessionId: string | undefined, conversation: unknown, text: string, files: string[] = [], replyTo?: string): Promise<string> {
  if (files.length) throw new Error('attachments are not posted to Slack yet; reply with text (a link works)')
  if (!text.trim()) throw new Error('nothing to post: the text is empty')
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
    await postParts(speaks!, homePlaceId, undefined, text, where, true, () => homePlaceChannel(hydraConfig(), me!, speaks) === homePlaceId, bindThread)
    return unbound ? `posted to ${where}, but its thread is not bound to ${me}: ${unbound}` : `posted to ${where}; replies in its thread come back to ${me}`
  }
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const id = conversationId(c)
  const e = getConversationTable().get(c.channel, c.threadTs, app)
  if (!e) throw new Error(`${id} is not an open conversation, so there is nothing there to answer`)
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  /** Throws unless the caller answers this open conversation; returns who it is bound to, which `stillMine` holds it to before every part. */
  const mayAnswer = (entry: ConversationEntry, entryId: string): string | undefined => {
    const bound = entry.specialist ? currentId(h, entry.specialist) : undefined
    // A thread a session bound to itself is listen-only: only a specialist (or main) speaks in Slack.
    if (bound && isSessionThread(bound)) throw new Error(`${entryId} is bound to a session to listen to: hydra posts to Slack only for a specialist (or main), so reply to the operator instead`)
    if (!mayAnswerConversation(h, caller, me, bound, entryId)) throw new Error(`${entryId} is bound to ${bound ?? 'no one yet'}${me ? `, not ${me}` : ''}: a reply goes only to a conversation bound to your specialist (or its home_place)${isConversationSession(caller) ? ', and from a conversation\'s own session only to that conversation' : ''}`)
    return bound
  }
  const bound = mayAnswer(e, id)
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
      if (nested) mayAnswer(nested, conversationId({ ...c, threadTs: ts }))
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
  const { posted } = await postParts(app, c.channel, thread, text, id, false, stillMine, opened ? () => { unbound = bindOpenedThread(h, me!, c.channel, opened!, app, `reply in the thread of message ${opened}`, 'tool') } : undefined)
  const said = `posted ${posted} message${posted === 1 ? '' : 's'} to ${id}${how}`
  return opened ? (unbound ? `${said}; its thread is not bound to ${me}: ${unbound}, so replies in it go to whoever the rules name here` : `${said}; replies in it come back to ${me}`) : said
}

/**
 * A thread this session opened by answering under a message is a conversation bound to it, counted with the ones it binds by hand so a loop
 * can't fill the table. Returns why it is not bound (and alerts), or nothing.
 */
function bindOpenedThread(h: HydraConfig, me: string, channel: string, ts: string, app: string, what: string, by: 'home' | 'tool'): string | undefined {
  const w = getConversationTable()
  // A thread the person answered into while the first part was posting may already be bound by the rules: never taken from whoever holds it.
  const now = w.get(channel, ts, app)?.specialist
  if (now) return currentId(h, now) === me ? undefined : `it is already bound to ${now}`
  const held = w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(h, e.specialist) === me).length
  if (held < TOOL_BIND_MAX && w.bind(channel, ts, me, by, app)) return undefined
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
    return `${url}/archives/${c.channel}${c.threadTs === TOP_LEVEL ? '' : `/p${c.threadTs.replace('.', '')}`}`
  } catch { return undefined }
}

/** A specialist's `home_place`, when it names a Slack place: that channel's id (a `#name` resolved once names are read, through the app it speaks as). */
function homePlaceChannel(h: HydraConfig, id: string, app?: string): string | undefined {
  const home = homePlaceOf(h.specialists[id] ?? {})
  if (home?.platform !== 'slack' || home.kind !== 'channel') return undefined
  return isChannelName(home) ? offlineView(app).directory.idOf(home.ref.slice(1)) : home.ref
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
        slackRuntimeDeps.post(channel, thread, part, app),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), POST_BACKSTOP_MS) }),
      ]).finally(() => clearTimeout(timer))
    } catch (err) {
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

/** `hydra conversations bind`: the operator binds or moves a conversation to any declared specialist, main, or a session's thread (listen-only there). */
export function operatorBind(conversation: string, target: string): string {
  const h = hydraConfig()
  // The target must say its kind (a bare `ops` is an error); a binding stores the bare form.
  const ref = readTarget(target, id => Object.hasOwn(h.specialists, id))
  if (!ref.ok) throw new Error(ref.error ?? `no specialist "${ref.undeclared}" in hydra.toml (or a session's thread id)`)
  const to = bareOf(ref.ref)
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  declaredApp(h, app)
  // A specialist pinned to other apps can't be reached through this one (`main` and a session's thread are exempt).
  const apart = notServedBy(h, to, app, 'this conversation is through')
  if (apart) throw new Error(`${conversationId(c)} can't be bound to ${to}: ${apart}`)
  // A channel has no top-level conversation: every one is a thread (a DM's top level is one, and may be moved).
  if (!isDm(c.channel) && c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} names a channel, not a conversation: add the thread's ts`)
  if (ref.ref.kind === 'thread' && registry.getByThread(`${c.channel}:${c.threadTs}`)) throw new Error(`${conversationId(c)} is a hydra session's own thread: another session can't listen to it`)
  if (!getConversationTable().bind(c.channel, c.threadTs, to, 'cli', app)) throw new Error('the conversation table is full')
  return `${conversationId(c)} → ${to}`
}

export function operatorUnbind(conversation: string): string {
  const c = parseConversation(conversation)
  const owed = getConversationTable().get(c.channel, c.threadTs, appOfEntry(c))?.owed?.length ?? 0
  if (!getConversationTable().unwatch(c.channel, c.threadTs, appOfEntry(c))) return `${conversationId(c)} was not bound`
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped (and alerted)` : ''}`
}

/** The live session in a thread, by name. */
const sessionNameIn = (threadId: string): string | undefined => [...registry.values()].find(s => s.threadId === threadId && s.deadAt === undefined)?.tmuxName

const line = (v: Pick<ConversationConfig, 'hydra' | 'directory'>, e: ConversationEntry, now: number): string => {
  const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
  const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
  const via = e.via === 'user' ? ' · read as the operator' : ''
  const to = e.specialist && isSessionThread(e.specialist) ? `${sessionNameIn(e.specialist) ?? 'no session'} (listening, thread ${e.specialist})` : e.specialist
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

