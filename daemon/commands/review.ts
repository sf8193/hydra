import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startReview, getReviewByThread, cancelReview } from '../adversarial.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleReviewIntercept(msg: InboundMessage, rounds: number, topic?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '⚔️').catch(() => {})

  // Must be in a session thread
  const sessionId = registry.getByThread(msg.channelId)
    ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`/review\` in a session thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(msg.channelId, `Session not found.`, { replyTo: msg.id })
    return
  }

  const threadId = info.threadId

  // Check if a review is already running
  const existing = getReviewByThread(threadId)
  if (existing) {
    await gateway.send(msg.channelId, `A review is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  // Clamp rounds
  const clampedRounds = Math.max(1, Math.min(rounds, 5))

  try {
    await startReview(threadId, sessionId, clampedRounds, topic)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Review failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelReviewIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = msg.channelId
  const existing = getReviewByThread(threadId)

  if (!existing) {
    await gateway.send(msg.channelId, `No review in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelReview(existing.reviewId)
}
