// Codex spend, read from the thread's rollout JSONL (S10-lite A). Observation
// only: nothing here orders turns or keeps a cursor. The rollout's
// token_count.info.total_token_usage is cumulative per thread, so the LAST one
// is the whole answer.

import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'fs'
import { join } from 'path'
import { codexHomeDir } from './codex-process.js'
import type { TokenTotals } from './usage.js'

const TAIL_CHUNK_BYTES = 64 * 1024
// ponytail: fixed cap; a turn whose tool output alone exceeds this reads as null
// (unresolved) until the next token_count lands after it.
const TAIL_MAX_BYTES = 4 * 1024 * 1024

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

const TOKEN_COUNT = Buffer.from('"token_count"')

function tokenUsageOf(line: Buffer): Record<string, unknown> | null {
  if (line.indexOf(TOKEN_COUNT) < 0) return null
  try {
    const o = JSON.parse(line.toString('utf8'))
    const u = o?.type === 'event_msg' && o.payload?.type === 'token_count' ? o.payload.info?.total_token_usage : undefined
    return u && typeof u === 'object' ? u : null
  } catch { return null }
}

// The last complete token_count's total_token_usage, reading the tail backwards
// in chunks. A final line with no newline is still being written and is ignored.
export function lastTokenUsage(path: string, chunk = TAIL_CHUNK_BYTES, cap = TAIL_MAX_BYTES): Record<string, unknown> | null {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return null }
  try {
    const size = fstatSync(fd).size
    let pos = size
    let pending = Buffer.alloc(0)  // bytes before the earliest line boundary seen so far
    let trimmed = false            // has the partial final line been cut off yet
    while (pos > 0 && size - pos < cap) {
      const start = Math.max(0, pos - chunk)
      const buf = Buffer.alloc(pos - start)
      readSync(fd, buf, 0, buf.length, start)
      pos = start
      pending = Buffer.concat([buf, pending])
      let end = pending.length
      if (!trimmed) {
        end = pending.lastIndexOf(0x0a)
        if (end < 0) continue
        trimmed = true
      }
      // Walk complete lines newest first; the leading segment is complete only at offset 0.
      for (;;) {
        const nl = end === 0 ? -1 : pending.lastIndexOf(0x0a, end - 1)
        if (nl < 0 && pos > 0) break
        const u = tokenUsageOf(pending.subarray(nl + 1, end))
        if (u) return u
        if (nl < 0) break
        end = nl
      }
      pending = pending.subarray(0, end)
    }
    return null
  } catch { return null } finally { closeSync(fd) }
}

const count = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined)

let loggedCacheWrite = false

// input_tokens INCLUDES cached_input_tokens (verified 16481 = 16363 + 118);
// output_tokens already includes reasoning_output_tokens.
export function codexTotals(u: Record<string, unknown>): TokenTotals | null {
  const input = count(u.input_tokens)
  const cached = count(u.cached_input_tokens)
  const output = count(u.output_tokens)
  if (input === undefined || cached === undefined || output === undefined) return null
  const cacheWrite = count(u.cache_write_input_tokens) ?? 0
  if (cacheWrite > 0 && !loggedCacheWrite) {
    loggedCacheWrite = true
    // Q6e: never seen non-zero; whether it is inside input_tokens is unverified.
    process.stderr.write(`daemon: raindrop: codex cache_write_input_tokens=${cacheWrite} seen for the first time — check the input mapping\n`)
  }
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheCreateTokens: cacheWrite,
    cacheReadTokens: cached,
  }
}

export type CodexUsageCursor = { threadId: string; totals: TokenTotals }
export type UsageReading = { totals: TokenTotals; providerSessionId: string; cursor: unknown; restarted: boolean }
type CodexSubject = { tmuxName: string; codexThreadId?: string; codexHomeName?: string }

const decreased = (a: TokenTotals, b: TokenTotals): boolean =>
  b.inputTokens < a.inputTokens || b.outputTokens < a.outputTokens
  || b.cacheCreateTokens < a.cacheCreateTokens || b.cacheReadTokens < a.cacheReadTokens

// Totals are not monotonic (1.46M → 117k seen with no compaction marker), so a
// decrease or a different thread is a restart: new baseline, no delta.
export function codexUsageTotals(s: CodexSubject, prev: unknown, homeDir = codexHomeDir): UsageReading | null {
  const threadId = s.codexThreadId
  if (!threadId) return null
  const path = findRollout(homeDir(s.codexHomeName ?? s.tmuxName), threadId)
  const raw = path ? lastTokenUsage(path) : null
  const totals = raw ? codexTotals(raw) : null
  if (!totals) return null
  const p = prev as CodexUsageCursor | undefined
  const restarted = !!p && (p.threadId !== threadId || decreased(p.totals, totals))
  return { totals, providerSessionId: threadId, cursor: { threadId, totals } satisfies CodexUsageCursor, restarted }
}
