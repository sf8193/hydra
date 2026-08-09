import { randomUUID } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL, CLAUDE_CONFIG, SOCK_PATH, STATE_DIR } from './config.js'
import { safeSend, formatSpawnLine, tmuxHasSession } from './util.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { SessionInfo, SessionCapabilities, SpawnOpts, SpawnResult } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession } from './bridge-tools.js'
import { extractPhaseBudget } from './util.js'
import { startPhaseBudget, clearPhaseBudget } from './phase-budget.js'
import { isKnownModel, resolveModelAlias, spawnModel } from '../shared/constants.js'
import { withRaisedFdLimit } from '../shared/tmux-env.js'
import { buildSpawnPrompt, buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from './prompts/session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { unwatchBySession } from './pr-watch.js'
import { loadAccess } from './access.js'
import { codexEngine } from './codex-bootstrap.js'
import { codexSocketPath } from './codex-engine.js'
import { emit } from './event-bus.js'
import { clearInterceptsForSession } from './pane-probe.js'
import { classifyResumeFailure } from './resume-health.js'

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
        filled++
      }
    } catch (err) {
      process.stderr.write(`daemon: WARNING: backfill anchorChannelId failed for ${info.tmuxName} (thread ${info.threadId}): ${err}\n`)
      failed++
    }
    // Stagger to avoid Discord rate limits during fleet recovery
    if (missing.length > 1) await new Promise(r => setTimeout(r, 200))
  }

  if (filled > 0) registry.persist()
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
    // Join members, ephemeral, and headless sessions don't own a real thread
    if (!info.isJoinMember && !info.ephemeral && !info.headless) {
      try {
        await gateway.send(info.threadId, `_${reason}_`)
      } catch (err) {
        process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
      }

      refreshSessionVisual(info.threadId, { state: 'killed' })
    }

    // Notify parent session when a child dies (createdAt guard prevents name-recycling mismatch)
    if (info.originFrom && !info.isJoinMember && !info.suppressDeathMessage) {
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
    if (info.engine === 'codex') {
      try {
        // codexEngine imported at module scope
        codexEngine.disconnect(info.sessionId)
      } catch (err) {
        process.stderr.write(`daemon: killSession: codexEngine.disconnect failed for ${info.tmuxName}: ${err}
`)
      }
    }
    try {
      execSync(`tmux kill-session -t ${shq(tmuxName)}`, { stdio: 'pipe' })
    } catch {}

    transport.disconnect(info.sessionId)
    clearPhaseBudget(info.sessionId)
    clearInterceptsForSession(info.tmuxName)

    if (info.worktreePath && info.worktreeRepo) {
      const branch = `wt/${info.tmuxName}`

      // Warn if worktree branch has commits that may not have been pushed
      try {
        const commits = execSync(`git -C ${shq(info.worktreeRepo)} log ${shq(branch)} --not --remotes --oneline 2>/dev/null`, { stdio: 'pipe' }).toString().trim()
        if (commits) {
          const count = commits.split('\n').length
          process.stderr.write(`daemon: worktree ${info.tmuxName} has ${count} unpushed commit(s) on ${branch}\n`)
          void safeSend(info.threadId, `⚠️ Worktree branch \`${branch}\` has ${count} unpushed commit(s). Verify changes were pushed before cleanup.`).catch(() => {})
        }
      } catch (err) {
        process.stderr.write(`daemon: worktree ${info.tmuxName}: failed to check unpushed commits: ${err instanceof Error ? err.message : err}\n`)
      }

      const cleanupScript = `${info.worktreePath}/bin/dev/on-worktree-remove.sh`
      try {
        execSync(`test -x ${shq(cleanupScript)} && ${shq(cleanupScript)} ${shq(info.tmuxName)}`, { stdio: 'pipe' })
        process.stderr.write(`daemon: ran worktree cleanup hook for ${info.tmuxName}\n`)
      } catch (err) {
        process.stderr.write(`daemon: worktree ${info.tmuxName}: cleanup hook failed (non-fatal): ${err instanceof Error ? err.message : err}\n`)
      }
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} worktree remove ${shq(info.worktreePath)} --force`, { stdio: 'pipe' })
        process.stderr.write(`daemon: removed worktree ${info.worktreePath}\n`)
      } catch (err) {
        process.stderr.write(`daemon: worktree ${info.tmuxName}: git worktree remove failed: ${err instanceof Error ? err.message : err}\n`)
        if (info.worktreePath.includes('/.worktrees/') && existsSync(info.worktreePath)) {
          try {
            execSync(`rm -rf ${shq(info.worktreePath)}`, { stdio: 'pipe' })
            process.stderr.write(`daemon: rm -rf worktree ${info.worktreePath} (git remove failed, used rm -rf)\n`)
          } catch (rmErr) {
            process.stderr.write(`daemon: worktree ${info.tmuxName}: rm -rf also failed: ${rmErr instanceof Error ? rmErr.message : rmErr}\n`)
          }
        }
      }
      try { execSync(`git -C ${shq(info.worktreeRepo)} worktree prune`, { stdio: 'pipe' }) } catch (err) {
        process.stderr.write(`daemon: worktree ${info.tmuxName}: prune failed (non-fatal): ${err instanceof Error ? err.message : err}\n`)
      }
      try {
        execSync(`git -C ${shq(info.worktreeRepo)} branch -D ${shq(branch)}`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deleted branch ${branch}\n`)
      } catch (err) {
        process.stderr.write(`daemon: worktree ${info.tmuxName}: branch delete failed (non-fatal, branch may be pushed): ${err instanceof Error ? err.message : err}\n`)
      }
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

    emit('session:death', {
      sessionId: info.sessionId,
      threadId: info.threadId,
      wasOwner: !info.isJoinMember,
      tmuxName: info.tmuxName,
    })

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

async function spawnCodexSession(p: {
  tmuxName: string; sessionId: string; effectiveCwd: string;
  model?: string; forkFromThread?: string;
}): Promise<{ sockPath: string; spawnLogPath?: string; codexThreadId: string }> {
  const sockPath = codexSocketPath(p.tmuxName)
  const codexHomeDir = join(process.env.HOME!, '.codex', `hydra-${p.tmuxName}`)
  const mcpServerPath = join(new URL('.', import.meta.url).pathname, 'codex-mcp-server.ts')
  const codexModel = p.model ? `-c model=${shq(p.model)}` : ''
  const fullPerms = `-c 'sandbox_permissions=["disk-full-read-access","disk-full-write-access","network-full-access"]'`
  const serverCmd = `codex app-server --listen 'unix://' ${codexModel} ${fullPerms}`.trim()

  // Window 0: durable app-server
  const serverInner = [
    `cd ${shq(p.effectiveCwd)}`,
    `export CODEX_HOME=${shq(codexHomeDir)}`,
    `mkdir -p ${shq(codexHomeDir)}`,
    `ln -sf ~/.codex/auth.json ${shq(codexHomeDir)}/auth.json`,
    `codex mcp remove hydra 2>/dev/null; CODEX_HOME=${shq(codexHomeDir)} codex mcp add hydra --env DAEMON_SOCK=${shq(SOCK_PATH)} --env HYDRA_SESSION_ID=${shq(p.sessionId)} -- bun ${shq(mcpServerPath)}`,
    serverCmd,
  ].join(' && ')

  process.stderr.write(`daemon: codex spawning ${p.tmuxName}\n`)
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', p.tmuxName, withRaisedFdLimit(serverInner)], { stdio: 'pipe' })
  } catch (err) {
    throw new Error(`failed to spawn codex tmux: ${err instanceof Error ? err.message : err}`)
  }

  // Capture server pane for crash diagnostics
  let spawnLogPath: string | undefined
  try {
    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    const logPath = join(SPAWN_LOGS_DIR, `${p.tmuxName}-${p.sessionId}.log`)
    execFileSync('tmux', ['pipe-pane', '-o', '-t', `${p.tmuxName}:0`, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
    spawnLogPath = logPath
  } catch {}

  // Window 1: attachable TUI
  const tuiInner = `export CODEX_HOME=${shq(codexHomeDir)} && sleep 3 && codex --remote "unix://${sockPath}"`
  try {
    execFileSync('tmux', ['new-window', '-t', p.tmuxName, tuiInner], { stdio: 'pipe' })
  } catch {
    process.stderr.write(`daemon: codex TUI window failed for ${p.tmuxName} (non-fatal)\n`)
  }

  // Connect to the app-server socket with retry
  const start = Date.now()
  let codexThreadId: string | null = null
  let lastErr = ''
  while (Date.now() - start < 15_000) {
    try {
      if (p.forkFromThread) {
        const r = await codexEngine.connectAndFork(p.sessionId, sockPath, p.forkFromThread)
        codexThreadId = r.threadId
      } else {
        const r = await codexEngine.connect(p.sessionId, sockPath)
        codexThreadId = r.threadId
      }
      break
    } catch (err: any) {
      lastErr = err?.message || String(err)
      try { codexEngine.disconnect(p.sessionId) } catch {}
      if (!tmuxHasSession(p.tmuxName)) throw new Error(`codex tmux ${p.tmuxName} died during startup`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (!codexThreadId) throw new Error(`codex socket not ready after 15s (last: ${lastErr})`)
  process.stderr.write(`daemon: codex connected for ${p.tmuxName}, thread=${codexThreadId}\n`)

  return { sockPath, spawnLogPath, codexThreadId }
}

// ---------------------------------------------------------------------------
// Main spawn orchestrator
// ---------------------------------------------------------------------------

export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined
  let anchorMessageId: string | undefined
  let anchorChannelId: string | undefined

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
    parentChannelId = resolved.parentChannelId
    if (resolved.threadId) threadId = resolved.threadId
    if (resolved.warning) process.stderr.write(`daemon: WARNING: ${resolved.warning}\n`)

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const existingId = registry.getByThread(threadId)
      if (existingId) {
        const existing = registry.get(existingId)
        if (existing) {
          try { execFileSync('tmux', ['has-session', '-t', existing.tmuxName], { stdio: 'pipe' }) } catch {
            respawnCount = (existing.respawnCount ?? 0) + 1
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
        if (tmuxHasSession(existing.tmuxName)) {
          throw new Error(`thread has a live session (${existing.tmuxName}) — kill it first or spawn in a new thread`)
        }
        respawnCount = (existing.respawnCount ?? 0) + 1
        if (!anchorMessageId && existing.anchorMessageId) {
          anchorMessageId = existing.anchorMessageId
          anchorChannelId = existing.anchorChannelId
        }
        await killSession(existing, 'replaced by new spawn')
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
    try { execSync(`git -C ${shq(repoDir)} worktree remove ${shq(wtDir)} --force 2>/dev/null`, { stdio: 'pipe' }) } catch (err) {
      process.stderr.write(`daemon: stale worktree cleanup (pre-spawn): remove ${wtDir} failed (non-fatal): ${err instanceof Error ? err.message : err}\n`)
    }
    try { execSync(`git -C ${shq(repoDir)} worktree prune 2>/dev/null`, { stdio: 'pipe' }) } catch (err) {
      process.stderr.write(`daemon: stale worktree cleanup (pre-spawn): prune ${repoDir} failed (non-fatal): ${err instanceof Error ? err.message : err}\n`)
    }
    try { execSync(`git -C ${shq(repoDir)} branch -D ${shq(branch)} 2>/dev/null`, { stdio: 'pipe' }) } catch (err) {
      // Expected when branch doesn't exist yet — only log if error is unexpected
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('not found') && !msg.includes('error: branch')) {
        process.stderr.write(`daemon: stale worktree cleanup (pre-spawn): branch delete ${branch} failed (non-fatal): ${msg}\n`)
      }
    }

    // Start worktree from current branch (preserves feature-branch context for forks).
    // Falls back to default branch (main/master) if HEAD is detached.
    let baseBranch: string | undefined
    try {
      const current = execSync(`git -C ${shq(repoDir)} branch --show-current`, { stdio: 'pipe' }).toString().trim()
      if (current) baseBranch = current
    } catch {}
    if (!baseBranch) {
      baseBranch = 'main'
      try {
        baseBranch = execSync(`git -C ${shq(repoDir)} symbolic-ref refs/remotes/origin/HEAD`, { stdio: 'pipe' }).toString().trim().replace('refs/remotes/origin/', '')
      } catch {
        try {
          execSync(`git -C ${shq(repoDir)} rev-parse --verify main`, { stdio: 'pipe' })
        } catch {
          baseBranch = 'master'
        }
      }
    }

    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, wtDir, baseBranch], { stdio: 'pipe' })
      process.stderr.write(`daemon: created worktree ${wtDir} (branch ${branch}) from ${baseBranch}\n`)
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

  const engine = opts?.engine ?? 'claude'

  if (engine === 'claude' && !isKnownModel(model)) {
    process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
    if (threadId) void gateway.send(threadId, `\u26a0\ufe0f Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
  }

  // --- Codex engine: spawn in tmux, connect via unix socket ---
  if (engine === 'codex') {
    const { sockPath, spawnLogPath, codexThreadId } = await spawnCodexSession({
      tmuxName, sessionId, effectiveCwd, model: opts?.model, forkFromThread: opts?.forkFrom?.codexThreadId,
    })
    void codexEngine.startTurn(sessionId, prompt).catch(err => {
      process.stderr.write(`daemon: codex startTurn failed for ${tmuxName}: ${err}\n`)
    })

    // SYNC: keep in sync with Claude registration block (~line 655+)
    const now = Date.now()
    const capabilities: SessionCapabilities = { role: 'worker', tools: [], model: opts?.model ?? 'codex-default', cwd: effectiveCwd, platform: PLATFORM }
    const url = await gateway.getThreadUrl(threadId!)
    registry.set(sessionId, {
      sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
      tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, capabilities,
      threadUrl: url || undefined, engine: 'codex', codexThreadId: codexThreadId!,
      ...(spawnLogPath ? { spawnLogPath } : {}),
      ...(respawnCount > 0 ? { respawnCount } : {}),
      ...(worktreeRepo ? { worktreeRepo, worktreePath } : {}),
      ...(isJoin ? { isJoinMember: true } : {}),
      initiator: opts?.initiator,
      ephemeral: opts?.ephemeral,
      ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
    })
    if (phaseBudgetMs) startPhaseBudget(sessionId)
    if (!isJoin) registry.setThread(threadId!, sessionId)
    else registry.addMember(threadId!, sessionId, opts?.memberLabel)
    registry.persist()

    if (!isJoin) {
      threadRegistry.recordSpawn(threadId!, {
        anchorMessageId, threadUrl: url || undefined, topic, respawnCount,
        sessionId, tmuxName, originType, originFrom, model: opts?.model ?? 'codex-default', parentChannelId,
      })
    }
    refreshSessionVisual(threadId!, { state: respawnCount > 0 ? 'zombie' : 'live' })

    const spawnLine = formatSpawnLine({
      emoji: sessionEmoji(tmuxName), name: tmuxName, model: opts?.model ?? 'codex',
      trigger: opts?.trigger ?? originType ?? 'spawn',
    })
    const announceIds = await safeSend(threadId!, spawnLine)
    const info = registry.get(sessionId)
    if (info && announceIds.length > 0) { info.spawnAnnounceId = announceIds[0]; registry.persist() }

    return { name: tmuxName, sessionId, threadId: threadId!, url: url || '' }
  }

  // For fork+worktree: tell the builder its exact worktree path via the prompt.
  // (The process starts from spawnCwd for --resume CWD compatibility, so the
  // builder can't infer its worktree from $PWD.)
  const worktreeAppend = buildWorktreePromptAppend(isFork, worktreePath)
  if (worktreeAppend) prompt += worktreeAppend

  // Build claude command — fork adds --resume --fork-session, resume uses --resume without fork
  let claudeArgs: string
  let assignedClaudeSessionId: string | undefined
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
    assignedClaudeSessionId = randomUUID()
    const disallowed = opts?.disallowedTools?.length ? ` --disallowedTools ${shq(opts.disallowedTools.join(','))}` : ''
    const toolsFlag = opts?.tools?.length ? ` --tools ${shq(opts.tools.join(','))}` : ''
    claudeArgs = `claude --session-id ${shq(assignedClaudeSessionId)} --model ${shq(model)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}${disallowed}${toolsFlag}`
    if (disallowed) process.stderr.write(`daemon: disallowedTools flag: ${disallowed}\n`)
    if (toolsFlag) process.stderr.write(`daemon: tools whitelist active (${opts!.tools!.length} tools, Edit/Write blocked)\n`)
  }

  const stderrLog = join(SPAWN_LOGS_DIR, `stderr-${tmuxName}-${sessionId}.log`)
  const debugLog = join(SPAWN_LOGS_DIR, `debug-${tmuxName}-${sessionId}.log`)
  const exitFile = join(SPAWN_LOGS_DIR, `exit-${tmuxName}-${sessionId}.log`)
  const writeExitMarker = [
    `_HYDRA_EXIT_CODE=$?`,
    `_HYDRA_EXIT_TS=$(date +%s)`,
    `{ echo "exit_code=$_HYDRA_EXIT_CODE"`,
    `echo "wall_clock=\${SECONDS}s"`,
    `echo "exit_ts=$_HYDRA_EXIT_TS"`,
    `echo "session_id=${sessionId}"`,
    `echo "tmux_name=${tmuxName}"`,
    `if [ $_HYDRA_EXIT_CODE -gt 128 ]; then echo "signal=$(( $_HYDRA_EXIT_CODE - 128 ))"; fi`,
    `} > ${shq(exitFile)}`,
  ].join('; ')
  claudeArgs += ` --debug-file ${shq(debugLog)}`
  const spawnCd = resolveForkSpawnCwd(isFork, !!worktreeTarget, spawnCwd, effectiveCwd)
  if (isFork && worktreeTarget) {
    process.stderr.write(`daemon: spawn ${tmuxName}: fork+worktree — using PM CWD ${spawnCwd} for fork (worktree ${effectiveCwd} in prompt)\n`)
  }
  const inner = [
    `_hydra_write_exit() { ${writeExitMarker}; }; trap _hydra_write_exit EXIT`,
    `cd ${shq(spawnCd)}`,
    ...buildSpawnEnv(sessionId, tmuxName),
    `${claudeArgs} 2>>${shq(stderrLog)}`,
  ].join(' && ')

  process.stderr.write(`daemon: spawn ${tmuxName}: running tmux new-session\n`)
  process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

  mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, withRaisedFdLimit(inner)], { stdio: 'pipe' })
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
    tools: computeToolsForSession(sessionId, { allowMainTools: opts?.allowMainTools }).map(t => t.name),
    model,
    cwd: effectiveCwd,
    platform: PLATFORM,
  }
  const url = isHeadless ? '' : await gateway.getThreadUrl(threadId!)

  registry.set(sessionId, {
    sessionId, topic, threadId: threadId!, anchorMessageId, anchorChannelId, createdAt: now, lastActive: now,
    tmuxName, listening: resolveListenState(threadId!, chatId), originType, originFrom, capabilities,
    threadUrl: url || undefined,
    ...(assignedClaudeSessionId ? { claudeSessionId: assignedClaudeSessionId } : {}),
    ...(respawnCount > 0 ? { respawnCount } : {}),
    ...(worktreeRepo ? { worktreeRepo, worktreePath } : {}),
    ...(isJoin ? { isJoinMember: true } : {}),
    ...(spawnLogPath ? { spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog } : {}),
    debugLogPath: debugLog,
    initiator: opts?.initiator,
    ephemeral: opts?.ephemeral,
    ...(isHeadless ? { headless: true } : {}),
    ...(opts?.allowMainTools ? { allowMainTools: true } : {}),
    ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
  })
  if (phaseBudgetMs) startPhaseBudget(sessionId)
  // Thread ownership: setThread claims the thread for message routing.
  // Only the thread OWNER should call setThread — join members (protocol
  // critics, guest agents) use addMember and never touch the mapping.
  // Callers resuming a non-owner session MUST pass joinThread to preserve
  // the real owner's routing. See auto-resume in adversarial.ts/build.ts.
  // Headless sessions use a synthetic UUID as threadId — don't register it.
  if (!isJoin && !isHeadless) {
    registry.setThread(threadId!, sessionId)
  } else if (isJoin) {
    registry.addMember(threadId!, sessionId, opts?.memberLabel)
  }
  registry.persist()

  // Co-update thread metadata (observational — not load-bearing for message routing)
  if (!isJoin && !isHeadless) {
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
      claudeSessionId: assignedClaudeSessionId,
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
}): Promise<(SpawnResult & { bridgeOrphan?: boolean }) | null> {
  if (!dead.claudeSessionId) return null
  try {
    const result = await doSpawnSession(dead.topic, undefined, undefined, {
      existingThreadId: dead.threadId,
      resumeFrom: dead.claudeSessionId,
      model: dead.model,
    })

    // Queue the recovery notification before checking bridge health — sendOrQueue
    // delivers immediately if connected, queues for later if not. The orphan path
    // needs it most: when the bridge eventually connects, the session learns it
    // was recovered.
    transport.sendOrQueue(result.sessionId, {
      type: 'notification',
      content: `[system] You were interrupted by a system crash and have been recovered with full conversation context. Check your thread for any messages you may have missed, and continue where you left off.`,
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
        await killSession(info, 'resume health check failed').catch(() => {})
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
): Promise<SpawnResult | null> {
  try {
    return await doSpawnSession(topic, undefined, undefined, {
      existingThreadId: threadId,
      resurrectFrom,
      model,
    })
  } catch (err) {
    process.stderr.write(`daemon: tryRespawn: doSpawnSession failed for ${threadId}: ${err}\n`)
    return null
  }
}

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

// ---------------------------------------------------------------------------
// Periodic stale worktree scanner
// ---------------------------------------------------------------------------

const WORKTREE_SCAN_INTERVAL_MS = 30 * 60_000 // 30 minutes

/**
 * Start a periodic scanner that detects worktree directories with no active
 * session owner and logs them. Logs only — never auto-deletes (too dangerous).
 * Callers can clean up manually via `git worktree remove`.
 */
export function startWorktreeScanner(): void {
  setInterval(() => {
    try {
      const wtBase = resolve(process.env.SPAWN_CWD ?? '', '..', '.worktrees')
      if (!existsSync(wtBase)) return
      const entries = readdirSync(wtBase, { withFileTypes: true }).filter(e => e.isDirectory())
      if (entries.length === 0) return

      for (const entry of entries) {
        // Worktree dirs are named <repoName>-<tmuxName>
        const owner = [...registry.values()].find(s => s.worktreePath?.endsWith(`/${entry.name}`))
        if (!owner) {
          process.stderr.write(`daemon: stale worktree detected: ${entry.name} at ${wtBase} — no active session owns it (safe to remove with: git worktree remove --force ${join(wtBase, entry.name)})\n`)
        }
      }
    } catch (err) {
      process.stderr.write(`daemon: worktree scanner error: ${err instanceof Error ? err.message : err}\n`)
    }
  }, WORKTREE_SCAN_INTERVAL_MS).unref()
}
