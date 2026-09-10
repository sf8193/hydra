/**
 * Codex Engine Bootstrap — initializes the CodexEngine singleton and wires
 * its events into the daemon's protocol dispatch system.
 *
 * Codex app-servers outlive their replaceable tmux TUIs. This module owns the
 * engine event plumbing and reconnects transiently lost daemon connections.
 */

import { codexSocketPath } from './codex-engine.js'
import { transport } from './bridge-transport.js'
import { registry, threadRegistry } from './sessions.js'
import { dispatchDisconnect } from './protocol-registry.js'
import { handleSilenceEvent, noteActivityForSession } from './reply-guard.js'
import { appendFileSync } from 'fs'
import { safeSend } from './util.js'
import { clearCodexKeys, flushCodexKeys } from './codex-key-queue.js'
import { providerFor } from './session-provider.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

import { codexEngine } from './engines/instances.js'
export { codexEngine } from './engines/instances.js'

export const CODEX_SURFACE_REPAIR_DELAYS_MS = [1_000, 3_000] as const

export function scheduleCodexSurfaceRepairs(
  sessionId: string,
  deps = {
    get: (id: string) => registry.get(id),
    ensure: (info: NonNullable<ReturnType<typeof registry.get>>) => providerFor('codex').ensureInteractiveSurface(info),
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
  // The remote TUI may exit with the completed turn. Repair its tmux surface
  // immediately so the next protocol turn/keys command has somewhere to land.
  providerFor('codex').ensureInteractiveSurface(info)
  // The remote TUI may disappear just after turn/completed. Recheck after that
  // teardown window; the provider is idempotent when the surface stayed alive.
  scheduleCodexSurfaceRepairs(sessionId)
  flushCodexKeys(sessionId)
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
    resume: async (id: string, socket: string, thread: string) => {
      const result = await codexEngine.connectAndResume(id, socket, thread)
      const info = registry.get(id)
      if (info?.sessionMetadata && result.model) {
        info.sessionMetadata.model = result.model
        const entry = threadRegistry.get(info.threadId)?.sessionHistory.find(e => e.sessionId === id)
        if (entry) entry.model = result.model
        threadRegistry.persist()
      }
    },
    wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    ensure: (info: NonNullable<ReturnType<typeof registry.get>>) => providerFor('codex').ensureInteractiveSurface(info),
    persist: () => registry.persist(),
    failed: (id: string) => dispatchDisconnect(id),
  },
): Promise<boolean> {
  const delays = [250, 750, 1_500]
  for (const delay of delays) {
    await deps.wait(delay)
    const info = deps.get(sessionId)
    if (!info || info.engine !== 'codex' || !info.codexThreadId) return false
    try {
      await deps.resume(sessionId, codexSocketPath(info.codexHomeName ?? info.tmuxName), info.codexThreadId)
      delete info.deadAt
      deps.persist()
      deps.ensure(info)
      process.stderr.write(`codex-bootstrap: restored app-server connection for ${info.tmuxName}\n`)
      return true
    } catch (err) {
      process.stderr.write(`codex-bootstrap: reconnect attempt failed for ${info.tmuxName}: ${err}\n`)
      try { codexEngine.disconnect(sessionId) } catch {}
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
    const sockPath = codexSocketPath(info.codexHomeName ?? info.tmuxName)
    let connected = false

    // Strategy 1: resume existing thread (preserves conversation)
    if (info.codexThreadId) {
      try {
        const result = await codexEngine.connectAndResume(info.sessionId, sockPath, info.codexThreadId)
        if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
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
        if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
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
      delete info.deadAt
      const entry = threadRegistry.get(info.threadId)?.sessionHistory.find(e => e.sessionId === info.sessionId)
      if (entry) {
        entry.codexThreadId = info.codexThreadId
        entry.codexHomeName = info.codexHomeName ?? info.tmuxName
        entry.model = info.sessionMetadata?.model
        threadRegistry.persist()
      }
      providerFor('codex').ensureInteractiveSurface(info)
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
