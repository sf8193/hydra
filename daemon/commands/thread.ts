import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { gateway } from '../config.js'
import { markDead, registry, sessionEmoji, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { killSession, emitSessionDeath, requestHandoff } from '../session-lifecycle.js'
import type { SessionInfo } from '../sessions.js'
import { COUNT_EMOJI } from '../anchor-state.js'
import { debouncedRefreshListDisplay } from './status.js'
import { fallbackDescription, formatDuration, reportError, safeSend } from '../util.js'
import { hasFreeze, paneScreenshot, tmuxHasSession, tmuxSync } from '../tmux.js'
import { isThreadOccupied } from '../protocol-registry.js'
import { unwatchBySession } from "../../connectors/github/pr-watch.js"
import { emit } from "../event-bus.js"
import { getTemplate, buildTemplateSpawnOpts } from '../templates.js'
import type { InboundMessage } from '../../gateway.js'
import { recoveryEntry } from '../recovery-selection.js'
import { recoveryEngine } from '../engines/history.js'
import { formatContextPercent, type ProviderId } from '../engines/engine-adapter.js'
import { claudeEngine, resolveEngine } from '../engines/instances.js'
import { blocksRecovery, occupancy } from '../session-reachability.js'
import { currentRecoveryDeps, reviveThread, threadStub } from '../recovery.js'
export { _setRecoveryDeps, _resetRecoveryDeps } from '../recovery.js'
import { targetKeyForThread, threadLockHeld, withThreadLock } from '../../specialists/specialists.js'
import { isForMain, mainContext, mainStartedAt, mainSubject, mainTmux } from '../main-session.js'

function adapterFor(info: { engine?: ProviderId; adapter?: any }) {
  return info.adapter
}


export async function handleThreadKillIntercept(
  msg: InboundMessage,
  opts?: { cascade?: boolean; destroy?: boolean },
): Promise<void> {
  const cascade = opts?.cascade ?? false
  const destroy = opts?.destroy ?? false
  const info = registry.resolveThreadSessionFromMsg(msg)

  // `+destroy` is scoped to the thread, not the session, so it stays meaningful
  // once there is nothing left to kill — which is the whole point of offering it
  // as one command. Two shapes of "already dead" land here: a killed session is
  // gone from the registry (info is null), and one whose execution is gone is
  // still in it. Both skip straight to the destroy rather than reporting a failed
  // kill. A running orphan, even one stamped dead, is killed first.
  if (destroy && (!info || occupancy(info) === 'dead')) {
    await handleDestroyIntercept(msg)
    return
  }

  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, cascade ? '🧨' : '☠️').catch(() => {})

  await killSession(info, cascade ? 'session ended (cascade)' : 'session ended')
  debouncedRefreshListDisplay()

  // Sequential, not atomic: destroy re-applies its own guards (Discord-only, no
  // protocol in flight) against the state the kill just produced.
  // If it declines, the session stays dead and the thread survives — destroy
  // says why, and running `destroy` again once the blocker clears finishes the
  // job. Deliberate: a pre-flight check here would make `kill +d` refuse to
  // kill in cases where a plain `kill` succeeds.
  if (destroy) await handleDestroyIntercept(msg)
}

export async function handleForkIntercept(msg: InboundMessage, description?: string, model?: string, opts?: { ephemeral?: boolean; engine?: ProviderId }): Promise<void> {
  const info = registry.resolveThreadSessionFromMsg(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  const sourceEngine = info.engine ?? 'claude'
  const targetEngine = opts?.engine ?? sourceEngine
  if (adapterFor(info).recoveryPlan(info, { discover: sourceEngine === targetEngine }).learnedId) registry.persist()

  const provider = adapterFor(info)
  if (!tmuxHasSession(info.tmuxName)) provider.surface(info)
  if (!tmuxHasSession(info.tmuxName) && occupancy(info) === 'dead') {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot fork — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  const forkModel = model ?? (targetEngine === sourceEngine ? info.sessionMetadata?.model : undefined)
  // Native fork needs the source engine's own id; cross-engine is always a continuation.
  const forkFrom = resolveEngine(sourceEngine).recoveryPlan(info).fork
  const nativeFork = sourceEngine === targetEngine && forkFrom !== null

  // Missing native history, or a cross-engine continuation: start fresh and
  // reconstruct from the shared thread instead of claiming a native fork.
  if (!nativeFork) {
    void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})
    const forkTopic = description || `continuing: ${threadRegistry.get(info.threadId)?.topic ?? info.description ?? 'session'}`
    const baseChatId = msg.parentChannelId ?? msg.channelId
    const parentThreadId = info.threadId
    try {
      const ephemeralSuffix = opts?.ephemeral ? `\n\nWhen you are finished, post exactly \`[done]\` on its own line to your thread. This signals the system to clean up your session automatically.` : ''
      const result = await currentRecoveryDeps().doSpawnSession(forkTopic, baseChatId, undefined, {
        model: forkModel,
        engine: targetEngine,
        inheritedLabel: info.label,
        ephemeral: opts?.ephemeral,
        promptPrefix: `Read the parent thread for context using fetch_messages(channel="${parentThreadId}", limit=50). Reconstruct what was discussed there, then continue the work in YOUR thread.${ephemeralSuffix}`,
      })
      const e = sessionEmoji(result.name)
      const reason = targetEngine !== sourceEngine
        ? `cross-engine continuation from **${info.tmuxName}** — reading thread context`
        : `session not forkable yet — reading thread from **${info.tmuxName}**`
      await gateway.send(msg.channelId, `${e} \`${result.name}\` spawned (${reason})${result.url ? ` — ${result.url}` : ''}`, { replyTo: msg.id })
      debouncedRefreshListDisplay()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      try { await gateway.send(msg.channelId, `Fork fallback failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
    }
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍴').catch(() => {})

  const parentName = info.tmuxName
  const thread = threadRegistry.get(info.threadId)
  const forkTopic = description || `continuing: ${thread?.topic ?? info.description ?? 'session'}`
  const baseChatId = msg.parentChannelId ?? msg.channelId

  try {
    const ephemeralPrefix = opts?.ephemeral ? `When you are finished, post exactly \`[done]\` on its own line to your thread. This signals the system to clean up your session automatically.\n\n` : undefined
    const result = await currentRecoveryDeps().doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: forkFrom!,
      parentId: info.sessionId,  // a human fork answers to its source
      model: forkModel,
      engine: targetEngine,
      inheritedLabel: info.label,
      ephemeral: opts?.ephemeral,
      ...(ephemeralPrefix ? { promptPrefix: ephemeralPrefix } : {}),
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
      const result = await currentRecoveryDeps().doSpawnSession(forkTopic, baseChatId, undefined, {
        resurrectFrom: parentName,
        parentId: info.sessionId,  // a human fork answers to its source
        promptPrefix: `Read the parent thread for context using fetch_messages(channel="${info.threadId}", limit=50), then continue in your own thread.`,
        model: forkModel,
        engine: targetEngine,
        inheritedLabel: info.label,
        ephemeral: opts?.ephemeral,
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
    const ctx = formatContextPercent(adapterFor(s), s)
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
  msg: RecoveryAnchor,
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

export type RecoveryAnchor = Pick<InboundMessage, 'id' | 'channelId' | 'isThread' | 'effectiveThreadId'>

// A person asking by hand is not held back by the target's back-off, and a success clears it.
const byHand = (threadId: string) => ({ backoffKey: targetKeyForThread(threadId), ignoreBackoff: true })

// A person typing resume or respawn twice gets told, not queued behind the first (which may take 30s).
async function oneRecoveryPerThread(msg: RecoveryAnchor, run: () => Promise<void>): Promise<void> {
  const threadId = msg.effectiveThreadId ?? msg.channelId
  if (threadLockHeld(threadId)) {
    await gateway.send(msg.channelId, `⏳ A recovery of this thread is already in progress.`, { replyTo: msg.id }).catch(() => {})
    return
  }
  await withThreadLock(threadId, run)
}

// `resume <claudeSessionId>` reattaches an earlier conversation from this thread's
// history instead of the latest one (e.g. after an unwanted handoff).
export async function handleResumeIntercept(msg: RecoveryAnchor, claudeSessionIdArg?: string): Promise<void> {
  await oneRecoveryPerThread(msg, () => resumeThread(msg, claudeSessionIdArg))
}

async function resumeThread(msg: RecoveryAnchor, claudeSessionIdArg?: string): Promise<void> {
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

  let orphan: { info: SessionInfo; reason: string } | undefined
  // If thread has a live session, check if it's actually running
  const liveSessionId = registry.getByThread(threadId)
  if (liveSessionId) {
    const liveInfo = registry.get(liveSessionId)
    if (liveInfo) {
      const occ = occupancy(liveInfo)
      if (blocksRecovery(occ)) {
        const surfaceReady = adapterFor(liveInfo).surface(liveInfo) !== null
        void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})
        const note = occ === 'starting'
          ? `Session **${liveInfo.tmuxName}** is still starting up — give its bridge a moment to connect.`
          : `Session **${liveInfo.tmuxName}** is already running.${surfaceReady ? '' : ' Its interactive surface is unavailable; the server is alive and may still be reconnecting.'}`
        try { await gateway.send(msg.channelId, note, { replyTo: msg.id }) } catch {}
        return
      }
      // Orphaned: the process is up but unreachable. The revive tears it down (worktree kept) after taking what it
      // carries, so the cascade can reattach to its conversation.
      if (occ === 'orphaned') orphan = { info: liveInfo, reason: 'bridge was unreachable — reattaching to this conversation' }
      // Gone: mark it dead as the health poll would, so the poll doesn't announce a second death after this resume.
      else markDead(liveInfo)
    }
  }

  // Thread is detached: continue its latest conversation, or the named one.
  const entry = claudeSessionIdArg ? thread.sessionHistory.findLast(e => e.claudeSessionId === claudeSessionIdArg) : undefined
  if (claudeSessionIdArg && !entry) {
    await reportError(msg.channelId, msg.id, 'resume', `no session \`${claudeSessionIdArg}\` in this thread's history`)
    return
  }

  void gateway.react(msg.channelId, msg.id, '⏯️').catch(() => {})

  const outcome = await reviveThread({ thread, entry, orphan, ...byHand(threadId) })
  if (outcome.ok) {
    const { result } = outcome
    const note = result.bridgeOrphan ? registry.get(result.sessionId)?.channelNote : undefined
    const [method, emoji] = outcome.method === 'resumed'
      ? [result.bridgeOrphan
        ? `resumed — context restored, but bridge not yet connected (may need a moment)${note ? `. ${note}` : ''}`
        : 'resumed — full context restored', '⏯️']
      : outcome.method === 'forked'
        ? ['resumed (forked from dead session — transcript preserved)', '⏯️']
        : ['respawned (resume unavailable — reading thread history)', '🔁']
    await announceRecovery(msg, result, thread, method, emoji, outcome.lastTmuxName)
  } else if (outcome.busy) {
    await gateway.send(msg.channelId, `⏳ A resume of this session is already in progress.`, { replyTo: msg.id }).catch(() => {})
  } else {
    await reportError(msg.channelId, msg.id, 'resume', 'all recovery methods failed')
  }
}

export async function handleRespawnIntercept(msg: InboundMessage, topic?: string, templateName?: string, selection?: { model: string; engine: ProviderId }): Promise<void> {
  await oneRecoveryPerThread(msg, () => respawnThread(msg, topic, templateName, selection))
}

async function respawnThread(msg: InboundMessage, topic?: string, templateName?: string, selection?: { model: string; engine: ProviderId }): Promise<void> {
  if (!msg.isThread) {
    await reportError(msg.channelId, msg.id, 'respawn', 'must be used in a thread')
    return
  }

  // `respawn +mod:` — respawn applying a spawn template
  // modifier. The template's prompt/tool settings are layered onto the
  // resurrect spawn, which already instructs the session to reread the thread.
  const template = templateName ? getTemplate(templateName) : undefined
  if (templateName && !template) {
    await reportError(msg.channelId, msg.id, 'respawn', `unknown template "${templateName}"`)
    return
  }

  const threadId = msg.effectiveThreadId ?? msg.channelId
  const thread = threadRegistry.get(threadId)

  // A template layers tools and a session type onto the respawn; omp takes neither. Refused before anything is torn down.
  const earlier = recoveryEntry(thread?.sessionHistory ?? [])
  if (template && (selection?.engine ?? recoveryEngine(earlier, registry.get(earlier?.sessionId ?? ''))) === 'omp') {
    await reportError(msg.channelId, msg.id, 'respawn', 'templates (`+f`) are not available for omp sessions', 'Use a plain `respawn`.')
    return
  }

  let orphan: { info: SessionInfo; reason: string } | undefined
  const respawnLiveId = registry.getByThread(threadId)
  if (respawnLiveId) {
    const liveInfo = registry.get(respawnLiveId)
    if (liveInfo) {
      const occ = occupancy(liveInfo)
      if (blocksRecovery(occ)) {
        await reportError(msg.channelId, msg.id, 'respawn', `thread has a live session (**${liveInfo.tmuxName}**)`, 'Use `kill` first, or `spawn:` for a new thread.')
        return
      }
      // An orphaned session would otherwise wedge respawn behind a kill the alert never mentioned; the revive tears
      // it down after taking what it carries. Prefer resume, which keeps the transcript.
      if (occ === 'orphaned') orphan = { info: liveInfo, reason: 'bridge was unreachable — respawning' }
    }
  }

  void gateway.react(msg.channelId, msg.id, '🔁').catch(() => {})

  const resolvedTopic = topic || thread?.topic || 'respawned session'
  const resurrectFrom = recoveryEntry(thread?.sessionHistory ?? [])?.tmuxName
  // A template respawn layers the template's prompt/tool settings onto the resurrect spawn. `trigger` is kept so
  // the session's origin still reads as the template in the spawn announce + `list sessions`; its label wins.
  const outcome = await reviveThread({
    thread: thread ?? threadStub(threadId, resolvedTopic),
    respawnOnly: true, respawnTopic: resolvedTopic, orphan, ...byHand(threadId),
    ...(selection && { engine: selection.engine, model: selection.model }),
    ...(template && { respawnOpts: buildTemplateSpawnOpts(templateName!, template) }),
  })
  const result = outcome.ok ? outcome.result : undefined
  if (result) {
    const e = sessionEmoji(result.name)
    const count = thread?.respawnCount ?? 0
    const countLabel = count > 0 ? ` ${COUNT_EMOJI[Math.min(count - 1, COUNT_EMOJI.length - 1)]}` : ''
    const tplLabel = templateName ? ` (${templateName})` : ''
    try {
      const sent = await gateway.send(msg.channelId, `🔁 ${e} \`${result.name}\`${tplLabel} respawned${countLabel} — reading thread history.\nView in any terminal: \`tmux attach -t ${result.name}\``, { replyTo: msg.id })
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

  if (info && occupancy(info) !== 'dead') {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void safeSend(msg.channelId, `_Session **${info.tmuxName}** is still alive. Kill it first with \`kill\`._`)
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
    // No creator check any more, so the log is the record of who did it.
    process.stderr.write(`daemon: destroy: deleted thread ${threadId} (by ${msg.authorUsername})\n`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: destroy: thread deletion failed: ${errMsg}\n`)
    void safeSend(parentChannelId ?? msg.channelId, `_Thread deletion failed: ${errMsg}_`)
    return
  }

  // Clean up registry only after successful thread deletion
  if (info && sessionId) {
    registry.delete(sessionId)
    registry.deleteThread(threadId)
    registry.persist()
    unwatchBySession(info)
    emitSessionDeath(info)
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

export async function handlePeekIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  let info
  let name: string

  if (targetName) {
    info = [...registry.values()].find(s => s.tmuxName === targetName)
    if (!info && isForMain(msg) && (targetName === mainTmux() || targetName === 'main')) return peekMain(msg)
    if (!info) {
      void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
      void gateway.send(msg.channelId, `No session named **${targetName}**`, { replyTo: msg.id }).catch(() => {})
      return
    }
    name = info.tmuxName
  } else {
    info = registry.resolveThreadSessionFromMsg(msg)
    if (!info && isForMain(msg)) return peekMain(msg)
    if (!info) {
      void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
      return
    }
    name = info.tmuxName
  }

  const adapter = adapterFor(info)
  await sendPeek(msg, name, adapter.surface(info), () => {
    const model = info.sessionMetadata?.model ?? info.engine ?? '?'
    return `📸 **${name}** · \`${model}\` · ${formatContextPercent(adapter, info)} · ${info.messageCount ?? 0} msgs · ${formatDuration(Date.now() - info.createdAt)}`
  })
}

// Main has no registry record: no message count or model, only what its pane and tmux can say.
async function peekMain(msg: InboundMessage): Promise<void> {
  const name = mainTmux()
  await sendPeek(msg, name, claudeEngine.surface(mainSubject()), () =>
    `📸 **${name}** · main · ${mainContext() ?? '?'} · ${formatDuration(Date.now() - mainStartedAt())}`)
}

/** The pane screenshot (or text) of a session, under a header. target is the tmux surface, or null when there is none. */
async function sendPeek(msg: InboundMessage, name: string, target: string | null, header: () => string): Promise<void> {
  if (target === null) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `**${name}** interactive surface unavailable`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '📸').catch(() => {})
  const head = header()

  if (hasFreeze()) {
    const outPath = join(tmpdir(), `hydra-peek-${name}-${Date.now()}.png`)
    try {
      paneScreenshot(target, outPath)
      await gateway.send(msg.channelId, head, { files: [outPath], replyTo: msg.id })
      try { unlinkSync(outPath) } catch {}
      return
    } catch (err) {
      process.stderr.write(`daemon: peek screenshot failed: ${err}\n`)
      try { unlinkSync(outPath) } catch {}
    }
  }

  // Fallback: text capture
  try {
    const text = tmuxSync(['capture-pane', '-t', target, '-p', '-S', '-60']).trimEnd()
    await safeSend(msg.channelId, `${head}\n\`\`\`\n${(text || '(empty)').slice(-1800)}\n\`\`\``, { replyTo: msg.id })
  } catch (err) {
    await reportError(msg.channelId, msg.id, 'peek', `capture failed: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Handoff — ask the live session to write its state, then hand the thread to a
// fresh session (via the `handoff` tool, which does the kill + successor spawn)
// ---------------------------------------------------------------------------

export async function handleHandoffIntercept(msg: InboundMessage, selection?: { model: string; engine: ProviderId }, note?: string): Promise<void> {
  const threadId = msg.effectiveThreadId ?? msg.channelId
  const liveId = msg.isThread ? registry.getByThread(threadId) : undefined
  const info = liveId ? registry.get(liveId) : undefined
  if (!info) {
    await reportError(msg.channelId, msg.id, 'handoff', 'no live session in this thread', 'Use `respawn` to start one from the thread history.')
    return
  }
  requestHandoff(info, { channelId: msg.channelId, msgId: msg.id, threadId, requester: msg.authorUsername || 'the user', options: { selection, note } })
}
