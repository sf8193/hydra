/**
 * Codex runtime — the CodexEngine singleton, its events wired into the daemon
 * at module init, and the boot sweep the Codex adapter's start() runs.
 *
 * Codex app-servers outlive their replaceable tmux TUIs. This module owns the
 * engine event plumbing and reconnects transiently lost daemon connections.
 * Its listeners bind their dependencies (registry, reply guard, safeSend,
 * dispatchDisconnect) at import, as before, so an event that arrives before
 * start() behaves exactly as one after it.
 */

import { CodexEngine, type ReconciledTurn } from '../codex-engine.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { dispatchDisconnect } from '../protocol-registry.js'
import { handleSilenceEvent, noteActivityForSession } from '../reply-guard.js'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { safeSend } from '../util.js'
import { clearCodexKeys, flushCodexKeys } from '../codex-key-queue.js'
import { noteCodexMessage, noteCodexTurnState } from './codex-observation.js'
import { on } from '../event-bus.js'
import type { EngineAdapter } from './engine-adapter.js'

// reconnect is Codex-internal: not on EngineAdapter, but on every Codex record's adapter.
// A typed guard rather than instanceof: test fixtures stand in duck-typed adapters.
type Reconnectable = { reconnect(info: SessionInfo): Promise<boolean> }
const isReconnectable = (a: EngineAdapter): a is EngineAdapter & Reconnectable =>
  typeof (a as Partial<Reconnectable>).reconnect === 'function'
function reconnectOf(info: SessionInfo): Promise<boolean> {
  if (isReconnectable(info.adapter)) return info.adapter.reconnect(info)
  process.stderr.write(`codex-runtime: ${info.tmuxName} has no reconnectable adapter (${info.adapter.provider}); skipped\n`)
  return Promise.resolve(false)
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codexEngine = new CodexEngine()

export const CODEX_SURFACE_REPAIR_DELAYS_MS = [1_000, 3_000] as const

export function scheduleCodexSurfaceRepairs(
  sessionId: string,
  deps = {
    get: (id: string) => registry.get(id),
    ensure: (info: NonNullable<ReturnType<typeof registry.get>>) => !!info.adapter && info.adapter.surface(info) !== null,
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

codexEngine.on('message', (sessionId: string, text: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  info.lastActive = Date.now()
  if (info.turnState !== 'working') {
    info.turnState = 'working'
    noteActivityForSession(info.tmuxName)
  }
  noteCodexMessage(sessionId, text)
  noteCodexTurnState(sessionId, false) // still producing — not the final answer yet
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
  noteCodexTurnState(sessionId, true)
  // The remote TUI may exit with the completed turn. Repair its tmux surface
  // immediately so the next protocol turn/keys command has somewhere to land.
  info.adapter?.surface(info)
  // The remote TUI may disappear just after turn/completed. Recheck after that
  // teardown window; the provider is idempotent when the surface stayed alive.
  scheduleCodexSurfaceRepairs(sessionId)
  flushCodexKeys(sessionId)
  handleSilenceEvent(info.tmuxName)
})

// After a restart or reconnect: record what thread/resume says the last turn
// did, for the reply guard. Observation only — no surface repair, key flush or
// silence handling; the scheduler stays RPC-owned.
export function onTurnReconciled(sessionId: string, t: ReconciledTurn): void {
  if (!registry.get(sessionId)) return
  noteCodexTurnState(sessionId, true)
  // completedAt is epoch SECONDS, so `at` is floored: a turn that finished less
  // than 1s after the message was delivered reads as older than it and is
  // deliberately not relayed — erring toward never relaying a stale answer.
  // No completedAt → at 0: an answer of unknown age is never relayed as new.
  if (t.lastAgentText) noteCodexMessage(sessionId, t.lastAgentText, t.completedAt ? t.completedAt * 1000 : 0)
}
codexEngine.on('turnReconciled', onTurnReconciled)

codexEngine.on('turnStalled', (sessionId: string, reason: string) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `⚠️ Codex needs attention: ${reason || 'turn progress is unresolved.'}`)
})

codexEngine.on('turnDeliveryUnknown', (sessionId: string, _text: string, err: unknown) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `⚠️ Codex input delivery is uncertain; retaining it while checking thread history. ${String(err)}`)
})

on('delivery:failed', ({ sessionId, status, reason, messageId }) => {
  const info = registry.get(sessionId)
  if (!info) return
  const source = messageId ? ` (message ${messageId})` : ''
  const outcome = status === 'unknown' ? 'delivery is uncertain; no automatic replay' : 'delivery was rejected'
  void safeSend(info.threadId, `⚠️ Codex ${outcome}${source}: ${reason}`)
}, 'codex-bootstrap:delivery-failed')

codexEngine.on('usageWarning', (sessionId: string, usedPercent: number) => {
  const info = registry.get(sessionId)
  if (!info) return
  void safeSend(info.threadId, `⚠️ Codex usage at **${usedPercent}%** of weekly limit.`)
})

codexEngine.on('contextUsage', (sessionId: string, usage: { usedTokens: number; contextWindow: number; percent: number }) => {
  const info = registry.get(sessionId)
  if (!info) return
  info.contextUsage = { ...usage, updatedAt: Date.now() }
  registry.persist()
  logContextUsageSample(sessionId, info.tmuxName, usage)
})

// Append-only samples, one per turn (contextUsage fires once per completed
// turn). Registry only ever keeps the latest snapshot per session, so there's
// no history to compute turn-over-turn token growth from — this is that
// history, so "does turn count or payload size actually drive codex token
// cost" (open question from tonight's reviews) has real data to answer it
// from, instead of staying an assumption indefinitely.
const CONTEXT_USAGE_LOG = join(STATE_DIR, 'context-usage-samples.jsonl')
function logContextUsageSample(sessionId: string, tmuxName: string, usage: { usedTokens: number; contextWindow: number; percent: number }): void {
  try {
    appendFileSync(CONTEXT_USAGE_LOG, JSON.stringify({ ts: Date.now(), sessionId, tmuxName, ...usage }) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: failed to log context usage sample: ${err}\n`)
  }
}

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
      const ok = await reconnectOf(info)
      if (deps.get(sessionId) !== info) return false // replaced/removed meanwhile (invariant 10)
      if (!ok) continue
      delete info.deadAt
      deps.persist()
      info.adapter.surface(info)
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

// records: the Codex records at boot. Only live ones reconnect, one at a time.
export async function reconnectCodexSessions(records: readonly SessionInfo[]): Promise<void> {
  const codexSessions = records.filter(s => !s.deadAt)
  if (codexSessions.length === 0) return

  let reconnected = 0
  for (const info of codexSessions) {
    if (!info.adapter) continue
    const connected = await reconnectOf(info)

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
      info.adapter.surface(info)
      reconnected++
    }
  }
  registry.persist()
  if (reconnected > 0) process.stderr.write(`codex-bootstrap: reconnected ${reconnected} codex session(s)\n`)
}
