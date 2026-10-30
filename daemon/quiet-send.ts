import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

// Session-to-session sends reach the recipient's session in full. The recipient's thread
// shows a one-line note instead of the whole text.

/** Past this many characters the recipient gets a file path and the opening lines, not the whole text. */
export const SPILL_THRESHOLD = 4000
const HEAD_LINES = 6
const HEAD_MAX_CHARS = 600
const NOTE_SUMMARY_MAX = 140
const SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000

const TYPE_MARK = { progress: '·', question: '?', result: '✓' } as const
export type SendType = keyof typeof TYPE_MARK

/** The sender's own summary, else the first non-empty line: one line, bounded, identifiers intact. */
export function oneLine(text: string, summary?: string): string {
  const source = summary?.trim() || text.split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  const flat = source
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/<(?=[@#&])/g, '<\u200b')
  return flat.length > NOTE_SUMMARY_MAX ? `${flat.slice(0, NOTE_SUMMARY_MAX - 1)}…` : flat
}

export function noteLine(from: string, to: string, type: SendType, text: string, summary?: string, path?: string): string {
  const line = `${from} → ${to} ${TYPE_MARK[type]} ${oneLine(text, summary)}`
  return path ? `${line} · \`${path}\`` : line
}

function sweep(dir: string, now: number): void {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (now - statSync(p).mtimeMs > SPILL_TTL_MS) unlinkSync(p)
    }
  } catch {}
}

/** Long text is saved under <dir>; the returned text is what the recipient session is shown. */
export function spillIfLong(text: string, dir: string, from: string, to: string, now = Date.now()): { text: string; path?: string } {
  if (text.length <= SPILL_THRESHOLD) return { text }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweep(dir, now)
  const safe = (s: string) => s.replace(/[^\w-]/g, '_')
  const path = join(dir, `${now}-${safe(from)}-to-${safe(to)}-${randomBytes(3).toString('hex')}.md`)
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' })
  const head = text.split('\n').slice(0, HEAD_LINES).join('\n').slice(0, HEAD_MAX_CHARS)
  return { text: `${head}\n[full text: ${path}]`, path }
}

/** Whether a send is shown as a one-line note. A protocol child's result must be posted in full to count, so it stays loud. */
export function shouldQuiet(o: { protocolParticipant: boolean; hasFiles: boolean }): boolean {
  return !o.protocolParticipant && !o.hasFiles
}

export type QuietIO = { postLine: (line: string) => Promise<unknown>; log: (msg: string) => void }

/**
 * Prepares what the recipient session is shown and posts the one-line note. Neither step
 * may stop delivery: a spill failure delivers the full text, and a note failure is
 * logged and reported as posted=false. The note is a notice, not the sender speaking to
 * the human: only a session's own reply does that.
 */
export async function quietSend(
  o: { from: string; to: string; type: SendType; text: string; summary?: string; dir: string },
  io: QuietIO,
): Promise<{ delivered: string; posted: boolean }> {
  let delivered = o.text
  let path: string | undefined
  try {
    const spilled = spillIfLong(o.text, o.dir, o.from, o.to)
    delivered = spilled.text
    path = spilled.path
  } catch (err) {
    io.log(`quiet-send: spill failed, delivering full text: ${err instanceof Error ? err.message : err}`)
  }
  try {
    await io.postLine(noteLine(o.from, o.to, o.type, o.text, o.summary, path))
    return { delivered, posted: true }
  } catch (err) {
    io.log(`quiet-send: note post failed, line skipped: ${err instanceof Error ? err.message : err}`)
    return { delivered, posted: false }
  }
}
