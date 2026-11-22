/**
 * The daemon's one call to keep the bridge plugin pointing at this checkout's bridge.ts.
 * Boot runs it without waiting on dependency installs; a spawn awaits `ready` before it starts the session.
 */
import { join } from 'path'
import { claudeConfigDir } from '../shared/constants.js'
import { PLATFORM, SOCK_PATH } from '../infra/config.js'
import { syncHydraBridge, type BridgeSyncResult } from '../infra/plugin-manifest.js'

const HYDRA_DIR = join(import.meta.dir, '..')

export function syncDaemonBridge(): BridgeSyncResult {
  return syncHydraBridge({
    claudeConfig: claudeConfigDir(),
    hydraDir: HYDRA_DIR,
    platform: PLATFORM,
    sockPath: SOCK_PATH,
    log: line => process.stderr.write(`daemon: ${line}\n`),
  })
}
