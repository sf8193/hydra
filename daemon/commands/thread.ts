import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { COUNT_EMOJI } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, tmuxHasSession, reportError, safeSend } from '../util.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { unwatchBySession } from "../pr-watch.js"
import { emit } from "../event-bus.js"
import type { InboundMessage } from '../../gateway.js'

export async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
  debouncedRefreshListDisplay()
}

export async function handleForkIntercept(msg: InboundMessage, description?: string, model?: string, opts?: { ephemeral?: boolean }): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  if (!info.claudeSessionId) {
    const discovered = discoverClaudeSessionId(info.tmuxName)
    if (discovered) {
      info.claudeSessionId = discovered
      registry.persist()
    }
  }

  if (!tmuxHasSession(info.tmuxName)) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot fork — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  const forkModel = model ?? info.capabilities?.model

  // No claudeSessionId → skip fork, spawn session that reads the parent thread
  if (!info.claudeSessionId) {
    void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})
    const forkTopic = description || `continuing: ${threadRegistry.get(info.threadId)?.topic ?? info.description ?? 'session'}`
    const baseChatId = msg.parentChannelId ?? msg.channelId
    const parentThreadId = info.threadId
    try {
      const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
        model: forkModel,
        ephemeral: opts?.ephemeral,
        promptPrefix: `Read the parent thread for context using fetch_messages(channel="${parentThreadId}", limit=50). Reconstruct what was discussed there, then continue the work in YOUR thread.`,
      })
      const e = sessionEmoji(result.name)
      await gateway.send(msg.channelId, `${e} \`${result.name}\` spawned (session not forkable yet — reading thread from **${info.tmuxName}**)${result.url ? ` — ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      try { await gateway.send(msg.channelId, `Fork fallback failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
    }
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍴').catch(() => {})

  const parentName = info.tmuxName
  const parentMessages = info.messageCount ?? 0
  const parentContext = getContextPercent(parentName)
  const thread = threadRegistry.get(info.threadId)
  const forkTopic = description || `continuing: ${thread?.topic ?? info.description ?? 'session'}`
  const baseChatId = msg.parentChannelId ?? msg.channelId

  try {
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: { claudeSessionId: info.claudeSessionId, parentName, codexThreadId: info.codexThreadId },
      model: forkModel,
      engine: info.engine,
      ephemeral: opts?.ephemeral,
    })

    const pe = sessionEmoji(parentName)
    const ce = sessionEmoji(result.name)
    await gateway.send(msg.channelId, [
      `${ce} \`${result.name}\` — forked from ${pe} \`${parentName}\``,
      forkTopic.startsWith('continuing:') ? '' : forkTopic,
      `${result.url ? result.url : ''}`,
    ].filter(Boolean).join('\n'), { replyTo: msg.id })

    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] ${pe} \`${parentName}\` forked → ${ce} \`${result.name}\`: ${forkTopic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: fork failed, falling back to spawn: ${errMsg}\n`)
    try {
      await gateway.send(msg.channelId, `⚠️ Fork failed — spawning fresh session that will read the thread for context.`, { replyTo: msg.id })
      const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
        resurrectFrom: parentName,
        model: forkModel,
      })
      const e = sessionEmoji(result.name)
      await gateway.send(msg.channelId, `${e} \`${result.name}\` spawned (reading thread from **${parentName}**)${result.url ? ` — ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
    } catch (spawnErr) {
      const spawnErrMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      try { await gateway.send(msg.channelId, `Fork and fallback spawn both failed: ${spawnErrMsg}`, { replyTo: msg.id }) } catch {}
    }
  }
}

export async function handleForksIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍽️').catch(() => {})
  const forks = [...registry.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName)
  if (forks.length === 0) {
    try { await gateway.send(msg.channelId, `No forks from ${sessionEmoji(info.tmuxName)} \`${info.tmuxName}\`.`, { replyTo: msg.id }) } catch {}
    return
  }

  const lines = forks.sort((a, b) => a.createdAt - b.createdAt).map(s => {
    const t = threadRegistry.get(s.threadId)
    const url = t?.threadUrl ?? ''
    const desc = s.description ?? fallbackDescription(t?.topic ?? '')
    const ctx = getContextPercent(s.tmuxName)
    const msgs = s.messageCount ?? 0
    const duration = formatDuration(Date.now() - s.createdAt)
    const e = sessionEmoji(s.tmuxName)
    const title = url ? `[**${desc}**](${url})` : `**${desc}**`
    return `╰ ${e} \`${s.tmuxName}\` — ${title}\n    ◦ ${ctx} (${msgs} msgs · ${duration})`
  })

  const pe = sessionEmoji(info.tmuxName)
  try { await gateway.send(msg.channelId, `Forks from ${pe} \`${info.tmuxName}\`\n\n${lines.join('\n')}`, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Recovery announcement helper — shared by all resume tiers
// ---------------------------------------------------------------------------

async function announceRecovery(
  msg: InboundMessage,
  result: { name: string },
  thread: { respawnCount: number; threadId?: string },
  method: string,
  emoji: string,
  lastTmuxName: string,
): Promise<void> {
  const e = sessionEmoji(result.name)
  const count = thread.respawnCount
  const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
  try {
    const sent = await gateway.send(msg.channelId, `${emoji} ${e} \`${result.name}\` ${method}${countLabel}.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
    if (count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
  } catch {}
  const mainBridge = transport.get('main')
  if (mainBridge) {
    transport.sendToBridge(mainBridge, {
      type: 'notification',
      content: `[system] ${emoji} ${e} \`${result.name}\` ${method} in thread (was ${lastTmuxName})`,
      meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }
  debouncedRefreshListDisplay()
}

// ---------------------------------------------------------------------------
// Resume / Respawn
// ---------------------------------------------------------------------------

export async function handleResumeIntercept(msg: InboundMessage): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'resume', 'must be used in a thread')
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  if (!thread) {
    await reportError(msg.channelId, msg.id, 'resume', 'no session found in this thread', 'Use `respawn` to start a fresh session that reads this thread.')
    return
  }

  // If thread has a live session, check if it's actually running
  const liveSessionId = registry.getByThread(threadId)
  if (liveSessionId) {
    const liveInfo = registry.get(liveSessionId)
    if (liveInfo) {
      if (tmuxHasSession(liveInfo.tmuxName)) {
        void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
        try { await gateway.send(msg.channelId, `Session **${liveInfo.tmuxName}** is already running.`, { replyTo: msg.id }) } catch {}
        return
      }
    }
  }

  // Thread is detached — find claudeSessionId from last session in history
  const lastSession = thread.sessionHistory[thread.sessionHistory.length - 1]
  const claudeSessionId = lastSession?.claudeSessionId
  const lastTmuxName = lastSession?.tmuxName ?? thread.threadId.slice(0, 8)
  const deadModel = lastSession?.model ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.model

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  // Three-tier cascade: resume → fork-from-dead → respawn
  if (claudeSessionId) {
    // Tier 1: full resume (--resume, same conversation)
    const result = await tryResume({
      topic: thread.topic,
      threadId: thread.threadId,
      claudeSessionId,
      threadUrl: thread.threadUrl,
      model: deadModel,
    })
    if (result) {
      const method = result.bridgeOrphan
        ? 'resumed — context restored, but bridge not yet connected (may need a moment)'
        : 'resumed — full context restored'
      await announceRecovery(msg, result, thread, method, '⏯️', lastTmuxName)
      return
    }
    process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

    // Tier 2: fork from dead session (--resume --fork-session, transcript copy)
    try {
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom: { claudeSessionId, parentName: lastTmuxName },
        model: deadModel,
      })
      await announceRecovery(msg, forkResult, thread, 'resumed (forked from dead session — transcript preserved)', '⏯️', lastTmuxName)
      return
    } catch {
      process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
    }
  }

  // Tier 3: respawn (fresh session reads thread history)
  const t3result = await tryRespawn(threadId, thread.topic, lastTmuxName, deadModel)
  if (t3result) {
    await announceRecovery(msg, t3result, thread, 'respawned (resume unavailable — reading thread history)', '🔁', lastTmuxName)
  } else {
    await reportError(msg.channelId, msg.id, 'resume', 'all recovery methods failed')
  }
}

export async function handleRespawnIntercept(msg: InboundMessage, topic?: string): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'respawn', 'must be used in a thread')
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  const respawnLiveId = registry.getByThread(threadId)
  if (respawnLiveId) {
    const liveInfo = registry.get(respawnLiveId)
    if (liveInfo) {
      if (tmuxHasSession(liveInfo.tmuxName)) {
        await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${liveInfo.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
        return
      }
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const lastSession = thread?.sessionHistory[thread.sessionHistory.length - 1]
  const resolvedTopic = topic || thread?.topic || 'respawned session'
  const resurrectFrom = lastSession?.tmuxName
  const deadModel = lastSession?.model ?? registry.get(lastSession?.sessionId ?? '')?.capabilities?.model

  const result = await tryRespawn(threadId, resolvedTopic, resurrectFrom, deadModel)
  if (result) {
    const e = sessionEmoji(result.name)
    const count = thread?.respawnCount ?? 0
    const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
    try {
      const sent = await gateway.send(msg.channelId, `🔁 ${e} \`${result.name}\` respawned${countLabel} — reading thread history.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
      if (count > 0) void gateway.react(msg.channelId, sent.id, '🧟').catch(() => {})
    } catch {}
    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] 🔁 ${e} \`${result.name}\` respawned in thread${resurrectFrom ? ` (was ${resurrectFrom})` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
    debouncedRefreshListDisplay()
  } else {
    await reportError(msg.channelId, msg.id, 'respawn', 'failed to spawn session')
  }
}

// ---------------------------------------------------------------------------
// Destroy — permanently delete thread + anchor message (Discord only)
// ---------------------------------------------------------------------------

export async function handleDestroyIntercept(msg: InboundMessage): Promise<void> {
  if (!gateway.deleteThread) {
    void safeSend(msg.channelId, `_\`destroy\` is only available on Discord._`)
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId

  const occupied = isThreadOccupied(threadId)
  if (occupied) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void safeSend(msg.channelId, `_A **${occupied}** is in progress. Cancel or wait for completion._`)
    return
  }

  const sessionId = registry.getByThread(threadId)
  const info = sessionId ? registry.get(sessionId) : undefined

  if (info && !info.deadAt) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void safeSend(msg.channelId, `_Session **${info.tmuxName}** is still alive. Kill it first with \`kill\`._`)
    return
  }

  if (info?.initiator && info.initiator !== msg.authorUsername) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void safeSend(msg.channelId, `_Only the session creator can destroy this thread._`)
    return
  }

  void gateway.react(msg.channelId, msg.id, '💀').catch(() => {})

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
    await gateway.deleteThread(threadId)
    process.stderr.write(`daemon: destroy: deleted thread ${threadId}\n`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: destroy: thread deletion failed: ${errMsg}\n`)
    void safeSend(parentChannelId ?? msg.channelId, `_Thread deletion failed: ${errMsg}_`)
    return
  }

  // Clean up registry only after successful thread deletion
  if (info && sessionId) {
    threadRegistry.recordKill(threadId, sessionId, info.messageCount ?? 0, info.claudeSessionId)
    registry.delete(sessionId)
    registry.deleteThread(threadId)
    registry.persist()
    unwatchBySession(sessionId)
    emit('session:death', {
      sessionId,
      threadId,
      wasOwner: !info.isJoinMember,
      tmuxName: info.tmuxName,
    })
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
}

// Peek — screenshot the tmux pane and post it to the thread
// ---------------------------------------------------------------------------

let hasFreezeCache: boolean | null = null
function hasFreeze(): boolean {
  if (hasFreezeCache === null) {
    try { execSync('which freeze', { stdio: 'pipe' }); hasFreezeCache = true } catch { hasFreezeCache = false }
  }
  return hasFreezeCache
}

export async function handlePeekIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  let info
  let name: string

  if (targetName) {
    info = [...registry.values()].find(s => s.tmuxName === targetName)
    if (!info) {
      void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
      void gateway.send(msg.channelId, `No session named **${targetName}**`, { replyTo: msg.id }).catch(() => {})
      return
    }
    name = info.tmuxName
  } else {
    info = registry.resolveThreadSessionFromMsg(msg)
    if (!info) {
      void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
      return
    }
    name = info.tmuxName
  }

  if (!tmuxHasSession(name)) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `**${name}** tmux not running`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '📸').catch(() => {})

  const ctx = getContextPercent(name)
  const duration = formatDuration(Date.now() - info.createdAt)
  const msgs = info.messageCount ?? 0
  const header = `📸 **${name}** · ${ctx} · ${msgs} msgs · ${duration}`

  if (hasFreeze()) {
    const outPath = join(tmpdir(), `hydra-peek-${name}-${Date.now()}.png`)
    try {
      const safeName = name.replace(/'/g, "'\\''")
      execSync(
        `tmux capture-pane -t '${safeName}' -e -p | freeze -o '${outPath}' --language bash`,
        { stdio: 'pipe', timeout: 10000 },
      )
      await gateway.send(msg.channelId, header, { files: [outPath], replyTo: msg.id })
      try { unlinkSync(outPath) } catch {}
      return
    } catch (err) {
      process.stderr.write(`daemon: peek screenshot failed: ${err}\n`)
      try { unlinkSync(outPath) } catch {}
    }
  }

  // Fallback: text capture
  try {
    const safeName = name.replace(/'/g, "'\\''")
    const text = execSync(
      `tmux capture-pane -t '${safeName}' -p -S -60`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    ).trimEnd()
    await gateway.send(msg.channelId, `${header}\n\`\`\`\n${(text || '(empty)').slice(-1800)}\n\`\`\``, { replyTo: msg.id })
  } catch (err) {
    await reportError(msg.channelId, msg.id, 'peek', `capture failed: ${err}`)
  }
}
