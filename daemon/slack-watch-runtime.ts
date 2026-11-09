import { SlackWatcher, currentSlackWatchConfig, cmpTs, slackWatchesPath, routeFor, routedChannels, routeTargets, type SlackWatchConfig, type SlackWatchStats, type Target } from './slack-watch.js'
import { deliverToSpecialist } from './specialist-deliver.js'
import { getSpecialist } from './specialists.js'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { pushToolSurface } from './tool-surface.js'
import { SlackListener, boltApp, type ListenerHealth } from './slack-listener.js'
import { SCRUBBED_ENV } from './config.js'
import { safeSend } from './util.js'
import { mainChannel } from './main-session.js'
import { transport } from './bridge-transport.js'

const log = (line: string) => { process.stderr.write(line) }
const readConfig = currentSlackWatchConfig
let lastConfig: SlackWatchConfig | null | undefined
let lastTargets: string[] = []
/** The current config. A changed file re-pushes tool lists, so a re-route moves the watch tools with it. */
function config(): SlackWatchConfig | null {
  const cfg = readConfig()
  if (cfg !== lastConfig) {
    const first = lastConfig === undefined
    lastConfig = cfg
    if (!first) queueMicrotask(refreshSlackSpecialistSurface)
  }
  return cfg
}

const SWEEP_INTERVAL_MS = 60 * 60_000

/**
 * A plain message (not a session turn) to the thread of the specialist a channel routes to, from the current config:
 * the same lookup delivery uses. With no channel (listener trouble concerns every route), each target hears it once.
 */
function alert(text: string, channel?: string): void {
  const cfg = config()
  const route = channel ? routeFor(cfg, channel) : undefined
  const targets = route ? [route.to] : routeTargets(cfg)
  let sent = false
  for (const to of targets) {
    const where = alertChannel(to)
    if (where) { void safeSend(where, text).catch(() => {}); sent = true }
  }
  if (!sent) log(`daemon: slack alert with no specialist thread to send it to: ${text}\n`)
}

/** Where a target's alerts are posted: main's channel for `main`, the specialist's thread otherwise. */
function alertChannel(to: string): string | undefined {
  return to === 'main' ? mainChannel() || undefined : getSpecialist(to)?.threadId
}

// -- delivery: the brief's Target contract ------------------------------------------

type DeliverOutcome =
  | { ok: true; sessionName: string; threadId: string; revived: boolean }
  // exit 2: already delivered with this key. 8: no such specialist. `permanent`: this message can never be delivered.
  | { ok: false; exit: number; reason: string; permanent?: true }

/**
 * Until daemon/targets.ts lands (lane A), the brief's deliverToTarget served by today's deliverToSpecialist.
 * Then this function goes and its callers import the real one.
 */
async function deliverToTarget(t: Target, text: string, opts: { initiator: string; idempotencyKey?: string }): Promise<DeliverOutcome> {
  if (t.to === 'main') {
    // main has no registry record; it is reached by its bridge id. Its queue does not survive a restart, so an unconnected main stays owed.
    if (!transport.has('main')) return { ok: false, exit: 4, reason: 'main is not connected' }
    transport.sendOrQueue('main', { type: 'notification', content: text, meta: { source: 'slack-watch', initiator: opts.initiator } })
    return { ok: true, sessionName: 'main', threadId: '', revived: false }
  }
  if (!getSpecialist(t.to)) return { ok: false, exit: 8, reason: `no such specialist: ${t.to}` }
  const r = await deliverToSpecialist({ specialist: t.to, message: text, initiator: opts.initiator, idempotencyKey: opts.idempotencyKey, source: 'slack-watch' })
  if (r.ok) { const d = r.data as { sessionName: string; threadId: string; spawned: boolean }; return { ok: true, sessionName: d.sessionName, threadId: d.threadId, revived: d.spawned } }
  return { ok: false, exit: r.exitCode ?? 3, reason: r.error, ...(r.permanent && { permanent: true as const }) }
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
    log,
    config,
    alert,
    deliver: async (target, message, idempotencyKey) => {
      const r = await deliverToTarget(target, message, { initiator: 'slack-watch', idempotencyKey })
      if (r.ok) return { ok: true }
      if (r.exit === 2) return { ok: true, duplicate: true }
      return { ok: false, error: r.reason, exit: r.exit, ...(r.permanent && { permanent: true }) }
    },
  })
}

let listener: SlackListener | undefined

/**
 * Connects to Slack and begins feeding the watcher. Called once boot recovery has finished,
 * so a specialist refill never races it. The tokens come from the scrubbed environment: only this
 * module ever sees them, never a session. A no-op, with a log line, until both are set and
 * slack-watch.json is valid.
 */
export async function startSlackListener(): Promise<void> {
  if (listener) return
  const l = new SlackListener({
    watcher: getSlackWatcher(),
    config,
    tokens: () => ({ app: SCRUBBED_ENV.SLOPBOT_SLACK_APP_TOKEN, bot: SCRUBBED_ENV.SLOPBOT_SLACK_BOT_TOKEN }),
    createApp: boltApp,
    log,
    alert: text => alert(text),
  })
  if (await l.start()) listener = l
}

export function stopSlackListener(): void {
  listener?.stop()
  listener = undefined
}

/** Tell each route target's session which tools it now has (a session gets the watch tools only while it sits in a route's specialist). */
export function refreshSlackSpecialistSurface(): void {
  const targets = routeTargets(config())
  // Targets a route just dropped lose the tools too.
  const all = [...new Set([...targets, ...lastTargets])]
  lastTargets = targets
  for (const to of all) {
    const thread = getSpecialist(to)?.threadId
    const id = thread ? registry.getByThread(thread) : undefined
    if (id) pushToolSurface(id)
  }
}

/**
 * Starts the watch's own clock: the idle sweep. Called at boot next to `startPrWatcher()`,
 * which owns the same kind of timer for PR watches. A no-op until slack-watch.json exists.
 */
export function startSlackWatch(): void {
  if (sweepTimer) return
  const w = getSlackWatcher()
  w.sweep()
  sweepTimer = setInterval(() => { w.sweep() }, SWEEP_INTERVAL_MS)
  ;(sweepTimer as { unref?: () => void }).unref?.()
  refreshSlackSpecialistSurface()
}

/**
 * Shutdown: stop the clock and write the store. Nothing is delivered on the way out
 * (that could spawn a session mid-teardown): what is waiting was already persisted as
 * owed, and the catch-up pass delivers it after the restart.
 */
export function stopSlackWatch(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined }
  stopSlackListener()
  watcher?.close()
}

// -- what the bridge tools and the CLI do ----------------------------------------

const THREAD_TS = /^\d{1,12}\.\d{1,6}$/

function requireConfig(): SlackWatchConfig {
  const cfg = config()
  if (!cfg) throw new Error('Slack watching is not configured: <state>/slack-watch.json is missing or invalid')
  return cfg
}

function checkThread(cfg: SlackWatchConfig, channel: unknown, threadTs: unknown): { channel: string; threadTs: string } {
  const channels = routedChannels(cfg)
  if (typeof channel !== 'string' || !channels.includes(channel)) throw new Error(`channel must be one of: ${channels.join(', ')}`)
  if (typeof threadTs !== 'string' || !THREAD_TS.test(threadTs)) throw new Error('thread_ts must look like 1793732224.093059')
  return { channel, threadTs }
}

/**
 * The watch tools steer a channel's threads, so only the session in the specialist that channel routes to may call them.
 * The capability (tool-surface.ts) hides them from everyone outside a route's specialist; this enforces it per channel.
 */
function requireRouteOccupant(caller: Pick<SessionInfo, 'threadId'> | undefined, channel: unknown, threadTs: unknown, what: string): { channel: string; threadTs: string } {
  const cfg = requireConfig()
  const t = checkThread(cfg, channel, threadTs)
  const to = routeFor(cfg, t.channel)!.to
  const thread = getSpecialist(to)?.threadId
  if (!caller || !thread || caller.threadId !== thread) throw new Error(`only the session in the "${to}" specialist may ${what} in ${t.channel}`)
  return t
}

export function watchSlackThread(caller: Pick<SessionInfo, 'threadId'> | undefined, channel: unknown, threadTs: unknown): string {
  const t = requireRouteOccupant(caller, channel, threadTs, 'watch Slack threads')
  if (!getSlackWatcher().watch(t.channel, t.threadTs, 'tool')) throw new Error(`the watch table is full (${requireConfig().maxWatches}); unwatch a thread first`)
  return `watching ${t.channel}:${t.threadTs}`
}

export function unwatchSlackThread(caller: Pick<SessionInfo, 'threadId'> | undefined, channel: unknown, threadTs: unknown): string {
  const t = requireRouteOccupant(caller, channel, threadTs, 'unwatch Slack threads')
  return getSlackWatcher().unwatch(t.channel, t.threadTs) ? `stopped watching ${t.channel}:${t.threadTs}` : `${t.channel}:${t.threadTs} was not being watched`
}

/** `hydra slack-watch add`: the operator watches a thread by hand. Throws a message for the CLI to show. */
export function addSlackWatch(channel: string, threadTs: string): string {
  const cfg = requireConfig()
  if (!routeFor(cfg, channel)) throw new Error(`${channel} is in no route in slack-watch.json, so nothing in it would ever be delivered`)
  const t = checkThread(cfg, channel, threadTs)
  if (!getSlackWatcher().watch(t.channel, t.threadTs, 'cli')) throw new Error('the watch table is full')
  return `${t.channel}:${t.threadTs}`
}

/** The operator's view: every watch. A session sees only its own routes' through `formatSlackWatchesFor`. */
export function formatSlackWatches(now = Date.now(), only?: (channel: string) => boolean): string[] {
  return getSlackWatcher().list().filter(e => !only || only(e.channel)).map(e => {
    const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
    const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
    return `${e.channel}:${e.threadTs} → ${routeFor(config(), e.channel)?.to ?? '(no route: owed messages wait)'} · idle ${idle}h${owed}`
  })
}

/**
 * The watches a session may see: those in channels routed to the specialist whose thread it sits in. Routes are an
 * audience boundary, so one route's session never reads another route's threads. Empty for anyone outside a route.
 */
export function formatSlackWatchesFor(caller: Pick<SessionInfo, 'threadId'>, now = Date.now()): string[] {
  const cfg = config()
  if (!caller.threadId) return []
  const mine = new Set(routeTargets(cfg).filter(to => getSpecialist(to)?.threadId === caller.threadId))
  if (!mine.size) return []
  return formatSlackWatches(now, channel => mine.has(routeFor(cfg, channel)?.to ?? ''))
}

/** A route whose `to` names no specialist is a config error: said here, before any message is owed to it. */
function routeNote(to: string): { note?: string } {
  if (to === 'main') return { note: MAIN_NOTE }
  if (!getSpecialist(to)) return { note: `no such specialist: ${to}; declare it with hydra specialist set, or fix the route` }
  return {}
}

const MAIN_NOTE = 'main is never revived; while it is disconnected its messages stay owed, since its queue does not survive a restart'

/** For `hydra health` and `slack-watch list`: null when nothing is configured. Refusals and drops count since the daemon started. */
export function slackWatchHealth(now = Date.now()): ({ routes: { channels: string[]; to: string; note?: string }[]; watches: number; owed: number; oldestOwedAgeMin: number | null; listener?: ListenerHealth } & SlackWatchStats) | null {
  const cfg = config()
  if (!cfg) return null
  const entries = getSlackWatcher().list()
  const owed = entries.flatMap(e => e.owed ?? [])
  const oldest = owed.sort(cmpTs)[0]
  return {
    routes: cfg.routes.map(r => ({ channels: r.channels, to: r.to, ...routeNote(r.to) })),
    watches: entries.length,
    owed: owed.length,
    oldestOwedAgeMin: oldest ? Math.max(0, Math.round((now / 1000 - parseFloat(oldest)) / 60)) : null,
    ...getSlackWatcher().stats(),
    ...(listener && { listener: listener.health() }),
  }
}
