// The watchdog's crash-loop alert. Every daemon restart it makes is recorded in the state dir;
// when RESTART_ALERT_COUNT of them land within RESTART_ALERT_WINDOW_S, it leaves an alert for the
// operator in WATCHDOG_ALERT_FILE. The watchdog holds no chat connection, so the daemon posts it
// once its gateway is up (daemon/watchdog-alert.ts) — the next daemon of the loop, typically.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WATCHDOG_ALERT_FILE } from '../shared/constants.js'

export const RESTART_ALERT_COUNT = 3
export const RESTART_ALERT_WINDOW_S = 3600

export type Restart = { at: number; reason: string }
type Log = { restarts: Restart[]; alertedAt?: number }

const logPath = (stateDir: string) => join(stateDir, 'watchdog-restarts.json')

function readLog(stateDir: string): Log {
  try {
    if (!existsSync(logPath(stateDir))) return { restarts: [] }
    const log = JSON.parse(readFileSync(logPath(stateDir), 'utf8')) as Log
    return Array.isArray(log.restarts) ? log : { restarts: [] }
  } catch {
    return { restarts: [] }
  }
}

/** The alert text for a window of restarts, oldest first. */
export function formatRestartAlert(restarts: Restart[], logFile: string): string {
  const time = (at: number) => new Date(at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return [
    `⚠️ The watchdog restarted the daemon ${restarts.length} times in the last hour:`,
    ...restarts.map(r => `• ${time(r.at)} — ${r.reason}`),
    `It keeps restarting it while this lasts. Details: \`${logFile}\`.`,
  ].join('\n')
}

/**
 * Record a restart the watchdog just made. Returns the alert text when this restart brings the
 * last hour to RESTART_ALERT_COUNT and nothing in that hour was alerted yet (written to the alert
 * file as well); otherwise null. A loop that goes on is alerted again once its window no longer
 * holds the restart that was alerted, about once an hour.
 */
export function noteRestart(stateDir: string, now: number, reason: string, logFile: string): string | null {
  const log = readLog(stateDir)
  const restarts = [...log.restarts.filter(r => now - r.at < RESTART_ALERT_WINDOW_S), { at: now, reason }]
  const alerted = log.alertedAt !== undefined && log.alertedAt >= restarts[0].at
  const alert = restarts.length >= RESTART_ALERT_COUNT && !alerted ? formatRestartAlert(restarts, logFile) : null
  const alertedAt = alert ? now : log.alertedAt
  const next: Log = { restarts, ...(alertedAt !== undefined && { alertedAt }) }
  try {
    writeFileSync(logPath(stateDir), JSON.stringify(next) + '\n')
    if (alert) writeFileSync(join(stateDir, WATCHDOG_ALERT_FILE), JSON.stringify({ text: alert, at: now }) + '\n')
  } catch (err) {
    process.stderr.write(`watchdog: could not record the restart: ${err}\n`)
  }
  return alert
}
