import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { gateway } from './config.js'
import { tmuxHasSession } from './util.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { mainChannel, mainContext, mainTmux } from './main-session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { ORPHAN_GRACE_MS } from './session-reachability.js'

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000
const SPAWN_GRACE_MS = 60_000
// SYNC: shared with the recovery commands' reachability check, which must agree
// on what counts as an orphan. See daemon/session-reachability.ts.
const CONTEXT_ALERT_THRESHOLDS = [50, 70]

const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()
const orphanAlerted = new Set<string>()

export function startSessionHealthPoll(): void {
  setInterval(() => pollSessionsOnce(Date.now()), SESSION_CHECK_INTERVAL_MS)
}

/** One session-health pass: crash detection, orphan detection (+ id discovery), context alert. */
export function pollSessionsOnce(now: number): void {
  for (const info of registry.values()) {
    // Crash detection — both tmux AND bridge must be gone. Bridge-only disconnects are handled
    // by the bridge-server disconnect handler (3s delay + tmux check). Skip sessions in spawn
    // grace period (bridge needs time to connect).
    if (!crashAlerted.has(info.sessionId) && info.sessionType !== 'thread_guest' && !info.deadAt && (now - info.createdAt > SPAWN_GRACE_MS) && !tmuxHasSession(info.tmuxName) && !transport.has(info.sessionId)) {
      crashAlerted.add(info.sessionId)
      info.deadAt = now
      registry.persist()
      threadRegistry.closeHistoryEntry(info.threadId, info)
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
      const discovered = info.adapter.recoveryPlan(info, { discover: true }).learnedId
      if (discovered) {
        registry.persist()
        const thread = threadRegistry.get(info.threadId)
        if (thread) {
          const histEntry = thread.sessionHistory.find((h: any) => h.sessionId === info.sessionId && !h.endedAt)
          if (histEntry) histEntry.claudeSessionId = discovered
          threadRegistry.persist()
        }
        process.stderr.write(`daemon: orphan ${info.tmuxName}: discovered claudeSessionId=${discovered}\n`)
      }
      if (!orphanAlerted.has(info.sessionId)) {
        orphanAlerted.add(info.sessionId)
        process.stderr.write(`daemon: orphan detected: ${info.tmuxName} (tmux alive, bridge disconnected for ${Math.round((now - info.createdAt) / 1000)}s)\n`)
        void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** is running but its bridge isn't connected — replies can't reach this thread. Use \`resume\` to reattach with its context, or \`respawn\` to start fresh.`).catch(() => {})
      }
    } else {
      orphanAlerted.delete(info.sessionId)
    }

    alertContext(info.sessionId, info.tmuxName, formatContextPercent(info.adapter, info), info.threadId)
  }
  // Main has no registry record, so it is checked on its own. With no channel yet there is nowhere to alert,
  // and nothing is marked alerted.
  const channel = mainChannel()
  if (channel) alertContext('main', mainTmux(), mainContext() ?? '?', channel)
}

function alertContext(id: string, name: string, pct: string, channel: string): void {
  if (pct === '?') return
  const num = parseInt(pct)
  // A drop (/clear, /compact) re-arms the thresholds it fell below; the main session keeps its id across a /clear.
  for (const t of CONTEXT_ALERT_THRESHOLDS) if (num < t) contextAlerted.delete(`${id}:${t}`)
  // Highest crossed threshold not yet alerted; a jump past both fires once.
  const threshold = CONTEXT_ALERT_THRESHOLDS.findLast(t => num >= t)
  const key = `${id}:${threshold}`
  if (threshold !== undefined && !contextAlerted.has(key)) {
    for (const t of CONTEXT_ALERT_THRESHOLDS) if (t <= threshold) contextAlerted.add(`${id}:${t}`)
    process.stderr.write(`daemon: context alert: ${name} at ${pct}\n`)
    void gateway.send(channel, `**${name}** is at **${pct}** context. Consider a \`handoff\` to a fresh session (\`handoff - <note>\` passes a note to it).`).catch(() => {})
  }
}
