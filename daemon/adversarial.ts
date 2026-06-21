import { randomUUID } from 'crypto'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewState = {
  reviewId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  topic?: string
  rounds: number
  currentRound: number
  currentTurn: 'critic' | 'owner'
  phase: 'debate' | 'cleanup' | 'complete' | 'cancelled'
  consecutiveFailures: number
  messageIds: string[]  // track all review messages for cleanup
  timeout?: ReturnType<typeof setTimeout>
  _disconnectTimer?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const reviews = new Map<string, ReviewState>()
const sessionToReview = new Map<string, string>()  // critic → reviewId
const ownerToReview = new Map<string, string>()     // owner → reviewId
const threadToReview = new Map<string, string>()    // thread → reviewId

const CRITIC_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes for critic
const OWNER_TIMEOUT_MS = 30 * 60 * 1000  // 30 minutes for owner (human involvement)

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

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

  const reviewId = randomUUID()
  const state: ReviewState = {
    reviewId,
    ownerThreadId,
    ownerSessionId,
    topic,
    rounds,
    currentRound: 1,
    currentTurn: 'critic',
    phase: 'debate',
    consecutiveFailures: 0,
    messageIds: [],
  }

  // Set maps synchronously before any await to prevent TOCTOU
  reviews.set(reviewId, state)
  threadToReview.set(ownerThreadId, reviewId)
  ownerToReview.set(ownerSessionId, reviewId)

  try {
    const topicLine = topic ? `\nFocus: **${topic}**` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `A critic will challenge the design. You defend.${topicLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

    // Notify owner to prepare
    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: `[system] Adversarial review started (${rounds} rounds). A critic will challenge your design. When their critique arrives as a notification, defend your work by replying to your thread. Be specific — cite code and reasoning.`,
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    // Spawn critic
    await spawnCritic(state)
    return state
  } catch (err) {
    // Clean up maps if startup fails
    reviews.delete(reviewId)
    threadToReview.delete(ownerThreadId)
    ownerToReview.delete(ownerSessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a review
// ---------------------------------------------------------------------------

export async function cancelReview(reviewId: string): Promise<void> {
  const state = reviews.get(reviewId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)
  if (state._disconnectTimer) clearTimeout(state._disconnectTimer)

  // Kill critic if alive
  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'review cancelled')
    }
    sessionToReview.delete(state.criticSessionId)
  }

  ownerToReview.delete(state.ownerSessionId)
  threadToReview.delete(state.ownerThreadId)
  reviews.delete(reviewId)
  await gateway.send(state.ownerThreadId, `Review cancelled.`)

  // Clean up review messages
  void deleteReviewMessages(state)
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

export function onReviewReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  // Check if this is a critic posting
  const memberReviewId = sessionToReview.get(sessionId)
  if (memberReviewId) {
    const state = reviews.get(memberReviewId)
    if (!state || chatId !== state.ownerThreadId) return

    if (state.phase === 'debate' && state.currentTurn === 'critic' && state.criticSessionId === sessionId) {
      state.messageIds.push(...sentMessageIds)
      onCriticPosted(state, text)
      return
    }
    return
  }

  // Check if this is the owner posting during a review — must be to the review thread
  const ownerReviewId = ownerToReview.get(sessionId)
  if (ownerReviewId) {
    const state = reviews.get(ownerReviewId)
    if (!state || chatId !== state.ownerThreadId) return

    if (state.phase === 'cleanup') {
      // Owner posted the summary — delete review messages and finalize
      finalizeReview(state)
      return
    }

    if (state.phase !== 'debate' || state.currentTurn !== 'owner') return
    state.messageIds.push(...sentMessageIds)
    onOwnerPosted(state, text)
  }
}

/** Called when a critic bridge disconnects. Grace period before cancel. */
export function onParticipantDisconnect(sessionId: string): void {
  const reviewId = sessionToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state) return

  if (state.phase === 'debate' && state.criticSessionId === sessionId) {
    // If a new bridge already registered, this is a stale disconnect — ignore
    if (transport.has(sessionId)) return

    process.stderr.write(`daemon: review critic disconnected — 30s grace period\n`)
    // Pause turn timeout during grace period to prevent double-cancel
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    // Grace period: bridge reconnections fire disconnect before re-register
    state._disconnectTimer = setTimeout(async () => {
      if (transport.has(sessionId)) {
        process.stderr.write(`daemon: review critic reconnected, grace period cleared\n`)
        resetTimeout(state)
        return
      }
      process.stderr.write(`daemon: review critic did not reconnect, cancelling review\n`)
      await cancelReview(state.reviewId)
    }, 30_000)
  }
}

/** Called when a bridge registers — clears disconnect grace period if applicable. */
export function onParticipantReconnect(sessionId: string): void {
  const reviewId = sessionToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state || !state._disconnectTimer) return
  clearTimeout(state._disconnectTimer)
  state._disconnectTimer = undefined
  // Restore turn timeout that was paused during disconnect
  resetTimeout(state)
  process.stderr.write(`daemon: review participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onCriticPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  // Push critique to owner
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `[Adversarial Review — Critic ${roundLabel}]\n\n${text}\n\n---\nDefend your design. Reply to your thread with your response.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'owner'
  resetTimeout(state)
}

function onOwnerPosted(state: ReviewState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)

  if (state.currentRound >= state.rounds) {
    // Final round complete — kill critic, finish
    void finishDebate(state).catch(err => {
      process.stderr.write(`daemon: finishDebate failed: ${err}\n`)
      void cancelReview(state.reviewId).catch(() => {})
      void gateway.send(state.ownerThreadId, `Review failed during cleanup: ${err}`).catch(() => {})
    })
    return
  }

  // Push defense to critic and advance round
  state.currentRound++
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  transport.sendOrQueue(state.criticSessionId!, {
    type: 'notification',
    content: `[Adversarial Review — Owner Defense]\n\n${text}\n\n---\nPost your counter-argument for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'review-owner', user_id: 'system', ts: new Date().toISOString() },
  })

  state.currentTurn = 'critic'
  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function finishDebate(state: ReviewState): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    const info = registry.get(state.criticSessionId)
    if (info && !killsInProgress.has(state.criticSessionId)) {
      await killSession(info, 'debate complete')
    }
    sessionToReview.delete(state.criticSessionId)
    state.criticSessionId = undefined
  }

  completeReview(state)
}

function completeReview(state: ReviewState): void {
  state.phase = 'cleanup'

  // Nudge owner to post a summary — messages stay visible until summary is posted
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: [
      `[system] Adversarial review complete (${state.rounds} round${state.rounds > 1 ? 's' : ''}).`,
      `Post a brief summary to your thread. After you post, the review messages will be cleaned up.`,
      ``,
      `Use this format:`,
      `**Review Summary** (${state.rounds} round${state.rounds > 1 ? 's' : ''})`,
      `- ✅ issue — fixed/will fix`,
      `- ⚠️ issue — acknowledged, deferred`,
      `- ❌ issue — rebutted`,
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

/** Delete review messages after owner posts summary. Serialized with delay to avoid rate limits. */
async function deleteReviewMessages(state: ReviewState): Promise<void> {
  for (const msgId of state.messageIds) {
    try {
      await gateway.delete(state.ownerThreadId, msgId)
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
}

function finalizeReview(state: ReviewState): void {
  state.phase = 'complete'
  ownerToReview.delete(state.ownerSessionId)
  threadToReview.delete(state.ownerThreadId)
  reviews.delete(state.reviewId)

  void deleteReviewMessages(state)
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: ReviewState): Promise<void> {
  const msg = await gateway.send(state.ownerThreadId, `Spawning critic...`)
  state.messageIds.push(msg.id)

  try {
    const result = await doSpawnSession(`Adversarial review CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      promptBuilder: (sessionId, tmuxName) =>
        buildCriticPrompt(sessionId, tmuxName, state.rounds, state.ownerThreadId, state.topic),
    })

    state.criticSessionId = result.sessionId
    state.consecutiveFailures = 0
    sessionToReview.set(result.sessionId, state.reviewId)
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

  const whose = state.currentTurn
  const timeoutMs = whose === 'owner' ? OWNER_TIMEOUT_MS : CRITIC_TIMEOUT_MS
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: review turn timed out (${whose})\n`)
    await gateway.send(state.ownerThreadId, `Review timed out waiting for ${whose}. Cancelling.`)
    await cancelReview(state.reviewId)
  }, timeoutMs)
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildCriticPrompt(
  sessionId: string,
  tmuxName: string,
  rounds: number,
  threadId: string,
  topic?: string,
): string {
  const mandate = topic
    ? `**Your focus:** ${topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
    : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`

  return [
    `You are ${tmuxName}, the CRITIC in a ${rounds}-round adversarial review.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read the design conversation`,
    `2. Read any code files, wiki articles, or analysis referenced in the discussion`,
    `3. Post your opening critique using reply(chat_id="${threadId}")`,
    `4. **WAIT** — the designer will respond. Their defense will arrive as a notification.`,
    `5. When you receive their defense, post your counter-argument. Repeat for ${rounds} rounds.`,
    ``,
    mandate,
    ``,
    `Format with clear headers. Be substantive and focused. One message per round.`,
  ].join('\n')
}

