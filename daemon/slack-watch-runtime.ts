import { SlackWatcher, cmpTs, slackWatchesPath, unresolvedPlaces, conversationId, placeName, isDm, TOP_LEVEL, NO_DIRECTORY, SLACK_LIMITS, type SlackWatchConfig, type SlackWatchEntry, type SlackWatchStats } from './slack-watch.js'
import { getSpecialist, conversationSpecialistOf } from './specialists.js'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { pushToolSurface } from './tool-surface.js'
import { deliverToTarget, conversationSessionName, conversationSessionRunning, placesFree, type Target } from './targets.js'
import { on } from './event-bus.js'
import { SlackListener, boltApp, POST_TIMEOUT_MS, type ListenerHealth } from './slack-listener.js'
import { SCRUBBED_ENV, STATE_DIR } from './config.js'
import { SCRUBBED_SPAWN_VARS } from '../shared/spawn-env.js'
import { join } from 'path'
import { existsSync } from 'fs'
import { safeSend } from './util.js'
import { mainChannel } from './main-session.js'
import { currentHydraConfig, onHydraConfigLoad } from './hydra-config.js'
import { MAIN, currentId } from '../routing/route.js'
import { chunk } from './util.js'
import type { HydraConfig } from '../config/types.js'

const log = (line: string) => { process.stderr.write(line) }

/** Test seams: the watcher's view of hydra.toml (the listener's, once Slack has connected), and posting to Slack. */
export const slackRuntimeDeps = {
  view: (): SlackWatchConfig | null => listener?.view() ?? null,
  /** A place freed under max: catch-up refetches what waits, the oldest waiter first. */
  wake: (): void => { void listener?.runCatchUp(false, 'a place freed') },
  post: (channel: string, threadTs: string | undefined, text: string): Promise<string> => {
    if (!listener) return Promise.reject(new Error('Slack is not connected (hydra.toml has no [connectors.slack], or its tokens are not set)'))
    return listener.post(channel, threadTs, text)
  },
}
const hydraConfig = () => currentHydraConfig()

/** What the watcher routes with: hydra.toml plus what the Slack connection learned. Null until Slack has connected. */
function config(): SlackWatchConfig | null {
  return slackRuntimeDeps.view()
}

/** Without a connection, the tools still name channels by id; `#name` places resolve once it is up. */
function offlineView(): Pick<SlackWatchConfig, 'hydra' | 'directory'> {
  return config() ?? { hydra: hydraConfig(), directory: NO_DIRECTORY }
}

const SWEEP_INTERVAL_MS = 60 * 60_000

/** The specialists that hear Slack: they listen on a Slack place, or a rule at one sends to them. */
function slackSpecialists(h: HydraConfig): string[] {
  const slack = (p: string) => p.startsWith('slack:')
  return [...new Set([
    ...Object.values(h.specialists).filter(s => s.listens.some(slack)).map(s => s.id),
    ...h.rules.filter(r => slack(r.at)).map(r => r.to),
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

/** Where a specialist's alerts are posted: main's channel for `main`, the specialist's thread otherwise. */
function alertChannel(to: string): string | undefined {
  return to === MAIN ? mainChannel() || undefined : getSpecialist(to)?.threadId
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
    config,
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

let listener: SlackListener | undefined

/**
 * A token is read only from a variable the daemon scrubs from every session it starts: a token anywhere else would
 * reach them all. Any other name is refused, with why, and the listener stays off.
 */
/** The Slack token variables the daemon scrubs from every session. */
const SLACK_TOKEN_VARS: readonly string[] = SCRUBBED_SPAWN_VARS.filter(v => v.startsWith('SLOPBOT_SLACK_'))

export function slackTokens(h: HydraConfig, env: Readonly<Record<string, string>> = SCRUBBED_ENV, warn: (line: string) => void = log): { app?: string; bot?: string } {
  const c = h.connectors.slack
  if (!c) return {}
  const read = (name: string | undefined): string | undefined => {
    if (!name) return undefined
    if (!SLACK_TOKEN_VARS.includes(name)) {
      warn(`daemon: slack listener: refusing to read the token in ${name}: only ${SLACK_TOKEN_VARS.join(' and ')} are kept from sessions, so a token in ${name} would reach every session hydra starts. Use one of those names.\n`)
      return undefined
    }
    return env[name]
  }
  return { bot: read(c.botTokenEnv), app: read(c.appTokenEnv) }
}

/**
 * Connects to Slack and begins feeding the watcher. Called once boot recovery has finished,
 * so a specialist refill never races it. The tokens come from the scrubbed environment: only this
 * module ever sees them, never a session. A no-op, with a log line, until hydra.toml has
 * [connectors.slack] and its tokens are set.
 */
let watchingConfig = false
export async function startSlackListener(): Promise<void> {
  // A [connectors.slack] added later connects as soon as hydra.toml loads it: no restart.
  if (!watchingConfig) { watchingConfig = true; onHydraConfigLoad(c => { if (!listener && c.connectors.slack) void startSlackListener() }) }
  if (listener) return
  // The old config is no longer read: left behind unmigrated, Slack would go quiet without a word.
  if (!hydraConfig().connectors.slack && existsSync(join(STATE_DIR, 'slack-watch.json'))) {
    alert('⚠️ <state>/slack-watch.json is no longer read, and hydra.toml has no [connectors.slack], so Slack is not connected. Run `hydra migrate` to carry its routes into hydra.toml (or add them by hand: [connectors.slack], and each route as a specialist\'s listens and allow); Slack connects as soon as hydra.toml loads it.')
  }
  const l = new SlackListener({
    watcher: getSlackWatcher(),
    hydra: hydraConfig,
    tokens: () => slackTokens(hydraConfig()),
    createApp: boltApp,
    log,
    alert: text => alert(text),
  })
  listener = l
  if (!await l.start()) listener = undefined
}

export function stopSlackListener(): void {
  listener?.stop()
  listener = undefined
}

let lastSpecialists: string[] = []
/** Tell each Slack specialist's session which tools it now has: a hydra.toml edit can add or remove one. */
export function refreshSlackSpecialistSurface(): void {
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
  sweepTimer = setInterval(() => { w.sweep() }, SWEEP_INTERVAL_MS)
  ;(sweepTimer as { unref?: () => void }).unref?.()
  refreshSlackSpecialistSurface()
  const offConfig = onHydraConfigLoad(() => queueMicrotask(refreshSlackSpecialistSurface))
  // A conversation session ending frees a place: the waiters are offered it at once (catch-up refetches them, oldest first).
  const freed = ({ tmuxName }: { tmuxName: string }) => {
    const to = conversationSpecialistOf(tmuxName)
    const h = hydraConfig()
    if (to && getSlackWatcher().waiters(id => currentId(h, id) === to).length) slackRuntimeDeps.wake()
  }
  // Killed, reaped, [done], or found dead by the health poll or a lost bridge: either way a place is free.
  const offDeath = on('session:death', freed, 'slack-watch: wake conversations waiting at max')
  const offDead = on('session:marked-dead', freed, 'slack-watch: wake conversations waiting at max (found dead)')
  unsubscribe = () => { offConfig(); offDeath(); offDead() }
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

const THREAD_TS = /^\d{1,12}\.\d{1,6}$/
const CONVERSATION_RE = /^slack:([CGD][A-Z0-9]+)(?::(\d{1,12}\.\d{1,6}))?$/

/** A conversation id as `hydra conversations` prints it: `slack:C0ABC:1793732224.093059`, or `slack:D0ABC` / `slack:C0ABC` for a top level. */
export function parseConversation(raw: unknown): { channel: string; threadTs: string } {
  const m = typeof raw === 'string' ? raw.trim().match(CONVERSATION_RE) : null
  if (!m) throw new Error('conversation must look like slack:C0ABC:1793732224.093059 (a thread) or slack:D0ABC (a top level), as hydra conversations prints it')
  const [, channel, ts] = m
  if (ts && !THREAD_TS.test(ts)) throw new Error('thread ts must look like 1793732224.093059')
  return { channel, threadTs: ts ?? TOP_LEVEL }
}

/** The specialist whose thread this session sits in, if it is one in hydra.toml. */
/**
 * The specialist this session acts for: it sits in the specialist's thread, or it is one of a per-conversation
 * specialist's conversation sessions (named `<id>_…`). A conversation session answers only its own conversation
 * (replyInConversation checks that), but it may post to its specialist's home and bind and unbind for it.
 */
export function specialistOf(caller: Partial<Pick<SessionInfo, 'threadId' | 'tmuxName'>> | undefined, h: HydraConfig = hydraConfig()): string | undefined {
  const own = conversationSpecialistOf(caller?.tmuxName)
  if (own) return own
  if (!caller?.threadId) return undefined
  return Object.keys(h.specialists).find(id => getSpecialist(id)?.threadId === caller.threadId)
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
 * `bind_conversation`: the session in a specialist binds a conversation to that specialist. It may bind one that is
 * unbound or already its own, at a place it hears. Moving another specialist's conversation is the operator's (`hydra conversations bind`).
 */
export function bindConversation(caller: Pick<SessionInfo, 'threadId'> | undefined, conversation: unknown): string {
  const v = offlineView()
  const me = specialistOf(caller, v.hydra)
  if (!me) throw new Error('only a session in a specialist declared in hydra.toml may bind conversations')
  const c = parseConversation(conversation)
  // A DM, or a place's top level, is routing's to hand out: a tool never takes one, least of all the operator's DM from main.
  if (isDm(c.channel) || c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} is not a thread in a channel: only a thread can be bound by hand`)
  if (!listensOn(v, me, c.channel)) throw new Error(`${me} doesn't listen on ${placeName(v, c.channel)}: it binds only threads where it listens`)
  const w = getSlackWatcher()
  const bound = w.get(c.channel, c.threadTs)?.specialist
  if (bound && currentId(v.hydra, bound) !== me) throw new Error(`${conversationId(c)} is bound to ${bound}; only the operator moves it (hydra conversations bind)`)
  if (!bound && w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(v.hydra, e.specialist) === me).length >= TOOL_BIND_MAX) {
    throw new Error(`${me} already holds ${TOOL_BIND_MAX} conversations it opened itself; unbind one first`)
  }
  if (!w.bind(c.channel, c.threadTs, me, 'tool')) throw new Error(`the conversation table is full (${SLACK_LIMITS.maxWatches}); unbind one first`)
  return `${conversationId(c)} is bound to ${me}`
}

/** `unbind_conversation`: the session in a specialist lets go of one of its own conversations. */
export function unbindConversation(caller: Pick<SessionInfo, 'threadId'> | undefined, conversation: unknown): string {
  const me = specialistOf(caller)
  if (!me) throw new Error('only a session in a specialist declared in hydra.toml may unbind conversations')
  const c = parseConversation(conversation)
  const e = getSlackWatcher().get(c.channel, c.threadTs)
  if (!e) return `${conversationId(c)} was not bound`
  if (!e.specialist || currentId(hydraConfig(), e.specialist) !== me) throw new Error(`${conversationId(c)} is bound to ${e.specialist ?? 'no one yet'}, not ${me}`)
  const owed = e.owed?.length ?? 0
  getSlackWatcher().unwatch(c.channel, c.threadTs)
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
 * as given, and only into a conversation bound to the caller's specialist: a reply goes back where its question came from.
 */
export async function replyInConversation(callerSessionId: string | undefined, conversation: unknown, text: string, files: string[] = []): Promise<string> {
  if (files.length) throw new Error('attachments are not posted to Slack yet; reply with text (a link works)')
  if (!text.trim()) throw new Error('nothing to post: the text is empty')
  const h = hydraConfig()
  const me = callerSessionId === 'main' ? MAIN : specialistOf(callerSessionId ? registry.get(callerSessionId) : undefined, h)
  // Its own `home` (a schedule's reply has no conversation): a new thread there, bound to it, so answers come back to it.
  const home = me ? homeChannel(h, me) : undefined
  if (home && (conversation === h.specialists[me!]?.home || conversation === `slack:${home}`)) {
    const where = `${me}'s home (${h.specialists[me!]!.home})`
    // Its thread is a conversation bound to it as soon as the first part lands (whatever becomes of the rest), counted
    // with the ones it binds by hand, so a loop can't fill the table. Past that, the post goes unbound, and is alerted.
    let unbound: string | undefined
    const bindThread = (ts: string) => {
      const w = getSlackWatcher()
      const held = w.list().filter(e => (e.mentionedBy === 'tool' || e.mentionedBy === 'home') && e.specialist && currentId(h, e.specialist) === me).length
      if (held < TOOL_BIND_MAX && w.bind(home, ts, me!, 'home')) return
      unbound = held >= TOOL_BIND_MAX ? `${me} already holds ${TOOL_BIND_MAX} conversations it opened itself` : 'the conversation table is full'
      alert(`⚠️ ${me}'s post to its home opened no conversation (${unbound}): replies under it go to whoever listens there, not back to ${me}.`, me)
    }
    await postParts(home, undefined, text, where, true, () => homeChannel(hydraConfig(), me!) === home, bindThread)
    return unbound ? `posted to ${where}, but its thread is not bound to ${me}: ${unbound}` : `posted to ${where}; replies in its thread come back to ${me}`
  }
  const c = parseConversation(conversation)
  const id = conversationId(c)
  const e = getSlackWatcher().get(c.channel, c.threadTs)
  if (!e) throw new Error(`${id} is not an open conversation, so there is nothing there to answer`)
  const bound = e.specialist ? currentId(h, e.specialist) : undefined
  // A per-conversation session answers its own conversation, and no other.
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  const ownSession = !!caller && !!bound && [bound, ...(h.specialists[bound]?.was ?? [])].some(sid => caller.tmuxName === conversationSessionName(sid, id))
  // A conversation's own session answers its conversation and no other; a shared session, any bound to its specialist.
  if (isConversationSession(caller) ? !ownSession : (!me || bound !== me)) throw new Error(`${id} is bound to ${bound ?? 'no one yet'}${me ? `, not ${me}` : ''}: a reply goes only to a conversation bound to your specialist (or its home)${isConversationSession(caller) ? ', and from a conversation\'s own session only to that conversation' : ''}`)
  // Checked again before every part: a conversation moved away mid-reply gets no more of it.
  const stillMine = () => { const now = getSlackWatcher().get(c.channel, c.threadTs)?.specialist; return !!now && currentId(hydraConfig(), now) === bound }
  const { posted } = await postParts(c.channel, c.threadTs === TOP_LEVEL ? undefined : c.threadTs, text, id, false, stillMine)
  return `posted ${posted} message${posted === 1 ? '' : 's'} to ${id}`
}

/** A specialist's `home`, when it names a Slack place: that channel's id (a `#name` resolved once names are read). */
function homeChannel(h: HydraConfig, id: string): string | undefined {
  const home = h.specialists[id]?.home
  if (!home?.startsWith('slack:') || home === 'slack:dm') return undefined
  const rest = home.slice('slack:'.length)
  return rest.startsWith('#') ? offlineView().directory.idOf(rest.slice(1)) : rest
}

/**
 * The text as written, split under Slack's limit, posted part by part while `allowed()` still holds. `thread` undefined:
 * the first part at the top level, and with `threadRest` the others in its thread. Posting never retries on its own, so
 * a part either landed, failed, or (past the deadline) is unknown: said as such, so a resend is the caller's choice.
 */
async function postParts(channel: string, thread: string | undefined, text: string, where: string, threadRest: boolean, allowed: () => boolean, onFirst?: (ts: string) => void): Promise<{ first: string; posted: number }> {
  const parts = chunk(text, SLACK_CHUNK, 'markdown')
  let posted = 0
  let first: string | undefined
  for (const part of parts) {
    if (!allowed()) throw new Error(`stopped after ${posted} of ${parts.length} message(s) to ${where}: it is no longer yours to answer`)
    let timer: ReturnType<typeof setTimeout> | undefined
    let ts: string
    try {
      ts = await Promise.race([
        slackRuntimeDeps.post(channel, thread, part),
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

/** `hydra conversations bind`: the operator binds or moves a conversation to any declared specialist. */
export function operatorBind(conversation: string, to: string): string {
  const h = hydraConfig()
  if (to !== MAIN && !h.specialists[to]) throw new Error(`no specialist "${to}" in hydra.toml`)
  const c = parseConversation(conversation)
  // A channel has no top-level conversation: every one is a thread (a DM's top level is one, and may be moved).
  if (!isDm(c.channel) && c.threadTs === TOP_LEVEL) throw new Error(`${conversationId(c)} names a channel, not a conversation: add the thread's ts`)
  if (!getSlackWatcher().bind(c.channel, c.threadTs, to, 'cli')) throw new Error('the conversation table is full')
  return `${conversationId(c)} → ${to}`
}

export function operatorUnbind(conversation: string): string {
  const c = parseConversation(conversation)
  const owed = getSlackWatcher().get(c.channel, c.threadTs)?.owed?.length ?? 0
  if (!getSlackWatcher().unwatch(c.channel, c.threadTs)) return `${conversationId(c)} was not bound`
  return `${conversationId(c)} is unbound${owed ? `; ${owed} message${owed === 1 ? '' : 's'} it still owed were dropped (and alerted)` : ''}`
}

const line = (v: Pick<SlackWatchConfig, 'directory'>, e: SlackWatchEntry, now: number): string => {
  const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
  const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
  return `${conversationId(e)} (${placeName(v, e.channel)}) → ${e.specialist ?? '(unbound: its next message binds it)'} · idle ${idle}h${owed}`
}

/** The operator's view: every conversation. */
export function formatConversations(now = Date.now(), only?: (e: SlackWatchEntry) => boolean): string[] {
  const v = offlineView()
  return getSlackWatcher().list().filter(e => !only || only(e)).map(e => line(v, e, now))
}

/** The conversations a session may see: those bound to the specialist it sits in. One specialist never reads another's. */
export function formatConversationsFor(caller: Pick<SessionInfo, 'threadId'>, now = Date.now()): string[] {
  const me = specialistOf(caller)
  const h = hydraConfig()
  return me ? formatConversations(now, e => !!e.specialist && currentId(h, e.specialist) === me) : []
}

/** For `hydra health` and `hydra conversations`: null when Slack isn't configured. Refusals and drops count since the daemon started. */
export function slackWatchHealth(now = Date.now()): ({ places: { place: string; to: string; note?: string }[]; conversations: number; owed: number; oldestOwedAgeMin: number | null; listener?: ListenerHealth } & SlackWatchStats) | null {
  const h = hydraConfig()
  if (!h.connectors.slack) return null
  const v = offlineView()
  const entries = getSlackWatcher().list()
  const owed = entries.flatMap(e => e.owed ?? [])
  const oldest = owed.sort(cmpTs)[0]
  const unresolved = new Set(unresolvedPlaces(v))
  const places = Object.values(h.specialists).flatMap(s => s.listens.filter(p => p.startsWith('slack:')).map(place => ({
    place, to: s.id,
    ...(unresolved.has(place) && { note: 'no channel answers to this name (not joined, renamed, or names unreadable without channels:read)' }),
  })))
  return {
    places,
    conversations: entries.length,
    owed: owed.length,
    oldestOwedAgeMin: oldest ? Math.max(0, Math.round((now / 1000 - parseFloat(oldest)) / 60)) : null,
    ...getSlackWatcher().stats(),
    ...(listener && { listener: listener.health() }),
  }
}

/** For `hydra route`: the names a place goes by, most specific first, as the watcher would see them. */
export function placeAliases(place: string): string[] {
  const v = offlineView()
  if (place.startsWith('slack:#')) {
    const id = v.directory.idOf(place.slice('slack:#'.length))
    return id ? [`slack:${id}`, place] : [place]
  }
  const m = place.match(/^slack:([CG][A-Z0-9]+)$/)
  const name = m ? v.directory.nameOf(m[1]) : undefined
  return name ? [place, `slack:#${name}`] : [place]
}

