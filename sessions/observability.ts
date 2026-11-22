// Observability for spawned sessions: id correlation, periodic vitals, and a
// death report to the daemon log. A crashed spawn otherwise leaves no cause, no
// stderr, and no link to its transcript.

import { readFileSync, statSync, fstatSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { occupancy } from './session-reachability.js'
import { execFileSync } from 'child_process'
import { markDead, registry } from './registry.js'
import type { SessionInfo } from './registry.js'
import { formatDuration } from '../infra/util.js'
import { PLATFORM } from '../infra/config.js'
import { transcriptPathFor } from '../infra/usage.js'
import { sampleCpu, type CpuSample, type CpuVitals } from './cpu-watch.js'
import { formatPct, formatPressure, type SystemPressure } from '../infra/cpu-spin.js'
import { vitalsSnapshot, vitalsPruners, type PaneVitals } from '../infra/vitals-snapshot.js'
import { readConversationForensics } from '../engines/conversation-forensics.js'
import type { ConversationForensics } from '../engines/conversation-forensics.js'
import { createHostHealth, type HostHealth } from '../infra/host-health.js'
import { byteTmuxName } from '../shared/constants.js'
import { takeWorstLagMs, timed } from '../shared/loop-watch.js'

const VITALS_INTERVAL_MS = 60_000

// Front-trim cap for the black-box spawn logs. A live session's pane output is
// otherwise unbounded on disk; over the cap we keep only the most recent bytes —
// the dying tail is the whole point of the recorder — and discard the front.
// The daemon log is one file for the whole fleet, not one per session, so it gets
// a far larger cap than a spawn log. Sized to hold days of ordinary operation
// while still bounding a runaway: the 2026-08-31 tools/list loop wrote 2.3GB, and
// the same loop had it back to 4.8GB by 2026-09-10 because nothing capped it.
const DAEMON_LOG_MAX_BYTES = 512 * 1024 * 1024
const DAEMON_LOG_KEEP_BYTES = 64 * 1024 * 1024

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

export function logCorrelation(info: SessionInfo): void {
  if (correlatedSessions.has(info.sessionId)) return
  correlatedSessions.add(info.sessionId)
  const transcript = transcriptPathFor(info.claudeSessionId)
  process.stderr.write(
    `daemon: correlate ${info.tmuxName}: hydra=${info.sessionId} ` +
    `claude=${info.claudeSessionId ?? '?'} ` +
    `transcript=${transcript ?? 'pending'} ` +
    `pane-log=${info.spawnLogPath ?? 'none'}\n`,
  )
}

export function sessionVitalsLine(info: SessionInfo, now: number, isConnected: (id: string) => boolean, v: PaneVitals, cpu?: CpuVitals): string {
  if (v.rssMB != null) vitalsSamples.set(info.sessionId, { rssMB: v.rssMB, at: now })
  const conn = isConnected(info.sessionId) ? '' : ' [disconnected]'
  const cpuPart = cpu ? ` cpu=${formatPct(cpu.claudePct)} bridge=${cpu.bridgePid ?? '?'}/${formatPct(cpu.bridgePct)}${cpu.spinning ? ` [spinning: ${cpu.spinning}]` : ''}` : ''
  return `${info.tmuxName} pid=${v.pid ?? '?'} rss=${v.rssMB ?? '?'}MB${cpuPart} up=${dur(now - info.createdAt)} idle=${dur(now - info.lastActive)}${conn}`
}

// Truncate an over-cap spawn log in place, keeping the last SPAWN_LOG_KEEP_BYTES
// (the inode-preservation rationale is at the writeFileSync call below). Best-effort
// — a few bytes appended during the read→write window may be lost; only over the cap.
export function trimSpawnLog(path: string): void {
  frontTrim(path, SPAWN_LOG_MAX_BYTES, SPAWN_LOG_KEEP_BYTES, 'spawn-log')
}

/**
 * Cap the daemon's own log, on the same principle as a spawn log.
 *
 * Only ever trims the path the launcher handed us in HYDRA_LOG — the file it is
 * teeing to. A daemon that re-derived this path could truncate the wrong file,
 * and no cap is worth that.
 */
export function trimDaemonLog(): void {
  const path = process.env.HYDRA_LOG
  if (!path) return
  frontTrim(path, DAEMON_LOG_MAX_BYTES, DAEMON_LOG_KEEP_BYTES, 'daemon-log')
}

function frontTrim(path: string, maxBytes: number, keepBytes: number, label: string): void {
  let size: number
  try { size = statSync(path).size } catch { return }
  if (size <= maxBytes) return
  try {
    const fd = openSync(path, 'r')
    let kept: Buffer
    try {
      const buf = Buffer.alloc(keepBytes)
      const read = readSync(fd, buf, 0, keepBytes, size - keepBytes)
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
    process.stderr.write(`daemon: ${label} front-trimmed ${path} (${Math.round(size / 1048576)}MB -> kept ${Math.round(keepBytes / 1048576)}MB tail)\n`)
  } catch (err) {
    process.stderr.write(`daemon: ${label} trim failed ${path}: ${err}\n`)
  }
}

/** `alert` reaches the operator (the daemon passes `notifyOperator`): host health speaks through it. */
export function startVitalsSnapshots(isConnected: (id: string) => boolean, { alert }: { alert: (text: string) => Promise<boolean> }): void {
  const host = createHostHealth({ alert })
  // A tick that outlives the interval (a slow ps or tmux) is not stacked under the next.
  let ticking = false
  setInterval(() => timed('vitals', () => {
    if (ticking) return
    ticking = true
    void vitalsTick(isConnected, host)
      .catch(err => process.stderr.write(`daemon: vitals failed: ${err}\n`))
      .finally(() => { ticking = false })
  }), VITALS_INTERVAL_MS).unref()
}

async function vitalsTick(isConnected: (id: string) => boolean, host: HostHealth): Promise<void> {
  const now = Date.now()
  // Prune diagnostic state for gone-or-dead sessions. Each map/set is pruned by
  // liveness independently: a session that registered (→ correlatedSessions) but
  // never yielded an RSS sample (→ absent from vitalsSamples) must still be
  // reclaimed. buildAutopsy reads its sample before deadAt is set
  // (checkSessionDeath). A session that dies during this tick's awaits
  // gets one sample written after its autopsy, pruned on the next tick.
  const goneOrDead = (id: string) => { const s = registry.get(id); return !s || !!s.deadAt }
  for (const id of vitalsSamples.keys()) if (goneOrDead(id)) vitalsSamples.delete(id)
  for (const prune of vitalsPruners) prune(goneOrDead)
  for (const id of correlatedSessions) if (goneOrDead(id)) correlatedSessions.delete(id)
  const live = [...registry.values()].filter(s => occupancy(s) !== 'dead')
  for (const s of live) if (s.spawnLogPath) trimSpawnLog(s.spawnLogPath)
  for (const s of live) if (s.debugLogPath) trimSpawnLog(s.debugLogPath)
  // Ahead of the empty-fleet return: a runaway can outlive every session.
  trimDaemonLog()
  const snap = await vitalsSnapshot()
  const { pressure } = snap
  // Ahead of the empty-fleet return: the host can be in trouble with no session running.
  // Like CPU sampling: a failure here must not cost the RSS line.
  try { host.tick(snap, now) } catch (err) { process.stderr.write(`daemon: host health failed: ${err}\n`) }
  const panes = new Map(live.map(s => [s.sessionId, snap.pane(s.tmuxName)]))
  let cpu: CpuSample = { sessions: new Map(), orphans: [] }
  // CPU is an addition to the line: a sampling failure must not cost the RSS line.
  // Also ahead of the empty-fleet return: an orphaned bridge can outlive every session.
  // Main has no registry record; byte's pane pid is its Claude, the fallback when its bridge has no record.
  const mainTmux = byteTmuxName(PLATFORM)
  const main = { tmuxName: mainTmux, pid: snap.root(mainTmux) }
  try { cpu = await sampleCpu(snap.procs, live, id => panes.get(id), pressure, main) } catch (err) { process.stderr.write(`daemon: cpu sample failed: ${err}\n`) }
  if (live.length === 0 && cpu.orphans.length === 0 && !cpu.main) return
  const lines = live.map(s => '  ' + sessionVitalsLine(s, now, isConnected, panes.get(s.sessionId)!, cpu.sessions.get(s.sessionId)))
  if (cpu.main) lines.push(`  ${mainTmux} (main) cpu=${formatPct(cpu.main.claudePct)} bridge=${cpu.main.bridgePid ?? '?'}/${formatPct(cpu.main.bridgePct)}${cpu.main.spinning ? ` [spinning: ${cpu.main.spinning}]` : ''}`)
  for (const o of cpu.orphans) lines.push(`  orphan bridge pid=${o.pid} session=${o.key} cpu=${formatPct(o.pct)}${o.spinning ? ' [spinning]' : ''}`)
  process.stderr.write(`${vitalsHeader(live.length, pressure, takeWorstLagMs())}\n${lines.join('\n')}\n`)
}

/** `loopLagMs`: the event loop's worst lateness since the last header (shared/loop-watch.ts). */
export function vitalsHeader(live: number, pressure: SystemPressure, loopLagMs: number): string {
  return `daemon: vitals (${live} live, ${formatPressure(pressure)}, loop=${loopLagMs}ms):`
}

// Pure: `now` and `sample` are injected (not read from the wall clock / global
// Map) so the assembled report — including the "N before death" timing and the
// sampled-vs-never-sampled branch — is deterministic and testable.
export type AutopsyExtras = {
  exitFileLines?: string[]
  stderrTail?: string[]
  debugTail?: string[]
  protocolContext?: { protocol: string; phase: string; round: string; advanceCalled: boolean; role: string } | null
  resumeCount?: number
}

export function buildAutopsy(info: SessionInfo, reason: string, blackBoxTail: string[], now: number, sample: VitalsSample | undefined, extras?: AutopsyExtras): string {
  const { exitFileLines, stderrTail, debugTail } = extras ?? {}
  const transcript = transcriptPathFor(info.claudeSessionId)
  const rss = sample ? `${sample.rssMB}MB (${dur(now - sample.at)} before death)` : 'never sampled'
  const lines = [
    `daemon: ═══ AUTOPSY ${info.tmuxName} ═══`,
    `  reason: ${reason}`,
    `  hydra=${info.sessionId} claude=${info.claudeSessionId ?? '?'} model=${info.sessionMetadata?.model ?? '?'}`,
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
  const pctx = extras?.protocolContext
  if (pctx) {
    lines.push(`  protocol: ${pctx.protocol} (${pctx.phase}, round ${pctx.round})`)
    lines.push(`  role: ${pctx.role}, advance called: ${pctx.advanceCalled}`)
  }
  if (extras?.resumeCount && extras.resumeCount > 0) {
    lines.push(`  resume #${extras.resumeCount} of conversation`)
  }
  if (transcript) {
    const forensics = readConversationForensics(transcript)
    if (forensics) {
      const tailLabel = forensics.isTail ? 'recent ' : ''
      lines.push(`  conversation: ${tailLabel}${forensics.tailTurns} turns, ${forensics.tailApiCalls} api calls${forensics.isTail ? ' (tail)' : ''}`)
      lines.push(`  last stop_reason: ${forensics.lastStopReason ?? 'none'}`)
      lines.push(`  last tool: ${forensics.lastToolCalled ?? 'none'}${forensics.lastToolPending ? ` (${forensics.pendingToolCount} PENDING — died mid-execution)` : ''}`)
      if (forensics.lastAssistantText) lines.push(`  last text: ${forensics.lastAssistantText.slice(0, 120)}...`)
    }
  }
  lines.push(`  ═══ end autopsy ═══`)
  return lines.join('\n')
}

/** Last `maxLines` lines of a black-box spawn logfile (see session-lifecycle.ts's
 *  `pipe-pane` capture). Uses `tail`, which seeks from the end, so a multi-hundred-MB
 *  pane log isn't read into memory. Throws if the file is missing/unreadable. */
export function tailSpawnLog(path: string, maxLines: number = CRASH_LOG_TAIL_LINES): string[] {
  const out = execFileSync('tail', ['-n', String(maxLines), path], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' })
  const lines = out.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function recordSessionDeath(info: SessionInfo, reason: string, protocolContext?: AutopsyExtras['protocolContext']): void {
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
  process.stderr.write(buildAutopsy(info, reason, tail, Date.now(), getVitalsSample(info.sessionId), { exitFileLines, stderrTail, debugTail, protocolContext, resumeCount: info.resumeCount }) + '\n')
  markDead(info)
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
