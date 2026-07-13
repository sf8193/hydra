import { join } from 'path'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { loadLensesFromDir, type LensDef } from '../lens-loader.js'
import type { InboundMessage } from '../../gateway.js'

const LENSES_DIR = join(import.meta.dir, '..', '..', 'protocols', 'lenses')

let reviewProto: Awaited<ReturnType<typeof import('../../protocols/review.js')>>['default'] | null = null
let lensCache: Map<string, LensDef> | null = null

async function getReviewProto() {
  if (!reviewProto) reviewProto = (await import('../../protocols/review.js')).default
  return reviewProto
}

async function getLenses(): Promise<Map<string, LensDef>> {
  if (!lensCache) lensCache = await loadLensesFromDir(LENSES_DIR)
  return lensCache
}

export async function handleReviewV2Intercept(msg: InboundMessage, rounds: number, topic?: string, model?: string, postPasses?: string[]): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '⚔️').catch(() => {})

  const resolvedThreadId = registry.resolveThreadId(msg)
  const sessionId = registry.getByThread(resolvedThreadId)

  if (!sessionId) {
    await gateway.send(msg.channelId, `No session owns this thread. Use \`review_v2\` in a session thread.`, { replyTo: msg.id })
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

  // Resolve lenses if requested
  let resolvedLenses: LensDef[] | undefined
  if (postPasses && postPasses.length > 0) {
    const allLenses = await getLenses()
    const unknown = postPasses.filter(p => !allLenses.has(p))
    if (unknown.length > 0) {
      await gateway.send(msg.channelId, `Unknown lens${unknown.length > 1 ? 'es' : ''}: ${unknown.map(p => `\`+${p}\``).join(', ')}`, { replyTo: msg.id })
      return
    }
    resolvedLenses = postPasses.map(p => allLenses.get(p)!)
  }

  try {
    const proto = await getReviewProto()
    await startProtocolRun(proto, threadId, sessionId, {
      rounds: clampedRounds, topic, model,
      lenses: resolvedLenses,
      strike: true,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Review v2 failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}

export async function handleCancelReviewV2Intercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🛑').catch(() => {})

  const threadId = registry.resolveThreadId(msg)
  const run = getRunByThread(threadId)

  if (!run) {
    await gateway.send(msg.channelId, `No review_v2 in progress in this thread.`, { replyTo: msg.id })
    return
  }

  await cancelRun(run, 'cancelled by user')
}
