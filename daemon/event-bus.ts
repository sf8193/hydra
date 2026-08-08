// Typed event bus — decouples producers from consumers across the daemon.
//
// Protocols emit events (review lifecycle, session replies, deaths).
// Any module can subscribe without importing the emitter.
// Each listener is isolated: a throw or rejected promise logs and continues to the next.
// Async listeners are supported — rejections are caught and logged with the listener label.
//
// Extensible: other modules can augment EventMap via:
//   declare module './event-bus' { interface EventMap { 'my:event': { ... } } }

export interface EventMap {
  'reply': { sessionId: string; text: string; chatId: string; sentIds: string[] }
  'session:death': { sessionId: string; threadId: string; wasOwner: boolean; tmuxName: string }
  'review:complete': { threadId: string }
  'review:cancelled': { threadId: string }
  'review:round': { threadId: string; round: number; totalRounds: number; text: string }
}

type Listener<T> = (payload: T) => void | Promise<void>
type LabeledListener = { listener: Listener<any>; label: string }

const listeners = new Map<string, Set<LabeledListener>>()

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
      const result = listener(payload)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(err => {
          process.stderr.write(`daemon: event-bus: '${label}' async listener for '${event}' rejected: ${err}\n`)
        })
      }
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

export function _resetForTesting(): void {
  listeners.clear()
}
