import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import type { InboundMessage } from '../../gateway.js'

let buildProto: Awaited<ReturnType<typeof import('../../protocols/build.js')>>['default'] | null = null

async function getBuildProto() {
  if (!buildProto) buildProto = (await import('../../protocols/build.js')).default
  return buildProto
}

export async function handleBuildV2Intercept(msg: InboundMessage, rounds: number, task?: string, model?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔨').catch(() => {})

  if (isNaN(rounds)) rounds = 3

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
  const occupied = isThreadOccupied(threadId)
  if (occupied) {
    await gateway.send(msg.channelId, `A ${occupied} is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  const clampedRounds = Math.max(1, Math.min(rounds, 5))

  try {
    const proto = await getBuildProto()
    await startProtocolRun(proto, threadId, sessionId, { rounds: clampedRounds, task, model, strike: true })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Build v2 failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelBuildV2Intercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run) {
    await gateway.send(msg.channelId, `No build_v2 in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelRun(run, 'cancelled by user')
}
