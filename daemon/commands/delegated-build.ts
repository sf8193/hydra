import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import type { InboundMessage } from '../../gateway.js'

let proto: Awaited<ReturnType<typeof import('../../protocols/delegated-build.js')>>['default'] | null = null

async function getProto() {
  if (!proto) proto = (await import('../../protocols/delegated-build.js')).default
  return proto
}

export async function handleDelegatedBuildIntercept(msg: InboundMessage, rounds: number, task?: string, model?: string, engine?: 'claude' | 'codex'): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📋').catch(() => {})

  if (isNaN(rounds)) rounds = 3

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`delegate\` in a session thread.`, { replyTo: msg.id })
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
    const p = await getProto()
    await startProtocolRun(p, threadId, sessionId, { rounds: clampedRounds, task, model, engine, strike: true })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Delegated build failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}
