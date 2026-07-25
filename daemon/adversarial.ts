import { randomUUID } from 'crypto'
import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, isThreadOccupied, dispatchProtocolComplete } from './protocol-registry.js'
import { clearQueue } from './command-queue.js'
import { reviewCriticPrompt } from './prompts/review-critic.js'
import { reviewModel } from '../shared/constants.js'
import { createStateMachine } from './state-machine.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { safeSend, type StatusLineState } from './util.js'
import { dumpTranscript } from './transcript-dump.js'
import { reviewSummaryFormat } from './prompts/review-summary.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewPhase = 'critic_turn' | 'owner_turn' | 'post_pass' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'pass_posted' | 'summary_posted' | 'timeout' | 'cancel'

const OWNER_SENTINEL = '[owner→critic]'
const CRITIC_SENTINEL = '[critic→owner]'
const SUMMARY_SENTINEL = '[summary]'

// ---------------------------------------------------------------------------
// Post-pass instructions — composable lenses applied after correctness rounds
// ---------------------------------------------------------------------------

const POST_PASS_INSTRUCTIONS: Record<string, string> = {
  readability: [
    'Review purely for simplicity and readability. Correctness is settled — don\'t re-litigate it.',
    '',
    'The standard: code should be immediately understandable without comments.',
    'If something needs a comment to explain it, it should be rewritten instead.',
    '',
    'Flag:',
    '- Anything you have to read twice to understand',
    '- Indirection that obscures what\'s actually happening',
    '- Abstractions that make simple things look complex',
    '- Code that could be deleted without changing behavior',
    '- Inconsistency (same thing done two different ways)',
    '',
    'Do NOT suggest adding anything (comments, types, docs, error handling).',
    'Only suggest making things simpler, clearer, or shorter.',
  ].join('\n'),
}

const POST_PASS_ALIASES: Record<string, string> = {
  r: 'readability',
}

export function listPostPasses(): string[] {
  return [...Object.keys(POST_PASS_INSTRUCTIONS), ...Object.keys(POST_PASS_ALIASES)]
}

export function resolvePassName(name: string): string {
  return POST_PASS_ALIASES[name] ?? name
}

export type ReviewState = StatusLineState & {
  reviewId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  topic?: string
  rounds: number
  currentRound: number
  phase: ReviewPhase
  timeout?: ReturnType<typeof setTimeout>
  _criticDisconnectTimer?: ReturnType<typeof setTimeout>
  _ownerDisconnectTimer?: ReturnType<typeof setTimeout>
  _finalizing?: boolean
  _cleanupNudged?: boolean
  model?: string
  postPasses?: string[]
  _currentPassIdx?: number
  engine?: 'claude' | 'codex'
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'post_pass', timeout: 'cancelled', cancel: 'cancelled' },
  post_pass:   { pass_posted: 'post_pass', summary_posted: 'complete', timeout: 'cleanup', cancel: 'cancelled' },
  cleanup:     { summary_posted: 'complete', timeout: 'complete' },
  complete:    {},
  cancelled:   {},
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const reviews = new Map<string, ReviewState>()
const sessionToReview = new Map<string, string>()
const ownerToReview = new Map<string, string>()
const threadToReview = new Map<string, string>()

const cleaningUpThreads = new Set<string>()

const CRITIC_TIMEOUT_MS = 10 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Map cleanup — single function for all exit paths
// ---------------------------------------------------------------------------

function cleanupReviewMaps(state: ReviewState): void {
  if (state.criticSessionId) sessionToReview.delete(state.criticSessionId)
  ownerToReview.delete(state.ownerSessionId)
  threadToReview.delete(state.ownerThreadId)
  reviews.delete(state.reviewId)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function reviewHalf(phase: ReviewPhase): 'top' | 'bottom' {
  return phase === 'critic_turn' || phase === 'cleanup' ? 'top' : 'bottom'
}

registerProtocolBadge(threadId => {
  const state = getReviewByThread(threadId)
  if (!state) return undefined
  if (state.phase === 'post_pass' && state.postPasses) {
    const idx = state._currentPassIdx ?? 0
    if (idx < state.postPasses.length) {
      return `⚔️ +${resolvePassName(state.postPasses[idx])} (${idx + 1}/${state.postPasses.length})`
    }
  }
  return formatRoundBadge('⚔️', reviewHalf(state.phase), state.currentRound, state.rounds)
})

export function getActiveReviews(): ReviewState[] {
  return [...reviews.values()].filter(r => r.phase !== 'complete' && r.phase !== 'cancelled')
}

export function getReviewByThread(threadId: string): ReviewState | undefined {
  const reviewId = threadToReview.get(threadId)
  return reviewId ? reviews.get(reviewId) : undefined
}

export function isReviewParticipant(sessionId: string): boolean {
  return sessionToReview.has(sessionId) || ownerToReview.has(sessionId)
}

// ---------------------------------------------------------------------------
// Start a review
// ---------------------------------------------------------------------------

export async function startReview(
  ownerThreadId: string,
  ownerSessionId: string,
  rounds: number,
  topic?: string,
  model?: string,
  postPasses?: string[],
  engine?: 'claude' | 'codex',
): Promise<ReviewState> {
  if (threadToReview.has(ownerThreadId)) {
    throw new Error('A review is already in progress in this thread')
  }
  if (cleaningUpThreads.has(ownerThreadId)) {
    throw new Error('A previous review is still cleaning up — try again in a few seconds')
  }
  const occupied = isThreadOccupied(ownerThreadId, 'review')
  if (occupied) {
    throw new Error(`A ${occupied} is in progress in this thread — finish or cancel it first`)
  }

  const reviewId = randomUUID()
  const state: ReviewState = {
    reviewId,
    ownerThreadId,
    ownerSessionId,
    topic,
    rounds,
    currentRound: 1,
    phase: 'critic_turn',
    messageIds: [],
    model,
    ...(postPasses && postPasses.length > 0 ? { postPasses } : {}),
    ...(engine ? { engine } : {}),
  }

  reviews.set(reviewId, state)
  threadToReview.set(ownerThreadId, reviewId)
  ownerToReview.set(ownerSessionId, reviewId)
  refreshSessionVisual(ownerThreadId, { badge: formatRoundBadge('⚔️', reviewHalf(state.phase), state.currentRound, state.rounds) })

  try {
    const topicLine = topic ? `\nFocus: **${topic}**` : ''
    const annIds = await safeSend(ownerThreadId, [
      `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `A critic will challenge the design. You defend.${topicLine}`,
    ].join('\n'))
    state.messageIds.push(...annIds)

    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: [
        `[system] Adversarial review started (${rounds} rounds). A critic will challenge your design.`,
        `When their critique arrives as a notification, defend your work by replying to your thread.`,
        ``,
        `**Message routing:** Your first line MUST be \`${OWNER_SENTINEL}\` when posting your defense. Messages without this tag are conversational and won't advance the review.`,
      ].join('\n'),
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    await spawnCritic(state)
    reviewStatusLine(state)
    return state
  } catch (err) {
    cleanupReviewMaps(state)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a review
// ---------------------------------------------------------------------------

export async function cancelReview(reviewId: string): Promise<void> {
  const state = reviews.get(reviewId)
  if (!state) return

  const transition = reviewMachine.transition(state.phase, 'cancel')
  if (!transition.ok) return
  state.phase = transition.to
  if (state.timeout) clearTimeout(state.timeout)
  if (state._criticDisconnectTimer) clearTimeout(state._criticDisconnectTimer)
  if (state._ownerDisconnectTimer) clearTimeout(state._ownerDisconnectTimer)

  try {
    if (state.criticSessionId) {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'review cancelled')
      }
    }
  } catch (err) {
    process.stderr.write(`daemon: review cancel killSession failed: ${err}\n`)
  } finally {
    cleanupReviewMaps(state)
  }

  refreshSessionVisual(state.ownerThreadId)
  const dropped = clearQueue(state.ownerThreadId)
  await safeSend(state.ownerThreadId, `Review cancelled.`)
  if (dropped > 0) {
    await safeSend(state.ownerThreadId, `_⚠️ Queue cleared — ${dropped} chained command${dropped !== 1 ? 's' : ''} dropped_`)
  }

  void deleteReviewMessages(state).catch(err => {
    process.stderr.write(`daemon: cancel cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// Core reply handler
// ---------------------------------------------------------------------------

export function onReviewReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  const firstLine = text.split('\n')[0].trim()

  // Critic posting
  const memberReviewId = sessionToReview.get(sessionId)
  if (memberReviewId) {
    const state = reviews.get(memberReviewId)
    if (!state || chatId !== state.ownerThreadId || state.criticSessionId !== sessionId) return

    // Only process messages with the critic sentinel
    if (!firstLine.startsWith(CRITIC_SENTINEL)) return

    const bodyText = text.slice(text.indexOf('\n') + 1).trim()

    // Post-pass phase — critic feedback on readability/security/etc
    if (state.phase === 'post_pass') {
      const result = reviewMachine.transition(state.phase, 'pass_posted')
      if (!result.ok) return
      state.messageIds.push(...sentMessageIds)
      state.phase = result.to
      onPostPassCriticPosted(state, bodyText)
      return
    }

    const result = reviewMachine.transition(state.phase, 'critic_posted')
    if (!result.ok) return
    state.messageIds.push(...sentMessageIds)
    state.phase = result.to
    onCriticPosted(state, bodyText)
    return
  }

  // Owner posting
  const ownerReviewId = ownerToReview.get(sessionId)
  if (ownerReviewId) {
    const state = reviews.get(ownerReviewId)
    if (!state || chatId !== state.ownerThreadId) return

    // Cleanup phase — sentinel match, same pattern as round routing
    if (state.phase === 'cleanup') {
      if (firstLine.startsWith(SUMMARY_SENTINEL)) {
        const result = reviewMachine.transition(state.phase, 'summary_posted')
        if (result.ok) {
          state.phase = result.to
          finalizeReview(state)
        }
      } else if (!state._cleanupNudged) {
        state._cleanupNudged = true
        transport.sendOrQueue(state.ownerSessionId, {
          type: 'notification',
          content: `[system] Waiting for your review summary. Your first line must be \`${SUMMARY_SENTINEL}\`.`,
          meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
      }
      return
    }

    // Only process messages with the owner sentinel
    if (!firstLine.startsWith(OWNER_SENTINEL)) return

    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
    const isFinalRound = state.currentRound >= state.rounds
    if (isFinalRound && bodyText.split('\n')[0].trim().startsWith(SUMMARY_SENTINEL)) {
      transport.sendOrQueue(state.ownerSessionId, {
        type: 'notification',
        content: `[system] Your defense was counted, but \`${SUMMARY_SENTINEL}\` belongs in the cleanup phase — post it separately after the debate ends.`,
        meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
    const event: ReviewEvent = isFinalRound ? 'final_round' : 'owner_posted'
    const result = reviewMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to

    if (isFinalRound) {
      void finishDebate(state).catch(err => {
        process.stderr.write(`daemon: finishDebate failed: ${err}\n`)
        void cancelReview(state.reviewId).catch(e => process.stderr.write(`daemon: cancelReview failed: ${e}\n`))
      })
    } else {
      onOwnerPosted(state, bodyText)
    }
  }
}

/** Called when a review participant bridge disconnects. */
export function onParticipantDisconnect(sessionId: string): void {
  const reviewId = sessionToReview.get(sessionId) ?? ownerToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state || state.phase === 'complete' || state.phase === 'cancelled') return
  if (transport.has(sessionId)) return

  if (state.criticSessionId === sessionId) {
    process.stderr.write(`daemon: review critic disconnected — 30s grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    state._criticDisconnectTimer = setTimeout(async () => {
      process.stderr.write(`daemon: review critic did not reconnect, cancelling review\n`)
      void cancelReview(state.reviewId).catch(e => process.stderr.write(`daemon: cancelReview failed: ${e}\n`))
    }, 30_000)
  } else if (state.ownerSessionId === sessionId) {
    process.stderr.write(`daemon: review owner disconnected — 2min grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    if (state.criticSessionId) {
      transport.sendOrQueue(state.criticSessionId, {
        type: 'notification',
        content: `[system] Owner session disconnected. Waiting up to 2 minutes for reconnect before cancelling.`,
        meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
    state._ownerDisconnectTimer = setTimeout(async () => {
      process.stderr.write(`daemon: review owner did not reconnect, cancelling review\n`)
      void cancelReview(state.reviewId).catch(e => process.stderr.write(`daemon: cancelReview failed: ${e}\n`))
    }, 120_000)
  }
}

/** Called when a bridge registers. */
export function onParticipantReconnect(sessionId: string): void {
  const reviewId = sessionToReview.get(sessionId) ?? ownerToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state) return
  if (state.criticSessionId === sessionId && state._criticDisconnectTimer) {
    clearTimeout(state._criticDisconnectTimer)
    state._criticDisconnectTimer = undefined
  } else if (state.ownerSessionId === sessionId && state._ownerDisconnectTimer) {
    clearTimeout(state._ownerDisconnectTimer)
    state._ownerDisconnectTimer = undefined
  } else {
    return
  }
  resetTimeout(state)
  process.stderr.write(`daemon: review participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

async function reviewStatusLine(state: ReviewState): Promise<void> {
  const half = reviewHalf(state.phase)
  const isCriticTurn = state.phase === 'critic_turn'
  const name = isCriticTurn
    ? (state.criticSessionId ? registry.get(state.criticSessionId)?.tmuxName : undefined)
    : registry.get(state.ownerSessionId)?.tmuxName
  const action = isCriticTurn
    ? (name ? `${sessionEmoji(name)} ${name} (The Critic) is attacking...` : 'critic is attacking...')
    : (name ? `${sessionEmoji(name)} ${name} (The Owner) is defending...` : 'owner is defending...')
  const text = formatStateLine('⚔️', 'review', formatRoundBadge('', half, state.currentRound, state.rounds), action)
  if (!state.statusHistory) state.statusHistory = []
  state.statusHistory.push(text)
  const ids = await safeSend(state.ownerThreadId, text)
  state.messageIds.push(...ids)
}

function onCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  const badge = formatRoundBadge('⚔️', reviewHalf(state.phase), state.currentRound, state.rounds)
  reviewStatusLine(state)
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `${badge} [Adversarial Review — Critic ${roundLabel}]\n\n${text}\n\n---\nDefend your design. Reply to your thread with \`${OWNER_SENTINEL}\` as the first line.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

function onOwnerPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  state.currentRound++
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  reviewStatusLine(state)
  const badge = formatRoundBadge('⚔️', reviewHalf(state.phase), state.currentRound, state.rounds)

  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: `${badge} [Adversarial Review — Owner Defense]\n\n${text}\n\n---\nPost your counter-argument for ${roundLabel}. First line must be \`${CRITIC_SENTINEL}\`.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-owner', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishDebate(state: ReviewState): Promise<void> {
  // If post-passes are configured, enter post-pass flow instead of finishing
  if (state.postPasses && state.postPasses.length > 0) {
    state._currentPassIdx = 0
    startNextPass(state)
    return
  }

  // Kill critic — wrapped so a kill failure doesn't abort the closing sequence
  if (state.criticSessionId) {
    sessionToReview.delete(state.criticSessionId)
    try {
      const criticInfo = registry.get(state.criticSessionId)
      if (criticInfo && !killsInProgress.has(state.criticSessionId)) {
        await killSession(criticInfo, 'debate complete')
      }
    } catch (err) {
      process.stderr.write(`daemon: review finishDebate killSession failed: ${err}\n`)
    }
    state.criticSessionId = undefined
  }

  // Closing transition: new message (linear, not edited onto the status line)
  void safeSend(state.ownerThreadId, formatStateLine('⚔️', 'review', '⚒︎', 'has concluded. Processing summary…'))

  // Transition through state machine: post_pass → timeout → cleanup
  const transition = reviewMachine.transition(state.phase, 'timeout')
  if (transition.ok) state.phase = transition.to
  completeReview(state)
}

// ---------------------------------------------------------------------------
// Post-pass flow — critic reviews with a different lens after correctness
// ---------------------------------------------------------------------------

function startNextPass(state: ReviewState): void {
  const idx = state._currentPassIdx ?? 0
  const passes = state.postPasses!
  const passName = resolvePassName(passes[idx])
  const instruction = POST_PASS_INSTRUCTIONS[passName]

  if (!instruction) {
    process.stderr.write(`daemon: review: unknown pass "${passName}", skipping\n`)
    void advanceOrFinishPasses(state)
    return
  }

  const passLabel = `+${passName} (${idx + 1}/${passes.length})`
  const statusText = formatStateLine('⚔️', 'review', passLabel, `critic reviewing ${passName}`)
  if (!state.statusHistory) state.statusHistory = []
  state.statusHistory.push(statusText)
  void safeSend(state.ownerThreadId, statusText).then(ids => state.messageIds.push(...ids)).catch(() => {})

  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: [
      `[system] Correctness debate complete. Now do a **${passName}** pass.`,
      ``,
      instruction,
      ``,
      `Post your feedback with \`${CRITIC_SENTINEL}\` as the first line.`,
      `If everything is clean, post \`${CRITIC_SENTINEL}\` followed by \`LGTM\`.`,
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

function onPostPassCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  const firstLine = text.split('\n')[0].trim()
  const isLgtm = firstLine.replace(/[*_.]/g, '').trim().toUpperCase() === 'LGTM'

  if (isLgtm) {
    void advanceOrFinishPasses(state).catch(err => {
      process.stderr.write(`daemon: review post-pass advance failed: ${err}\n`)
      finalizeReview(state)
    })
  } else {
    // Relay feedback to owner — they apply fixes while review advances
    const idx = state._currentPassIdx ?? 0
    const passName = resolvePassName(state.postPasses![idx])
    transport.sendOrQueue(state.ownerSessionId, {
      type: 'notification',
      content: `[+${passName} feedback]\n\n${text}\n\n---\nApply these changes.`,
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-critic', user_id: 'system', ts: new Date().toISOString() },
    })
    void advanceOrFinishPasses(state).catch(err => {
      process.stderr.write(`daemon: review post-pass advance failed: ${err}\n`)
      finalizeReview(state)
    })
  }
}

async function advanceOrFinishPasses(state: ReviewState): Promise<void> {
  const idx = (state._currentPassIdx ?? 0) + 1
  state._currentPassIdx = idx

  if (idx < (state.postPasses?.length ?? 0)) {
    startNextPass(state)
  } else {
    // All passes done — kill critic and finish
    if (state.criticSessionId) {
      sessionToReview.delete(state.criticSessionId)
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'review complete')
      }
      state.criticSessionId = undefined
    }
    // Transition through state machine: post_pass → timeout → cleanup
    const transition = reviewMachine.transition(state.phase, 'timeout')
    if (transition.ok) state.phase = transition.to
    completeReview(state)
  }
}

function completeReview(state: ReviewState): void {
  if (state.phase === 'complete' || state.phase === 'cancelled' || state._finalizing) return

  if (state.timeout) clearTimeout(state.timeout)
  state.timeout = setTimeout(async () => {
    if (state.phase !== 'cleanup') return
    process.stderr.write(`daemon: review cleanup timed out, auto-finalizing\n`)
    await gateway.send(state.ownerThreadId, `**Review Summary** — auto-closed (owner did not post summary)`).catch(() => {})
    const transition = reviewMachine.transition(state.phase, 'timeout')
    if (!transition.ok) return
    state.phase = transition.to
    finalizeReview(state)
  }, 5 * 60 * 1000)

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: [
      `[system] Adversarial review complete (${state.rounds} round${state.rounds > 1 ? 's' : ''}).`,
      `Post a brief summary to your thread. After you post, the review messages will be cleaned up.`,
      ``,
      `**Message routing:** Your first line MUST be \`${SUMMARY_SENTINEL}\`. Messages without this tag won't complete the review.`,
      ``,
      `Use this format:`,
      `${SUMMARY_SENTINEL}`,
      ...reviewSummaryFormat(state.rounds),
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

async function deleteReviewMessages(state: ReviewState): Promise<void> {
  if (state.messageIds.length === 0) return

  // Preserve-then-strike: no deletion without a complete dump on disk first.
  // Covers cancel and completion alike — both paths land here.
  const owner = registry.get(state.ownerSessionId)?.tmuxName ?? state.ownerSessionId
  const critic = state.criticSessionId ? registry.get(state.criticSessionId)?.tmuxName ?? state.criticSessionId : 'unknown'
  const dumpPath = await dumpTranscript(state.ownerThreadId, 'review', state.messageIds, {
    topic: state.topic ?? '(none)',
    rounds: `${state.currentRound}/${state.rounds}`,
    cast: `owner ${owner} · critic ${critic}`,
    outcome: state.phase,
  }, state.statusHistory)
  if (!dumpPath) {
    process.stderr.write(`daemon: review cleanup: transcript dump failed — leaving ${state.messageIds.length} messages in place (no strike without preserve)\n`)
    return
  }

  let failures = 0
  for (let i = 0; i < state.messageIds.length; i++) {
    try {
      await gateway.delete(state.ownerThreadId, state.messageIds[i])
    } catch (err) {
      failures++
      process.stderr.write(`daemon: review cleanup: failed to delete message ${state.messageIds[i]}: ${err}\n`)
    }
    if (i < state.messageIds.length - 1) {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  if (failures > 0) {
    process.stderr.write(`daemon: review cleanup: ${failures}/${state.messageIds.length} message deletes failed\n`)
  }

  // Posted after the strike so the one status line reports the whole outcome.
  const struck = state.messageIds.length - failures
  const failNote = failures > 0 ? ` · ⚠️ ${failures} delete${failures > 1 ? 's' : ''} failed (still in thread)` : ''
  void safeSend(state.ownerThreadId, `_📼 transcript saved: \`${dumpPath}\` · ${struck}/${state.messageIds.length} messages struck${failNote}_`)
}

function finalizeReview(state: ReviewState): void {
  if (state.phase !== 'complete') return
  if (state._finalizing) return
  state._finalizing = true

  if (state.timeout) {
    clearTimeout(state.timeout)
    state.timeout = undefined
  }

  cleanupReviewMaps(state)
  refreshSessionVisual(state.ownerThreadId)

  const threadId = state.ownerThreadId
  cleaningUpThreads.add(threadId)
  void deleteReviewMessages(state)
    .catch(err => {
      process.stderr.write(`daemon: review message cleanup failed: ${err}\n`)
    })
    .finally(() => {
      cleaningUpThreads.delete(threadId)
      dispatchProtocolComplete(threadId)
    })
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: ReviewState): Promise<void> {
  const statusMsg = await gateway.send(state.ownerThreadId, `Spawning critic...`)
  state.messageIds.push(statusMsg.id)

  const criticModel = state.engine === 'codex' ? state.model : (state.model ?? reviewModel())
  try {
    const result = await doSpawnSession(`Adversarial review CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      trigger: 'review',
      joinThread: state.ownerThreadId,
      ...(criticModel ? { model: criticModel } : {}),
      ...(state.engine ? { engine: state.engine } : {}),
      promptBuilder: (sessionId, tmuxName) =>
        reviewCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, topic: state.topic }),
    })

    state.criticSessionId = result.sessionId
    sessionToReview.set(result.sessionId, state.reviewId)
    void gateway.delete(state.ownerThreadId, statusMsg.id).catch(() => {})
    state.messageIds = state.messageIds.filter(id => id !== statusMsg.id)
    resetTimeout(state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: critic spawn failed: ${msg}\n`)
    await safeSend(state.ownerThreadId, `Failed to spawn critic: ${msg}. Review cancelled.`)
    void cancelReview(state.reviewId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: ReviewState): void {
  if (state.timeout) clearTimeout(state.timeout)

  const whose = (state.phase === 'critic_turn' || state.phase === 'post_pass') ? 'critic' : 'owner'
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review turn timed out (${whose})\n`)
    if (state.phase === 'post_pass') {
      // Graceful: skip remaining passes and finish the review
      await safeSend(state.ownerThreadId, `Post-pass timed out waiting for critic. Finishing review.`)
      void advanceOrFinishPasses(state).catch(() => finalizeReview(state))
    } else {
      await safeSend(state.ownerThreadId, `Review timed out waiting for ${whose}. Cancelling.`)
      await cancelReview(state.reviewId)
    }
  }, timeoutMs)
}

registerProtocol('review', {
  getByThread: (threadId) => !!getReviewByThread(threadId),
  isParticipant: isReviewParticipant,
  onReply: onReviewReply,
  onDisconnect: onParticipantDisconnect,
  onReconnect: onParticipantReconnect,
  expectedTag: (sessionId, chatId) => {
    const reviewId = sessionToReview.get(sessionId) ?? ownerToReview.get(sessionId)
    const state = reviewId ? reviews.get(reviewId) : undefined
    if (!state || chatId !== state.ownerThreadId) return null
    if (state.phase === 'critic_turn' && sessionId === state.criticSessionId) return CRITIC_SENTINEL
    if (state.phase === 'post_pass' && sessionId === state.criticSessionId) return CRITIC_SENTINEL
    if (state.phase === 'owner_turn' && sessionId === state.ownerSessionId) return OWNER_SENTINEL
    if (state.phase === 'cleanup' && sessionId === state.ownerSessionId) return SUMMARY_SENTINEL
    return null
  },
})
