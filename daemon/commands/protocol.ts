import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { resolveModifiers } from '../modifiers.js'
import type { Protocol } from '../protocol-dsl.js'
import type { InboundMessage } from '../../gateway.js'

const VALID_NAME = /^[a-z][a-z0-9-]*$/

const protocols = new Map<string, Protocol>()

export async function getProtocol(name: string): Promise<Protocol> {
  let proto = protocols.get(name)
  if (proto) return proto
  if (!VALID_NAME.test(name)) throw new Error(`invalid protocol name "${name}"`)
  const mod = await import(`../../protocols/${name}.js`)
  if (!mod.default?.name) throw new Error(`protocol "${name}" has no default export`)
  proto = mod.default as Protocol
  protocols.set(name, proto)
  return proto
}

export async function handleProtocolIntercept(
  protoName: string,
  msg: InboundMessage,
  params: { rounds?: number; topic?: string; model?: string; modifierNames?: string[]; strike?: boolean },
): Promise<void> {
  try {
    const proto = await getProtocol(protoName)
    void gateway.react(msg.channelId, msg.id, proto.emoji).catch(() => {})

    const resolvedThreadId = registry.resolveThreadId(msg)
    const sessionId = registry.getByThread(resolvedThreadId)

    if (!sessionId) {
      await gateway.send(msg.channelId, `No session owns this thread. Use \`${protoName}\` in a session thread.`, { replyTo: msg.id })
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

    const rounds = Math.max(1, Math.min(params.rounds ?? 3, 5))

    let resolvedMods: ReturnType<typeof resolveModifiers>['resolved'] | undefined
    if (params.modifierNames && params.modifierNames.length > 0) {
      const { resolved, unknown } = resolveModifiers(params.modifierNames)
      if (unknown.length > 0) {
        await gateway.send(msg.channelId, `Unknown modifier${unknown.length > 1 ? 's' : ''}: ${unknown.map(p => `+${p}`).join(', ')}`, { replyTo: msg.id })
        return
      }
      resolvedMods = resolved
    }

    await startProtocolRun(proto, threadId, sessionId, {
      rounds,
      topic: params.topic,
      task: params.topic,
      model: params.model,
      modifiers: resolvedMods,
      strike: params.strike ?? false,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `${protoName} failed to start: ${errMsg}`, { replyTo: msg.id }).catch(() => {})
  }
}

export async function handleCancelProtocolIntercept(msg: InboundMessage, expectedProtocol?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run) {
    await gateway.send(msg.channelId, `No ${expectedProtocol ?? 'protocol'} in progress in this thread.`, { replyTo: msg.id })
    return
  }

  if (expectedProtocol && run.protocol.name !== expectedProtocol) {
    await gateway.send(msg.channelId, `A ${run.protocol.name} is running, not a ${expectedProtocol}.`, { replyTo: msg.id })
    return
  }

  await cancelRun(run, 'cancelled by user')
}
