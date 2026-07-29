/**
 * Codex Engine Bootstrap — initializes the CodexEngine singleton and wires
 * its events into the daemon's protocol dispatch system.
 *
 * Process model is identical to Claude: codex runs in tmux, daemon connects
 * to its unix socket. This module handles the event plumbing.
 */

import { CodexEngine, codexSocketPath } from './codex-engine.js'
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'
import { dispatchDisconnect } from './protocol-registry.js'
import { handleSilenceEvent, noteActivityForSession } from './reply-guard.js'
import { appendFileSync } from 'fs'
import { tmuxHasSession, safeSend } from './util.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codexEngine = new CodexEngine()

// Register with transport so sendOrQueue can route to it
transport.setCodexEngine(codexEngine)

// ---------------------------------------------------------------------------
// Event wiring — Codex engine events → daemon protocol dispatch
// ---------------------------------------------------------------------------

codexEngine.on('message', (sessionId: string, _text: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  info.lastActive = Date.now()
  if (info.turnState !== 'working') {
    info.turnState = 'working'
    noteActivityForSession(info.tmuxName)
  }
})

codexEngine.on('autoApproved', (sessionId: string, method: string) => {
  const info = registry.get(sessionId)
  if (info?.spawnLogPath) {
    try { appendFileSync(info.spawnLogPath, `[${new Date().toISOString()}] auto-approved: ${method}\n`) } catch {}
  }
})

codexEngine.on('turnCompleted', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  info.turnState = 'idle'
  handleSilenceEvent(info.tmuxName)
})

codexEngine.on('turnStalled', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `\u26a0\ufe0f Turn stalled (no activity for 20 minutes) — interrupted.`)
})

codexEngine.on('usageWarning', (sessionId: string, usedPercent: number) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `\u26a0\ufe0f Codex usage at **${usedPercent}%** of monthly limit.`)
})

codexEngine.on('disconnected', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (info && !info.deadAt && !tmuxHasSession(info.tmuxName)) {
    info.deadAt = Date.now()
    registry.persist()
  }
  dispatchDisconnect(sessionId)
})

// ---------------------------------------------------------------------------
// Reconnection — on daemon startup, reconnect persisted codex sessions
// ---------------------------------------------------------------------------

export async function reconnectCodexSessions(): Promise<void> {
  const codexSessions = [...registry.values()].filter(s => s.engine === 'codex' && !s.deadAt)
  if (codexSessions.length === 0) return

  let reconnected = 0
  for (const info of codexSessions) {
    if (!tmuxHasSession(info.tmuxName)) {
      info.deadAt = Date.now()
      continue
    }
    const sockPath = codexSocketPath(info.tmuxName)
    let connected = false

    // Strategy 1: resume existing thread (preserves conversation)
    if (info.codexThreadId) {
      try {
        await codexEngine.connectAndResume(info.sessionId, sockPath, info.codexThreadId)
        connected = true
        process.stderr.write(`codex-bootstrap: reconnected ${info.tmuxName} (resumed)\n`)
      } catch (err: any) {
        process.stderr.write(`codex-bootstrap: resume failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { codexEngine.disconnect(info.sessionId) } catch {}
        await new Promise(r => setTimeout(r, 2000)) // cooldown before fresh connect
      }
    }

    // Strategy 2: fresh thread (resume failed or no threadId)
    if (!connected) {
      const hadPriorThread = !!info.codexThreadId
      try {
        const result = await codexEngine.connect(info.sessionId, sockPath)
        info.codexThreadId = result.threadId
        connected = true
        if (hadPriorThread) {
          void safeSend(info.threadId, `\u26a0\ufe0f Session resumed but conversation history was lost. The agent is starting fresh.`)
        }
        process.stderr.write(`codex-bootstrap: reconnected ${info.tmuxName} (new thread)\n`)
      } catch (err: any) {
        process.stderr.write(`codex-bootstrap: fresh connect failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { codexEngine.disconnect(info.sessionId) } catch {}
      }
    }

    if (!connected) {
      info.deadAt = Date.now()
    } else {
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
