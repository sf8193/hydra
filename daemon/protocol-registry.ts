// Protocol registry — eliminates cross-imports between protocol modules.
// Each protocol registers its hooks at module scope; the registry provides
// unified queries (isThreadOccupied) and dispatch (reconnect/reply/disconnect).
//
// Design decision: protocols are interchangeable for occupancy and
// participant-scoped dispatch. The registry encodes this — callers don't
// need to know which specific protocol is active, only that some protocol is.
// Protocol-specific routing behaviors (e.g., design answer interception)
// remain as direct imports in their consumers.

export type ProtocolName = 'review' | 'build' | 'design' | 'review_v2' | 'build_v2' | 'spike_v2'

type ProtocolHooks = {
  getByThread: (threadId: string) => boolean
  isParticipant: (sessionId: string) => boolean
  onReply: (sessionId: string, text: string, chatId: string, sentIds: string[]) => void
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
  onDecision?: (sessionId: string, value: string, because: string) => boolean
  expectedTag?: (sessionId: string, chatId: string) => string | null
}

const protocols = new Map<ProtocolName, ProtocolHooks>()

export function registerProtocol(name: ProtocolName, hooks: ProtocolHooks): void {
  if (protocols.has(name)) throw new Error(`Protocol '${name}' is already registered`)
  protocols.set(name, hooks)
}

export function isThreadOccupied(threadId: string, exclude?: ProtocolName): ProtocolName | null {
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

export function dispatchReply(sessionId: string, text: string, chatId: string, sentIds: string[]): void {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) { hooks.onReply(sessionId, text, chatId, sentIds); break }
  }
}

export function dispatchDisconnect(sessionId: string): void {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) { hooks.onDisconnect(sessionId); break }
  }
}

export function dispatchDecision(sessionId: string, value: string, because: string): { ok: true } | { ok: false; reason: string } {
  for (const hooks of protocols.values()) {
    if (hooks.isParticipant(sessionId)) {
      if (!hooks.onDecision) return { ok: false, reason: 'this protocol does not support decide()' }
      const accepted = hooks.onDecision(sessionId, value, because)
      if (!accepted) return { ok: false, reason: `decision "${value}" was not accepted (wrong phase, role, or invalid value)` }
      return { ok: true }
    }
  }
  return { ok: false, reason: 'no active protocol for this session' }
}

export function _resetForTesting(): void { protocols.clear() }
