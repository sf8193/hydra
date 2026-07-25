import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startReview, getReviewByThread, cancelReview, listPostPasses } from '../adversarial.js'
import { queueLength } from '../command-queue.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleReviewIntercept(msg: InboundMessage, rounds: number, topic?: string, model?: string, postPasses?: string[], engine?: 'claude' | 'codex'): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '⚔️').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

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

  const existing = getReviewByThread(threadId)
  if (existing) {
    const qLen = queueLength(threadId)
    const queueWarning = qLen > 0 ? `\n_⚠️ ${qLen} chained command${qLen !== 1 ? 's' : ''} will fire when the current review completes — \`kill queue\` to drop them._` : ''
    await gateway.send(msg.channelId, `A review is already in progress in this thread.${queueWarning}`, { replyTo: msg.id })
    return
  }

  const clampedRounds = Math.max(1, Math.min(rounds, 5))

  const validPasses = listPostPasses()
  const invalidPasses = postPasses?.filter(p => !validPasses.includes(p))
  if (invalidPasses && invalidPasses.length > 0) {
    await gateway.send(msg.channelId, `Unknown pass${invalidPasses.length > 1 ? 'es' : ''}: ${invalidPasses.map(p => `\`+${p}\``).join(', ')}. Available: ${validPasses.map(p => `\`+${p}\``).join(', ')}`, { replyTo: msg.id })
    return
  }

  try {
    await startReview(threadId, sessionId, clampedRounds, topic, model, postPasses, engine)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Review failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelReviewIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const existing = getReviewByThread(threadId)

  if (!existing) {
    await gateway.send(msg.channelId, `No review in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelReview(existing.reviewId)
}
