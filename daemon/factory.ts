// Factory protocol — async build→review cycle with daemon enforcement.
//
// Flow:
//   1. PM calls factory_build → returns ticket immediately
//   2. Daemon forks PM → Builder (full context + write access, NOT ephemeral)
//   3. Builder implements spec, calls factory_done tool with structured artifact
//   4. Daemon starts adversarial review in builder's thread
//      Builder is the review OWNER — defends its own code
//   5. Review completes → builder stays alive, PM gets notification
//   6. PM decides: factory_accept (kill builder, done) / factory_retry (send
//      new instructions, re-enter build→review) / factory_abandon (kill, abort)

import { randomBytes } from 'crypto'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { appendFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync, readdirSync, realpathSync } from 'fs'
import { join, resolve, relative } from 'path'
import { gateway } from './config.js'
import { doSpawnSession, killSession as _killSession } from './session-lifecycle.js'
import { checkUnpushedCommits } from './worktree-manager.js'
import { getWatchesBySession, restoreWatches } from './pr-watch.js'
import { startProtocolRun, getRunByThread, cancelRun, protocolEvents } from './protocol-runner.js'
import type { CompletionEvent } from './protocol-types.js'
import reviewProto from '../protocols/review.js'
import { registry, threadRegistry, sessionEmoji, setToolDescription, removeToolDescriptions } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { safeSend, safeEdit, formatDuration, getContextPercent } from './util.js'
import { defaultToolDescription } from './bridge-tools.js'
import { resolveModelAlias, isKnownModel } from '../shared/constants.js'
import { transport } from './bridge-transport.js'
import { on } from './event-bus.js'
import { pushToolSurface } from './tool-surface.js'
import { registerProtocol } from './protocol-registry.js'
import { clearBuilderNudge } from './pane-probe.js'

// Late-bound so tests can substitute a recording fake (mirrors
// protocol-runner's setLifecycle). Production always uses the real kill.
let killSession = _killSession

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactoryPhase = 'building' | 'reviewing' | 'awaiting_pm' | 'complete' | 'failed'

export type FactoryBuildState = {
  ticket: string
  pmThreadId: string
  pmSessionId: string
  spec: string
  specTag?: string      // short semantic label derived from spec at creation — display identity
  builderModel?: string
  builderSessionId?: string
  builderThreadId?: string
  reviewerModel?: string
  reviewRounds: number
  phase: FactoryPhase
  retryCount: number
  createdAt: number
  reviewed: boolean
  worktree?: string
  diffGistUrl?: string  // set at factory_done time, included in review-complete notification
  prUrl?: string        // set at factory_done time for worktree builds; preferred over gist in notification
  reviewSummary?: string // captured from builder's [summary] post at review completion
  reviewMessageId?: string // ID of the review-complete message — accept links back to it
  builderName?: string  // snapshot of the builder's session name — outlives the registry entry
  _awaitingPmTimer?: ReturnType<typeof setTimeout>  // TTL on the awaiting_pm phase (see AWAITING_PM_TTL_MS)
  _awaitingPmSince?: number  // when that TTL was armed — the only way to report time remaining
}

// ---------------------------------------------------------------------------
// State — keyed by ticket (supports parallel builds per PM)
// ---------------------------------------------------------------------------

const builds = new Map<string, FactoryBuildState>()

// Reverse lookups
const builderSessionToTicket = new Map<string, string>()   // builderSessionId → ticket
const builderThreadToTicket = new Map<string, string>()     // builderThreadId → ticket

const pmReviewFailures = new Map<string, number>()  // pmThreadId → consecutive review failure count

let ticketCounter = 0

// Build history log.
//
// Late-bound: an explicit state-dir override takes the log with it, which is
// what stops `bun test` appending to the operator's real build history —
// test-setup.ts points that var at a throwaway dir. A default-configured daemon
// sets neither var and keeps ~/.hydra/factory.
function logDir(): string {
  const override = process.env.HYDRA_STATE_DIR ?? process.env.DISCORD_STATE_DIR
  return override
    ? join(override, 'factory')
    : join(process.env.HOME ?? '/tmp', '.hydra', 'factory')
}
let logDirReady = false

function ensureLogDir(): void {
  if (logDirReady) return
  if (!existsSync(logDir())) mkdirSync(logDir(), { recursive: true })
  logDirReady = true
}

function logBuild(state: FactoryBuildState, outcome: string): void {
  try {
    ensureLogDir()
    const entry = {
      ticket: state.ticket,
      spec: state.spec.slice(0, 500),
      phase: state.phase,
      outcome,
      retries: state.retryCount,
      reviewed: state.reviewed,
      builderModel: state.builderModel ?? 'default',
      reviewerModel: state.reviewerModel ?? 'default',
      elapsed: Date.now() - state.createdAt,
      ts: new Date().toISOString(),
    }
    appendFileSync(join(logDir(), 'history.jsonl'), JSON.stringify(entry) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: factory: log failed: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Display grammar — one line per build, shared by every factory message
// ---------------------------------------------------------------------------
//
//   {emoji} {sessionName} · {specTag} · {phase} [· {elapsed}] [· ctx {pct}] ({shortTicket})
//
// A ticket ID says nothing about what is being built. The spec tag does, so it
// leads every status line and the raw counter trails in parentheses.

const SPEC_TAG_MAX = 40

/** Collapse a spec to a single-line label, truncated at a word boundary. */
export function deriveSpecTag(spec: string): string {
  const flat = spec.replace(/\s+/g, ' ').trim()
  if (flat.length <= SPEC_TAG_MAX) return flat
  const cut = flat.slice(0, SPEC_TAG_MAX).replace(/\s+\S*$/, '')
  return (cut || flat.slice(0, SPEC_TAG_MAX)) + '…'
}

/** Strip the random suffix from a ticket: `fb-10-381f` → `fb-10`. */
function shortTicket(ticket: string): string {
  return ticket.replace(/-[0-9a-f]+$/, '')
}

function specTagOf(state: FactoryBuildState): string {
  return state.specTag ?? deriveSpecTag(state.spec)
}

/**
 * Which review round a build is in, read live from the protocol run.
 *
 * Pulled rather than mirrored onto the build: the run owns the counter, so
 * there is no second copy to fall behind when a round advances.
 */
function currentReviewRound(state: FactoryBuildState): { round: number; rounds: number } | undefined {
  if (state.phase !== 'reviewing' || !state.builderThreadId) return undefined
  const run = getRunByThread(state.builderThreadId)
  if (run?.protocol.name !== 'review') return undefined
  return { round: run.currentRound, rounds: run.rounds }
}

export function formatBuildLine(
  state: FactoryBuildState,
  opts?: { includeElapsed?: boolean; includeCtx?: boolean; includeRound?: boolean; omitPhase?: boolean },
): string {
  // killSession deletes the registry entry BEFORE emitting session:death, so
  // every post-mortem line (crash, cascade kill, the closing board) renders
  // after the live lookup has gone. Fall back to the name snapshotted at spawn
  // rather than reporting the corpse as "unknown".
  const info = state.builderSessionId ? registry.get(state.builderSessionId) : undefined
  const name = info?.tmuxName ?? state.builderName ?? 'unknown'
  const emoji = info
    ? (info.contentEmoji || sessionEmoji(info.tmuxName))
    : (state.builderName ? sessionEmoji(state.builderName) : '🏗️')
  const specTag = specTagOf(state)

  // omitPhase is for lines that already state the outcome some other way — a
  // "✅ … · complete" or "… · failed — abandoned" reads as a stutter.
  let line = opts?.omitPhase ? `${emoji} ${name} · ${specTag}` : `${emoji} ${name} · ${specTag} · ${state.phase}`
  if (opts?.includeRound) {
    const round = currentReviewRound(state)
    if (round) line += ` · round ${round.round}/${round.rounds}`
  }
  if (opts?.includeElapsed) {
    line += ` · ${formatDuration(Date.now() - state.createdAt)}`
  }
  if (opts?.includeCtx && info) {
    const ctx = getContextPercent(info.tmuxName)
    if (ctx !== '?') line += ` · ctx ${ctx}`
  }
  return `${line} (${shortTicket(state.ticket)})`
}

/**
 * A build's identity for an event message.
 *
 * Event messages name what happened in their own trailing clause, so the phase
 * segment would only stutter ("✅ … · complete — accepted"). Status board lines
 * have no such clause, and keep it.
 */
function eventLine(state: FactoryBuildState): string {
  return formatBuildLine(state, { omitPhase: true })
}

// ---------------------------------------------------------------------------
// Progress board — one message per PM thread, edited in place
// ---------------------------------------------------------------------------
//
// A tick used to post a fresh message per builder, so two builders over half an
// hour buried the PM thread under twenty status lines. Instead each PM thread
// owns a single board that every active build shares; ticks and phase changes
// rewrite it. The board is created lazily by the first tick, so builds that
// finish inside the interval leave no trace at all.

const PROGRESS_INTERVAL_MS = 3 * 60_000 // every 3 minutes

// A PM thread that never fully drains accumulates one finished line per build
// forever, so the history is bounded and the oldest entries are dropped first.
const BOARD_HISTORY_CAP = 25

/**
 * Everything one PM thread's board owns.
 *
 * Held as a single record rather than four maps keyed the same way: the message,
 * its text, the ticker and the history all share one lifetime, and splitting
 * them meant creating and retiring that lifetime in four places, where the next
 * field added would be forgotten in one of them.
 */
type BoardState = {
  messageId?: string                          // set once a board has actually been posted
  content?: string                            // what that message currently says
  timer?: ReturnType<typeof setInterval>      // live only while some build advances on its own
  finished: string[]                          // closing lines, held for the summary
  writeTail?: Promise<void>                   // serializes this board's writes
}

const boards = new Map<string, BoardState>()

function boardFor(pmThreadId: string): BoardState {
  let board = boards.get(pmThreadId)
  if (!board) {
    board = { finished: [] }
    boards.set(pmThreadId, board)
  }
  return board
}

/** Stop ticking and forget the board entirely. */
function retireBoard(pmThreadId: string): void {
  stopProgressUpdates(pmThreadId)
  boards.delete(pmThreadId)
}

/**
 * Assemble a board, keeping it inside one message.
 *
 * The board IS a single message — that is the whole point of editing in place —
 * so its render has to fit in one. safeEdit will truncate anything over the
 * limit rather than let the platform reject the edit, but a board cut mid-line
 * is a worse answer than a board that says what it left out: dropping whole
 * lines with a count keeps every line that survives readable.
 */
function composeBoard(header: string, lines: string[]): string {
  const limit = gateway.maxMessageLength - 64 // headroom for the overflow note
  let used = header.length
  const kept: string[] = []
  // Newest last, so fill from the end — dropping what just happened in favour
  // of what happened an hour ago would be the wrong half to keep.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > limit) break
    used += lines[i].length + 1
    kept.unshift(lines[i])
  }
  const dropped = lines.length - kept.length
  if (dropped > 0) kept.unshift(`  …and ${dropped} earlier`)
  return [header, ...kept].join('\n')
}

function isTerminalPhase(phase: FactoryPhase): boolean {
  return phase === 'complete' || phase === 'failed'
}

/** Builds the board should show — anything not yet finished. */
function activeBuildsInThread(pmThreadId: string): FactoryBuildState[] {
  return [...builds.values()].filter(s => s.pmThreadId === pmThreadId && !isTerminalPhase(s.phase))
}

/**
 * Whether a build's line will say something new without anyone acting.
 *
 * Work in flight moves: elapsed, context and review round all advance. A build
 * in `awaiting_pm` does not — except that it now carries a decision deadline
 * (see AWAITING_PM_TTL_MS), and that counts down. So it qualifies while the TTL
 * is armed, and stops qualifying the moment the phase is left.
 *
 * This is the only reason to hold a ticker. Without the distinction, a finished
 * build waiting on a human kept a 3-minute interval alive for as long as it
 * waited, spending a `tmux capture-pane` per build to re-render a line that
 * had not changed.
 */
function lineAdvances(state: FactoryBuildState): boolean {
  if (state.phase === 'building' || state.phase === 'reviewing') return true
  return state.phase === 'awaiting_pm' && awaitingPmRemainingMs(state) !== undefined
}

function advancingBuildsInThread(pmThreadId: string): FactoryBuildState[] {
  return [...builds.values()].filter(s => s.pmThreadId === pmThreadId && lineAdvances(s))
}

function startProgressUpdates(pmThreadId: string): void {
  const board = boardFor(pmThreadId)
  if (board.timer) return
  board.timer = setInterval(() => {
    if (activeBuildsInThread(pmThreadId).length === 0) {
      finalizeProgress(pmThreadId)
      return
    }
    // Nothing left that moves by itself: the board already reads correctly, so
    // stop rather than reprinting it forever.
    if (advancingBuildsInThread(pmThreadId).length === 0) {
      stopProgressUpdates(pmThreadId)
      return
    }
    refreshProgress(pmThreadId, true)
  }, PROGRESS_INTERVAL_MS)
}

function stopProgressUpdates(pmThreadId: string): void {
  const board = boards.get(pmThreadId)
  if (!board?.timer) return
  clearInterval(board.timer)
  board.timer = undefined
}

/** The board as it should read right now, or undefined when nothing is active. */
function renderProgress(pmThreadId: string): string | undefined {
  const active = activeBuildsInThread(pmThreadId)
  if (active.length === 0) return undefined
  // Elapsed and context only while the build is working. Those are minute- and
  // percent-granular, so on a line that has stopped being repainted they read
  // as current when they are not — and a stale context reading is the one a
  // manager would weigh when choosing between retry and abandon. The decision
  // deadline is safe to show by contrast: it is coarse enough that a few
  // minutes of drift cannot mislead, and its own countdown is what keeps the
  // ticker alive to refresh it. It trails the ticket, matching how adoption
  // notices render the same value.
  const lines = active.map(s => {
    const working = s.phase === 'building' || s.phase === 'reviewing'
    let line = formatBuildLine(s, { includeRound: true, includeElapsed: working, includeCtx: working })
    const remaining = awaitingPmRemainingMs(s)
    if (remaining !== undefined) line += ` · decide within ${formatDuration(remaining)}`
    return `  ${line}`
  })
  return composeBoard(`🏭 Factory · ${active.length} active`, lines)
}

/**
 * Apply this board's writes in the order they were dispatched.
 *
 * Every write is fire-and-forget, so two of them racing (a round advance and a
 * tick, or a refresh and the closing summary) could otherwise land out of
 * order and strand the board showing state that has already passed — with no
 * timer left to correct it once the thread has drained.
 */
function enqueueBoardWrite(pmThreadId: string, write: () => Promise<void>): void {
  const board = boardFor(pmThreadId)
  const next = (board.writeTail ?? Promise.resolve()).then(write).catch(() => {})
  board.writeTail = next
  void next.then(() => {
    const current = boards.get(pmThreadId)
    if (current?.writeTail !== next) return
    current.writeTail = undefined
    // finalizeProgress retires the board and *then* dispatches the closing
    // write, which has to borrow an entry to queue on. Once it has drained
    // there is nothing left to hold, so don't leave the husk behind.
    if (!current.messageId && !current.timer && current.finished.length === 0) {
      boards.delete(pmThreadId)
    }
  })
}

/**
 * Rewrite the board for a PM thread.
 *
 * `allowCreate` is the tick's privilege alone. Phase changes and round advances
 * only sharpen a board that already exists — they must not conjure one, or a
 * build that starts and finishes between ticks would post a board and then
 * immediately have to retract it.
 */
function refreshProgress(pmThreadId: string, allowCreate: boolean): void {
  // Decide whether to render BEFORE rendering. Every line costs a synchronous
  // `tmux capture-pane` for its context percentage, and this runs on the
  // phase-change path — rendering first meant paying one subprocess per active
  // build only to throw the result away whenever no board existed yet.
  const board = boards.get(pmThreadId)
  if (!board?.messageId && !allowCreate) return
  const content = renderProgress(pmThreadId)
  if (!content) return
  if (board?.content === content) return // nothing moved; an identical edit is a wasted call
  enqueueBoardWrite(pmThreadId, () => writeBoard(pmThreadId, content, allowCreate))
}

/**
 * Close out a PM thread's board: stop ticking, and if a board was ever posted,
 * leave it showing what finished. A thread that never posted one stays silent.
 */
function finalizeProgress(pmThreadId: string): void {
  const board = boards.get(pmThreadId)
  if (!board) return
  stopProgressUpdates(pmThreadId)
  if (!board.messageId) {
    // A first post may still be in flight; it re-finalizes when it lands, so
    // the history has to survive for that pass. Nothing in flight means no
    // board is coming and the history has nowhere to go.
    if (!board.writeTail) boards.delete(pmThreadId)
    return
  }
  const messageId = board.messageId
  const summary = composeBoard('🏭 Factory · complete', board.finished)
  // Retire first, then write: nothing may resurrect this board afterwards.
  boards.delete(pmThreadId)
  enqueueBoardWrite(pmThreadId, () => writeBoard(pmThreadId, summary, false, messageId))
}

/**
 * Edit the board, or post one when permitted.
 *
 * safeEdit classifies the failure; the three shapes want three answers — the
 * message is gone (re-post it), the channel is gone (give up on the board),
 * anything else is transient (keep the board for the next tick).
 */
async function writeBoard(
  pmThreadId: string,
  content: string,
  allowCreate: boolean,
  explicitMessageId?: string,
): Promise<void> {
  const messageId = explicitMessageId ?? boards.get(pmThreadId)?.messageId
  if (messageId) {
    const outcome = await safeEdit(pmThreadId, messageId, content)
    if (outcome === 'ok') {
      const board = boards.get(pmThreadId)
      if (board?.messageId === messageId) board.content = content
      return
    }
    // Nowhere to re-post into.
    if (outcome === 'channel-gone') { retireBoard(pmThreadId); return }
    // Transient — keep the board so the next tick edits it again.
    if (outcome === 'failed') return
    const board = boards.get(pmThreadId)
    if (board?.messageId === messageId) { board.messageId = undefined; board.content = undefined }
    if (!allowCreate) return
  }
  const ids = await safeSend(pmThreadId, content)
  if (!ids[0]) return
  const board = boardFor(pmThreadId)
  board.messageId = ids[0]
  board.content = content
  // The last build can finish while this post is in flight. Close the board out
  // rather than leaving a fresh message advertising work that is already over.
  if (activeBuildsInThread(pmThreadId).length === 0) finalizeProgress(pmThreadId)
}

/** Remember a build's closing line so the final board can show it. */
function noteBuildFinished(state: FactoryBuildState): void {
  const board = boards.get(state.pmThreadId)
  if (!board) return
  const mark = state.phase === 'complete' ? '✅' : '❌'
  board.finished.push(`  ${mark} ${formatBuildLine(state, { omitPhase: true, includeElapsed: true })}`)
  if (board.finished.length > BOARD_HISTORY_CAP) {
    board.finished = board.finished.slice(-BOARD_HISTORY_CAP)
  }
}

// ---------------------------------------------------------------------------
// awaiting_pm TTL — a build nobody decides on must not wait forever
// ---------------------------------------------------------------------------
//
// In awaiting_pm the builder is idle, the review is done, and the state sits in
// the builds map until a PM calls accept/retry/abandon. A PM that never comes
// back — killed mid-decision, or simply distracted — leaks that entry, its
// reverse lookups and its builder's factory identity for the life of the daemon.
// The TTL closes the ticket and reports it instead. Armed and disarmed by
// transitionFactoryPhase, so every entry into and exit from the phase is covered
// by construction.
//
// Not the only unbounded phase: `building` has no timeout either. pane-probe's
// nudgeIdleBuilder stops after BUILDER_MAX_NUDGES and never transitions, so a
// builder whose pane wedges without crashing leaks the same way. Out of scope
// here; noted so this comment isn't read as a completeness claim.

const AWAITING_PM_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Late-bound so a test can shrink the window and drive the real setTimeout.
// Asserting only on state._awaitingPmTimer let a wrong delay, a dead callback
// and a missing clearTimeout all pass — the mechanism has to actually fire.
let awaitingPmTtlMs = (): number => AWAITING_PM_TTL_MS

function startAwaitingPmTtl(state: FactoryBuildState): void {
  clearAwaitingPmTtl(state)
  state._awaitingPmSince = Date.now()
  state._awaitingPmTimer = setTimeout(() => expireAwaitingPm(state), awaitingPmTtlMs())
}

/**
 * Time left on the awaiting_pm TTL, or undefined if none is armed.
 *
 * Adoption deliberately does NOT restart the clock — the window measures how
 * long completed work may sit undecided, not how long any one PM has been
 * looking at it. Resetting on adopt would let a thread that rotates PMs faster
 * than the window keep a build alive forever, which is the leak the TTL exists
 * to close. So the successor inherits whatever is left, and is told what that is.
 */
function awaitingPmRemainingMs(state: FactoryBuildState): number | undefined {
  if (!state._awaitingPmTimer || state._awaitingPmSince === undefined) return undefined
  return Math.max(0, awaitingPmTtlMs() - (Date.now() - state._awaitingPmSince))
}

function expireAwaitingPm(state: FactoryBuildState): void {
  // clearAwaitingPmTtl, not a bare field reset: the field alone leaves a live
  // ref'd handle behind on the direct-invocation path used by tests.
  clearAwaitingPmTtl(state)
  // Precondition, like every sibling terminal path. Reachable if a lost
  // clearTimeout ever leaves a stale timer armed: without this, an accepted
  // build gets a spurious "expired" post 24h after the PM merged it.
  if (state.phase !== 'awaiting_pm' || builds.get(state.ticket) !== state) return
  process.stderr.write(`daemon: factory: ${state.ticket} expired in awaiting_pm after 24h — closing ticket\n`)
  // Transition before logging, as every other terminal path does — history.jsonl
  // records the phase the build ended in, and `outcome` already names the cause.
  transitionFactoryPhase(state, 'failed')
  logBuild(state, 'awaiting_pm_expired')
  // The builder is left alive: it holds completed work, and the PM never said to
  // throw it away. cleanupState releases its factory identity, so it reverts to
  // a plain thread_owner the operator can peek at or kill.
  void safeSend(
    state.pmThreadId,
    `🏭 \`${state.ticket}\` expired — no PM action after 24h\n↳ builder left alive; its work is still on disk`,
  ).catch(() => {})
  cleanupState(state.ticket)
}

function clearAwaitingPmTtl(state: FactoryBuildState): void {
  if (state._awaitingPmTimer) {
    clearTimeout(state._awaitingPmTimer)
    state._awaitingPmTimer = undefined
  }
  state._awaitingPmSince = undefined
}

// ---------------------------------------------------------------------------
// Worktree target validation — make "wrong repo" impossible to reach async
// ---------------------------------------------------------------------------
//
// The `worktree` param is a path RELATIVE to SPAWN_CWD, resolved by
// createWorktree() as `resolve(spawnCwd, repoName)`. Agents repeatedly pass a
// bare repo name ("hydra") when the repo is nested ("Documents/hydra"), and the
// only signal was an async spawn failure. These helpers validate synchronously
// at factory_build time and hand back the exact string that would have worked.

// Injectable git runner (DI, mirrors pane-probe's _setIO) — lets tests supply a
// deterministic fake instead of shelling out, and keeps these functions testable
// even when another test file globally mocks child_process.
export type FactoryGitIO = {
  // Run `git <args>` from `cwd`; return stdout, throw on non-zero exit (like execFileSync).
  git(args: string[], cwd: string): string
}
const defaultGitIO: FactoryGitIO = {
  git: (args, cwd) => execFileSync('git', args, { stdio: 'pipe', cwd }).toString(),
}
let gitIO: FactoryGitIO = defaultGitIO
export function _setGitIO(io: FactoryGitIO): void { gitIO = io }
export function _resetGitIO(): void { gitIO = defaultGitIO }

// macOS home-dir noise + build artifacts we never want to descend into.
const REPO_SCAN_SKIP = new Set([
  'node_modules', 'Library', 'Applications', 'Music', 'Movies', 'Pictures',
  'Downloads', '.Trash', '.cache', '.npm', '.cargo', '.rustup', 'go', 'Public',
])

/**
 * Scan `dir` (depth-bounded) for git repositories, returning their paths
 * relative to `dir` — exactly the strings a caller should pass as `worktree`.
 * Bounded by depth, a directory budget, and a result cap so a scan of a home
 * directory can't stall the daemon. Best-effort: unreadable dirs are skipped.
 */
export function listGitRepos(dir: string, maxDepth: number = 2): string[] {
  const repos: string[] = []
  let budget = 800  // max directories visited — guards against pathological trees

  function scan(current: string, depth: number): void {
    if (depth > maxDepth || budget <= 0 || repos.length >= 40) return
    budget--

    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }

    // A directory containing `.git` IS a repo — record it and don't descend
    // (a repo's own subdirs are never separate worktree targets).
    if (entries.some(e => e.name === '.git')) {
      repos.push(relative(dir, current) || '.')
      return
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || REPO_SCAN_SKIP.has(e.name)) continue
      scan(join(current, e.name), depth + 1)
    }
  }

  scan(dir, 0)
  return repos.sort()
}

/**
 * Given the PM's current working directory, return the `worktree` string that
 * would target the repo the PM is actually in — or undefined if the PM isn't in
 * a git repo under SPAWN_CWD. This is the "did you mean" suggestion.
 */
export function suggestWorktreeFromCwd(pmCwd: string, spawnCwd: string): string | undefined {
  try {
    const top = gitIO.git(['-C', pmCwd, 'rev-parse', '--show-toplevel'], pmCwd).trim()
    if (!top) return undefined
    // git returns a realpath; SPAWN_CWD may be spelled through a symlink
    // (e.g. macOS /var → /private/var). Compare against its realpath so the
    // prefix check holds — the relative result is identical either way.
    let base = spawnCwd
    try { base = realpathSync(spawnCwd) } catch {}
    if (top === base || top.startsWith(base + '/')) {
      const rel = relative(base, top)
      // rel === '' means the repo IS spawnCwd. We can't target it: createWorktree
      // puts the worktree at resolve(repoDir, '..', '.worktrees') — for a root repo
      // that escapes above SPAWN_CWD (e.g. /Users/.worktrees, SIP-protected). Worktree
      // targets must be repos NESTED under SPAWN_CWD; the root repo isn't isolatable.
      return rel || undefined
    }
  } catch {
    // pmCwd not a repo, git missing, etc. — no suggestion
  }
  return undefined
}

/**
 * Validate that `worktree` resolves to a git repo under `spawnCwd`, mirroring
 * createWorktree()'s own resolution + git check so the two never disagree.
 * On failure, the error lists every available repo so the caller can self-correct.
 */
export function validateWorktreeTarget(
  worktree: string,
  spawnCwd: string,
): { ok: true } | { error: string } {
  const base = resolve(spawnCwd)
  const targetRepo = resolve(base, worktree)
  // Target must be a repo STRICTLY nested under SPAWN_CWD. createWorktree places
  // the worktree at resolve(repoDir, '..', '.worktrees'); if the target is
  // SPAWN_CWD itself that escapes above it (e.g. /Users/.worktrees, SIP-protected),
  // and a target outside SPAWN_CWD ("../other") escapes the sandbox entirely.
  if (targetRepo === base || !targetRepo.startsWith(base + '/')) {
    return {
      error: `Worktree target "${worktree}" resolves to ${targetRepo}, not a repo nested under SPAWN_CWD (${base}). `
        + `The root repo cannot be isolated and out-of-bounds paths are refused — pass a nested path like "Documents/hydra".`,
    }
  }
  try {
    // Spawn from spawnCwd (a dir known to exist) rather than inheriting
    // process.cwd() — the child spawn itself fails if the inherited cwd is gone.
    gitIO.git(['-C', targetRepo, 'rev-parse', '--git-dir'], spawnCwd)
    return { ok: true }
  } catch {
    const available = listGitRepos(spawnCwd)
    const availStr = available.length ? available.join(', ') : 'none found'
    return {
      error: `Worktree target "${worktree}" is not a git repo at ${targetRepo}. `
        + `worktree must be a path relative to SPAWN_CWD (${spawnCwd}). `
        + `Available repos: ${availStr}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Model resolution — difficulty ladder with auto-fallback
// ---------------------------------------------------------------------------

export const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type Difficulty = (typeof VALID_DIFFICULTIES)[number]

// Hardcoded per tier — consistent, no env-var surprise.
// Different opus versions per tier for review diversity.
export function getDifficultyLadder(difficulty: Difficulty): { builder: string; reviewer: string } {
  switch (difficulty) {
    case 'easy':   return { builder: 'claude-opus-4-6[1m]',  reviewer: 'claude-opus-4-8[1m]' }
    case 'medium': return { builder: 'claude-opus-4-8[1m]',  reviewer: 'claude-opus-4-6[1m]' }
    case 'hard':   return { builder: 'claude-opus-5[1m]',    reviewer: 'claude-fable-5[1m]' }
  }
}

export function resolveModels(
  difficulty: Difficulty,
  builderRaw?: string,
  reviewerRaw?: string,
): { builder: string; reviewer: string; warning?: string } {
  const ladder = getDifficultyLadder(difficulty)

  // Explicit overrides take priority — validate against known models, fall back to ladder
  let builder = builderRaw ? (resolveModelAlias(builderRaw) ?? builderRaw) : ladder.builder
  let reviewer = reviewerRaw ? (resolveModelAlias(reviewerRaw) ?? reviewerRaw) : ladder.reviewer
  let warning: string | undefined

  if (builderRaw && !isKnownModel(builder)) {
    warning = `Unknown builder model "${builderRaw}". Using ladder default.`
    builder = ladder.builder
  }
  if (reviewerRaw && !isKnownModel(reviewer)) {
    warning = (warning ? warning + ' ' : '') + `Unknown reviewer model "${reviewerRaw}". Using ladder default.`
    reviewer = ladder.reviewer
  }

  // Check for collision (compare full IDs — different versions of same family are fine)
  const effectiveBuilder = builder.replace(/\[1m\]$/, '')
  const effectiveReviewer = reviewer.replace(/\[1m\]$/, '')

  if (effectiveBuilder !== effectiveReviewer) {
    return { builder, reviewer, warning }
  }

  // Same exact model — fall back to ladder's reviewer, or pick a different one
  const collisionMsg = `Builder and reviewer both resolved to ${effectiveBuilder}.`
  if (effectiveBuilder !== ladder.reviewer.replace(/\[1m\]$/, '')) {
    return {
      builder,
      reviewer: ladder.reviewer,
      warning: (warning ? warning + ' ' : '') + `${collisionMsg} Using ladder reviewer (${ladder.reviewer.replace(/\[1m\]$/, '')}).`,
    }
  }

  // Ladder reviewer is also the same — pick from a different family
  const FALLBACK_REVIEWERS: Record<string, string> = {
    'claude-opus-4-6': 'claude-opus-4-8[1m]',
    'claude-opus-4-7': 'claude-opus-4-8[1m]',
    'claude-opus-4-8': 'claude-opus-4-6[1m]',
    'claude-opus-5': 'claude-fable-5[1m]',
    'claude-fable-5': 'claude-opus-5[1m]',
  }

  const fallback = FALLBACK_REVIEWERS[effectiveBuilder]
  if (fallback) {
    return {
      builder,
      reviewer: fallback,
      warning: (warning ? warning + ' ' : '') + `${collisionMsg} Auto-selected ${fallback.replace(/\[1m\]$/, '')}.`,
    }
  }

  // Unknown model with no fallback — use opus as a safe generic reviewer
  const genericFallback = 'claude-opus-4-6[1m]'
  if (effectiveBuilder !== genericFallback.replace(/\[1m\]$/, '')) {
    return {
      builder,
      reviewer: genericFallback,
      warning: (warning ? warning + ' ' : '') + `${collisionMsg} Auto-selected ${genericFallback.replace(/\[1m\]$/, '')} as reviewer.`,
    }
  }

  // Builder IS the generic fallback — use a different opus version
  return {
    builder,
    reviewer: 'claude-opus-4-8[1m]',
    warning: (warning ? warning + ' ' : '') + `${collisionMsg} Auto-selected claude-opus-4-8 as reviewer.`,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an async build→review cycle. Returns immediately with a ticket.
 * Results delivered as notifications to the PM's thread.
 */
export type FactoryBuildOpts = {
  pmThreadId: string
  pmSessionId: string
  spec: string
  builderModel?: string
  reviewerModel?: string
  reviewRounds?: number
  difficulty?: Difficulty
  worktree?: string
  fresh?: boolean  // spawn fresh builder (no fork from PM context)
}

export function factoryBuild(opts: FactoryBuildOpts): { ticket: string; warning?: string } | { error: string } {
  const { pmThreadId, pmSessionId, spec, builderModel, reviewerModel, worktree } = opts
  const reviewRounds = opts.reviewRounds ?? 3
  const difficulty = opts.difficulty ?? 'easy'
  const { builder, reviewer, warning: modelWarning } = resolveModels(difficulty, builderModel, reviewerModel)

  // Warn about concurrent builds sharing the same working tree (skip if worktree-isolated)
  const activeCount = worktree ? 0 : [...builds.values()].filter(s => s.pmThreadId === pmThreadId && s.phase !== 'complete' && s.phase !== 'failed').length
  const parallelWarning = activeCount > 0
    ? `You have ${activeCount} other active build${activeCount > 1 ? 's' : ''}. Concurrent builds share the same working tree — pass worktree to isolate, or test runs may interfere.`
    : undefined
  const warning = [modelWarning, parallelWarning].filter(Boolean).join(' ') || undefined

  const pmInfo = registry.get(pmSessionId)
  const fresh = opts.fresh ?? false
  if (!fresh && !pmInfo?.claudeSessionId) {
    return { error: 'Cannot fork — PM claude session ID not found. Use fresh=true to spawn without fork.' }
  }

  // Validate the worktree target NOW (sync) — not async at spawn time. A wrong
  // repo name is the single most common factory failure; catch it before any
  // state is created and hand back the string that would have worked.
  if (worktree) {
    const spawnCwd = process.env.SPAWN_CWD
    if (!spawnCwd) return { error: 'SPAWN_CWD not set — cannot resolve worktree target.' }
    const validation = validateWorktreeTarget(worktree, spawnCwd)
    if ('error' in validation) {
      const suggestion = pmInfo?.sessionMetadata?.cwd
        ? suggestWorktreeFromCwd(pmInfo.sessionMetadata.cwd, spawnCwd)
        : undefined
      const suffix = suggestion && suggestion !== worktree ? ` Did you mean worktree="${suggestion}"?` : ''
      return { error: validation.error + suffix }
    }
  }

  const ticket = `fb-${++ticketCounter}-${randomBytes(2).toString('hex')}`
  const state: FactoryBuildState = {
    ticket,
    pmThreadId,
    pmSessionId,
    spec,
    specTag: deriveSpecTag(spec),
    builderModel: builder,
    reviewerModel: reviewer,
    reviewRounds,
    phase: 'building',
    retryCount: 0,
    createdAt: Date.now(),
    reviewed: false,
    worktree,
  }
  builds.set(ticket, state)

  // Spawn builder async — don't await
  const forkInfo = fresh ? undefined : { claudeSessionId: pmInfo!.claudeSessionId!, tmuxName: pmInfo!.tmuxName }
  void spawnBuilder(state, forkInfo).catch(err => {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: factory: builder spawn failed: ${errMsg}\n`)
    transitionFactoryPhase(state, 'failed')
    logBuild(state, 'spawn_failed')
    cleanupState(ticket)
    void safeSend(pmThreadId, `🏭 ❌ ${eventLine(state)} — spawn failed: ${errMsg}`)
  })

  return { ticket, warning }
}

/**
 * Authorize a caller against a build's PM *thread*, not its PM session.
 *
 * The thread is the PM's seat; sessions rotate through it. A PM at 90% context
 * dies and its successor respawns in the same thread — session-scoped checks
 * would strand every in-flight build with no one able to accept it.
 */
function authorizePmThread(
  state: FactoryBuildState,
  callerSessionId: string,
  verb: string,
): { error: string } | undefined {
  const callerInfo = registry.get(callerSessionId)
  if (callerInfo?.threadId !== state.pmThreadId) {
    return { error: `Only a session in the PM thread can ${verb} this build.` }
  }
  return undefined
}

/**
 * Retry a build that's awaiting PM decision. Sends new instructions to the
 * still-alive builder and re-enters the build→review cycle.
 */
export function factoryRetry(
  ticket: string,
  instructions: string,
  callerSessionId: string,
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  const denied = authorizePmThread(state, callerSessionId, 'retry')
  if (denied) return denied
  if (state.phase !== 'awaiting_pm') return { error: `Cannot retry — build is in phase "${state.phase}", expected "awaiting_pm".` }

  if (!state.builderSessionId || !state.builderThreadId) return { error: 'Builder session not found — use factory_build to start a new build.' }
  const builderInfo = registry.get(state.builderSessionId)
  if (!builderInfo) return { error: 'Builder session no longer exists — use factory_build to start a new build.' }

  transitionFactoryPhase(state, 'building')
  state.retryCount++

  // Send new instructions to the builder via notification
  transport.sendOrQueue(state.builderSessionId, {
    type: 'notification',
    content: [
      `[system] The PM has requested changes. Implement the following:`,
      ``,
      instructions,
      ``,
      `When done, call \`factory_done\` with your results as before.`,
    ].join('\n'),
    meta: { chat_id: state.builderThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  void safeSend(state.pmThreadId, `🏭 🔄 ${eventLine(state)} — retry ${state.retryCount}`)

  process.stderr.write(`daemon: factory: retry ${ticket} (attempt ${state.retryCount + 1})\n`)
  return { ok: true }
}

/**
 * Accept a build — PM is satisfied. Kill builder, clean up.
 */
export function factoryAccept(
  ticket: string,
  callerSessionId: string,
  allowUnreviewed: boolean = false,
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  const denied = authorizePmThread(state, callerSessionId, 'accept')
  if (denied) return denied
  return acceptCore(state, allowUnreviewed)
}

/**
 * Accept a build by ticket alone (admin/CLI path — skips PM ownership check).
 */
export function factoryAcceptByTicket(
  ticket: string,
  allowUnreviewed: boolean = false,
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  return acceptCore(state, allowUnreviewed)
}

/** Shared accept logic — assumes caller authorization already checked. */
function acceptCore(state: FactoryBuildState, allowUnreviewed: boolean): { ok: true } | { error: string } {
  if (state.phase !== 'awaiting_pm') return { error: `Cannot accept — build is in phase "${state.phase}", expected "awaiting_pm".` }
  if (!state.reviewed && !allowUnreviewed) return { error: 'Build was NOT adversarially reviewed (review failed or was cancelled). Pass allow_unreviewed=true to accept anyway.' }

  transitionFactoryPhase(state, 'complete')
  logBuild(state, state.reviewed ? 'accepted' : 'accepted_unreviewed')

  const reviewWarning = state.reviewed ? '' : ' (unreviewed)'
  // Link to the review summary rather than reprinting it — the PM already read
  // it once, and a second copy is the noisiest message in the thread.
  const reviewUrl = state.reviewMessageId
    ? gateway.getMessageUrl(state.pmThreadId, state.reviewMessageId)
    : ''
  const reviewLabel = reviewUrl ? ` · [review](${reviewUrl})` : ''
  void safeSend(state.pmThreadId, `🏭 ✅ ${eventLine(state)} — accepted${reviewLabel}${reviewWarning}`)

  killBuilder(state, true)
  cleanupState(state.ticket)
  return { ok: true }
}

/**
 * Abandon a build — PM gives up. Kill builder, clean up.
 */
export function factoryAbandon(
  ticket: string,
  callerSessionId: string,
  reason?: string,
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  const denied = authorizePmThread(state, callerSessionId, 'abandon')
  if (denied) return denied
  return abandonCore(state, reason)
}

/**
 * Abandon a build by ticket alone (admin/CLI path — skips PM ownership check).
 */
export function factoryAbandonByTicket(ticket: string, reason?: string): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  return abandonCore(state, reason)
}

/** Shared abandon logic — assumes caller authorization already checked. */
function abandonCore(state: FactoryBuildState, reason?: string): { ok: true } | { error: string } {
  if (state.phase === 'complete' || state.phase === 'failed') return { error: 'Build already terminated.' }

  const wasPhase = state.phase
  transitionFactoryPhase(state, 'failed')
  logBuild(state, 'abandoned')

  const reviewNote = state.reviewSummary
    ? '\n↳ review had found: ' + (state.reviewSummary.length > 200 ? state.reviewSummary.slice(0, 200) + '…' : state.reviewSummary)
    : ''
  void safeSend(state.pmThreadId, `🏭 🗑️ ${eventLine(state)} — abandoned${reason ? ': ' + reason.slice(0, 200) : ''}${reviewNote}`)

  // Cancel any in-flight review so the critic doesn't orphan
  if (wasPhase === 'reviewing' && state.builderThreadId) {
    const run = getRunByThread(state.builderThreadId)
    if (run) {
      void cancelRun(run, 'factory abandoned').catch(err => {
        process.stderr.write(`daemon: factory: cancel review on abandon failed: ${err}\n`)
      })
    }
  }

  killBuilder(state, true)
  cleanupState(state.ticket)

  process.stderr.write(`daemon: factory: abandoned ${state.ticket} (was in phase ${wasPhase})\n`)
  return { ok: true }
}

/** Serialize a build to a summary row (shared by factoryStatus + factoryListAll). */
type BuildSummary = { ticket: string; phase: string; spec: string; retries: number; elapsed: number; builderName?: string; pmThreadId?: string; worktree?: string }
function summarizeBuild(s: FactoryBuildState, includePmThread = false): BuildSummary {
  return {
    ticket: s.ticket,
    phase: s.phase,
    spec: s.spec.slice(0, 200),
    retries: s.retryCount,
    elapsed: Date.now() - s.createdAt,
    builderName: s.builderSessionId ? registry.get(s.builderSessionId)?.tmuxName : undefined,
    ...(includePmThread ? { pmThreadId: s.pmThreadId } : {}),
    ...(s.worktree ? { worktree: s.worktree } : {}),
  }
}

/**
 * Get status of factory builds for a PM.
 */
export function factoryStatus(
  pmThreadId: string,
  ticket?: string,
): { builds: BuildSummary[]; availableRepos: string[] } {
  const matching = ticket
    ? [builds.get(ticket)].filter((s): s is FactoryBuildState => !!s && s.pmThreadId === pmThreadId)
    : [...builds.values()].filter(s => s.pmThreadId === pmThreadId)

  const spawnCwd = process.env.SPAWN_CWD
  return {
    builds: matching.map(s => summarizeBuild(s)),
    availableRepos: spawnCwd ? listGitRepos(spawnCwd) : [],
  }
}

/**
 * List ALL active factory builds regardless of PM (admin/CLI path).
 * Includes pmThreadId so the operator can trace each build to its PM.
 */
export function factoryListAll(ticket?: string): { builds: BuildSummary[] } {
  const matching = ticket
    ? [builds.get(ticket)].filter((s): s is FactoryBuildState => !!s)
    : [...builds.values()]
  return { builds: matching.map(s => summarizeBuild(s, true)) }
}

/**
 * Run adversarial review on an existing session without a full build cycle.
 * Wires a one-shot listener to deliver the review result back to the caller's thread.
 */
export async function factoryReview(opts: {
  callerThreadId: string
  targetSessionId: string
  targetThreadId: string
  targetName: string
  topic?: string
  reviewerModel?: string
  reviewRounds?: number
}): Promise<void> {
  const { callerThreadId, targetSessionId, targetThreadId, targetName, topic, reviewerModel } = opts
  const reviewRounds = opts.reviewRounds ?? 3

  const unsub = protocolEvents.onceComplete(targetThreadId, (event) => {
    if (event.outcome === 'cancelled') {
      void safeSend(callerThreadId, `🔍 Review of **${targetName}** cancelled`)
    } else {
      const summary = event.summary
      const summaryBlock = summary
        ? '\n' + (summary.length > 1500 ? summary.slice(0, 1500) + '\n…(truncated)' : summary)
        : ''
      void safeSend(callerThreadId, `🔍 Review of **${targetName}** complete${summaryBlock}`)
    }
  })

  try {
    await startProtocolRun(reviewProto, targetThreadId, targetSessionId, {
      rounds: reviewRounds,
      topic,
      model: reviewerModel,
    })
  } catch (err) {
    unsub()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Internal — builder lifecycle
// ---------------------------------------------------------------------------

const FACTORY_DONE_DESCRIPTIONS: Record<FactoryPhase, string> = {
  building: 'Signal that your factory build is complete. Triggers mandatory adversarial review.',
  reviewing: 'Not available — your code is under review. Defend with advance() instead.',
  awaiting_pm: 'Not available — build complete, awaiting PM decision.',
  complete: 'Not available — build cycle complete.',
  failed: 'Not available — build failed.',
}

function setFactoryTools(info: SessionInfo, phase: FactoryPhase): void {
  setToolDescription(info, 'factory_done', FACTORY_DONE_DESCRIPTIONS[phase])
}

function transitionFactoryPhase(state: FactoryBuildState, newPhase: FactoryPhase): void {
  const wasTerminal = isTerminalPhase(state.phase)
  state.phase = newPhase

  // The TTL is armed here rather than at each awaiting_pm call site so that
  // accept, retry, abandon and the death paths all disarm it just by moving the
  // phase — no caller has to remember. Re-entering awaiting_pm (a retry that
  // completes again) restarts the clock: it is a fresh decision point.
  if (newPhase === 'awaiting_pm') startAwaitingPmTtl(state)
  else clearAwaitingPmTtl(state)

  // Terminal builds are captured for the closing board; cleanupState finalizes
  // it a moment later, so refreshing here would only post an interim edit.
  if (isTerminalPhase(newPhase)) {
    if (!wasTerminal) noteBuildFinished(state)
  } else {
    // Re-arm the ticker whenever the new phase has a line that moves on its
    // own — work resuming after a retry, or a decision deadline starting to
    // count down. Must follow the TTL arm above, which is what makes
    // awaiting_pm qualify.
    if (lineAdvances(state)) startProgressUpdates(state.pmThreadId)
    refreshProgress(state.pmThreadId, false)
  }

  if (!state.builderSessionId) return
  const info = registry.get(state.builderSessionId)
  if (!info) return

  info.factoryPhase = newPhase
  setFactoryTools(info, newPhase)
  registry.persist()
  pushToolSurface(state.builderSessionId)
}

const execAsync = promisify(execFile)
const DIFF_SIZE_CAP = 50 * 1024  // 50KB — enough for UX, not so large it's useless

/**
 * Capture the builder's committed diff and upload as a secret GitHub Gist.
 * Called at factory_done time (before review), stored in state.diffGistUrl.
 * Best-effort — failure is silent.
 *
 * Uses `git log -p HEAD~1..HEAD` to capture the most recent commit (the builder's
 * work) rather than `git diff HEAD` which is empty after a commit.
 */
async function captureBuilderDiff(state: FactoryBuildState): Promise<string | undefined> {
  if (!state.builderSessionId) return undefined
  const info = registry.get(state.builderSessionId)
  if (!info) return undefined

  const cwd = info.worktreePath ?? info.sessionMetadata?.cwd
  if (!cwd) return undefined

  try {
    const { stdout: rawDiff } = await execAsync('git', ['log', '-p', 'HEAD~1..HEAD'], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })
    let diff = rawDiff.trim()
    if (!diff) return undefined

    let truncated = false
    if (diff.length > DIFF_SIZE_CAP) {
      diff = diff.slice(0, DIFF_SIZE_CAP) + '\n\n... (truncated — diff exceeded 50KB)'
      truncated = true
    }

    const tmpPath = join('/tmp', `factory-diff-${state.ticket}.diff`)
    writeFileSync(tmpPath, diff)
    try {
      const { stdout } = await execAsync('gh', ['gist', 'create', tmpPath], { timeout: 15_000 })
      if (truncated) process.stderr.write(`daemon: factory: diff truncated at 50KB for ${state.ticket}\n`)
      return stdout.trim() || undefined
    } finally {
      try { unlinkSync(tmpPath) } catch {}
    }
  } catch (err) {
    process.stderr.write(`daemon: factory: diff capture failed for ${state.ticket}: ${err instanceof Error ? err.message : err}\n`)
    return undefined
  }
}

/**
 * Create a GitHub PR from the builder's worktree branch.
 * Only runs for worktree builds (info.worktreePath + info.worktreeRepo set).
 * Best-effort — failure is silent.
 */
async function createBuilderPR(state: FactoryBuildState): Promise<string | undefined> {
  if (!state.builderSessionId) return undefined
  const info = registry.get(state.builderSessionId)
  if (!info?.worktreePath || !info.worktreeRepo) return undefined

  const branch = `wt/${info.tmuxName}`
  try {
    // Check if PR already exists for this branch (idempotent).
    // gh pr view exits 1 when no PR exists — wrap in its own try so the throw
    // doesn't prevent creation (the common path for a fresh factory build).
    try {
      const { stdout } = await execAsync(
        'gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'],
        { cwd: info.worktreeRepo, timeout: 10_000 },
      )
      const existing = stdout.trim()
      if (existing) return existing
    } catch {
      // No existing PR — fall through to create
    }

    const title = `Factory ${state.ticket}: ${state.spec.slice(0, 60)}`
    const body = `Factory build from ticket \`${state.ticket}\``
    const { stdout } = await execAsync(
      'gh', ['pr', 'create', '--head', branch, '--title', title, '--body', body],
      { cwd: info.worktreeRepo, timeout: 15_000 },
    )
    return stdout.trim() || undefined
  } catch (err) {
    process.stderr.write(`daemon: factory: PR creation failed for ${state.ticket}: ${err instanceof Error ? err.message : err}\n`)
    return undefined
  }
}

/**
 * Where a builder thread's spawn announcement lives, resolved from the
 * registries while they still hold the builder.
 *
 * Captured *before* the kill: killSession drops the session entry, and the
 * anchor is only reachable from that entry on platforms whose thread metadata
 * lacks a parent channel.
 */
function resolveBuilderAnchor(
  threadId: string,
  builderSessionId?: string,
): { channelId?: string; messageId?: string } {
  const thread = threadRegistry.get(threadId)
  const info = builderSessionId ? registry.get(builderSessionId) : undefined
  // Take both fields from the same record. Mixing them — a channel from the
  // thread record, a message ID from the session — can name a message that
  // exists in that channel but is not this builder's anchor, and on Slack,
  // where a ts is only unique within its channel, that is a live message.
  const candidates: Array<{ channelId?: string; messageId?: string }> = [
    { channelId: thread?.parentChannelId ?? thread?.anchorChannelId, messageId: thread?.anchorMessageId },
    { channelId: info?.anchorChannelId, messageId: info?.anchorMessageId },
  ]
  return candidates.find(c => c.channelId && c.messageId) ?? {}
}

/**
 * Delete the builder thread and the spawn announcement it hangs from.
 *
 * Deleting only the thread leaves a dangling "⚡ spawned" line in the parent
 * channel for work that no longer exists, so accepting a build accumulated one
 * orphan per build. Best-effort throughout — a builder that cannot be swept up
 * must never block the accept that asked for it.
 */
async function destroyBuilderThread(
  threadId: string,
  anchor: { channelId?: string; messageId?: string },
): Promise<void> {
  // Ask the platform BEFORE deleting the thread. Both of these read the thread
  // itself, so after the delete they can only ever fail — the fallback would be
  // dead code exactly when the registries could not supply the anchor.
  let { channelId, messageId } = anchor
  if (!channelId || !messageId) {
    try {
      if (!channelId) {
        const channelInfo = await gateway.fetchChannel(threadId)
        if (channelInfo.isThread && channelInfo.parentId) channelId = channelInfo.parentId
      }
      if (!messageId) {
        const starter = await gateway.getThreadStarterInfo(threadId)
        if (starter) messageId = starter.starterId
      }
    } catch {
      // Nothing more to learn from the thread; fall through to what we have.
    }
  }

  try {
    await gateway.deleteThread!(threadId)
  } catch (err) {
    process.stderr.write(`daemon: factory: thread cleanup failed: ${err instanceof Error ? err.message : err}\n`)
    return
  }

  // The thread is gone, so its metadata record is a remnant too — it would
  // otherwise outlive the build in `history` and the dashboard, linking
  // somewhere that no longer resolves.
  threadRegistry.delete(threadId)

  if (!channelId || !messageId) {
    process.stderr.write(`daemon: factory: skipped anchor deletion for ${threadId} (channel=${channelId ?? 'unknown'}, message=${messageId ?? 'unknown'})\n`)
    return
  }
  try {
    await gateway.delete(channelId, messageId)
  } catch (err) {
    process.stderr.write(`daemon: factory: anchor deletion failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

function killBuilder(state: FactoryBuildState, deleteThread: boolean = false): void {
  const threadToDelete = deleteThread && state.builderThreadId && gateway.deleteThread
    ? state.builderThreadId : undefined
  const anchor = threadToDelete
    ? resolveBuilderAnchor(threadToDelete, state.builderSessionId)
    : undefined

  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      const killPromise = killSession(builderInfo, 'factory complete').catch(() => {})
      // Delete thread AFTER killSession completes — killSession may post
      // unpushed-commit warnings to the thread that would be swallowed otherwise
      if (threadToDelete) {
        void killPromise.finally(() => destroyBuilderThread(threadToDelete, anchor!).catch(() => {}))
      }
      return
    }
  }
  // No builder session to kill — delete thread directly
  if (threadToDelete) {
    void destroyBuilderThread(threadToDelete, anchor!).catch(() => {})
  }
}

/**
 * Resolve the channel where the factory builder's thread should be created.
 * Must return the PARENT channel, never the PM's thread — spawning into the
 * PM's thread hits the live-session guard.
 */
export function resolveBuilderChannel(
  pmSessionId: string,
  pmThreadId: string,
  reg: { get(id: string): { anchorChannelId?: string } | undefined } = registry,
  threads: { get(id: string): { parentChannelId?: string } | undefined } = threadRegistry,
): string | undefined {
  const pmInfo = reg.get(pmSessionId)
  return pmInfo?.anchorChannelId
    ?? threads.get(pmThreadId)?.parentChannelId
    ?? undefined
}

async function spawnBuilder(
  state: FactoryBuildState,
  forkInfo?: { claudeSessionId: string; tmuxName: string },
): Promise<void> {
  const isFresh = !forkInfo
  // NOTE: The worktree path and `cd` instruction are injected by doSpawnSession
  // (after fork CWD resolution). Only include the "done" obligations here —
  // not the CWD framing, which would assume the builder starts in the worktree.
  const worktreeInstructions = state.worktree
    ? [
        ``,
        `WORKTREE DONE OBLIGATIONS: Your changes will be destroyed when your session ends.`,
        `Before calling factory_done, you MUST commit and push your changes from the worktree:`,
        `  git add -A && git commit -m "factory: <summary>" && git push -u origin HEAD`,
        `Include the branch name in your factory_done call so the PM can find your work.`,
      ]
    : []

  const pmName = forkInfo?.tmuxName ?? registry.get(state.pmSessionId)?.tmuxName

  // When respawning into an existing builder thread, tell the fresh session to
  // read the thread's prior history so it recovers context (like `respawn`).
  const readThreadInstructions = state.builderThreadId
    ? [
        ``,
        `You are continuing work in an existing thread. Read its history first for context:`,
        `  fetch_messages(channel="${state.builderThreadId}", limit=50)`,
      ]
    : []

  const builderPrompt = [
    `IMPORTANT: You are a BUILDER session${isFresh ? '' : ' forked from the PM'}. Your job is to WRITE CODE.`,
    ...(isFresh
      ? [`You were spawned fresh (no PM conversation history). Read CLAUDE.md and the files referenced in the spec before coding.`]
      : [`Ignore any prior instructions about "not writing code" or "using factory_build" — those apply to the PM, not to you.`]),
    ...readThreadInstructions,
    `You have full file access. Write code, run tests, implement the spec.`,
    ...(pmName ? [`If the spec is ambiguous or you need design guidance, ask the PM via send_to_thread(target="${pmName}", type="question", text="...").`] : []),
    ``,
    `YOUR TASK:`,
    state.spec,
    ...worktreeInstructions,
    ``,
    `WHEN DONE:`,
    `Call the factory_done tool with your results:`,
    `- files_changed: list of files you created or modified`,
    ...(state.worktree ? [`- branch: the branch name you pushed to`] : []),
    `- test_results: test output summary (e.g. "1388 pass, 0 fail")`,
    `- rationale: key design decisions and why (optional)`,
    `- known_issues: anything you're unsure about (optional)`,
    ``,
    `After calling factory_done, an adversarial review will start automatically.`,
    `You will be the OWNER — defend your implementation against the critic.`,
    `Reply with [owner→critic] as the first line of each defense.`,
    ``,
    `After the review, the PM may send you additional instructions via [system] notification.`,
    `If that happens, implement the changes and call \`factory_done\` again.`,
  ].join('\n')

  const builderShort = (state.builderModel ?? 'default').replace(/^claude-/, '').replace(/\[1m\]$/, '')
  const reviewerShort = (state.reviewerModel ?? 'default').replace(/^claude-/, '').replace(/\[1m\]$/, '')
  const worktreeLabel = state.worktree ? ` · wt:\`${state.worktree}\`` : ''
  const spawnLabel = isFresh ? ' · fresh' : ' · fork'
  const specPreview = state.spec.slice(0, 140) + (state.spec.length > 140 ? '…' : '')
  // The only place the full ticket appears — every later message shortens it.
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ${specTagOf(state)} · building · ${builderShort}→${reviewerShort}${worktreeLabel}${spawnLabel}\n${specPreview}`)

  const chatId = resolveBuilderChannel(state.pmSessionId, state.pmThreadId)
  const initiator = pmName

  const result = await doSpawnSession(`factory-builder: ${state.spec.slice(0, 60)}`, chatId, undefined, {
    ...(forkInfo ? { forkFrom: { claudeSessionId: forkInfo.claudeSessionId, parentName: forkInfo.tmuxName } } : {}),
    model: state.builderModel,
    promptPrefix: builderPrompt,
    ...(initiator ? { initiator } : {}),
    ...(state.worktree ? { worktree: state.worktree } : {}),
    sessionType: 'factory_builder',
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  state.builderName = result.name
  builderSessionToTicket.set(result.sessionId, state.ticket)
  builderThreadToTicket.set(result.threadId, state.ticket)

  const builderInfo = registry.get(result.sessionId)
  if (builderInfo) {
    builderInfo.factoryPmThreadId = state.pmThreadId
    builderInfo.factoryTicket = state.ticket
  }
  transitionFactoryPhase(state, 'building')

  process.stderr.write(`daemon: factory: builder ${result.name} (${result.sessionId}) ${isFresh ? 'spawned' : 'forked'} for ticket ${state.ticket}\n`)

  // Start the PM thread's progress board so the PM gets status during long builds
  startProgressUpdates(state.pmThreadId)
}

export type FactoryDoneArgs = {
  files_changed: string[]
  test_results: string
  rationale?: string
  known_issues?: string
  branch?: string
}

export function onBuilderDone(sessionId: string, args: FactoryDoneArgs): { ok: true } | { error: string } {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return { error: 'No active factory build for this session.' }

  const state = builds.get(ticket)
  if (!state || state.phase !== 'building') return { error: `Cannot complete — build is in phase "${state?.phase ?? 'unknown'}", expected "building".` }

  transitionFactoryPhase(state, 'reviewing')
  process.stderr.write(`daemon: factory: builder called factory_done for ticket ${state.ticket}, starting review\n`)

  void doBuilderDoneAsync(state, args)

  return { ok: true }
}

async function doBuilderDoneAsync(state: FactoryBuildState, args: FactoryDoneArgs): Promise<void> {
  const fileCount = args.files_changed.length
  const testShort = args.test_results.slice(0, 80)
  const branchLabel = args.branch ? ` · \`${args.branch}\`` : ''
  void safeSend(state.pmThreadId, `🏭 🔍 ${eventLine(state)} — review starting · ${fileCount} file${fileCount !== 1 ? 's' : ''}${branchLabel} · ${testShort}`)

  // Start review BEFORE diff/PR capture — closes the protocol ownership gap.
  // During diff capture (up to 15s of GitHub API calls), the review protocol
  // owns the session so bridge disconnects are handled correctly.
  // Diff/PR URLs are only needed in onFactoryReviewComplete, not at review start.
  startProtocolRun(reviewProto, state.builderThreadId!, state.builderSessionId!, {
    rounds: state.reviewRounds,
    topic: state.spec,
    model: state.reviewerModel,
  })
    .catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: factory: review failed to start: ${errMsg}\n`)
      if (state.phase !== 'reviewing') {
        process.stderr.write(`daemon: factory: review start failed but phase already moved to ${state.phase}, skipping PM notification\n`)
        return
      }
      transitionFactoryPhase(state, 'awaiting_pm')
      const failCount = (pmReviewFailures.get(state.pmThreadId) ?? 0) + 1
      pmReviewFailures.set(state.pmThreadId, failCount)
      void safeSend(state.pmThreadId, `🏭 ⚠️ ${eventLine(state)} — review failed: ${errMsg}\n↳ factory_retry / factory_accept / factory_abandon`)
    })

  // Capture diff/PR concurrently — not blocking the review start.
  void Promise.all([captureBuilderDiff(state), createBuilderPR(state)]).then(([gistUrl, prUrl]) => {
    if (gistUrl) state.diffGistUrl = gistUrl
    if (prUrl) state.prUrl = prUrl
  }).catch(err => {
    process.stderr.write(`daemon: factory: diff/PR capture failed (non-fatal): ${err instanceof Error ? err.message : err}\n`)
  })
}

/**
 * Called when a builder session dies WITHOUT calling factory_done — crash/timeout.
 */
export function onBuilderDeath(sessionId: string): void {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return

  const state = builds.get(ticket)
  if (!state) return

  if (state.phase === 'building') {
    process.stderr.write(`daemon: factory: builder died without calling factory_done for ticket ${state.ticket}\n`)
    transitionFactoryPhase(state, 'failed')
    logBuild(state, 'builder_crashed')
    void safeSend(state.pmThreadId, `🏭 ❌ ${eventLine(state)} — builder crashed (no factory_done)`)
    cleanupState(ticket)
  } else if (state.phase === 'reviewing') {
    process.stderr.write(`daemon: factory: builder died during review for ticket ${state.ticket}, cancelling review\n`)
    transitionFactoryPhase(state, 'failed')
    logBuild(state, 'builder_died_reviewing')
    if (state.builderThreadId) {
      const run = getRunByThread(state.builderThreadId)
      if (run) {
        void cancelRun(run, 'builder crashed during review').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on builder death failed: ${err}\n`)
        })
      }
    }
    void safeSend(state.pmThreadId, `🏭 ❌ ${eventLine(state)} — builder crashed during review`)
    cleanupState(ticket)
  } else if (state.phase === 'awaiting_pm') {
    process.stderr.write(`daemon: factory: builder died while awaiting PM for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, `🏭 ⚠️ ${eventLine(state)} — builder exited (work on disk, ticket closed)`)
    transitionFactoryPhase(state, 'failed')
    logBuild(state, 'builder_died_awaiting')
    cleanupState(ticket)
  }
}

function onFactoryReviewComplete(builderThreadId: string, summaryText?: string): boolean {
  const ticket = builderThreadToTicket.get(builderThreadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  transitionFactoryPhase(state, 'awaiting_pm')
  state.reviewed = true
  if (summaryText) state.reviewSummary = summaryText
  pmReviewFailures.delete(state.pmThreadId)
  process.stderr.write(`daemon: factory: review complete for ticket ${state.ticket}, awaiting PM decision\n`)

  // prUrl/diffGistUrl were captured at factory_done time — use synchronously, no race.
  const diffLink = state.prUrl ?? state.diffGistUrl
  const linkLabel = diffLink ? ` · ${diffLink}` : ''
  // Keep review summary — it's the "what was reviewed" signal the PM needs
  const summaryBlock = state.reviewSummary
    ? '\n' + (state.reviewSummary.length > 1500 ? state.reviewSummary.slice(0, 1500) + '\n…(truncated)' : state.reviewSummary)
    : ''
  void safeSend(state.pmThreadId, `🏭 🏁 ${eventLine(state)} — review complete${linkLabel}\n↳ factory_accept / factory_retry / factory_abandon${summaryBlock}`)
    .then(ids => { if (ids[0]) state.reviewMessageId = ids[0] })
    .catch(() => {})

  return true
}

function onFactoryReviewCancelled(threadId: string, reason?: string): boolean {
  const ticket = builderThreadToTicket.get(threadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}\n`)

  transitionFactoryPhase(state, 'awaiting_pm')
  const reasonStr = reason ? ` (${reason})` : ''
  void safeSend(state.pmThreadId, `🏭 ⚠️ ${eventLine(state)} — review cancelled${reasonStr}, builder still alive\n↳ factory_retry / factory_abandon`)

  const failCount = (pmReviewFailures.get(state.pmThreadId) ?? 0) + 1
  pmReviewFailures.set(state.pmThreadId, failCount)
  if (failCount >= 3) {
    void safeSend(state.pmThreadId, `⚠️ Factory degraded: ${failCount} consecutive reviews have failed. Review system may be broken — consider accept_unreviewed or investigate critic health.`)
  }

  return true
}

function clearFactoryIdentity(info: SessionInfo): void {
  info.sessionType = 'thread_owner'
  delete info.factoryPmThreadId
  delete info.factoryTicket
  delete info.factoryPhase
  removeToolDescriptions(info, 'factory_done')
}

/**
 * Retire a build: stop its timers, drop both reverse lookups, release the
 * builder's factory identity, and remove it from the builds map.
 *
 * Dropping builderSessionToTicket is also what makes a deliberate teardown safe.
 * Every terminal path (accept, abandon, cascade, TTL expiry) kills the builder
 * and then calls this, and killSession is async — it awaits a gateway.send
 * before emitting session:death — so by the time that death lands, onBuilderDeath
 * can no longer resolve a ticket for the session and exits at its `if (!ticket)`.
 * A deliberate kill therefore cannot be reported as a crash, structurally,
 * without any need for an "is this kill intentional?" flag. Keep the kill-then-
 * cleanup order in that frame and the property holds.
 */
function cleanupState(ticket: string): void {
  const state = builds.get(ticket)
  if (!state) return
  clearAwaitingPmTtl(state)
  if (state.builderSessionId) {
    builderSessionToTicket.delete(state.builderSessionId)
    clearBuilderNudge(state.builderSessionId)
    const info = registry.get(state.builderSessionId)
    if (info) {
      clearFactoryIdentity(info)
      registry.persist()
      pushToolSurface(state.builderSessionId)
    }
  }
  if (state.builderThreadId) builderThreadToTicket.delete(state.builderThreadId)
  builds.delete(ticket)

  // The board outlives any single build — retire it only once the PM thread has
  // nothing left in flight.
  if (activeBuildsInThread(state.pmThreadId).length === 0) finalizeProgress(state.pmThreadId)
  else refreshProgress(state.pmThreadId, false)
}

// ---------------------------------------------------------------------------
// Event bus subscriptions
// ---------------------------------------------------------------------------

/** Builds a PM still owns — anything not yet terminal. */
function activePmBuilds(sessionId: string): FactoryBuildState[] {
  return [...builds.values()].filter(s =>
    s.pmSessionId === sessionId && s.phase !== 'complete' && s.phase !== 'failed'
  )
}

/**
 * PM death is gentle: the builders live on.
 *
 * A dying PM used to take every in-flight build with it — the handler treated
 * its own death as "nobody will ever come back." But the PM *thread* survives,
 * factory state lives in daemon memory, and each builder is self-sufficient in
 * its own thread. So the handler now only reports: builders keep building,
 * reviews keep running, and the next session to register in the PM thread
 * adopts them (see factoryAdopt). Destruction is opt-in via factoryCascadeKill.
 */
function factorySessionDeath({ sessionId }: { sessionId: string }): void {
  onBuilderDeath(sessionId)

  const orphaned = activePmBuilds(sessionId)
  if (orphaned.length === 0) return

  process.stderr.write(`daemon: factory: PM ${sessionId} died with ${orphaned.length} in-flight build(s) — leaving them running\n`)

  // Grouped by thread: one notice per thread, addressed to the seat that will
  // inherit those builds. A PM session normally holds a single thread, but the
  // notice has to land where the successor will read it either way.
  const byThread = new Map<string, FactoryBuildState[]>()
  for (const state of orphaned) {
    const group = byThread.get(state.pmThreadId)
    if (group) group.push(state)
    else byThread.set(state.pmThreadId, [state])
  }

  for (const [pmThreadId, group] of byThread) {
    const lines = group.map(s => `  ${formatBuildLine(s)}`).join('\n')
    void safeSend(
      pmThreadId,
      `🏭 PM session ended · ${group.length} build${group.length > 1 ? 's' : ''} in-flight\n${lines}\n↳ respawn to resume management`,
    ).catch(() => {})
  }
}

/**
 * The old destructive PM-death path, now reachable only by explicit intent
 * (`kill!` / `kill --cascade`). Kills every builder this PM owns, cancels
 * in-flight reviews, and clears the state.
 *
 * Scoped by thread as well as session: after a gentle death that no successor
 * has adopted yet, `pmSessionId` still points at the corpse, and a cascade
 * from the seat's current occupant must still reach those builds.
 *
 * Returns the number of builds torn down.
 */
export function factoryCascadeKill(sessionId: string): number {
  const pmThreadId = registry.get(sessionId)?.threadId
  const doomed = [...builds.entries()].filter(([_, s]) =>
    s.pmSessionId === sessionId || (pmThreadId !== undefined && s.pmThreadId === pmThreadId)
  )

  for (const [ticket, state] of doomed) {
    process.stderr.write(`daemon: factory: cascade kill of build ${state.ticket} (PM ${sessionId})\n`)
    const wasPhase = state.phase

    // Terminal phase before the kill. Two independent things then keep this
    // deliberate teardown from being reported as a crash: onBuilderDeath's
    // if/else chain covers only building|reviewing|awaiting_pm, so `failed`
    // falls through; and cleanupState below drops the reverse lookup the handler
    // needs, before any real session:death can land. See cleanupState.
    transitionFactoryPhase(state, 'failed')
    logBuild(state, 'pm_cascade_kill')

    // Cancel any in-flight review so the critic doesn't orphan
    if (wasPhase === 'reviewing' && state.builderThreadId) {
      const run = getRunByThread(state.builderThreadId)
      if (run) {
        void cancelRun(run, 'PM cascade kill').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on cascade kill failed: ${err}\n`)
        })
      }
    }

    killBuilder(state, true)
    cleanupState(ticket)
  }

  return doomed.length
}

/**
 * A session registered in a thread that holds builds whose PM is gone — take
 * over as PM.
 *
 * Adoption is about routing, not authority: authorizePmThread already lets any
 * session in the PM thread act on these builds. What adoption fixes is where
 * notifications land and who the builder is told to ask questions of.
 *
 * Fires on every bridge registration (reconnects included), so it must stay
 * idempotent — once `pmSessionId` points at a live session the filter is empty.
 */
function factoryAdopt({ sessionId, threadId }: { sessionId: string; threadId: string }): void {
  const newPmInfo = registry.get(sessionId)
  // Guests (critics, judges) pass through a thread without taking its seat.
  if (!newPmInfo || newPmInfo.sessionType === 'thread_guest') return

  const orphaned = [...builds.values()].filter(s =>
    s.pmThreadId === threadId &&
    s.pmSessionId !== sessionId &&
    s.phase !== 'complete' && s.phase !== 'failed' &&
    !registry.get(s.pmSessionId)
  )
  if (orphaned.length === 0) return

  const newPmName = newPmInfo.tmuxName

  for (const state of orphaned) {
    state.pmSessionId = sessionId
    if (!state.builderSessionId) continue
    transport.sendOrQueue(state.builderSessionId, {
      type: 'notification',
      content: `[system] PM session replaced. New PM: ${newPmName}. Use send_to_thread(target="${newPmName}") for questions.`,
      meta: { chat_id: state.builderThreadId ?? '', message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }

  // Builds already awaiting a decision carry an inherited deadline the successor
  // had no way to know about — a PM adopting at hour 23 has an hour, not a day.
  const lines = orphaned.map(s => {
    const remaining = awaitingPmRemainingMs(s)
    const deadline = remaining !== undefined ? ` · decide within ${formatDuration(remaining)}` : ''
    return `  ${formatBuildLine(s)}${deadline}`
  }).join('\n')
  void safeSend(threadId, `🤝 Adopted ${orphaned.length} build${orphaned.length > 1 ? 's' : ''}\n${lines}`).catch(() => {})

  process.stderr.write(`daemon: factory: adopted ${orphaned.length} build(s) for new PM ${newPmName} in thread ${threadId}\n`)
}

function factoryReviewComplete({ threadId, summary }: { threadId: string; summary?: string }): void {
  onFactoryReviewComplete(threadId, summary)
}

function factoryReviewCancelled({ threadId, reason }: { threadId: string; reason?: string }): void {
  onFactoryReviewCancelled(threadId, reason)
}

protocolEvents.onComplete((event: CompletionEvent) => {
  if (event.protocol !== 'review') return
  if (event.outcome === 'complete') {
    factoryReviewComplete({ threadId: event.threadId, summary: event.summary })
  } else {
    factoryReviewCancelled({ threadId: event.threadId, reason: event.reason })
  }
})
on('session:death', factorySessionDeath, 'factory:session-death')
on('session:bridge-registered', factoryAdopt, 'factory:adopt')

// A review round advancing is the only thing that moves a build's status line
// between ticks — repaint the board so a 20-minute review isn't three minutes
// stale on every round.
protocolEvents.onPhaseChange((event) => {
  if (event.protocol !== 'review') return
  const ticket = builderThreadToTicket.get(event.threadId)
  if (!ticket) return
  const state = builds.get(ticket)
  if (state) refreshProgress(state.pmThreadId, false)
})

// Register factory hooks so builders get factory_done via scoped tool overrides.
// getByThread returns false — factory does NOT occupy threads for mutual exclusion.
// The builder's thread must remain free for the nested review to start.
// isParticipant is gated to building phase — during review, the review protocol
// owns the session. Without this gate, both protocols claim the session and
// resolution depends on Map iteration order (registration order).
registerProtocol('factory', {
  getByThread: () => false,
  isParticipant: (sessionId) => {
    const ticket = builderSessionToTicket.get(sessionId)
    if (!ticket) return false
    const state = builds.get(ticket)
    return !!state && state.phase === 'building'
  },
  onReply: () => {},
  onDisconnect: () => {},
  onReconnect: (sessionId) => {
    if (builderSessionToTicket.has(sessionId)) clearBuilderNudge(sessionId)
  },
})

// ---------------------------------------------------------------------------
// Test seam — mirrors protocol-runner's __test
// ---------------------------------------------------------------------------

export const __test = process.env.NODE_ENV === 'test'
  ? {
      builds, builderSessionToTicket, builderThreadToTicket,
      // transitionFactoryPhase is the only door into awaiting_pm that arms the
      // TTL; seedBuild sets the field without going through it.
      AWAITING_PM_TTL_MS, expireAwaitingPm, transitionFactoryPhase,
      /** Shrink the TTL so a case can drive the real setTimeout end to end. */
      setAwaitingPmTtl(ms: number): void { awaitingPmTtlMs = () => ms },
      resetAwaitingPmTtl(): void { awaitingPmTtlMs = () => AWAITING_PM_TTL_MS },
      // The event-bus handlers, so a test can restore the subscriptions another
      // test file's _resetForTesting() wiped.
      factorySessionDeath, factoryAdopt,
      /** Register a build directly, bypassing the spawn path. */
      seedBuild(partial: Partial<FactoryBuildState> & Pick<FactoryBuildState, 'ticket' | 'pmThreadId' | 'pmSessionId'>): FactoryBuildState {
        const spec = partial.spec ?? 'test spec'
        const state: FactoryBuildState = {
          spec,
          specTag: deriveSpecTag(spec),
          reviewRounds: 3,
          phase: 'building',
          retryCount: 0,
          createdAt: Date.now(),
          reviewed: false,
          ...partial,
        }
        builds.set(state.ticket, state)
        if (state.builderSessionId) builderSessionToTicket.set(state.builderSessionId, state.ticket)
        if (state.builderThreadId) builderThreadToTicket.set(state.builderThreadId, state.ticket)
        return state
      },
      boards, BOARD_HISTORY_CAP,
      /** Drive one board tick without waiting out PROGRESS_INTERVAL_MS. */
      tickProgress(pmThreadId: string): void {
        if (activeBuildsInThread(pmThreadId).length === 0) finalizeProgress(pmThreadId)
        else if (advancingBuildsInThread(pmThreadId).length === 0) stopProgressUpdates(pmThreadId)
        else refreshProgress(pmThreadId, true)
      },
      startProgressUpdates,
      reset(): void {
        // A live 24h timer would hold the test runner's event loop open.
        for (const state of builds.values()) clearAwaitingPmTtl(state)
        for (const pmThreadId of [...boards.keys()]) stopProgressUpdates(pmThreadId)
        boards.clear()
        builds.clear()
        builderSessionToTicket.clear()
        builderThreadToTicket.clear()
        pmReviewFailures.clear()
        awaitingPmTtlMs = () => AWAITING_PM_TTL_MS
      },
      setLifecycle(overrides: { killSession?: typeof _killSession }) {
        if (overrides.killSession) killSession = overrides.killSession
      },
      resetLifecycle() {
        killSession = _killSession
      },
    } as const
  : undefined

/**
 * Startup sweep: kill orphaned factory builders left by a daemon restart.
 */
export async function sweepOrphanedBuilders(): Promise<void> {
  let swept = 0
  const builders = [...registry.values()].filter(i => i.sessionType === 'factory_builder')
  for (const info of builders) {
    const pmThreadId = info.factoryPmThreadId
    const ticketInfo = info.factoryTicket ? ` (ticket: \`${info.factoryTicket}\`, phase: ${info.factoryPhase ?? 'unknown'})` : ''

    // Leave awaiting_pm builders alive — they hold completed work the PM hasn't accepted yet
    if (info.factoryPhase === 'awaiting_pm') {
      process.stderr.write(`daemon: factory: leaving awaiting_pm builder ${info.tmuxName} alive${ticketInfo}\n`)
      // Release factory identity — no in-memory builds map after restart,
      // so the PM can't accept/retry/abandon. Restore full thread_owner tools.
      // No pushToolSurface here: bridges aren't connected at startup; the
      // reconnect path reads the updated SessionInfo.
      clearFactoryIdentity(info)
      // Preserve as-is for the PM to peek/kill — the automatic boot recovery batch
      // must NOT revive it (would re-run completed-but-unaccepted work). Manual
      // `recover` is unaffected. clearFactoryIdentity left it a plain thread_owner,
      // so this marker is the only signal auto-recovery has to skip it.
      info.suppressAutoRecover = true
      registry.persist()
      if (pmThreadId) {
        void safeSend(pmThreadId, `🏭 \`${info.tmuxName}\` survived restart${ticketInfo} — peek/kill when ready`).catch(() => {})
      }
      continue
    }

    process.stderr.write(`daemon: factory: sweeping orphaned builder ${info.tmuxName} (${info.sessionId})\n`)
    // A builder swept mid-build (building/reviewing) may hold locally-committed but unpushed
    // work on its worktree branch — the "commit and push before factory_done" step hasn't run
    // yet. Preserve the branch instead of letting killSession's `branch -D` delete it, and
    // surface it to the PM for manual recovery. (Same worktree-losslessness the worker recovery
    // path guarantees — factory builders are build sessions with worktrees too.)
    let skipWorktreeDestroy = false
    let savedWatches: ReturnType<typeof getWatchesBySession> = []
    let preserved: SessionInfo | undefined  // pre-kill snapshot to re-persist (decoupled from killSession's mutations)
    if (info.worktreeRepo && info.worktreePath) {
      const branch = info.worktreeBranch ?? `wt/${info.tmuxName}`
      const unpushed = await checkUnpushedCommits(info.worktreeRepo, branch)
      if (unpushed !== 0) {
        skipWorktreeDestroy = true
        // Snapshot the record + its PR watches (with seen-cursors) BEFORE the kill: killSession
        // deletes the record and unwatchBySession drops the watches. Re-persisting from this
        // pristine copy (not the live `info`) means a future killSession that mutates fields
        // before deletion can't corrupt the preserved record. Restoring the watches matches
        // recoverOne so a manual `recover` resumes them without re-notifying / missing a CI change.
        preserved = { ...info }
        savedWatches = getWatchesBySession(info.sessionId)
        const note = unpushed > 0 ? `${unpushed} unpushed commit(s)` : `possibly-unpushed commits (couldn't verify)`
        process.stderr.write(`daemon: factory: preserving worktree branch ${branch} for orphaned ${info.tmuxName} — ${note}\n`)
        if (pmThreadId) {
          void safeSend(pmThreadId, `🏭 \`${info.tmuxName}\` orphaned by restart${ticketInfo} — branch \`${branch}\` preserved (${note}); recover it manually before deleting.`).catch(() => {})
        }
      }
    }
    try {
      await killSession(info, 'orphaned factory builder (daemon restarted)', skipWorktreeDestroy ? { skipWorktreeDestroy: true } : undefined)
    } catch (err) {
      process.stderr.write(`daemon: factory: sweep kill failed for ${info.tmuxName}: ${err}\n`)
    }
    // Log the orphan for history
    const orphanState: FactoryBuildState = {
      ticket: info.factoryTicket ?? 'unknown',
      pmThreadId: pmThreadId ?? 'unknown',
      pmSessionId: 'unknown',
      spec: '(orphaned — daemon restarted)',
      reviewRounds: 0,
      phase: 'failed',
      retryCount: 0,
      createdAt: info.createdAt,
      reviewed: false,

    }
    logBuild(orphanState, 'orphaned')

    if (skipWorktreeDestroy && preserved) {
      // killSession deleted the record, which drops pickSessionName's reservation of the
      // preserved branch's name — a later same-repo spawn could then draw that freed name and
      // branch -D it, destroying the commits we just saved. Re-persist a dead, non-auto-
      // recoverable thread_owner (from the pre-kill snapshot) so the reservation holds and the
      // branch stays salvageable via manual `recover` (mirrors the awaiting_pm identity release).
      clearFactoryIdentity(preserved)
      preserved.deadAt = preserved.deadAt ?? Date.now()
      preserved.suppressAutoRecover = true
      // killSession may have discovered+assigned claudeSessionId from the still-alive pane
      // (its one pre-delete mutation). Carry just that field forward so a later `recover` can
      // still do a full-context tier-1 resume; the pre-kill snapshot protects every other field.
      preserved.claudeSessionId ??= info.claudeSessionId
      registry.set(preserved.sessionId, preserved)
      registry.setThread(preserved.threadId, preserved.sessionId)
      if (savedWatches.length > 0) restoreWatches(savedWatches, preserved.sessionId, preserved.threadId)
      registry.persist()
    } else if (pmThreadId) {
      void safeSend(pmThreadId, `🏭 \`${info.tmuxName}\`${ticketInfo} orphaned — killed on restart`).catch(() => {})
    }
    swept++
  }
  if (swept > 0) process.stderr.write(`daemon: factory: swept ${swept} orphaned builder(s)\n`)
}
