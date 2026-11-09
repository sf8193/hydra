// The daemon's live hydra.toml: loaded at boot, re-read on change. Consumers read currentHydraConfig() each time
// (late-bound, so an edit applies without a restart) or subscribe with onHydraConfigLoad().
// A failed load keeps the last good config, and the alert the caller passes hears it.

import { join } from 'path'
import { STATE_DIR, PLATFORM } from './config.js'
import { SESSION_NAMES } from './sessions.js'
import { EMPTY_CONFIG, formatIssues, systemEnv } from '../config/load.js'
import { watchHydraConfig, type HydraConfigWatch } from '../config/watch.js'
import type { HydraConfig, LoadEnv, LoadResult } from '../config/types.js'

export const HYDRA_CONFIG_FILE = 'hydra.toml'
export const hydraConfigPath = () => join(STATE_DIR, HYDRA_CONFIG_FILE)

let watch: HydraConfigWatch | undefined
let override: HydraConfig | undefined
/** The config that last loaded. Set before subscribers hear it, so one reading currentHydraConfig() during the first
 * load (inside startHydraConfig, before the watch is returned) sees that config, not the empty one. */
let live: HydraConfig | undefined
const listeners = new Set<(config: HydraConfig) => void>()

type Send = (text: string) => Promise<boolean>
let send: Send | undefined
/** The latest alert not yet delivered. At boot the gateway isn't connected, so the first try can fail; a newer alert
 * replaces it, and a good load clears it, so a stale "didn't load" is never sent. */
let undelivered: string | undefined
let inFlight: Promise<void> | undefined
/** Whether hydra.toml governs: a live config names an operator, or the file has content that hasn't loaded yet. */
let inUse = false
/** Whether the latest read loaded; false while a failed load keeps the last good config. */
let lastLoadOk = true

/** One send at a time: a retry that lands while the boot send is still out waits for it instead of sending again. */
function deliver(): Promise<void> {
  if (inFlight) return inFlight
  const text = undelivered
  if (!text || !send) return Promise.resolve()
  const run = send(text).catch(() => false).then(ok => { if (ok && undelivered === text) undelivered = undefined })
  inFlight = run.finally(() => {
    inFlight = undefined
    // A newer alert that arrived during this send goes next.
    if (undelivered && undelivered !== text) void deliver()
  })
  return inFlight
}

/**
 * Whether hydra.toml decides who the operator is. A file that failed to load at boot counts: falling back to
 * access.json then would hand admin back to ids the operator meant to leave out. An emptied or deleted file doesn't.
 */
export function hydraConfigInUse(): boolean {
  return override ? override.operator !== undefined : inUse
}

/** Sends the alert that couldn't be delivered, if any. The daemon calls it once the gateway is up. */
export function retryHydraConfigAlert(): Promise<void> {
  return deliver()
}

/**
 * Starts the watch once; later calls return the first result. `alert` sends each failed load to the operator and
 * says whether it was delivered (passed in, since access.ts reads this module). Every alert and warning is logged too.
 */
export function startHydraConfig(opts: { alert?: Send; env?: LoadEnv; intervalMs?: number } = {}): LoadResult {
  if (watch) return watch.initial
  send = opts.alert
  inUse = false
  watch = watchHydraConfig({
    path: hydraConfigPath(),
    env: opts.env ?? systemEnv(SESSION_NAMES),
    intervalMs: opts.intervalMs,
    onAlert: text => { process.stderr.write(`daemon: ${text}\n`); undelivered = text; lastLoadOk = false; void deliver() },
    onLoad: (config, warnings) => {
      undelivered = undefined
      lastLoadOk = true
      live = config
      inUse = config.operator !== undefined
      const op = config.operator ? config.people[config.operator] : undefined
      if (op && !op.ids.some(a => a.startsWith(`${PLATFORM}:`))) {
        // Loud: on this platform nobody is in charge now. The alert falls back to the default channel (no operator id here).
        const text = `hydra.toml: the operator ${op.id} has no ${PLATFORM}: address, so on ${PLATFORM} nobody passes admin checks or reaches main by DM. Add one under [people.${op.id}].`
        process.stderr.write(`daemon: ${text}\n`)
        undelivered = text
        void deliver()
      }
      if (warnings.length) process.stderr.write(`daemon: hydra.toml loaded with warnings:\n${formatIssues(warnings)}\n`)
      notify(config)
    },
  })
  if (!watch.initial.ok) { inUse = true; lastLoadOk = false }
  return watch.initial
}

export function stopHydraConfig(): void {
  inUse = false
  live = undefined
  inFlight = undefined
  undelivered = undefined
  send = undefined
  watch?.stop()
  watch = undefined
}

function notify(config: HydraConfig): void {
  for (const fn of listeners) {
    try { fn(config) } catch (e) { process.stderr.write(`daemon: a hydra.toml listener failed: ${(e as Error).message}\n`) }
  }
}

/** Whether the latest read of hydra.toml loaded. While false, current() is the last good config, not the file. */
export function hydraConfigLoadedOk(): boolean {
  return override !== undefined || lastLoadOk
}

/** Reads hydra.toml now instead of at the next interval (`schedules sync`). Listeners hear it only if it changed. */
export function reloadHydraConfig(): void {
  watch?.reload()
}

/** The last config that loaded; the empty config before the first. */
export function currentHydraConfig(): HydraConfig {
  return override ?? live ?? EMPTY_CONFIG
}

/** Tests: stand in for the file. Set, it is current and subscribers hear it; undefined goes back to the file's. */
export function _setHydraConfigForTesting(config: HydraConfig | undefined): void {
  override = config
  if (config) notify(config)
}

/** Called with each newly loaded config (not the one already live). Returns an unsubscribe. */
export function onHydraConfigLoad(fn: (config: HydraConfig) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
