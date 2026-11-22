// A bridge's life record on disk: one JSONL file per bridge process, appended as it starts, wakes, errs and exits, and
// read back when the daemon explains a bridge that went away. The record's shape, path and wording: shared/bridge-life.ts.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { bridgeLifeDir, type BridgeLifeEvent } from '../shared/bridge-life.js'

export function appendBridgeLife(path: string, event: BridgeLifeEvent): void {
  try {
    if (event.ev === 'start') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, JSON.stringify(event) + '\n')
  } catch (err) {
    try { process.stderr.write(`bridge: life record write failed (${path}): ${err}\n`) } catch {}
  }
}

export function readBridgeLife(path: string): BridgeLifeEvent[] {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  const events: BridgeLifeEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line) as BridgeLifeEvent) } catch {}
  }
  return events
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function pruneBridgeLife(stateDir: string, maxAgeMs: number, now: number): void {
  const dir = bridgeLifeDir(stateDir)
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    const path = join(dir, name)
    const pid = Number(name.match(/-(\d+)\.jsonl$/)?.[1])
    try {
      if (pid && pidAlive(pid)) continue
      if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path)
    } catch {}
  }
}
