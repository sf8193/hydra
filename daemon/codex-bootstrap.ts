/**
 * Codex Engine Bootstrap — initializes the CodexEngine singleton and wires
 * its events into the daemon's protocol dispatch system.
 *
 * Codex app-servers outlive their replaceable tmux TUIs. This module owns the
 * engine event plumbing and reconnects transiently lost daemon connections.
 */

import { CodexEngine } from './codex-engine.js'
import { registry, threadRegistry } from './sessions.js'
import { dispatchDisconnect } from './protocol-registry.js'
import { handleSilenceEvent, noteActivityForSession } from './reply-guard.js'
import { appendFileSync } from 'fs'
import { safeSend } from './util.js'
import { clearCodexKeys, flushCodexKeys } from './codex-key-queue.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codexEngine = new CodexEngine()

export const CODEX_SURFACE_REPAIR_DELAYS_MS = [1_000, 3_000] as const

export function scheduleCodexSurfaceRepairs(
  sessionId: string,
  deps = {
    get: (id: string) => registry.get(id),
    ensure: (info: NonNullable<ReturnType<typeof registry.get>>) => info.adapter?.ensureSurface(info) ?? false,
    schedule: (fn: () => void, delay: number) => setTimeout(fn, delay),
  },
): void {
  for (const delay of CODEX_SURFACE_REPAIR_DELAYS_MS) {
    deps.schedule(() => {
      const current = deps.get(sessionId)
      if (!current || current.deadAt || current.engine !== 'codex') return
      deps.ensure(current)
    }, delay)
  }
}

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
  // The remote TUI may exit with the completed turn. Repair its tmux surface
  // immediately so the next protocol turn/keys command has somewhere to land.
  info.adapter?.ensureSurface(info)
  // The remote TUI may disappear just after turn/completed. Recheck after that
  // teardown window; the provider is idempotent when the surface stayed alive.
  scheduleCodexSurfaceRepairs(sessionId)
  flushCodexKeys(sessionId)
  handleSilenceEvent(info.tmuxName)
})

codexEngine.on('turnStalled', (sessionId: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `⚠️ Turn stalled (no activity for 20 minutes) — interrupted.`)
})

codexEngine.on('usageWarning', (sessionId: string, usedPercent: number) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `⚠️ Codex usage at **${usedPercent}%** of monthly limit.`)
})

codexEngine.on('contextUsage', (sessionId: string, usage: { usedTokens: number; contextWindow: number; percent: number }) => {
  const info = registry.get(sessionId)
  if (!info) return
  info.contextUsage = { ...usage, updatedAt: Date.now() }
  registry.persist()
})

const reconnecting = new Set<string>()

export async function reconnectCodexAfterDisconnect(
  sessionId: string,
  deps = {
    get: (id: string) => registry.get(id),
    wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    persist: () => registry.persist(),
    failed: (id: string) => dispatchDisconnect(id),
  },
): Promise<boolean> {
  const delays = [250, 750, 1_500]
  for (const delay of delays) {
    await deps.wait(delay)
    const info = deps.get(sessionId)
    if (!info || info.engine !== 'codex' || !info.codexThreadId || !info.adapter) return false
    try {
      const ok = await info.adapter.reconnect(info)
      if (!ok) continue
      delete info.deadAt
      deps.persist()
      info.adapter.ensureSurface(info)
      process.stderr.write(`codex-bootstrap: restored app-server connection for ${info.tmuxName}\n`)
      return true
    } catch (err) {
      process.stderr.write(`codex-bootstrap: reconnect attempt failed for ${info.tmuxName}: ${err}\n`)
    }
  }

  const info = deps.get(sessionId)
  if (info && !info.deadAt) {
    info.deadAt = Date.now()
    deps.persist()
  }
  clearCodexKeys(sessionId)
  deps.failed(sessionId)
  return false
}

codexEngine.on('disconnected', (sessionId: string) => {
  if (reconnecting.has(sessionId)) return
  reconnecting.add(sessionId)
  void reconnectCodexAfterDisconnect(sessionId).finally(() => reconnecting.delete(sessionId))
})

// ---------------------------------------------------------------------------
// Reconnection — on daemon startup, reconnect persisted codex sessions
// ---------------------------------------------------------------------------

export async function reconnectCodexSessions(): Promise<void> {
  const codexSessions = [...registry.values()].filter(s => s.engine === 'codex' && !s.deadAt)
  if (codexSessions.length === 0) return

  let reconnected = 0
  for (const info of codexSessions) {
    if (!info.adapter) continue
    const connected = await info.adapter.reconnect(info)

    if (!connected) {
      info.deadAt = Date.now()
    } else {
      delete info.deadAt
      const entry = threadRegistry.get(info.threadId)?.sessionHistory.find(e => e.sessionId === info.sessionId)
      if (entry) {
        entry.codexThreadId = info.codexThreadId
        entry.codexHomeName = info.codexHomeName ?? info.tmuxName
        entry.model = info.sessionMetadata?.model
        threadRegistry.persist()
      }
      info.adapter.ensureSurface(info)
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
