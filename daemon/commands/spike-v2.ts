import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import type { InboundMessage } from '../../gateway.js'

let spikeProto: Awaited<ReturnType<typeof import('../../protocols/spike.js')>>['default'] | null = null

async function getSpikeProto() {
  if (!spikeProto) spikeProto = (await import('../../protocols/spike.js')).default
  return spikeProto
}

export async function handleSpikeV2Intercept(msg: InboundMessage, topic?: string, model?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔬').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`spike_v2\` in a session thread.`, { replyTo: msg.id })
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

  try {
    const proto = await getSpikeProto()
    await startProtocolRun(proto, threadId, sessionId, { rounds: 1, topic, model })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Spike failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelSpikeV2Intercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})
  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)
  if (!run) {
    await gateway.send(msg.channelId, `No spike in progress in this thread.`, { replyTo: msg.id })
    return
  }
  await cancelRun(run, 'cancelled by user')
}
