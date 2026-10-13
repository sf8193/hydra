// daemon/engines/omp-session.ts
//
// Reads omp's own session file: one JSONL per hydra session, in the directory OmpEngine passes as --session-dir.
// omp appends each message as it happens: an assistant message with stopReason 'toolUse' means the turn is still
// running, 'stop' is its final answer. Each assistant message carries the token usage of its request.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { zeroTotals, type TokenTotals } from '../usage.js'

export const ompSessionDir = (sessionId: string): string => join(STATE_DIR, 'omp-sessions', sessionId)

type OmpMessage = {
  role?: string
  stopReason?: string
  timestamp?: number
  content?: Array<{ text?: string }> // text blocks carry `text`; thinking and tool-call blocks do not
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number }
}

// Only the tail is read: a message line longer than this reads as absent, so the turn reads not-complete.
const TAIL_BYTES = 256 * 1024

// The `message` entries in the last TAIL_BYTES of the session's file, oldest first (a cut first line or one omp is still writing fails to parse and is skipped).
// Empty before omp has written one.
function tailMessages(sessionId: string): OmpMessage[] {
  const dir = ompSessionDir(sessionId)
  let text: string
  try {
    const file = join(dir, readdirSync(dir).find(n => n.endsWith('.jsonl'))!) // one session file per directory
    const size = statSync(file).size
    const from = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - from)
    const fd = openSync(file, 'r')
    try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
    text = buf.toString('utf8')
  } catch { return [] }
  const out: OmpMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"message"')) continue
    try { const e = JSON.parse(line); if (e.type === 'message' && e.message) out.push(e.message) } catch { continue }
  }
  return out
}

export function ompTurn(sessionId: string, sinceMs: number): { complete: boolean; text: string | null } {
  const last = tailMessages(sessionId).pop()
  if (last?.stopReason !== 'stop' || (last.timestamp ?? 0) < sinceMs) return { complete: false, text: null }
  return { complete: true, text: (last.content ?? []).map(c => c.text ?? '').join('') }
}

// Tokens in context after the last request: its input plus both cache counters (as for Claude, daemon/usage.ts).
export function ompContextTokens(sessionId: string): number | null {
  const msgs = tailMessages(sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const u = msgs[i].usage
    if (msgs[i].role === 'assistant' && u) return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  }
  return null
}

// Spend so far: every assistant message's usage, summed. `cursor` is the byte offset after the last complete line read, so
// the next read adds only what omp appended since; a different or shorter file starts over (`restarted`).
export type OmpUsageCursor = { offset: number; totals: TokenTotals; providerSessionId: string }
const DRAIN_MAX_BYTES = 8 * 1024 * 1024
const HEADER_BYTES = 4096

// The id in the file's `session` header entry (within the first few lines).
function headerSessionId(file: string): string {
  const buf = Buffer.alloc(HEADER_BYTES)
  const fd = openSync(file, 'r')
  let n: number
  try { n = readSync(fd, buf, 0, HEADER_BYTES, 0) } finally { closeSync(fd) }
  for (const line of buf.toString('utf8', 0, n).split('\n')) {
    if (!line.includes('"type":"session"')) continue
    try { return JSON.parse(line).id } catch { return '' }
  }
  return ''
}

export function ompUsageTotals(sessionId: string, prev: OmpUsageCursor | undefined): { totals: TokenTotals; providerSessionId: string; cursor: OmpUsageCursor; restarted: boolean } | null {
  const dir = ompSessionDir(sessionId)
  let file: string, size: number, providerSessionId: string
  try {
    file = join(dir, readdirSync(dir).find(n => n.endsWith('.jsonl'))!)
    size = statSync(file).size
    providerSessionId = headerSessionId(file)
  } catch { return null }
  const restarted = !!prev && (size < prev.offset || (!!prev.providerSessionId && providerSessionId !== prev.providerSessionId))
  const base = prev && !restarted ? prev : { offset: 0, totals: zeroTotals(), providerSessionId }
  const buf = Buffer.alloc(Math.min(size - base.offset, DRAIN_MAX_BYTES))
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, buf.length, base.offset) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  // A full chunk with no newline is the inside of a line longer than the cap: skip it (the rest of that line fails to parse and is skipped too).
  const consumed = complete ? Buffer.byteLength(complete) : buf.length === DRAIN_MAX_BYTES ? buf.length : 0
  const totals = { ...base.totals }
  for (const line of complete.split('\n')) {
    if (!line.includes('"usage"')) continue
    try {
      const e = JSON.parse(line)
      const u = e.type === 'message' && e.message?.role === 'assistant' ? e.message.usage : undefined
      if (!u) continue
      totals.inputTokens += u.input ?? 0
      totals.outputTokens += u.output ?? 0
      totals.cacheCreateTokens += u.cacheWrite ?? 0
      totals.cacheReadTokens += u.cacheRead ?? 0
    } catch { continue }
  }
  return { totals, providerSessionId, cursor: { offset: base.offset + consumed, totals, providerSessionId }, restarted }
}
