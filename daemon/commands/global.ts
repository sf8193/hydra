import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { gateway, STATE_DIR, PLATFORM } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession, killSession } from '../session-lifecycle.js'
import { tmuxHasSession, safeSend } from '../util.js'
import { debouncedRefreshListDisplay } from './status.js'
import { getActiveReviews, cancelReview } from '../adversarial.js'
import type { SpawnTemplate } from '../templates.js'
import { buildTemplateSpawnOpts, runTemplateAction } from '../templates.js'
import type { InboundMessage } from '../../gateway.js'
import { type Access } from '../access.js'

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

function friendlySpawnError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('not a git repo') || msg.includes('not a git repository'))
    return `${msg}\n_Check that the target directory exists and is a git repository under \`$SPAWN_CWD\`._`
  if (msg.includes('SPAWN_CWD') || msg.includes('no such file or directory') && msg.includes('cwd'))
    return `${msg}\n_Set \`SPAWN_CWD\` in the daemon environment to the working directory for sessions._`
  if (msg.includes('failed to spawn tmux') || msg.includes('tmux: command not found'))
    return `${msg}\n_Is tmux installed? Try: \`brew install tmux\`_`
  if (msg.includes('thread has a live session'))
    return `${msg}\n_Kill the existing session first (\`kill\` in the thread), or \`spawn:\` in a different channel._`
  if (msg.includes('worktree') && (msg.includes('already exists') || msg.includes('EEXIST')))
    return `${msg}\n_A stale worktree may exist. Check with: \`git worktree list\`_`
  if (msg.includes('Cannot fork') || msg.includes('PM claude session ID not found'))
    return `${msg}\n_The PM session must be connected before forking. Try again after the PM bridge reconnects._`
  return msg
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
  const resolvedModel = model ?? template?.template.model
  const spawnOpts = {
    ...(template && buildTemplateSpawnOpts(template.name, template.template, model)),
    ...(!template && { trigger: 'spawn:' }),
    ...(engine && { engine }),
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
      try {
        await runTemplateAction(template.template.action, result.threadId, result.sessionId, topic)
        process.stderr.write(`daemon: template action: started ${template.template.action} for ${topic}\n`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`daemon: template action "${template.template.action}" failed: ${errMsg}\n`)
        void gateway.send(result.threadId, `_Action **${template.template.action}** failed: ${errMsg}_`).catch(() => {})
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
    const rawMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn failed: ${rawMsg}\n`)
    const friendlyMsg = friendlySpawnError(err)
    try { await gateway.send(msg.channelId, `Spawn failed: ${friendlyMsg}`, { replyTo: msg.id }) } catch {}
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
  const activeReviews = getActiveReviews()

  const cancelled = activeReviews.length
  const cancelNote = cancelled > 0 ? ` (cancelled ${cancelled} active build/review${cancelled > 1 ? 's' : ''})` : ''

  const hydraTs = join(import.meta.dir, '..', '..', 'cli', 'hydra.ts')
  const fast = /\+fast\b/.test(msg.content)
  const fastFlag = fast ? ' --fast' : ''
  const modeNote = fast ? '' : ' (validating)'
  try {
    await gateway.send(msg.channelId, `🔄 Restarting daemon${cancelNote}${modeNote} — back in a moment...`, { replyTo: msg.id })
  } catch {}

  try {
    const restartChatId = registry.resolveThreadId(msg)
    writeFileSync(RESTART_PENDING_FILE, JSON.stringify({ chatId: restartChatId, messageId: msg.id, ts: Date.now() }) + '\n')
  } catch {}

  let restartFailed = false
  try {
    execSync(`nohup bun "${hydraTs}" restart ${PLATFORM}${fastFlag} > /dev/null 2>&1 &`, {
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
    '• 🏭 `factory: <task>` — PM orchestrator: research → design → build → review → ship (also `spawn +f: <task>`)',
    '• 🎯 `review:` / `fix:` — templated session (`<template> <model>: topic`) · 📋 `templates`',
    '• 📊 `list sessions` — show all running sessions',
    '• ☠️ `kill session: <name>` — terminate a named session',
    '',
    '**Thread** (inside a session thread):',
    '• ⌨️ `keys <text>` — type text + Enter into the session (CC slash commands, etc.)',
    '• ⚡ `! <message>` — interrupt current work, then deliver',
    '• 🍴 `fork` / `fork: <focus>` / `fork <model>: <focus>` — fork with optional model override',
    '• 🍽️ `forks` — list forks from this thread',
    '• ☠️ `kill` — kill this session (factory builders keep running)',
    '• 🧨 `kill!` / `kill --cascade` — kill this session **and** its factory builds',
    '• 💀 `destroy` — permanently delete this thread + anchor (Discord only)',
    '• 💀 `kill +d` / `kill +destroy` — kill this session, then delete the thread',
    '• 👂 `listen` / 🔇 `unlisten` — mute/unmute message delivery',
    '• ⏸️ `pause` / ▶️ `unpause` — mark as paused (visual only)',
    '• 📸 `peek` / `peek <name>` — screenshot the tmux pane',
    '• 📈 `usage` — context %, messages, runtime',
    '',
    '**Multi-agent** (thread):',
    '• 🔨 `build [N] [model:] [task]` — implement + review cycle',
    '• ⚔️ `/review [N] [model:] [topic]` — adversarial review',
    '• 🔬 `spike [topic]` — single-agent deep investigation (checkpoints → decide done → report)',
    '• ⚔️ `review_v2 [N] [+s] [topic]` · 🔨 `build_v2 [N] [task]` — v2 protocols',
    '• 🚫 `kill build` / `kill review` / `kill spike`',
    '',
    '**Recovery** (thread, or channel for `recover`):',
    '• ⏯️ `resume` — reconnect with full context (--resume)',
    '• 🔁 `respawn` — fresh session, reads thread history (`respawn +f:` for a fresh factory PM)',
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
