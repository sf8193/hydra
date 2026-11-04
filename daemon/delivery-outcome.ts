import type { DeliveryResult } from './engines/engine-adapter.js'

export type DeliveryOutcome =
  | { ok: true; status: 'delivered' | 'queued'; proof: 'socket_write' | 'persisted' | 'adapter' }
  | { ok: false; error: string; exitCode?: number }

/**
 * What an adapter's DeliveryResult means to a CLI caller, shared by every
 * `hydra deliver` target (session, thread, specialist). `queued` is whether the caller
 * expected the message to wait for a bridge: Claude's contract fails (exit 6)
 * unless the write hit the socket or the caller asked for the queue.
 */
export function deliveryOutcome(result: DeliveryResult, queued: boolean): DeliveryOutcome {
  const via = result.status === 'accepted' ? result.via : undefined
  if (result.status === 'rejected') return { ok: false, error: `delivery rejected: ${result.reason}` }
  if (result.status === 'unknown') return { ok: false, error: `delivery outcome unknown: ${result.reason} — transient, retry`, exitCode: 6 }
  if (via === 'requeued') return { ok: false, error: 'bridge write failed (socket destroyed) — transient, retry', exitCode: 6 }
  if (via === 'queued' && !queued) return { ok: false, error: 'bridge unexpectedly absent after reachability check', exitCode: 6 }
  if (via === 'queued') return { ok: true, status: 'queued', proof: 'persisted' }
  if (via === 'bridge-socket') return { ok: true, status: 'delivered', proof: 'socket_write' }
  return { ok: true, status: 'delivered', proof: 'adapter' }
}
