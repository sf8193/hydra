import { writeFileSync, renameSync } from 'fs'
import { randomBytes } from 'crypto'

/**
 * Write via a temp file and rename, so a reader never sees a half-written file. The temp name is this writer's
 * own, so two writers at once never rename each other's half-written file into place.
 */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, { mode: mode ?? 0o600 })
  renameSync(tmp, filePath)
}
