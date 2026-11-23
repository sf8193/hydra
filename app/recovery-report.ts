import { registry } from '../sessions/registry.js'
import { transport } from '../sessions/bridge-transport.js'
import { operatorIds } from '../sessions/access.js'
import { gateway } from '../infra/config.js'

/** The DM operators get when the gateway comes back after an outage (and at boot after a long gap). */
export function sendRecoveryReport(gapMs: number): void {
  const hrs = Math.floor(gapMs / 3_600_000)
  const mins = Math.floor((gapMs % 3_600_000) / 60_000)
  const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
  const connected = [...registry.values()].filter(s => transport.has(s.sessionId)).length
  const disconnected = [...registry.values()].filter(s => !transport.has(s.sessionId)).length
  const queuedMsgCount = [...transport.messageQueues.values()].reduce((sum, q) => sum + q.length, 0)
  const report = [
    `**Recovery report** — back online after ${duration} outage`,
    `• Sessions: ${registry.size} total (${connected} connected, ${disconnected} disconnected)`,
    `• Queued messages: ${queuedMsgCount}`,
  ].join('\n')
  for (const userId of operatorIds()) {
    void gateway.sendDM(userId, report).catch(e =>
      process.stderr.write(`daemon: recovery report DM failed: ${e}\n`),
    )
  }
  process.stderr.write(`daemon: sent recovery report (offline ${duration})\n`)
}
