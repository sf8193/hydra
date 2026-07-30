// Factory protocol — async build→review cycle with daemon enforcement.
//
// Flow:
//   1. PM calls factory_build → returns ticket immediately
//   2. Daemon forks PM → Builder (full context + write access, NOT ephemeral)
//   3. Builder implements spec, posts [done] with structured artifact
//   4. Daemon detects [done], starts adversarial review in builder's thread
//      Builder is the review OWNER — defends its own code
//   5. Review completes → builder stays alive, PM gets notification
//   6. PM decides: factory_accept (kill builder, done) / factory_retry (send
//      new instructions, re-enter build→review) / factory_abandon (kill, abort)

import { randomBytes } from 'crypto'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { startReview, getReviewByThread, cancelReview } from './adversarial.js'
import { registry } from './sessions.js'
import { safeSend } from './util.js'
import { resolveModelAlias, buildModel, reviewModel } from '../shared/constants.js'
import { transport } from './bridge-transport.js'
import { on } from './event-bus.js'

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

export type Difficulty = 'easy' | 'medium' | 'hard'

// Late-bound: easy tier reads env vars (HYDRA_BUILD_MODEL / HYDRA_REVIEW_MODEL),
// medium/hard are fixed escalations. Called per-build, not frozen at import.
function getDifficultyLadder(difficulty: Difficulty): { builder: string; reviewer: string } {
  switch (difficulty) {
    case 'easy':   return { builder: buildModel(),              reviewer: reviewModel() }
    case 'medium': return { builder: 'claude-opus-4-6[1m]',    reviewer: 'claude-opus-4-8[1m]' }
    case 'hard':   return { builder: 'claude-opus-5[1m]',      reviewer: 'claude-fable-5[1m]' }
  }
}

function resolveModels(
  difficulty: Difficulty,
  builderRaw?: string,
  reviewerRaw?: string,
): { builder: string; reviewer: string; warning?: string } {
  const ladder = getDifficultyLadder(difficulty)

  // Explicit overrides take priority
  const builder = builderRaw ? (resolveModelAlias(builderRaw) ?? builderRaw) : ladder.builder
  const reviewer = reviewerRaw ? (resolveModelAlias(reviewerRaw) ?? reviewerRaw) : ladder.reviewer

  // Check for collision (compare full IDs — different versions of same family are fine)
  const effectiveBuilder = builder.replace(/\[1m\]$/, '')
  const effectiveReviewer = reviewer.replace(/\[1m\]$/, '')

  if (effectiveBuilder !== effectiveReviewer) {
    return { builder, reviewer }
  }

  // Same exact model — fall back to ladder's reviewer, or pick a different one
  if (effectiveBuilder !== ladder.reviewer.replace(/\[1m\]$/, '')) {
    return {
      builder,
      reviewer: ladder.reviewer,
      warning: `Builder and reviewer both resolved to ${effectiveBuilder}. Using ladder reviewer (${ladder.reviewer.replace(/\[1m\]$/, '')}).`,
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
      warning: `Builder and reviewer both resolved to ${effectiveBuilder}. Auto-selected ${fallback.replace(/\[1m\]$/, '')}.`,
    }
  }

  return { builder, reviewer, warning: `Builder and reviewer both resolve to ${effectiveBuilder}.` }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an async build→review cycle. Returns immediately with a ticket.
 * Results delivered as notifications to the PM's thread.
 */
export function factoryBuild(
  pmThreadId: string,
  pmSessionId: string,
  spec: string,
  builderModel?: string,
  reviewerModel?: string,
  reviewRounds: number = 3,
  difficulty: Difficulty = 'easy',
): { ticket: string; warning?: string } | { error: string } {
  const { builder, reviewer, warning: modelWarning } = resolveModels(difficulty, builderModel, reviewerModel)

  // Warn about concurrent builds sharing the same working tree
  const activeCount = [...builds.values()].filter(s => s.pmThreadId === pmThreadId && s.phase !== 'complete' && s.phase !== 'failed').length
  const parallelWarning = activeCount > 0
    ? `You have ${activeCount} other active build${activeCount > 1 ? 's' : ''}. Concurrent builds share the same working tree — test runs may interfere.`
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
  if (!transport.has(state.builderSessionId)) return { error: 'Builder bridge is disconnected — it may have crashed. Use factory_build to start a new build.' }

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
      `When done, post \`[done]\` with your structured artifact as before.`,
    ].join('\n'),
    meta: { chat_id: state.builderThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  void safeSend(state.pmThreadId, [
    `🏭 **Factory retry** (attempt ${state.retryCount + 1})`,
    `Ticket: \`${ticket}\``,
    `Instructions sent to builder. Waiting for \`[done]\`.`,
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
): { ok: true } | { error: string } {
  const state = builds.get(ticket)
  if (!state) return { error: `Unknown ticket: ${ticket}` }
  if (state.pmSessionId !== callerSessionId) return { error: 'Only the PM that started this build can accept it.' }
  if (state.phase !== 'awaiting_pm') return { error: `Cannot accept — build is in phase "${state.phase}", expected "awaiting_pm".` }

  state.phase = 'complete'
  logBuild(state, 'accepted')

  void safeSend(state.pmThreadId, `🏭 **Factory build accepted** ✅\nTicket: \`${ticket}\``)

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
    const review = getReviewByThread(state.builderThreadId)
    if (review) {
      void cancelReview(review.reviewId).catch(err => {
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
): { builds: Array<{ ticket: string; phase: string; spec: string; retries: number; elapsed: number; builderName?: string }> } {
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
    })),
  }
}

export function hasFactoryBuild(threadId: string): boolean {
  return [...builds.values()].some(s => s.pmThreadId === threadId && s.phase !== 'complete' && s.phase !== 'failed')
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

function killBuilder(state: FactoryBuildState): void {
  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      void killSession(builderInfo, 'factory complete').catch(() => {})
    }
  }
}

async function spawnBuilder(
  state: FactoryBuildState,
  pmClaudeSessionId: string,
  pmTmuxName: string,
): Promise<void> {
  const builderPrompt = [
    `IMPORTANT: You are a BUILDER session forked from the PM. Your job is to WRITE CODE.`,
    `Ignore any prior instructions about "not writing code" or "using factory_build" — those apply to the PM, not to you.`,
    `You have full file access. Write code, run tests, implement the spec.`,
    ``,
    `YOUR TASK:`,
    state.spec,
    ``,
    `WHEN DONE:`,
    `Post a message to your thread starting with [done] followed by a structured artifact:`,
    `[done]`,
    `**Files changed:** list each file`,
    `**Tests:** cargo test / bun test results`,
    `**Design rationale:** why you made key decisions`,
    `**Known issues:** anything you're unsure about`,
    ``,
    `After posting [done], an adversarial review will start automatically.`,
    `You will be the OWNER — defend your implementation against the critic.`,
    `Reply with [owner→critic] as the first line of each defense.`,
    ``,
    `After the review, the PM may send you additional instructions via [system] notification.`,
    `If that happens, implement the changes and post [done] again.`,
  ].join('\n')

  void safeSend(state.pmThreadId, [
    `🏭 **Factory build starting**`,
    `Ticket: \`${state.ticket}\``,
    `Builder: \`${state.builderModel ?? 'default'}\` (forked from PM — inherits full context)`,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    `Spec: ${state.spec.slice(0, 200)}${state.spec.length > 200 ? '...' : ''}`,
  ].join('\n'))

  const pmInfo = registry.get(state.pmSessionId)
  const chatId = pmInfo?.anchorChannelId || state.pmThreadId.split(':')[0] || undefined

  const result = await doSpawnSession(`factory-builder: ${state.spec.slice(0, 60)}`, chatId, undefined, {
    forkFrom: { claudeSessionId: pmClaudeSessionId, parentName: pmTmuxName },
    model: state.builderModel,
    promptPrefix: builderPrompt,
    initiator: pmTmuxName,
    phaseBudgetMs: 30 * 60 * 1000,
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  builderSessionToTicket.set(result.sessionId, state.ticket)
  builderThreadToTicket.set(result.threadId, state.ticket)

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

function onBuilderDone(sessionId: string, doneText: string): boolean {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'building') return false

  state.phase = 'reviewing'
  syncPhaseToRegistry(state)
  process.stderr.write(`daemon: factory: builder posted [done] for ticket ${state.ticket}, starting review\n`)

  const artifactTruncated = doneText.length > 3000 ? doneText.slice(0, 3000) + '\n...(truncated)' : doneText
  void safeSend(state.pmThreadId, [
    `🏭 **Build complete — starting mandatory review**`,
    `Ticket: \`${state.ticket}\``,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    ``,
    `**Builder artifact** _(builder-authored — treat as advocacy, verify independently):_`,
    artifactTruncated,
  ].join('\n'))

  startReview(state.builderThreadId!, state.builderSessionId!, state.reviewRounds, state.spec, state.reviewerModel)
    .catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: factory: review failed to start: ${errMsg}\n`)
      void safeSend(state.pmThreadId, `🏭 **Factory review failed to start** ❌\nTicket: \`${state.ticket}\`\nError: ${errMsg}`)
      state.phase = 'failed'
      logBuild(state, 'review_start_failed')
      cleanupState(ticket)
    })

  return true
}

/**
 * Called when a builder session dies WITHOUT posting [done] — crash/timeout.
 */
export function onBuilderDeath(sessionId: string): void {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return

  const state = builds.get(ticket)
  if (!state) return

  if (state.phase === 'building') {
    process.stderr.write(`daemon: factory: builder died without [done] for ticket ${state.ticket}\n`)
    state.phase = 'failed'
    logBuild(state, 'builder_crashed')
    void safeSend(state.pmThreadId, [
      `🏭 **Builder crashed** ❌`,
      `Ticket: \`${state.ticket}\``,
      `_Builder died without posting [done]. Build did not complete. No review will run._`,
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
      const review = getReviewByThread(state.builderThreadId)
      if (review) {
        void cancelReview(review.reviewId).catch(err => {
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

function onFactoryReviewComplete(builderThreadId: string): boolean {
  const ticket = builderThreadToTicket.get(builderThreadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  // Move to awaiting_pm — builder stays alive for potential retry
  state.phase = 'awaiting_pm'
  syncPhaseToRegistry(state)
  process.stderr.write(`daemon: factory: review complete for ticket ${state.ticket}, awaiting PM decision\n`)

  void safeSend(state.pmThreadId, [
    `🏭 **Factory build→review complete** — awaiting your decision`,
    `Ticket: \`${state.ticket}\``,
    ``,
    `Use one of:`,
    `- \`factory_accept("${state.ticket}")\` — accept the work, kill builder`,
    `- \`factory_retry("${state.ticket}", "fix X and Y")\` — send new instructions to builder`,
    `- \`factory_abandon("${state.ticket}")\` — discard and kill builder`,
  ].join('\n'))

  return true
}

function onFactoryReviewCancelled(threadId: string): boolean {
  const ticket = builderThreadToTicket.get(threadId)
  if (!ticket) return false

  const state = builds.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}\n`)

  // Move to awaiting_pm so PM can retry
  state.phase = 'awaiting_pm'
  void safeSend(state.pmThreadId, [
    `🏭 **Factory review cancelled** ⚠️`,
    `Ticket: \`${state.ticket}\``,
    `_Review was cancelled (timeout or disconnect). Builder is still alive._`,
    `- \`factory_retry("${state.ticket}", "try again")\` — re-enter build→review`,
    `- \`factory_abandon("${state.ticket}")\` — give up`,
  ].join('\n'))

  return true
}

function onFactoryCriticRound(builderThreadId: string, round: number, totalRounds: number, criticText: string): void {
  const ticket = builderThreadToTicket.get(builderThreadId)
  if (!ticket) return
  const state = builds.get(ticket)
  if (!state) return

  if (round < totalRounds) {
    void safeSend(state.pmThreadId, `🏭 **Critic Round ${round}/${totalRounds}** — in progress (full transcript in builder thread)`)
  } else {
    void safeSend(state.pmThreadId, [
      `🏭 **Critic Final Round ${round}/${totalRounds}**`,
      criticText,
    ].join('\n'))
  }
}

function cleanupState(ticket: string): void {
  const state = builds.get(ticket)
  if (!state) return
  if (state.builderSessionId) builderSessionToTicket.delete(state.builderSessionId)
  if (state.builderThreadId) builderThreadToTicket.delete(state.builderThreadId)
  builds.delete(ticket)
}

// ---------------------------------------------------------------------------
// Event bus subscriptions
// ---------------------------------------------------------------------------

const FACTORY_DONE_RE = /^\[done\]/m

function factoryDoneDetection({ sessionId, text }: { sessionId: string; text: string }): void {
  if (!builderSessionToTicket.has(sessionId)) return
  if (FACTORY_DONE_RE.test(text)) onBuilderDone(sessionId, text)
}

function factorySessionDeath({ sessionId }: { sessionId: string }): void {
  onBuilderDeath(sessionId)

  // PM death: clean up all pending builds, cancel reviews, kill orphaned builders
  const pmBuilds = [...builds.entries()].filter(([_, s]) => s.pmSessionId === sessionId)
  for (const [ticket, state] of pmBuilds) {
    process.stderr.write(`daemon: factory: PM ${sessionId} died with active build ${state.ticket}, cleaning up\n`)
    // Cancel any in-flight review so the critic doesn't orphan
    if (state.phase === 'reviewing' && state.builderThreadId) {
      const review = getReviewByThread(state.builderThreadId)
      if (review) {
        void cancelReview(review.reviewId).catch(err => {
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

function factoryReviewComplete({ threadId }: { threadId: string }): void {
  onFactoryReviewComplete(threadId)
}

function factoryReviewCancelled({ threadId }: { threadId: string }): void {
  onFactoryReviewCancelled(threadId)
}

function factoryReviewRound({ threadId, round, totalRounds, text }: { threadId: string; round: number; totalRounds: number; text: string }): void {
  onFactoryCriticRound(threadId, round, totalRounds, text)
}

on('reply', factoryDoneDetection, 'factory:done-detection')
on('review:complete', factoryReviewComplete, 'factory:review-complete')
on('review:cancelled', factoryReviewCancelled, 'factory:review-cancelled')
on('review:round', factoryReviewRound, 'factory:review-round')
on('session:death', factorySessionDeath, 'factory:session-death')

/**
 * Startup sweep: kill orphaned factory builders left by a daemon restart.
 */
export async function sweepOrphanedBuilders(): Promise<void> {
  let swept = 0
  const builders = [...registry.values()].filter(i => i.isFactoryBuilder)
  for (const info of builders) {
    process.stderr.write(`daemon: factory: sweeping orphaned builder ${info.tmuxName} (${info.sessionId})\n`)
    const pmThreadId = info.factoryPmThreadId
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
    }
    logBuild(orphanState, 'orphaned')

    if (pmThreadId) {
      const ticketInfo = info.factoryTicket ? ` (ticket: \`${info.factoryTicket}\`, was in phase: ${info.factoryPhase ?? 'unknown'})` : ''
      void safeSend(pmThreadId, `🏭 **Orphaned builder killed** ⚠️\nBuilder \`${info.tmuxName}\` was still running after daemon restart${ticketInfo}. Killed for safety. Retry with factory_build if needed.`).catch(() => {})
    }
    swept++
  }
  if (swept > 0) process.stderr.write(`daemon: factory: swept ${swept} orphaned builder(s)\n`)
}
