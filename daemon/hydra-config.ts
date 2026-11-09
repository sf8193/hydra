// The daemon's live hydra.toml: loaded at boot, re-read on change. Consumers read currentHydraConfig() each time
// (late-bound, so an edit applies without a restart) or subscribe with onHydraConfigLoad().
// A failed load keeps the last good config, and the alert the caller passes hears it.

import { join } from 'path'
import { STATE_DIR } from './config.js'
import { SESSION_NAMES } from './sessions.js'
import { EMPTY_CONFIG, formatIssues, systemEnv } from '../config/load.js'
import { watchHydraConfig, type HydraConfigWatch } from '../config/watch.js'
import type { HydraConfig, LoadEnv, LoadResult } from '../config/types.js'

export const HYDRA_CONFIG_FILE = 'hydra.toml'
export const hydraConfigPath = () => join(STATE_DIR, HYDRA_CONFIG_FILE)

let watch: HydraConfigWatch | undefined
let override: HydraConfig | undefined
const listeners = new Set<(config: HydraConfig) => void>()


/**
 * Starts the watch once; later calls return the first result. `alert` hears each failed load (the daemon DMs the
 * operator; passed in, since access.ts reads this module). Every alert and warning is logged too.
 */
export function startHydraConfig(opts: { alert?: (text: string) => void; env?: LoadEnv; intervalMs?: number } = {}): LoadResult {
  if (watch) return watch.initial
  watch = watchHydraConfig({
    path: hydraConfigPath(),
    env: opts.env ?? systemEnv(SESSION_NAMES),
    intervalMs: opts.intervalMs,
    onAlert: text => { process.stderr.write(`daemon: ${text}\n`); opts.alert?.(text) },
    onLoad: (config, warnings) => {
      if (warnings.length) process.stderr.write(`daemon: hydra.toml loaded with warnings:\n${formatIssues(warnings)}\n`)
      notify(config)
    },
  })
  return watch.initial
}

export function stopHydraConfig(): void {
  watch?.stop()
  watch = undefined
}

function notify(config: HydraConfig): void {
  for (const fn of listeners) {
    try { fn(config) } catch (e) { process.stderr.write(`daemon: a hydra.toml listener failed: ${(e as Error).message}\n`) }
  }
}

/** The last config that loaded; the empty config before the first. */
export function currentHydraConfig(): HydraConfig {
  return override ?? watch?.current() ?? EMPTY_CONFIG
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
