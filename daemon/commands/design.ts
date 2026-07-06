import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startDesign, getDesignByThread, cancelDesign, retryDesign } from '../design.js'
import { debouncedRefreshListDisplay } from './status.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleDesignIntercept(msg: InboundMessage, topic: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🎨').catch(() => {})

  // Same pattern as build/review — resolve thread via session registry
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

export async function handleRetryDesignIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔄').catch(() => {})
  const threadId = registry.resolveThreadId(msg)
  const existing = getDesignByThread(threadId)
  if (!existing) {
    await gateway.send(msg.channelId, `No design session to retry.`, { replyTo: msg.id })
    return
  }
  try {
    const { respawned, alreadyAlive } = await retryDesign(threadId)
    const parts: string[] = []
    if (respawned > 0) parts.push(`${respawned} persona${respawned !== 1 ? 's' : ''} respawned`)
    if (alreadyAlive > 0) parts.push(`${alreadyAlive} already alive`)
    await gateway.send(msg.channelId, `🔄 Design retry: ${parts.join(', ')}.`, { replyTo: msg.id })
    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Retry failed: ${errMsg}`, { replyTo: msg.id })
  }
}
