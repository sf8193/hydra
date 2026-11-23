/**
 * Everything the daemon switches on at boot instead of at import: each module defines its listeners in a bind
 * function, and this is the one list of them. daemon.ts calls bindDaemon() once, before the engines start.
 * (The delivery gate is armed separately in daemon.ts: it must be set before queued messages are restored.)
 */
import { bindDeliveryNotice } from '../sessions/delivery-notice.js'
import { bindPiggybackCleanup } from '../sessions/codex-piggyback.js'
import { bindCodexRuntime } from './codex-runtime.js'
import { bindRouter } from './router.js'
import { bindCliIdempotency } from './cli-handler.js'
import { bindPermissionCleanup } from './permission.js'
import { bindReplyGuardCleanup } from './reply-guard.js'
import { bindSpecialistThreadDrop } from './specialist-thread.js'
import { bindTypedDeliveryFlush } from './typed-delivery.js'

export function bindDaemon(): void {
  bindDeliveryNotice()
  bindPiggybackCleanup()
  bindCodexRuntime()
  bindRouter()
  bindCliIdempotency()
  bindPermissionCleanup()
  bindReplyGuardCleanup()
  bindSpecialistThreadDrop()
  bindTypedDeliveryFlush()
}
