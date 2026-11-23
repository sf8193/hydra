// The notice a session's thread gets when a delivery to it was not accepted, for every engine. Registered at import (bridge-transport.ts
// imports it, as it emits the event). A refusal the delivery gate already announced (restricted.ts's deliveryRefusal, through the same
// limiter and key) is not said again; any other rejection or uncertain delivery is said once per message, under the session's own engine, except a standing one (an orphaned or dead session), which is said once per cause per window.
import { on } from '../infra/event-bus.js'
import { registry } from './registry.js'
import { safeSend } from '../infra/util.js'
import { engineLabel } from '../shared/engines/index.js'
import { refusalNoticeKey, threadNotices } from '../shared/notice-limit.js'

on('delivery:failed', ({ sessionId, status, reason, messageId, standing }) => {
  const info = registry.get(sessionId)
  if (!info) return
  const cause = refusalNoticeKey(info.threadId, reason)
  if (standing ? !threadNotices.allow(cause) : threadNotices.told(cause)) return
  const source = messageId ? ` (message ${messageId})` : ''
  const outcome = status === 'unknown' ? 'delivery is uncertain; no automatic replay' : 'delivery was rejected'
  void safeSend(info.threadId, `⚠️ ${engineLabel(info.engine)} ${outcome}${source}: ${reason}`)
}, 'delivery-notice')
