import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'

import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH, STATE_DIR } from './config.js'
import { safeSend, formatSpawnLine } from './util.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession } from './bridge-tools.js'
import { extractPhaseBudget } from './util.js'
import { startPhaseBudget, clearPhaseBudget } from './phase-budget.js'
import { isKnownModel, resolveModelAlias, spawnModel } from '../shared/constants.js'
import { buildSpawnPrompt, buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from './prompts/session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { unwatchBySession } from './pr-watch.js'
import { loadAccess } from './access.js'

// ---------------------------------------------------------------------------
// Session death events
// ---------------------------------------------------------------------------

export type SessionDeathEvent = {
  sessionId: string
  threadId: string
  wasOwner: boolean
  tmuxName: string
}

export const sessionDeathEmitter = new EventEmitter()

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

// Per-session pane logfile — `tmux pipe-pane` captures each spawn's output so a
// crash still leaves it on disk.

const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

// ---------------------------------------------------------------------------
// Listen state resolution: thread override → channel group → global → false
// ---------------------------------------------------------------------------

export function resolveListenState(threadId: string, channelId?: string): boolean {
  const thread = threadRegistry.get(threadId)
  return resolveListenStatePure(channelId, loadAccess(), thread?.listenOverride, thread?.parentChannelId)
}

export function resolveListenStatePure(
  channelId: string | undefined,
  access: { groups: Record<string, { defaultListen?: boolean }>; defaultListen?: boolean },
  listenOverride?: boolean,
  parentChannelId?: string,
): boolean {
  if (listenOverride !== undefined) return listenOverride
  for (const id of [channelId, parentChannelId]) {
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

export async function killSession(info: SessionInfo, reason: string): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    // Join members and ephemeral sessions don't own the thread — skip death message and anchor reactions
    if (!info.isJoinMember && !info.ephemeral) {
      try {
        await gateway.send(info.threadId, `_${reason}_`)
      } catch (err) {
        process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
      }

      refreshSessionVisual(info.threadId, { state: 'killed' })
    }

    // Notify parent session when a child dies (createdAt guard prevents name-recycling mismatch)
    if (info.originFrom && !info.isJoinMember) {
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
    if (info.spawnAnnounceId && info.isJoinMember) {
      const elapsed = Math.round((Date.now() - info.createdAt) / 60_000)
      const spawnLine = formatSpawnLine({
        roleLabel: undefined,
        emoji: sessionEmoji(info.tmuxName),
        name: info.tmuxName,
        model: info.capabilities?.model ?? 'unknown',
        trigger: info.originType ?? 'spawn',
        initiator: info.initiator,
      })
      const completionNote = `\n_↳ guest agent in thread_\n_↳ ${reason} after ${elapsed}m_`
      void gateway.edit(info.threadId, info.spawnAnnounceId, spawnLine + completionNote).catch(() => {})
    }

    const tmuxName = info.tmuxName
    try {
      execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)

    if (info.worktreePath && info.worktreeRepo) {
      const branch = `wt/${info.tmuxName}`
      const cleanupScript = `${info.worktreePath}/bin/dev/on-worktree-remove.sh`
      try {
        execSync(`test -x ${shq(cleanupScript)} && ${shq(cleanupScript)} ${shq(info.tmuxName)}`, { stdio: 'pipe' })
        process.stderr.write(`daemon: ran worktree cleanup hook for ${info.tmuxName}\n`)
      } catch {}
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} worktree remove ${shq(info.worktreePath)} --force`, { stdio: 'pipe' })
        process.stderr.write(`daemon: removed worktree ${info.worktreePath}\n`)
      } catch {
        if (info.worktreePath.includes('/.worktrees/') && existsSync(info.worktreePath)) {
          execSync(`rm -rf ${shq(info.worktreePath)}`, { stdio: 'pipe' })
          process.stderr.write(`daemon: rm -rf worktree ${info.worktreePath} (git remove failed)\n`)
        }
      }
      try { execSync(`git -C ${shq(info.worktreeRepo)} worktree prune`, { stdio: 'pipe' }) } catch {}
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} branch -D ${shq(branch)}`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deleted branch ${branch}\n`)
      } catch {}
    }

    // Update thread metadata before deleting session
    if (!info.isJoinMember) {
      threadRegistry.recordKill(info.threadId, info.sessionId, info.messageCount ?? 0, info.claudeSessionId)
      registry.deleteThread(info.threadId)
    }
    registry.delete(info.sessionId)
    registry.persist()

    const removedWatches = unwatchBySession(info.sessionId)
    if (removedWatches > 0) {
      process.stderr.write(`daemon: removed ${removedWatches} PR watch(es) for session ${info.sessionId}\n`)
    }

    if (info.isJoinMember) {
      registry.removeMember(info.threadId, info.sessionId)
    }

    sessionDeathEmitter.emit('death', {
      sessionId: info.sessionId,
      threadId: info.threadId,
      wasOwner: !info.isJoinMember,
      tmuxName: info.tmuxName,
    } satisfies SessionDeathEvent)

    setTimeout(() => {
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s.tmuxName === tmuxName)
        if (!currentOwner) {
          execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
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
export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined
  let anchorMessageId: string | undefined
  let anchorChannelId: string | undefined

  // Parse worktree:repo_name prefix early so it doesn't leak into thread names/prompts
  let worktreeTarget: string | undefined
  topic = topic || 'session'
  const worktreeMatch = topic.match(/^(?:worktree|wt):(\S+)\s+/)
  if (worktreeMatch) {
    worktreeTarget = worktreeMatch[1]
    topic = topic.slice(worktreeMatch[0].length)
  }

  // Parse --phase-budget from the topic (works for every spawn form); an
  // explicit opts value (bridge tool) wins over the inline flag.
  const budgetExtract = extractPhaseBudget(topic)
  topic = budgetExtract.topic || 'session'
  const phaseBudgetMs = opts?.phaseBudgetMs ?? budgetExtract.budgetMs

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
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

  // Join an existing thread as a member (skip thread creation entirely)
  const isJoin = !!opts?.joinThread
  let respawnCount = 0
  if (isJoin) {
    threadId = opts!.joinThread!
  }

  // Determine where to create the thread
  let targetChannelId = chatId
  let parentChannelId: string | undefined
  if (!threadId) {
    if (targetChannelId) {
      try {
        const ch = await gateway.fetchChannel(targetChannelId)
        if (ch.isThread) {
          threadId = ch.id
          parentChannelId = ch.parentId ?? undefined
        } else if (ch.isDM && !gateway.canThreadInDM) {
          targetChannelId = DEFAULT_SESSION_CHANNEL
        }
      } catch {
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } else {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const staleId = registry.getByThread(threadId)
      if (staleId) {
        const stale = registry.get(staleId)
        if (stale) {
          try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {
            respawnCount = (stale.respawnCount ?? 0) + 1
            await killSession(stale, 'replaced by new spawn')
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
    const staleId = registry.getByThread(threadId)
    if (staleId) {
      const stale = registry.get(staleId)
      if (stale) {
        let staleAlive = false
        try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); staleAlive = true } catch {}
        if (!staleAlive) {
          respawnCount = (stale.respawnCount ?? 0) + 1
          if (!anchorMessageId && stale.anchorMessageId) {
            anchorMessageId = stale.anchorMessageId
            anchorChannelId = stale.anchorChannelId
          }
          await killSession(stale, 'replaced by new spawn')
        }
      }
    }
    if (!anchorMessageId) {
      const thread = threadRegistry.get(threadId)
      if (thread?.anchorMessageId) {
        anchorMessageId = thread.anchorMessageId
        anchorChannelId = thread.anchorChannelId
      }
    }
  }

  const channelFlag = `plugin:discord@claude-plugins-official`
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required -- set it to the working directory for spawned sessions')

  let worktreeRepo: string | undefined
  let worktreePath: string | undefined
  let effectiveCwd = spawnCwd
  if (worktreeTarget) {
    const repoName = worktreeTarget
    const repoDir = resolve(spawnCwd, repoName)

    // Verify the target is a git repo
    try {
      execSync(`git -C ${shq(repoDir)} rev-parse --git-dir`, { stdio: 'pipe' })
    } catch {
      throw new Error(`worktree target "${repoName}" is not a git repo at ${repoDir}`)
    }

    const wtDir = resolve(repoDir, '..', `.worktrees`, `${repoName}-${tmuxName}`)
    const branch = `wt/${tmuxName}`

    // Clean up stale worktree/branch from previous runs
    try { execSync(`git -C ${shq(repoDir)} worktree remove ${shq(wtDir)} --force 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} worktree prune 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} branch -D ${shq(branch)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}

    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, wtDir], { stdio: 'pipe' })
      process.stderr.write(`daemon: created worktree ${wtDir} (branch ${branch})\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to create worktree: ${msg}`)
    }

    worktreeRepo = repoDir
    worktreePath = wtDir
    effectiveCwd = wtDir

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
      for (const p of [wtDir, repoDir]) {
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

  if (!isKnownModel(model)) {
    process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
    if (threadId) void gateway.send(threadId, `\u26a0\ufe0f Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
  }

  // Build claude command — fork adds --resume --fork-session, resume uses --resume without fork
  let claudeArgs: string
  if (isFork) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.forkFrom!.claudeSessionId)}`,
      `--fork-session`,
      `--model ${shq(model)}`,
      `--channels ${shq(channelFlag)}`,
      `--dangerously-skip-permissions`,
      shq(prompt),
    ].join(' ')
  } else if (isResume) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.resumeFrom!)}`,
      `--model ${shq(model)}`,
      `--channels ${shq(channelFlag)}`,
      `--dangerously-skip-permissions`,
    ].join(' ')
  } else {
    claudeArgs = `claude --model ${shq(model)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}`
  }

  const inner = [
    `cd ${shq(effectiveCwd)}`,
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    claudeArgs,
  ].join(' && ')

  process.stderr.write(`daemon: spawn ${tmuxName}: running tmux new-session\n`)
  process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, inner], { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn ${tmuxName}: execFileSync FAILED: ${msg}\n`)
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  // Verify the tmux session actually exists after creation
  let tmuxConfirmedAlive = false
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
    process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
    tmuxConfirmedAlive = true
  } catch {
    process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
  }

  // Best-effort: any failure is logged, never fatal to the spawn.
  let spawnLogPath: string | undefined
  if (tmuxConfirmedAlive) {
    try {
      // 0o700: the spawn logs are sensitive by construction (raw pane output).
      // Assert it at the artifact, not only via STATE_DIR's mode.
      mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
      const logPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)
      // Shell string is unavoidable here — `pipe-pane` runs its argument through a
      // shell, so it can't be array-form execFileSync; the path is shq-quoted.
      execFileSync('tmux', ['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
      spawnLogPath = logPath
      process.stderr.write(`daemon: spawn ${tmuxName}: pane capture -> ${logPath}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: pipe-pane capture setup FAILED (non-fatal): ${msg}\n`)
    }
  }

  const now = Date.now()
  const capabilities: SessionCapabilities = {
    role: 'worker',
    tools: computeToolsForSession(sessionId).map(t => t.name),
    model,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
    tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, capabilities,
    threadUrl: url || undefined,
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath } : {}),
    ...(isJoin ? { isJoinMember: true } : {}),
    ...(spawnLogPath ? { spawnLogPath } : {}),
    initiator: opts?.initiator,
    ephemeral: opts?.ephemeral,
    ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
  })
  if (phaseBudgetMs) startPhaseBudget(sessionId)
  // Don't register in threadToSession for join members — owner keeps that mapping
  if (!isJoin) {
    registry.setThread(threadId!, sessionId)
  } else {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }
  registry.persist()

  // Co-update thread metadata (observational — not load-bearing for message routing)
  if (!isJoin) {
    threadRegistry.recordSpawn(threadId!, {
      anchorMessageId,
      threadUrl: url || undefined,
      topic,
      respawnCount,
      sessionId,
      tmuxName,
      originType,
      originFrom,
      model,
      parentChannelId,
    })
  }

  refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

  // Deterministic spawn visibility: every tmux announces itself, from the one
  // function all spawn paths share. Echoed to the causing thread when distinct.
  const spawnLine = formatSpawnLine({
    roleLabel: opts?.memberLabel,
    emoji: sessionEmoji(tmuxName),
    name: tmuxName,
    model,
    trigger: opts?.trigger ?? originType,
    initiator: opts?.initiator,
  })
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

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

// ---------------------------------------------------------------------------
// Recovery primitives — shared by resume/respawn commands and recover cascade
// ---------------------------------------------------------------------------

export const HEALTH_TIMEOUT_MS = 30_000

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
}): Promise<SpawnResult | null> {
  if (!dead.claudeSessionId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resumeFrom: dead.claudeSessionId,
      model: dead.model,
    })
    const ok = await waitForBridge(result.sessionId, HEALTH_TIMEOUT_MS)
    if (!ok) {
      const info = registry.get(result.sessionId)
      if (info) await killSession(info, 'resume health check failed').catch(() => {})
      return null
    }
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: `[system] You were interrupted by a system crash and have been recovered with full conversation context. Check your thread for any messages you may have missed, and continue where you left off.`,
      meta: { chat_id: dead.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    return result
  } catch {
    return null
  }
}

export async function tryRespawn(
  threadId: string,
  topic: string,
  resurrectFrom?: string,
  model?: string,
): Promise<SpawnResult | null> {
  try {
    return await doSpawnSession(topic, undefined, undefined, {
      existingThreadId: threadId,
      resurrectFrom,
      model,
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Claude session ID discovery
// ---------------------------------------------------------------------------

export function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (!panePid) return null
    const childPids = execSync(`pgrep -P ${panePid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const childPid of childPids) {
      const envOutput = execSync(`ps -E -p ${childPid} 2>/dev/null`, { encoding: 'utf8' })
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
