// Typed event bus — decouples producers from consumers across the daemon.
//
// Protocols emit events (review lifecycle, session replies, deaths).
// Any module can subscribe without importing the emitter.
// Each listener is isolated: a throw logs and continues to the next.
// Listeners may be sync or async — async rejections are caught and logged
// with full stack traces, or routed to a caller-supplied onError handler.
//
// Extensible: other modules can augment EventMap via:
//   declare module './event-bus' { interface EventMap { 'my:event': { ... } } }

export interface EventMap {
  'reply': { sessionId: string; text: string; chatId: string; sentIds: string[] }
  'session:death': { sessionId: string; threadId: string; wasOwner: boolean; tmuxName: string }
}

type Listener<T> = (payload: T) => void | Promise<void>

type ListenerOpts = {
  onError?: (err: unknown) => void
}

type LabeledListener = {
  listener: Listener<any>
  label: string
  onError?: (err: unknown) => void
}

const listeners = new Map<string, Set<LabeledListener>>()
const contributors: SubscriptionContributor[] = []

export function contributeSubscriptions(source: string, getLabels: () => Record<string, string[]>): void {
  contributors.push({ source, getLabels })
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message
  }
  return String(err)
}

function handleListenerError(label: string, event: string, err: unknown, verb: string, onError?: (err: unknown) => void): void {
  if (onError) {
    try { onError(err) } catch {}
  } else {
    process.stderr.write(`daemon: event-bus: '${label}' listener for '${event}' ${verb}: ${formatError(err)}\n`)
  }
}

export function on<K extends keyof EventMap>(
  event: K,
  listener: Listener<EventMap[K]>,
  label: string,
  opts?: ListenerOpts,
): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  const set = listeners.get(event)!
  const entry: LabeledListener = { listener, label, onError: opts?.onError }
  set.add(entry)
  return () => { set.delete(entry) }
}

/** Subscribe for exactly one delivery, then auto-unsubscribe. */
export function once<K extends keyof EventMap>(
  event: K,
  listener: Listener<EventMap[K]>,
  label: string,
  opts?: ListenerOpts,
): () => void {
  const unsub = on(event, payload => {
    unsub()
    return listener(payload)
  }, label, opts)
  return unsub
}

export function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  const set = listeners.get(event)
  if (!set) return
  // Snapshot: a listener may trigger another emit() for the same event.
  // Re-entrant emits are depth-first — inner emit runs to completion
  // before the outer emit resumes delivering to remaining listeners.
  for (const { listener, label, onError } of [...set]) {
    try {
      const result = listener(payload)
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err: unknown) => {
          handleListenerError(label, event, err, 'rejected', onError)
        })
      }
    } catch (err) {
      handleListenerError(label, event, err, 'threw', onError)
    }
  }
}

/** Number of listeners for a specific event, or total across all events. */
export function listenerCount(event?: keyof EventMap): number {
  if (event !== undefined) {
    return listeners.get(event)?.size ?? 0
  }
  let total = 0
  for (const set of listeners.values()) total += set.size
  return total
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
