import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

// Session-to-session sends reach the recipient's session in full. Discord shows a
// one-line ticker entry instead of the whole text, unless the send is for the human.

/** Past this many characters the recipient gets a file path and the opening lines, not the whole text. */
export const SPILL_THRESHOLD = 4000
const HEAD_LINES = 6
const HEAD_MAX_CHARS = 600
const TICKER_SUMMARY_MAX = 140
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
  return flat.length > TICKER_SUMMARY_MAX ? `${flat.slice(0, TICKER_SUMMARY_MAX - 1)}…` : flat
}

export function tickerLine(from: string, to: string, type: SendType, text: string, summary?: string, path?: string): string {
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

/** Whether a send goes to the ticker instead of the recipient's thread. A protocol child's result must be posted to count, so it stays loud. */
export function shouldQuiet(o: { tickerThreadId?: string; protocolParticipant: boolean }): boolean {
  return !!o.tickerThreadId && !o.protocolParticipant
}

export type QuietIO = { postTicker: (line: string) => Promise<unknown>; log: (msg: string) => void }

/**
 * Prepares what the recipient session is shown and posts the ticker line. Neither step
 * may stop delivery: a spill failure delivers the full text, and a ticker failure is
 * logged and reported as ticked=false. Nothing is ever posted to the recipient's thread
 * in its place: only a session's own reply reaches the human.
 */
export async function quietSend(
  o: { from: string; to: string; type: SendType; text: string; summary?: string; dir: string },
  io: QuietIO,
): Promise<{ delivered: string; ticked: boolean }> {
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
    await io.postTicker(tickerLine(o.from, o.to, o.type, o.text, o.summary, path))
    return { delivered, ticked: true }
  } catch (err) {
    io.log(`quiet-send: ticker post failed, line skipped: ${err instanceof Error ? err.message : err}`)
    return { delivered, ticked: false }
  }
}
