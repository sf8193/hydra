import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { startProtocolRun, getRunByThread, cancelRun } from '../protocol-runner.js'
import { isThreadOccupied } from '../protocol-registry.js'
import type { InboundMessage } from '../../gateway.js'

let selectProto: Awaited<ReturnType<typeof import('../../protocols/delegated-build-select.js')>>['selectDelegatedBuildProtocol'] | null = null

async function getProto(quick = false) {
  if (!selectProto) selectProto = (await import('../../protocols/delegated-build-select.js')).selectDelegatedBuildProtocol
  return selectProto(quick)
}

export async function handleDelegatedBuildIntercept(msg: InboundMessage, rounds: number, task?: string, model?: string, engine?: 'claude' | 'codex', opts?: { skipClarify?: boolean }): Promise<void> {
  void gateway.react(msg.channelId, msg.id, opts?.skipClarify ? '⚡' : '📋').catch(() => {})

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

  // Quick mode keeps the legacy cap. Rigorous delegate budgets both planned
  // steps and review-driven fix cycles, so it needs the same practical ceiling
  // as adversarial review.
  const clampedRounds = Math.max(1, Math.min(rounds, opts?.skipClarify ? 5 : 20))

  try {
    const p = await getProto(!!opts?.skipClarify)
    await startProtocolRun(p, threadId, sessionId, { rounds: clampedRounds, task, model, engine, strike: true, skipClarify: opts?.skipClarify })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await gateway.send(msg.channelId, `Delegated build failed to start: ${errMsg}`, { replyTo: msg.id })
  }
}
