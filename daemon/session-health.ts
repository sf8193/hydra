import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { gateway } from './config.js'
import { tmuxHasSession, fallbackDescription } from './util.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { mainChannel, mainContext, mainTmux } from './main-session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { ORPHAN_GRACE_MS } from './session-reachability.js'
import { notifyOperator } from './access.js'
import type { SessionInfo } from './sessions.js'
import { isSessionWorking } from './session-activity.js'
import { getProtocolContext } from './protocol-runner.js'
import { pendingPermissions } from './permission.js'
import { requestHandoff } from './commands/thread.js'

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000
const SPAWN_GRACE_MS = 60_000
// SYNC: shared with the recovery commands' reachability check, which must agree
// on what counts as an orphan. See daemon/session-reachability.ts.
const CONTEXT_ALERT_THRESHOLDS = [50, 70]

// Cache handoff, on unless AUTO_HANDOFF_CACHE=0: a Claude session at 50%+ context that nobody has touched for 50 minutes
// hands off while its 1-hour prompt cache is still warm (the 5-minute poll lands the request 50-55 minutes after the last touch).
const CACHE_HANDOFF_PCT = 50
const CACHE_HANDOFF_IDLE_MS = 50 * 60_000
// lastActive is saved only for chat messages, not tool calls, so after a restart it can be stale: idle counts from here at the earliest.
const DAEMON_STARTED_AT = Date.now()
const cacheHandoffAsked = new Set<string>()

const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()
const orphanAlerted = new Map<string, number>()

export function startSessionHealthPoll(): void {
  setInterval(() => pollSessionsOnce(Date.now()), SESSION_CHECK_INTERVAL_MS)
}

/** One session-health pass: crash detection, orphan detection (+ id discovery), context alert. */
export function pollSessionsOnce(now: number): void {
  const newOrphans: SessionInfo[] = []
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
        orphanAlerted.set(info.sessionId, now)
        process.stderr.write(`daemon: orphan detected: ${info.tmuxName} (tmux alive, bridge disconnected for ${Math.round((now - info.createdAt) / 1000)}s)${channelNoteSentence(info)}\n`)
        newOrphans.push(info)
      }
    } else {
      orphanAlerted.delete(info.sessionId)
    }

    const pct = formatContextPercent(info.adapter, info)
    alertContext(info.sessionId, info.tmuxName, pct, info.threadId)
    // A failure here (disk, template) must not skip the other sessions' crash and orphan checks.
    try { cacheHandoff(info, parseInt(pct), now) } catch (err) { process.stderr.write(`daemon: cache handoff failed for ${info.tmuxName}: ${err}\n`) }
  }
  // Main has no registry record, so it is checked on its own. With no channel yet there is nowhere to alert,
  // and nothing is marked alerted.
  const channel = mainChannel()
  if (channel) alertContext('main', mainTmux(), mainContext() ?? '?', channel)

  alertOrphans(newOrphans, now)
}

function cacheHandoff(info: SessionInfo, pct: number, now: number): void {
  if (process.env.AUTO_HANDOFF_CACHE === '0' || Number.isNaN(pct)) return
  // Below the threshold, re-arm: a later climb past it asks again.
  if (pct < CACHE_HANDOFF_PCT) { cacheHandoffAsked.delete(info.sessionId); return }
  if (cacheHandoffAsked.has(info.sessionId)) return
  if (info.engine !== 'claude' || info.sessionType !== 'thread_owner' || !transport.has(info.sessionId)) return
  if (isSessionWorking(info) || getProtocolContext(info.sessionId)) return
  if ([...pendingPermissions.values()].some(p => p.sessionId === info.sessionId)) return
  const idleMs = now - Math.max(info.lastActive, DAEMON_STARTED_AT)
  if (idleMs < CACHE_HANDOFF_IDLE_MS) return
  cacheHandoffAsked.add(info.sessionId)
  const idleMin = Math.round(idleMs / 60_000)
  process.stderr.write(`daemon: cache handoff: ${info.tmuxName} at ${pct}%, idle ${idleMin}m\n`)
  requestHandoff(info, { channelId: info.threadId, threadId: info.threadId, requester: 'hydra (auto-handoff)' })
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
    void gateway.send(channel, `**${name}** is at **${pct}** context. Consider a \`handoff\` to a fresh session (\`handoff: <note>\` passes a note to it).`).catch(() => {})
  }
}

function channelNoteSentence(info: SessionInfo): string {
  return info.channelNote ? ` ${info.channelNote}.` : ''
}

function alertOrphanThread(info: SessionInfo): void {
  void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** is running but its bridge isn't connected — replies can't reach this thread.${channelNoteSentence(info)} Use \`resume\` to reattach with its context, or \`respawn\` to start fresh.`).catch(() => {})
}

function alertOrphans(orphans: SessionInfo[], detectedAt: number): void {
  if (orphans.length === 0) return
  if (orphans.length === 1) return alertOrphanThread(orphans[0])
  const lines = orphans.map(info => {
    const thread = threadRegistry.get(info.threadId)
    const name = thread?.threadUrl ? `[${info.tmuxName}](${thread.threadUrl})` : `\`${info.tmuxName}\``
    const label = info.description?.split('\n')[0].trim() || fallbackDescription(thread?.topic ?? '')
    const note = info.channelNote ? ` (${info.channelNote})` : ''
    return label ? `• ${name} — ${label}${note}` : `• ${name}${note}`
  })
  const text = [
    `⚠️ **${orphans.length} sessions lost their bridge** — they're still running, but replies can't reach their threads. In each thread, use \`resume\` to reattach with its context, or \`respawn\` to start fresh.`,
    ...lines,
  ].join('\n')
  void notifyOperator(text).then(sent => {
    if (sent) return
    for (const info of orphans) {
      if (orphanAlerted.get(info.sessionId) !== detectedAt) continue
      if (registry.get(info.sessionId) === info && !info.deadAt && !transport.has(info.sessionId)) alertOrphanThread(info)
      else orphanAlerted.delete(info.sessionId)
    }
  })
}
