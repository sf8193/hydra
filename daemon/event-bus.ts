// Typed event bus — decouples producers from consumers across the daemon.
//
// Protocols emit events (review lifecycle, session replies, deaths).
// Any module can subscribe without importing the emitter.
// Each listener is isolated: a throw logs and continues to the next.
// Listeners are sync fire-and-forget — async work must handle its own errors.
//
// Extensible: other modules can augment EventMap via:
//   declare module './event-bus' { interface EventMap { 'my:event': { ... } } }

export interface EventMap {
  'reply': { sessionId: string; text: string; chatId: string; sentIds: string[] }
  'session:death': { sessionId: string; threadId: string; wasOwner: boolean; tmuxName: string }
}

type Listener<T> = (payload: T) => void
type LabeledListener = { listener: Listener<any>; label: string }
type SubscriptionContributor = { source: string; getLabels: () => Record<string, string[]> }

const listeners = new Map<string, Set<LabeledListener>>()
const contributors: SubscriptionContributor[] = []

export function contributeSubscriptions(source: string, getLabels: () => Record<string, string[]>): void {
  contributors.push({ source, getLabels })
}

export function on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>, label: string): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  const set = listeners.get(event)!
  const entry = { listener, label }
  set.add(entry)
  return () => { set.delete(entry) }
}

export function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  const set = listeners.get(event)
  if (!set) return
  // Snapshot: a listener may trigger another emit() for the same event.
  // Re-entrant emits are depth-first — inner emit runs to completion
  // before the outer emit resumes delivering to remaining listeners.
  for (const { listener, label } of [...set]) {
    try {
      listener(payload)
    } catch (err) {
      process.stderr.write(`daemon: event-bus: '${label}' listener for '${event}' threw: ${err}\n`)
    }
  }
}

export function getSubscriptions(): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [event, set] of listeners) {
    result[event] = [...set].map(e => e.label)
  }
  for (const c of contributors) {
    const labels = c.getLabels()
    for (const [event, list] of Object.entries(labels)) {
      result[event] = [...(result[event] ?? []), ...list.map(l => `${c.source}:${l}`)]
    }
  }
  return result
}

export function logSubscriptions(): void {
  const subs = getSubscriptions()
  const entries = Object.entries(subs)
  if (entries.length === 0) return
  process.stderr.write('daemon: event-bus subscriptions:\n')
  for (const [event, labels] of entries) {
    process.stderr.write(`  ${event} → ${labels.join(', ')}\n`)
  }
}

// Module-level singletons (e.g. ProtocolEventBus) register contributors once
// at import time. After reset, getSubscriptions() under-reports until re-import.
export function _resetForTesting(): void {
  listeners.clear()
  contributors.splice(0)
}
