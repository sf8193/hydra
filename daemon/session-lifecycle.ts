import { randomUUID } from 'crypto'
import { execSync, execFileSync, spawn } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH, STATE_DIR } from './config.js'
import { safeSend, formatSpawnLine, tmuxHasSession, executionAlive } from './util.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionMetadata, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession } from './bridge-tools.js'
import { parseSpawnTopic, resolveSpawnLabel } from './util.js'
import { startPhaseBudget, clearPhaseBudget } from './phase-budget.js'
import { isKnownModel, resolveModelAlias, spawnModel } from '../shared/constants.js'
import type { SessionType, SessionLabel } from '../shared/constants.js'
import { resolveEngine } from './engines/instances.js'
import type { EngineAdapter } from './engines/engine-adapter.js'
import { resumeHomeOwner } from './engines/codex-engine-adapter.js'
import { buildSpawnPrompt, buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from './prompts/session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { getWatchesBySession, restoreWatches, unwatchBySession } from './pr-watch.js'
import { loadAccess } from './access.js'
import { emit } from './event-bus.js'
import { clearInterceptsForSession } from './pane-probe.js'
import { classifyResumeFailure } from './resume-health.js'
import { createWorktree, destroyWorktree, cleanScratchWorktrees, sessionScratchpads } from './worktree-manager.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

// ---------------------------------------------------------------------------
// Channel resolution — determines where to create a new thread
// ---------------------------------------------------------------------------

type ChannelProbe = { isThread: boolean; isDM: boolean; parentId: string | null }
type ChannelResolution = {
  targetChannelId: string
  threadId?: string
  parentChannelId?: string
  warning?: string
}

export async function resolveSpawnChannel(
  chatId: string | undefined,
  defaultChannel: string,
  fetchChannel: (id: string) => Promise<ChannelProbe>,
  canThreadInDM: boolean,
): Promise<ChannelResolution> {
  if (!chatId) return { targetChannelId: defaultChannel }
  try {
    const ch = await fetchChannel(chatId)
    if (ch.isThread) {
      const parentChannelId = ch.parentId ?? undefined
      if (parentChannelId) {
        // Return both: threadId so the caller can reuse the thread (respawn in
        // dead thread), and targetChannelId=parent so new thread creation lands
        // in the right channel if the thread can't be reused.
        return { targetChannelId: parentChannelId, threadId: chatId, parentChannelId }
      }
      return {
        targetChannelId: defaultChannel,
        warning: `chatId ${chatId} is a thread with no parentId — structurally unexpected, falling back to default channel`,
      }
    }
    if (ch.isDM && !canThreadInDM) {
      // Intentionally silent — DMs without thread support are expected on Slack
      return { targetChannelId: defaultChannel }
    }
    return { targetChannelId: chatId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      targetChannelId: defaultChannel,
      warning: `fetchChannel(${chatId}) failed: ${msg} — falling back to default channel`,
    }
  }
}

// ---------------------------------------------------------------------------
// Boot-time backfill — resolve anchorChannelId for sessions missing it
// ---------------------------------------------------------------------------

export async function backfillAnchorChannelIds(): Promise<void> {
  const missing = [...registry.values()].filter(s => !s.anchorChannelId && s.threadId)
  if (missing.length === 0) return

  process.stderr.write(`daemon: backfill: ${missing.length} session(s) missing anchorChannelId\n`)
  let filled = 0
  let failed = 0

  for (const info of missing) {
    try {
      const ch = await gateway.fetchChannel(info.threadId)
      if (ch.isThread && ch.parentId) {
        info.anchorChannelId = ch.parentId
        const thread = threadRegistry.get(info.threadId)
        if (thread && !thread.anchorChannelId) thread.anchorChannelId = ch.parentId
        filled++
      }
    } catch (err) {
      process.stderr.write(`daemon: WARNING: backfill anchorChannelId failed for ${info.tmuxName} (thread ${info.threadId}): ${err}\n`)
      failed++
    }
    // Stagger to avoid Discord rate limits during fleet recovery
    if (missing.length > 1) await new Promise(r => setTimeout(r, 200))
  }

  if (filled > 0) {
    registry.persist()
    threadRegistry.persist()
  }
  process.stderr.write(`daemon: backfill: ${filled} filled, ${failed} failed, ${missing.length - filled - failed} skipped\n`)
}

// Per-session pane logfile — `tmux pipe-pane` captures each spawn's output so a
// crash still leaves it on disk.

const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

// ---------------------------------------------------------------------------
// Spawn env whitelist — explicit construction, not ambient inheritance
// ---------------------------------------------------------------------------
// Each env var the byte carries gets a conscious routing decision here:
//   pass-through: shared between byte and sessions (platform, socket, config)
//   override:     session-specific identity
//   strip:        byte-only (HYDRA_ROLE) — prevented from leaking into sessions

function buildSpawnEnv(sessionId: string, tmuxName: string): string[] {
  return [
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    `unset HYDRA_ROLE`, // prevent spawned session from inheriting byte's HYDRA_ROLE=main
  ]
}

// ---------------------------------------------------------------------------
// Fork CWD resolution — exported for testing
// ---------------------------------------------------------------------------

/**
 * When forking into a worktree, the process must start in the PM's original
 * CWD (spawnCwd) so that `--resume --fork-session` can locate the conversation
 * file at ~/.claude/projects/<cwd>/<sessionId>.jsonl. For all other spawn
 * forms, use effectiveCwd (which may be the worktree path itself).
 */
export function resolveForkSpawnCwd(
  isFork: boolean,
  hasWorktree: boolean,
  spawnCwd: string,
  effectiveCwd: string,
): string {
  return (isFork && hasWorktree) ? spawnCwd : effectiveCwd
}

/**
 * Append worktree location to the prompt for fork+worktree builders.
 * The builder starts from spawnCwd (for --resume CWD compatibility), so it
 * needs an explicit path to cd into. Returns '' for all other spawn forms.
 */
export function buildWorktreePromptAppend(isFork: boolean, worktreePath: string | undefined): string {
  if (isFork && worktreePath) {
    return `\n\nWORKTREE: Your isolated worktree is at ${worktreePath}. cd there before making any code changes.`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Listen state resolution: thread override → channel group → global → false
// ---------------------------------------------------------------------------

/** Tool names recorded in a spawn's sessionMetadata. Codex sessions discover
 *  tools via their own MCP sidecar, not the daemon bridge. */
export function spawnToolNames(adapter: EngineAdapter, spawnType: SessionType): string[] {
  return adapter.channel === 'bridge' ? computeToolsForSession(spawnType, new Set()).map(t => t.name) : []
}

export function resolveListenState(threadId: string, channelId?: string): boolean {
  const thread = threadRegistry.get(threadId)
  return resolveListenStatePure(channelId, loadAccess(), thread?.listenOverride, thread?.parentChannelId, thread?.anchorChannelId)
}

export function resolveListenStatePure(
  channelId: string | undefined,
  access: { groups: Record<string, { defaultListen?: boolean }>; defaultListen?: boolean },
  listenOverride?: boolean,
  parentChannelId?: string,
  anchorChannelId?: string,
): boolean {
  if (listenOverride !== undefined) return listenOverride
  for (const id of [channelId, parentChannelId, anchorChannelId]) {
    if (id) {
      const group = access.groups[id]
      if (group?.defaultListen !== undefined) return group.defaultListen
    }
  }
  return access.defaultListen ?? false
}

// ---------------------------------------------------------------------------
// Kill guard
// ---------------------------------------------------------------------------

export const killsInProgress = new Set<string>()

// ---------------------------------------------------------------------------
// Kill session
// ---------------------------------------------------------------------------

export function emitSessionDeath(info: SessionInfo): void {
  emit('session:death', {
    sessionId: info.sessionId,
    threadId: info.threadId,
    wasOwner: info.sessionType !== 'thread_guest',
    tmuxName: info.tmuxName,
    deadAt: info.deadAt,
    claudeSessionId: info.claudeSessionId,
    engine: info.engine,
    codexThreadId: info.codexThreadId,
    codexHomeName: info.codexHomeName,
  })
}

/** Spawn opts for the successor: same thread/label/worktree and carried deliverables; model+engine from `handoff <model>` if given. */
export function handoffSpawnOpts(info: SessionInfo, artifact: string): SpawnOpts {
  const sel = info.handoffSelection
  const reuseWorktree = info.worktreePath && info.worktreeRepo
    ? { repo: info.worktreeRepo, path: info.worktreePath, branch: info.worktreeBranch ?? `wt/${info.tmuxName}` }
    : undefined
  return {
    existingThreadId: info.threadId,
    handedOffFrom: info.tmuxName,
    artifact,
    model: sel?.model ?? info.sessionMetadata?.model,
    engine: sel?.engine ?? info.engine,
    inheritedLabel: info.label,
    // killSession deletes the record, so the spawn can't snapshot these itself (same as recovery.ts)
    carryOver: { artifacts: info.artifacts, contextLinks: info.contextLinks, description: info.description },
    ...(reuseWorktree && { preserveWorktree: true, reuseWorktree }),
  }
}

// Injectable for tests (like recoveryDeps): the real ones kill tmux and spawn sessions.
export const handoffIO = { killSession: (i: SessionInfo, r: string, o: { skipWorktreeDestroy: boolean }) => killSession(i, r, o), doSpawnSession: (t: string, c?: string, m?: string, o?: SpawnOpts) => doSpawnSession(t, c, m, o) }
const handoffsInFlight = new Set<string>()

/**
 * Replace a live session with a fresh one in the same thread, seeded from a
 * handoff file the old session wrote. The kill reason 'handed off' is not a
 * human Kill, so the on-kill retro skips it. PR watches move to the successor.
 */
export async function handOff(info: SessionInfo, artifact: string): Promise<SpawnResult> {
  if (handoffsInFlight.has(info.sessionId) || registry.get(info.sessionId) !== info) {
    throw new Error(`${info.tmuxName} is already handing off (or gone)`)
  }
  handoffsInFlight.add(info.sessionId)
  try {
    const opts = handoffSpawnOpts(info, artifact)
    const watches = getWatchesBySession(info.sessionId)  // before the kill unwatches them
    await handoffIO.killSession(info, 'handed off', { skipWorktreeDestroy: true })
    const r = await handoffIO.doSpawnSession(info.topic, undefined, undefined, opts)
    if (watches.length > 0) restoreWatches(watches, r.sessionId, r.threadId)
    return r
  } finally {
    handoffsInFlight.delete(info.sessionId)
  }
}

// Under STATE_DIR so the test preload's temp state dir keeps `bun test` from ever running the real hook
export const KILL_HOOK_PATH = join(STATE_DIR, 'hooks', 'on-kill')

/**
 * User extension point: if <STATE_DIR>/hooks/on-kill exists, run it detached after a
 * session dies, with the session's identity in env. Best-effort, never blocks the kill.
 */
export function runKillHook(info: SessionInfo, reason: string, hookPath = KILL_HOOK_PATH): void {
  if (!existsSync(hookPath)) return
  try {
    const child = spawn(hookPath, [], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HYDRA_SESSION_NAME: info.tmuxName,
        HYDRA_SESSION_ID: info.sessionId,
        HYDRA_THREAD_ID: info.threadId,
        HYDRA_KILL_REASON: reason,
        HYDRA_ENGINE: info.engine ?? 'claude',
        HYDRA_CLAUDE_SESSION_ID: info.claudeSessionId ?? '',
        HYDRA_CODEX_HOME_NAME: info.codexHomeName ?? '',
        HYDRA_SESSION_TYPE: info.sessionType ?? '',
      },
    })
    child.on('error', err => process.stderr.write(`daemon: on-kill hook failed: ${err.message}\n`))
    child.unref()
  } catch (err) {
    process.stderr.write(`daemon: on-kill hook failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

/** Claude session ids whose scratchpads a kill of info cleans: its own, plus a thread owner's handoff chain; never a live session's. */
export function scratchSessionIds(info: SessionInfo, sessions: Iterable<SessionInfo>, history: readonly { claudeSessionId?: string }[]): string[] {
  const ids = new Set<string>()
  if (info.claudeSessionId) ids.add(info.claudeSessionId)
  if (info.sessionType !== 'thread_guest') for (const h of history) if (h.claudeSessionId) ids.add(h.claudeSessionId)
  for (const s of sessions) if (s !== info && !s.deadAt && s.claudeSessionId) ids.delete(s.claudeSessionId)
  return [...ids]
}

// skipWorktreeDestroy: the conversation continues elsewhere (handoff, reattach) — keep the
// Hydra worktree and scratchpads. keepScratch: only the scratchpads (a resume or fork of
// this conversation still names their paths, and a resume reuses the scratchpad itself).
export async function killSession(info: SessionInfo, reason: string, opts?: { skipWorktreeDestroy?: boolean; keepScratch?: boolean }): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    // Join members, ephemeral, and headless sessions don't own a real thread
    if (info.sessionType !== 'thread_guest' && !info.ephemeral && !info.headless) {
      try {
        await gateway.send(info.threadId, `_${reason}_`)
      } catch (err) {
        process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
      }

      refreshSessionVisual(info.threadId, { state: 'killed' })
    }

    // Notify parent session when a child dies (createdAt guard prevents name-recycling mismatch)
    if (info.originFrom && info.sessionType !== 'thread_guest' && !info.suppressDeathMessage) {
      const parent = [...registry.values()].find(s => s.tmuxName === info.originFrom && s.createdAt < info.createdAt)
      if (parent) {
        const msgs = info.messageCount ?? 0
        const emoji = sessionEmoji(info.tmuxName)
        void gateway.send(parent.threadId, `${emoji} \`${info.tmuxName}\` died — _${reason}_ (${msgs} msgs)`).catch(err => {
          process.stderr.write(`daemon: failed to notify parent of child death: ${err}\n`)
        })
      }
    }

    // Edit spawn announce to show completion
    if (info.spawnAnnounceId && info.sessionType === 'thread_guest') {
      const elapsed = Math.round((Date.now() - info.createdAt) / 60_000)
      const spawnLine = formatSpawnLine({
        roleLabel: undefined,
        emoji: sessionEmoji(info.tmuxName),
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
    await info.adapter.stop(info)

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)
    clearInterceptsForSession(info.tmuxName)

    if (info.worktreePath && info.worktreeRepo && !opts?.skipWorktreeDestroy) {
      const branch = info.worktreeBranch ?? `wt/${info.tmuxName}`

      // Async worktree cleanup — fire-and-forget (killSession is sync, cleanup is best-effort).
      // Work at risk (uncommitted, mid-operation, not on a remote) is kept, never destroyed.
      void (async () => {
        const kept = await destroyWorktree(info.worktreeRepo!, info.worktreePath!, branch)
        if (kept) void safeSend(info.threadId, `⚠️ Worktree \`${info.worktreePath}\` (branch \`${branch}\`) kept: ${kept}. Remove it once the work is safe.`).catch(() => {})
      })().catch(err => {
        process.stderr.write(`daemon: worktree cleanup failed for ${info.tmuxName}: ${err}\n`)
      })
    }

    // Worktrees the session — and, for a thread owner, its handoff predecessors, whose
    // worktrees a handoff deliberately kept for it — made under their scratchpads: same rule.
    const scratchIds = !opts?.skipWorktreeDestroy && !opts?.keepScratch ? scratchSessionIds(info, registry.values(), threadRegistry.get(info.threadId)?.sessionHistory ?? []) : []
    if (scratchIds.length) {
      void cleanScratchWorktrees(scratchIds.flatMap(id => sessionScratchpads(id))).then(({ removed, kept }) => {
        if (removed.length) process.stderr.write(`daemon: ${info.tmuxName}: removed ${removed.length} scratchpad worktree(s)\n`)
        if (kept.length) {
          process.stderr.write(`daemon: ${info.tmuxName}: kept scratchpad worktree(s): ${kept.map(k => `${k.path} (${k.reason})`).join(', ')}\n`)
          void safeSend(info.threadId, `⚠️ Kept ${kept.length} worktree(s) with work not on a remote:\n${kept.map(k => `- \`${k.path}\` — ${k.reason}`).join('\n')}`).catch(() => {})
        }
      }).catch(err => process.stderr.write(`daemon: scratchpad worktree cleanup failed for ${info.tmuxName}: ${err}\n`))
    }

    // Update thread metadata before deleting session
    if (info.sessionType !== 'thread_guest') {
      threadRegistry.closeHistoryEntry(info.threadId, info)
      registry.deleteThread(info.threadId)
    }
    registry.delete(info.sessionId)
    registry.persist()

    // Recovery re-establishes watches on the replacement via restoreWatches (snapshot
    // taken before this kill) — so deleting here is safe and avoids orphaning entries
    // on the now-deleted sessionId (which pollPr would prune mid-recovery).
    const removedWatches = unwatchBySession(info.sessionId)
    if (removedWatches > 0) {
      process.stderr.write(`daemon: removed ${removedWatches} PR watch(es) for session ${info.sessionId}\n`)
    }

    if (info.sessionType === 'thread_guest') {
      registry.removeMember(info.threadId, info.sessionId)
    }

    emitSessionDeath(info)
    runKillHook(info, reason)

    setTimeout(() => {
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s.tmuxName === tmuxName)
        if (!currentOwner) {
          execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
          execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
          process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
        }
      } catch {}
      killsInProgress.delete(info.sessionId)
    }, 3000)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

/** Unified session creation -- spawn, fork, and handoff all flow through here via SpawnOpts. */
// ---------------------------------------------------------------------------
// Codex spawn helper — tmux setup + engine connect
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main spawn orchestrator
// ---------------------------------------------------------------------------

export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined
  let anchorMessageId: string | undefined
  let anchorChannelId: string | undefined

  // Lossless respawn: deliverables/description re-applied after the new record is
  // created (killSession discards the dead record). Seeded from an explicit
  // opts.carryOver (fallback tiers, where the record is gone), else snapshotted off
  // the replaced record in the existing-thread branch below.
  let carriedArtifacts: string[] | undefined = opts?.carryOver?.artifacts
  let carriedContextLinks: string[] | undefined = opts?.carryOver?.contextLinks
  let carriedDescription: string | undefined = opts?.carryOver?.description
  // Recovery: reuse the dead session's on-disk worktree rather than recreate one.
  // An explicit descriptor (opts.reuseWorktree) wins so fallback tiers can adopt it
  // even after the record it came from was deleted.
  let reuseWorktree: { repo: string; path: string; branch: string } | undefined = opts?.reuseWorktree
  // The recovery orchestrator (recoverOne) reserves the predecessor's name in
  // registry.reservedNames across the whole cascade — protecting the preserved worktree
  // branch from a concurrent spawn's `branch -D` during the kill→persist window — so
  // doSpawnSession doesn't manage the reservation itself.

  // Flags come off before the topic becomes a thread name; opts beat the flag.
  const rawTopic = topic || 'session'
  const parsed = parseSpawnTopic(rawTopic)
  topic = parsed.topic || 'session'
  const worktreeTarget: string | undefined = opts?.worktree ?? parsed.worktree
  // rawTopic, not topic — the flag has been stripped out of the latter by here.
  const labelFields = resolveSpawnLabel(rawTopic, opts?.label, opts?.inheritedLabel)
  const sessionLabel = labelFields.label
  const phaseBudgetMs = opts?.phaseBudgetMs ?? parsed.budgetMs

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
  // NOTE: the freshly-picked name is intentionally NOT held in registry.reservedNames.
  // The pick→registry.set window is short (recoverOne resolves slow worktree ops up front,
  // so nothing lengthy runs here) and shorter than the recovery wave's STAGGER, so same-wave
  // recoveries don't collide; and a genuine collision is self-healing — `tmux new-session`
  // fails cleanly on a duplicate name, the tier returns null, and recovery retries. Reserving
  // it here would instead leak the name on any throw before registry.set (no try/finally on
  // this large function), which is worse than the self-healing collision it would prevent.
  const cleanTopic = topic.replace(/\*\*/g, '').replace(/\*/g, '').replace(/[\[\]<>]/g, '').replace(/\s+/g, ' ').trim()
  const threadName = `${sessionEmoji(tmuxName)} ${cleanTopic || tmuxName} · ${tmuxName}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const isResume = !!opts?.resumeFrom
  const isResurrect = !!opts?.resurrectFrom
  const originType: 'spawn' | 'fork' | 'handoff' | 'resurrect' = isFork ? 'fork' : isHandoff ? 'handoff' : isResurrect ? 'resurrect' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom ?? opts?.resurrectFrom

  if (opts?.existingThreadId) {
    threadId = opts.existingThreadId
  }

  // Headless sessions: no Discord thread, just tmux + send_to_thread.
  // Use sessionId as a synthetic threadId for registry tracking.
  // TODO: headless sessions can send via send_to_thread but cannot receive — safeSend with a UUID silently fails
  const isHeadless = !!opts?.headless
  if (isHeadless) {
    threadId = sessionId // synthetic — not a real Discord thread
  }

  // Join an existing thread as a member (skip thread creation entirely)
  const isJoin = !!opts?.joinThread
  let respawnCount = 0
  let resumeCount = 0
  if (isResume) {
    const predecessor = [...registry.values()]
      .filter(s => s.claudeSessionId === opts!.resumeFrom && s.deadAt)
      .sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]
    if (predecessor) resumeCount = (predecessor.resumeCount ?? 0) + 1
  }
  if (isJoin) {
    threadId = opts!.joinThread!
  }

  // Determine where to create the thread
  let targetChannelId = chatId
  let parentChannelId: string | undefined
  if (!threadId && !isHeadless) {
    const resolved = await resolveSpawnChannel(
      chatId, DEFAULT_SESSION_CHANNEL,
      id => gateway.fetchChannel(id),
      !!gateway.canThreadInDM,
    )
    targetChannelId = resolved.targetChannelId
    parentChannelId = resolved.parentChannelId ?? resolved.targetChannelId
    if (resolved.threadId) threadId = resolved.threadId
    if (resolved.warning) process.stderr.write(`daemon: WARNING: ${resolved.warning}\n`)

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const existingId = registry.getByThread(threadId)
      if (existingId) {
        const existing = registry.get(existingId)
        if (existing) {
          if (!executionAlive(existing)) {
            respawnCount = (existing.respawnCount ?? 0) + 1
            // Lossless respawn (mirror the existingThreadId branch): carry the dead
            // record's deliverables/description to the replacement. Worktree destruction
            // stays — a fresh non-recovery spawn onto a dead thread is a real replacement.
            carriedArtifacts ??= existing.artifacts
            carriedContextLinks ??= existing.contextLinks
            carriedDescription ??= existing.description
            await killSession(existing, 'replaced by new spawn', { keepScratch: isResume || !!opts?.forkFrom })
          }
        }
      }
    }

    // Create thread if we don't have one yet
    if (!threadId) {
      if (messageId && targetChannelId === chatId) {
        try {
          const thread = await gateway.createThread(targetChannelId!, threadName, {
            messageId,
            archiveDuration: 1440,
          })
          threadId = thread.id
          anchorMessageId = messageId
          anchorChannelId = targetChannelId!
        } catch (err: any) {
          // If thread already exists on this message, join it.
          // Discord thread IDs equal the parent message ID when created via startThread on a message.
          if (err?.code === 'MessageExistingThread') {
            threadId = messageId
            anchorMessageId = messageId
            anchorChannelId = targetChannelId!
            process.stderr.write(`daemon: joined existing thread ${threadId} on message ${messageId}\n`)
          } else {
            process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
          }
        }
      }

      if (!threadId) {
        const anchorText = originFrom
          ? `${threadName} — ${originType} from **${originFrom}**`
          : threadName
        const anchor = await gateway.send(targetChannelId!, anchorText)
        anchorMessageId = anchor.id
        anchorChannelId = targetChannelId!
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId: anchor.id,
          archiveDuration: 1440,
        })
        threadId = thread.id
      }
    }
  }

  // Codex resume adopts the original CODEX_HOME. Refuse if anything other than the
  // record being replaced owns that home —
  // launching would restart another owner's app-server. Throws before any mutation.
  if (opts?.resumeCodex) {
    const replacing = threadId ? registry.getByThread(threadId) : undefined
    const owner = resumeHomeOwner(registry.values(), opts.resumeCodex, replacing)
    if (owner) {
      throw new Error(`codex home ${opts.resumeCodex.homeName} is owned by ${owner.tmuxName} — cannot resume into it`)
    }
  }

  // Clean up dead session in this thread before spawning
  // Runs for all paths: existingThreadId, channel lookup, or spawn-in-dead-thread
  if (threadId && !isJoin) {
    const existingId = registry.getByThread(threadId)
    if (existingId) {
      const existing = registry.get(existingId)
      if (existing) {
        if (executionAlive(existing)) {
          throw new Error(`thread has a live session (${existing.tmuxName}) — kill it first or spawn in a new thread`)
        }
        respawnCount = (existing.respawnCount ?? 0) + 1
        if (!anchorMessageId && existing.anchorMessageId) {
          anchorMessageId = existing.anchorMessageId
          anchorChannelId = existing.anchorChannelId
        }
        // Carry the dead record's deliverables/description to the replacement — killSession
        // deletes the record, so snapshot before it runs (fixes lost PR/artifact links).
        // Explicit opts.carryOver (fallback tiers, where the record is already gone) wins.
        carriedArtifacts ??= existing.artifacts
        carriedContextLinks ??= existing.contextLinks
        carriedDescription ??= existing.description
        // Recovery reuses the existing worktree in place; skip destruction so unpushed
        // work survives and --resume can find the transcript under the same CWD.
        // An explicit opts.reuseWorktree (fallback tiers) already covers this — only
        // derive from the record when one wasn't passed.
        if (!reuseWorktree && opts?.preserveWorktree && existing.worktreeRepo && existing.worktreePath && !worktreeTarget) {
          reuseWorktree = {
            repo: existing.worktreeRepo,
            path: existing.worktreePath,
            branch: existing.worktreeBranch ?? `wt/${existing.tmuxName}`,
          }
        }
        await killSession(existing, 'replaced by new spawn', { skipWorktreeDestroy: !!opts?.preserveWorktree, keepScratch: isResume || !!opts?.forkFrom })
      }
    }
    if (!anchorMessageId) {
      const thread = threadRegistry.get(threadId)
      if (thread?.anchorMessageId) {
        anchorMessageId = thread.anchorMessageId
        anchorChannelId = thread.anchorChannelId
      }
    }
    // Backfill anchorChannelId if still missing (e.g. spawning into a thread
    // via existingThreadId/joinThread whose prior occupant lacked it).
    if (!anchorChannelId && threadId) {
      try {
        const ch = await gateway.fetchChannel(threadId)
        if (ch.isThread && ch.parentId) {
          anchorChannelId = ch.parentId
          process.stderr.write(`daemon: backfilled anchorChannelId=${ch.parentId} from thread ${threadId}\n`)
        }
      } catch (err) {
        process.stderr.write(`daemon: WARNING: backfill anchorChannelId failed for thread ${threadId}: ${err}\n`)
      }
    }
  }

  const channelFlag = `plugin:discord@claude-plugins-official`
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required -- set it to the working directory for spawned sessions')

  let worktreeRepo: string | undefined
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  let effectiveCwd = spawnCwd
  if (reuseWorktree) {
    // Recovery adopts the dead session's worktree in place. recoverOne has already resolved
    // availability (reattached the dir, or deferred/skipped) BEFORE this cascade — so the
    // dir is expected to exist here. If it doesn't (sub-second race: removed between that
    // check and now), throw rather than fall back to spawnCwd: a recovered autonomous agent
    // must never run in the shared main checkout, and a live record whose worktree isn't
    // there would let a later non-recovery kill `branch -D` the branch. The throw fails this
    // tier; the cascade's total-failure path re-persists the dead record to retry next boot.
    if (!existsSync(reuseWorktree.path)) {
      throw new Error(`worktree ${reuseWorktree.path} unavailable at spawn (branch ${reuseWorktree.branch} preserved) — deferring recovery`)
    }
    worktreeRepo = reuseWorktree.repo
    worktreePath = reuseWorktree.path
    worktreeBranch = reuseWorktree.branch
    effectiveCwd = reuseWorktree.path
    process.stderr.write(`daemon: spawn ${tmuxName}: reusing worktree ${worktreePath} (branch ${worktreeBranch})\n`)
  } else if (worktreeTarget) {
    const wt = await createWorktree({
      repoName: worktreeTarget,
      spawnCwd,
      branchName: opts?.worktreeBranchSuffix ? `wt/${tmuxName}-${opts.worktreeBranchSuffix}` : `wt/${tmuxName}`,
      dirSuffix: `${worktreeTarget}-${tmuxName}`,
    })

    worktreeRepo = wt.repoDir
    worktreePath = wt.worktreePath
    worktreeBranch = wt.branch
    effectiveCwd = wt.worktreePath

    // Pre-approve Claude trust for the worktree paths (Claude-specific, not git)
    const claudeJsonPath = join(CLAUDE_CONFIG, '.claude.json')
    try {
      const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
      if (!claudeJson.projects) claudeJson.projects = {}
      const trustEntry = {
        allowedTools: [] as string[],
        mcpContextUris: [] as string[],
        mcpServers: {} as Record<string, unknown>,
        enabledMcpjsonServers: [] as string[],
        disabledMcpjsonServers: [] as string[],
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 0,
      }
      let changed = false
      for (const p of [wt.worktreePath, wt.repoDir]) {
        const existing = claudeJson.projects[p]
        if (!existing || !existing.hasClaudeMdExternalIncludesApproved) {
          claudeJson.projects[p] = { ...existing, ...trustEntry }
          changed = true
        }
      }
      if (changed) {
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n')
        process.stderr.write(`daemon: pre-approved trust for worktree paths\n`)
      }
    } catch (err) {
      process.stderr.write(`daemon: trust pre-approval failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  const promptParams = { sessionId, tmuxName, threadId: threadId!, topic }
  let prompt: string
  if (opts?.promptBuilder) {
    prompt = opts.promptBuilder(sessionId, tmuxName)
  } else if (isHandoff) {
    prompt = buildHandoffPrompt({ ...promptParams, originFrom: originFrom!, artifact: opts?.artifact })
  } else if (isFork) {
    prompt = buildForkPrompt({ ...promptParams, originFrom: originFrom! })
  } else if (isResurrect) {
    prompt = buildResurrectPrompt(promptParams)
  } else {
    prompt = buildSpawnPrompt(promptParams)
  }

  if (opts?.promptPrefix) {
    prompt = `${opts.promptPrefix}\n\n${prompt}`
  }

  // Central model resolution: alias → full ID → validate. All callers can pass
  // raw aliases (e.g. "sonnet") or full IDs (e.g. "claude-sonnet-5[1m]").
  const rawModel = opts?.model
  const model = rawModel ? (resolveModelAlias(rawModel) ?? rawModel) : spawnModel()

  const engine = opts?.engine ?? 'claude'

  // --- Launch via engine adapter ---
  // Private protocol children use this hook to install their fail-closed policy
  // before the process receives its prompt or can connect to bridge tools.
  opts?.beforeInitialTurn?.(sessionId)
  const adapter = resolveEngine(engine)
  const launched = await adapter.launch({
    sessionId, tmuxName, cwd: effectiveCwd, originalCwd: spawnCwd, model, prompt,
    worktreePath, forkFromOriginalCwd: !!worktreeTarget,
    tools: opts?.tools, disallowedTools: opts?.disallowedTools,
    forkFrom: opts?.forkFrom, resumeFrom: opts?.resumeFrom, resumeCodex: opts?.resumeCodex,
    threadId,
  })

  const now = Date.now()
  const spawnType = opts?.sessionType ?? (isJoin ? 'thread_guest' : 'thread_owner')
  const sessionMetadata = {
    role: 'worker' as const,
    tools: spawnToolNames(adapter, spawnType),
    model: launched.model,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = isHeadless ? '' : await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
    tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, sessionMetadata,
    sessionType: spawnType,
    ...labelFields,
    threadUrl: url || undefined,
    engine,
    ...launched.identity,
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(resumeCount > 0 ? { resumeCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch } : {}),
    ...(launched.spawnLogPath ? { spawnLogPath: launched.spawnLogPath } : {}),
    ...(launched.exitFilePath ? { exitFilePath: launched.exitFilePath } : {}),
    ...(launched.stderrLogPath ? { stderrLogPath: launched.stderrLogPath } : {}),
    ...(launched.debugLogPath ? { debugLogPath: launched.debugLogPath } : {}),
    initiator: opts?.initiator,
    ephemeral: opts?.ephemeral,
    ...(isHeadless ? { headless: true } : {}),
    ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
    adapter,
  })
  if (phaseBudgetMs) startPhaseBudget(sessionId)
  // Thread ownership: setThread claims the thread for message routing. Only the
  // thread OWNER calls setThread — join members (protocol critics, guest agents)
  // use addMember and must never touch the mapping, or they'd hijack routing.
  // Headless sessions use a synthetic UUID as threadId — don't register it.
  if (!isJoin && !isHeadless) {
    registry.setThread(threadId!, sessionId)
  } else if (isJoin) {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }

  // Lossless respawn: re-apply the replaced record's deliverables/description so
  // the dashboard row keeps its PR/artifact links across respawns. Reset
  // artifactsBackfilled so a later boot's history-rescan re-derives links.
  if (carriedArtifacts?.length || carriedContextLinks?.length || carriedDescription) {
    const created = registry.get(sessionId)
    if (created) {
      if (carriedArtifacts?.length) created.artifacts = carriedArtifacts
      if (carriedContextLinks?.length) created.contextLinks = carriedContextLinks
      if (carriedDescription && !created.description) created.description = carriedDescription
      delete created.artifactsBackfilled
    }
  }

  registry.persist()

  if (!isJoin && !isHeadless) {
    threadRegistry.recordSpawn(threadId!, {
      anchorMessageId, anchorChannelId, threadUrl: url || undefined, topic, respawnCount,
      sessionId, tmuxName, originType, originFrom, model: launched.model, parentChannelId,
      label: sessionLabel,
      claudeSessionId: launched.identity.claudeSessionId,
    })
  }

  const spawnLine = formatSpawnLine({
    roleLabel: opts?.memberLabel,
    emoji: sessionEmoji(tmuxName),
    name: tmuxName,
    model: launched.model,
    trigger: opts?.trigger ?? originType,
    initiator: opts?.initiator,
  })

  if (isHeadless) {
    if (!opts?.quiet) {
      const parentInfo = opts?.initiator ? registry.findByName(opts.initiator) : undefined
      if (parentInfo) {
        void safeSend(parentInfo.threadId, `${spawnLine}\n_↳ headless worker_`)
      }
    }
  } else {
    refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

    const guestNote = isJoin ? '\n_↳ guest agent in thread_' : ''
    void safeSend(threadId!, spawnLine + guestNote).then(ids => {
      if (ids.length > 0) {
        const info = registry.get(sessionId)
        if (info) info.spawnAnnounceId = ids[0]
      }
    })
    // Echo to the causing thread — but only when it IS a thread we track
    // (a session or protocol thread). A plain channel already shows the new
    // thread's anchor; echoing there would double-announce.
    if (chatId && chatId !== threadId && (registry.getByThread(chatId) || threadRegistry.get(chatId))) {
      void safeSend(chatId, spawnLine)
    }
  }

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

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
  topic: string
  threadId: string
  claudeSessionId?: string
  threadUrl?: string
  model?: string
  label?: SessionLabel
  worktree?: { repo: string; path: string; branch: string }
  // Only recoverOne sets this: it pre-resolves the worktree dir (reattach) before the
  // cascade, so adopting the branch is safe. The manual `resume` path has no such
  // pre-flight — leaving it off keeps resume's prior destroy-and-respawn semantics
  // (a gone dir would otherwise make doSpawnSession throw and orphan the branch).
  preserveWorktree?: boolean
}): Promise<(SpawnResult & { bridgeOrphan?: boolean }) | null> {
  if (!dead.claudeSessionId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resumeFrom: dead.claudeSessionId,
      model: dead.model,
      label: dead.label,
      preserveWorktree: dead.preserveWorktree,
      reuseWorktree: dead.preserveWorktree ? dead.worktree : undefined,
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
        await killSession(info, 'resume health check failed', { skipWorktreeDestroy: true }).catch(() => {})
        return null
      }

      // Orphan: Claude is running with restored context but the bridge hasn't
      // connected. Preserve the session — killing it discards recovered context,
      // and returning null would cascade to a tier that spawns a duplicate.
      // The periodic orphan detector (daemon/session-health.ts) will monitor it from here.
      process.stderr.write(`daemon: resume ${info.tmuxName}: bridge timeout but tmux alive — preserving as orphan\n`)

      // One-shot recheck: the periodic detector runs every 5 minutes, so a
      // session that dies right after this check could go undetected for a full
      // cycle. This closes the gap by re-evaluating 30s later.
      const recheckSessionId = result.sessionId
      setTimeout(() => {
        const s = registry.get(recheckSessionId)
        if (!s || s.deadAt) return
        if (transport.has(recheckSessionId)) return
        if (!tmuxHasSession(s.tmuxName)) {
          process.stderr.write(`daemon: resume recheck: ${s.tmuxName} died after orphan classification — marking dead\n`)
          s.deadAt = Date.now()
          registry.persist()
          void gateway.send(s.threadId, `💀 **${s.tmuxName}** died. Use \`resume\` to restore context or \`respawn\` for a fresh start.`).catch(() => {})
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
  try {
    return await doSpawnSession(topic, undefined, undefined, {
      ...extraOpts,
      existingThreadId: threadId,
      resurrectFrom,
      // Respawn continuity: keep the dead session's model if we have one,
      // else fall back to the template's model (extraOpts), else the default.
      model: model ?? extraOpts?.model,
    })
  } catch (err) {
    process.stderr.write(`daemon: tryRespawn: doSpawnSession failed for ${threadId}: ${err}\n`)
    return null
  }
}

// Claude session ID discovery lives in the Claude engine; re-exported for existing importers.
export { discoverClaudeSessionId } from './engines/claude-engine.js'
