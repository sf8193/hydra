import type { DeliveryResult } from '../engines/engine-adapter.js'

export type Landing =
  | { ok: true; status: 'delivered' | 'queued'; proof: 'socket_write' | 'persisted' | 'adapter' }
  | { ok: false; error: string; exitCode?: 5 | 6 }

/**
 * What an adapter's DeliveryResult means to a CLI caller, shared by every
 * `hydra deliver` target (session, thread, specialist). `queued` is whether the caller
 * expected the message to wait for a bridge: Claude's contract fails (exit 6)
 * unless the write hit the socket or the caller asked for the queue.
 */
export function landingOf(result: DeliveryResult, queued: boolean): Landing {
  const via = result.status === 'accepted' ? result.via : undefined
  // A rejection the engine says may clear is exit 5, `deferred` ("busy, try again later"); one that cannot stays a plain failure.
  if (result.status === 'rejected') return result.retryable
    ? { ok: false, error: `delivery rejected: ${result.reason} — transient, retry`, exitCode: 5 }
    : { ok: false, error: `delivery rejected: ${result.reason}` }
  if (result.status === 'unknown') return { ok: false, error: `delivery outcome unknown: ${result.reason} — transient, retry`, exitCode: 6 }
  if (via === 'requeued' && !queued) return { ok: false, error: 'bridge write failed (socket destroyed) — transient, retry', exitCode: 6 }
  if (via === 'requeued') return { ok: true, status: 'queued', proof: 'persisted' }
  if (via === 'queued' && !queued) return { ok: false, error: 'bridge unexpectedly absent after reachability check', exitCode: 6 }
  if (via === 'queued') return { ok: true, status: 'queued', proof: 'persisted' }
  if (via === 'bridge-socket') return { ok: true, status: 'delivered', proof: 'socket_write' }
  return { ok: true, status: 'delivered', proof: 'adapter' }
}
