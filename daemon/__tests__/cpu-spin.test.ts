import { describe, test, expect } from 'bun:test'
import {
  parseCpuTime, parsePs, createCpuMeter, createSpinTracker, hotProcess, parseSwapUsage, parseMeminfoSwap,
  formatPressure, formatSpinAlert, formatCpuSummary, paneChildOf, startedAt,
} from '../cpu-spin.js'

describe('parseCpuTime', () => {
  test('macOS mmm:ss.cc — minutes are not capped at 59', () => {
    expect(parseCpuTime('0:00.00')).toBe(0)
    expect(parseCpuTime('562:03.35')).toBeCloseTo(562 * 60 + 3.35)
  })
  test('Linux [[dd-]hh:]mm:ss', () => {
    expect(parseCpuTime('00:01:05')).toBe(65)
    expect(parseCpuTime('1-02:03:04')).toBe(86400 + 2 * 3600 + 3 * 60 + 4)
  })
  test('garbage is undefined', () => {
    expect(parseCpuTime('')).toBeUndefined()
    expect(parseCpuTime('TIME')).toBeUndefined()
    expect(parseCpuTime('1:2:3:4')).toBeUndefined()
  })
})

test('parsePs reads pid, ppid, elapsed and cputime, skipping junk lines', () => {
  const stats = parsePs('    1     0 102-19:02:23 562:03.35\n14498  6381   02:05   0:00.12\nps: bogus\n\n')
  expect(stats.get(1)).toEqual({ ppid: 0, elapsedSec: 102 * 86400 + 19 * 3600 + 2 * 60 + 23, cpuSec: 562 * 60 + 3.35 })
  expect(stats.get(14498)?.elapsedSec).toBe(125)
  expect(stats.get(14498)?.ppid).toBe(6381)
  expect(stats.size).toBe(2)
})

describe('paneChildOf', () => {
  // pane zsh 10 → caffeinate 11, claude 12 → bun run 13 → bun server.ts 14 (the live tree on 2026-11-08)
  const tree = parsePs('10 1 1:00 0:00.00\n11 10 1:00 0:00.00\n12 10 1:00 0:00.00\n13 12 1:00 0:00.00\n14 13 1:00 0:00.00\n99 1 1:00 0:00.00')
  test('walks up from the bridge to the process directly under the pane, past wrappers', () => {
    expect(paneChildOf(tree, 14, 10)).toBe(12)
  })
  test('a process outside the pane has no pane child', () => {
    expect(paneChildOf(tree, 99, 10)).toBeUndefined()
    expect(paneChildOf(tree, 404, 10)).toBeUndefined()
  })
})

test('startedAt tells the process that wrote a start record from a recycled pid', () => {
  const now = 10_000_000
  const stat = { ppid: 1, cpuSec: 0, elapsedSec: 3600 }
  expect(startedAt(stat, now - 3600_000 - 2_000, now)).toBe(true)  // started an hour ago, as recorded
  expect(startedAt(stat, now - 86400_000, now)).toBe(false)        // the record is a day old: someone else's pid now
  expect(startedAt(undefined, now, now)).toBe(false)
})

describe('createCpuMeter', () => {
  test('percent of one core between two readings; none on the first', () => {
    const m = createCpuMeter()
    expect(m.update(new Map([[7, { ppid: 1, cpuSec: 100, elapsedSec: 0 }]]), 0).size).toBe(0)
    // 60s of wall, 59s of CPU: a busy-spin.
    expect(m.update(new Map([[7, { ppid: 1, cpuSec: 159, elapsedSec: 0 }]]), 60_000).get(7)).toBe(98)
  })
  test('a lifetime-idle process that starts spinning reads hot at once (no lifetime averaging)', () => {
    const m = createCpuMeter()
    m.update(new Map([[7, { ppid: 1, cpuSec: 5, elapsedSec: 0 }]]), 0)
    expect(m.update(new Map([[7, { ppid: 1, cpuSec: 65, elapsedSec: 0 }]]), 60_000).get(7)).toBe(100)
  })
  test('a pid that disappears is forgotten, so a recycled pid starts fresh', () => {
    const m = createCpuMeter()
    m.update(new Map([[7, { ppid: 1, cpuSec: 500, elapsedSec: 0 }]]), 0)
    m.update(new Map(), 60_000)
    expect(m.update(new Map([[7, { ppid: 2, cpuSec: 1, elapsedSec: 0 }]]), 120_000).size).toBe(0)
  })
  test('cputime going backwards (recycled pid between ticks) yields no reading', () => {
    const m = createCpuMeter()
    m.update(new Map([[7, { ppid: 1, cpuSec: 500, elapsedSec: 0 }]]), 0)
    expect(m.update(new Map([[7, { ppid: 2, cpuSec: 1, elapsedSec: 0 }]]), 60_000).size).toBe(0)
  })
})

describe('spin classifier', () => {
  const hot = { bridgePct: 99, claudePct: 1, idle: true }
  const cool = { bridgePct: 0, claudePct: 1, idle: true }

  test('hotProcess prefers the bridge, then Claude, at the threshold', () => {
    expect(hotProcess({ bridgePct: 90, claudePct: 95, idle: true })).toBe('bridge')
    expect(hotProcess({ bridgePct: 89, claudePct: 90, idle: true })).toBe('claude')
    expect(hotProcess({ idle: true })).toBeNull()
  })

  test('spinning after two hot idle samples in a row, newly only once per episode', () => {
    const t = createSpinTracker(90, 2)
    expect(t.observe('a', hot)).toEqual({ spinning: null, newly: false })
    expect(t.observe('a', hot)).toEqual({ spinning: 'bridge', newly: true })
    expect(t.observe('a', hot)).toEqual({ spinning: 'bridge', newly: false })
  })

  test('a cool sample ends the episode; the next one alerts again', () => {
    const t = createSpinTracker(90, 2)
    t.observe('a', hot); t.observe('a', hot)
    expect(t.observe('a', cool).spinning).toBeNull()
    t.observe('a', hot)
    expect(t.observe('a', hot)).toEqual({ spinning: 'bridge', newly: true })
  })

  test('a working session is never spinning, however hot', () => {
    const t = createSpinTracker(90, 2)
    for (let i = 0; i < 5; i++) expect(t.observe('a', { ...hot, idle: false }).spinning).toBeNull()
  })

  test('an unsampled reading (first tick of a pid) breaks the streak', () => {
    const t = createSpinTracker(90, 2)
    t.observe('a', hot)
    t.observe('a', { idle: true })
    expect(t.observe('a', hot).spinning).toBeNull()
  })

  test('sessions are tracked independently; forget drops one', () => {
    const t = createSpinTracker(90, 2)
    t.observe('a', hot); t.observe('b', hot)
    t.forget('a')
    expect(t.observe('a', hot).spinning).toBeNull()
    expect(t.observe('b', hot).newly).toBe(true)
    expect(t.ids().sort()).toEqual(['a', 'b'])
  })
})

describe('system pressure', () => {
  test('macOS sysctl vm.swapusage', () => {
    expect(parseSwapUsage('vm.swapusage: total = 6144.00M  used = 4836.00M  free = 1308.00M  (encrypted)')).toBe(4836)
    expect(parseSwapUsage('total = 2.00G  used = 1.50G  free = 0.50G')).toBe(1536)
    expect(parseSwapUsage('nonsense')).toBeUndefined()
  })
  test('Linux /proc/meminfo', () => {
    expect(parseMeminfoSwap('MemTotal:  1 kB\nSwapTotal:     2097152 kB\nSwapFree:      1048576 kB\n')).toBe(1024)
    expect(parseMeminfoSwap('MemTotal: 1 kB\n')).toBeUndefined()
  })
  test('formatPressure', () => {
    expect(formatPressure({ load1: 7.234, cores: 10, swapUsedMB: 4836 })).toBe('load=7.2/10cores swap=4836MB')
    expect(formatPressure({ load1: 0.5, cores: 4 })).toBe('load=0.5/4cores')
  })
})

test('formatCpuSummary', () => {
  expect(formatCpuSummary({ claudePct: 3, bridgePct: 0, spinning: null })).toBe('claude 3% · bridge 0%')
  expect(formatCpuSummary({ bridgePct: 99, spinning: 'bridge' })).toBe('claude ? · bridge 99% · spinning (bridge)')
})

test('formatSpinAlert: one message, every entry, combined cores, advice per kind', () => {
  const text = formatSpinAlert([
    { name: 'pixel', url: 'https://x/1', label: 'TD build', who: 'bridge', pct: 99, pid: 111 },
    { name: 'orbit', who: 'claude', pct: 95, pid: 222 },
    { name: 'session 0523124d', who: 'orphan', pct: 100, pid: 333 },
  ], { load1: 9.1, cores: 10, swapUsedMB: 5000 })
  const lines = text.split('\n')
  expect(lines[0]).toContain('3 idle processes are spinning')
  expect(lines[0]).toContain('~2.9 cores')
  expect(lines[0]).toContain('load=9.1/10cores swap=5000MB')
  expect(lines[1]).toBe('• [pixel](https://x/1) — TD build · bridge pid 111 at 99%: `kill 111`, then `resume` in the thread')
  // Never advise killing Claude itself.
  expect(lines[2]).toBe('• `orbit` · Claude pid 222 at 95% while idle: check its pane')
  expect(lines[2]).not.toContain('kill')
  expect(lines[3]).toBe('• `session 0523124d` · orphan bridge pid 333 at 100%, its launcher gone: `kill 333`')
})
