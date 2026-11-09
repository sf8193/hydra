// Writing to a live hydra.toml from a CLI (`hydra people add`, `hydra config add`): plan under one lock, and write only
// if the file is still what was planned from. The daemon re-reads it within a second.

import { closeSync, openSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../shared/atomic-write.js'
import { HYDRA_TOML } from './migrate.js'

const LOCK = 'hydra.toml.lock'
const STALE_LOCK_MS = 10_000
const BUSY = 'another hydra command is writing hydra.toml; run it again in a moment'

/**
 * Runs `fn` under hydra.toml.lock (created exclusively; one older than 10s is a crashed writer's and is taken over), so
 * two writers at once can't both plan from the old file and lose one's change.
 */
export function withHydraTomlLock<T>(stateDir: string, fn: () => T, busy: (error: string) => T): T {
  const lock = join(stateDir, LOCK)
  let fd: number
  try { fd = openSync(lock, 'wx') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    try { if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return busy(BUSY) } catch {}
    try { unlinkSync(lock) } catch {}
    try { fd = openSync(lock, 'wx') } catch { return busy(BUSY) }
  }
  try { return fn() } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch {}
  }
}

/**
 * Writes `text` in one step, keeping the file's mode, unless hydra.toml is no longer `from` (a hand edit since it was
 * planned): then it writes nothing and says why.
 */
export function writeIfUnchanged(stateDir: string, from: string, text: string): string | undefined {
  const path = join(stateDir, HYDRA_TOML)
  if (readFileSync(path, 'utf8') !== from) return 'hydra.toml changed while this was being planned; nothing written, run it again'
  atomicWriteFileSync(path, text, statSync(path).mode & 0o777)
  return undefined
}
