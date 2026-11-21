// daemon/engines/agy-session.ts
//
// What agy's own files say about a hydra session. agy-hook.ts writes <state>/agy-sessions/<session id>.json (the conversation, its transcript, working or idle);
// the transcript is agy's JSONL, one step per line, and holds the turn's answer and each model call's token counts:
// (the hook names transcript_full.jsonl: the same steps with each tool's whole output; transcript.jsonl cuts them)
//   {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-11-21T04:55:17Z","content":"..."}
//   {"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"...","input_tokens":2358,"cache_read_tokens":7635,"output_tokens":171,"content":"done"}
// A PLANNER_RESPONSE with tool_calls is the model asking for a tool; one with content and no tool_calls is its answer. created_at has whole-second resolution.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { zeroTotals, type TokenTotals } from '../usage.js'

export const agyStateDir = () => join(STATE_DIR, 'agy-sessions')
export const agyStateFile = (sessionId: string): string => join(agyStateDir(), `${sessionId}.json`)

export type AgyState = { conversationId: string; transcriptPath: string; live: 'working' | 'idle'; backgroundWork: boolean }
type Step = { type?: string; created_at?: string; content?: string; tool_calls?: unknown[]; input_tokens?: number; cache_read_tokens?: number; output_tokens?: number }

/** The hook's record for a session; null before agy has sent its first event. */
export function agyState(sessionId: string): AgyState | null {
  try { return JSON.parse(readFileSync(agyStateFile(sessionId), 'utf8')) } catch { return null }
}

// Only the tail is read (a cut first line, or one agy is still writing, is skipped). The hook names agy's full transcript, where a tool's whole output is a line:
// so a turn's tail can hold more than the 256 KB first read, and the read widens until it holds a user input or the whole file.
const TAIL_BYTES = 256 * 1024
// The widening stops here: turn() runs on the daemon's event loop at every health poll, and a turn whose input is further back than this reads as not over (its silence limit ends it).
const MAX_TAIL_BYTES = 16 * 1024 * 1024

function tailSteps(path: string, bytes = TAIL_BYTES): Step[] {
  let text: string
  try {
    const size = statSync(path).size
    const from = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - from)
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
    text = buf.toString('utf8')
  } catch { return [] }
  const out: Step[] = []
  for (const line of text.split('\n')) { try { out.push(JSON.parse(line)) } catch { continue } }
  return out
}

/** The steps from the last user input on (or, with no input in the file, all of it). */
function stepsFromLastAsk(path: string): Step[] {
  for (let bytes = TAIL_BYTES; ; bytes = Math.min(bytes * 4, MAX_TAIL_BYTES)) {
    const steps = tailSteps(path, bytes)
    const i = steps.findLastIndex(s => s.type === 'USER_INPUT')
    if (i >= 0) return steps.slice(i)
    let size = 0
    try { size = statSync(path).size } catch { return [] }
    if (bytes >= size || bytes >= MAX_TAIL_BYTES) return steps
  }
}

const isAnswer = (s: Step | undefined): s is Step => s?.type === 'PLANNER_RESPONSE' && !s.tool_calls?.length && !!s.content?.trim()

/**
 * Is the turn that answers a message delivered at `sinceMs` over, and what did it say? Over: agy has stopped with nothing running, and the
 * transcript ends in an answer that follows a user input from at or after `sinceMs` (so a stop from before the message is never read as its answer).
 */
export function agyTurn(sessionId: string, sinceMs: number): { complete: boolean; text: string | null } {
  const state = agyState(sessionId)
  if (state?.live !== 'idle' || state.backgroundWork) return { complete: false, text: null }
  const steps = stepsFromLastAsk(state.transcriptPath)
  const last = steps.at(-1)
  const asked = steps[0]?.type === 'USER_INPUT' ? steps[0] : undefined
  // created_at is whole seconds: the second the message arrived in counts as at or after it.
  if (!isAnswer(last) || !asked || !(Date.parse(asked.created_at ?? '') >= Math.floor(sinceMs / 1000) * 1000)) return { complete: false, text: null }   // no readable time: not its answer
  return { complete: true, text: last.content! }
}

/** Tokens in context after the last model call: its input plus what came from cache. Null before the first call. */
export function agyContextTokens(sessionId: string): number | null {
  const state = agyState(sessionId)
  const call = state && tailSteps(state.transcriptPath).findLast(s => s.type === 'PLANNER_RESPONSE')
  return call ? (call.input_tokens ?? 0) + (call.cache_read_tokens ?? 0) : null
}

// Spend so far: every model call's counts, summed. `cursor` is the byte offset after the last complete line read, so the next read adds only what agy
// appended since; a different conversation or a shorter file starts over (`restarted`).
export type AgyUsageCursor = { offset: number; totals: TokenTotals; conversationId: string }
const DRAIN_MAX_BYTES = 8 * 1024 * 1024

export function agyUsageTotals(sessionId: string, prev: AgyUsageCursor | undefined): { totals: TokenTotals; providerSessionId: string; cursor: AgyUsageCursor; restarted: boolean } | null {
  const state = agyState(sessionId)
  if (!state) return null
  let size: number
  try { size = statSync(state.transcriptPath).size } catch { return null }
  const restarted = !!prev && (size < prev.offset || prev.conversationId !== state.conversationId)
  const base = prev && !restarted ? prev : { offset: 0, totals: zeroTotals(), conversationId: state.conversationId }
  const buf = Buffer.alloc(Math.min(size - base.offset, DRAIN_MAX_BYTES))
  const fd = openSync(state.transcriptPath, 'r')
  try { readSync(fd, buf, 0, buf.length, base.offset) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  const consumed = Buffer.byteLength(complete)
  const totals = { ...base.totals }
  for (const line of complete.split('\n')) {
    if (!line.includes('"PLANNER_RESPONSE"')) continue
    try {
      const s: Step = JSON.parse(line)
      totals.inputTokens += s.input_tokens ?? 0
      totals.outputTokens += s.output_tokens ?? 0
      totals.cacheReadTokens += s.cache_read_tokens ?? 0
    } catch { continue }
  }
  return { totals, providerSessionId: state.conversationId, cursor: { offset: base.offset + consumed, totals, conversationId: state.conversationId }, restarted }
}
