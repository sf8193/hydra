import { randomUUID } from 'crypto'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { getBuildByThread } from './build.js'
import { getDesignByThread } from './design.js'
import { reviewCriticPrompt } from './prompts/review-critic.js'
import { createStateMachine } from './state-machine.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge } from './anchor-state.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewPhase = 'critic_turn' | 'owner_turn' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'summary_posted' | 'timeout' | 'cancel'

const OWNER_SENTINEL = '[owner→critic]'
const CRITIC_SENTINEL = '[critic→owner]'
const SUMMARY_SENTINEL = '[summary]'

export type ReviewState = {
  reviewId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  topic?: string
  rounds: number
  currentRound: number
  phase: ReviewPhase
  messageIds: string[]
  timeout?: ReturnType<typeof setTimeout>
  _criticDisconnectTimer?: ReturnType<typeof setTimeout>
  _ownerDisconnectTimer?: ReturnType<typeof setTimeout>
  _finalizing?: boolean
  _cleanupNudged?: boolean
  statusMessageId?: string
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled' },
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

registerProtocolBadge(threadId => {
  const state = getReviewByThread(threadId)
  if (!state) return undefined
  const half = state.phase === 'critic_turn' || state.phase === 'cleanup' ? 'top' : 'bottom'
  return formatRoundBadge('⚔️', half, state.currentRound, state.rounds)
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
): Promise<ReviewState> {
  if (threadToReview.has(ownerThreadId)) {
    throw new Error('A review is already in progress in this thread')
  }
  if (cleaningUpThreads.has(ownerThreadId)) {
    throw new Error('A previous review is still cleaning up — try again in a few seconds')
  }
  if (getBuildByThread(ownerThreadId)) {
    throw new Error('A build is in progress in this thread — finish or cancel it first')
  }
  if (getDesignByThread(ownerThreadId)) {
    throw new Error('A design is in progress in this thread — finish or cancel it first')
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
  }

  reviews.set(reviewId, state)
  threadToReview.set(ownerThreadId, reviewId)
  ownerToReview.set(ownerSessionId, reviewId)
  refreshSessionVisual(ownerThreadId, { badge: formatRoundBadge('⚔️', 'top', state.currentRound, state.rounds) })

  try {
    const topicLine = topic ? `\nFocus: **${topic}**` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `A critic will challenge the design. You defend.${topicLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

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
  await gateway.send(state.ownerThreadId, `Review cancelled.`)

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

    const result = reviewMachine.transition(state.phase, 'critic_posted')
    if (!result.ok) return

    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
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
    const event: ReviewEvent = isFinalRound ? 'final_round' : 'owner_posted'
    const result = reviewMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to

    if (isFinalRound) {
      void finishDebate(state, bodyText).catch(err => {
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

function onCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  const badge = formatRoundBadge('⚔️', 'top', state.currentRound, state.rounds)
  const statusText = `_${badge} Critic posted (${roundLabel}). Owner defending..._`
  if (state.statusMessageId) {
    void gateway.edit(state.ownerThreadId, state.statusMessageId, statusText).catch(() => {})
  } else {
    void gateway.send(state.ownerThreadId, statusText).then(msg => { state.statusMessageId = msg.id }).catch(() => {})
  }
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
  const badge = formatRoundBadge('⚔️', 'bottom', state.currentRound, state.rounds)
  const statusText = `_${badge} Owner defended (${roundLabel}). Critic reviewing..._`
  if (state.statusMessageId) {
    void gateway.edit(state.ownerThreadId, state.statusMessageId, statusText).catch(() => {})
  } else {
    void gateway.send(state.ownerThreadId, statusText).then(msg => { state.statusMessageId = msg.id }).catch(() => {})
  }

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

async function finishDebate(state: ReviewState, lastOwnerText: string): Promise<void> {
  // Kill critic — delete from map BEFORE nulling the field
  if (state.criticSessionId) {
    sessionToReview.delete(state.criticSessionId)
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'debate complete')
    }
    state.criticSessionId = undefined
  }

  // If the owner's final defense starts with the summary sentinel, skip cleanup
  if (lastOwnerText.split('\n')[0].trim().startsWith(SUMMARY_SENTINEL)) {
    const transition = reviewMachine.transition(state.phase, 'summary_posted')
    if (transition.ok) {
      state.phase = transition.to
      finalizeReview(state)
      return
    }
  }

  completeReview(state)
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
      `**Review Summary** (${state.rounds} round${state.rounds > 1 ? 's' : ''})`,
      `- ✅ issue — fixed/will fix`,
      `- ⚠️ issue — acknowledged, deferred`,
      `- ❌ issue — rebutted`,
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

async function deleteReviewMessages(state: ReviewState): Promise<void> {
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

  cleaningUpThreads.add(state.ownerThreadId)
  void deleteReviewMessages(state)
    .catch(err => {
      process.stderr.write(`daemon: review message cleanup failed: ${err}\n`)
    })
    .finally(() => {
      cleaningUpThreads.delete(state.ownerThreadId)
    })
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: ReviewState): Promise<void> {
  const statusMsg = await gateway.send(state.ownerThreadId, `Spawning critic...`)
  state.messageIds.push(statusMsg.id)

  // Intentionally omits model — critics always use SPAWN_MODEL (strongest available)
  try {
    const result = await doSpawnSession(`Adversarial review CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      promptBuilder: (sessionId, tmuxName) =>
        reviewCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, topic: state.topic }),
    })

    state.criticSessionId = result.sessionId
    sessionToReview.set(result.sessionId, state.reviewId)
    void gateway.edit(state.ownerThreadId, statusMsg.id, `_Critic (**${result.name}**) spawned._`).catch(() => {})
    resetTimeout(state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: critic spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn critic: ${msg}. Review cancelled.`)
    void cancelReview(state.reviewId)
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: ReviewState): void {
  if (state.timeout) clearTimeout(state.timeout)

  const whose = state.phase === 'critic_turn' ? 'critic' : 'owner'
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review turn timed out (${whose})\n`)
    await gateway.send(state.ownerThreadId, `Review timed out waiting for ${whose}. Cancelling.`)
    await cancelReview(state.reviewId)
  }, timeoutMs)
}
