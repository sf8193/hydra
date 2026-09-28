import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { resolveModifiers, partitionFlagModifiers, listLensNames } from '../modifiers.js'
import type { InboundMessage } from '../../gateway.js'
import { normalizeReviewRounds } from '../../shared/constants.js'
import type { ProviderId } from '../engines/engine-adapter.js'

let reviewProto: typeof import('../../protocols/review.js')['default'] | null = null

async function getReviewProto() {
  if (!reviewProto) reviewProto = (await import('../../protocols/review.js')).default
  return reviewProto
}

export async function handleReviewIntercept(msg: InboundMessage, rounds: number, topic?: string, model?: string, modifierNames?: string[], engine?: ProviderId): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '⚔️').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`review\` in a session thread.`, { replyTo: msg.id })
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

  const clampedRounds = normalizeReviewRounds(rounds)

  let resolvedMods: ReturnType<typeof resolveModifiers>['resolved'] | undefined
  // Flags (`+subagent`, `+no-fallback`) become run params rather than modifiers:
  // they steer the run, they don't add a lens. See partitionFlagModifiers.
  let flagParams: Record<string, true> = {}
  if (modifierNames && modifierNames.length > 0) {
    const { resolved, unknown } = resolveModifiers(modifierNames)
    if (unknown.length > 0) {
      await gateway.send(msg.channelId, `Unknown modifier${unknown.length > 1 ? 's' : ''}: ${unknown.map(p => `\`+${p}\``).join(', ')}. Lenses are automatic. Force: ${listLensNames().map(n => `\`+${n}\``).join(' ')}. Opt out: \`+no-ponytail\` or \`+no-lenses\`.`, { replyTo: msg.id })
      return
    }
    const { params, rest } = partitionFlagModifiers(resolved)
    flagParams = params
    resolvedMods = rest.length > 0 ? rest : undefined
  }

  // `+subagent` means "no adversary"; `+no-fallback` means "an adversary or
  // nothing". Together they ask for opposite things, and the run would honour
  // the first and drop the second without saying so. Whichever the caller meant,
  // they should find out now rather than from the summary.
  if (flagParams.directSubagent && flagParams.noFallback) {
    await gateway.send(msg.channelId, `\`+subagent\` and \`+no-fallback\` contradict each other — \`+subagent\` skips the critic, so there is no death for \`+no-fallback\` to refuse. Pick one.`, { replyTo: msg.id })
    return
  }

  const forcedLensNames = (resolvedMods ?? []).map(mod => mod.name)
  if (flagParams.noAutoLenses && forcedLensNames.length > 0) {
    await gateway.send(msg.channelId, `\`+no-lenses\` contradicts explicitly requested lenses (${forcedLensNames.map(name => `\`+${name}\``).join(' ')}). Remove the positive lenses or use \`+no-ponytail\` to disable only the default Ponytail helper.`, { replyTo: msg.id })
    return
  }
  if (flagParams.noPonytail && forcedLensNames.includes('ponytail')) {
    await gateway.send(msg.channelId, `\`+no-ponytail\` contradicts \`+ponytail\`. Pick one.`, { replyTo: msg.id })
    return
  }

  try {
    const proto = await getReviewProto()
    await startProtocolRun(proto, threadId, sessionId, {
      rounds: clampedRounds, topic, model, engine,
      modifiers: resolvedMods,
      strike: true,
      autoReviewLenses: true,
      ...flagParams,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Review failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelReviewIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run || run.protocol.name !== 'review') {
    await gateway.send(msg.channelId, `No review in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelRun(run, 'cancelled by user')
}
