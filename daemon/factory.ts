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
//   7. PM decides: accept / retry / move on

import { randomBytes } from 'crypto'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { startReview } from './adversarial.js'
import { registry } from './sessions.js'
import { safeSend } from './util.js'
import { resolveModelAlias, spawnModel, reviewModel } from '../shared/constants.js'
import { on } from './event-bus.js'

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
  phase: 'building' | 'reviewing' | 'complete' | 'failed'
}

// ---------------------------------------------------------------------------
// State — keyed by PM threadId (one build at a time per PM)
// ---------------------------------------------------------------------------

const pending = new Map<string, FactoryBuildState>()

// Reverse lookups
const builderSessionToFactory = new Map<string, string>()  // builderSessionId → pmThreadId
const builderThreadToFactory = new Map<string, string>()    // builderThreadId → pmThreadId

let ticketCounter = 0

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
): { ticket: string } | { error: string } {
  const resolvedBuilder = builderModel ? (resolveModelAlias(builderModel) ?? builderModel) : undefined
  const resolvedReviewer = reviewerModel ? (resolveModelAlias(reviewerModel) ?? reviewerModel) : undefined

  // S1: compare effective models including defaults — strip [1m] suffix for comparison
  const effectiveBuilder = (resolvedBuilder ?? spawnModel()).replace(/\[1m\]$/, '')
  const effectiveReviewer = (resolvedReviewer ?? reviewModel()).replace(/\[1m\]$/, '')
  if (effectiveBuilder === effectiveReviewer) {
    return { error: `Builder and reviewer resolve to the same model (${effectiveBuilder}). Use different models.` }
  }

  if (pending.has(pmThreadId)) {
    return { error: 'A factory_build is already running in this thread. Wait for it to complete.' }
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
  }
  pending.set(pmThreadId, state)

  // Spawn builder async — don't await
  void spawnBuilder(state, pmInfo.claudeSessionId, pmInfo.tmuxName).catch(err => {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: factory: builder spawn failed: ${errMsg}\n`)
    cleanupState(pmThreadId)
    void safeSend(pmThreadId, `🏭 **Factory build failed** ❌\nTicket: ${ticket}\nError: builder spawn failed — ${errMsg}`)
  })

  return { ticket }
}

function onFactoryReviewComplete(threadId: string): boolean {
  // threadId here is the builder's thread
  const pmThreadId = builderThreadToFactory.get(threadId)
  if (!pmThreadId) return false

  const state = pending.get(pmThreadId)
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

  cleanupState(pmThreadId)
  return true
}

function onFactoryReviewCancelled(threadId: string): boolean {
  const pmThreadId = builderThreadToFactory.get(threadId)
  if (!pmThreadId) return false

  const state = pending.get(pmThreadId)
  if (!state || state.phase !== 'reviewing') return false

  process.stderr.write(`daemon: factory: review cancelled for ticket ${state.ticket}\n`)

  void safeSend(state.pmThreadId, [
    `🏭 **Factory review cancelled** ⚠️`,
    `Ticket: ${state.ticket}`,
    `_Review was cancelled (timeout or disconnect). You can retry with factory_build._`,
  ].join('\n'))

  // Kill the builder
  if (state.builderSessionId) {
    const builderInfo = registry.get(state.builderSessionId)
    if (builderInfo) {
      builderInfo.suppressDeathMessage = true
      void killSession(builderInfo, 'factory review cancelled').catch(() => {})
    }
  }

  cleanupState(pmThreadId)
  return true
}

function onFactoryCriticRound(builderThreadId: string, round: number, totalRounds: number, criticText: string): void {
  const pmThreadId = builderThreadToFactory.get(builderThreadId)
  if (!pmThreadId) return

  if (round < totalRounds) {
    void safeSend(pmThreadId, `🏭 **Critic Round ${round}/${totalRounds}** — in progress (full transcript in builder thread)`)
  } else {
    void safeSend(pmThreadId, [
      `🏭 **Critic Final Round ${round}/${totalRounds}**`,
      criticText,
    ].join('\n'))
  }
}


export function hasFactoryBuild(threadId: string): boolean {
  return pending.has(threadId)
}

export function getFactoryStatus(pmThreadId: string): { ticket: string; phase: string } | null {
  const state = pending.get(pmThreadId)
  if (!state) return null
  return { ticket: state.ticket, phase: state.phase }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

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
  ].join('\n')

  void safeSend(state.pmThreadId, [
    `🏭 **Factory build starting**`,
    `Ticket: ${state.ticket}`,
    `Builder: \`${state.builderModel ?? 'default'}\` (forked from PM — inherits full context)`,
    `Reviewer: \`${state.reviewerModel ?? 'default'}\` · Rounds: ${state.reviewRounds}`,
    `Spec: ${state.spec.slice(0, 200)}${state.spec.length > 200 ? '...' : ''}`,
  ].join('\n'))

  // Use the PM's channel so the builder thread is created in the same DM/channel.
  // anchorChannelId may not be set (Slack DM spawns skip it), so extract from threadId.
  const pmInfo = registry.get(state.pmSessionId)
  const chatId = pmInfo?.anchorChannelId || state.pmThreadId.split(':')[0] || undefined

  const result = await doSpawnSession(`factory-builder: ${state.spec.slice(0, 60)}`, chatId, undefined, {
    forkFrom: { claudeSessionId: pmClaudeSessionId, parentName: pmTmuxName },
    model: state.builderModel,
    promptPrefix: builderPrompt,
    initiator: pmTmuxName,
    phaseBudgetMs: 30 * 60 * 1000, // 30min deadline — reuse phase-budget machinery
  })

  state.builderSessionId = result.sessionId
  state.builderThreadId = result.threadId
  builderSessionToFactory.set(result.sessionId, state.pmThreadId)
  builderThreadToFactory.set(result.threadId, state.pmThreadId)

  // Stamp registry fields for persistence + startup sweep
  const builderInfo = registry.get(result.sessionId)
  if (builderInfo) {
    builderInfo.isFactoryBuilder = true
    builderInfo.factoryPmThreadId = state.pmThreadId
    registry.persist()
  }

  process.stderr.write(`daemon: factory: builder ${result.name} (${result.sessionId}) forked for ticket ${state.ticket}\n`)
}

function onBuilderDone(sessionId: string, doneText: string): boolean {
  const pmThreadId = builderSessionToFactory.get(sessionId)
  if (!pmThreadId) return false

  const state = pending.get(pmThreadId)
  if (!state || state.phase !== 'building') return false

  state.phase = 'reviewing'
  process.stderr.write(`daemon: factory: builder posted [done] for ticket ${state.ticket}, starting review\n`)

  // Forward builder artifact to PM (F2: PM must see what was built)
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
      void safeSend(state.pmThreadId, `🏭 **Factory review failed to start** ❌\nTicket: ${state.ticket}\nError: ${errMsg}`)
      cleanupState(pmThreadId)
    })

  return true
}

/**
 * Called when a builder session dies WITHOUT posting [done] — crash/timeout.
 */
export function onBuilderDeath(sessionId: string): void {
  const pmThreadId = builderSessionToFactory.get(sessionId)
  if (!pmThreadId) return

  const state = pending.get(pmThreadId)
  if (!state) return

  // Only treat as crash if still building (reviewing phase: builder dies after review = normal)
  if (state.phase === 'building') {
    process.stderr.write(`daemon: factory: builder died without [done] for ticket ${state.ticket}\n`)
    void safeSend(state.pmThreadId, [
      `🏭 **Builder crashed** ❌`,
      `Ticket: ${state.ticket}`,
      `_Builder died without posting [done]. Build did not complete. No review will run._`,
      `_Retry with factory_build if needed._`,
    ].join('\n'))
    cleanupState(pmThreadId)
  }
}

function cleanupState(pmThreadId: string): void {
  const state = pending.get(pmThreadId)
  if (!state) return
  if (state.builderSessionId) builderSessionToFactory.delete(state.builderSessionId)
  if (state.builderThreadId) builderThreadToFactory.delete(state.builderThreadId)
  pending.delete(pmThreadId)
}

// ---------------------------------------------------------------------------
// Event bus subscriptions — named functions for stack trace clarity
// ---------------------------------------------------------------------------

const FACTORY_DONE_RE = /^\[done\]/m

function factoryDoneDetection({ sessionId, text }: { sessionId: string; text: string }): void {
  if (FACTORY_DONE_RE.test(text)) onBuilderDone(sessionId, text)
}

function factorySessionDeath({ sessionId }: { sessionId: string }): void {
  onBuilderDeath(sessionId)

  // PM death: clean up pending state and kill orphaned builder.
  // Snapshot to avoid Map mutation during iteration (killSession can
  // trigger synchronous death events that call cleanupState).
  const pmEntry = [...pending.entries()].find(([_, s]) => s.pmSessionId === sessionId)
  if (pmEntry) {
    const [pmThreadId, state] = pmEntry
    process.stderr.write(`daemon: factory: PM ${sessionId} died with active build ${state.ticket}, cleaning up\n`)
    cleanupState(pmThreadId)
    if (state.builderSessionId) {
      const builderInfo = registry.get(state.builderSessionId)
      if (builderInfo) {
        void killSession(builderInfo, 'PM died').catch(() => {})
      }
    }
  }
}

on('reply', factoryDoneDetection, 'factory:done-detection')
on('review:complete', ({ threadId }) => onFactoryReviewComplete(threadId), 'factory:review-complete')
on('review:cancelled', ({ threadId }) => onFactoryReviewCancelled(threadId), 'factory:review-cancelled')
on('review:round', ({ threadId, round, totalRounds, text }) => onFactoryCriticRound(threadId, round, totalRounds, text), 'factory:review-round')
on('session:death', factorySessionDeath, 'factory:session-death')

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
