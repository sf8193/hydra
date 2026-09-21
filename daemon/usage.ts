import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { claudeConfigDir } from '../shared/constants.js'
import { isUnder } from '../shared/path-containment.js'

export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
}

export type UsageCursor = { offset: number; totals: TokenTotals; lastMessageId?: string; path?: string; restartedFromZero?: boolean }

export const zeroTotals = (): TokenTotals => ({
  inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0,
})

export const newCursor = (): UsageCursor => ({ offset: 0, totals: zeroTotals() })

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// Late-bound: config.ts sources .env at import, after a module-scope constant here would resolve.
export const projectsRoot = (): string => join(claudeConfigDir(), 'projects')

// Scans rather than deriving: the dir follows the STARTING cwd, which a resume outlives.
export function projectDirNames(): string[] {
  return readdirSync(projectsRoot())
}

// A session id becomes a path segment here, and it arrives from the bridge as
// an unvalidated cast — so `..` would otherwise resolve out of the root.
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

export function transcriptPathFor(claudeSessionId: string | undefined): string | undefined {
  if (!claudeSessionId || !SESSION_ID_SHAPE.test(claudeSessionId)) return undefined
  const root = projectsRoot()
  let dirs: string[]
  try { dirs = projectDirNames() } catch { return undefined }
  for (const dir of dirs) {
    const p = join(root, dir, `${claudeSessionId}.jsonl`)
    // A symlinked entry inside the root still resolves out of it.
    if (existsSync(p) && isUnder(p, root, { realpath: true })) return p
  }
  return undefined
}

// Only the cost is pinned, not the value — the widen below finds the same cwd either way.
const CWD_TAIL_BYTES = 256 * 1024
const CWD_WIDE_TAIL_BYTES = 8 * 1024 * 1024

function readRange(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, from))
  } finally { closeSync(fd) }
}

export function latestCwd(path: string, tailBytes = CWD_TAIL_BYTES, wideBytes = CWD_WIDE_TAIL_BYTES): string | undefined {
  let size: number
  try { size = statSync(path).size } catch { return undefined }
  const from = Math.max(0, size - tailBytes)
  const fromTail = readCwdFrom(path, from, size)
  // Already the whole file — widening would re-read the same bytes.
  if (fromTail || from === 0) return fromTail
  // One line longer than the tail leaves nothing parseable; widen once, still bounded.
  return readCwdFrom(path, Math.max(0, size - wideBytes), size)
}

// Attribution, not accounting: an unreadable transcript costs only a repo name.
function readCwdFrom(path: string, from: number, size: number): string | undefined {
  let text: string
  try { text = readRange(path, from, size - from).toString('utf8') } catch { return undefined }
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

export const subtractTotals = (from: TokenTotals, to: TokenTotals): TokenTotals => ({
  inputTokens: to.inputTokens - from.inputTokens,
  outputTokens: to.outputTokens - from.outputTokens,
  cacheCreateTokens: to.cacheCreateTokens - from.cacheCreateTokens,
  cacheReadTokens: to.cacheReadTokens - from.cacheReadTokens,
})

// A transcript can exceed one window several times over.
const MAX_DRAIN_PASSES = 64

export function drainUsage(path: string, cursor: UsageCursor, maxBytes?: number): UsageCursor {
  let next = cursor
  let restartedFromZero = false
  for (let i = 0; i < MAX_DRAIN_PASSES; i++) {
    const step = readUsageDelta(path, next, maxBytes)
    const done = step.offset === next.offset
    restartedFromZero ||= step.restartedFromZero === true
    next = step
    if (done) break
  }
  return { ...next, restartedFromZero }
}

export function totalsChanged(a: TokenTotals, b: TokenTotals): boolean {
  return a.inputTokens !== b.inputTokens || a.outputTokens !== b.outputTokens
    || a.cacheCreateTokens !== b.cacheCreateTokens || a.cacheReadTokens !== b.cacheReadTokens
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)

// Returns only Number-produced counters, so no transcript text can escape.
export function readUsageDelta(path: string, cursor: UsageCursor, maxBytes = 8 * 1024 * 1024): UsageCursor {
  // Loud: a transcript that quietly stops being readable reports zero forever.
  const size = statSync(path).size
  // Rotated or replaced: re-read from the top rather than trusting the offset.
  const rotated = size < cursor.offset || cursor.path !== path
  const from = rotated ? 0 : cursor.offset
  const totals = rotated ? zeroTotals() : { ...cursor.totals }
  let lastMessageId = rotated ? undefined : cursor.lastMessageId
  if (size === from) return { offset: from, totals, lastMessageId, path, restartedFromZero: rotated }

  const buf = readRange(path, from, Math.min(size - from, maxBytes))

  // A trailing partial line is left for the next read — unless the window is
  // full, where waiting for its newline would stall this session forever.
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    return { offset: size - from > maxBytes ? from + buf.length : from, totals, lastMessageId, path, restartedFromZero: rotated }
  }
  for (const line of buf.subarray(0, lastNewline).toString('utf8').split('\n')) {
    if (!line) continue
    let usage: Record<string, unknown> | undefined
    let messageId: string | undefined
    try {
      const o = JSON.parse(line) as { message?: { id?: unknown; usage?: unknown } }
      const u = o?.message?.usage
      if (u && typeof u === 'object') usage = u as Record<string, unknown>
      if (typeof o?.message?.id === 'string') messageId = o.message.id
    } catch { continue }
    if (!usage) continue
    // One line per content block, each repeating the turn's whole usage envelope.
    if (messageId !== undefined && messageId === lastMessageId) continue
    if (messageId !== undefined) lastMessageId = messageId
    totals.inputTokens += int(usage.input_tokens)
    totals.outputTokens += int(usage.output_tokens)
    totals.cacheCreateTokens += int(usage.cache_creation_input_tokens)
    totals.cacheReadTokens += int(usage.cache_read_input_tokens)
  }
  return { offset: from + lastNewline + 1, totals, lastMessageId, path, restartedFromZero: rotated }
}
