/**
 * Codex Engine Bootstrap — initializes the CodexEngine singleton and wires
 * its events into the daemon's protocol dispatch system.
 */

import { CodexEngine } from './codex-engine.js'
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'
import { dispatchReply, dispatchDisconnect } from './protocol-registry.js'
import { gateway } from './config.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codexEngine = new CodexEngine()

// Register with transport so sendOrQueue can route to it
transport.setCodexEngine(codexEngine)

// ---------------------------------------------------------------------------
// Event wiring — Codex engine events → daemon protocol dispatch
// ---------------------------------------------------------------------------

codexEngine.on('message', (sessionId: string, text: string) => {
  const info = registry.get(sessionId)
  if (!info) return

  info.lastActive = Date.now()
  info.messageCount = (info.messageCount ?? 0) + 1

  // Post the message to the session's Discord/Slack thread
  void gateway.send(info.threadId, text).then(sentMsg => {
    const sentIds = sentMsg?.id ? [sentMsg.id] : []
    // Feed into protocol dispatch (review, build, design state machines)
    dispatchReply(sessionId, text, info.threadId, sentIds)
  }).catch(err => {
    process.stderr.write(`codex-bootstrap: failed to send message for ${sessionId}: ${err}\n`)
  })
})

codexEngine.on('disconnected', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (info && !info.deadAt) {
    info.deadAt = Date.now()
    registry.persist()
  }
  dispatchDisconnect(sessionId)
})


codexEngine.on('spawnError', (sessionId: string, err: Error) => {
  const info = registry.get(sessionId)
  if (info) {
    void gateway.send(info.threadId, `Codex session failed to start: ${err.message}`).catch(() => {})
  }
})
