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
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { startProtocolRun, getRunByThread, cancelRun, protocolEvents } from './protocol-runner.js'
import type { CompletionEvent } from './protocol-types.js'
import reviewProto from '../protocols/review.js'
import { registry, threadRegistry } from './sessions.js'
import { safeSend, formatDuration, getContextPercent } from './util.js'
import { resolveModelAlias, isKnownModel } from '../shared/constants.js'
import { transport } from './bridge-transport.js'
import { on } from './event-bus.js'
import { registerProtocol } from './protocol-registry.js'
import { clearBuilderNudge } from './pane-probe.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FactoryPhase = 'building' | 'reviewing' | 'awaiting_pm' | 'complete' | 'failed'

type FactoryBuildState = {
  ticket: string
  pmThreadId: string
  pmSessionId: string
  spec: string
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
  _progressTimer?: ReturnType<typeof setInterval> // periodic progress update timer
}

// ---------------------------------------------------------------------------
// State — keyed by ticket (supports parallel builds per PM)
// ---------------------------------------------------------------------------

const builds = new Map<string, FactoryBuildState>()

// Reverse lookups
const builderSessionToTicket = new Map<string, string>()   // builderSessionId → ticket
const builderThreadToTicket = new Map<string, string>()     // builderThreadId → ticket

let ticketCounter = 0

// Build history log
const LOG_DIR = join(process.env.HOME ?? '/tmp', '.hydra', 'factory')
let logDirReady = false

function ensureLogDir(): void {
  if (logDirReady) return
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
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
    appendFileSync(join(LOG_DIR, 'history.jsonl'), JSON.stringify(entry) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: factory: log failed: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// Progress updates — periodic status messages during build and review
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 3 * 60_000 // every 3 minutes

function startProgressUpdates(state: FactoryBuildState): void {
  if (state._progressTimer) return
  state._progressTimer = setInterval(() => {
    if (state.phase !== 'building' && state.phase !== 'reviewing') {
      stopProgressUpdates(state)
      return
    }
    const info = state.builderSessionId ? registry.get(state.builderSessionId) : undefined
    if (!info) return
    const elapsed = formatDuration(Date.now() - state.createdAt)
    const ctx = getContextPercent(info.tmuxName)
    const ctxStr = ctx !== '?' ? ` · ctx ${ctx}` : ''
    const phase = state.phase === 'reviewing' ? 'under review' : 'building'
    void safeSend(state.pmThreadId, `🏭 _${info.tmuxName} ${phase} · ${elapsed} elapsed${ctxStr} · ticket \`${state.ticket}\`_`).catch(() => {})
  }, PROGRESS_INTERVAL_MS)
}

function stopProgressUpdates(state: FactoryBuildState): void {
  if (state._progressTimer) {
    clearInterval(state._progressTimer)
    state._progressTimer = undefined
  }
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
      const suggestion = pmInfo?.capabilities?.cwd
        ? suggestWorktreeFromCwd(pmInfo.capabilities.cwd, spawnCwd)
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
    state.phase = 'failed'
    logBuild(state, 'spawn_failed')
    cleanupState(ticket)
    void safeSend(pmThreadId, `🏭 \`${ticket}\` ❌ spawn failed — ${errMsg}`)
  })

  return { ticket, warning }
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
  if (state.pmSessionId !== callerSessionId) return { error: 'Only the PM that started this build can retry it.' }
  if (state.phase !== 'awaiting_pm') return { error: `Cannot retry — build is in phase "${state.phase}", expected "awaiting_pm".` }

  if (!state.builderSessionId || !state.builderThreadId) return { error: 'Builder session not found — use factory_build to start a new build.' }
  const builderInfo = registry.get(state.builderSessionId)
  if (!builderInfo) return { error: 'Builder session no longer exists — use factory_build to start a new build.' }

  state.phase = 'building'
  state.retryCount++
  syncPhaseToRegistry(state)

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

  void safeSend(state.pmThreadId, `🏭 \`${ticket}\` retrying (attempt ${state.retryCount + 1})`)

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
  if (state.pmSessionId !== callerSessionId) return { error: 'Only the PM that started this build can accept it.' }
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

  state.phase = 'complete'
  logBuild(state, state.reviewed ? 'accepted' : 'accepted_unreviewed')

  const reviewWarning = state.reviewed ? '' : ' (unreviewed)'
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ✅ accepted${reviewWarning}`)

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
  if (state.pmSessionId !== callerSessionId) return { error: 'Only the PM that started this build can abandon it.' }
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
  state.phase = 'failed'
  logBuild(state, 'abandoned')

  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` abandoned${reason ? ' — ' + reason.slice(0, 200) : ''}`)

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

/** Sync phase to registry for daemon-restart recovery. */
function syncPhaseToRegistry(state: FactoryBuildState): void {
  if (state.builderSessionId) {
    const info = registry.get(state.builderSessionId)
    if (info) {
      info.factoryPhase = state.phase
      // Use direct persist (not debounced) — factoryPhase is load-bearing for
      // restart recovery: retry/accept/abandon need the correct phase after a crash.
      registry.persist()
    }
  }
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

  const cwd = info.worktreePath ?? info.capabilities?.cwd
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

function killBuilder(state: FactoryBuildState, deleteThread: boolean = false): void {
  const threadToDelete = deleteThread && state.builderThreadId && gateway.deleteThread
    ? state.builderThreadId : undefined

  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      const killPromise = killSession(builderInfo, 'factory complete').catch(() => {})
      // Delete thread AFTER killSession completes — killSession may post
      // unpushed-commit warnings to the thread that would be swallowed otherwise
      if (threadToDelete) {
        void killPromise.finally(() => {
          gateway.deleteThread!(threadToDelete).catch(err => {
            process.stderr.write(`daemon: factory: thread cleanup failed: ${err instanceof Error ? err.message : err}\n`)
          })
        })
      }
      return
    }
  }
  // No builder session to kill — delete thread directly
  if (threadToDelete) {
    void gateway.deleteThread!(threadToDelete).catch(err => {
      process.stderr.write(`daemon: factory: thread cleanup failed: ${err instanceof Error ? err.message : err}\n`)
    })
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
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` building · ${builderShort}→${reviewerShort}${worktreeLabel}${spawnLabel}\n${specPreview}`)

  const chatId = resolveBuilderChannel(state.pmSessionId, state.pmThreadId)
  const initiator = pmName

  const result = await doSpawnSession(`factory-builder: ${state.spec.slice(0, 60)}`, chatId, undefined, {
    ...(forkInfo ? { forkFrom: { claudeSessionId: forkInfo.claudeSessionId, parentName: forkInfo.tmuxName } } : {}),
    model: state.builderModel,
    promptPrefix: builderPrompt,
    ...(initiator ? { initiator } : {}),
    ...(state.worktree ? { worktree: state.worktree } : {}),
    scopedToolOverrides: { factory_done: 'Signal that your factory build is complete. Triggers mandatory adversarial review.' },
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  builderSessionToTicket.set(result.sessionId, state.ticket)
  builderThreadToTicket.set(result.threadId, state.ticket)

  // Stamp registry fields for sweep notifications + phase-aware restart messages.
  const builderInfo = registry.get(result.sessionId)
  if (builderInfo) {
    builderInfo.isFactoryBuilder = true
    builderInfo.factoryPmThreadId = state.pmThreadId
    builderInfo.factoryTicket = state.ticket
    builderInfo.factoryPhase = state.phase
    registry.persist()
  }

  process.stderr.write(`daemon: factory: builder ${result.name} (${result.sessionId}) ${isFresh ? 'spawned' : 'forked'} for ticket ${state.ticket}\n`)

  // Start periodic progress updates so PM gets status during long builds
  startProgressUpdates(state)
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

  state.phase = 'reviewing'
  syncPhaseToRegistry(state)
  process.stderr.write(`daemon: factory: builder called factory_done for ticket ${state.ticket}, starting review\n`)

  void doBuilderDoneAsync(state, args)

  return { ok: true }
}

async function doBuilderDoneAsync(state: FactoryBuildState, args: FactoryDoneArgs): Promise<void> {
  const fileCount = args.files_changed.length
  const testShort = args.test_results.slice(0, 80)
  const branchLabel = args.branch ? ` · \`${args.branch}\`` : ''
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` reviewing · ${fileCount} file${fileCount !== 1 ? 's' : ''}${branchLabel} · ${testShort}`)

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
      state.phase = 'awaiting_pm'
      syncPhaseToRegistry(state)
      void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ⚠️ review failed — ${errMsg}\n↳ factory_retry / factory_accept / factory_abandon`)
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
    state.phase = 'failed'
    logBuild(state, 'builder_crashed')
    void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ❌ builder crashed (no factory_done)`)
    cleanupState(ticket)
  } else if (state.phase === 'reviewing') {
    // Builder died during review — cancel the review defensively to avoid leaking state.
    // Normally the review system handles this, but if it misses the death we'd leak.
    process.stderr.write(`daemon: factory: builder died during review for ticket ${state.ticket}, cancelling review\n`)
    state.phase = 'failed'
    logBuild(state, 'builder_died_reviewing')
    if (state.builderThreadId) {
      const run = getRunByThread(state.builderThreadId)
      if (run) {
        void cancelRun(run, 'builder crashed during review').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on builder death failed: ${err}\n`)
        })
      }
    }
    void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ❌ builder crashed during review`)
    cleanupState(ticket)
  } else if (state.phase === 'awaiting_pm') {
    process.stderr.write(`daemon: factory: builder died while awaiting PM for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ⚠️ builder exited (work on disk, ticket closed)`)
    state.phase = 'failed'
    logBuild(state, 'builder_died_awaiting')
    cleanupState(ticket)
  }
}

function onFactoryReviewComplete(builderThreadId: string, summaryText?: string): boolean {
  const ticket = builderThreadToTicket.get(builderThreadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  // Move to awaiting_pm — builder stays alive for potential retry
  state.phase = 'awaiting_pm'
  state.reviewed = true
  if (summaryText) state.reviewSummary = summaryText
  syncPhaseToRegistry(state)
  process.stderr.write(`daemon: factory: review complete for ticket ${state.ticket}, awaiting PM decision\n`)

  // prUrl/diffGistUrl were captured at factory_done time — use synchronously, no race.
  const diffLink = state.prUrl ?? state.diffGistUrl
  const linkLabel = diffLink ? ` · ${diffLink}` : ''
  // Keep review summary — it's the "what was reviewed" signal the PM needs
  const summaryBlock = state.reviewSummary
    ? '\n' + (state.reviewSummary.length > 1500 ? state.reviewSummary.slice(0, 1500) + '\n…(truncated)' : state.reviewSummary)
    : ''
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` review complete${linkLabel}\n↳ factory_accept / factory_retry / factory_abandon${summaryBlock}`)

  return true
}

function onFactoryReviewCancelled(threadId: string, reason?: string): boolean {
  const ticket = builderThreadToTicket.get(threadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}${reason ? ` (${reason})` : ''}\n`)

  // Move to awaiting_pm so PM can retry
  state.phase = 'awaiting_pm'
  syncPhaseToRegistry(state)
  const reasonStr = reason ? ` (${reason})` : ''
  void safeSend(state.pmThreadId, `🏭 \`${state.ticket}\` ⚠️ review cancelled${reasonStr} — builder still alive\n↳ factory_retry / factory_abandon`)

  return true
}

function cleanupState(ticket: string): void {
  const state = builds.get(ticket)
  if (!state) return
  stopProgressUpdates(state)
  if (state.builderSessionId) {
    builderSessionToTicket.delete(state.builderSessionId)
    clearBuilderNudge(state.builderSessionId)
    const info = registry.get(state.builderSessionId)
    if (info) {
      delete info.isFactoryBuilder
      delete info.factoryPmThreadId
      delete info.factoryTicket
      delete info.factoryPhase
      registry.persist()
    }
  }
  if (state.builderThreadId) builderThreadToTicket.delete(state.builderThreadId)
  builds.delete(ticket)
}

// ---------------------------------------------------------------------------
// Event bus subscriptions
// ---------------------------------------------------------------------------

function factorySessionDeath({ sessionId }: { sessionId: string }): void {
  onBuilderDeath(sessionId)

  // PM death: clean up all pending builds, cancel reviews, kill orphaned builders
  const pmBuilds = [...builds.entries()].filter(([_, s]) => s.pmSessionId === sessionId)
  for (const [ticket, state] of pmBuilds) {
    process.stderr.write(`daemon: factory: PM ${sessionId} died with active build ${state.ticket}, cleaning up\n`)
    // Cancel any in-flight review so the critic doesn't orphan
    if (state.phase === 'reviewing' && state.builderThreadId) {
      const run = getRunByThread(state.builderThreadId)
      if (run) {
        void cancelRun(run, 'PM session died').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on PM death failed: ${err}\n`)
        })
      }
    }
    killBuilder(state, true)
    state.phase = 'failed'
    logBuild(state, 'pm_died')
    cleanupState(ticket)
  }
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
  resolveScopedToolOverrides: (sessionId) => {
    if (!builderSessionToTicket.has(sessionId)) return null
    const ticket = builderSessionToTicket.get(sessionId)!
    const state = builds.get(ticket)
    if (!state || state.phase !== 'building') return null
    return { factory_done: 'Signal that your factory build is complete. Triggers mandatory adversarial review.' }
  },
})

/**
 * Startup sweep: kill orphaned factory builders left by a daemon restart.
 */
export async function sweepOrphanedBuilders(): Promise<void> {
  let swept = 0
  const builders = [...registry.values()].filter(i => i.isFactoryBuilder)
  for (const info of builders) {
    const pmThreadId = info.factoryPmThreadId
    const ticketInfo = info.factoryTicket ? ` (ticket: \`${info.factoryTicket}\`, phase: ${info.factoryPhase ?? 'unknown'})` : ''

    // Leave awaiting_pm builders alive — they hold completed work the PM hasn't accepted yet
    if (info.factoryPhase === 'awaiting_pm') {
      process.stderr.write(`daemon: factory: leaving awaiting_pm builder ${info.tmuxName} alive${ticketInfo}\n`)
      if (pmThreadId) {
        void safeSend(pmThreadId, `🏭 \`${info.tmuxName}\` survived restart${ticketInfo} — peek/kill when ready`).catch(() => {})
      }
      continue
    }

    process.stderr.write(`daemon: factory: sweeping orphaned builder ${info.tmuxName} (${info.sessionId})\n`)
    try {
      await killSession(info, 'orphaned factory builder (daemon restarted)')
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

    if (pmThreadId) {
      void safeSend(pmThreadId, `🏭 \`${info.tmuxName}\`${ticketInfo} orphaned — killed on restart`).catch(() => {})
    }
    swept++
  }
  if (swept > 0) process.stderr.write(`daemon: factory: swept ${swept} orphaned builder(s)\n`)
}
