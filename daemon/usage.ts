import { closeSync, openSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
}

export type UsageCursor = { offset: number; totals: TokenTotals }

export const zeroTotals = (): TokenTotals => ({
  inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0,
})

export const newCursor = (): UsageCursor => ({ offset: 0, totals: zeroTotals() })

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function transcriptPath(cwd: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectDirName(cwd), `${claudeSessionId}.jsonl`)
}

const CWD_TAIL_BYTES = 256 * 1024

function readRange(path: string, from: number, length: number): string | undefined {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return undefined }
  try {
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, from)
    return buf.subarray(0, read).toString('utf8')
  } catch { return undefined } finally { closeSync(fd) }
}

export function latestCwd(path: string): string | undefined {
  let size: number
  try { size = statSync(path).size } catch { return undefined }
  const from = Math.max(0, size - CWD_TAIL_BYTES)
  const text = readRange(path, from, size - from)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue
    try {
      const cwd = (JSON.parse(lines[i]) as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch { continue }
  }
  return undefined
}

export function totalsChanged(a: TokenTotals, b: TokenTotals): boolean {
  return a.inputTokens !== b.inputTokens || a.outputTokens !== b.outputTokens
    || a.cacheCreateTokens !== b.cacheCreateTokens || a.cacheReadTokens !== b.cacheReadTokens
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

/**
 * Reads only the four token counters out of a Claude transcript. Every value
 * it returns is produced by Number, so no text from the file can escape —
 * that directory holds conversation content.
 */
export function readUsageDelta(path: string, cursor: UsageCursor, maxBytes = 8 * 1024 * 1024): UsageCursor {
  let size: number
  try { size = statSync(path).size } catch { return cursor }
  // Rotated or replaced: re-read from the top rather than trusting the offset.
  const from = size < cursor.offset ? 0 : cursor.offset
  const totals = size < cursor.offset ? zeroTotals() : { ...cursor.totals }
  if (size === from) return { offset: from, totals }

  const want = Math.min(size - from, maxBytes)
  const text = readRange(path, from, want)
  if (text === undefined) return cursor

  // A trailing partial line must not be consumed, or its counters are lost.
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline < 0) return { offset: from, totals }
  for (const line of text.slice(0, lastNewline).split('\n')) {
    if (!line) continue
    let usage: Record<string, unknown> | undefined
    try {
      const o = JSON.parse(line) as { message?: { usage?: unknown }; usage?: unknown }
      const u = o?.message?.usage ?? o?.usage
      if (u && typeof u === 'object') usage = u as Record<string, unknown>
    } catch { continue }
    if (!usage) continue
    totals.inputTokens += int(usage.input_tokens)
    totals.outputTokens += int(usage.output_tokens)
    totals.cacheCreateTokens += int(usage.cache_creation_input_tokens)
    totals.cacheReadTokens += int(usage.cache_read_input_tokens)
  }
  return { offset: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'), totals }
}
