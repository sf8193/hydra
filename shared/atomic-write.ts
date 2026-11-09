import { writeFileSync, renameSync } from 'fs'

/** Write via a temp file and rename, so a reader never sees a half-written file. */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, data, { mode: mode ?? 0o600 })
  renameSync(tmp, filePath)
}
