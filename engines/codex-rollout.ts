// The thread's rollout JSONL: where it lives, and its latest turn boundary. Observation only:
// nothing here orders turns or keeps a cursor.

import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'fs'
import { join } from 'path'

const TAIL_CHUNK_BYTES = 64 * 1024

const rolloutMemo = new Map<string, string>()

// <home>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl. Only hits are memoized:
// a thread whose first turn hasn't flushed yet is looked for again next time.
export function findRollout(homeDir: string, threadId: string): string | undefined {
  const key = `${homeDir}\0${threadId}`
  const hit = rolloutMemo.get(key)
  if (hit) return hit
  const suffix = `-${threadId}.jsonl`
  const root = join(homeDir, 'sessions')
  const desc = (dir: string): string[] => { try { return readdirSync(dir).sort().reverse() } catch { return [] } }
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    const name = desc(join(root, y, m, d)).find(f => f.startsWith('rollout-') && f.endsWith(suffix))
    if (name) {
      const path = join(root, y, m, d, name)
      rolloutMemo.set(key, path)
      return path
    }
  }
  return undefined
}

export function _resetRolloutMemoForTesting(): void { rolloutMemo.clear() }

// ---- Turn boundary: task_started / task_complete / turn_aborted ------------------------------
// The same rollout's event_msg task_started / task_complete / turn_aborted records are a durable turn
// boundary that does not depend on the app-server socket delivering turnCompleted. A CLOSED boundary is
// definitive; an OPEN one is not proof of work (a killed session ends its file open).

export type TurnBoundary = 'open' | 'closed'

// The latest turn boundary in the thread's rollout tail, or null when unknown (no file, no boundary in view).
// `answer`/`at` are the boundary line's own: a task_complete's last_agent_message and its timestamp (epoch ms);
// null for an open boundary, an abort, or a line without them.
// ponytail: one 64KB tail; a turn whose latest boundary is further back reads null (5 of 190 real files), which
// is the safe direction. A growing backwards walk would fix that if it ever matters.
export type CodexLastTurn = { boundary: TurnBoundary; answer: string | null; at: number | null }

export function codexLastTurn(homeDir: string, threadId: string): CodexLastTurn | null {
  const path = findRollout(homeDir, threadId)
  if (!path) return null
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, TAIL_CHUNK_BYTES))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"event_msg"')) continue
      let raw: unknown
      try { raw = JSON.parse(lines[i]) } catch { continue }
      if (!raw || typeof raw !== 'object') continue
      const m = raw as { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; last_agent_message?: unknown } }
      const type = m.type === 'event_msg' ? m.payload?.type : undefined
      if (type !== 'task_started' && type !== 'task_complete' && type !== 'turn_aborted') continue
      const at = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN
      const text = type === 'task_complete' ? m.payload?.last_agent_message : undefined
      return {
        boundary: type === 'task_started' ? 'open' : 'closed',
        answer: typeof text === 'string' && text.trim() ? text : null,
        at: Number.isFinite(at) ? at : null,
      }
    }
    return null
  } catch { return null } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

