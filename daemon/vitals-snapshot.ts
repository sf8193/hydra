// The vitals tick's view of the machine: one `ps`, one `tmux list-panes` and the swap reading per
// tick, all async, with every pane's process subtree walked in memory from them. The tick shares
// the daemon's one event loop with every live connection. The per-process sync walk this replaces
// (`pgrep -P` and `ps -p` per process, `tmux list-panes -t` per session) blocked that loop for
// 6.0–6.7 s per tick, measured on a host running 39 sessions plus main, where one tick made ~530
// sync spawns: long enough for Slack's Socket Mode client to drop its connection.

import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { cpus, loadavg } from 'os'
import { promisify } from 'util'
import { parseMeminfoSwap, parsePs, parseSwapUsage, type ProcStat, type SystemPressure } from './cpu-spin.js'

const execFileP = promisify(execFile)

/**
 * A spawn on the vitals tick: async, and killed outright at the timeout. SIGKILL because a child
 * that ignores the default SIGTERM would leave the promise, and with it the tick's in-flight guard,
 * pending for good.
 */
export async function vitalsExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(file, args, { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 16 << 20 })
  return stdout
}

/** Every process, so ancestry and pane subtrees can be walked in memory. */
export async function psAll(): Promise<Map<number, ProcStat>> {
  return parsePs(await vitalsExec('ps', ['-A', '-o', 'pid=,ppid=,rss=,etime=,time=,comm=']))
}

// Name last: a session name may hold spaces.
export const PANE_ROOTS_FORMAT = '#{window_active} #{pane_index} #{pane_pid} #{session_name}'

/**
 * Each tmux session's pane root, from `list-panes -a -F PANE_ROOTS_FORMAT`: the first pane of the
 * session's active window, which is what `list-panes -t <session>` lists first.
 */
export function parsePaneRoots(out: string): Map<string, number> {
  const first = new Map<string, { index: number; pid: number }>()
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d) (\d+) (\d+) (.+)$/)
    if (!m || m[1] !== '1') continue
    const [, , index, pid, name] = m
    const prev = first.get(name)
    if (!prev || Number(index) < prev.index) first.set(name, { index: Number(index), pid: Number(pid) })
  }
  return new Map([...first].map(([name, p]) => [name, p.pid]))
}

async function paneRoots(): Promise<Map<string, number>> {
  try {
    return parsePaneRoots(await vitalsExec('tmux', ['list-panes', '-a', '-F', PANE_ROOTS_FORMAT]))
  } catch (err) {
    // No server is no panes, not a fault worth a line every minute.
    if (/no server running|error connecting to/.test(String((err as { stderr?: unknown }).stderr))) return new Map()
    throw err
  }
}

/** Children by parent, each list ascending: the order `pgrep -P` gave the walk this replaces. */
export function childrenIndex(procs: Map<number, ProcStat>): Map<number, number[]> {
  const kids = new Map<number, number[]>()
  for (const [pid, st] of procs) {
    if (pid === st.ppid) continue // pid 0 is its own parent
    const list = kids.get(st.ppid)
    if (list) list.push(pid); else kids.set(st.ppid, [pid])
  }
  for (const list of kids.values()) list.sort((a, b) => a - b)
  return kids
}

export type PaneVitals = { pid?: number; rssMB?: number; panePid?: number }

/**
 * pid (the root's first child) + summed RSS (MB) of a pane's whole process subtree, breadth-first.
 * Claude's tree is shell → node → claude, so a direct-children-only sum undercounts.
 */
export function paneVitals(procs: Map<number, ProcStat>, kids: Map<number, number[]>, root: number | undefined): PaneVitals {
  // A root missing from the snapshot (a pane created between the two reads) has no reading, not a 0.
  if (root === undefined || !procs.has(root)) return {}
  const subtree: number[] = []
  // A process table is a forest, but this walk must end even on a malformed one.
  const seen = new Set([root])
  for (const queue = [root]; queue.length;) {
    for (const kid of kids.get(queue.shift()!) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid); subtree.push(kid); queue.push(kid)
    }
  }
  const rssKb = [root, ...subtree].reduce((sum, pid) => sum + (procs.get(pid)?.rssKb ?? 0), 0)
  return { pid: subtree[0] ?? root, rssMB: Math.round(rssKb / 1024), panePid: root }
}

async function swapUsedMB(): Promise<number | undefined> {
  if (process.platform === 'darwin') {
    // By path: sysctl lives in /usr/sbin, which a launchd-started daemon's PATH leaves out.
    try { return parseSwapUsage(await vitalsExec('/usr/sbin/sysctl', ['vm.swapusage'])) } catch { return undefined }
  }
  try { return parseMeminfoSwap(await readFile('/proc/meminfo', 'utf8')) } catch { return undefined }
}

export async function systemPressure(): Promise<SystemPressure> {
  return { load1: loadavg()[0], cores: cpus().length, swapUsedMB: await swapUsedMB() }
}

export type VitalsSnapshot = {
  /** Undefined when `ps` failed: every pane then reads `?`, since a 0 would overwrite the last real RSS sample. */
  procs?: Map<number, ProcStat>
  /** The session's pane root pid, as tmux reported it. */
  root: (tmuxName: string) => number | undefined
  pane: (tmuxName: string) => PaneVitals
  pressure: SystemPressure
}

/** A snapshot from the tick's reads; a read that failed is undefined. */
export function snapshotFrom(procs: Map<number, ProcStat> | undefined, roots: Map<string, number> | undefined, pressure: SystemPressure): VitalsSnapshot {
  const root = (tmuxName: string) => roots?.get(tmuxName)
  if (!procs || !roots) return { procs, root, pane: () => ({}), pressure }
  const kids = childrenIndex(procs)
  return { procs, root, pane: tmuxName => paneVitals(procs, kids, root(tmuxName)), pressure }
}

/** The tick's one read of the machine. A failed `ps` or `tmux` read is logged and left undefined. */
export async function vitalsSnapshot(): Promise<VitalsSnapshot> {
  const failed = (what: string) => (err: unknown) => {
    process.stderr.write(`daemon: vitals ${what} failed: ${err}\n`)
    return undefined
  }
  const [procs, roots, pressure] = await Promise.all([psAll().catch(failed('ps')), paneRoots().catch(failed('tmux list-panes')), systemPressure()])
  return snapshotFrom(procs, roots, pressure)
}
