// Account-wide Claude rate-limit alerts, posted to the default channel.
//
// Two sources feed one dedupe per window:
//   'claude' — Claude Code's own figures, sent by the hydra mod in byte (report_usage tool).
//   'pane'   — byte's footer text ("You've used N% of your weekly limit"), read by pane-probe.
// The claude source is the truth; the pane is a fallback for when the mod is not reporting
// (an older Claude Code, a broken early-access API). While the claude source has reported a
// window recently, the pane only cross-checks it.
//
// Alerts once per threshold (the highest newly crossed). Re-arms on a new window, or when usage
// falls well below the last alert (a few points of hysteresis, so 91→89→91 jitter can't re-alert).
// State persists in the state dir: a daemon restart hot-reloads byte's mod, whose first reading
// would otherwise re-announce the threshold already posted.

import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, PLATFORM, DEFAULT_SESSION_CHANNEL } from './config.js'
import { atomicWriteFileSync, formatDuration, safeSend } from './util.js'

export type UsageKind = 'five_hour' | 'seven_day'
export type UsageSource = 'claude' | 'pane'
export type UsageReading = {
  kind: UsageKind
  percentUsed: number
  /** claude: an ISO timestamp; pane: the footer's own words ("Oct 2, 6am (America/Los_Angeles)"). */
  resetsAt?: string
  source: UsageSource
}

export const USAGE_THRESHOLDS: Readonly<Record<UsageKind, readonly number[]>> = {
  five_hour: [80, 95],
  seven_day: [80, 90, 95],
}
const LABELS: Record<UsageKind, string> = { five_hour: '5-hour limit', seven_day: 'weekly limit' }
// Usage must fall this far below the last alerted threshold before it re-arms.
const REARM_HYSTERESIS = 5
// A claude reading this recent keeps the pane from alerting for that window.
const CLAUDE_FRESH_MS = 60 * 60_000
// Two claude resets_at closer than this are the same window (the API may round differently).
const SAME_WINDOW_MS = 5 * 60_000
// Readings further apart than this are worth a stderr line.
const DISAGREE_POINTS = 2

type WindowState = { alerted: number; windows: Partial<Record<UsageSource, string>> }
type State = Partial<Record<UsageKind, WindowState>>

export type UsageAlertsIO = {
  send: (text: string) => void
  log: (line: string) => void
  now: () => number
  platform: string
  load: () => State
  save: (state: State) => void
}

const PERSIST_FILE = join(STATE_DIR, 'usage-alerts.json')

const defaultIO: UsageAlertsIO = {
  // Late-bound: DEFAULT_SESSION_CHANNEL may be auto-resolved after boot.
  send: text => { if (DEFAULT_SESSION_CHANNEL) void safeSend(DEFAULT_SESSION_CHANNEL, text) },
  log: line => { process.stderr.write(`daemon: usage-alerts: ${line}\n`) },
  now: () => Date.now(),
  platform: PLATFORM,
  load: () => {
    try { return JSON.parse(readFileSync(PERSIST_FILE, 'utf8')) as State } catch { return {} }
  },
  save: state => {
    try { atomicWriteFileSync(PERSIST_FILE, JSON.stringify(state) + '\n') } catch (err) {
      process.stderr.write(`daemon: usage-alerts: persist failed: ${err}\n`)
    }
  },
}

let io = defaultIO
let state: State | undefined
// Last reading per source and window, for the cross-check. Memory only: the mod re-reports after a restart.
const last = new Map<string, { percentUsed: number; at: number }>()

export function _setUsageAlertsIO(custom: UsageAlertsIO): void { io = custom; state = undefined; last.clear() }
export function _resetUsageAlertsIO(): void { io = defaultIO; state = undefined; last.clear() }

function windowState(kind: UsageKind): WindowState {
  if (!state) { const loaded = io.load(); state = loaded && typeof loaded === 'object' ? loaded : {} }
  const w = state[kind]
  // A hand-edited or truncated file starts that window over rather than throwing on every report.
  if (!w || typeof w.alerted !== 'number' || !w.windows || typeof w.windows !== 'object') return (state[kind] = { alerted: 0, windows: {} })
  return w
}

/** Is `next` a later window than `prev`, for this source's way of naming one? */
function isNewWindow(w: WindowState, source: UsageSource, prev: string | undefined, next: string | undefined, now: number): boolean {
  if (!prev || !next || prev === next) return false
  if (source === 'pane') {
    // The pane's saved text can be weeks old (the footer only shows at high usage), so a change
    // in it proves nothing while the claude source's window has not yet reset.
    const claudeReset = w.windows.claude ? Date.parse(w.windows.claude) : NaN
    return Number.isNaN(claudeReset) || now >= claudeReset
  }
  const a = Date.parse(prev), b = Date.parse(next)
  return Number.isNaN(a) || Number.isNaN(b) || Math.abs(b - a) > SAME_WINDOW_MS
}

function resetsText(r: UsageReading): string {
  if (!r.resetsAt) return ''
  if (r.source === 'pane') return ` · resets ${r.resetsAt}`
  const at = Date.parse(r.resetsAt)
  if (Number.isNaN(at)) return ''
  // Discord draws <t:…:R> live, in the reader's own timezone.
  if (io.platform === 'discord') return ` · resets <t:${Math.floor(at / 1000)}:R>`
  return ` · resets in ${formatDuration(Math.max(0, at - io.now()))}`
}

/** One reading from either source. Never throws. */
export function reportUsage(r: UsageReading): void {
  const now = io.now()
  const other: UsageSource = r.source === 'claude' ? 'pane' : 'claude'
  const prior = last.get(`${other}:${r.kind}`)
  last.set(`${r.source}:${r.kind}`, { percentUsed: r.percentUsed, at: now })
  const claudeFresh = r.source === 'pane' && !!prior && now - prior.at < CLAUDE_FRESH_MS
  if (prior && now - prior.at < CLAUDE_FRESH_MS && Math.abs(prior.percentUsed - r.percentUsed) > DISAGREE_POINTS) {
    io.log(`${r.kind}: ${r.source} says ${r.percentUsed}%, ${other} said ${prior.percentUsed}% (claude wins)`)
  }

  const w = windowState(r.kind)
  const before = JSON.stringify(w)
  const prevWindow = w.windows[r.source]
  if (r.resetsAt) w.windows[r.source] = r.resetsAt
  // While the claude source is fresh it decides this window; the pane's reading was only the cross-check.
  if (!claudeFresh) {
    const thresholds = USAGE_THRESHOLDS[r.kind]
    if (isNewWindow(w, r.source, prevWindow, r.resetsAt, now)) w.alerted = 0
    else if (w.alerted && r.percentUsed < w.alerted - REARM_HYSTERESIS) w.alerted = thresholds.filter(t => t <= r.percentUsed).pop() ?? 0
    const crossed = thresholds.filter(t => r.percentUsed >= t && t > w.alerted).pop()
    if (crossed) {
      w.alerted = crossed
      io.send(`> ⚠️ Claude usage at **${r.percentUsed}%** of ${LABELS[r.kind]}${resetsText(r)}.`)
    }
  }
  if (JSON.stringify(w) !== before) io.save(state!)
}

/**
 * The report_usage tool's input as readings: `{ rate_limits: [{ kind, percent_used, resets_at? }] }`.
 * Unknown kinds (a gateway's spend_limit) and malformed entries are dropped, never thrown on.
 */
export function parseRateLimits(args: Record<string, unknown>): UsageReading[] {
  const list = Array.isArray(args.rate_limits) ? args.rate_limits : []
  const readings: UsageReading[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { kind, percent_used, resets_at } = item as Record<string, unknown>
    if (kind !== 'five_hour' && kind !== 'seven_day') continue
    if (typeof percent_used !== 'number' || !Number.isFinite(percent_used)) continue
    readings.push({ kind, percentUsed: percent_used, source: 'claude', ...(typeof resets_at === 'string' && resets_at ? { resetsAt: resets_at } : {}) })
  }
  return readings
}
