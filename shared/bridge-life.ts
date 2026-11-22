// A bridge's life record: its events, where its file sits, and how the daemon words a bridge's end. Writing and reading
// the file: infra/bridge-life-file.ts.

import { join } from 'path'

type ExitCause = { ev: 'stdin' | 'signal'; ts: number; ppid: number; detail: string }

export type BridgeLifeEvent =
  | { ev: 'start'; ts: number; pid: number; ppid: number; sessionId: string }
  | { ev: 'wake'; ts: number; gapMs: number }
  | ExitCause
  | { ev: 'error'; ts: number; detail: string }
  | { ev: 'exit'; ts: number; code: number }

export function bridgeLifeDir(stateDir: string): string {
  return join(stateDir, 'bridge-life')
}

export function bridgeLifePath(stateDir: string, sessionId: string, pid: number): string {
  return join(bridgeLifeDir(stateDir), `${sessionId.replace(/[^\w-]/g, '_')}-${pid}.jsonl`)
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s}s`
  const m = Math.round(s / 60)
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`
}

export function describeBridgeExit(events: BridgeLifeEvent[], alive: boolean, now: number): string {
  const cause = events.find((e): e is ExitCause => e.ev === 'signal' || e.ev === 'stdin')
  const exit = events.find(e => e.ev === 'exit')
  const errors = events.filter(e => e.ev === 'error')
  const start = events.find(e => e.ev === 'start')
  const wake = events.filter(e => e.ev === 'wake').at(-1)

  let head: string
  if (cause || exit) {
    const why = !cause ? 'no recorded cause' : cause.ev === 'stdin' ? `stdin ${cause.detail}` : cause.detail
    const outcome = exit ? `exit ${exit.code}` : alive ? 'no exit yet, pid still alive' : 'pid gone without an exit record'
    head = `${why} → ${outcome}`
  } else if (alive) {
    head = 'no exit record, pid still alive'
  } else if (events.length === 0) {
    head = 'pid gone and no life record (file missing or unreadable)'
  } else {
    head = 'pid gone with no exit record — likely SIGKILL or a native crash'
  }

  const end = exit?.ts ?? cause?.ts ?? now
  const notes: string[] = []
  if (start) notes.push(`up ${ago(end - start.ts)}`)
  if (cause && start && cause.ppid !== start.ppid) notes.push(`parent gone (ppid ${start.ppid} → ${cause.ppid})`)
  if (wake) notes.push(`woke from a ${ago(wake.gapMs)} gap ${ago(end - wake.ts)} before`)
  const lastError = errors.at(-1)
  if (lastError) notes.push(`${errors.length} uncaught error(s) recorded, last: ${lastError.detail.replace(/\s+/g, ' ').slice(0, 200)}`)
  if (events.length > 0 && !start) notes.push('no start record')
  return notes.length ? `${head} (${notes.join('; ')})` : head
}
