// Posts the alert the watchdog left in the state dir (cli/watchdog-restarts.ts): the watchdog
// has no chat connection, so a daemon whose gateway is up does it. Called once the gateway starts.
// The file is removed only once the alert reached the operator, so a daemon that dies first leaves
// it for the next one.
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { notifyOperator } from './access.js'
import { WATCHDOG_ALERT_FILE } from '../shared/constants.js'

export async function deliverWatchdogAlert(notify: (text: string) => Promise<boolean> = notifyOperator, stateDir = STATE_DIR): Promise<void> {
  const path = join(stateDir, WATCHDOG_ALERT_FILE)
  if (!existsSync(path)) return
  let text: string | undefined
  try {
    text = (JSON.parse(readFileSync(path, 'utf8')) as { text?: string }).text
  } catch (err) {
    process.stderr.write(`daemon: watchdog alert unreadable, dropping it: ${err}\n`)
  }
  if (text && !(await notify(text).catch(() => false))) {
    process.stderr.write(`daemon: watchdog alert not delivered, kept for the next start\n`)
    return
  }
  try { unlinkSync(path) } catch {}
}
