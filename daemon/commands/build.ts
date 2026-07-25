import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startBuild, getBuildByThread, cancelBuild } from '../build.js'
import { clearQueue } from '../command-queue.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleBuildIntercept(msg: InboundMessage, rounds: number, task?: string, worktree?: string, model?: string, engine?: 'claude' | 'codex'): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔨').catch(() => {})

  // Validate rounds
  if (isNaN(rounds)) rounds = 3

  // Must be in a session thread
  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`build\` in a session thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await gateway.send(msg.channelId, `Session not found.`, { replyTo: msg.id })
    return
  }

  const threadId = info.threadId

  // Check if a build is already running
  const existing = getBuildByThread(threadId)
  if (existing) {
    await gateway.send(msg.channelId, `A build is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  // Clamp rounds
  const clampedRounds = Math.max(1, Math.min(rounds, 5))

  try {
    await startBuild(threadId, sessionId, clampedRounds, task, worktree, model, engine)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Build failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelBuildIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const existing = getBuildByThread(threadId)

  if (!existing) {
    await gateway.send(msg.channelId, `No build in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelBuild(existing.buildId)
  const dropped = clearQueue(threadId)
  if (dropped > 0) {
    void gateway.send(msg.channelId, `_⚠️ Queue cleared — ${dropped} chained command${dropped !== 1 ? 's' : ''} dropped_`).catch(() => {})
  }
}
