import { gateway } from '../../infra/config.js'
import { safeSend } from '../../infra/util.js'
import { registry } from '../../sessions/registry.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../../sessions/protocol-registry.js'
import type { InboundMessage } from '../../gateways/gateway.js'
import type { ProviderId } from '../../engines/engine-adapter.js'
import spikeProto from '../../protocols/spike.js'

export async function handleSpikeV2Intercept(msg: InboundMessage, topic?: string, model?: string, engine?: ProviderId): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔬').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await safeSend(msg.channelId, `No session owns this thread. Use \`spike\` in a session thread.`, { replyTo: msg.id })
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    await safeSend(msg.channelId, `Session not found.`, { replyTo: msg.id })
    return
  }

  const threadId = info.threadId
  const occupied = isThreadOccupied(threadId)
  if (occupied) {
    await safeSend(msg.channelId, `A ${occupied} is already in progress in this thread.`, { replyTo: msg.id })
    return
  }

  try {
    await startProtocolRun(spikeProto, threadId, sessionId, { rounds: 1, topic, model, engine })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await safeSend(msg.channelId, `Spike failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelSpikeV2Intercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})
  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)
  if (!run) {
    await safeSend(msg.channelId, `No spike in progress in this thread.`, { replyTo: msg.id })
    return
  }
  await cancelRun(run, 'cancelled by user')
}
