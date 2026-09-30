import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { claudeConfigDir } from '../shared/constants.js'
import { isUnder } from '../shared/path-containment.js'
import { DELEGATED_PHASE, INITIAL_PHASE, latchVote, nextLatch, phaseForTurn, toolNamesFrom, USAGE_PHASES, type LatchPhase, type UsagePhase } from './usage-phase.js'

export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
}

export type PhaseTotals = Record<UsagePhase, TokenTotals>

// `latch` rides the cursor because it has to outlive a drain: the window that
// names a phase is rarely the window that spends the tokens.
export type UsageCursor = {
  offset: number
  totals: TokenTotals
  latch: LatchPhase
  phaseTotals: PhaseTotals
  // Phases a turn in THIS read chose. Everything else in phaseTotals was carried.
  voted: readonly UsagePhase[]
  lastMessageId?: string
  // Tools lastMessageId's turn has shown so far, so a turn split across reads
  // is still classified on all of them.
  lastTurnTools?: readonly string[]
  path?: string
  restartedFromZero?: boolean
}

export const zeroTotals = (): TokenTotals => ({
  inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0,
})

export const zeroPhaseTotals = (): PhaseTotals =>
  Object.fromEntries(USAGE_PHASES.map(p => [p, zeroTotals()])) as PhaseTotals

export const newCursor = (): UsageCursor =>
  ({ offset: 0, totals: zeroTotals(), latch: INITIAL_PHASE, phaseTotals: zeroPhaseTotals(), voted: [] })

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

// Tokens in context after the latest model turn: its input plus both cache counters (output is not in the next prompt).
// The tail is bounded; a turn line longer than it reads null. Skips synthetic (`<...>` model) and sidechain lines.
const CONTEXT_TAIL_BYTES = 256 * 1024
export function lastContextTokens(path: string): number | null {
  let text: string
  try {
    const size = statSync(path).size
    const from = Math.max(0, size - CONTEXT_TAIL_BYTES)
    text = readRange(path, from, size - from).toString('utf8')
  } catch { return null }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue
    let o: { isSidechain?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } }
    try { o = JSON.parse(lines[i]) } catch { continue }
    const m = o.message
    if (!m?.usage || o.isSidechain === true || typeof m.model !== 'string' || m.model.startsWith('<')) continue
    return int(m.usage.input_tokens) + int(m.usage.cache_creation_input_tokens) + int(m.usage.cache_read_input_tokens)
  }
  return null
}

export const subtractTotals = (from: TokenTotals, to: TokenTotals): TokenTotals => ({
  inputTokens: to.inputTokens - from.inputTokens,
  outputTokens: to.outputTokens - from.outputTokens,
  cacheCreateTokens: to.cacheCreateTokens - from.cacheCreateTokens,
  cacheReadTokens: to.cacheReadTokens - from.cacheReadTokens,
})

const clonePhaseTotals = (t: PhaseTotals): PhaseTotals =>
  Object.fromEntries(USAGE_PHASES.map(p => [p, { ...t[p] }])) as PhaseTotals

export const sumTotals = (parts: readonly TokenTotals[]): TokenTotals =>
  parts.reduce((a, t) => ({
    inputTokens: a.inputTokens + t.inputTokens,
    outputTokens: a.outputTokens + t.outputTokens,
    cacheCreateTokens: a.cacheCreateTokens + t.cacheCreateTokens,
    cacheReadTokens: a.cacheReadTokens + t.cacheReadTokens,
  }), zeroTotals())

// A transcript can exceed one window several times over.
const MAX_DRAIN_PASSES = 64

export function drainUsage(path: string, cursor: UsageCursor, maxBytes?: number): UsageCursor {
  let next = cursor
  let restartedFromZero = false
  // Unioned across passes: one drain is one telemetry window, and a vote in an
  // early pass still describes that window.
  const voted = new Set<UsagePhase>()
  for (let i = 0; i < MAX_DRAIN_PASSES; i++) {
    const step = readUsageDelta(path, next, maxBytes)
    const done = step.offset === next.offset
    restartedFromZero ||= step.restartedFromZero === true
    for (const p of step.voted) voted.add(p)
    next = step
    if (done) break
  }
  return { ...next, restartedFromZero, voted: [...voted] }
}

export type SessionCursor = {
  main: UsageCursor
  subagents: Record<string, UsageCursor>
  retired: TokenTotals
  // null when a baseline read could not list subagents, so which are missing is unknown.
  missingFromBaseline: string[] | null
}

export const newSessionCursor = (): SessionCursor =>
  ({ main: newCursor(), subagents: {}, retired: zeroTotals(), missingFromBaseline: [] })

export type SessionUsageRead = {
  cursor: SessionCursor
  totals: TokenTotals
  phaseTotals: PhaseTotals
  latch: LatchPhase
  voted: readonly UsagePhase[]
  restarted: boolean
}

const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/
const WORKFLOW_RUN = /^wf_[A-Za-z0-9_-]{1,128}$/

const entriesMatching = (dir: string, pattern: RegExp, wantDir: boolean): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter(e => pattern.test(e.name) && e.isDirectory() === wantDir)
    .map(e => join(dir, e.name))

// existsSync is false on EACCES too, which would read an unlistable directory as an empty one.
const present = (path: string): boolean => {
  try { statSync(path); return true } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw err
  }
}

export function subagentPathsFor(transcript: string): string[] {
  const dir = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents')
  if (!present(dir)) return []
  const workflows = join(dir, 'workflows')
  const runs = present(workflows) ? entriesMatching(workflows, WORKFLOW_RUN, true) : []
  const root = projectsRoot()
  return [dir, ...runs]
    .flatMap(d => entriesMatching(d, SUBAGENT_FILE, false))
    .filter(p => isUnder(p, root, { realpath: true }))
}

// Logged, not thrown: one unreadable subagent must not silence the parent's own spend.
const subagentReadFailed = (where: string, err: unknown): void => {
  process.stderr.write(`daemon: raindrop: subagent usage read failed: ${where}: ${err instanceof Error ? err.message : String(err)}\n`)
}

type SubagentState = Pick<SessionCursor, 'subagents' | 'retired'>

function readSubagents(transcript: string, from: SubagentState, maxBytes?: number): SubagentState & { failed: string[] | null; shrank: boolean } {
  const subagents = { ...from.subagents }
  let retired = from.retired
  let paths: string[]
  try { paths = subagentPathsFor(transcript) } catch (err) {
    subagentReadFailed(transcript, err)
    return { subagents, retired, failed: null, shrank: false }
  }
  const failedPaths: string[] = []
  let shrank = false
  for (const path of paths) {
    const seen = subagents[path]
    let next: UsageCursor
    try { next = drainUsage(path, seen ?? newCursor(), maxBytes) } catch (err) { subagentReadFailed(path, err); failedPaths.push(path); continue }
    // A rotated file keeps what it spent, so the cumulative never falls; what it re-read may already be delivered.
    if (seen && next.restartedFromZero) {
      retired = sumTotals([retired, seen.totals])
      shrank ||= totalsChanged(zeroTotals(), next.totals)
    }
    subagents[path] = next
  }
  return { subagents, retired, failed: failedPaths, shrank }
}

const delegatedOf = (s: SubagentState): TokenTotals =>
  sumTotals([s.retired, ...Object.values(s.subagents).map(c => c.totals)])

export function drainSession(transcript: string, prev: SessionCursor, maxBytes?: number): SessionUsageRead {
  const main = drainUsage(transcript, prev.main, maxBytes)
  const parentRestarted = main.restartedFromZero === true
  // Old-path cursors would double-count a moved parent's subagents.
  const read = readSubagents(transcript, parentRestarted ? newSessionCursor() : prev, maxBytes)
  const missing = prev.missingFromBaseline
  // A subagent the banked baseline lacks re-banks when it reads, or its whole history arrives as a delta.
  const healed = Object.keys(read.subagents)
    .some(path => !(path in prev.subagents) && (missing === null || missing.includes(path))
      && totalsChanged(zeroTotals(), read.subagents[path].totals))
  const restarted = parentRestarted || healed || read.shrank
  const delegated = delegatedOf(read)
  const spent = totalsChanged(delegatedOf(prev), delegated)
  return {
    cursor: { main, subagents: read.subagents, retired: read.retired, missingFromBaseline: (parentRestarted || missing === null) ? read.failed : missing },
    totals: sumTotals([main.totals, delegated]),
    phaseTotals: { ...main.phaseTotals, [DELEGATED_PHASE]: sumTotals([main.phaseTotals[DELEGATED_PHASE], delegated]) },
    latch: main.latch,
    voted: spent ? [...main.voted, DELEGATED_PHASE] : main.voted,
    restarted,
  }
}

export function totalsChanged(a: TokenTotals, b: TokenTotals): boolean {
  return a.inputTokens !== b.inputTokens || a.outputTokens !== b.outputTokens
    || a.cacheCreateTokens !== b.cacheCreateTokens || a.cacheReadTokens !== b.cacheReadTokens
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)

const addUsage = (into: TokenTotals, usage: Record<string, unknown>): void => {
  into.inputTokens += int(usage.input_tokens)
  into.outputTokens += int(usage.output_tokens)
  into.cacheCreateTokens += int(usage.cache_creation_input_tokens)
  into.cacheReadTokens += int(usage.cache_read_input_tokens)
}

// One turn of a transcript. A turn is spread over one line per content block,
// each line repeating the whole usage envelope — and the tool_use blocks land on
// the lines the envelope dedupe drops (93% of multi-line turns in the sampled
// transcript), so the tools have to be gathered across the group before the
// envelope is attributed.
type Turn = { id?: string; usage?: Record<string, unknown>; tools: string[] }

// Separated from the folding below so it is unit-testable without touching fs.
export function turnsIn(text: string): Turn[] {
  const turns: Turn[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let message: { id?: unknown; usage?: unknown; content?: unknown } | undefined
    try { message = (JSON.parse(line) as { message?: typeof message }).message } catch { continue }
    if (!message || typeof message !== 'object') continue
    const usage = message.usage && typeof message.usage === 'object'
      ? message.usage as Record<string, unknown>
      : undefined
    const tools = toolNamesFrom(message.content)
    // A line that carries neither is structure, not spend.
    if (!usage && tools.length === 0) continue
    const id = typeof message.id === 'string' ? message.id : undefined
    const open = turns.at(-1)
    // An id-less line can be neither deduped nor grouped, so it stands alone.
    if (id !== undefined && open?.id === id) { open.tools.push(...tools); open.usage ??= usage }
    else turns.push({ id, usage, tools })
  }
  return turns
}

// Returns only Number-produced counters and a closed-set phase, so no
// transcript text can escape.
export function readUsageDelta(path: string, cursor: UsageCursor, maxBytes = 8 * 1024 * 1024): UsageCursor {
  // Loud: a transcript that quietly stops being readable reports zero forever.
  const size = statSync(path).size
  // Rotated or replaced: re-read from the top rather than trusting the offset.
  const rotated = size < cursor.offset || cursor.path !== path
  const from = rotated ? 0 : cursor.offset
  const totals = rotated ? zeroTotals() : { ...cursor.totals }
  const phaseTotals = rotated ? zeroPhaseTotals() : clonePhaseTotals(cursor.phaseTotals)
  // Repaired here, once, so nothing downstream has to re-check a value that
  // indexes phaseTotals.
  let latch = rotated ? INITIAL_PHASE : nextLatch(cursor.latch, [])
  let lastMessageId = rotated ? undefined : cursor.lastMessageId
  let lastTurnTools: readonly string[] = rotated ? [] : cursor.lastTurnTools ?? []
  const voted = new Set<UsagePhase>()
  const done = (offset: number): UsageCursor =>
    ({ offset, totals, latch, phaseTotals, voted: [...voted], lastMessageId, lastTurnTools, path, restartedFromZero: rotated })
  if (size === from) return done(from)

  const buf = readRange(path, from, Math.min(size - from, maxBytes))

  // A trailing partial line is left for the next read — unless the window is
  // full, where waiting for its newline would stall this session forever.
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < 0) return done(size - from > maxBytes ? from + buf.length : from)

  for (const turn of turnsIn(buf.subarray(0, lastNewline).toString('utf8'))) {
    // A turn's blocks can straddle the read boundary, so classify it on every
    // tool it has shown, not just the ones in this window. Voting on the tail
    // alone lets a late Edit outrank an Agent that `latchVote` ranks above it.
    const continues = turn.id !== undefined && turn.id === lastMessageId
    const tools = continues ? [...lastTurnTools, ...turn.tools] : turn.tools
    lastTurnTools = turn.id !== undefined ? tools : lastTurnTools
    // The tools move the latch BEFORE this turn's tokens are attributed, which
    // stops a session that edits and then delegates billing the handoff to `execute`.
    const vote = latchVote(tools)
    latch = nextLatch(latch, tools)
    const phase = phaseForTurn(latch, tools)
    if (vote !== undefined) voted.add(vote)
    if (phase === 'report') voted.add('report')
    if (!turn.usage) continue
    if (turn.id !== undefined) {
      if (turn.id === lastMessageId) continue
      lastMessageId = turn.id
    }
    addUsage(totals, turn.usage)
    addUsage(phaseTotals[phase], turn.usage)
  }
  // KNOWN LIMIT, measured: a turn straddling the window edge books its envelope
  // at the phase the first read saw. A latched phase recovers on the next turn;
  // `report` cannot, having no latch, so it alone loses one-directionally —
  // 5-12% of its own bucket depending on tick cadence. Totals stay exact; only
  // the split moves. Retro-attributing would emit a negative delta once the
  // baseline is delivered, and deferring the open turn silences idle sessions.
  return done(from + lastNewline + 1)
}
