import { existsSync } from 'fs'
import { safeSend } from '../../infra/util.js'
import { tmuxHasSession } from '../../infra/tmux.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { markDead, registry } from '../../sessions/registry.js'
import { notifyParentOfEnd } from '../parent-notice.js'
import type { SessionWorktree, SpawnOpts, SpawnResult } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import type { SessionLabel } from '../../shared/constants.js'
import { refreshSessionVisual } from '../../sessions/anchor-state.js'
import { classifyResumeFailure } from '../../sessions/resume-health.js'
import { killSession } from './kill.js'
import { doSpawnSession } from './spawn.js'

// ---------------------------------------------------------------------------
// Recovery primitives — shared by resume/respawn commands and recover cascade
// ---------------------------------------------------------------------------

export const HEALTH_TIMEOUT_MS = 30_000

// Injected into every recovered session (resume notification + respawn/fork prompt).
export const RECOVERY_REVERIFY_GUARD =
  'Orient yourself — read your thread history, check the state of any work in progress (git status, gh pr view, etc.), and continue where the previous session left off.'

export function waitForBridge(sessionId: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (transport.has(sessionId)) { resolve(true); return }
    const interval = setInterval(() => {
      if (transport.has(sessionId)) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(true)
      }
    }, 1_000)
    const timer = setTimeout(() => {
      clearInterval(interval)
      resolve(false)
    }, timeoutMs)
  })
}

export async function tryResume(dead: {
  reuseName?: string
  /** A specialist's name, claimed rather than picked. */
  name?: string
  /** The specialist it acts for (its id): carried so the resumed session is restricted as it was. */
  specialist?: string
  topic: string
  threadId: string
  claudeSessionId?: string
  threadUrl?: string
  model?: string
  label?: SessionLabel
  worktree?: SessionWorktree
  // Set only when the worktree is on disk (reviveThread's resolveWorktree checks, and reattaches a missing one), so
  // adopting the branch is safe.
  preserveWorktree?: boolean
  /** What the resumed session keeps off the one it continues, whose record may already be gone (an orphan torn down). */
  carryOver?: SpawnOpts['carryOver']
}): Promise<(SpawnResult & { bridgeOrphan?: boolean }) | null> {
  if (!dead.claudeSessionId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      reuseName: dead.reuseName,
      ...(dead.name && { name: dead.name }),
      ...(dead.specialist && { specialist: dead.specialist }),
      resumeFrom: dead.claudeSessionId,
      model: dead.model,
      label: dead.label,
      preserveWorktree: dead.preserveWorktree,
      reuseWorktree: dead.preserveWorktree ? dead.worktree : undefined,
      ...(dead.carryOver && { carryOver: dead.carryOver }),
    })

    // Queue the recovery notification before checking bridge health — sendOrQueue
    // delivers immediately if connected, queues for later if not. The orphan path
    // needs it most: when the bridge eventually connects, the session learns it
    // was recovered.
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: `[system] You were recovered automatically after a system restart with full conversation context. ${RECOVERY_REVERIFY_GUARD}`,
      meta: { chat_id: dead.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    const ok = await waitForBridge(result.sessionId, HEALTH_TIMEOUT_MS)
    if (!ok) {
      const info = registry.get(result.sessionId)
      if (!info) return null

      const verdict = classifyResumeFailure({
        tmuxAlive: tmuxHasSession(info.tmuxName),
        hasExitMarker: !!(info.exitFilePath && existsSync(info.exitFilePath)),
        hasExitFilePath: !!info.exitFilePath,
      })

      if (verdict === 'kill') {
        if (!info.exitFilePath) process.stderr.write(`daemon: resume ${info.tmuxName}: exit file path not configured (pipe-pane failed at spawn) — cannot distinguish orphan from dead, defaulting to kill\n`)
        // Preserve the reused worktree on failure so the caller's fork/respawn
        // fallback tiers can still adopt it (they pass the same descriptor
        // explicitly, since this kill deletes the record). Watches unwatch normally —
        // keeping them here would only orphan them on the now-deleted record.
        await killSession(info, 'resume health check failed', { ended: 'killed by hydra', skipWorktreeDestroy: true, keepWatches: true }).catch(() => {})
        return null
      }

      // Orphan: Claude is running with restored context but the bridge hasn't
      // connected. Preserve the session — killing it discards recovered context,
      // and returning null would cascade to a tier that spawns a duplicate.
      // The periodic orphan detector (app/session-health.ts) will monitor it from here.
      process.stderr.write(`daemon: resume ${info.tmuxName}: bridge timeout but tmux alive — preserving as orphan${info.channelNote ? ` (${info.channelNote})` : ''}\n`)

      // One-shot recheck: the periodic detector runs every 5 minutes, so a
      // session that dies right after this check could go undetected for a full
      // cycle. This closes the gap by re-evaluating 30s later.
      const recheckSessionId = result.sessionId
      setTimeout(() => {
        const s = registry.get(recheckSessionId)
        if (!s || s.deadAt) return
        if (occupancy(s) === 'dead') {
          process.stderr.write(`daemon: resume recheck: ${s.tmuxName} died after orphan classification — marking dead\n`)
          if (markDead(s)) notifyParentOfEnd(s, 'died from crash', 'died after orphan classification')
          void safeSend(s.threadId, `💀 **${s.tmuxName}** died. Use \`resume\` to restore context or \`respawn\` for a fresh start.`)
          refreshSessionVisual(s.threadId, { state: 'crashed' })
        }
      }, 30_000)

      return { ...result, bridgeOrphan: true }
    }
    return result
  } catch (err) {
    process.stderr.write(`daemon: tryResume: doSpawnSession failed for ${dead.threadId}: ${err}\n`)
    return null
  }
}

export async function tryRespawn(
  threadId: string,
  topic: string,
  resurrectFrom?: string,
  model?: string,
  extraOpts?: Partial<SpawnOpts>,
): Promise<SpawnResult | null> {
  return doSpawnSession(topic, undefined, undefined, {
    ...extraOpts,
    existingThreadId: threadId,
    resurrectFrom,
    // Respawn continuity: keep the dead session's model if we have one,
    // else fall back to the template's model (extraOpts), else the default.
    model: model ?? extraOpts?.model,
  })
}
