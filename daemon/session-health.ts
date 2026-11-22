import { markDead, registry, threadRegistry } from './sessions.js'
import { gateway } from '../infra/config.js'
import { fallbackDescription } from '../infra/util.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { mainChannel, mainContext, mainTmux } from './main-session.js'
import { refreshSessionVisual } from './anchor-state.js'
import { bridgeWaitMs, occupancy } from './session-reachability.js'
import { notifyOperator } from './access.js'
import type { SessionInfo } from './sessions.js'
import { automaticHandoffSentence, autoHandoff } from './auto-handoff.js'
import { CONTEXT_ALERT_LINES } from './context-lines.js'
import { timed } from '../shared/loop-watch.js'

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000

const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()
const orphanAlerted = new Map<string, number>()

export function startSessionHealthPoll(): void {
  setInterval(() => timed('session-health', () => pollSessionsOnce(Date.now())), SESSION_CHECK_INTERVAL_MS)
}

/** One session-health pass: crash detection, orphan detection (+ id discovery), context alert. */
export function pollSessionsOnce(now: number): void {
  const newOrphans: SessionInfo[] = []
  for (const info of registry.values()) {
    const occ = info.sessionType === 'thread_guest' ? undefined : occupancy(info, now)
    // Bridge-only disconnects are handled by the bridge-server disconnect handler (3s delay + tmux check).
    // Codex owns its deaths: finaliseCodexDeath drops its queue. Claude and agy are judged by their tmux here.
    if (occ === 'dead' && !info.deadAt && info.engine !== 'codex' && !crashAlerted.has(info.sessionId)) {
      crashAlerted.add(info.sessionId)
      markDead(info, now)
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
    if (occ === 'orphaned') {
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
        process.stderr.write(`daemon: orphan detected: ${info.tmuxName} (tmux alive, no bridge for ${Math.round(bridgeWaitMs(info.createdAt, now) / 1000)}s awake)${channelNoteSentence(info)}\n`)
        newOrphans.push(info)
      }
    } else {
      orphanAlerted.delete(info.sessionId)
    }

    const pct = formatContextPercent(info.adapter, info)
    alertContext(info.sessionId, info.tmuxName, pct, info.threadId, info)
    // A failure here (disk, template) must not skip the other sessions' crash and orphan checks.
    try { autoHandoff(info, parseInt(pct), now) } catch (err) { process.stderr.write(`daemon: auto-handoff failed for ${info.tmuxName}: ${err}\n`) }
  }
  // Main has no registry record, so it is checked on its own. With no channel yet there is nowhere to alert,
  // and nothing is marked alerted.
  const channel = mainChannel()
  if (channel) alertContext('main', mainTmux(), mainContext() ?? '?', channel)

  alertOrphans(newOrphans, now)
}

function alertContext(id: string, name: string, pct: string, channel: string, info?: SessionInfo): void {
  if (pct === '?') return
  const num = parseInt(pct)
  // A drop (/clear, /compact) re-arms the thresholds it fell below; the main session keeps its id across a /clear.
  for (const t of CONTEXT_ALERT_LINES) if (num < t) contextAlerted.delete(`${id}:${t}`)
  // Highest crossed threshold not yet alerted; a jump past both fires once.
  const threshold = CONTEXT_ALERT_LINES.findLast(t => num >= t)
  const key = `${id}:${threshold}`
  if (threshold !== undefined && !contextAlerted.has(key)) {
    for (const t of CONTEXT_ALERT_LINES) if (t <= threshold) contextAlerted.add(`${id}:${t}`)
    process.stderr.write(`daemon: context alert: ${name} at ${pct}\n`)
    const auto = info ? automaticHandoffSentence(info) : ''
    void gateway.send(channel, `**${name}** is at **${pct}** context, at its ${threshold}% alert line.${auto ? ` ${auto}` : ''} Consider a \`handoff\` to a fresh session (\`handoff: <note>\` passes a note to it).`).catch(() => {})
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
      if (registry.get(info.sessionId) === info && occupancy(info) === 'orphaned') alertOrphanThread(info)
      else orphanAlerted.delete(info.sessionId)
    }
  })
}
