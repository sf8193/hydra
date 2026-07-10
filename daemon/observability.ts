// Observability for spawned sessions: id correlation, periodic vitals, and a
// death report to the daemon log. A crashed spawn otherwise leaves no cause, no
// stderr, and no link to its transcript.

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { formatDuration } from './util.js'

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const VITALS_INTERVAL_MS = 60_000

// Last RSS sample per session, kept here rather than on SessionInfo — SessionInfo
// is persisted to sessions.json, and this is ephemeral diagnostic state.
const vitalsSamples = new Map<string, { rssMB: number; at: number }>()

// Seconds under a minute, so a short-lived session doesn't read as "0m".
function dur(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatDuration(ms)
}

// Scans project dirs rather than deriving the path from cwd — avoids depending
// on claude's cwd→dir encoding.
export function transcriptPathFor(claudeSessionId: string): string | undefined {
  try {
    for (const dir of readdirSync(PROJECTS_ROOT)) {
      const p = join(PROJECTS_ROOT, dir, `${claudeSessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch { /* projects dir absent */ }
  return undefined
}

export function logCorrelation(info: SessionInfo): void {
  const transcript = info.claudeSessionId ? transcriptPathFor(info.claudeSessionId) : undefined
  process.stderr.write(
    `daemon: correlate ${info.tmuxName}: hydra=${info.sessionId} ` +
    `claude=${info.claudeSessionId ?? '?'} ` +
    `transcript=${transcript ?? 'pending'} ` +
    `pane-log=${info.spawnLogPath ?? 'none'}\n`,
  )
}

// pid + RSS (MB) of the pane's process subtree (shell + children).
// TODO: async — this sync-spawns 3+ subprocesses per session each tick.
function paneVitals(tmuxName: string): { pid?: number; rssMB?: number } {
  try {
    const panePid = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0]
    if (!panePid) return {}
    const kids = execSync(`pgrep -P ${panePid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    let rssKb = 0
    for (const pid of [panePid, ...kids]) {
      try { rssKb += parseInt(execSync(`ps -o rss= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim() || '0', 10) } catch { /* pid gone */ }
    }
    const pid = kids[0] ? parseInt(kids[0], 10) : parseInt(panePid, 10)
    return { pid, rssMB: Math.round(rssKb / 1024) }
  } catch {
    return {}
  }
}

export function sessionVitalsLine(info: SessionInfo, now: number, isConnected: (id: string) => boolean): string {
  const v = paneVitals(info.tmuxName)
  if (v.rssMB != null) vitalsSamples.set(info.sessionId, { rssMB: v.rssMB, at: now })
  const conn = isConnected(info.sessionId) ? '' : ' [disconnected]'
  return `${info.tmuxName} pid=${v.pid ?? '?'} rss=${v.rssMB ?? '?'}MB up=${dur(now - info.createdAt)} idle=${dur(now - info.lastActive)}${conn}`
}

export function startVitalsSnapshots(isConnected: (id: string) => boolean): void {
  setInterval(() => {
    const now = Date.now()
    for (const id of vitalsSamples.keys()) if (!registry.get(id)) vitalsSamples.delete(id)
    const live = [...registry.values()].filter(s => !s.deadAt)
    if (live.length === 0) return
    const lines = live.map(s => '  ' + sessionVitalsLine(s, now, isConnected))
    process.stderr.write(`daemon: vitals (${live.length} live):\n${lines.join('\n')}\n`)
  }, VITALS_INTERVAL_MS).unref()
}

export function buildAutopsy(info: SessionInfo, reason: string, blackBoxTail: string[]): string {
  const now = Date.now()
  const transcript = info.claudeSessionId ? transcriptPathFor(info.claudeSessionId) : undefined
  const sample = vitalsSamples.get(info.sessionId)
  const rss = sample ? `${sample.rssMB}MB (${dur(now - sample.at)} before death)` : 'never sampled'
  const lines = [
    `daemon: ═══ AUTOPSY ${info.tmuxName} ═══`,
    `  reason: ${reason}`,
    `  hydra=${info.sessionId} claude=${info.claudeSessionId ?? '?'} model=${info.capabilities?.model ?? '?'}`,
    `  context: ${info.topic}`,
    `  transcript: ${transcript ?? 'not found'}`,
    `  pane-log: ${info.spawnLogPath ?? 'none'}`,
    `  lifetime: ${dur(now - info.createdAt)}, idle at death: ${dur(now - info.lastActive)}`,
    `  last RSS: ${rss}`,
  ]
  if (blackBoxTail.length > 0) {
    lines.push(`  last output (${blackBoxTail.length} lines):`)
    lines.push(...blackBoxTail.map(l => `  | ${l}`))
  } else {
    lines.push(`  last output: none captured`)
  }
  lines.push(`  ═══ end autopsy ═══`)
  return lines.join('\n')
}
