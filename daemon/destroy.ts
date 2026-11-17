// Destroy — permanently delete a session's thread + anchor message (Discord only).
//
// The one implementation behind every way of destroying: the chat commands
// `destroy` and `kill +d`, the `kill_session` tool and `hydra kill --destroy`.
// Each caller decides *whether it may* (chat: the operator allowlist; tool: the
// spawner; CLI: the local socket) and how to report; this decides *whether it
// can* — and does it.

import { gateway } from './config.js'
import { isParentOf, registry, threadRegistry, type SessionInfo } from './sessions.js'
import { isProtocolParticipant } from './protocol-registry.js'
import { emitSessionDeath, killSession } from './session-lifecycle.js'
import { debouncedRefreshListDisplay } from './commands/status.js'
import { isThreadOccupied } from './protocol-registry.js'
import { unwatchBySession } from '../connectors/github/pr-watch.js'
import { occupancy } from './session-reachability.js'

export type DestroyOutcome =
  | { ok: true }
  | { ok: false; kind: 'unsupported' | 'occupied' | 'alive' | 'delete-failed'; text: string; parentChannelId?: string }

/**
 * Delete `threadId` and its anchor, then forget its session record.
 * `by` is who asked, for the log. `onProceed` runs once every guard has passed,
 * just before the deletion (the chat reaction goes here, while its message still exists).
 */
export function destroyRefusal(threadId: string): Extract<DestroyOutcome, { ok: false }> | undefined {
  if (!gateway.deleteThread) return { ok: false, kind: 'unsupported', text: '`destroy` is only available on Discord.' }
  const occupied = isThreadOccupied(threadId)
  if (occupied) return { ok: false, kind: 'occupied', text: `A **${occupied}** is in progress. Cancel or wait for completion.` }
  return undefined
}

export async function destroyThread(threadId: string, by: string, onProceed?: () => void): Promise<DestroyOutcome> {
  const refused = destroyRefusal(threadId)
  if (refused) return refused

  const sessionId = registry.getByThread(threadId)
  const info = sessionId ? registry.get(sessionId) : undefined

  if (info && occupancy(info) !== 'dead') {
    return { ok: false, kind: 'alive', text: `Session **${info.tmuxName}** is still alive. Kill it first with \`kill\`.` }
  }

  onProceed?.()

  const thread = threadRegistry.get(threadId)
  let parentChannelId = thread?.parentChannelId ?? info?.anchorChannelId
  let anchorMessageId = thread?.anchorMessageId ?? info?.anchorMessageId

  if (!parentChannelId || !anchorMessageId) {
    try {
      const channelInfo = await gateway.fetchChannel(threadId)
      if (channelInfo.isThread && channelInfo.parentId) {
        parentChannelId = parentChannelId ?? channelInfo.parentId
      }
      if (!anchorMessageId) {
        const starter = await gateway.getThreadStarterInfo(threadId)
        if (starter) anchorMessageId = starter.starterId
      }
    } catch {
      process.stderr.write(`daemon: destroy: failed to fetch thread anchor info for ${threadId}\n`)
    }
  }

  // Delete thread BEFORE registry cleanup — if the API call fails, the registry
  // stays intact so the thread isn't orphaned from hydra's perspective.
  try {
    await gateway.deleteThread!(threadId) // destroyRefusal checked it
    // No creator check any more, so the log is the record of who did it.
    process.stderr.write(`daemon: destroy: deleted thread ${threadId} (by ${by})\n`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: destroy: thread deletion failed: ${errMsg}\n`)
    return { ok: false, kind: 'delete-failed', text: `Thread deletion failed: ${errMsg}`, parentChannelId }
  }

  // Clean up registry only after successful thread deletion
  if (info && sessionId) {
    registry.delete(sessionId)
    registry.deleteThread(threadId)
    registry.persist()
    unwatchBySession(info)
    emitSessionDeath(info, true)
  }
  threadRegistry.delete(threadId)

  if (parentChannelId && anchorMessageId) {
    try {
      await gateway.delete(parentChannelId, anchorMessageId)
      process.stderr.write(`daemon: destroy: deleted anchor message ${anchorMessageId} in ${parentChannelId}\n`)
    } catch (err) {
      process.stderr.write(`daemon: destroy: anchor deletion failed (thread already gone): ${err}\n`)
    }
  } else {
    process.stderr.write(`daemon: destroy: skipped anchor deletion (parentChannelId=${parentChannelId ?? 'unknown'}, anchorMessageId=${anchorMessageId ?? 'unknown'})\n`)
  }

  debouncedRefreshListDisplay()
  return { ok: true }
}

/**
 * Kill a session, then destroy its thread: what the tool and the CLI mean by "destroy".
 * A refusal the thread already shows (not Discord, a protocol in flight) is returned
 * before the kill, so nothing happens. After the kill, a declined destroy leaves the
 * kill standing, as the chat's `kill +d` does.
 */
export async function killThenDestroy(info: SessionInfo, killReason: string, by: string): Promise<{ killed: boolean; out: DestroyOutcome }> {
  const threadId = info.threadId
  const refused = destroyRefusal(threadId)
  if (refused) return { killed: false, out: refused }
  await killSession(info, killReason)
  return { killed: true, out: await destroyThread(threadId, by) }
}

/** What a caller reads when it asked to destroy and the thread stayed. */
export function destroyDeclinedText(name: string, r: { killed: boolean; out: DestroyOutcome }): string {
  if (r.out.ok) return ''
  return r.killed
    ? `killed ${name}, but its thread was NOT deleted: ${r.out.text} The session is dead and no longer listed; the thread is still there, and the operator can delete it with \`destroy\` in that thread.`
    : `${name} was NOT killed and its thread was NOT deleted: ${r.out.text}`
}

/**
 * Why a session may not kill (or destroy) `info`, or undefined if it may. Applies to a
 * session acting on its own behalf: the `kill_session` tool, and `hydra kill --destroy`
 * run from inside a session. Main and the operator's shell never come through here.
 *
 * Authority is the spawner's (isParentOf). A destroy also deletes a thread and its anchor
 * message, so it needs a thread hydra made for the spawn (not one spawned into, nor one
 * anchored on someone's message) that no other session answers in (the caller, its parent,
 * a sibling). Every refusal precedes any kill.
 */
export function callerRefusal(caller: SessionInfo | undefined, info: SessionInfo, verb: 'kill' | 'destroy'): string | undefined {
  if (!caller || !isParentOf(caller, info)) return `cannot ${verb} ${info.tmuxName} — you can only ${verb} sessions you spawned`
  // A protocol-managed participant (e.g. the review Critic) belongs to the protocol, not to whoever happened to spawn it.
  if (isProtocolParticipant(info.sessionId)) return `cannot ${verb} ${info.tmuxName} — it is a protocol participant`
  if (verb === 'kill') return undefined
  if (!threadRegistry.get(info.threadId)?.hydraMade) {
    return `cannot destroy ${info.tmuxName} — its thread was not created for it by hydra (it was spawned into an existing thread or message, or predates this check); nothing was killed. Kill it without destroy; the operator can delete the thread.`
  }
  const sharer = [...registry.values()].find(s => s.sessionId !== info.sessionId && s.threadId === info.threadId)
  if (sharer) return `cannot destroy ${info.tmuxName} — its thread is also ${sharer.sessionId === caller.sessionId ? 'yours' : `${sharer.tmuxName}'s`}; nothing was killed. Kill it without destroy.`
  return undefined
}
