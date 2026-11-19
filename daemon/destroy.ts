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
import { unwatchThread } from '../connectors/github/pr-watch.js'
import { emit } from './event-bus.js'
import { currentHydraConfig } from './hydra-config.js'
import { listSpecialists } from '../specialists/specialists.js'
import { ownsLineage } from './lineage.js'
import { occupancy } from './session-reachability.js'
import { removeLaunchFiles } from './launch-files.js'

export type DestroyOutcome =
  | { ok: true }
  | { ok: false; kind: 'unsupported' | 'protocol-running' | 'alive' | 'delete-failed' | 'disabled' | 'not-a-thread' | 'specialist-thread'; text: string; parentChannelId?: string }

/**
 * Delete `threadId` and its anchor, then forget its session record.
 * `by` is who asked, for the log. `onProceed` runs once every guard has passed,
 * just before the deletion (the chat reaction goes here, while its message still exists).
 */
export function destroyRefusal(threadId: string): Extract<DestroyOutcome, { ok: false }> | undefined {
  if (!gateway.deleteThread) return { ok: false, kind: 'unsupported', text: '`destroy` is only available on Discord.' }
  const running = isThreadOccupied(threadId)
  if (running) return { ok: false, kind: 'protocol-running', text: `A **${running}** is in progress. Cancel or wait for completion.` }
  return undefined
}

export async function destroyThread(threadId: string, by: string, onProceed?: () => void, opts?: { keepAnchor?: boolean }): Promise<DestroyOutcome> {
  const refused = destroyRefusal(threadId)
  if (refused) return refused

  const sessionId = registry.getByThread(threadId)
  const info = sessionId ? registry.get(sessionId) : undefined

  if (info && occupancy(info) !== 'dead') {
    return { ok: false, kind: 'alive', text: `Session **${info.tmuxName}** is still alive. Kill it first with \`kill\`, or use \`kill +d\`.` }
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
    removeLaunchFiles(info)
    emitSessionDeath(info, true)
  }
  threadRegistry.delete(threadId)
  // What hangs on the thread goes with it, whether or not a session was in it: its PR watches and its bound conversations.
  unwatchThread(threadId)
  emit('thread:destroyed', { threadId })

  if (opts?.keepAnchor) {
    process.stderr.write(`daemon: destroy: kept the anchor message (hydra did not make this thread)\n`)
  } else if (parentChannelId && anchorMessageId) {
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
 * Delete a thread by its id, whether or not a session ever lived in it or has ended: `hydra kill <name|thread id> --destroy`
 * and main's `kill_session {thread_id, destroy}`, when no session record answers. The one rule is hydra.toml's `[threads] allow_destroy`; off, it refuses and names the key.
 * Who may ask is the caller's to decide (the operator's shell, main). Then three guards, each a thing that must not be
 * deleted from under hydra: a channel or DM (main lives there, never in a thread), a specialist's home thread (hydra
 * refills it), and a thread a live session is in (`destroyThread`: kill it first). The deletion and the clearing of the
 * thread's records are `destroyThread`'s: the same steps `kill +d` runs.
 */
export async function destroyThreadById(threadId: string, by: string): Promise<DestroyOutcome> {
  if (currentHydraConfig().allowThreadDestroy !== true) {
    return { ok: false, kind: 'disabled', text: 'Destroying a thread by id is off. Set `[threads] allow_destroy = true` in hydra.toml to turn it on.' }
  }
  const refused = destroyRefusal(threadId)
  if (refused) return refused
  let isThread = false
  try { isThread = (await gateway.fetchChannel(threadId)).isThread } catch {}
  if (!isThread) return { ok: false, kind: 'not-a-thread', text: `${threadId} is not a thread hydra can see (a channel or DM is never destroyed here: main lives in those).` }
  const owner = listSpecialists().find(([, s]) => s.threadId === threadId)
  if (owner) return { ok: false, kind: 'specialist-thread', text: `${threadId} is specialist **${owner[0]}**'s home thread, which hydra refills.` }
  // The anchor message is deleted only where hydra posted it: in a thread it did not make, it may be a person's own message.
  return destroyThread(threadId, by, undefined, { keepAnchor: threadRegistry.get(threadId)?.hydraMade !== true })
}

/**
 * Why `callerSessionId` may not destroy the thread of a session that has ended, or undefined if it may.
 * The operator's shell and main (no id, or 'main') may. A session may if it owns the ended thread's lineage (ownsLineage: the spawner, or
 * its handoff successor), as it could while the child lived. Like the live destroy, only a thread hydra made for that lineage (madeFor): a
 * session spawned into an existing thread does not make it destroyable.
 * The one rule for `hydra kill --destroy` and the `kill_session` tool; `destroyThreadById` still gates on `[threads] allow_destroy`.
 */
export function endedDestroyRefusal(callerSessionId: string | undefined, threadId: string, name: string): string | undefined {
  if (!callerSessionId || callerSessionId === 'main') return undefined
  if (threadRegistry.madeFor(threadId) && ownsLineage(callerSessionId, threadId)) return undefined
  return `cannot destroy ${name} — its session has ended, and only the session that spawned it (or its handoff successor), the operator's shell or main may destroy its thread. Ask one of them to run \`hydra kill ${threadId} --destroy\`.`
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
  await killSession(info, killReason, { ended: 'killed & destroyed' })
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
  if (!threadRegistry.madeFor(info.threadId, info.sessionId)) {
    return `cannot destroy ${info.tmuxName} — its thread was not created for it by hydra (it was spawned into an existing thread or message, or predates this check); nothing was killed. Kill it without destroy; the operator can delete the thread.`
  }
  const sharer = [...registry.values()].find(s => s.sessionId !== info.sessionId && s.threadId === info.threadId)
  if (sharer) return `cannot destroy ${info.tmuxName} — its thread is also ${sharer.sessionId === caller.sessionId ? 'yours' : `${sharer.tmuxName}'s`}; nothing was killed. Kill it without destroy.`
  return undefined
}
