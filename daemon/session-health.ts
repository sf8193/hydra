import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { gateway } from './config.js'
import { tmuxHasSession, getContextPercent } from './util.js'
import { refreshSessionVisual } from './anchor-state.js'
import { discoverClaudeSessionId } from './session-lifecycle.js'
import { readBridgeStartVerdict, describeBridgeAbsence } from './bridge-preflight.js'

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000
const SPAWN_GRACE_MS = 60_000
const ORPHAN_GRACE_MS = 90_000
const CONTEXT_ALERT_THRESHOLD = 70

const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()
const orphanAlerted = new Set<string>()

export function startSessionHealthPoll(): void {
  setInterval(() => {
    const now = Date.now()
    for (const info of registry.values()) {
      // Crash detection — both tmux AND bridge must be gone. Bridge-only disconnects are handled
      // by the bridge-server disconnect handler (3s delay + tmux check). Skip sessions in spawn
      // grace period (bridge needs time to connect).
      if (!crashAlerted.has(info.sessionId) && info.sessionType !== 'thread_guest' && !info.deadAt && (now - info.createdAt > SPAWN_GRACE_MS) && !tmuxHasSession(info.tmuxName) && !transport.has(info.sessionId)) {
        crashAlerted.add(info.sessionId)
        info.deadAt = now
        registry.persist()
        const thread = threadRegistry.get(info.threadId)
        if (thread) {
          const histEntry = thread.sessionHistory.find((h: any) => h.sessionId === info.sessionId && !h.endedAt)
          if (histEntry) {
            histEntry.endedAt = now
            histEntry.messageCount = info.messageCount ?? 0
            histEntry.claudeSessionId = info.claudeSessionId
          }
          threadRegistry.persist()
        }
        process.stderr.write(`daemon: crash detected: ${info.tmuxName}\n`)
        void gateway.send(info.threadId, `💀 **${info.tmuxName}** died. Use \`resume\` to restore context or \`respawn\` for a fresh start.`).catch(() => {})
        refreshSessionVisual(info.threadId, { state: 'crashed' })
        continue
      }

      // Orphan detection — tmux alive but bridge never connected past grace window.
      // See also: daemon/resume-health.ts classifyResumeFailure, which checks
      // the same condition at bridge-timeout time. Both paths must preserve.
      // Discovery retries every poll (claudeSessionId may become available later).
      // Alert fires once per orphan episode; clears when bridge reconnects.
      if (info.sessionType !== 'thread_guest' && !info.deadAt && !info.headless && (now - info.createdAt > ORPHAN_GRACE_MS) && tmuxHasSession(info.tmuxName) && !transport.has(info.sessionId)) {
        if (!info.claudeSessionId && info.engine !== 'codex') {
          const discovered = discoverClaudeSessionId(info.tmuxName)
          if (discovered) {
            info.claudeSessionId = discovered
            registry.persist()
            const thread = threadRegistry.get(info.threadId)
            if (thread) {
              const histEntry = thread.sessionHistory.find((h: any) => h.sessionId === info.sessionId && !h.endedAt)
              if (histEntry) histEntry.claudeSessionId = discovered
              threadRegistry.persist()
            }
            process.stderr.write(`daemon: orphan ${info.tmuxName}: discovered claudeSessionId=${discovered}\n`)
          }
        }
        if (!orphanAlerted.has(info.sessionId)) {
          orphanAlerted.add(info.sessionId)
          // Name which of the two causes this is. They read identically from here
          // — tmux alive, no socket — but only one of them can still resolve on
          // its own, and the human's next move depends on which.
          const verdict = readBridgeStartVerdict(info.debugLogPath)
          process.stderr.write(`daemon: orphan detected: ${info.tmuxName} (tmux alive, bridge disconnected for ${Math.round((now - info.createdAt) / 1000)}s, verdict=${verdict})\n`)
          void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** is running but its bridge isn't connected — replies can't reach this thread.\n_${describeBridgeAbsence(verdict)}_\nUse \`respawn\` to start fresh.`).catch(() => {})
        }
      } else {
        orphanAlerted.delete(info.sessionId)
      }

      // Context alert
      const pct = getContextPercent(info.tmuxName)
      if (pct === '?') continue
      const num = parseInt(pct)
      if (num >= CONTEXT_ALERT_THRESHOLD && !contextAlerted.has(info.sessionId)) {
        contextAlerted.add(info.sessionId)
        process.stderr.write(`daemon: context alert: ${info.tmuxName} at ${pct}\n`)
        void gateway.send(info.threadId, `**${info.tmuxName}** is at **${pct}** context. Consider \`respawn\` to continue in a fresh session.`).catch(() => {})
      }
    }
  }, SESSION_CHECK_INTERVAL_MS)
}
