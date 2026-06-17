import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { gateway, STATE_DIR } from '../config.js'
import { registry, sessionEmoji } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { doSpawnSession, killSession } from '../session-lifecycle.js'
import { debouncedRefreshListDisplay } from './status.js'
import type { InboundMessage } from '../../gateway.js'
import type { Access } from '../access.js'

const RESTART_PENDING_FILE = join(STATE_DIR, 'restart-pending.json')

export async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚀').catch(() => {})

  // If spawn is typed in a thread with a dead session, target that thread so it gets reused
  let chatId = msg.channelId
  if (msg.isThread && msg.existingThreadId) {
    const staleId = registry.getByThread(msg.existingThreadId)
    if (staleId && registry.has(staleId)) {
      const staleInfo = registry.get(staleId)!
      let tmuxAlive = false
      try { execSync(`tmux has-session -t '${staleInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
      if (tmuxAlive) {
        try { await gateway.send(msg.channelId, `Thread already has a live session (**${staleInfo.tmuxName}**). Spawning in a new thread instead.`, { replyTo: msg.id }) } catch {}
      } else {
        chatId = msg.existingThreadId
      }
    } else {
      chatId = msg.existingThreadId
    }
  }

  try {
    const result = await doSpawnSession(topic, chatId, msg.id)

    if (msg.isDM) {
      const e = sessionEmoji(result.name)
      const base = (result.url && !gateway.canThreadInDM)
        ? `Spawned ${e} \`${result.name}\` — ${result.url}`
        : `Spawned ${e} \`${result.name}\``
      const reply = `${base}\nView in any terminal: \`tmux attach -t ${result.name}\``
      await gateway.send(msg.channelId, reply, { replyTo: msg.id })
    }

    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned ${sessionEmoji(result.name)} \`${result.name}\` for topic: ${topic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
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

  const restartScript = join(import.meta.dir, '..', '..', 'restart-daemon.sh')
  try {
    await gateway.send(msg.channelId, `🔄 Restarting daemon — back in a moment...`, { replyTo: msg.id })
  } catch {}

  try {
    const restartChatId = msg.isThread && msg.existingThreadId ? msg.existingThreadId : msg.channelId
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
    '**Commands**',
    '',
    '**Sessions:**',
    '• 🚀 `spawn: <topic>` — new session in its own thread',
    '• 🚀 `spawn-wt: <repo> <topic>` — new session in a git worktree',
    '• 📊 `list sessions` — show all running sessions',
    '• ☠️ `kill session: <name>` — terminate a named session',
    '• ☠️ `kill` — kill this session (thread-scoped)',
    '• 🍴 `fork` / `fork: <focus>` — fork into a new thread with full history',
    '• 🍽️ `forks` — list forks from this thread',
    '',
    '**Multi-agent:**',
    '• `build [N] [task]` — owner implements, critic reviews (default 3 rounds)',
    '• `build-wt: <repo> [N] [task]` — build in an isolated worktree',
    '• `kill build` — cancel an in-progress build',
    '• `/review [N] [topic]` — adversarial review: critic challenges, owner defends',
    '• `kill review` — cancel an in-progress review',
    '',
    '**Handoff & Recovery:**',
    '• 🤝 `handoff` / `handoff: <direction>` — distill context into an artifact',
    '• 🤝 `/go` — launch the handoff successor',
    '• ⏯️ `resume` — reconnect to a dead session with full context',
    '• 🔁 `respawn` — fresh session that reads thread history and continues',
    '• 🔮 `recover` — revive dead sessions from a crash',
    '',
    '**Session control:**',
    '• 👂/⏸️ `listen` / `pause` — toggle message routing to session',
    '• 📈 `usage` — context %, messages, runtime, fork count',
    '',
    '**Daemon:**',
    '• 💚 `health` / `status` — daemon diagnostics',
    '• 🔌 `reconnect` — re-establish chat connection',
    '• 🔄 `restart` — restart daemon (sessions reconnect)',
    '• 📋 `help` / `commands` — this list',
  ].join('\n')
  try { await gateway.send(msg.channelId, text, { replyTo: msg.id }) } catch {}
}
