// CPU sampling on the vitals tick: one `ps` for every session's Claude and bridge pid, the
// spin classifier over the result, and a batched operator alert when sessions start spinning.
// Report-only: it reads system pressure but acts on nothing. A bridge whose launcher has died
// (reparented) is sampled too: nothing else would ever notice it spinning.
//
// A bridge's pid comes from its bridge-life record (`<sessionId>-<pid>.jsonl`, written by the
// bridge itself at start), not from the bridge socket: the bridges that spun on 2026-11-08 had
// stopped re-registering, so the socket no longer knew them. The bridge runs under a `bun run`
// wrapper that Claude starts, so the record's `start.ppid` is that wrapper, not Claude; it is used
// only to tell the live bridge from a recycled pid. Claude is the bridge's nearest `claude` ancestor.
// Main (byte) has no registry record but writes records under the key `main`, so it is sampled too.

import { readdirSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { loadavg, cpus } from 'os'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { threadRegistry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { notifyOperator } from './access.js'
import { isSessionWorking } from './session-activity.js'
import { fallbackDescription, isTmuxRecentlyActiveSync } from './util.js'
import { bridgeLifeDir, type BridgeLifeEvent } from '../shared/bridge-life.js'
import { SPIN_CPU_PERCENT } from '../shared/constants.js'
import {
  claudeAncestor, createCpuMeter, createSpinTracker, formatSpinAlert, hotProcess, parseMeminfoSwap, parsePs, parseSwapUsage, startedAt,
  type ProcStat, type SpinEntry, type SpinWho, type SystemPressure,
} from './cpu-spin.js'

export type CpuVitals = {
  claudePid?: number
  claudePct?: number
  bridgePid?: number
  bridgePct?: number
  spinning: SpinWho | null
  at: number
}

/** A live bridge whose launcher has died (reparented): no session owns it any more. */
export type OrphanBridge = { pid: number; key: string; pct?: number; spinning: boolean }

export type CpuSample = { sessions: Map<string, CpuVitals>; orphans: OrphanBridge[]; main?: CpuVitals }

type StartRecord = { pid: number; ppid: number; ts: number }

const meter = createCpuMeter()
let spinThreshold = SPIN_CPU_PERCENT
let tracker = createSpinTracker(spinThreshold)
const latest = new Map<string, CpuVitals>()
// A record's start line never changes, so it is read once per file (once it has been written).
const startRecords = new Map<string, StartRecord>()

/**
 * Test seam: a real-process test can't count on a loaded machine giving its busy loop 90% of a core.
 * The classifier's own threshold behaviour is pinned in cpu-spin.test.ts; this resets all spin state.
 */
export function _setSpinThresholdForTesting(pct?: number): void {
  spinThreshold = pct ?? SPIN_CPU_PERCENT
  tracker = createSpinTracker(spinThreshold)
}

/** The last CPU reading for a session, for `hydra list`/`status`. Ephemeral, like the RSS sample. */
export function getCpuVitals(sessionId: string): CpuVitals | undefined {
  return latest.get(sessionId)
}

function readStart(path: string): StartRecord | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  try {
    const ev = JSON.parse(raw.split('\n', 1)[0]) as BridgeLifeEvent
    return ev.ev === 'start' ? { pid: ev.pid, ppid: ev.ppid, ts: ev.ts } : undefined
  } catch { return undefined }
}

/** Every bridge-life start record, with the session key it is filed under (non-word chars → `_`). */
function bridgeRecords(stateDir: string): Array<StartRecord & { key: string }> {
  const out: Array<StartRecord & { key: string }> = []
  let names: string[]
  try { names = readdirSync(bridgeLifeDir(stateDir)) } catch { return out }
  const seen = new Set<string>()
  for (const name of names) {
    const m = name.match(/^(.+)-(\d+)\.jsonl$/)
    if (!m) continue
    const path = join(bridgeLifeDir(stateDir), name)
    seen.add(path)
    // Not cached until it parses: the file can exist a moment before its start line does.
    const start = startRecords.get(path) ?? readStart(path)
    if (!start || start.pid !== Number(m[2])) continue
    startRecords.set(path, start)
    out.push({ ...start, key: m[1] })
  }
  for (const path of startRecords.keys()) if (!seen.has(path)) startRecords.delete(path)
  return out
}

/** One `ps` per tick: every process, so a bridge's ancestry can be walked in memory. */
function psAll(): Map<number, ProcStat> {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,time=,comm='], { encoding: 'utf8' })
  return parsePs(r.stdout ?? '')
}

function swapUsedMB(): number | undefined {
  if (process.platform === 'darwin') {
    const r = spawnSync('sysctl', ['vm.swapusage'], { encoding: 'utf8' })
    return parseSwapUsage(r.stdout ?? '')
  }
  try { return parseMeminfoSwap(readFileSync('/proc/meminfo', 'utf8')) } catch { return undefined }
}

export function systemPressure(): SystemPressure {
  return { load1: loadavg()[0], cores: cpus().length, swapUsedMB: swapUsedMB() }
}

export type PaneProcs = { pid?: number }

/** The main session (byte): it has no registry record, but it has a bridge, a Claude and a pane like any other. */
export type MainSubject = { tmuxName: string; pid?: number }

/** One thing to sample: a session, or main under the bridge-life key `main`. */
type Subject = {
  id: string
  key: string
  fallbackClaude?: number
  idle: () => boolean
  entry: () => Pick<SpinEntry, 'name' | 'url' | 'label'>
}

function sessionSubject(s: SessionInfo, pane: PaneProcs): Subject {
  return {
    id: s.sessionId,
    key: s.sessionId.replace(/[^\w-]/g, '_'),
    fallbackClaude: pane.pid,
    idle: () => !isSessionWorking(s),
    entry: () => {
      const thread = threadRegistry.get(s.threadId)
      return { name: s.tmuxName, url: thread?.threadUrl, label: s.description?.split('\n')[0].trim() || fallbackDescription(thread?.topic ?? '') }
    },
  }
}

function mainSubject(m: MainSubject): Subject {
  return {
    id: 'main',
    key: 'main',
    fallbackClaude: m.pid,
    idle: () => !isTmuxRecentlyActiveSync(m.tmuxName),
    entry: () => ({ name: `${m.tmuxName} (main)` }),
  }
}

/**
 * Sample every live session's CPU, main's, and every orphaned bridge's; classify spins, and alert once
 * per episode. A subject's Claude is its bridge's nearest `claude` ancestor; `pane` gives a fallback
 * (the pane's first child) for a session with no live bridge.
 */
export function sampleCpu(live: SessionInfo[], pane: (sessionId: string) => PaneProcs | undefined, pressure: SystemPressure, main?: MainSubject): CpuSample {
  const records = bridgeRecords(STATE_DIR)
  const all = psAll()
  const now = Date.now()
  // A record is live when its pid still runs and started when the record says (not a recycled pid).
  const liveRecords = records.filter(r => startedAt(all.get(r.pid), r.ts, now))
  const subjects = [...live.map(s => sessionSubject(s, pane(s.sessionId) ?? {})), ...(main ? [mainSubject(main)] : [])]
  const perSubject = subjects.map(subject => {
    const bridges = liveRecords.filter(r => r.key === subject.key && all.get(r.pid)?.ppid === r.ppid)
    const viaBridge = bridges.map(b => claudeAncestor(all, b.pid)).find(pid => pid !== undefined)
    // A failed pane lookup keeps last tick's Claude, so one flaky tmux call does not end an episode.
    const prev = latest.get(subject.id)?.claudePid
    const claudePid = viaBridge ?? subject.fallbackClaude ?? (prev !== undefined && all.has(prev) ? prev : undefined)
    return { subject, bridges, claudePid }
  })
  const orphans = liveRecords.filter(r => all.get(r.pid)?.ppid !== r.ppid)

  const watched = new Map<number, ProcStat>()
  const watch = (pid: number | undefined) => { const st = pid === undefined ? undefined : all.get(pid); if (st) watched.set(pid!, st) }
  for (const p of perSubject) { watch(p.claudePid); p.bridges.forEach(b => watch(b.pid)) }
  orphans.forEach(o => watch(o.pid))
  const pct = meter.update(watched, now)

  const readings = new Map<string, CpuVitals>()
  const newly: SpinEntry[] = []
  for (const { subject, bridges, claudePid } of perSubject) {
    const bridge = [...bridges].sort((a, b) => (pct.get(b.pid) ?? -1) - (pct.get(a.pid) ?? -1))[0]
    const reading = {
      claudePid, bridgePid: bridge?.pid,
      claudePct: claudePid ? pct.get(claudePid) : undefined,
      bridgePct: bridge ? pct.get(bridge.pid) : undefined,
    }
    // The idle test reads tmux, so it is only asked when something is hot.
    const idle = hotProcess({ ...reading, idle: true }, spinThreshold) ? subject.idle() : true
    const state = tracker.observe(subject.id, { ...reading, idle })
    const v: CpuVitals = { ...reading, spinning: state.spinning, at: now }
    readings.set(subject.id, v)
    latest.set(subject.id, v)
    if (state.newly && state.spinning) {
      newly.push({
        ...subject.entry(),
        who: state.spinning,
        pct: (state.spinning === 'bridge' ? reading.bridgePct : reading.claudePct) ?? 0,
        pid: state.spinning === 'bridge' ? bridge?.pid : claudePid,
      })
    }
  }

  // An orphan bridge has no Claude to work for, so it is always idle.
  const orphanVitals: OrphanBridge[] = orphans.map(o => {
    const state = tracker.observe(`orphan:${o.pid}`, { bridgePct: pct.get(o.pid), bridgePid: o.pid, idle: true })
    if (state.newly) newly.push({ name: `session ${o.key.slice(0, 8)}`, who: 'orphan', pct: pct.get(o.pid) ?? 0, pid: o.pid })
    return { pid: o.pid, key: o.key, pct: pct.get(o.pid), spinning: !!state.spinning }
  })

  const keep = new Set([...subjects.map(s => s.id), ...orphans.map(o => `orphan:${o.pid}`)])
  for (const id of latest.keys()) if (!keep.has(id)) latest.delete(id)
  for (const id of tracker.ids()) if (!keep.has(id)) tracker.forget(id)
  if (newly.length > 0) alertSpinning(newly, pressure)
  const mainReading = readings.get('main')
  readings.delete('main')
  return { sessions: readings, orphans: orphanVitals, ...(mainReading && { main: mainReading }) }
}

function alertSpinning(entries: SpinEntry[], p: SystemPressure): void {
  const text = formatSpinAlert(entries, p)
  process.stderr.write(`daemon: spinning: ${entries.map(e => `${e.name} (${e.who} pid ${e.pid ?? '?'} ${e.pct}%)`).join(', ')}\n`)
  void notifyOperator(text).then(sent => {
    if (!sent) process.stderr.write(`daemon: spin alert not delivered to any operator\n`)
  })
}
