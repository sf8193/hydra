// The notice a session's thread gets when a delivery to it was not accepted, for every engine. Registered at import (bridge-transport.ts
// imports it, as it emits the event). A refusal the delivery gate already announced (restricted.ts's deliveryRefusal, through the same
// limiter and key) is not said again; any other rejection or uncertain delivery is said once per message, under the session's own engine.
import { on } from '../infra/event-bus.js'
import { registry } from './sessions.js'
import { safeSend } from '../infra/util.js'
import { engineLabel } from '../shared/engines/index.js'
import { refusalNoticeKey, threadNotices } from './notice-limit.js'

on('delivery:failed', ({ sessionId, status, reason, messageId }) => {
  const info = registry.get(sessionId)
  if (!info) return
  if (threadNotices.told(refusalNoticeKey(info.threadId, reason))) return
  const source = messageId ? ` (message ${messageId})` : ''
  const outcome = status === 'unknown' ? 'delivery is uncertain; no automatic replay' : 'delivery was rejected'
  void safeSend(info.threadId, `⚠️ ${engineLabel(info.engine)} ${outcome}${source}: ${reason}`)
}, 'delivery-notice')
