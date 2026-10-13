import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

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
