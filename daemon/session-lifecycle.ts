import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG } from './config.js'
import { safeSend, formatSpawnLine, tmuxHasSession } from './util.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionMetadata, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession } from './bridge-tools.js'
import { extractPhaseBudget } from './util.js'
import { startPhaseBudget, clearPhaseBudget } from './phase-budget.js'
import { isKnownModel, resolveModelAlias, spawnModel } from '../shared/constants.js'
import type { SessionType } from '../shared/constants.js'
import { buildSpawnPrompt, buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from './prompts/session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { unwatchBySession } from './pr-watch.js'
import { loadAccess } from './access.js'
import { codexEngine } from './codex-bootstrap.js'
import { codexSocketPath } from './codex-engine.js'
import { emit } from './event-bus.js'
import { clearInterceptsForSession } from './pane-probe.js'
import { classifyResumeFailure } from './resume-health.js'
import { createWorktree, destroyWorktree, checkUnpushedCommits } from './worktree-manager.js'
import { configureSessionProviders, providerFor } from './session-provider.js'
import { hasPendingRetirementForHome } from './retirement-journal.js'
import { stopCodexAppServer } from './codex-process.js'
import { ClaudeAdapter } from './engines/claude-adapter.js'
import { CodexAdapter } from './engines/codex-adapter.js'

const claudeAdapter = new ClaudeAdapter()
const codexAdapter = new CodexAdapter(codexEngine)

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

// Compatibility exports while callers migrate to the runtime.
export { resolveForkSpawnCwd, buildWorktreePromptAppend } from './engines/claude-adapter.js'

// ---------------------------------------------------------------------------
// Listen state resolution: thread override → channel group → global → false
// ---------------------------------------------------------------------------

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

export async function killSession(info: SessionInfo, reason: string, opts?: { skipWorktreeDestroy?: boolean }): Promise<void> {
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

    // Last-resort claudeSessionId discovery before tmux dies — if the bridge
    // never registered it, read ~/.claude/sessions/<panePid>.json while the
    // pane PID is still available. Without this, resume falls to tier 3 (respawn).
    if (!info.claudeSessionId && info.engine !== 'codex') {
      const discovered = discoverClaudeSessionId(info.tmuxName)
      if (discovered) {
        info.claudeSessionId = discovered
        process.stderr.write(`daemon: kill ${info.tmuxName}: late-discovered claudeSessionId=${discovered}\n`)
      }
    }

    const tmuxName = info.tmuxName
    process.stderr.write(`daemon: killing tmux session ${tmuxName} (${reason})\n`)
    try { providerFor(info.engine).disconnect(info) }
    catch (err) { process.stderr.write(`daemon: killSession: provider disconnect failed for ${info.tmuxName}: ${err}\n`) }
    if (info.engine === 'codex') {
      // SIGTERM is asynchronous. Keep ownership until the old server has
      // actually stopped, otherwise an immediate resume races its live socket.
      const socket = codexSocketPath(info.codexHomeName ?? info.tmuxName)
      const deadline = Date.now() + 5_000
      while (await codexEngine.isSocketLive(socket)) {
        if (Date.now() >= deadline) throw new Error(`Codex server ${info.tmuxName} is still shutting down; retry kill before resuming`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    try {
      execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)
    clearInterceptsForSession(info.tmuxName)

    if (info.worktreePath && info.worktreeRepo && !opts?.skipWorktreeDestroy) {
      const branch = info.worktreeBranch ?? `wt/${info.tmuxName}`

      // Async worktree cleanup — fire-and-forget (killSession is sync, cleanup is best-effort)
      void (async () => {
        const unpushed = await checkUnpushedCommits(info.worktreeRepo!, branch)
        if (unpushed > 0) {
          process.stderr.write(`daemon: worktree ${info.tmuxName} has ${unpushed} unpushed commit(s) on ${branch}\n`)
          void safeSend(info.threadId, `⚠️ Worktree branch \`${branch}\` has ${unpushed} unpushed commit(s). Verify changes were pushed before cleanup.`).catch(() => {})
        } else if (unpushed < 0) {
          process.stderr.write(`daemon: worktree ${info.tmuxName}: couldn't verify unpushed commits on ${branch} before cleanup\n`)
          void safeSend(info.threadId, `⚠️ Couldn't verify unpushed commits on worktree branch \`${branch}\` before cleanup (transient git error). Check the branch if it held unmerged work.`).catch(() => {})
        }
        await destroyWorktree(info.worktreeRepo!, info.worktreePath!, branch)
      })().catch(err => {
        process.stderr.write(`daemon: worktree cleanup failed for ${info.tmuxName}: ${err}\n`)
      })
    }

    // Update thread metadata before deleting session
    if (info.sessionType !== 'thread_guest') {
      threadRegistry.recordKill(info.threadId, info.sessionId, info.messageCount ?? 0, {
        claudeSessionId: info.claudeSessionId, engine: info.engine ?? 'claude',
        codexThreadId: info.codexThreadId, codexHomeName: info.codexHomeName,
      })
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

    emit('session:death', {
      sessionId: info.sessionId,
      threadId: info.threadId,
      wasOwner: info.sessionType !== 'thread_guest',
      tmuxName: info.tmuxName,
    })

    setTimeout(() => {
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s.tmuxName === tmuxName)
        if (!currentOwner) {
          execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
          process.stderr.write(`daemon: deferred tmux kill ${tmuxName} (no registry owner)\n`)
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
// Main spawn orchestrator
// ---------------------------------------------------------------------------

export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  if (opts?.engine === 'codex' && opts.model === 'codex-default') opts = { ...opts, model: undefined }
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

  // Parse worktree:repo_name prefix early so it doesn't leak into thread names/prompts
  let worktreeTarget: string | undefined = opts?.worktree
  topic = topic || 'session'
  if (!worktreeTarget) {
    const worktreeMatch = topic.match(/^(?:worktree|wt):(\S+)\s+/)
    if (worktreeMatch) {
      worktreeTarget = worktreeMatch[1]
      topic = topic.slice(worktreeMatch[0].length)
    }
  }

  // Parse --phase-budget from the topic (works for every spawn form); an
  // explicit opts value (bridge tool) wins over the inline flag.
  const budgetExtract = extractPhaseBudget(topic)
  topic = budgetExtract.topic || 'session'
  const phaseBudgetMs = opts?.phaseBudgetMs ?? budgetExtract.budgetMs

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
  const requestedCodexHome = opts?.resumeCodex?.homeName ?? tmuxName
  const ownsCodexReservation = opts?.engine === 'codex'
  if (ownsCodexReservation && !registry.reserveCodexHome(requestedCodexHome)) {
    throw new Error(`codex home ${requestedCodexHome} is already active or starting`)
  }
  if (ownsCodexReservation && hasPendingRetirementForHome(requestedCodexHome)) {
    registry.releaseCodexHome(requestedCodexHome)
    throw new Error(`codex home ${requestedCodexHome} has unresolved retirement`)
  }
  try {
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
  const isResume = !!opts?.resumeFrom || !!opts?.resumeCodex
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
      .filter(s => opts?.resumeCodex
        ? (s.codexHomeName ?? s.tmuxName) === opts.resumeCodex.homeName && s.codexThreadId === opts.resumeCodex.threadId && s.deadAt
        : s.claudeSessionId === opts?.resumeFrom && s.deadAt)
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
          const alive = existing.engine === 'codex'
            ? codexEngine.isConnected(existing.sessionId) || await codexEngine.isSocketLive(codexSocketPath(existing.codexHomeName ?? existing.tmuxName))
            : tmuxHasSession(existing.tmuxName)
          if (!alive) {
            respawnCount = (existing.respawnCount ?? 0) + 1
            // Lossless respawn (mirror the existingThreadId branch): carry the dead
            // record's deliverables/description to the replacement. Worktree destruction
            // stays — a fresh non-recovery spawn onto a dead thread is a real replacement.
            carriedArtifacts ??= existing.artifacts
            carriedContextLinks ??= existing.contextLinks
            carriedDescription ??= existing.description
            await killSession(existing, 'replaced by new spawn')
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

  // Clean up dead session in this thread before spawning
  // Runs for all paths: existingThreadId, channel lookup, or spawn-in-dead-thread
  if (threadId && !isJoin) {
    const existingId = registry.getByThread(threadId)
    if (existingId) {
      const existing = registry.get(existingId)
      if (existing) {
        if (existing.engine === 'codex'
          ? codexEngine.isConnected(existing.sessionId) || await codexEngine.isSocketLive(codexSocketPath(existing.codexHomeName ?? existing.tmuxName))
          : tmuxHasSession(existing.tmuxName)) {
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
        await killSession(existing, 'replaced by new spawn', { skipWorktreeDestroy: !!opts?.preserveWorktree })
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
  // raw aliases (e.g. "sonnet") or full IDs (e.g. "claude-sonnet-4-6[1m]").
  const rawModel = opts?.model
  const model = rawModel ? (resolveModelAlias(rawModel) ?? rawModel) : spawnModel()

  const engine = opts?.engine ?? 'claude'

  if (engine === 'claude' && !isKnownModel(model)) {
    process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
    if (threadId) void gateway.send(threadId, `\u26a0\ufe0f Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
  }

  // --- Codex engine: spawn in tmux, connect via unix socket ---
  if (engine === 'codex') {
    const now = Date.now()
    const url = await gateway.getThreadUrl(threadId!)
    const provisionalModel = opts?.model ?? 'codex-default'
    const sessionMetadata: SessionMetadata = { role: 'worker', tools: [], model: provisionalModel, cwd: effectiveCwd, platform: PLATFORM }

    // The Codex client snapshots MCP tools while spawnCodexSession starts its
    // app-server/TUI, before the first model turn. Publish a provisional record
    // and protocol capabilities before starting that client.
    registry.set(sessionId, {
      sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
      tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, sessionMetadata,
      threadUrl: url || undefined, engine: 'codex',
      codexHomeName: opts?.resumeCodex?.homeName ?? tmuxName,
      ownershipGeneration: sessionId,
      ...(respawnCount > 0 ? { respawnCount } : {}),
      ...(resumeCount > 0 ? { resumeCount } : {}),
      ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch } : {}),
      sessionType: opts?.sessionType ?? (isJoin ? 'thread_guest' as const : 'thread_owner' as const),
      initiator: opts?.initiator,
      ephemeral: opts?.ephemeral,
      ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
    })
    if (phaseBudgetMs) startPhaseBudget(sessionId)
    if (!isJoin) registry.setThread(threadId!, sessionId)
    else registry.addMember(threadId!, sessionId, opts?.memberLabel)
    registry.persist()
    opts?.beforeInitialTurn?.(sessionId)

    let spawned: Awaited<ReturnType<CodexAdapter['spawn']>>
    try {
      spawned = await codexAdapter.spawn({
        sessionId, tmuxName, cwd: effectiveCwd, originalCwd: spawnCwd, model: opts?.model, prompt,
        mode: opts?.resumeCodex
          ? { kind: 'resume', source: { provider: 'codex', threadId: opts.resumeCodex.threadId, homeName: opts.resumeCodex.homeName } }
          : opts?.forkFrom?.codexThreadId
            ? { kind: 'fork', source: { provider: 'codex', threadId: opts.forkFrom.codexThreadId, homeName: opts.forkFrom.codexHomeName ?? tmuxName } }
            : { kind: 'fresh' },
      })
    } catch (err) {
      registry.delete(sessionId)
      if (isJoin) registry.removeMember(threadId!, sessionId)
      else registry.deleteThread(threadId!)
      registry.persist()
      throw err
    }
    const { spawnLogPath, model: resolvedCodexModel } = spawned
    const codexThreadId = spawned.nativeIdentity!.threadId
    const displayedModel = resolvedCodexModel ?? provisionalModel
    const info = registry.get(sessionId)!
    // A failed connection attempt emits disconnected while this provisional
    // record is visible. A later successful retry is authoritative.
    delete info.deadAt
    info.codexThreadId = codexThreadId!
    info.sessionMetadata!.model = displayedModel
    if (spawnLogPath) info.spawnLogPath = spawnLogPath
    registry.persist()
    // Refresh protocol execution identity now that the persistent thread exists.
    opts?.beforeInitialTurn?.(sessionId)
    providerFor('codex').ensureInteractiveSurface(info)

    void codexEngine.startTurn(sessionId, prompt).catch(err => {
      process.stderr.write(`daemon: codex startTurn failed for ${tmuxName}: ${err}\n`)
    })

    if (!isJoin) {
      threadRegistry.recordSpawn(threadId!, {
        anchorMessageId, anchorChannelId, threadUrl: url || undefined, topic, respawnCount,
        sessionId, tmuxName, originType, originFrom, model: displayedModel, parentChannelId,
        engine: 'codex', codexThreadId, codexHomeName: opts?.resumeCodex?.homeName ?? tmuxName,
      })
    }
    refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

    const spawnLine = formatSpawnLine({
      emoji: sessionEmoji(tmuxName), name: tmuxName, model: displayedModel,
      trigger: opts?.trigger ?? originType ?? 'spawn',
    })
    const announceIds = await safeSend(threadId!, spawnLine)
    if (announceIds.length > 0) { info.spawnAnnounceId = announceIds[0]; registry.persist() }

    return { name: tmuxName, sessionId, threadId: threadId!, url: url || '' }
  }

  const launched = await claudeAdapter.spawn({
    sessionId, tmuxName, cwd: effectiveCwd, originalCwd: spawnCwd, model, prompt,
    worktreePath, forkFromOriginalCwd: !!worktreeTarget,
    tools: opts?.tools, disallowedTools: opts?.disallowedTools,
    mode: isFork
      ? { kind: 'fork', source: { provider: 'claude', sessionId: opts!.forkFrom!.claudeSessionId! } }
      : isResume
        ? { kind: 'resume', source: { provider: 'claude', sessionId: opts!.resumeFrom! } }
        : { kind: 'fresh' },
  })
  const assignedClaudeSessionId = launched.nativeIdentity?.sessionId
  const { spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog, debugLogPath: debugLog } = launched

  const now = Date.now()
  const spawnType: SessionType = opts?.sessionType ?? (isJoin ? 'thread_guest' : 'thread_owner')
  const sessionMetadata: SessionMetadata = {
    role: 'worker',
    tools: computeToolsForSession(spawnType, new Set()).map(t => t.name),
    model,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = isHeadless ? '' : await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
    tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, sessionMetadata,
    sessionType: spawnType,
    threadUrl: url || undefined,
    ...(assignedClaudeSessionId ? { claudeSessionId: assignedClaudeSessionId } : {}),
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(resumeCount > 0 ? { resumeCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath, worktreeBranch } : {}),
    ...(spawnLogPath ? { spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog } : {}),
    debugLogPath: debugLog,
    initiator: opts?.initiator,
    ephemeral: opts?.ephemeral,
    ...(isHeadless ? { headless: true } : {}),
    ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
  })
  if (phaseBudgetMs) startPhaseBudget(sessionId)
  // Thread ownership: setThread claims the thread for message routing.
  // Only the thread OWNER should call setThread — join members (protocol
  // critics, guest agents) use addMember and never touch the mapping.
  // Callers resuming a non-owner session MUST pass joinThread to preserve
  // the real owner's routing. See auto-resume in protocol-runner.ts.
  // Headless sessions use a synthetic UUID as threadId — don't register it.
  if (!isJoin && !isHeadless) {
    registry.setThread(threadId!, sessionId)
  } else if (isJoin) {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }

  // Lossless respawn: re-apply the replaced record's deliverables/description so the
  // dashboard row keeps its PR/artifact links. Reset artifactsBackfilled so a LATER
  // boot's history-rescan re-derives links (the snapshot is the complete array, so
  // nothing is lost now; this only re-arms the self-heal for links captured after).
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

  // Co-update thread metadata (observational — not load-bearing for message routing)
  if (!isJoin && !isHeadless) {
    threadRegistry.recordSpawn(threadId!, {
      anchorMessageId,
      anchorChannelId,
      threadUrl: url || undefined,
      topic,
      respawnCount,
      sessionId,
      tmuxName,
      originType,
      originFrom,
      model,
      parentChannelId,
      claudeSessionId: assignedClaudeSessionId,
      engine: 'claude',
    })
  }

  const spawnLine = formatSpawnLine({
    roleLabel: opts?.memberLabel,
    emoji: sessionEmoji(tmuxName),
    name: tmuxName,
    model,
    trigger: opts?.trigger ?? originType,
    initiator: opts?.initiator,
  })

  if (isHeadless) {
    // Announce headless worker in the parent session's thread
    const parentInfo = opts?.initiator ? registry.findByName(opts.initiator) : undefined
    if (parentInfo) {
      void safeSend(parentInfo.threadId, `${spawnLine}\n_↳ headless worker_`)
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
  } finally {
    if (ownsCodexReservation) registry.releaseCodexHome(requestedCodexHome)
  }
}

// ---------------------------------------------------------------------------
// Recovery primitives — shared by resume/respawn commands and recover cascade
// ---------------------------------------------------------------------------

export const HEALTH_TIMEOUT_MS = 30_000

// Injected into every recovered session (resume notification + respawn/fork prompt).
// Post-crash the session must assume nothing about what completed before it died.
export const RECOVERY_REVERIFY_GUARD =
  '⚠️ SAFETY: You were recovered after a crash/reboot — mid-task state is unknown. Before ANY write, commit, push, deploy, migration, or other state-changing/prod operation, re-verify current repo/PR/system state first (git status, gh pr view, etc.). Assume nothing about what finished before the crash.'

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
      preserveWorktree: dead.preserveWorktree,
      reuseWorktree: dead.preserveWorktree ? dead.worktree : undefined,
    })

    // Queue the recovery notification before checking bridge health — sendOrQueue
    // delivers immediately if connected, queues for later if not. The orphan path
    // needs it most: when the bridge eventually connects, the session learns it
    // was recovered.
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: `[system] You were interrupted by a system crash and have been recovered with full conversation context. Check your thread for any messages you may have missed, and continue where you left off. ${RECOVERY_REVERIFY_GUARD}`,
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
      model: (model === 'codex-default' ? undefined : model) ?? extraOpts?.model,
    })
  } catch (err) {
    process.stderr.write(`daemon: tryRespawn: doSpawnSession failed for ${threadId}: ${err}\n`)
    return null
  }
}

configureSessionProviders({
  spawn: doSpawnSession,
  resumeClaude: tryResume,
  disconnectCodex: sessionId => codexEngine.disconnect(sessionId),
  stopCodexAppServer,
  isCodexConnected: sessionId => codexEngine.isConnected(sessionId),
  interruptCodexCurrent: sessionId => codexEngine.retireSession(sessionId),
  interruptCodexPersisted: (homeName, threadId) => codexEngine.interruptPersistedThread(codexSocketPath(homeName), threadId),
})

// ---------------------------------------------------------------------------
// Claude session ID discovery
// ---------------------------------------------------------------------------

export function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execFileSync('tmux', ['list-panes', '-t', tmuxName, '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 2000 }).toString().trim()
    if (!panePid) return null

    // Primary: read Claude's session file at ~/.claude/sessions/<pid>.json
    const sessionFile = join(homedir(), '.claude', 'sessions', `${panePid}.json`)
    try {
      const data = JSON.parse(readFileSync(sessionFile, 'utf8'))
      if (data.sessionId && data.cwd) {
        // Verify the conversation file exists (Claude creates .jsonl lazily —
        // freshly spawned sessions may not have one yet).
        // NOTE: For fork+worktree builders, data.cwd reflects Claude's launch CWD
        // (spawnCwd, e.g. /Users/sam/trading), not the worktree the builder later
        // `cd`s to via Bash. Claude's session file captures the startup CWD and does
        // not update on shell cd — so the conversation file will be found correctly.
        const projectDir = join(homedir(), '.claude', 'projects', data.cwd.replace(/\//g, '-'))
        const conversationFile = join(projectDir, `${data.sessionId}.jsonl`)
        if (existsSync(conversationFile)) return data.sessionId
      }
    } catch {}

    // Fallback: scan child process environments
    const childPids = execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8', timeout: 2000 }).toString().trim().split('\n').filter(Boolean)
    for (const childPid of childPids) {
      const envOutput = execFileSync('ps', ['-E', '-p', childPid], { encoding: 'utf8', timeout: 2000 }).toString()
      if (!envOutput.includes('HYDRA_SESSION_ID')) continue
      const hydraId = envOutput.match(/HYDRA_SESSION_ID=([^\s]+)/)?.[1]
      const candidates = [...envOutput.matchAll(/([A-Z_]*SESSION[A-Z_]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
      const claudeId = candidates.find(m => m[2] !== hydraId)?.[2]
      if (claudeId) return claudeId
    }
    return null
  } catch {
    return null
  }
}
