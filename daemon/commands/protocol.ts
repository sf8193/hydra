import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { resolveModifiers } from '../modifiers.js'
import { safeSend } from '../util.js'
import { getProtocol } from '../protocol-loader.js'
import type { InboundMessage } from '../../gateway.js'

export async function handleProtocolIntercept(
  protoName: string,
  msg: InboundMessage,
  params: { rounds?: number; topic?: string; model?: string; modifierNames?: string[]; strike?: boolean; engine?: 'claude' | 'codex' },
): Promise<void> {
  let loadError: string | undefined
  const proto = await getProtocol(protoName).catch(err => {
    loadError = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: protocol: failed to load "${protoName}": ${loadError}\n`)
    return null
  })
  if (!proto) {
    void safeSend(msg.channelId, loadError ? `Failed to load protocol \`${protoName}\` — check daemon logs for details` : `Unknown protocol: ${protoName}`)
    return
  }

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    void safeSend(msg.channelId, `No session owns this thread. Use \`${protoName}\` in a session thread.`)
    return
  }

  const info = registry.get(sessionId)
  if (!info) {
    void safeSend(msg.channelId, `Session not found.`)
    return
  }

  const threadId = info.threadId
  const occupied = isThreadOccupied(threadId)
  if (occupied) {
    void safeSend(msg.channelId, `A ${occupied} is already in progress in this thread.`)
    return
  }

  const rounds = Math.max(1, Math.min(params.rounds ?? 3, 5))

  let resolvedMods: ReturnType<typeof resolveModifiers>['resolved'] | undefined
  if (params.modifierNames && params.modifierNames.length > 0) {
    const { resolved, unknown } = resolveModifiers(params.modifierNames)
    if (unknown.length > 0) {
      void safeSend(msg.channelId, `Unknown modifier${unknown.length > 1 ? 's' : ''}: ${unknown.map(p => `+${p}`).join(', ')}`)
      return
    }
    resolvedMods = resolved
  }

  void gateway.react(msg.channelId, msg.id, proto.emoji).catch(() => {})

  try {
    await startProtocolRun(proto, threadId, sessionId, {
      rounds,
      topic: params.topic,
      model: params.model,
      modifiers: resolvedMods,
      strike: params.strike ?? false,
      ...(params.engine && { engine: params.engine }),
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void safeSend(msg.channelId, `${protoName} failed to start: ${errMsg}`)
  }
}

export async function handleCancelProtocolIntercept(msg: InboundMessage, expectedProtocol?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run) {
    void safeSend(msg.channelId, `No ${expectedProtocol ?? 'protocol'} in progress in this thread.`)
    return
  }

  if (expectedProtocol && run.protocol.name !== expectedProtocol) {
    void safeSend(msg.channelId, `A ${run.protocol.name} is running, not a ${expectedProtocol}.`)
    return
  }

  try {
    await cancelRun(run, 'cancelled by user')
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void safeSend(msg.channelId, `Cancel failed: ${errMsg}`)
  }
}
