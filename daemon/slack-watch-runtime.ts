import { SlackWatcher, fileConfig, cmpTs, slackWatchConfigPath, slackWatchesPath, type SlackWatchConfig } from './slack-watch.js'
import { deliverToSpecialist } from './specialist-deliver.js'
import { getSpecialist } from './specialists.js'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { isSlackSpecialistOccupant, pushToolSurface } from './tool-surface.js'
import { SlackListener, boltApp, type ListenerHealth } from './slack-listener.js'
import { SCRUBBED_ENV } from './config.js'
import { safeSend } from './util.js'

const log = (line: string) => { process.stderr.write(line) }
const config = fileConfig(slackWatchConfigPath(), log)

const SWEEP_INTERVAL_MS = 60 * 60_000

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
    deliver: async (specialist, message, idempotencyKey) => {
      const r = await deliverToSpecialist({ specialist, message, initiator: 'slack-watch', idempotencyKey, source: 'slack-watch' })
      if (r.ok) return { ok: true }
      if (r.exitCode === 2) return { ok: true, duplicate: true }
      return { ok: false, error: r.error, ...(r.permanent && { permanent: true }) }
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
    alert: text => {
      const specialist = config()?.specialist
      const thread = specialist ? getSpecialist(specialist)?.threadId : undefined
      if (thread) void safeSend(thread, text).catch(() => {})
      else log(`daemon: slack listener alert with no specialist thread to send it to: ${text}\n`)
    },
  })
  if (await l.start()) listener = l
}

export function stopSlackListener(): void {
  listener?.stop()
  listener = undefined
}

/** The occupant of the Slack-watch specialist, if one is running. */
function specialistOccupantId(): string | undefined {
  const specialist = config()?.specialist
  const thread = specialist ? getSpecialist(specialist)?.threadId : undefined
  return thread ? registry.getByThread(thread) : undefined
}

/** Tell the specialist's session which tools it now has (it gets the watch tools only while it sits in the specialist). */
export function refreshSlackSpecialistSurface(): void {
  const id = specialistOccupantId()
  if (id) pushToolSurface(id)
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

/** The two tools may be called only by the session in the specialist; the capability hides them from the rest, this enforces it. */
function requireOccupant(caller: Pick<SessionInfo, 'threadId'> | undefined, what: string): SlackWatchConfig {
  const cfg = requireConfig()
  if (!caller || !isSlackSpecialistOccupant(caller)) throw new Error(`only the session in the "${cfg.specialist}" specialist may ${what}`)
  return cfg
}

function checkTarget(cfg: SlackWatchConfig, channel: unknown, threadTs: unknown): { channel: string; threadTs: string } {
  if (typeof channel !== 'string' || !cfg.channels.includes(channel)) throw new Error(`channel must be one of: ${cfg.channels.join(', ')}`)
  if (typeof threadTs !== 'string' || !THREAD_TS.test(threadTs)) throw new Error('thread_ts must look like 1793732224.093059')
  return { channel, threadTs }
}

export function watchSlackThread(caller: Pick<SessionInfo, 'threadId'> | undefined, channel: unknown, threadTs: unknown): string {
  const cfg = requireOccupant(caller, 'watch Slack threads')
  const t = checkTarget(cfg, channel, threadTs)
  // The specialist is always the configured one: a tool argument never picks where deliveries go.
  const entry = getSlackWatcher().watch(t.channel, t.threadTs, cfg.specialist, 'tool')
  if (!entry) throw new Error(`the watch table is full (${cfg.maxWatches}); unwatch a thread first`)
  return `watching ${t.channel}:${t.threadTs}`
}

export function unwatchSlackThread(caller: Pick<SessionInfo, 'threadId'> | undefined, channel: unknown, threadTs: unknown): string {
  const cfg = requireOccupant(caller, 'unwatch Slack threads')
  const t = checkTarget(cfg, channel, threadTs)
  return getSlackWatcher().unwatch(t.channel, t.threadTs) ? `stopped watching ${t.channel}:${t.threadTs}` : `${t.channel}:${t.threadTs} was not being watched`
}

export function formatSlackWatches(now = Date.now()): string[] {
  return getSlackWatcher().list().map(e => {
    const idle = Math.max(0, Math.round((now - e.lastEventAt) / 3_600_000))
    const owed = e.owed?.length ? ` · ${e.owed.length} owed` : ''
    return `${e.channel}:${e.threadTs} → ${e.specialist} · idle ${idle}h${owed}`
  })
}

/** The channels slack-watch.json lists; empty when nothing is configured. */
export function slackWatchChannels(): string[] { return config()?.channels ?? [] }

/** For `hydra health`: null when nothing is configured. */
export function slackWatchHealth(now = Date.now()): { specialist: string; watches: number; owed: number; oldestOwedAgeMin: number | null; listener?: ListenerHealth } | null {
  const cfg = config()
  if (!cfg) return null
  const entries = getSlackWatcher().list()
  const owed = entries.flatMap(e => e.owed ?? [])
  const oldest = owed.sort(cmpTs)[0]
  return {
    specialist: cfg.specialist,
    watches: entries.length,
    owed: owed.length,
    oldestOwedAgeMin: oldest ? Math.max(0, Math.round((now / 1000 - parseFloat(oldest)) / 60)) : null,
    ...(listener && { listener: listener.health() }),
  }
}
