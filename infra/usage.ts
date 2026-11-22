import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { claudeConfigDir, contextWindowOf } from '../shared/constants.js'
import { isUnder } from './path-containment.js'

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

export function readRange(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, from))
  } finally { closeSync(fd) }
}

// The latest model turn's context: its input plus both cache counters (output is not in the next prompt), and the model that
// served it. Skips synthetic (`<...>` model) and sidechain lines. The tail read doubles until it finds one or has read the whole
// file, so a turn line of any length is found: null means the transcript has no model turn, never "too long to read".
const CONTEXT_TAIL_BYTES = 256 * 1024
export type ContextTurn = { tokens: number; model: string }
export function lastContextTurn(path: string): ContextTurn | null {
  let size: number
  try { size = statSync(path).size } catch { return null }
  for (let tail = CONTEXT_TAIL_BYTES; ; tail *= 2) {
    const from = Math.max(0, size - tail)
    let text: string
    try { text = readRange(path, from, size - from).toString('utf8') } catch { return null }
    const lines = text.split('\n')
    // Past the first newline, a read that starts mid-file begins inside a line: that partial is dropped, not parsed.
    for (let i = lines.length - 1; i >= (from === 0 ? 0 : 1); i--) {
      if (!lines[i].includes('"usage"')) continue
      let o: { isSidechain?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } }
      try { o = JSON.parse(lines[i]) } catch { continue }
      const m = o.message
      if (!m?.usage || o.isSidechain === true || typeof m.model !== 'string' || m.model.startsWith('<')) continue
      return { tokens: int(m.usage.input_tokens) + int(m.usage.cache_creation_input_tokens) + int(m.usage.cache_read_input_tokens), model: m.model }
    }
    if (from === 0) return null
  }
}

// Window suffix and a trailing date stripped: `claude-x-5-20260101` and `claude-x-5[1m]` are the model `claude-x-5`.
const baseModel = (id: string): string => id.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')

export type TranscriptContext = {
  usedTokens: number
  contextWindow: number
  percent: number
  // The window is not the launch model's: the latest turn ran on another model (a `/model` switch), or holds more tokens than
  // the launch window can. The transcript names a model but never its window (no `[1m]`), so a same-model window change shows
  // only as the second case. The window is then a floor (1M once past 200k, else the launch window), not a reading.
  switched: boolean
}

/**
 * The one reading of a Claude session's context from its transcript: the latest turn's tokens over the window of the model
 * the session was launched with. null when the transcript has no model turn or the launch model's window is unknown.
 */
export function transcriptContext(path: string, launchModel: string | undefined): TranscriptContext | null {
  const window = contextWindowOf(launchModel)
  const turn = window ? lastContextTurn(path) : null
  if (!window || !turn) return null
  const a = baseModel(turn.model), b = baseModel(launchModel!)
  const switched = a !== b || turn.tokens > window
  const contextWindow = switched && turn.tokens > 200_000 ? Math.max(window, 1_000_000) : window
  return { usedTokens: turn.tokens, contextWindow, percent: Math.min(100, Math.round(turn.tokens * 100 / contextWindow)), switched }
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
