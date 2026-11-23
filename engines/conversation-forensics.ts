// What a Claude transcript (JSONL) says about its conversation: the last turns, the answer, queued work. Pure file reading, no daemon state.

import { readFileSync, statSync, fstatSync, openSync, readSync, closeSync } from 'fs'

export type ConversationForensics = {
  tailTurns: number
  lastStopReason: string | null
  lastToolCalled: string | null
  lastToolPending: boolean
  pendingToolCount: number
  tailApiCalls: number
  lastAssistantText: string | null
  isTail: boolean
  // Untruncated text of the assistant's LAST text block overall (not
  // necessarily from the same message as lastAssistantText, which only
  // updates per-turn above — this tracks the true last one), its message's
  // timestamp (for staleness checks against when a reply was expected), and
  // whether that same turn ended on a completed text answer (stop_reason
  // 'end_turn'/'stop_sequence') rather than mid tool-call ('tool_use') —
  // relaying a "let me check X..." fragment as if it were the answer is a
  // real failure mode, not a hypothetical one.
  lastAssistantFullText: string | null
  lastAssistantTs: string | null
  // A later tool_use entry (tool-only, or split from the text into its own entry)
  // resets this to false: a complete answer must not be followed by a tool call.
  // That fails safe — a real answer followed by an unrelated tool call is just not
  // treated as complete, never misrepresented.
  lastAssistantTurnComplete: boolean
  // Claude logs queue-operation enqueue when a channel message arrives, and dequeue
  // (between turns) or remove (injected into the running turn) when consumed. Backlog =
  // enqueued but not consumed, counted over the tail: a consume with no enqueue in view
  // clamps at 0 and can cancel an in-view enqueue (only in the gap between two turns).
  // lastConsumeTs (named for both ops) is the latest consume.
  queueBacklog: number
  lastConsumeTs: string | null
}

// Reads the tail of a transcript file, splitting into complete JSON lines.
// A tail read can start mid-line; the naive fix (always drop the first
// split element) is wrong when the byte offset happens to land exactly on a
// line boundary — it then discards a perfectly valid line instead of a
// partial one. Parse-and-check is the only way to tell the two apart.
function readTailLines(fd: number, size: number, tailBytes: number): { lines: string[]; isTail: boolean } {
  const isTail = size > tailBytes
  const offset = Math.max(0, size - tailBytes)
  const buf = Buffer.alloc(Math.min(size, tailBytes))
  readSync(fd, buf, 0, buf.length, offset)
  const rawLines = buf.toString('utf8').split('\n')
  if (isTail && rawLines.length > 0) {
    try { JSON.parse(rawLines[0]) } catch { rawLines.shift() } // genuinely partial — drop it; a valid first line survives
  }
  return { lines: rawLines.filter(l => l.trim()), isTail }
}

// The consume line for the latest message can sit far back (a long turn with big tool output), so
// widen the window until it is in view. Capped: this is a sync read on the daemon poll path, and
// a transcript with no consume line at all would otherwise be parsed in full every tick. Past the
// cap lastConsumeTs stays null, which callers already treat as unknown (silence-timer fallback).
const MAX_TAIL_BYTES = 8 * 1024 * 1024
export function readConversationForensics(transcriptPath: string): ConversationForensics | null {
  for (let tailBytes = 32 * 1024; ; tailBytes *= 4) {
    const f = forensicsFromTail(transcriptPath, tailBytes)
    if (!f || f.lastConsumeTs || !f.isTail || tailBytes >= MAX_TAIL_BYTES) return f
  }
}

function forensicsFromTail(transcriptPath: string, tailBytes: number): ConversationForensics | null {
  let fd: number | undefined
  try {
    fd = openSync(transcriptPath, 'r')
    const stat = fstatSync(fd)
    const { lines, isTail } = readTailLines(fd, stat.size, tailBytes)
    closeSync(fd)
    fd = undefined
    let tailTurns = 0
    let lastStopReason: string | null = null
    let lastToolCalled: string | null = null
    let lastAssistantText: string | null = null
    let lastAssistantFullText: string | null = null
    let lastAssistantTs: string | null = null
    let lastAssistantTurnComplete = false
    let tailApiCalls = 0
    let queueBacklog = 0
    let lastConsumeTs: string | null = null
    const lastTurnToolIds = new Set<string>()
    const answeredToolIds = new Set<string>()

    type TranscriptBlock = { type?: unknown; name?: unknown; id?: unknown; text?: unknown; tool_use_id?: unknown }
    type TranscriptEntry = {
      type?: unknown
      operation?: unknown
      timestamp?: unknown
      message?: { stop_reason?: unknown; content?: unknown; usage?: unknown }
    }

    for (const line of lines) {
      let raw: unknown
      try { raw = JSON.parse(line) } catch { continue }
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as TranscriptEntry

      if (entry.type === 'queue-operation') {
        if (entry.operation === 'enqueue') queueBacklog++
        else if (entry.operation === 'dequeue' || entry.operation === 'remove') {
          queueBacklog = Math.max(0, queueBacklog - 1)
          if (typeof entry.timestamp === 'string' && entry.timestamp) lastConsumeTs = entry.timestamp
        }
        continue
      }

      if (entry.type === 'assistant') {
        tailTurns++
        const msg = entry.message
        if (!msg) continue
        lastStopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : null
        lastTurnToolIds.clear()
        const content = msg.content
        let sawTextThisTurn = false
        if (Array.isArray(content)) {
          for (const rawBlock of content) {
            if (!rawBlock || typeof rawBlock !== 'object') continue
            const block = rawBlock as TranscriptBlock
            if (block.type === 'tool_use') {
              lastToolCalled = typeof block.name === 'string' ? block.name : null
              if (typeof block.id === 'string' && block.id) lastTurnToolIds.add(block.id)
            }
            if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              lastAssistantText = block.text.slice(0, 200)
              lastAssistantFullText = block.text
              lastAssistantTs = typeof entry.timestamp === 'string' ? entry.timestamp : null
              sawTextThisTurn = true
            }
          }
        }
        // A turn can emit a text block *and* a tool_use in the same message
        // (e.g. "Let me check that..." + a tool call) — only trust it as a
        // real answer if this turn didn't also reach for a tool.
        if (sawTextThisTurn) {
          lastAssistantTurnComplete = lastTurnToolIds.size === 0 && msg.stop_reason !== 'tool_use'
        } else if (lastTurnToolIds.size > 0) {
          // Claude logs each content block as its own entry: text, then the tool_use in a LATER entry.
          // A tool call after the text means that text was narration, not the answer.
          lastAssistantTurnComplete = false
        }
        if (msg.usage) tailApiCalls++
      }

      if (entry.type === 'user') {
        const content = entry.message?.content
        if (Array.isArray(content)) {
          for (const rawBlock of content) {
            if (!rawBlock || typeof rawBlock !== 'object') continue
            const block = rawBlock as TranscriptBlock
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
              answeredToolIds.add(block.tool_use_id)
            }
          }
        }
      }
    }

    const pendingIds = [...lastTurnToolIds].filter(id => !answeredToolIds.has(id))
    const lastToolPending = pendingIds.length > 0
    return {
      tailTurns, lastStopReason, lastToolCalled, lastToolPending, pendingToolCount: pendingIds.length,
      tailApiCalls, lastAssistantText, isTail, lastAssistantFullText, lastAssistantTs, lastAssistantTurnComplete,
      queueBacklog, lastConsumeTs,
    }
  } catch {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    return null
  }
}
