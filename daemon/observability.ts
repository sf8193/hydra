// Observability for spawned sessions: id correlation, periodic vitals, and a
// death report to the daemon log. A crashed spawn otherwise leaves no cause, no
// stderr, and no link to its transcript.

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { formatDuration } from './util.js'

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const VITALS_INTERVAL_MS = 60_000

// Front-trim cap for the black-box spawn logs. A live session's pane output is
// otherwise unbounded on disk; over the cap we keep only the most recent bytes —
// the dying tail is the whole point of the recorder — and discard the front.
const SPAWN_LOG_MAX_BYTES = 5 * 1024 * 1024
const SPAWN_LOG_KEEP_BYTES = 2 * 1024 * 1024

// How much pane tail the autopsy reads into the daemon log (PRESERVE, hardware-only).
// The channel crash notice gets a LINK to the log, never the bytes — so there is no
// channel-excerpt shaping to configure.
const CRASH_LOG_TAIL_LINES = 30

export type VitalsSample = { rssMB: number; at: number }

// Last RSS sample per session, kept here rather than on SessionInfo — SessionInfo
// is persisted to sessions.json, and this is ephemeral diagnostic state.
const vitalsSamples = new Map<string, VitalsSample>()

// The death path (bridge-server.ts) reads a session's last sample to fold into
// its autopsy — exposed here so buildAutopsy can take it as an argument (pure).
export function getVitalsSample(sessionId: string): VitalsSample | undefined {
  return vitalsSamples.get(sessionId)
}

// Sessions already correlated, so the correlation line is logged once per session
// (register fires on every reconnect too). Ephemeral, pruned with vitalsSamples.
const correlatedSessions = new Set<string>()

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
  if (correlatedSessions.has(info.sessionId)) return
  correlatedSessions.add(info.sessionId)
  const transcript = info.claudeSessionId ? transcriptPathFor(info.claudeSessionId) : undefined
  process.stderr.write(
    `daemon: correlate ${info.tmuxName}: hydra=${info.sessionId} ` +
    `claude=${info.claudeSessionId ?? '?'} ` +
    `transcript=${transcript ?? 'pending'} ` +
    `pane-log=${info.spawnLogPath ?? 'none'}\n`,
  )
}

// Direct children of a pid (empty if none — pgrep exits non-zero, which throws).
function childPids(pid: string): string[] {
  try {
    return execFileSync('pgrep', ['-P', pid], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch { return [] }
}

// The pane's whole process subtree. Claude's tree is shell → node → claude, so a
// direct-children-only walk undercounts RSS — descend the full tree.
function descendantPids(rootPid: string): string[] {
  const all: string[] = []
  const queue = [rootPid]
  while (queue.length) {
    for (const kid of childPids(queue.shift()!)) { all.push(kid); queue.push(kid) }
  }
  return all
}

// pid + summed RSS (MB) of the pane's process subtree.
// execFileSync (array form, no shell) throughout — removes the quoting question
// even though tmuxName is daemon-controlled.
// TODO: async — this sync-spawns several subprocesses per session each tick.
function paneVitals(tmuxName: string): { pid?: number; rssMB?: number } {
  try {
    const panePid = execFileSync('tmux', ['list-panes', '-t', tmuxName, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim().split('\n')[0]
    if (!panePid) return {}
    const subtree = descendantPids(panePid)
    let rssKb = 0
    for (const pid of [panePid, ...subtree]) {
      try { rssKb += parseInt(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim() || '0', 10) } catch { /* pid gone */ }
    }
    const pid = subtree[0] ? parseInt(subtree[0], 10) : parseInt(panePid, 10)
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

// Truncate an over-cap spawn log in place, keeping the last SPAWN_LOG_KEEP_BYTES
// (the inode-preservation rationale is at the writeFileSync call below). Best-effort
// — a few bytes appended during the read→write window may be lost; only over the cap.
export function trimSpawnLog(path: string): void {
  let size: number
  try { size = statSync(path).size } catch { return }
  if (size <= SPAWN_LOG_MAX_BYTES) return
  try {
    const fd = openSync(path, 'r')
    let kept: Buffer
    try {
      const buf = Buffer.alloc(SPAWN_LOG_KEEP_BYTES)
      const read = readSync(fd, buf, 0, SPAWN_LOG_KEEP_BYTES, size - SPAWN_LOG_KEEP_BYTES)
      const sub = buf.subarray(0, read)
      // Drop the partial first line so the file starts on a clean boundary.
      const nl = sub.indexOf(0x0a)
      kept = nl >= 0 ? sub.subarray(nl + 1) : sub
    } finally {
      closeSync(fd) // always, even if readSync throws
    }
    // writeFileSync's 'w' flag is O_TRUNC — it truncates this inode in place, it
    // does NOT unlink/recreate. So pipe-pane's O_APPEND fd keeps writing to the
    // same inode and capture continues past the trim (locked by the inode-identity
    // test in observability.test.ts).
    writeFileSync(path, kept)
    process.stderr.write(`daemon: spawn-log front-trimmed ${path} (${Math.round(size / 1048576)}MB -> kept ${Math.round(SPAWN_LOG_KEEP_BYTES / 1048576)}MB tail)\n`)
  } catch (err) {
    process.stderr.write(`daemon: spawn-log trim failed ${path}: ${err}\n`)
  }
}

export function startVitalsSnapshots(isConnected: (id: string) => boolean): void {
  setInterval(() => {
    const now = Date.now()
    // Prune diagnostic state for gone-or-dead sessions. Each map/set is pruned by
    // liveness independently: a session that registered (→ correlatedSessions) but
    // never yielded an RSS sample (→ absent from vitalsSamples) must still be
    // reclaimed. buildAutopsy reads its sample before deadAt is set
    // (checkSessionDeath), so this never races the autopsy.
    const goneOrDead = (id: string) => { const s = registry.get(id); return !s || !!s.deadAt }
    for (const id of vitalsSamples.keys()) if (goneOrDead(id)) vitalsSamples.delete(id)
    for (const id of correlatedSessions) if (goneOrDead(id)) correlatedSessions.delete(id)
    const live = [...registry.values()].filter(s => !s.deadAt)
    for (const s of live) if (s.spawnLogPath) trimSpawnLog(s.spawnLogPath)
    for (const s of live) if (s.debugLogPath) trimSpawnLog(s.debugLogPath)
    if (live.length === 0) return
    const lines = live.map(s => '  ' + sessionVitalsLine(s, now, isConnected))
    process.stderr.write(`daemon: vitals (${live.length} live):\n${lines.join('\n')}\n`)
  }, VITALS_INTERVAL_MS).unref()
}

// Pure: `now` and `sample` are injected (not read from the wall clock / global
// Map) so the assembled report — including the "N before death" timing and the
// sampled-vs-never-sampled branch — is deterministic and testable.
export type AutopsyExtras = {
  exitFileLines?: string[]
  stderrTail?: string[]
  debugTail?: string[]
}

export function buildAutopsy(info: SessionInfo, reason: string, blackBoxTail: string[], now: number, sample: VitalsSample | undefined, extras?: AutopsyExtras): string {
  const { exitFileLines, stderrTail, debugTail } = extras ?? {}
  const transcript = info.claudeSessionId ? transcriptPathFor(info.claudeSessionId) : undefined
  const rss = sample ? `${sample.rssMB}MB (${dur(now - sample.at)} before death)` : 'never sampled'
  const lines = [
    `daemon: ═══ AUTOPSY ${info.tmuxName} ═══`,
    `  reason: ${reason}`,
    `  hydra=${info.sessionId} claude=${info.claudeSessionId ?? '?'} model=${info.capabilities?.model ?? '?'}`,
    `  context: ${info.topic}`,
    `  transcript: ${transcript ?? 'not found'}`,
    `  pane-log: ${info.spawnLogPath ?? 'none'}`,
    `  debug-log: ${info.debugLogPath ?? 'none'}`,
    `  lifetime: ${dur(now - info.createdAt)}, idle at death: ${dur(now - info.lastActive)}`,
    `  last RSS: ${rss}`,
  ]
  const startIdx = blackBoxTail.indexOf('=== HYDRA SESSION EXIT ===')
  const endIdx = blackBoxTail.indexOf('=========================', startIdx)
  const exitBlock = startIdx >= 0 && endIdx > startIdx
    ? blackBoxTail.slice(startIdx + 1, endIdx)
    : (exitFileLines ?? [])
  const exitMarkers = new Map(
    exitBlock.filter(l => l.includes('=')).map(l => {
      const eq = l.indexOf('=')
      return [l.slice(0, eq), l.slice(eq + 1)] as [string, string]
    })
  )
  if (exitMarkers.has('exit_code')) {
    const code = exitMarkers.get('exit_code')!
    const signal = exitMarkers.get('signal')
    const wall = exitMarkers.get('wall_clock')
    const parts = [`exit_code=${code}`]
    if (signal) parts.push(`signal=${signal}`)
    if (wall) parts.push(`wall=${wall}`)
    lines.push(`  exit: ${parts.join(', ')}`)
  }
  if (stderrTail && stderrTail.length > 0) {
    lines.push(`  stderr (last ${stderrTail.length} lines):`)
    lines.push(...stderrTail.map(l => `  | ${l}`))
  }
  if (debugTail && debugTail.length > 0) {
    lines.push(`  cc-debug (last ${debugTail.length} lines):`)
    lines.push(...debugTail.map(l => `  | ${l}`))
  }
  const markerKeys = new Set(['exit_code', 'exit_ts', 'session_id', 'tmux_name', 'signal', 'wall_clock'])
  if (blackBoxTail.length > 0) {
    const displayTail = blackBoxTail.filter(l => !l.startsWith('=== HYDRA') && !l.startsWith('====') && !(l.includes('=') && markerKeys.has(l.slice(0, l.indexOf('=')))))
    if (displayTail.length > 0) {
      lines.push(`  last output (${displayTail.length} lines):`)
      lines.push(...displayTail.map(l => `  | ${l}`))
    } else {
      lines.push(`  last output: none captured`)
    }
  } else {
    lines.push(`  last output: none captured`)
  }
  lines.push(`  ═══ end autopsy ═══`)
  return lines.join('\n')
}

/** Last `maxLines` lines of a black-box spawn logfile (see session-lifecycle.ts's
 *  `pipe-pane` capture). Uses `tail`, which seeks from the end, so a multi-hundred-MB
 *  pane log isn't read into memory. Throws if the file is missing/unreadable. */
export function tailSpawnLog(path: string, maxLines: number = CRASH_LOG_TAIL_LINES): string[] {
  const out = execFileSync('tail', ['-n', String(maxLines), path], { encoding: 'utf8' })
  const lines = out.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function recordSessionDeath(info: SessionInfo, reason: string): void {
  let tail: string[] = []
  if (info.spawnLogPath) {
    try { tail = tailSpawnLog(info.spawnLogPath) } catch {}
  }
  let exitFileLines: string[] | undefined
  if (info.exitFilePath) {
    try { exitFileLines = readFileSync(info.exitFilePath, 'utf8').split('\n').filter(Boolean) } catch {}
  }
  let stderrTail: string[] | undefined
  if (info.stderrLogPath) {
    try { const s = tailSpawnLog(info.stderrLogPath, 5); if (s.length > 0) stderrTail = s } catch {}
  }
  let debugTail: string[] | undefined
  if (info.debugLogPath) {
    try { const d = tailSpawnLog(info.debugLogPath, 10); if (d.length > 0) debugTail = d } catch {}
  }
  process.stderr.write(buildAutopsy(info, reason, tail, Date.now(), getVitalsSample(info.sessionId), { exitFileLines, stderrTail, debugTail }) + '\n')
  info.deadAt = Date.now()
}

// The channel crash notice: LINK, not CONVEY. It names the on-disk black box
// (hardware-only) and a safe derived reason, but never posts raw pane bytes —
// so there is nothing to redact or fence-escape. Content crosses to chat only on
// request, when the main session reads the log and surfaces a judged summary.
export function buildCrashNotice(info: SessionInfo): string {
  const blackBox = info.spawnLogPath
    ? ` Black box: \`${info.spawnLogPath}\` — ask me to read it.`
    : ''
  return `💀 **${info.tmuxName}** crashed — tmux dead, bridge disconnected.${blackBox} Use \`resume\` to reconnect or \`respawn\` to start fresh.`
}
