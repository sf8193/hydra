import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startDesign, getDesignByThread, cancelDesign } from '../design.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleDesignIntercept(msg: InboundMessage, topic: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🎨').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`design:\` in a session thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(msg.channelId, `Session not found.`, { replyTo: msg.id })
    return
  }

  const threadId = info.threadId

  const existing = getDesignByThread(threadId)
  if (existing) {
    await gateway.send(msg.channelId, `A design session is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  try {
    await startDesign(threadId, topic)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Design failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelDesignIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const existing = getDesignByThread(threadId)
  if (!existing) {
    await gateway.send(msg.channelId, `No design session in progress.`, { replyTo: msg.id })
    return
  }

  await cancelDesign(threadId)
}
