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
    const ok = info.adapter
      ? await info.adapter.reconnect(info)
      : false
    if (!ok) {
      info.deadAt = Date.now()
    } else {
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
