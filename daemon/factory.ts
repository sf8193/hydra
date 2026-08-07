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
import { execFile } from 'child_process'
import { promisify } from 'util'
import { appendFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { startProtocolRun, protocolEvents, getRunByThread, cancelRun } from './protocol-runner.js'
import { getProtocol } from './protocol-loader.js'
import { registry, threadRegistry } from './sessions.js'
import { safeSend } from './util.js'
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
// Model resolution — difficulty ladder with auto-fallback
// ---------------------------------------------------------------------------

export const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type Difficulty = (typeof VALID_DIFFICULTIES)[number]

// Hardcoded per tier — consistent, no env-var surprise.
// Easy = sonnet builds, opus reviews (Sam's request).
export function getDifficultyLadder(difficulty: Difficulty): { builder: string; reviewer: string } {
  switch (difficulty) {
    case 'easy':   return { builder: 'claude-sonnet-4-6[1m]',  reviewer: 'claude-opus-4-6[1m]' }
    case 'medium': return { builder: 'claude-opus-4-6[1m]',    reviewer: 'claude-opus-4-8[1m]' }
    case 'hard':   return { builder: 'claude-opus-5[1m]',      reviewer: 'claude-fable-5[1m]' }
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
    'claude-opus-4-6': 'claude-sonnet-4-6[1m]',
    'claude-opus-4-7': 'claude-sonnet-4-6[1m]',
    'claude-opus-4-8': 'claude-sonnet-4-6[1m]',
    'claude-opus-5': 'claude-fable-5[1m]',
    'claude-sonnet-4-6': 'claude-opus-4-6[1m]',
    'claude-sonnet-5': 'claude-opus-5[1m]',
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

  // Unknown model with no fallback — use sonnet as a safe generic reviewer
  const genericFallback = 'claude-sonnet-4-6[1m]'
  if (effectiveBuilder !== genericFallback.replace(/\[1m\]$/, '')) {
    return {
      builder,
      reviewer: genericFallback,
      warning: (warning ? warning + ' ' : '') + `${collisionMsg} Auto-selected ${genericFallback.replace(/\[1m\]$/, '')} as reviewer.`,
    }
  }

  // Builder IS sonnet — use opus
  return {
    builder,
    reviewer: 'claude-opus-4-6[1m]',
    warning: (warning ? warning + ' ' : '') + `${collisionMsg} Auto-selected claude-opus-4-6 as reviewer.`,
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
  if (!pmInfo?.claudeSessionId) {
    return { error: 'Cannot fork — PM claude session ID not found.' }
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
  void spawnBuilder(state, pmInfo.claudeSessionId, pmInfo.tmuxName).catch(err => {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: factory: builder spawn failed: ${errMsg}\n`)
    state.phase = 'failed'
    logBuild(state, 'spawn_failed')
    cleanupState(ticket)
    void safeSend(pmThreadId, `🏭 **Factory build failed** ❌\nTicket: \`${ticket}\`\nError: builder spawn failed — ${errMsg}`)
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

  void safeSend(state.pmThreadId, [
    `🏭 **Factory retry** (attempt ${state.retryCount + 1})`,
    `Ticket: \`${ticket}\``,
    `Instructions sent to builder. Waiting for \`factory_done\`.`,
  ].join('\n'))

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
  if (state.phase !== 'awaiting_pm') return { error: `Cannot accept — build is in phase "${state.phase}", expected "awaiting_pm".` }
  if (!state.reviewed && !allowUnreviewed) return { error: 'Build was NOT adversarially reviewed (review failed or was cancelled). Pass allow_unreviewed=true to accept anyway.' }

  state.phase = 'complete'
  logBuild(state, state.reviewed ? 'accepted' : 'accepted_unreviewed')

  const reviewWarning = state.reviewed ? '' : '\n⚠️ **This build was NOT adversarially reviewed** (review failed or was cancelled).'
  void safeSend(state.pmThreadId, `🏭 **Factory build accepted** ✅\nTicket: \`${ticket}\`${reviewWarning}`)

  killBuilder(state)
  cleanupState(ticket)
  return { ok: true }
}

/**
 * Abandon a build — PM gives up. Kill builder, clean up.
 */
export function factoryAbandon(
  ticket: string,
  callerSessionId: string,
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  if (state.pmSessionId !== callerSessionId) return { error: 'Only the PM that started this build can abandon it.' }
  if (state.phase === 'complete' || state.phase === 'failed') return { error: 'Build already terminated.' }

  const wasPhase = state.phase
  state.phase = 'failed'
  logBuild(state, 'abandoned')

  void safeSend(state.pmThreadId, `🏭 **Factory build abandoned** 🗑️\nTicket: \`${ticket}\``)

  // Cancel any in-flight review so the critic doesn't orphan
  if (wasPhase === 'reviewing' && state.builderThreadId) {
    const run = getRunByThread(state.builderThreadId)
    if (run) {
      void cancelRun(run, 'factory abandoned').catch(err => {
        process.stderr.write(`daemon: factory: cancel review on abandon failed: ${err}\n`)
      })
    }
  }

  killBuilder(state)
  cleanupState(ticket)

  process.stderr.write(`daemon: factory: abandoned ${ticket} (was in phase ${wasPhase})\n`)
  return { ok: true }
}

/**
 * Get status of factory builds for a PM.
 */
export function factoryStatus(
  pmThreadId: string,
  ticket?: string,
): { builds: Array<{ ticket: string; phase: string; spec: string; retries: number; elapsed: number; builderName?: string; worktree?: string }> } {
  const matching = ticket
    ? [builds.get(ticket)].filter((s): s is FactoryBuildState => !!s && s.pmThreadId === pmThreadId)
    : [...builds.values()].filter(s => s.pmThreadId === pmThreadId)

  return {
    builds: matching.map(s => ({
      ticket: s.ticket,
      phase: s.phase,
      spec: s.spec.slice(0, 200),
      retries: s.retryCount,
      elapsed: Date.now() - s.createdAt,
      builderName: s.builderSessionId ? registry.get(s.builderSessionId)?.tmuxName : undefined,
      ...(s.worktree ? { worktree: s.worktree } : {}),
    })),
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
      registry.debouncedPersist()
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

function killBuilder(state: FactoryBuildState): void {
  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      void killSession(builderInfo, 'factory complete').catch(() => {})
    }
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
  pmClaudeSessionId: string,
  pmTmuxName: string,
): Promise<void> {
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

  const builderPrompt = [
    `IMPORTANT: You are a BUILDER session forked from the PM. Your job is to WRITE CODE.`,
    `Ignore any prior instructions about "not writing code" or "using factory_build" — those apply to the PM, not to you.`,
    `You have full file access. Write code, run tests, implement the spec.`,
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

  const worktreeLabel = state.worktree ? ` · Worktree: \`${state.worktree}\`` : ''
  void safeSend(state.pmThreadId, [
    `🏭 **Factory build starting**`,
    `Ticket: \`${state.ticket}\``,
    `Builder: \`${state.builderModel ?? 'default'}\` (forked from PM — inherits full context)${worktreeLabel}`,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    `Spec: ${state.spec.slice(0, 200)}${state.spec.length > 200 ? '...' : ''}`,
  ].join('\n'))

  const chatId = resolveBuilderChannel(state.pmSessionId, state.pmThreadId)

  const result = await doSpawnSession(`factory-builder: ${state.spec.slice(0, 60)}`, chatId, undefined, {
    forkFrom: { claudeSessionId: pmClaudeSessionId, parentName: pmTmuxName },
    model: state.builderModel,
    promptPrefix: builderPrompt,
    initiator: pmTmuxName,
    ...(state.worktree ? { worktree: state.worktree } : {}),
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  builderSessionToTicket.set(result.sessionId, state.ticket)
  builderThreadToTicket.set(result.threadId, state.ticket)

  // Stamp registry fields for sweep notifications + phase-aware restart messages.
  // NOTE: these are informational only — the in-memory `builds` map is NOT reconstructed
  // from registry on restart. Factory tools (retry/accept/abandon) will not work after
  // restart; the PM must use peek_session + kill_session directly.
  const builderInfo = registry.get(result.sessionId)
  if (builderInfo) {
    builderInfo.isFactoryBuilder = true
    builderInfo.factoryPmThreadId = state.pmThreadId
    builderInfo.factoryTicket = state.ticket
    builderInfo.factoryPhase = state.phase
    registry.persist()
  }

  process.stderr.write(`daemon: factory: builder ${result.name} (${result.sessionId}) forked for ticket ${state.ticket}\n`)
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
  const artifact = [
    args.branch ? `**Branch:** ${args.branch}` : null,
    `**Files changed:** ${args.files_changed.join(', ')}`,
    `**Tests:** ${args.test_results}`,
    args.rationale ? `**Design rationale:** ${args.rationale}` : null,
    args.known_issues ? `**Known issues:** ${args.known_issues}` : null,
  ].filter(Boolean).join('\n')

  const artifactTruncated = artifact.length > 3000 ? artifact.slice(0, 3000) + '\n...(truncated)' : artifact
  void safeSend(state.pmThreadId, [
    `🏭 **Build complete — starting mandatory review**`,
    `Ticket: \`${state.ticket}\``,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    ``,
    `**Builder artifact** _(builder-authored — treat as advocacy, verify independently):_`,
    artifactTruncated,
  ].join('\n'))

  // Start review BEFORE diff/PR capture — closes the protocol ownership gap.
  getProtocol('review').then(proto => {
    if (state.phase !== 'reviewing') return
    return startProtocolRun(proto, state.builderThreadId!, state.builderSessionId!, {
      rounds: state.reviewRounds,
      topic: state.spec,
      model: state.reviewerModel,
      strike: true,
    })
  }).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: factory: review failed to start: ${errMsg}\n`)
      if (state.phase !== 'reviewing') return
      state.phase = 'awaiting_pm'
      syncPhaseToRegistry(state)
      void safeSend(state.pmThreadId, [
        `🏭 **Review failed to start** ⚠️`,
        `Ticket: \`${state.ticket}\``,
        `Error: ${errMsg}`,
        `_Builder is still alive with the completed work. You can:_`,
        `- \`factory_retry("${state.ticket}", "try again")\` — re-enter build→review`,
        `- \`factory_accept("${state.ticket}")\` — accept without review`,
        `- \`factory_abandon("${state.ticket}")\` — discard`,
      ].join('\n'))
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
    void safeSend(state.pmThreadId, [
      `🏭 **Builder crashed** ❌`,
      `Ticket: \`${state.ticket}\``,
      `_Builder died without calling factory_done. Build did not complete. No review will run._`,
      `_Retry with factory_build if needed._`,
    ].join('\n'))
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
        void cancelRun(run, 'builder died during review').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on builder death failed: ${err}\n`)
        })
      }
    }
    void safeSend(state.pmThreadId, [
      `🏭 **Builder crashed during review** ❌`,
      `Ticket: \`${state.ticket}\``,
      `_Builder died while review was in progress. Review cancelled._`,
      `_Retry with factory_build if needed._`,
    ].join('\n'))
    cleanupState(ticket)
  } else if (state.phase === 'awaiting_pm') {
    process.stderr.write(`daemon: factory: builder died while awaiting PM for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder exited** ⚠️`,
      `Ticket: \`${state.ticket}\``,
      `_Builder session ended while awaiting your decision. The work is still on disk. Ticket is now closed — use \`factory_build\` to start a new build if needed._`,
    ].join('\n'))
    state.phase = 'failed'
    logBuild(state, 'builder_died_awaiting')
    cleanupState(ticket)
  }
}

function cleanupState(ticket: string): void {
  const state = builds.get(ticket)
  if (!state) return
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
        void cancelRun(run, 'PM died').catch(err => {
          process.stderr.write(`daemon: factory: cancel review on PM death failed: ${err}\n`)
        })
      }
    }
    killBuilder(state)
    state.phase = 'failed'
    logBuild(state, 'pm_died')
    cleanupState(ticket)
  }
}

on('session:death', factorySessionDeath, 'factory:session-death')

protocolEvents.onComplete((event) => {
  if (event.protocol !== 'review') return
  const ticket = builderThreadToTicket.get(event.threadId)
  if (!ticket) return
  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return

  if (event.outcome === 'complete') {
    state.phase = 'awaiting_pm'
    state.reviewed = true
    syncPhaseToRegistry(state)
    process.stderr.write(`daemon: factory: review complete for ticket ${state.ticket}, awaiting PM decision\n`)
    const transcriptLine = event.transcriptPath ? `📼 Review transcript: \`${event.transcriptPath}\`` : ''
    const diffLink = state.prUrl
      ? [`🔀 **PR:** ${state.prUrl}`]
      : state.diffGistUrl
        ? [`📄 **Diff:** ${state.diffGistUrl}`]
        : []
    const summaryBlock = state.reviewSummary
      ? [``, state.reviewSummary.length > 3000 ? state.reviewSummary.slice(0, 3000) + '\n...(truncated)' : state.reviewSummary, ``]
      : []
    void safeSend(state.pmThreadId, [
      `🏭 **Factory build→review complete** — awaiting your decision`,
      `Ticket: \`${state.ticket}\``,
      ...(transcriptLine ? [transcriptLine] : []),
      ...diffLink,
      ...summaryBlock,
      `Use one of:`,
      `- \`factory_accept("${state.ticket}")\` — accept the work, kill builder`,
      `- \`factory_retry("${state.ticket}", "fix X and Y")\` — send new instructions to builder`,
      `- \`factory_abandon("${state.ticket}")\` — discard and kill builder`,
    ].join('\n'))
  } else {
    state.phase = 'awaiting_pm'
    syncPhaseToRegistry(state)
    process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Factory review cancelled** ⚠️`,
      `Ticket: \`${state.ticket}\``,
      `_Review was cancelled (timeout or disconnect). Builder is still alive._`,
      `- \`factory_retry("${state.ticket}", "try again")\` — re-enter build→review`,
      `- \`factory_abandon("${state.ticket}")\` — give up`,
    ].join('\n'))
  }
})

protocolEvents.onRoundAdvance((event) => {
  if (event.protocol !== 'review') return
  const ticket = builderThreadToTicket.get(event.threadId)
  if (!ticket) return
  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return

  // Forward inline text only on the final round, and only when it is actually
  // the critic's. For `review` the round counter advances out of `owner_turn`
  // (the only phase declaring finalAdvanceEvent), so `role` is the owner and
  // this branch does not fire — the PM gets the counter, then the critic's
  // full assessment via onComplete's transcriptPath moments later.
  const isCriticFinal = event.role === 'critic' && event.round >= event.totalRounds && !!event.text
  if (!isCriticFinal) {
    void safeSend(state.pmThreadId, `🏭 **Critic Round ${event.round}/${event.totalRounds}** — in progress`)
    return
  }

  const text = event.text!.length > 3000 ? event.text!.slice(0, 3000) + '\n...(truncated)' : event.text!
  void safeSend(state.pmThreadId, [
    `🏭 **Critic Final Round ${event.round}/${event.totalRounds}**`,
    text,
  ].join('\n'))
})

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
        void safeSend(pmThreadId, `🏭 **Builder survived restart** ℹ️\nBuilder \`${info.tmuxName}\`${ticketInfo} is still alive with completed work. Factory ticket state was lost — use \`peek_session("${info.tmuxName}")\` to inspect, then \`kill_session\` when done. Work remains on disk.`).catch(() => {})
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
      void safeSend(pmThreadId, `🏭 **Orphaned builder killed** ⚠️\nBuilder \`${info.tmuxName}\`${ticketInfo} was still running after daemon restart. Killed for safety. Retry with factory_build if needed.`).catch(() => {})
    }
    swept++
  }
  if (swept > 0) process.stderr.write(`daemon: factory: swept ${swept} orphaned builder(s)\n`)
}
