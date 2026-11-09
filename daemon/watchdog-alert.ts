// Posts the alert the watchdog left in the state dir (cli/watchdog-restarts.ts): the watchdog
// has no chat connection, so a daemon whose gateway is up does it. Called once the gateway starts.
// The file is removed only once the alert reached the operator, so a daemon that dies first leaves
// it for the next one.
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { formatDuration } from './util.js'
import { notifyOperator } from './access.js'
import { WATCHDOG_ALERT_FILE } from '../shared/constants.js'

// The alert says "in the last hour"; one that waited longer than that for a daemon to post it says how long.
const STALE_AFTER_S = 3600

/** The alert as posted: prefixed with its age when it waited more than an hour. `at` and `now` are epoch seconds. */
export function alertText(text: string, at: number | undefined, now: number): string {
  if (at === undefined || now - at <= STALE_AFTER_S) return text
  return `_This alert is from ${formatDuration((now - at) * 1000)} ago; no daemon could post it until now._\n${text}`
}

export async function deliverWatchdogAlert(notify: (text: string) => Promise<boolean> = notifyOperator, stateDir = STATE_DIR, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const path = join(stateDir, WATCHDOG_ALERT_FILE)
  if (!existsSync(path)) return
  let text: string | undefined
  try {
    const alert = JSON.parse(readFileSync(path, 'utf8')) as { text?: string; at?: number }
    text = alert.text && alertText(alert.text, alert.at, now)
  } catch (err) {
    process.stderr.write(`daemon: watchdog alert unreadable, dropping it: ${err}\n`)
  }
  if (text && !(await notify(text).catch(() => false))) {
    process.stderr.write(`daemon: watchdog alert not delivered, kept for the next start\n`)
    return
  }
  try { unlinkSync(path) } catch {}
}
