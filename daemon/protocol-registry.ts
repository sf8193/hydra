// Protocol registry — thread occupancy, participant routing, turn management.
// Each protocol registers its hooks at module scope; the registry provides
// unified queries (isThreadOccupied) and dispatch (reconnect/reply/disconnect).
//
// For lifecycle events (review complete, session death, etc.) use event-bus.ts.

import { emit } from './event-bus.js'

type ProtocolHooks = {
  getByThread: (threadId: string) => boolean
  isParticipant: (sessionId: string) => boolean
  onReply: (sessionId: string, text: string, chatId: string, sentIds: string[]) => void | Promise<void>
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
  onDecision?: (sessionId: string, value: string, because: string) => boolean | Promise<boolean>
  expectedTag?: (sessionId: string, chatId: string) => string | null
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

// True only when the session is a participant AND the same protocol occupies
// chatId — a role's posts to unrelated channels (DMs, other threads) are not
// protocol posts and must not leak session names there.
export function isProtocolPost(sessionId: string, chatId: string): boolean {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId) && hooks.getByThread(chatId)) return true
  }
  return false
}

export function getExpectedTag(sessionId: string, chatId: string): string | null {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) return hooks.expectedTag?.(sessionId, chatId) ?? null
  }
  return null
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

// Encapsulates dispatch ordering: protocol registry processes the reply first
// (e.g. review protocol advances round state), then the event bus notifies
// general subscribers (e.g. factory checks for [done]).
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

export async function dispatchDecision(sessionId: string, value: string, because: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) {
      if (!hooks.onDecision) return { ok: false, reason: 'this protocol does not support decide()' }
      const accepted = await hooks.onDecision(sessionId, value, because)
      if (!accepted) return { ok: false, reason: `decision "${value}" was not accepted (wrong phase, role, or invalid value)` }
      return { ok: true }
    }
  }
  return { ok: false, reason: 'no active protocol for this session' }
}

export function _resetForTesting(): void { protocols.clear() }
