import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { gateway, STATE_DIR } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import type { ThreadMetadata } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession, killSession, tryResume, tryRespawn, discoverClaudeSessionId } from '../session-lifecycle.js'
import { tmuxHasSession, isAlive, safeSend } from '../util.js'
import { debouncedRefreshListDisplay } from './status.js'
import { getActiveBuilds, cancelBuild, startBuild } from '../build.js'
import { getActiveReviews, cancelReview, startReview } from '../adversarial.js'
import { startDesign } from '../design.js'
import type { SpawnTemplate } from '../templates.js'
import type { InboundMessage } from '../../gateway.js'
import type { Access } from '../access.js'

const RESTART_PENDING_FILE = join(STATE_DIR, 'restart-pending.json')

async function resolveSpawnTarget(msg: InboundMessage): Promise<string> {
  let chatId = msg.channelId
  const resolvedThreadId = registry.resolveThreadId(msg)
  if (msg.isThread && resolvedThreadId !== msg.channelId) {
    const staleId = registry.getByThread(resolvedThreadId)
    if (staleId && registry.has(staleId)) {
      const staleInfo = registry.get(staleId)!
      if (tmuxHasSession(staleInfo.tmuxName)) {
        try { await gateway.send(msg.channelId, `Thread already has a live session (**${staleInfo.tmuxName}**). Spawning in a new thread instead.`, { replyTo: msg.id }) } catch {}
      } else {
        chatId = resolvedThreadId
      }
    } else {
      chatId = resolvedThreadId
    }
  }
  return chatId
}

async function spawnAndNotify(
  msg: InboundMessage,
  topic: string,
  template?: { name: string; template: SpawnTemplate },
  model?: string,
  engine?: 'claude' | 'codex',
): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚀').catch(() => {})
  const chatId = await resolveSpawnTarget(msg)
  const label = template?.name ?? null
  // Model priority: chat/CLI alias (router.ts / hydra.ts) > template.model (here)
  //   > HYDRA_MODEL env > DEFAULT_MODEL (shared/constants.ts via spawnModel())
  const resolvedModel = model ?? template?.template.model
  const spawnOpts = {
    ...(template && { promptPrefix: template.template.prompt }),
    ...(resolvedModel && { model: resolvedModel }),
    ...(engine && { engine }),
    trigger: template ? `${template.name}:` : 'spawn:',
    initiator: msg.authorUsername,
  }

  try {
    const result = await doSpawnSession(topic, chatId, msg.id, spawnOpts)

    if (label || resolvedModel) {
      const parts: string[] = []
      if (label) parts.push(`**${label}** template`)
      if (resolvedModel) parts.push(`model \`${resolvedModel}\``)
      process.stderr.write(`daemon: ${label ? `template "${label}" ` : ''}spawned ${result.name} for: ${topic}${resolvedModel ? ` (model: ${resolvedModel})` : ''}\n`)
      void gateway.send(result.threadId, `_Using ${parts.join(' · ')}_`).catch(() => {})
    }

    if (template?.template.action) {
      const action = template.template.action
      try {
        switch (action) {
          case 'design':
            await startDesign(result.threadId, topic)
            break
          case 'review':
            await startReview(result.threadId, result.sessionId, 3, topic)
            break
          case 'build':
            await startBuild(result.threadId, result.sessionId, 3, topic)
            break
        }
        process.stderr.write(`daemon: template action: started ${action} for ${topic}\n`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`daemon: template action "${action}" failed: ${errMsg}\n`)
        void gateway.send(result.threadId, `_Action **${action}** failed: ${errMsg}_`).catch(() => {})
      }
    }

    if (msg.isDM) {
      const e = sessionEmoji(result.name)
      const suffix = label ? ` (${label})` : ''
      const base = (result.url && !gateway.canThreadInDM)
        ? `Spawned ${e} \`${result.name}\`${suffix} — ${result.url}`
        : `Spawned ${e} \`${result.name}\`${suffix}`
      const reply = `${base}\nView in any terminal: \`tmux attach -t ${result.name}\``
      await gateway.send(msg.channelId, reply, { replyTo: msg.id })
    }

    const mainBridge = transport.get('main')
    if (mainBridge) {
      const labelSuffix = label ? ` (${label})` : ''
      const modelSuffix = resolvedModel ? ` [${resolvedModel}]` : ''
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned ${sessionEmoji(result.name)} \`${result.name}\`${labelSuffix}${modelSuffix} for: ${topic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

export async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access, model?: string, engine?: 'claude' | 'codex'): Promise<void> {
  // Also parse --codex flag from topic (fallback for non-prefix usage)
  let resolvedEngine = engine
  let cleanTopic = topic
  if (!resolvedEngine && /\s*--codex\b/.test(topic)) {
    resolvedEngine = 'codex'
    cleanTopic = topic.replace(/\s*--codex\b/, '').trim()
  }
  await spawnAndNotify(msg, cleanTopic, undefined, model, resolvedEngine)
}

export async function handleTemplateSpawn(msg: InboundMessage, templateName: string, topic: string, template: SpawnTemplate, access: Access, model?: string): Promise<void> {
  if (!topic.trim()) {
    await gateway.send(msg.channelId, `_\`${templateName}:\` needs a topic — e.g. \`${templateName}: describe the task\`_`, { replyTo: msg.id })
    return
  }
  await spawnAndNotify(msg, topic, { name: templateName, template }, model)
}

export async function handleKillIntercept(msg: InboundMessage, name: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  let target: ReturnType<typeof registry.get>
  for (const s of registry.values()) {
    if (s.tmuxName === name || s.topic.toLowerCase() === name.toLowerCase()) {
      target = s
      break
    }
  }
  if (!target) {
    try { await gateway.send(msg.channelId, `No session found matching "${name}"`, { replyTo: msg.id }) } catch {}
    return
  }
  await killSession(target, 'session ended')
  try { await gateway.send(msg.channelId, `Killed session **${target.tmuxName}**`, { replyTo: msg.id }) } catch {}
  debouncedRefreshListDisplay()
}

export async function handleRestartIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔄').catch(() => {})

  // Cancel active builds/reviews before restart — critics are join members
  // that get killed on restart, so cancel cleanly first
  const activeBuilds = getActiveBuilds()
  const activeReviews = getActiveReviews()
  for (const build of activeBuilds) {
    process.stderr.write(`daemon: restart: cancelling active build ${build.buildId.slice(0, 8)}\n`)
    await cancelBuild(build.buildId).catch(err => {
      process.stderr.write(`daemon: restart: cancelBuild failed: ${err}\n`)
    })
  }
  for (const review of activeReviews) {
    process.stderr.write(`daemon: restart: cancelling active review ${review.reviewId.slice(0, 8)}\n`)
    await cancelReview(review.reviewId).catch(err => {
      process.stderr.write(`daemon: restart: cancelReview failed: ${err}\n`)
    })
  }

  const cancelled = activeBuilds.length + activeReviews.length
  const cancelNote = cancelled > 0 ? ` (cancelled ${cancelled} active build/review${cancelled > 1 ? 's' : ''})` : ''

  const restartScript = join(import.meta.dir, '..', '..', 'restart-daemon.sh')
  try {
    await gateway.send(msg.channelId, `🔄 Restarting daemon${cancelNote} — back in a moment...`, { replyTo: msg.id })
  } catch {}

  try {
    const restartChatId = registry.resolveThreadId(msg)
    writeFileSync(RESTART_PENDING_FILE, JSON.stringify({ chatId: restartChatId, messageId: msg.id, ts: Date.now() }) + '\n')
  } catch {}

  let restartFailed = false
  try {
    execSync(`nohup bash "${restartScript}" > /dev/null 2>&1 &`, {
      stdio: 'pipe',
      timeout: 10_000,
      shell: '/bin/bash',
      env: { ...process.env, PATH: `${homedir()}/.asdf/shims:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    })
  } catch (err) {
    restartFailed = true
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: restart failed: ${errMsg}\n`)
  }
  if (restartFailed) {
    try { unlinkSync(RESTART_PENDING_FILE) } catch {}
    try {
      await gateway.send(msg.channelId, `❌ Restart failed — daemon is still running on old code.`, { replyTo: msg.id })
    } catch {}
  }
}

export async function announceRestartComplete(): Promise<void> {
  try {
    const raw = readFileSync(RESTART_PENDING_FILE, 'utf8')
    const { chatId, messageId, ts } = JSON.parse(raw) as { chatId: string; messageId: string; ts: number }
    unlinkSync(RESTART_PENDING_FILE)
    const elapsedSec = Math.round((Date.now() - ts) / 1000)
    await gateway.send(chatId, `✨ Back online — restart took ${elapsedSec}s.`, { replyTo: messageId })
  } catch {}
}

export async function handleReconnectIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔌').catch(() => {})
  if (!gateway.forceReconnect) {
    try { await gateway.send(msg.channelId, `Reconnect not supported on this platform.`, { replyTo: msg.id }) } catch {}
    return
  }
  const result = await gateway.forceReconnect()
  const emoji = result.ok ? '✅' : '❌'
  try { await gateway.send(msg.channelId, `${emoji} ${result.message}`, { replyTo: msg.id }) } catch {}
}

export async function handleCommandsIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📋').catch(() => {})
  const text = [
    '**Help / Commands**',
    '',
    '**Channel** (work anywhere):',
    '• 🚀 `spawn: <topic>` — new session in its own thread',
    '• 🚀 `spawn <model>: <topic>` — spawn with model (sonnet, haiku, fable, etc)',
    '• 🚀 `spawn-wt: <repo> <topic>` — spawn in a git worktree',
    '• 🎯 `review:` / `fix:` / `design:` — templated session (`<template> <model>: topic`) · 📋 `templates`',
    '• 📊 `list sessions` — show all running sessions',
    '• ☠️ `kill session: <name>` — terminate a named session',
    '',
    '**Thread** (inside a session thread):',
    '• ⚡ `! <message>` — interrupt current work, then deliver',
    '• 🍴 `fork` / `fork: <focus>` / `fork <model>: <focus>` — fork with optional model override',
    '• 🍽️ `forks` — list forks from this thread',
    '• ☠️ `kill` — kill this session',
    '• 👂 `listen` / 🔇 `unlisten` — mute/unmute message delivery',
    '• ⏸️ `pause` / ▶️ `unpause` — mark as paused (visual only)',
    '• 📈 `usage` — context %, messages, runtime',
    '',
    '**Multi-agent** (thread):',
    '• 🔨 `build [N] [model:] [task]` — implement + review cycle',
    '• 🏗️ `build-wt: <repo> [N] [model:] [task]` — build in a worktree',
    '• ⚔️ `/review [N] [model:] [topic]` — adversarial review',
    '• 🎨 `design: <topic>` — multi-persona design session',
    '• 🔬 `spike [topic]` — single-agent deep investigation (checkpoints → decide done → report)',
    '• ⚔️ `review_v2 [N] [+s] [topic]` · 🔨 `build_v2 [N] [task]` — v2 protocols',
    '• 🚫 `kill build` / `kill review` / `kill design` / `kill spike`',
    '',
    '**Recovery** (thread, or channel for `recover`):',
    '• ⏯️ `resume` — reconnect with full context (--resume)',
    '• 🔁 `respawn` — fresh session, reads thread history',
    '• 🔮 `recover [name]` — revive dead sessions from a crash',
    '',
    '**PR watching** (thread):',
    '• 👁️ `watch [pr-url]` — auto-detect or specify PR to watch',
    '• 🙈 `unwatch <pr-url>` · 📡 `watches` — list watched PRs',
    '',
    '**Daemon:**',
    '• 💚 `health` · 🧩 `protocols` · 🔌 `reconnect` · 🔄 `restart`',
    '• 📋 `help` / `commands` — this list',
  ].join('\n')
  await safeSend(msg.channelId, text, { replyTo: msg.id })
}

// ---------------------------------------------------------------------------
// Recover — crash recovery via resume or resurrect
// ---------------------------------------------------------------------------

let recoveryInProgress = false
const MAX_CONCURRENT = 2
const STAGGER_MS = 5_000

function findDeadSessions(): Array<{ thread: ThreadMetadata; claudeSessionId?: string; lastTmuxName: string; model?: string }> {
  const results: Array<{ thread: ThreadMetadata; claudeSessionId?: string; lastTmuxName: string; model?: string }> = []

  // Check all sessions in registry for dead ones
  for (const info of registry.values()) {
    if (info.isJoinMember) continue
    if (isAlive(info)) continue

    const thread = threadRegistry.get(info.threadId)
    if (!thread) continue
    results.push({
      thread,
      claudeSessionId: info.claudeSessionId,
      lastTmuxName: info.tmuxName,
      model: info.capabilities?.model,
    })
  }

  return results
}

async function recoverOne(dead: { thread: ThreadMetadata; claudeSessionId?: string; lastTmuxName: string; model?: string }): Promise<{ name: string; method: 'resumed' | 'forked' | 'resurrected'; newName: string; threadUrl?: string } | { name: string; method: 'failed'; reason: string; threadUrl?: string }> {
  const { thread, claudeSessionId, lastTmuxName, model } = dead

  if (claudeSessionId) {
    // Tier 1: full resume
    const result = await tryResume({
      topic: thread.topic,
      threadId: thread.threadId,
      claudeSessionId,
      threadUrl: thread.threadUrl,
      model,
    })
    if (result) {
      return { name: lastTmuxName, method: 'resumed', newName: result.name, threadUrl: thread.threadUrl }
    }
    process.stderr.write(`daemon: recover ${lastTmuxName}: resume failed, trying fork-from-dead\n`)

    // Tier 2: fork from dead session (best-effort, short timeout)
    try {
      const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
        existingThreadId: thread.threadId,
        forkFrom: { claudeSessionId, parentName: lastTmuxName },
        model,
      })
      return { name: lastTmuxName, method: 'forked', newName: forkResult.name, threadUrl: thread.threadUrl }
    } catch {
      process.stderr.write(`daemon: recover ${lastTmuxName}: fork failed, falling back to resurrect\n`)
    }
  }

  // Tier 3: respawn
  const result = await tryRespawn(thread.threadId, thread.topic, lastTmuxName, model)
  if (result) {
    return { name: lastTmuxName, method: 'resurrected', newName: result.name, threadUrl: thread.threadUrl }
  }
  return { name: lastTmuxName, method: 'failed', reason: 'all recovery methods failed', threadUrl: thread.threadUrl }
}

export async function handleRecoverIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  if (recoveryInProgress) {
    try { await gateway.send(msg.channelId, 'Recovery already in progress.', { replyTo: msg.id }) } catch {}
    return
  }

  const deadSessions = findDeadSessions()
  if (deadSessions.length === 0) {
    try { await gateway.send(msg.channelId, 'No dead sessions found.', { replyTo: msg.id }) } catch {}
    return
  }

  let targets = deadSessions
  if (targetName && targetName !== 'all') {
    targets = targets.filter(d => d.lastTmuxName === targetName)
    if (targets.length === 0) {
      try { await gateway.send(msg.channelId, `"${targetName}" not found in dead sessions.`, { replyTo: msg.id }) } catch {}
      return
    }
  }

  // Sort by most recently active first
  targets.sort((a, b) => b.thread.lastActive - a.thread.lastActive)

  recoveryInProgress = true
  try {
    await gateway.send(msg.channelId, `Recovering ${targets.length} session(s)...`, { replyTo: msg.id })
  } catch {}

  const results: Awaited<ReturnType<typeof recoverOne>>[] = []

  try {
    // Process in waves of MAX_CONCURRENT with STAGGER_MS between each within a wave
    for (let i = 0; i < targets.length; i += MAX_CONCURRENT) {
      const wave = targets.slice(i, i + MAX_CONCURRENT)
      const wavePromises = wave.map(async (dead, j) => {
        if (j > 0) await new Promise(r => setTimeout(r, STAGGER_MS * j))
        try {
          const r = await recoverOne(dead)
          if (r.method !== 'failed') {
            const e = sessionEmoji(r.newName)
            void gateway.send(dead.thread.threadId, `${e} \`${r.newName}\` recovered (${r.method})`).catch(() => {})
          }
          return r
        } catch (err) {
          return { name: dead.lastTmuxName, method: 'failed' as const, reason: String(err) }
        }
      })
      const settled = await Promise.allSettled(wavePromises)
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
      }
    }
  } finally {
    recoveryInProgress = false
  }

  const resumed = results.filter(r => r.method === 'resumed')
  const forked = results.filter(r => r.method === 'forked')
  const resurrected = results.filter(r => r.method === 'resurrected')
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string }>

  const fmtName = (r: { name: string; threadUrl?: string }) =>
    r.threadUrl ? `[\`${r.name}\`](${r.threadUrl})` : `\`${r.name}\``

  const lines = [`**Recovery complete** — ${results.length} session(s)`]
  if (resumed.length > 0) lines.push(`• ${resumed.length} resumed (full context): ${resumed.map(fmtName).join(', ')}`)
  if (forked.length > 0) lines.push(`• ${forked.length} forked (transcript preserved): ${forked.map(fmtName).join(', ')}`)
  if (resurrected.length > 0) lines.push(`• ${resurrected.length} resurrected (thread re-read): ${resurrected.map(fmtName).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `${fmtName(r)} (${r.reason})`).join(', ')}`)

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}
