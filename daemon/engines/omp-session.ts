// daemon/engines/omp-session.ts
//
// Reads omp's own session file: one JSONL per hydra session, in the directory OmpEngine passes as --session-dir.
// omp appends each message as it happens: an assistant message with stopReason 'toolUse' means the turn is still
// running, 'stop' is its final answer. Each assistant message carries the token usage of its request.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'

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
