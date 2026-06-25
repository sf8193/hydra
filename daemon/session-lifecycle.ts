import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'

import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH } from './config.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, SPAWN_MODEL } from './bridge-dispatch.js'
import { setAnchorState } from './anchor-state.js'
import { syncSpawn, syncKill } from './list-sync.js'

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

// ---------------------------------------------------------------------------
// Detach session — unlink session from its thread without killing tmux
// ---------------------------------------------------------------------------

export function detachSession(sessionId: string, { skipPersist = false } = {}): void {
  const info = registry.get(sessionId)
  if (!info) return
  if (threadRegistry.getBoundSession(info.threadId) === sessionId) {
    threadRegistry.unbind(info.threadId)
    const thread = threadRegistry.get(info.threadId)
    if (thread) {
      const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId)
      if (histEntry) {
        histEntry.endedAt = Date.now()
        histEntry.messageCount = info.messageCount ?? 0
        histEntry.claudeSessionId = info.claudeSessionId
      }
    }
    if (!skipPersist) threadRegistry.persist()
  }
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

      void setAnchorState(info.threadId, 'killed').catch(() => {})
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

    // Co-update ThreadRegistry before deleting from session registry
    // (detachSession needs registry.get to work)
    if (!info.isJoinMember) {
      detachSession(info.sessionId, { skipPersist: true })
      const thread = threadRegistry.get(info.threadId)
      if (thread) {
        thread.anchorState = 'killed'
        void syncKill(thread)
      }
      threadRegistry.persist()
    }

    // Don't unbind for join members — owner keeps the binding
    if (!info.isJoinMember) {
      threadRegistry.unbind(info.threadId)
    }
    registry.delete(info.sessionId)
    registry.persist()

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
  const originType: 'spawn' | 'fork' | 'handoff' = isFork ? 'fork' : isHandoff ? 'handoff' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom

  // Join an existing thread as a member (skip thread creation entirely)
  const isJoin = !!opts?.joinThread
  let respawnCount = 0
  if (isJoin) {
    threadId = opts!.joinThread!
  } else {
    // Determine where to create the thread
    let targetChannelId = chatId
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

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const staleId = threadRegistry.getBoundSession(threadId)
      if (staleId) {
        const stale = registry.get(staleId)
        if (stale) {
          try { execSync(`tmux has-session -t '${stale.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {
            respawnCount = (stale.respawnCount ?? 0) + 1
            const anchor = gateway.getThreadAnchor(threadId)
            if (anchor) {
              void gateway.unreact(anchor.channelId, anchor.messageId, '☠️').catch(() => {})
              const COUNT_EMOJI = ['2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '👨‍👩‍👦‍👦']
              const idx = Math.min(respawnCount - 1, COUNT_EMOJI.length - 1)
              void gateway.react(anchor.channelId, anchor.messageId, COUNT_EMOJI[idx]).catch(() => {})
              if (respawnCount > 1) {
                void gateway.unreact(anchor.channelId, anchor.messageId, COUNT_EMOJI[Math.min(respawnCount - 2, COUNT_EMOJI.length - 1)]).catch(() => {})
              }
            }
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
  } else {
    prompt = `You are ${tmuxName}, a spawned session. Topic: ${topic}\n\nYour chat thread chat_id is ${threadId}. Your session_id is ${sessionId}. Read your memory files for context. To read prior conversation in your thread, use fetch_messages(channel="${threadId}") — this is your thread's history. Do NOT fetch from the parent channel ID alone, only from your full thread chat_id. Send a greeting to your thread using reply(chat_id=${threadId}). After orienting, call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary of what you're doing. Update it if your focus shifts significantly.`
  }

  // Build claude command -- fork adds --resume --fork-session
  const claudeArgs = isFork
    ? [
        `claude`,
        `--resume ${shq(opts!.forkFrom!.claudeSessionId)}`,
        `--fork-session`,
        `--model ${shq(SPAWN_MODEL)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ')
    : `claude --model ${shq(SPAWN_MODEL)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}`

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
    sessionId, topic, threadId: threadId!, anchorMessageId, createdAt: now, lastActive: now,
    tmuxName, listening: false, originType, originFrom, capabilities,
    threadUrl: url || undefined,
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath } : {}),
    ...(isJoin ? { isJoinMember: true } : {}),
  })
  // Don't bind for join members — owner keeps the binding
  if (!isJoin) {
    threadRegistry.bind(threadId!, sessionId)
  } else {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }
  registry.persist()

  // Co-update ThreadRegistry
  let thread = threadRegistry.get(threadId!)
  if (!thread) {
    thread = {
      threadId: threadId!,
      anchorMessageId,
      threadUrl: url || undefined,
      topic,
      description: undefined,
      anchorState: respawnCount > 0 ? 'zombie' : 'live',
      respawnCount,
      createdAt: now,
      lastActive: now,
      totalMessages: 0,
      sessionHistory: [],
    }
    threadRegistry.set(threadId!, thread)
  } else {
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

  void syncSpawn(thread, tmuxName, originType, originFrom)

  void setAnchorState(threadId!, respawnCount > 0 ? 'zombie' : 'live', respawnCount).catch(() => {})

  return { name: tmuxName, sessionId, threadId: threadId!, url }
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
