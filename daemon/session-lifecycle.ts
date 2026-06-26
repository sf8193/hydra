import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'

import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH } from './config.js'
import { loadAccess } from './access.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, SPAWN_MODEL } from './bridge-dispatch.js'
import { setAnchorState } from './anchor-state.js'
import { unwatchBySession } from './pr-watch.js'

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

// ---------------------------------------------------------------------------
// Kill guard
// ---------------------------------------------------------------------------

export const killsInProgress = new Set<string>()

export function detachSession(sessionId: string): void {
  const info = registry.get(sessionId)
  if (!info) return
  const thread = threadRegistry.get(info.threadId)
  if (thread) {
    thread.currentSessionId = null
    const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId)
    if (histEntry) {
      histEntry.endedAt = Date.now()
      histEntry.messageCount = info.messageCount ?? 0
      histEntry.claudeSessionId = info.claudeSessionId
    }
    threadRegistry.persist()
  }
  registry.delete(sessionId)
  registry.persist()
}

// ---------------------------------------------------------------------------
// Kill session
// ---------------------------------------------------------------------------

export async function killSession(info: SessionInfo, reason: string): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    // Join members don't own the thread — skip death message and anchor reactions
    if (!info.isJoinMember) {
      try {
        await gateway.send(info.threadId, `_${reason}_`)
      } catch (err) {
        process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
      }

      await setAnchorState(info.threadId, 'killed')
    }

    const tmuxName = info.tmuxName
    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)

    if (info.worktreePath && info.worktreeRepo) {
      const branch = `wt/${info.tmuxName}`
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} worktree remove ${shq(info.worktreePath)} --force`, { stdio: 'pipe' })
        process.stderr.write(`daemon: removed worktree ${info.worktreePath}\n`)
      } catch (err) {
        process.stderr.write(`daemon: worktree removal failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      try { execSync(`git -C ${shq(info.worktreeRepo)} worktree prune`, { stdio: 'pipe' }) } catch {}
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} branch -D ${shq(branch)}`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deleted branch ${branch}\n`)
      } catch {}
    }

    detachSession(info.sessionId)

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
      const current = [...registry.sessions.values()].find(s => s.tmuxName === tmuxName && s.sessionId !== info.sessionId)
      if (current) { killsInProgress.delete(info.sessionId); return }
      try {
        // Only kill if the tmux session isn't owned by a new session (name recycling)
        const currentOwner = [...registry.values()].find(s => s.tmuxName === tmuxName)
        if (!currentOwner) {
          execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
          execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
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

  // Parse worktree:repo_name prefix early so it doesn't leak into thread names/prompts
  let worktreeTarget: string | undefined
  const worktreeMatch = topic.match(/^(?:worktree|wt):(\S+)\s+/)
  if (worktreeMatch) {
    worktreeTarget = worktreeMatch[1]
    topic = topic.slice(worktreeMatch[0].length)
  }

  const sessionId = randomUUID()
  const tmuxName = registry.pickSessionName()
  const threadName = `${tmuxName}: ${topic}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const isResume = !!opts?.resumeFrom
  const isResurrect = !!opts?.existingThreadId && !isResume
  const originType: SessionInfo['originType'] = isFork ? 'fork' : isHandoff ? 'handoff' : isResurrect ? 'resurrect' : 'spawn'
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
  if (!threadId) {
    if (targetChannelId) {
      try {
        const ch = await gateway.fetchChannel(targetChannelId)
        if (ch.isThread) {
          threadId = ch.id
        } else if (ch.isDM && !gateway.canThreadInDM) {
          targetChannelId = DEFAULT_SESSION_CHANNEL
        }
      } catch {
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } else {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }
  }

  // Clean up dead session in this thread before spawning
  // (runs for all paths: explicit existingThreadId, channel lookup, or spawn-in-dead-thread)
  if (threadId) {
    const existingThread = threadRegistry.get(threadId)
    if (existingThread?.currentSessionId) {
      const stale = registry.get(existingThread.currentSessionId)
      if (stale) {
        let staleAlive = false
        try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); staleAlive = true } catch {}
        if (!staleAlive) {
          await killSession(stale, 'replaced by new spawn')
        }
      }
    }
    // Only increment respawnCount when a stale session was actually replaced
    if (existingThread && existingThread.currentSessionId === null) {
      respawnCount = existingThread.respawnCount + 1
    }
    await setAnchorState(threadId, respawnCount > 0 ? 'zombie' : 'live', respawnCount)
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
        } catch (err) {
          process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
        }
      }

      if (!threadId) {
        const e = sessionEmoji(tmuxName)
        let anchorText: string
        if (originFrom) {
          const pe = sessionEmoji(originFrom)
          const verb = isHandoff ? 'handed off from' : 'forked from'
          anchorText = `${e} \`${tmuxName}\` — ${verb} ${pe} \`${originFrom}\``
          if (isFork) anchorText += `\n${topic}`
        } else {
          anchorText = `Starting session **${tmuxName}**: ${topic}`
        }
        const anchor = await gateway.send(targetChannelId!, anchorText)
        anchorMessageId = anchor.id
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId: anchor.id,
          archiveDuration: 1440,
        })
        threadId = thread.id
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

  let prompt: string
  if (opts?.promptBuilder) {
    prompt = opts.promptBuilder(sessionId, tmuxName)
  } else if (isHandoff) {
    const contextLine = opts!.artifact
      ? `Read your handoff context from \`${opts!.artifact}\`, then read your memory files.`
      : `Read your memory files and workstream canon for context.`
    prompt = [
      `You are ${tmuxName}, a session created by handoff from ${originFrom}. Topic: ${topic}`,
      ``,
      `Your chat thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `${contextLine}`,
      `After reading the artifact, append a "### Reception (by ${tmuxName})" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.`,
      `Send a greeting to your thread using reply(chat_id=${threadId}). In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
      `After greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.`,
    ].join('\n')
  } else if (isFork) {
    prompt = [
      `You are ${tmuxName}, forked from ${originFrom}.`,
      `Topic: ${topic}`,
      ``,
      `Your new thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `Greet your new thread using reply(chat_id=${threadId}).`,
      `Mention you were forked from **${originFrom}** and describe your focus.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
    ].join('\n')
  } else if (isResurrect) {
    prompt = [
      `You are ${tmuxName}, a resurrected session resuming work in an existing thread.`,
      ``,
      `Your chat thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `Read your memory files for context.`,
      `Use fetch_messages(channel="${threadId}", limit=50) to read the thread history.`,
      `Reconstruct context and continue from where the previous session left off.`,
      `Post a summary of what you found and what you're picking up using reply(chat_id=${threadId}).`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
    ].join('\n')
  } else {
    prompt = `You are ${tmuxName}, a spawned session. Topic: ${topic}\n\nYour chat thread chat_id is ${threadId}. Your session_id is ${sessionId}. Read your memory files for context. To read prior conversation in your thread, use fetch_messages(channel="${threadId}") — this is your thread's history. Do NOT fetch from the parent channel ID alone, only from your full thread chat_id. Send a greeting to your thread using reply(chat_id=${threadId}). After orienting, call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary of what you're doing. Update it if your focus shifts significantly.`
  }

  // Build claude command — fork adds --resume --fork-session, resume uses --resume without fork
  let claudeArgs: string
  if (isFork) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.forkFrom!.claudeSessionId)}`,
      `--fork-session`,
      `--model ${shq(SPAWN_MODEL)}`,
      `--channels ${shq(channelFlag)}`,
      `--dangerously-skip-permissions`,
      shq(prompt),
    ].join(' ')
  } else if (isResume) {
    claudeArgs = [
      `claude`,
      `--resume ${shq(opts!.resumeFrom!)}`,
      `--model ${shq(SPAWN_MODEL)}`,
      `--channels ${shq(channelFlag)}`,
      `--dangerously-skip-permissions`,
    ].join(' ')
  } else {
    claudeArgs = `claude --model ${shq(SPAWN_MODEL)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}`
  }

  const inner = [
    `cd ${shq(effectiveCwd)}`,
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
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
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
    process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
  } catch {
    process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
  }

  const now = Date.now()
  const capabilities: SessionCapabilities = {
    role: 'worker',
    tools: computeToolsForSession(sessionId).map(t => t.name),
    model: SPAWN_MODEL,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, threadId: threadId!, createdAt: now, lastActive: now,
    tmuxName, listening: (() => {
      const existingThread = threadRegistry.get(threadId!)
      if (existingThread?.listenOverride !== undefined) return existingThread.listenOverride
      const access = loadAccess()
      const group = chatId ? access.groups[chatId] : undefined
      return group?.defaultListen ?? access.defaultListen ?? false
    })(), originType, originFrom, capabilities,
    ...(worktreeRepo ? { worktreeRepo, worktreePath } : {}),
    ...(isJoin ? { isJoinMember: true } : {}),
  })
  if (isJoin) {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }
  registry.persist()

  // Co-update ThreadInfo — join members don't claim the thread's currentSessionId
  let thread = threadRegistry.get(threadId!)
  if (!thread) {
    thread = {
      threadId: threadId!,
      anchorMessageId,
      threadUrl: url || undefined,
      topic,
      description: undefined,
      anchorState: 'live',
      respawnCount,
      currentSessionId: isJoin ? null : sessionId,
      createdAt: now,
      lastActive: now,
      totalMessages: 0,
      sessionHistory: [],
    }
    threadRegistry.set(threadId!, thread)
  } else {
    if (!isJoin) thread.currentSessionId = sessionId
    thread.lastActive = now
    thread.threadUrl = url || thread.threadUrl
    thread.anchorState = respawnCount > 0 ? 'zombie' : 'live'
    if (respawnCount > 0) thread.respawnCount = respawnCount
  }
  thread.sessionHistory.push({
    sessionId,
    tmuxName,
    originType: originType!,
    originFrom,
    startedAt: now,
    messageCount: 0,
    claudeSessionId: undefined,
  })
  threadRegistry.persist()

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

export async function tryResume(dead: { topic: string; threadId: string; claudeSessionId?: string; threadUrl?: string }): Promise<SpawnResult | null> {
  if (!dead.claudeSessionId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resumeFrom: dead.claudeSessionId,
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

export async function tryRespawn(threadId: string, topic: string, resurrectFrom?: string): Promise<SpawnResult | null> {
  try {
    return await doSpawnSession(topic, undefined, undefined, {
      existingThreadId: threadId,
      resurrectFrom,
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
