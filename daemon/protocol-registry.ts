// Protocol registry — thread occupancy, participant routing, turn management.
// Each protocol registers its hooks at module scope; the registry provides
// unified queries (isThreadOccupied) and dispatch (reconnect/reply/disconnect/advance).
//
// For lifecycle events (review complete, session death, etc.) use event-bus.ts.

import { emit } from './event-bus.js'
import { computeToolsForSession, UNIVERSAL_TOOLS } from './bridge-tools.js'

type ProtocolHooks = {
  getByThread: (threadId: string) => boolean
  isParticipant: (sessionId: string) => boolean
  onReply: (sessionId: string, text: string, chatId: string, sentIds: string[]) => void | Promise<void>
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
  onAdvance?: (sessionId: string, content: string, verdict?: string) => Promise<{ ok: true; sentIds: string[] } | { ok: false; reason: string }>
  resolveScopedToolOverrides?: (sessionId: string, chatId?: string) => Record<string, string> | null
}

// Protocol names are plain strings — intentionally not a union type so new
// protocols can register without editing this file.
const protocols = new Map<string, ProtocolHooks>()

export function registerProtocol(name: string, hooks: ProtocolHooks): void {
  if (protocols.has(name)) throw new Error(`Protocol '${name}' is already registered`)
  protocols.set(name, hooks)
}


export function isThreadOccupied(threadId: string, exclude?: string): string | null {
  for (const [name, hooks] of protocols) {
    if (name === exclude) continue
    if (hooks.getByThread(threadId)) return name
  }
  return null
}

export function isProtocolPost(sessionId: string, chatId: string): boolean {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId) && hooks.getByThread(chatId)) return true
  }
  return false
}

// Session IDs are unique across protocols — at most one handler fires per dispatch.
export function dispatchReconnect(sessionId: string): void {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) { hooks.onReconnect(sessionId); break }
  }
}

async function dispatchReply(sessionId: string, text: string, chatId: string, sentIds: string[]): Promise<void> {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) { await hooks.onReply(sessionId, text, chatId, sentIds); break }
  }
}

// Encapsulates dispatch ordering: protocol registry processes the reply first,
// then the event bus notifies general subscribers (e.g. artifact extraction, dashboard refresh).
export async function dispatchSessionReply(sessionId: string, text: string, chatId: string, sentIds: string[]): Promise<void> {
  await dispatchReply(sessionId, text, chatId, sentIds)
  emit('reply', { sessionId, text, chatId, sentIds })
}

export function dispatchDisconnect(sessionId: string): boolean {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) { hooks.onDisconnect(sessionId); return true }
  }
  return false
}

export async function dispatchAdvance(sessionId: string, content: string, verdict?: string): Promise<{ ok: true; sentIds: string[] } | { ok: false; reason: string }> {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) {
      if (!hooks.onAdvance) return { ok: false, reason: 'this protocol does not support advance()' }
      return hooks.onAdvance(sessionId, content, verdict)
    }
  }
  return { ok: false, reason: 'no active protocol for this session' }
}

export function isActiveActor(sessionId: string, chatId?: string): boolean {
  const overrides = resolveScopedToolOverrides(sessionId, chatId)
  return overrides !== null && 'advance' in overrides
}

export function resolveScopedToolOverrides(sessionId: string, chatId?: string): Record<string, string> | null {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) return hooks.resolveScopedToolOverrides?.(sessionId, chatId) ?? null
  }
  return null
}

export function toolsForSession(sessionId: string, opts?: { allowMainTools?: boolean; chatId?: string }): typeof UNIVERSAL_TOOLS {
  const overrides = resolveScopedToolOverrides(sessionId, opts?.chatId) ?? undefined
  return computeToolsForSession(sessionId, { allowMainTools: opts?.allowMainTools, scopedToolOverrides: overrides })
}

export function _resetForTesting(): void { protocols.clear() }
