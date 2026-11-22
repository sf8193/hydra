// The reason a daemon refused to start (infra/migrate.ts bootRefusal), kept in its state dir: the daemon writes it as
// it exits, the watchdog adds that it has logged it, and `hydra health` reads it. A daemon that starts removes it.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BOOT_REFUSED_FILE } from '../infra/migrate.js'

type Marker = { reason?: string; at?: number; watchdogLogged?: boolean; alerted?: boolean; alertTries?: number }
const read = (stateDir: string): Marker => {
  try { return JSON.parse(readFileSync(join(stateDir, BOOT_REFUSED_FILE), 'utf8')) as Marker } catch { return {} }
}

export function readBootRefusal(stateDir: string): string | undefined {
  return read(stateDir).reason
}

/**
 * Records a refusal the watchdog found. Returns the line to log the first time the watchdog sees this reason,
 * undefined after, so a 2-minute tick doesn't repeat it.
 */
export function noteBootRefusal(stateDir: string, reason: string, now: number): string | undefined {
  const m = read(stateDir)
  if (m.reason === reason && m.watchdogLogged) return undefined
  const same = m.reason === reason
  try { writeFileSync(join(stateDir, BOOT_REFUSED_FILE), JSON.stringify({ ...(same && m), reason, at: same ? m.at : now, watchdogLogged: true }) + '\n') } catch {}
  return reason
}

/** A failed DM is tried again on later ticks, this many times in all. */
const ALERT_TRIES = 5

/** Whether the operator still needs telling about this reason: not told yet, and fewer than ALERT_TRIES sends have failed. */
export function shouldAlertOperator(stateDir: string, reason: string): boolean {
  const m = read(stateDir)
  return m.reason !== reason || (!m.alerted && (m.alertTries ?? 0) < ALERT_TRIES)
}

/**
 * Records that a send is about to be tried, before it is: the count is what stops the retries, so a state dir that cannot be
 * written (the count would never persist) returns false and nothing is sent, instead of a DM on every tick.
 */
export function startOperatorAlert(stateDir: string, reason: string): boolean {
  const m = read(stateDir)
  const same = m.reason === reason
  try {
    writeFileSync(join(stateDir, BOOT_REFUSED_FILE), JSON.stringify({ ...(same && m), reason, alerted: false, alertTries: (same ? m.alertTries ?? 0 : 0) + 1 }) + '\n')
    return true
  } catch { return false }
}

/** The DM went out: stop the retries. */
export function finishOperatorAlert(stateDir: string): void {
  const m = read(stateDir)
  try { writeFileSync(join(stateDir, BOOT_REFUSED_FILE), JSON.stringify({ ...m, alerted: true }) + '\n') } catch {}
}
