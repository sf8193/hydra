// Factory protocol — async build→review cycle with daemon enforcement.
//
// Flow:
//   1. PM calls factory_build → returns ticket immediately
//   2. Daemon forks PM → Builder (full context + write access, NOT ephemeral)
//   3. Builder implements spec, posts [done] with structured artifact
//   4. Daemon detects [done], starts adversarial review in builder's thread
//      Builder is the review OWNER — defends its own code
//   5. Review completes → daemon captures critic verdict, kills builder
//   6. PM receives artifact + raw critic verdict as thread notifications
//   7. PM decides: accept / retry review / retry build / move on
//
// Concurrency: without worktree, one active build per PM thread (shared tree).
// With worktree, parallel builds allowed (each builder gets isolated copy).
//
// Supports review retry: if a review is cancelled/timed out, the builder
// stays alive in review_failed phase. PM can call factory_retry_review(ticket)
// to re-run just the review without rebuilding.

import { randomBytes } from 'crypto'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { startReview } from './adversarial.js'
import { registry } from './sessions.js'
import { safeSend, isAlive } from './util.js'
import { resolveModelAlias, spawnModel, reviewModel } from '../shared/constants.js'
import { cancelReview, getReviewByThread } from './adversarial.js'
import { on } from './event-bus.js'

// ---------------------------------------------------------------------------
// Shared model comparison — normalizes defaults and [1m] suffixes
// ---------------------------------------------------------------------------

function effectiveModel(explicit: string | undefined, fallback: () => string): string {
  return (explicit ?? fallback()).replace(/\[1m\]$/, '')
}


function sameModel(builderModel: string | undefined, reviewerModel: string | undefined): boolean {
  return effectiveModel(builderModel, spawnModel) === effectiveModel(reviewerModel, reviewModel)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  phase: 'building' | 'reviewing' | 'review_failed' | 'complete' | 'failed'
  reviewFailedAt?: number
  worktree?: string
}

// ---------------------------------------------------------------------------
// State — keyed by ticket
// ---------------------------------------------------------------------------

const pending = new Map<string, FactoryBuildState>()

// Index: pmThreadId → set of active tickets (for listing / PM death cleanup)
const pmTickets = new Map<string, Set<string>>()

// Reverse lookups → ticket
const builderSessionToTicket = new Map<string, string>()
const builderThreadToTicket = new Map<string, string>()

// Idle timeout for review_failed builders (30 min)
const REVIEW_FAILED_TIMEOUT_MS = 30 * 60 * 1000
const reviewFailedTimers = new Map<string, ReturnType<typeof setTimeout>>()

let ticketCounter = 0

// ---------------------------------------------------------------------------
// Concurrency — one active build per PM thread (shared working tree)
// ---------------------------------------------------------------------------

function activeBuildsForPm(pmThreadId: string): number {
  const tickets = pmTickets.get(pmThreadId)
  if (!tickets) return 0
  let count = 0
  for (const ticket of tickets) {
    const state = pending.get(ticket)
    if (state && (state.phase === 'building' || state.phase === 'reviewing')) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an async build→review cycle. Returns immediately with a ticket.
 * Without worktree: one build at a time (shared working tree).
 * With worktree: parallel builds allowed (each builder gets its own copy).
 */
export function factoryBuild(
  pmThreadId: string,
  pmSessionId: string,
  spec: string,
  builderModel?: string,
  reviewerModel?: string,
  reviewRounds: number = 3,
  worktree?: string,
): { ticket: string } | { error: string } {
  const resolvedBuilder = builderModel ? (resolveModelAlias(builderModel) ?? builderModel) : undefined
  const resolvedReviewer = reviewerModel ? (resolveModelAlias(reviewerModel) ?? reviewerModel) : undefined

  if (sameModel(resolvedBuilder, resolvedReviewer)) {
    return { error: `Builder and reviewer resolve to the same model (${effectiveModel(resolvedBuilder, spawnModel)}). Use different models.` }
  }

  // Worktree-isolated builds can run in parallel; shared-tree builds cannot
  if (!worktree && activeBuildsForPm(pmThreadId) > 0) {
    return { error: 'A factory_build is already active in this thread (building or reviewing). Pass worktree to isolate builders for parallel builds, or wait for the current build to complete.' }
  }

  // Kill any review_failed builders that share the working tree
  if (!worktree) {
    killReviewFailedBuilders(pmThreadId)
  }

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
    builderModel: resolvedBuilder,
    reviewerModel: resolvedReviewer,
    reviewRounds,
    phase: 'building',
    worktree,
  }
  pending.set(ticket, state)
  addPmTicket(pmThreadId, ticket)

  // Spawn builder async — don't await
  void spawnBuilder(state, pmInfo.claudeSessionId, pmInfo.tmuxName).catch(err => {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: factory: builder spawn failed: ${errMsg}\n`)
    cleanupState(ticket)
    void safeSend(pmThreadId, `🏭 **Factory build failed** ❌\nTicket: ${ticket}\nError: builder spawn failed — ${errMsg}`)
  })

  return { ticket }
}

/**
 * Retry review on an existing builder whose review was cancelled/failed.
 * Builder must be in review_failed phase and still alive.
 */
export function factoryRetryReview(
  ticket: string,
  callerSessionId: string,
  reviewerModel?: string,
  reviewRounds?: number,
): { ok: true } | { error: string } {
  const state = pending.get(ticket)
  if (!state) {
    return { error: `Ticket ${ticket} not found. It may have already completed or been cleaned up.` }
  }
  if (state.pmSessionId !== callerSessionId) {
    return { error: `Ticket ${ticket} belongs to a different PM session.` }
  }
  if (state.phase !== 'review_failed') {
    return { error: `Ticket ${ticket} is in phase "${state.phase}" — retry_review only works on review_failed tickets.` }
  }
  if (!state.builderSessionId || !state.builderThreadId) {
    return { error: `Ticket ${ticket} has no builder session — it may have been killed.` }
  }

  // Check builder is actually alive (not just registered)
  const builderInfo = registry.get(state.builderSessionId)
  if (!builderInfo || !isAlive(builderInfo)) {
    cleanupState(ticket)
    return { error: `Builder for ticket ${ticket} is dead. Use factory_build to start a new build.` }
  }

  // Resolve reviewer model and enforce builder≠reviewer
  const resolvedReviewer = reviewerModel ? (resolveModelAlias(reviewerModel) ?? reviewerModel) : state.reviewerModel
  if (sameModel(state.builderModel, resolvedReviewer)) {
    return { error: `Builder and reviewer resolve to the same model (${effectiveModel(state.builderModel, spawnModel)}). Use different models.` }
  }

  if (reviewerModel) state.reviewerModel = resolvedReviewer
  if (reviewRounds) state.reviewRounds = reviewRounds

  // Clear the idle timeout
  clearReviewFailedTimer(ticket)

  state.phase = 'reviewing'
  process.stderr.write(`daemon: factory: retrying review for ticket ${state.ticket}\n`)

  void safeSend(state.pmThreadId, [
    `🏭 **Retrying review** 🔄`,
    `Ticket: ${state.ticket}`,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
  ].join('\n'))

  startReview(state.builderThreadId, state.builderSessionId, state.reviewRounds, state.spec, state.reviewerModel)
    .catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: factory: retry review failed to start: ${errMsg}\n`)
      state.phase = 'review_failed'
      state.reviewFailedAt = Date.now()
      startReviewFailedTimer(ticket)
      void safeSend(state.pmThreadId, `🏭 **Review retry failed** ❌\nTicket: ${state.ticket}\nError: ${errMsg}`)
    })

  return { ok: true }
}

function onFactoryReviewComplete(threadId: string): boolean {
  const ticket = builderThreadToTicket.get(threadId)
  if (!ticket) return false

  const state = pending.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  state.phase = 'complete'
  process.stderr.write(`daemon: factory: review complete for ticket ${state.ticket}\n`)

  void safeSend(state.pmThreadId, [
    `🏭 **Factory build→review complete** ✅`,
    `Ticket: ${state.ticket}`,
    `_Review the builder's artifact and critic's feedback above. Decide: accept, retry with new spec, or move on._`,
  ].join('\n'))

  // Kill the builder (it stayed alive through review)
  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      void killSession(builderInfo, 'factory review complete').catch(() => {})
    }
  }

  cleanupState(ticket)
  return true
}

function onFactoryReviewCancelled(threadId: string): boolean {
  const ticket = builderThreadToTicket.get(threadId)
  if (!ticket) return false

  const state = pending.get(ticket)
  if (!state || state.phase !== 'reviewing') return false

  // Check if builder is actually still alive before promising retry
  const builderAlive = state.builderSessionId
    ? (() => { const info = registry.get(state.builderSessionId!); return info && isAlive(info) })()
    : false

  if (!builderAlive) {
    process.stderr.write(`daemon: factory: review cancelled but builder is dead for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Review cancelled — builder is dead** ❌`,
      `Ticket: ${state.ticket}`,
      `_Review was cancelled and the builder has already died. Use factory_build to start fresh._`,
    ].join('\n'))
    cleanupState(ticket)
    return true
  }

  // Builder alive — transition to review_failed so PM can retry
  state.phase = 'review_failed'
  state.reviewFailedAt = Date.now()

  process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}, builder kept alive for retry\n`)

  void safeSend(state.pmThreadId, [
    `🏭 **Review cancelled** ⚠️`,
    `Ticket: ${state.ticket}`,
    `_Builder is still alive. Use \`factory_retry_review(ticket: "${state.ticket}")\` to re-run review without rebuilding._`,
    `_Builder will be killed after 30 min of inactivity if not retried._`,
  ].join('\n'))

  startReviewFailedTimer(ticket)
  return true
}

function onFactoryCriticRound(builderThreadId: string, round: number, totalRounds: number, criticText: string): void {
  const ticket = builderThreadToTicket.get(builderThreadId)
  if (!ticket) return

  const state = pending.get(ticket)
  if (!state) return

  if (round < totalRounds) {
    void safeSend(state.pmThreadId, `🏭 **Critic Round ${round}/${totalRounds}** [${state.ticket}] — in progress (full transcript in builder thread)`)
  } else {
    void safeSend(state.pmThreadId, [
      `🏭 **Critic Final Round ${round}/${totalRounds}** [${state.ticket}]`,
      criticText,
    ].join('\n'))
  }
}


export function hasFactoryBuild(threadId: string): boolean {
  const tickets = pmTickets.get(threadId)
  return !!tickets && tickets.size > 0
}

export function getFactoryStatus(pmThreadId: string): Array<{ ticket: string; phase: string; worktree?: string }> {
  const tickets = pmTickets.get(pmThreadId)
  if (!tickets || tickets.size === 0) return []
  const result: Array<{ ticket: string; phase: string; worktree?: string }> = []
  for (const ticket of tickets) {
    const state = pending.get(ticket)
    if (state) result.push({ ticket: state.ticket, phase: state.phase, ...(state.worktree ? { worktree: state.worktree } : {}) })
  }
  return result
}

// ---------------------------------------------------------------------------
// Internal — index management
// ---------------------------------------------------------------------------

function killReviewFailedBuilders(pmThreadId: string): void {
  const tickets = pmTickets.get(pmThreadId)
  if (!tickets) return
  for (const ticket of [...tickets]) {
    const state = pending.get(ticket)
    if (!state || state.phase !== 'review_failed') continue
    process.stderr.write(`daemon: factory: killing review_failed builder for ticket ${state.ticket} before new build\n`)
    if (state.builderSessionId) {
      const builderInfo = registry.get(state.builderSessionId)
      if (builderInfo) {
        builderInfo.suppressDeathMessage = true
        void killSession(builderInfo, 'replaced by new factory_build').catch(() => {})
      }
    }
    cleanupState(ticket)
  }
}

function addPmTicket(pmThreadId: string, ticket: string): void {
  let set = pmTickets.get(pmThreadId)
  if (!set) {
    set = new Set()
    pmTickets.set(pmThreadId, set)
  }
  set.add(ticket)
}

function removePmTicket(pmThreadId: string, ticket: string): void {
  const set = pmTickets.get(pmThreadId)
  if (!set) return
  set.delete(ticket)
  if (set.size === 0) pmTickets.delete(pmThreadId)
}

// ---------------------------------------------------------------------------
// Internal — review_failed idle timer
// ---------------------------------------------------------------------------

function startReviewFailedTimer(ticket: string): void {
  clearReviewFailedTimer(ticket)
  reviewFailedTimers.set(ticket, setTimeout(() => {
    const state = pending.get(ticket)
    if (!state || state.phase !== 'review_failed') return

    process.stderr.write(`daemon: factory: review_failed idle timeout for ticket ${state.ticket}, killing builder\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder timed out** ⏰`,
      `Ticket: ${state.ticket}`,
      `_Builder was in review_failed for 30 min without retry. Killed to free resources._`,
    ].join('\n'))

    if (state.builderSessionId) {
      const builderInfo = registry.get(state.builderSessionId)
      if (builderInfo) {
        builderInfo.suppressDeathMessage = true
        void killSession(builderInfo, 'review_failed idle timeout').catch(() => {})
      }
    }
    cleanupState(ticket)
  }, REVIEW_FAILED_TIMEOUT_MS))
}

function clearReviewFailedTimer(ticket: string): void {
  const timer = reviewFailedTimers.get(ticket)
  if (timer) {
    clearTimeout(timer)
    reviewFailedTimers.delete(ticket)
  }
}

// ---------------------------------------------------------------------------
// Internal — spawn + lifecycle
// ---------------------------------------------------------------------------

async function spawnBuilder(
  state: FactoryBuildState,
  pmClaudeSessionId: string,
  pmTmuxName: string,
): Promise<void> {
  const worktreeInstructions = state.worktree
    ? [
        ``,
        `WORKTREE: You are in an isolated git worktree. Your changes will be destroyed when your session ends.`,
        `Before posting [done], you MUST commit and push your changes:`,
        `  git add -A && git commit -m "factory: <summary>" && git push -u origin HEAD`,
        `Include the branch name in your [done] artifact so the PM can find your work.`,
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
    `Post a message to your thread starting with [done] followed by a structured artifact:`,
    `[done]`,
    `**Files changed:** list each file`,
    ...(state.worktree ? [`**Branch:** the branch name you pushed to`] : []),
    `**Tests:** cargo test / bun test results`,
    `**Design rationale:** why you made key decisions`,
    `**Known issues:** anything you're unsure about`,
    ``,
    `After posting [done], an adversarial review will start automatically.`,
    `You will be the OWNER — defend your implementation against the critic.`,
    `Reply with [owner→critic] as the first line of each defense.`,
  ].join('\n')

  const worktreeLabel = state.worktree ? ` · Worktree: \`${state.worktree}\`` : ''
  void safeSend(state.pmThreadId, [
    `🏭 **Factory build starting**`,
    `Ticket: ${state.ticket}`,
    `Builder: \`${state.builderModel ?? 'default'}\` (forked from PM — inherits full context)${worktreeLabel}`,
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
    ...(state.worktree ? { worktree: state.worktree } : {}),
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  builderSessionToTicket.set(result.sessionId, state.ticket)
  builderThreadToTicket.set(result.threadId, state.ticket)

  const builderInfo = registry.get(result.sessionId)
  if (builderInfo) {
    builderInfo.isFactoryBuilder = true
    builderInfo.factoryPmThreadId = state.pmThreadId
    registry.persist()
  }

  process.stderr.write(`daemon: factory: builder ${result.name} (${result.sessionId}) forked for ticket ${state.ticket}\n`)
}

function onBuilderDone(sessionId: string, doneText: string): boolean {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return false

  const state = pending.get(ticket)
  if (!state || state.phase !== 'building') return false

  state.phase = 'reviewing'
  process.stderr.write(`daemon: factory: builder posted [done] for ticket ${state.ticket}, starting review\n`)

  const artifactTruncated = doneText.length > 3000 ? doneText.slice(0, 3000) + '\n...(truncated)' : doneText
  void safeSend(state.pmThreadId, [
    `🏭 **Build complete — starting mandatory review**`,
    `Ticket: ${state.ticket}`,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    ``,
    `**Builder artifact** _(builder-authored — treat as advocacy, verify independently):_`,
    artifactTruncated,
  ].join('\n'))

  startReview(state.builderThreadId!, state.builderSessionId!, state.reviewRounds, state.spec, state.reviewerModel)
    .catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: factory: review failed to start: ${errMsg}\n`)
      state.phase = 'review_failed'
      state.reviewFailedAt = Date.now()
      startReviewFailedTimer(ticket)
      void safeSend(state.pmThreadId, [
        `🏭 **Review failed to start** ❌`,
        `Ticket: ${state.ticket}`,
        `Error: ${errMsg}`,
        `_Builder is still alive. Use \`factory_retry_review(ticket: "${state.ticket}")\` to retry._`,
      ].join('\n'))
    })

  return true
}

/**
 * Called when a builder session dies — handles all phases.
 */
export function onBuilderDeath(sessionId: string): void {
  const ticket = builderSessionToTicket.get(sessionId)
  if (!ticket) return

  const state = pending.get(ticket)
  if (!state) return

  if (state.phase === 'building') {
    process.stderr.write(`daemon: factory: builder died without [done] for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder crashed** ❌`,
      `Ticket: ${state.ticket}`,
      `_Builder died without posting [done]. Build did not complete. No review will run._`,
      `_Retry with factory_build if needed._`,
    ].join('\n'))
    cleanupState(ticket)
  } else if (state.phase === 'reviewing') {
    // Builder died mid-review (e.g. phase budget reaper, crash). Proactively
    // cancel the review and clean up — don't wait for the 2-min owner-disconnect
    // grace period. Clean up factory state FIRST so the subsequent review:cancelled
    // event no-ops on the deleted mapping instead of resurrecting a review_failed corpse.
    process.stderr.write(`daemon: factory: builder died during review for ticket ${state.ticket}, cancelling review\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder died during review** ❌`,
      `Ticket: ${state.ticket}`,
      `_Builder crashed or was reaped while review was in progress. Rebuild required._`,
      `_Use factory_build to start a new build._`,
    ].join('\n'))
    const builderThreadId = state.builderThreadId
    cleanupState(ticket)
    if (builderThreadId) {
      const review = getReviewByThread(builderThreadId)
      if (review) void cancelReview(review.reviewId).catch(() => {})
    }
  } else if (state.phase === 'review_failed') {
    process.stderr.write(`daemon: factory: review_failed builder died for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder died** ❌`,
      `Ticket: ${state.ticket}`,
      `_Builder in review_failed phase has died. Retry review is no longer possible._`,
      `_Use factory_build to start a new build._`,
    ].join('\n'))
    cleanupState(ticket)
  }
}

function cleanupState(ticket: string): void {
  const state = pending.get(ticket)
  if (!state) return
  if (state.builderSessionId) builderSessionToTicket.delete(state.builderSessionId)
  if (state.builderThreadId) builderThreadToTicket.delete(state.builderThreadId)
  removePmTicket(state.pmThreadId, ticket)
  clearReviewFailedTimer(ticket)
  pending.delete(ticket)
}

// ---------------------------------------------------------------------------
// Event bus subscriptions — named functions for stack trace clarity
// ---------------------------------------------------------------------------

const FACTORY_DONE_RE = /^\[done\]/m

function factoryDoneDetection({ sessionId, text }: { sessionId: string; text: string }): void {
  if (!builderSessionToTicket.has(sessionId)) return
  if (FACTORY_DONE_RE.test(text)) onBuilderDone(sessionId, text)
}

function factorySessionDeath({ sessionId }: { sessionId: string }): void {
  onBuilderDeath(sessionId)

  // PM death: clean up all pending builds for this PM and kill orphaned builders.
  // Snapshot to avoid Map mutation during iteration (killSession can
  // trigger synchronous death events that call cleanupState).
  const pmBuilds = [...pending.entries()].filter(([_, s]) => s.pmSessionId === sessionId)
  for (const [ticket, state] of pmBuilds) {
    process.stderr.write(`daemon: factory: PM ${sessionId} died with active build ${state.ticket}, cleaning up\n`)
    if (state.builderSessionId) {
      const builderInfo = registry.get(state.builderSessionId)
      if (builderInfo) {
        builderInfo.suppressDeathMessage = true
        void killSession(builderInfo, 'PM died').catch(() => {})
      }
    }
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

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export function _getStateForTesting() {
  return { pending, pmTickets, builderSessionToTicket, builderThreadToTicket, reviewFailedTimers }
}

export function _resetForTesting(): void {
  pending.clear()
  pmTickets.clear()
  builderSessionToTicket.clear()
  builderThreadToTicket.clear()
  for (const timer of reviewFailedTimers.values()) clearTimeout(timer)
  reviewFailedTimers.clear()
  ticketCounter = 0
}

/**
 * Startup sweep: kill orphaned factory builders left by a daemon restart.
 * Uses persisted registry fields (isFactoryBuilder, factoryPmThreadId).
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
    if (pmThreadId) {
      void safeSend(pmThreadId, `🏭 **Orphaned builder killed** ⚠️\nBuilder \`${info.tmuxName}\` was still running after daemon restart. Killed for safety. Retry with factory_build if needed.`).catch(() => {})
    }
    swept++
  }
  if (swept > 0) process.stderr.write(`daemon: factory: swept ${swept} orphaned builder(s)\n`)
}
