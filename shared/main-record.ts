// What `hydra up` launched main (the byte) with, as a spawned session's record holds it. Main has no registry
// record, so the CLI writes this beside the daemon's state when it builds the byte's command, and the daemon
// reads it. Absent for a byte launched another way, or before this existed.

import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from './atomic-write.js'

export type MainRecord = { model: string }

const path = (stateDir: string) => join(stateDir, 'main.json')

export function writeMainRecord(stateDir: string, record: MainRecord): void {
  atomicWriteFileSync(path(stateDir), JSON.stringify(record) + '\n')
}

export function clearMainRecord(stateDir: string): void {
  try { rmSync(path(stateDir), { force: true }) } catch {}
}

export function readMainRecord(stateDir: string): MainRecord | null {
  try {
    const d = JSON.parse(readFileSync(path(stateDir), 'utf8'))
    return typeof d?.model === 'string' && d.model ? { model: d.model } : null
  } catch { return null }
}
