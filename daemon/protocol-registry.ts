// Protocol registry — eliminates cross-imports between protocol modules.
// Each protocol registers its hooks at module scope; the registry provides
// unified queries (isThreadOccupied) and dispatch (reconnect/reply/disconnect).
//
// Design decision: protocols are interchangeable for occupancy and
// participant-scoped dispatch. The registry encodes this — callers don't
// need to know which specific protocol is active, only that some protocol is.
// Protocol-specific routing behaviors (e.g., design answer interception)
// remain as direct imports in their consumers.

export type ProtocolName = 'review' | 'build' | 'design'

type ProtocolHooks = {
  getByThread: (threadId: string) => boolean
  isParticipant: (sessionId: string) => boolean
  onReply: (sessionId: string, text: string, chatId: string, sentIds: string[]) => void
  onDisconnect: (sessionId: string) => void
  onReconnect: (sessionId: string) => void
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

export function _resetForTesting(): void { protocols.clear() }
