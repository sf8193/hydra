// Recurring jobs, the part on disk: the state files the daemon's clock writes and the CLI reads, and the results launchd
// runs leave. The records' shapes and the owed rule: shared/jobs.ts. The ps reads: infra/processes.ts.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'fs'
import { join } from 'path'
import { daemonFile, jobStateFrom, parseExternalName, resultsDir, stateFile, v0File, type DaemonState, type ReadState } from '../shared/jobs.js'

/** A job's launchd results waiting for the daemon, oldest slot first. */
export function externalResults(stateDir: string, name: string): string[] {
  let files: string[] = []
  try { files = readdirSync(resultsDir(stateDir)) } catch {}
  return files.map(parseExternalName).filter((p): p is { name: string; slotAt: string } => p?.name === name)
    .map(p => p.slotAt).sort()
}

/** tmp + fsync + rename: a reader sees the old file or the new one, never half of one. */
export function writeAtomic(file: string, data: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

/**
 * A job's state: missing (never ran here), unreadable (corrupt or foreign), or the state. With no daemon record yet,
 * the old runner's `<name>.json` is migrated (`translated`), and only then: once the daemon has written its own
 * record, a later v0 write can't touch it.
 */
export function readJobState(stateDir: string, name: string, schedule?: string): ReadState {
  if (existsSync(stateFile(stateDir, name))) {
    const r = readRecord(stateFile(stateDir, name), schedule)
    return r.kind === 'ok' && r.translated ? { kind: 'unreadable', error: 'a v0 record in the daemon state file' } : r
  }
  if (!existsSync(v0File(stateDir, name))) return { kind: 'missing' }
  const r = readRecord(v0File(stateDir, name), schedule)
  return r.kind === 'ok' ? { ...r, translated: true } : r
}

function readRecord(f: string, schedule: string | undefined): ReadState {
  let o: unknown
  try { o = JSON.parse(readFileSync(f, 'utf8')) } catch (err) { return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) } }
  return jobStateFrom(o, schedule)
}

export function readDaemonState(stateDir: string): { state: DaemonState; corrupt?: string } {
  const f = daemonFile(stateDir)
  if (!existsSync(f)) return { state: {} }
  try {
    const o = JSON.parse(readFileSync(f, 'utf8'))
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return { state: {}, corrupt: 'not an object' }
    return { state: o as DaemonState }
  } catch (err) {
    return { state: {}, corrupt: err instanceof Error ? err.message : String(err) }
  }
}
