import { gateway } from '../../infra/config.js'
import { formatSpawnLine, safeSend } from '../../infra/util.js'
import { tmuxHasSession, tmuxSync, tmuxTimedOut } from '../../infra/tmux.js'
import { removeLaunchFiles } from '../../infra/launch-files.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { nameHeldByAnother } from '../../sessions/occupancy.js'
import { markDead, registry, threadRegistry } from '../../sessions/registry.js'
import type { SessionInfo } from '../../sessions/registry.js'
import { notifyParentOfEnd, type SessionEnd } from '../parent-notice.js'
import { transport } from '../../sessions/bridge-transport.js'
import { clearPhaseBudget } from '../../sessions/phase-budget.js'
import { clearIdleLimit } from '../../sessions/idle-limit.js'
import { emojiOf, refreshSessionVisual } from '../../sessions/anchor-state.js'
import { unwatchBySession } from '../../connectors/github/pr-watch.js'
import { emit } from '../../infra/event-bus.js'
import { clearInterceptsForSession } from '../pane-probe.js'
import { cleanScratchWorktrees, destroyWorktree, sessionScratchpads } from '../../infra/worktree-manager.js'
import { runKillHook } from './hooks.js'

// ---------------------------------------------------------------------------
// Kill guard
// ---------------------------------------------------------------------------

export const killsInProgress = new Set<string>()

/** `deliberate`: the operator or a parent ended it (a kill), as opposed to a crash, a handoff, a respawn or a resumable idle end: what ends on purpose takes its watches and subscriptions with it. */
export function emitSessionDeath(info: SessionInfo, deliberate = false): void {
  emit('session:death', {
    deliberate,
    sessionId: info.sessionId,
    threadId: info.threadId,
    wasOwner: info.sessionType !== 'thread_guest',
    tmuxName: info.tmuxName,
  })
}

/**
 * The one step that replaces a session whose kill deleted its record (a handoff, a revive): run the start, and if it fails
 * (throws, or returns nothing) put the old record back as dead, so `respawn`, `resume` and boot recovery still find its worktree,
 * launch dir, parent and predecessor. Not when another session has claimed the thread meanwhile. The caller holds the thread's lock.
 */
export async function restoreIfNotStarted<T>(old: SessionInfo | undefined, start: () => Promise<T>, what: string): Promise<T> {
  let started: T | undefined
  try {
    started = await start()
    return started
  } finally {
    const holder = old && registry.getByThread(old.threadId)
    const claimed = holder !== undefined && holder !== old?.sessionId && registry.get(holder ?? '') !== undefined
    if (old && (started === undefined || started === null) && registry.get(old.sessionId) === undefined && !claimed) {
      old.deadAt ??= Date.now()
      registry.set(old.sessionId, old)
      registry.setThread(old.threadId, old.sessionId)
      // Its kill is over: a later kill of the restored record (a `respawn` replacing it) must run, not wait out the deferred kill's guard.
      killsInProgress.delete(old.sessionId)
      registry.persist()
      process.stderr.write(`daemon: ${what} ${old.tmuxName}: the new session did not start — restored the old record\n`)
    }
  }
}



/** Claude session ids whose scratchpads a kill of info cleans: its own, plus a thread owner's handoff chain; never a live session's. */
export function scratchSessionIds(info: SessionInfo, sessions: Iterable<SessionInfo>, history: readonly { claudeSessionId?: string }[]): string[] {
  const ids = new Set<string>()
  if (info.claudeSessionId) ids.add(info.claudeSessionId)
  if (info.sessionType !== 'thread_guest') for (const h of history) if (h.claudeSessionId) ids.add(h.claudeSessionId)
  for (const s of sessions) if (s !== info && occupancy(s) !== 'dead' && s.claudeSessionId) ids.delete(s.claudeSessionId)
  return [...ids]
}

/** Splits scratchSessionIds' output so a force-cleanup opt-in never reaches a predecessor's
 * handoff history — only the id that is genuinely the killed session's own. */
export function splitOwnFromHistory(allIds: readonly string[], ownId: string | undefined): { own: string[]; history: string[] } {
  const own = ownId && allIds.includes(ownId) ? [ownId] : []
  const history = allIds.filter(id => id !== ownId)
  return { own, history }
}

// skipWorktreeDestroy: the conversation continues elsewhere (handoff, reattach) — keep the
// Hydra worktree and scratchpads. keepScratch: only the scratchpads (a resume or fork of
// this conversation still names their paths, and a resume reuses the scratchpad itself).
// keepRecord: end it the way a crash leaves it, so `resume` in the thread continues it in full:
// the record stays, stamped dead, with its worktree, scratchpads, PR watches and launch
// settings, and is left out of automatic boot recovery. ended: the notice to the parent says how it ended: a
// person or agent's kill ('killed', 'killed & destroyed' when the thread goes too), hydra's own doing on purpose
// (a budget, a replaced spawn, a protocol closing: 'killed by hydra', the reason is its cause), a crash; 'finished' for a session that ended itself; 'handed off' when a successor took its thread (the reason would only repeat it);
// left out, no one has classified the end and the notice says 'died'. keepWatches: the thread goes on (a handoff,
// a replacement, a revive's teardown), so its PR watches do too; any other kill ends them.
/** Deferred tmux kill delay after killSession. Test seam. */
export const killTiming = { deferredKillMs: 3_000 }

export async function killSession(info: SessionInfo, reason: string, opts?: { skipWorktreeDestroy?: boolean; keepScratch?: boolean; keepRecord?: boolean; keepWatches?: boolean; ended?: SessionEnd }): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  // A successor holding this record's name owns what runs under it, and what it carried over: stop and destroy nothing.
  const replaced = nameHeldByAnother(info)
  // A watch delivers to the thread, not this session. A deliberate end ends it first, before any await, so no poll
  // in flight can revive the thread; a guest, or a record a successor replaced, speaks for no thread's watches.
  const deliberate = !opts?.keepRecord && !opts?.keepWatches && !replaced && info.sessionType !== 'thread_guest'
  if (deliberate) {
    const removedWatches = unwatchBySession(info)
    if (removedWatches > 0) process.stderr.write(`daemon: removed ${removedWatches} PR watch(es) for session ${info.sessionId}\n`)
  }

  try {
    // Join members and ephemeral sessions don't own a real thread
    if (info.sessionType !== 'thread_guest' && !info.ephemeral) {
      await safeSend(info.threadId, `_${reason}_`)

      refreshSessionVisual(info.threadId, { state: 'killed' })
    }

    // Notify the parent session when a live child ends, gated on authority (parentId) rather than originFrom (#736).
    // Skip records already stamped dead (e.g. a crashed or keepRecord child later replaced by resume/respawn): the parent already heard.
    if (!info.deadAt) notifyParentOfEnd(info, opts?.ended, reason)

    // Edit spawn announce to show completion
    if (info.spawnAnnounceId && info.sessionType === 'thread_guest') {
      const elapsed = Math.round((Date.now() - info.createdAt) / 60_000)
      const spawnLine = formatSpawnLine({
        roleLabel: undefined,
        emoji: emojiOf(info),
        name: info.tmuxName,
        model: info.sessionMetadata?.model ?? 'unknown',
        trigger: info.originType ?? 'spawn',
        initiator: info.initiator,
      })
      const completionNote = `\n_↳ guest agent in thread_\n_↳ ${reason} after ${elapsed}m_`
      void gateway.edit(info.threadId, info.spawnAnnounceId, spawnLine + completionNote).catch(() => {})
    }

    const tmuxName = info.tmuxName
    // Stop learns a missing native id first where the provider can (Claude: pane discovery).
    const stopped = replaced ? undefined : await info.adapter.stop(info)
    if (stopped?.status === 'uncertain') process.stderr.write(`daemon: stop ${tmuxName}: uncertain (${stopped.reason}); the deferred kill will try again\n`)

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)
    clearIdleLimit(info.sessionId)
    if (!replaced) clearInterceptsForSession(info.tmuxName)

    const keepWorktree = replaced || opts?.skipWorktreeDestroy || opts?.keepRecord
    const wt = info.worktree
    if (wt && !keepWorktree) {
      // Async worktree cleanup — fire-and-forget (killSession is sync, cleanup is best-effort).
      // Work at risk (uncommitted, mid-operation, not on a remote) is kept, never destroyed —
      // unless info.forceWorktreeCleanup (see SpawnOpts).
      void (async () => {
        const kept = await destroyWorktree(wt.repo, wt.path, wt.branch, info.forceWorktreeCleanup)
        if (kept) void safeSend(info.threadId, `⚠️ Worktree \`${wt.path}\` (branch \`${wt.branch}\`) kept: ${kept}. Remove it once the work is safe.`)
      })().catch(err => {
        process.stderr.write(`daemon: worktree cleanup failed for ${info.tmuxName}: ${err}\n`)
      })
    }

    // Worktrees the session — and, for a thread owner, its handoff predecessors, whose
    // worktrees a handoff deliberately kept for it — made under their scratchpads: same rule.
    // forceWorktreeCleanup is this session's own opt-in: it never applies to a predecessor's
    // history, whose work a handoff may have deliberately kept.
    const allScratchIds = !keepWorktree && !opts?.keepScratch ? scratchSessionIds(info, registry.values(), threadRegistry.get(info.threadId)?.sessionHistory ?? []) : []
    const { own: ownScratchIds, history: historyScratchIds } = splitOwnFromHistory(allScratchIds, info.claudeSessionId)
    if (allScratchIds.length) {
      void Promise.all([
        cleanScratchWorktrees(ownScratchIds.flatMap(id => sessionScratchpads(id)), info.forceWorktreeCleanup),
        cleanScratchWorktrees(historyScratchIds.flatMap(id => sessionScratchpads(id))),
      ]).then(([own, history]) => {
        const removed = [...own.removed, ...history.removed]
        const kept = [...own.kept, ...history.kept]
        if (removed.length) process.stderr.write(`daemon: ${info.tmuxName}: removed ${removed.length} scratchpad worktree(s)\n`)
        if (kept.length) {
          process.stderr.write(`daemon: ${info.tmuxName}: kept scratchpad worktree(s): ${kept.map(k => `${k.path} (${k.reason})`).join(', ')}\n`)
          void safeSend(info.threadId, `⚠️ Kept ${kept.length} worktree(s) with work not on a remote:\n${kept.map(k => `- \`${k.path}\` — ${k.reason}`).join('\n')}`)
        }
      }).catch(err => process.stderr.write(`daemon: scratchpad worktree cleanup failed for ${info.tmuxName}: ${err}\n`))
    }

    // Update thread metadata before deleting session
    if (opts?.keepRecord) {
      info.suppressAutoRecover = true
      markDead(info)
    } else {
      if (info.sessionType !== 'thread_guest') {
        threadRegistry.closeHistoryEntry(info.threadId, info)
        // A thread another live session is bound to stays bound to it (a refused start must not unbind its predecessor's successor).
        if (registry.getByThread(info.threadId) === info.sessionId) registry.deleteThread(info.threadId)
      }
      registry.delete(info.sessionId)
    }
    registry.persist()

    if (info.sessionType === 'thread_guest') {
      registry.removeMember(info.threadId, info.sessionId)
    }

    removeLaunchFiles(info)
    emitSessionDeath(info, deliberate)
    runKillHook(info, reason)

    setTimeout(() => {
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s !== info && s.tmuxName === tmuxName)
        if (!currentOwner && tmuxHasSession(tmuxName)) {
          tmuxSync(['kill-session', '-t', tmuxName])
          process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
        }
      } catch (err) {
        process.stderr.write(`daemon: deferred kill of "${tmuxName}" ${tmuxTimedOut(err) ? 'timed out: tmux not responding' : `failed: ${err instanceof Error ? err.message : err}`}; the session may linger\n`)
      }
      killsInProgress.delete(info.sessionId)
    }, killTiming.deferredKillMs)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

