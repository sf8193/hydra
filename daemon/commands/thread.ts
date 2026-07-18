import { gateway } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, doSpawnSession, discoverClaudeSessionId, tryResume, tryRespawn } from '../session-lifecycle.js'
import { COUNT_EMOJI } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, getContextPercent, tmuxHasSession, reportError } from '../util.js'
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

export async function handleForkIntercept(msg: InboundMessage, description?: string): Promise<void> {
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

  // No claudeSessionId → skip fork, go straight to respawn fallback
  if (!info.claudeSessionId) {
    void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})
    const forkTopic = description || `continuing: ${threadRegistry.get(info.threadId)?.topic ?? info.description ?? 'session'}`
    const baseChatId = msg.parentChannelId ?? msg.channelId
    try {
      const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
        resurrectFrom: info.tmuxName,
        model: info.capabilities?.model,
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
      model: info.capabilities?.model,
      engine: info.engine,
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
        model: info.capabilities?.model,
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
      await announceRecovery(msg, result, thread, 'resumed — full context restored', '⏯️', lastTmuxName)
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
