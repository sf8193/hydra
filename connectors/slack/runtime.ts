import { SlackWatcher, cantRead, cmpTs, slackWatchesPath, unresolvedPlaces, conversationId, placeName, isDm, appOfEntry, TOP_LEVEL, NO_DIRECTORY, SLACK_LIMITS, type SlackWatchConfig, type SlackWatchEntry, type SlackWatchStats } from './watch.js'
import { parseConversation } from './conversation.js'
import { ConnectedApps, type AppIdentity } from './apps.js'
import { getSpecialist, conversationSpecialistOf, specialistOf, boundAs } from '../../specialists/specialists.js'
import { registry } from '../../daemon/sessions.js'
import type { SessionInfo } from '../../daemon/sessions.js'
import { pushToolSurface } from '../../daemon/tool-surface.js'
import { deliverToTarget, conversationSessionName, conversationSessionRunning, placesFree, type Target } from '../../specialists/targets.js'
import { on } from '../../daemon/event-bus.js'
import { SlackListener, boltApp, POST_TIMEOUT_MS, type ListenerHealth } from './listener.js'
import { STATE_DIR } from '../../daemon/config.js'
import { ENV_NAME_RE, capturedSpawnVars, scrubbedSpawnVars, tokenVarRefusal } from '../../shared/spawn-env.js'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { safeSend, atomicWriteFileSync } from '../../daemon/util.js'
import { mainChannel } from '../../daemon/main-session.js'
import { currentHydraConfig, onHydraConfigLoad } from '../../daemon/hydra-config.js'
import { MAIN, currentId, isSessionThread } from '../../routing/route.js'
import { chunk } from '../../daemon/util.js'
import { DEFAULT_SLACK_APP, slackConfigured, type HydraConfig, type SlackApp } from '../../config/types.js'
import { speaksAsOf, noSuchApp } from '../../config/pins.js'
import { notServedBy } from '../../routing/route.js'
import { NO_SLACK_APP, appKey, appSuffix, notConnected } from './app.js'
import { timed } from '../../shared/loop-watch.js'

const log = (line: string) => { process.stderr.write(line) }


/**
 * Test seams: one app's view of hydra.toml (that app's listener's, once it has connected), and posting to Slack through
 * one app. An absent `app` is `default`.
 */
export const slackRuntimeDeps = {
  view: (app: string = DEFAULT_SLACK_APP): SlackWatchConfig | null => listeners.get(app)?.view() ?? null,
  /** A place freed under max: catch-up refetches what waits, the oldest waiter first, through the apps that have waiters. */
  wake: (apps?: string[]): void => { for (const [id, l] of listeners) if (!apps || apps.includes(id)) void l.runCatchUp(false, 'a place freed') },
  post: (channel: string, threadTs: string | undefined, text: string, app: string = DEFAULT_SLACK_APP): Promise<string> => {
    const l = listeners.get(app)
    if (!l) return Promise.reject(new Error(notConnected(app, Object.keys(hydraConfig().slackApps).length)))
    return l.post(channel, threadTs, text)
  },
  /** How long a listening session's thread may stand empty (a handoff, a respawn) before its threads are let go. */
  releaseGraceMs: 60_000,
  /**
   * Who can read a thread now, through one app: its bot, the operator's user token, or (null) nobody can be asked because
   * that app isn't connected. Throws Slack's refusal when neither token can read it.
   */
  readThread: async (channel: string, threadTs: string, app: string = DEFAULT_SLACK_APP): Promise<'bot' | 'user' | null> => {
    const api = listeners.get(app)?.api
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
function config(app?: string): SlackWatchConfig | null {
  return slackRuntimeDeps.view(app)
}

/** Without a connection, the tools still name channels by id; `#name` places resolve once the app is up. */
function offlineView(app?: string): Pick<SlackWatchConfig, 'hydra' | 'directory'> {
  return config(app) ?? { hydra: hydraConfig(), directory: NO_DIRECTORY }
}

const SWEEP_INTERVAL_MS = 60 * 60_000

/** The specialists that hear Slack: they listen on a Slack place, or a rule at one sends to them. */
function slackSpecialists(h: HydraConfig): string[] {
  const slack = (p: string) => p.startsWith('slack:')
  return [...new Set([
    ...Object.values(h.specialists).filter(s => s.listens.some(slack)).map(s => s.id),
    ...h.rules.filter(r => r.at === undefined || slack(r.at)).map(r => r.to),   // a rule with only an app is a Slack rule
  ])]
}

/**
 * A plain message (not a session turn) to the thread of the specialist it concerns. With none named (listener
 * trouble concerns everyone), each specialist that hears Slack hears it once, and main's channel when nothing does.
 */
function alert(text: string, to?: string): void {
  // A specialist with nowhere to post (removed from hydra.toml, or no thread yet) does not swallow it: everyone hears it.
  const targets = to && alertChannel(to) ? [to] : slackSpecialists(hydraConfig())
  let sent = false
  for (const t of targets.length ? targets : [MAIN]) {
    const where = alertChannel(t)
    if (where) { void safeSend(where, text).catch(() => {}); sent = true }
  }
  if (!sent) log(`daemon: slack alert with no specialist thread to send it to: ${text}\n`)
}

/** Where a binding's alerts are posted: main's channel for `main`, a session's own thread, else the specialist's thread. */
function alertChannel(to: string): string | undefined {
  return to === MAIN ? mainChannel() || undefined : isSessionThread(to) ? to : getSpecialist(to)?.threadId
}

let watcher: SlackWatcher | undefined
let sweepTimer: ReturnType<typeof setInterval> | undefined

/**
 * The daemon's one watcher, wired to the state dir and to specialist delivery.
 * Built on first use, not at import. A "duplicate" answer from the specialist means
 * the daemon already delivered this key: that counts as delivered.
 */
export function getSlackWatcher(): SlackWatcher {
  return watcher ??= new SlackWatcher({
    now: Date.now,
    file: slackWatchesPath(),
    filesDir: join(STATE_DIR, 'slack-files'),
    log,
    config: app => config(app),
    alert,
    deliver: async (target, message, idempotencyKey) => {
      const t = targetFor(target.to, target.conversation)
      // First come, first served, when places are short: a newer conversation without a session takes a place only if
      // one is left over after every older waiter has had theirs.
      if ('perConversation' in t && !conversationSessionRunning(t.perConversation, t.conversation)) {
        const h = hydraConfig()
        const waiters = getSlackWatcher().waiters(id => currentId(h, id) === t.perConversation)
        const ahead = waiters.findIndex(e => conversationId(e) === t.conversation)
        const before = ahead === -1 ? waiters.length : ahead
        if (before > 0 && placesFree(t.perConversation) <= before) return { ok: false, error: `${t.perConversation} is at max with ${before} conversation${before === 1 ? '' : 's'} waiting ahead of ${t.conversation}`, wait: true }
      }
      const r = await deliverToTarget(t, message, { initiator: 'slack-watch', idempotencyKey, source: 'slack-watch' })
      if (!r.ok && r.atMax) return { ok: false, error: r.reason, wait: true }
      if (r.ok) return { ok: true, ...(r.duplicate && { duplicate: true }) }
      return { ok: false, error: r.reason, exit: r.exit, ...(r.permanent && { permanent: true }) }
    },
  })
}

/** A per-conversation specialist gives the conversation its own session (targets.ts counts `max`); any other is one target. */
export function targetFor(to: string, conversation: string | undefined): Target {
  const s = hydraConfig().specialists[to]
  return s?.sessions === 'per-conversation' && conversation ? { perConversation: to, conversation } : { to }
}

/** One listener per app hydra.toml declares and has tokens for, by app id. */
const listeners = new Map<string, SlackListener>()
/** Where each app's bot ids are kept, so a restart still recognises a tag of an app that has not joined yet. Absent: nothing is known. */
const identitiesPath = () => join(STATE_DIR, 'slack-apps.json')
function savedIdentities(): Record<string, AppIdentity> {
  try { return existsSync(identitiesPath()) ? JSON.parse(readFileSync(identitiesPath(), 'utf8')) as Record<string, AppIdentity> : {} } catch { return {} }
}
const newSharedApps = () => {
  const apps = new ConnectedApps({
    alert: text => alert(text), log,
    persist: ids => { try { atomicWriteFileSync(identitiesPath(), JSON.stringify(ids, null, 2) + '\n') } catch (err) { log(`daemon: slack apps: saving bot ids failed: ${err}\n`) } },
  })
  apps.seedIdentities(savedIdentities())
  return apps
}
/** What the listeners share: every app's bot ids, and which apps are in which channel. */
let sharedApps = newSharedApps()

/**
 * One app's tokens, each read from the variable the app names for it. A token is read only from a variable the daemon
 * keeps from every session it starts: a token anywhere else would reach them all. hydra.toml's loader rejects a name
 * that is not one, and the daemon adds the ones it names to those; a name still not kept is refused here, saying which
 * key and why, and the listener stays off.
 */
export function slackTokens(app: SlackApp, env: Readonly<Record<string, string>> = capturedSpawnVars(), warn: (line: string) => void = log): { app?: string; bot?: string; user?: string } {
  const read = (key: 'bot_token_env' | 'app_token_env' | 'user_token_env', name: string | undefined): string | undefined => {
    if (!name) return undefined
    if (!scrubbedSpawnVars().includes(name)) {
      const why = !ENV_NAME_RE.test(name) ? 'is not an environment variable name' : tokenVarRefusal(name) ?? 'is not among the variables kept from sessions (the daemon adds the ones hydra.toml names when it loads it)'
      warn(`daemon: slack listener: refusing to read the token in ${name}, the \`${key}\` of the app named \`${app.id}\`: it ${why}, so a token there would reach every session hydra starts. Name a variable only the daemon needs, like SLACK_BOT_TOKEN.\n`)
      return undefined
    }
    return env[name]
  }
  const user = read('user_token_env', app.userTokenEnv)
  return { bot: read('bot_token_env', app.botTokenEnv), app: read('app_token_env', app.appTokenEnv), ...(user && { user }) }
}

/** Why an app can't connect for want of tokens, naming the key to fix; undefined when it has both. */
function missingTokens(app: SlackApp, t: { app?: string; bot?: string }): string | undefined {
  if (!t.bot) return `${appKey(app.id, 'bot_token_env')} names ${app.botTokenEnv}, which has no value in the daemon's environment`
  if (!app.appTokenEnv) return `${appKey(app.id, 'app_token_env')} is not set, and Socket Mode needs it`
  if (!t.app) return `${appKey(app.id, 'app_token_env')} names ${app.appTokenEnv}, which has no value in the daemon's environment`
  return undefined
}

let watchingConfig = false
/** What each skipped app was last told, so a config reload does not say it again. */
const skipped = new Map<string, string>()
let reconciling: Promise<void> = Promise.resolve()

/**
 * Connects to Slack, one connection per app hydra.toml declares, and begins feeding the watcher. Called once boot recovery
 * has finished, so a specialist refill never races it. The tokens come from the scrubbed environment: only this module ever
 * sees them, never a session. An app with no tokens is skipped, and said so by name; the others connect. It runs again on every
 * hydra.toml load: an app added there connects, one taken out disconnects, with no restart.
 */
export function startSlackListener(): Promise<void> {
  if (!watchingConfig) { watchingConfig = true; onHydraConfigLoad(() => { void startSlackListener().catch(err => log(`daemon: slack listeners: ${err instanceof Error ? err.stack ?? err.message : err}\n`)) }) }
  // One pass at a time: two overlapping would both start the app they find missing.
  const run = reconciling.then(connectApps)
  reconciling = run.catch(() => {})
  return run
}

async function connectApps(): Promise<void> {
  const h = hydraConfig()
  for (const [id, l] of listeners) if (!Object.hasOwn(h.slackApps, id)) { l.stop(); listeners.delete(id); skipped.delete(id) }
  for (const id of [...skipped.keys()]) if (!Object.hasOwn(h.slackApps, id)) skipped.delete(id)
  // The old config is no longer read: left behind unmigrated, Slack would go quiet without a word.
  if (!slackConfigured(h) && existsSync(join(STATE_DIR, 'slack-watch.json'))) {
    alert('⚠️ <state>/slack-watch.json is no longer read, and hydra.toml declares no Slack app, so Slack is not connected. Run `hydra migrate` to carry its routes into hydra.toml; Slack connects as soon as hydra.toml loads it.')
  }
  const starting: Promise<void>[] = []
  const fresh = Object.values(h.slackApps).filter(a => !listeners.has(a.id) && !missingTokens(a, slackTokens(a))).map(a => a.id)
  sharedApps.expectJoin(fresh)   // who is in a channel is not settled until each has joined, failed to, or taken too long
  for (const app of Object.values(h.slackApps)) {
    if (listeners.has(app.id)) continue
    const why = missingTokens(app, slackTokens(app))
    if (why) {
      log(`daemon: slack listener for the app named ${app.id} off (${why})\n`)
      if (skipped.get(app.id) !== why) { skipped.set(app.id, why); alert(`⚠️ ${notConnected(app.id, Object.keys(h.slackApps).length)}: ${why}. Put the token in that variable (in \`.env\`) and restart the daemon.`) }
      continue
    }
    skipped.delete(app.id)
    const l = new SlackListener({
      app: app.id,
      apps: sharedApps,
      watcher: getSlackWatcher(),
      hydra: hydraConfig,
      tokens: slackTokens,
      createApp: boltApp,
      log,
      alert: text => alert(text),
    })
    listeners.set(app.id, l)
    // Connected side by side: one app's slow or refused connection does not hold another's.
    const drop = () => { sharedApps.failedToJoin(app.id); if (listeners.get(app.id) === l) listeners.delete(app.id) }
    starting.push(l.start().then(ok => { if (!ok) drop() }).catch(err => { log(`daemon: slack listener${appSuffix(app.id, Object.keys(h.slackApps).length)} failed to start: ${err instanceof Error ? err.stack ?? err.message : err}\n`); drop() }))
  }
  await Promise.all(starting)
}

export function stopSlackListener(): void {
  for (const l of listeners.values()) l.stop()
  listeners.clear()
  skipped.clear()
  reconciling = Promise.resolve()
  sharedApps = newSharedApps()
}

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
  const now = slackSpecialists(hydraConfig())
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
export function startSlackWatch(): void {
  if (sweepTimer) return
  const w = getSlackWatcher()
  w.sweep()
  sweepTimer = setInterval(() => timed('slack-watch-sweep', () => { w.sweep() }), SWEEP_INTERVAL_MS)
  ;(sweepTimer as { unref?: () => void }).unref?.()
  refreshSlackSpecialistSurface()
  const offConfig = onHydraConfigLoad(() => queueMicrotask(refreshSlackSpecialistSurface))
  // A conversation session ending frees a place: the waiters are offered it at once (catch-up refetches them, oldest first).
  const freed = ({ tmuxName }: { tmuxName: string }) => {
    const to = conversationSpecialistOf(tmuxName)
    const h = hydraConfig()
    const waiting = to ? getSlackWatcher().waiters(id => currentId(h, id) === to) : []
    if (waiting.length) slackRuntimeDeps.wake([...new Set(waiting.map(appOfEntry))])
  }
  // A session that listened ends (killed, reaped, or found dead) and nobody is home in its thread within the grace (a
  // handoff successor or a respawn would be): its threads are let go, said once there, not owed to a thread nobody answers.
  const offRelease = on('session:death', ({ threadId }) => releaseIfVacant(threadId), 'slack-watch: let go of the threads a session listened to')
  const offReleaseDead = on('session:marked-dead', ({ sessionId }) => releaseIfVacant(registry.get(sessionId)?.threadId), 'slack-watch: let go of the threads a session listened to (found dead)')
  // A timer pending at the last shutdown is gone: every listened thread is checked once at boot.
  for (const t of new Set(getSlackWatcher().list().map(e => e.specialist).filter((id): id is string => !!id && isSessionThread(id)))) releaseIfVacant(t)
  const offDeath = on('session:death', freed, 'slack-watch: wake conversations waiting at max')
  const offDead = on('session:marked-dead', freed, 'slack-watch: wake conversations waiting at max (found dead)')
  // After a sleep the socket is likely dead and Slack replays nothing: replace it and catch up now, not when a timer notices.
  const offResumed = on('clock:resumed', () => { for (const l of listeners.values()) l.onResume() }, 'slack listener: replace the socket and catch up after a resume')
  unsubscribe = () => { offConfig(); offRelease(); offReleaseDead(); offDeath(); offDead(); offResumed() }
}

/** Whether a live session is home in this thread. A reaped session's kept record (deadAt) is nobody. */
const homeIn = (threadId: string): boolean => [...registry.values()].some(s => s.threadId === threadId && s.deadAt === undefined)

/** After the grace, let go of a vacant session thread's conversations, said once in that thread. */
function releaseIfVacant(threadId: string | undefined): void {
  if (!threadId || !isSessionThread(threadId) || !getSlackWatcher().list().some(e => e.specialist === threadId)) return
  const t = setTimeout(() => {
    if (homeIn(threadId)) return
    const gone = getSlackWatcher().list().filter(e => e.specialist === threadId)
    for (const e of gone) getSlackWatcher().unwatch(e.channel, e.threadTs, e.app)
    if (gone.length) alert(`ℹ️ The session here ended, so it stopped listening to ${gone.map(conversationId).join(', ')}.`, threadId)
  }, slackRuntimeDeps.releaseGraceMs)
  ;(t as { unref?: () => void }).unref?.()
}

/**
 * Shutdown: stop the clock and write the store. Nothing is delivered on the way out
 * (that could spawn a session mid-teardown): what is waiting was already persisted as
 * owed, and the catch-up pass delivers it after the restart.
 */
export function stopSlackWatch(): void {
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

/** Whether `to` listens on this channel. A rule there doesn't count: it takes chosen people's messages, not the place. */
function listensOn(v: Pick<SlackWatchConfig, 'hydra' | 'directory'>, to: string, channel: string): boolean {
  const s = v.hydra.specialists[to]
  const name = v.directory.nameOf(channel)
  return !!s && [`slack:${channel}`, ...(name ? [`slack:#${name}`] : [])].some(p => s.listens.includes(p))
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
  // A specialist pinned to other apps can't be reached through this one: its answers would never be heard.
  const apart = notServedBy(v.hydra, me, app, 'this conversation is through')
  if (apart) throw new Error(`not bound: ${conversationId(c)}: ${apart}`)
  if (!isSessionThread(me) && !listensOn(v, me, c.channel)) throw new Error(`${me} doesn't listen on ${placeName(v, c.channel)}: it binds only threads where it listens`)
  // Asked of Slack, not assumed: a bind nobody can read would say "listening" and deliver nothing.
  const via = await slackRuntimeDeps.readThread(c.channel, c.threadTs, app).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`not bound: ${conversationId(c)}: ${cantRead(v.hydra.slackApps[app], placeName(v, c.channel), why, config(app)?.botUserId)}`)
  })
  // A specialist answers in its threads: one only the operator can read is one it could never post in.
  if (via === 'user' && !isSessionThread(me)) throw new Error(`not bound: ${conversationId(c)}: the bot isn't in ${placeName(v, c.channel)}, so ${me} could not answer there. Ask the operator to invite it, then bind again`)
  // From here to the bind nothing waits: the table checks and the bind can't interleave with another call.
  const w = getSlackWatcher()
  const bound = w.get(c.channel, c.threadTs, app)?.specialist
  // A specialist answers where it listens: a session only listening there gives the thread way, and is told.
  const takeover = !!bound && isSessionThread(bound) && !isSessionThread(me)
  if (bound && currentId(v.hydra, bound) !== me && !takeover) throw new Error(`${conversationId(c)} is bound to ${bound}; only the operator moves it (hydra conversations bind)`)
  if (!bound && w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(v.hydra, e.specialist) === me).length >= TOOL_BIND_MAX) {
    throw new Error(`${me} already holds ${TOOL_BIND_MAX} conversations it opened itself; unbind one first`)
  }
  if (!w.bind(c.channel, c.threadTs, me, 'tool', app)) throw new Error(`the conversation table is full (${SLACK_LIMITS.maxWatches}); unbind one first`)
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
  const e = getSlackWatcher().get(c.channel, c.threadTs, appOfEntry(c))
  if (!e) return `${conversationId(c)} was not bound`
  if (!e.specialist || currentId(hydraConfig(), e.specialist) !== me) throw new Error(`${conversationId(c)} is bound to ${e.specialist ?? 'no one yet'}, not ${me}`)
  const owed = e.owed?.length ?? 0
  getSlackWatcher().unwatch(c.channel, c.threadTs, appOfEntry(c))
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped (and alerted)` : ''}`
}

/** Slack's own advice is to keep a message under 4,000 characters; longer ones are split. */
const SLACK_CHUNK = 3900
/** Errors that say a post did not happen: a platform refusal (`An API error occurred: …`), a rate limit, no connection. */
const CLEANLY_REFUSED = /An API error occurred|rate.?limit|not connected/i
/** A backstop past the posting client's own deadline (it neither retries nor waits longer). */
const POST_BACKSTOP_MS = POST_TIMEOUT_MS + 5_000

/**
 * `reply` with a conversation id as its chat_id: the specialist answers a Slack conversation. Hydra posts the text
 * as given, and only into a conversation bound to the caller's specialist: a reply goes back where its question came from. A thread
 * bound to a session's own thread is listen-only.
 */
export async function replyInConversation(callerSessionId: string | undefined, conversation: unknown, text: string, files: string[] = []): Promise<string> {
  if (files.length) throw new Error('attachments are not posted to Slack yet; reply with text (a link works)')
  if (!text.trim()) throw new Error('nothing to post: the text is empty')
  const h = hydraConfig()
  const me = callerSessionId === 'main' ? MAIN : boundAs(callerSessionId ? registry.get(callerSessionId) : undefined, h)
  // Its own `home` (a schedule's reply has no conversation): a new thread there, bound to it, so answers come back to it.
  // The app it posts as with no message to answer: hydra.toml's loader has checked it is declared and can reach the specialist.
  const spec = me ? h.specialists[me] : undefined
  const speaks = spec ? speaksAsOf(spec, Object.keys(h.slackApps)) : undefined
  const home = me ? homeChannel(h, me, speaks) : undefined
  if (home && (conversation === h.specialists[me!]?.home || conversation === `slack:${home}` || conversation === conversationId({ app: speaks, channel: home, threadTs: TOP_LEVEL }))) {
    if (!speaks) throw new Error(`${me} has no Slack app to post as: set \`speaks_as\` in [specialists.${me}]`)
    declaredApp(h, speaks)
    const where = `${me}'s home (${h.specialists[me!]!.home})`
    // Its thread is a conversation bound to it as soon as the first part lands (whatever becomes of the rest), counted
    // with the ones it binds by hand, so a loop can't fill the table. Past that, the post goes unbound, and is alerted.
    let unbound: string | undefined
    const bindThread = (ts: string) => {
      const w = getSlackWatcher()
      const held = w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(h, e.specialist) === me).length
      if (held < TOOL_BIND_MAX && w.bind(home, ts, me!, 'home', speaks)) return
      unbound = held >= TOOL_BIND_MAX ? `${me} already holds ${TOOL_BIND_MAX} conversations it opened itself` : 'the conversation table is full'
      alert(`⚠️ ${me}'s post to its home opened no conversation (${unbound}): replies under it go to whoever listens there, not back to ${me}.`, me)
    }
    await postParts(speaks!, home, undefined, text, where, true, () => homeChannel(hydraConfig(), me!, speaks) === home, bindThread)
    return unbound ? `posted to ${where}, but its thread is not bound to ${me}: ${unbound}` : `posted to ${where}; replies in its thread come back to ${me}`
  }
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const id = conversationId(c)
  const e = getSlackWatcher().get(c.channel, c.threadTs, app)
  if (!e) throw new Error(`${id} is not an open conversation, so there is nothing there to answer`)
  const bound = e.specialist ? currentId(h, e.specialist) : undefined
  // A thread a session bound to itself is listen-only: only a specialist (or main) speaks in Slack.
  if (bound && isSessionThread(bound)) throw new Error(`${id} is bound to a session to listen to: hydra posts to Slack only for a specialist (or main), so reply to the operator instead`)
  // A per-conversation session answers its own conversation, and no other.
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  const ownSession = !!caller && !!bound && [bound, ...(h.specialists[bound]?.was ?? [])].some(sid => caller.tmuxName === conversationSessionName(sid, id))
  // A conversation's own session answers its conversation and no other; a shared session, any bound to its specialist.
  if (isConversationSession(caller) ? !ownSession : (!me || bound !== me)) throw new Error(`${id} is bound to ${bound ?? 'no one yet'}${me ? `, not ${me}` : ''}: a reply goes only to a conversation bound to your specialist (or its home)${isConversationSession(caller) ? ', and from a conversation\'s own session only to that conversation' : ''}`)
  // Checked again before every part: a conversation moved away mid-reply gets no more of it.
  const stillMine = () => { const now = getSlackWatcher().get(c.channel, c.threadTs, app)?.specialist; return !!now && currentId(hydraConfig(), now) === bound }
  // Through the app that heard the conversation, and no other.
  const { posted } = await postParts(app, c.channel, c.threadTs === TOP_LEVEL ? undefined : c.threadTs, text, id, false, stillMine)
  return `posted ${posted} message${posted === 1 ? '' : 's'} to ${id}`
}

/** A specialist's `home`, when it names a Slack place: that channel's id (a `#name` resolved once names are read, through the app it speaks as). */
function homeChannel(h: HydraConfig, id: string, app?: string): string | undefined {
  const home = h.specialists[id]?.home
  if (!home?.startsWith('slack:') || home === 'slack:dm') return undefined
  const rest = home.slice('slack:'.length)
  return rest.startsWith('#') ? offlineView(app).directory.idOf(rest.slice(1)) : rest
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
export function operatorBind(conversation: string, to: string): string {
  const h = hydraConfig()
  if (to !== MAIN && !h.specialists[to] && !isSessionThread(to)) throw new Error(`no specialist "${to}" in hydra.toml (or a session's thread id)`)
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  declaredApp(h, app)
  // A specialist pinned to other apps can't be reached through this one (`main` and a session's thread are exempt).
  const apart = notServedBy(h, to, app, 'this conversation is through')
  if (apart) throw new Error(`${conversationId(c)} can't be bound to ${to}: ${apart}`)
  // A channel has no top-level conversation: every one is a thread (a DM's top level is one, and may be moved).
  if (!isDm(c.channel) && c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} names a channel, not a conversation: add the thread's ts`)
  if (!getSlackWatcher().bind(c.channel, c.threadTs, to, 'cli', app)) throw new Error('the conversation table is full')
  return `${conversationId(c)} → ${to}`
}

export function operatorUnbind(conversation: string): string {
  const c = parseConversation(conversation)
  const owed = getSlackWatcher().get(c.channel, c.threadTs, appOfEntry(c))?.owed?.length ?? 0
  if (!getSlackWatcher().unwatch(c.channel, c.threadTs, appOfEntry(c))) return `${conversationId(c)} was not bound`
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped (and alerted)` : ''}`
}

/** The live session in a thread, by name. */
const sessionNameIn = (threadId: string): string | undefined => [...registry.values()].find(s => s.threadId === threadId && s.deadAt === undefined)?.tmuxName

const line = (v: Pick<SlackWatchConfig, 'directory'>, e: SlackWatchEntry, now: number): string => {
  const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
  const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
  const via = e.via === 'user' ? ' · read as the operator' : ''
  const to = e.specialist && isSessionThread(e.specialist) ? `${sessionNameIn(e.specialist) ?? 'no session'} (listening, thread ${e.specialist})` : e.specialist
  return `${conversationId(e)} (${placeName(v, e.channel)}) → ${to ?? '(unbound: its next message binds it)'} · idle ${idle}h${owed}${via}`
}

/** The operator's view: every conversation. */
export function formatConversations(now = Date.now(), only?: (e: SlackWatchEntry) => boolean): string[] {
  return getSlackWatcher().list().filter(e => !only || only(e)).map(e => line(offlineView(appOfEntry(e)), e, now))
}

/** The conversations a session may see: those bound to it (boundAs). One session never reads another's. */
export function formatConversationsFor(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName' | 'sessionType'>>, now = Date.now()): string[] {
  const me = boundAs(caller)
  const h = hydraConfig()
  return me ? formatConversations(now, e => !!e.specialist && currentId(h, e.specialist) === me) : []
}

/** For `hydra health` and `hydra conversations`: null when Slack isn't configured. Refusals and drops count since the daemon started. */
export function slackWatchHealth(now = Date.now()): ({ places: { place: string; to: string; note?: string }[]; conversations: number; readAsOperator: number; owed: number; oldestOwedAgeMin: number | null; listener?: ListenerHealth; apps?: Record<string, ListenerHealth> } & SlackWatchStats) | null {
  const h = hydraConfig()
  if (!slackConfigured(h)) return null
  const entries = getSlackWatcher().list()
  const owed = entries.flatMap(e => e.owed ?? [])
  const oldest = owed.sort(cmpTs)[0]
  // A name no connected app can resolve: each app reads its own workspace's channel names.
  const views = [...listeners.keys()].map(a => offlineView(a))
  const unresolved = new Set((views.length ? views : [offlineView()]).map(v => unresolvedPlaces(v)).reduce((a, b) => a.filter(p => b.includes(p))))
  const places = Object.values(h.specialists).flatMap(s => s.listens.filter(p => p.startsWith('slack:')).map(place => ({
    place, to: s.id,
    ...(unresolved.has(place) && { note: 'no channel answers to this name (not joined, renamed, or names unreadable without channels:read)' }),
  })))
  return {
    places,
    conversations: entries.length,
    readAsOperator: entries.filter(e => e.via === 'user').length,
    owed: owed.length,
    oldestOwedAgeMin: oldest ? Math.max(0, Math.round((now / 1000 - parseFloat(oldest)) / 60)) : null,
    ...getSlackWatcher().stats(),
    // `apps` has every connected app's health by id; `listener` is the same fact for the app `default` (else the first connected), kept as an alias.
    ...(listeners.size && { listener: (listeners.get(DEFAULT_SLACK_APP) ?? [...listeners.values()][0]).health() }),
    ...(listeners.size && { apps: Object.fromEntries([...listeners].map(([id, l]) => [id, l.health()])) }),
  }
}

/** For `hydra route`: the names a place goes by, most specific first, as the watcher would see them. */
export function placeAliases(place: string, app?: string): string[] {
  const v = offlineView(app)
  if (place.startsWith('slack:#')) {
    const id = v.directory.idOf(place.slice('slack:#'.length))
    return id ? [`slack:${id}`, place] : [place]
  }
  const m = place.match(/^slack:([CG][A-Z0-9]+)$/)
  const name = m ? v.directory.nameOf(m[1]) : undefined
  return name ? [place, `slack:#${name}`] : [place]
}

