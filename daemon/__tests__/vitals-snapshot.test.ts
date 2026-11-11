// The vitals snapshot: one `ps` and one `tmux list-panes` per tick, every pane's vitals walked in memory.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parsePs, type ProcStat } from '../cpu-spin.js'
import { childrenIndex, paneVitals, parsePaneRoots, snapshotFrom } from '../vitals-snapshot.js'

describe('pane vitals from one process snapshot', () => {
  // `ps -A -o pid=,ppid=,rss=,etime=,time=,comm=`, deliberately out of pid order. A spawn's pane is a
  // zsh wrapper (caffeinate and claude under it, claude's bridge two levels further down); byte's pane
  // is claude itself.
  const procs = parsePs([
    '  305   302  40960 1:00 0:00.00 node',
    '  300     1   2048 1:00 0:00.00 zsh',
    '  302   300 409600 1:00 0:00.00 claude',
    '  301   300   1024 1:00 0:00.00 caffeinate',
    '  304   303  81920 1:00 0:00.00 /opt/homebrew/bin/bun',
    '  303   302   8192 1:00 0:00.00 bun',
    '  400     1 307200 1:00 0:00.00 claude',
    '  401   400   1024 1:00 0:00.00 caffeinate',
    '  402   400  65536 1:00 0:00.00 bun',
    '  999     1 999999 1:00 0:00.00 Unrelated App',
    '    0     0      0 1:00 0:00.00 kernel_task',
  ].join('\n'))

  // The walk vitals did before: `pgrep -P` per process (ascending pids), breadth-first, then `ps -o rss= -p` per pid.
  function walkAsBefore(stats: Map<number, ProcStat>, root: number) {
    const pgrep = (pid: number) => [...stats].filter(([p, s]) => s.ppid === pid && p !== pid).map(([p]) => p).sort((a, b) => a - b)
    const subtree: number[] = []
    for (const queue = [root]; queue.length;) for (const kid of pgrep(queue.shift()!)) { subtree.push(kid); queue.push(kid) }
    const rssKb = [root, ...subtree].reduce((n, p) => n + (stats.get(p)?.rssKb ?? 0), 0)
    return { pid: subtree[0] ?? root, rssMB: Math.round(rssKb / 1024), panePid: root }
  }

  test('equal the per-process walk on the same tree: pid is the first child, RSS the whole subtree, main included', () => {
    const kids = childrenIndex(procs)
    for (const root of [300, 302, 400, 304]) expect(paneVitals(procs, kids, root)).toEqual(walkAsBefore(procs, root))
    expect(paneVitals(procs, kids, 300)).toEqual({ pid: 301, rssMB: Math.round((2048 + 409600 + 1024 + 81920 + 8192 + 40960) / 1024), panePid: 300 })
    expect(paneVitals(procs, kids, 400)).toEqual({ pid: 401, rssMB: Math.round((307200 + 1024 + 65536) / 1024), panePid: 400 })
    // A leaf reports itself. A session with no pane, or a pane root the snapshot lacks (created between
    // the two reads), reports nothing rather than an RSS of 0.
    expect(paneVitals(procs, kids, 304)).toEqual({ pid: 304, rssMB: 80, panePid: 304 })
    expect(paneVitals(procs, kids, undefined)).toEqual({})
    expect(paneVitals(procs, kids, 777)).toEqual({})
  })

  test('the walk ends on a malformed table with a parent cycle', () => {
    const cyclic = parsePs(['10 11 1024 1:00 0:00.00 a', '11 10 1024 1:00 0:00.00 b'].join('\n'))
    expect(paneVitals(cyclic, childrenIndex(cyclic), 10)).toEqual({ pid: 11, rssMB: 2, panePid: 10 })
  })

  test('pane roots: the first pane of each session\'s active window, whatever the active pane', () => {
    const roots = parsePaneRoots([
      '0 0 500 multi', '0 1 501 multi',   // inactive window
      '1 1 503 multi', '1 0 502 multi',   // active window, listed out of index order
      '1 0 400 byte',
      '1 0 600 a name with spaces',
      '1 0  bad', '',
    ].join('\n'))
    expect(roots).toEqual(new Map([['multi', 502], ['byte', 400], ['a name with spaces', 600]]))
  })
})


// A failed `ps` (it has a timeout, which a loaded machine just woken can hit) while tmux still answers.
describe('a snapshot whose ps failed', () => {
  const snap = snapshotFrom(undefined, new Map([['pane-session', 4242]]), { load1: 1, cores: 10 })

  test('leaves every pane unread, not an RSS of 0 that would overwrite the last real sample', () => {
    expect(snap.procs).toBeUndefined()
    expect(snap.pane('pane-session')).toEqual({})
  })

  test('still reports the pane root tmux gave (main\'s fallback Claude)', () => {
    expect(snap.root('pane-session')).toBe(4242)
    expect(snap.root('absent')).toBeUndefined()
  })
})

// The vitals tick runs on the daemon's one event loop, which every live connection shares: a sync
// spawn on it stalls them all. Lexical, over the three vitals modules' own code; the idle check they
// reach through session-activity/util is pinned behaviourally in cpu-watch-idle.test.ts. The one sync
// spawn left in these files is tailSpawnLog's `tail`, run per session death, not on the tick.
test('no sync spawn in the vitals modules', () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, '..', f), 'utf8')
  const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\b/g
  expect(src('vitals-snapshot.ts')).not.toMatch(SYNC_SPAWN)
  const obs = src('observability.ts')
  expect(obs.match(/(?:spawnSync|execFileSync|execSync)\(/g)).toEqual(['execFileSync('])
  expect(obs).toContain("execFileSync('tail'")
  // cpu-watch may read files synchronously (bridge-life records), but call no other *Sync helper.
  const cw = src('cpu-watch.ts')
  expect(cw).not.toMatch(SYNC_SPAWN)
  expect([...new Set(cw.match(/\b\w+Sync\b/g))].sort()).toEqual(['readFileSync', 'readdirSync'])
})
