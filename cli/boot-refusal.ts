// The reason a daemon refused to start (config/migrate.ts bootRefusal), kept in its state dir: the daemon writes it as
// it exits, the watchdog adds that it has logged it, and `hydra health` reads it. A daemon that starts removes it.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BOOT_REFUSED_FILE } from '../config/migrate.js'

type Marker = { reason?: string; at?: number; watchdogLogged?: boolean }
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
  try { writeFileSync(join(stateDir, BOOT_REFUSED_FILE), JSON.stringify({ reason, at: m.reason === reason ? m.at : now, watchdogLogged: true }) + '\n') } catch {}
  return reason
}
