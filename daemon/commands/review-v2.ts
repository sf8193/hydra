import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import type { InboundMessage } from '../../gateway.js'

let reviewProto: Awaited<ReturnType<typeof import('../../protocols/review.js')>>['default'] | null = null

async function getReviewProto() {
  if (!reviewProto) reviewProto = (await import('../../protocols/review.js')).default
  return reviewProto
}

export async function handleReviewV2Intercept(msg: InboundMessage, rounds: number, topic?: string, model?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '⚔️').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`review_v2\` in a session thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(msg.channelId, `Session not found.`, { replyTo: msg.id })
    return
  }

  const threadId = info.threadId
  const occupied = isThreadOccupied(threadId)
  if (occupied) {
    await gateway.send(msg.channelId, `A ${occupied} is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  const clampedRounds = Math.max(1, Math.min(rounds, 5))

  try {
    const proto = await getReviewProto()
    await startProtocolRun(proto, threadId, sessionId, { rounds: clampedRounds, topic, model })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Review v2 failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelReviewV2Intercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run) {
    await gateway.send(msg.channelId, `No review_v2 in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelRun(run, 'cancelled by user')
}
