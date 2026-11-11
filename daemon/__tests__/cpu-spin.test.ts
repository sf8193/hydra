import { describe, test, expect } from 'bun:test'
import {
  parsePs, createCpuMeter, createSpinTracker, hotProcess, parseSwapUsage, parseMeminfoSwap, parseMemoryPressure, createHostIdleMeter,
  formatPressure, formatSpinAlert, formatCpuSummary, claudeAncestor, startedAt,
} from '../cpu-spin.js'
import { parseCpuTime } from '../../shared/constants.js'
import { systemPressure } from '../vitals-snapshot.js'

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

test('parsePs reads pid, ppid, rss, elapsed and cputime, skipping junk lines', () => {
  const stats = parsePs('    1     0  12816 102-19:02:23 562:03.35\n14498  6381    208   02:05   0:00.12\nps: bogus\n\n')
  expect(stats.get(1)).toEqual({ ppid: 0, rssKb: 12816, elapsedSec: 102 * 86400 + 19 * 3600 + 2 * 60 + 23, cpuSec: 562 * 60 + 3.35 })
  expect(stats.get(14498)).toEqual({ ppid: 6381, rssKb: 208, elapsedSec: 125, cpuSec: 0.12 })
  expect(stats.size).toBe(2)
})

test('parsePs reads the 6-column form, keeping a command with spaces whole', () => {
  const stats = parsePs('63562 53795 412304  21-22:38:01  89:13.03 claude\n  787     1  20480 102-19:01:15  87:09.11 Core Audio Driver (Zoom)\n')
  expect(stats.get(63562)).toMatchObject({ ppid: 53795, rssKb: 412304, comm: 'claude' })
  expect(stats.get(787)).toMatchObject({ ppid: 1, rssKb: 20480, cpuSec: 87 * 60 + 9.11, comm: 'Core Audio Driver (Zoom)' })
})

describe('claudeAncestor', () => {
  // Both live shapes (2026-11-08): a spawn's pane is a zsh wrapper with Claude under it; byte's pane is Claude.
  const spawn = parsePs([
    '10 1 100 1:00 0:00.00 zsh', '11 10 100 1:00 0:00.00 caffeinate', '12 10 100 1:00 0:00.00 claude',
    '13 12 100 1:00 0:00.00 bun', '14 13 100 1:00 0:00.00 /opt/homebrew/bin/bun', '99 1 100 1:00 0:00.00 bun',
  ].join('\n'))
  const byte = parsePs(['20 1 100 1:00 0:00.00 claude', '21 20 100 1:00 0:00.00 caffeinate', '22 20 100 1:00 0:00.00 bun', '23 22 100 1:00 0:00.00 /opt/homebrew/bin/bun'].join('\n'))
  test('a spawn: past the bun wrapper to the claude under the pane', () => {
    expect(claudeAncestor(spawn, 14)).toBe(12)
  })
  test('byte: the pane itself is claude, not the wrapper directly under it', () => {
    expect(claudeAncestor(byte, 23)).toBe(20)
  })
  test('no claude above it: undefined', () => {
    expect(claudeAncestor(spawn, 99)).toBeUndefined()
    expect(claudeAncestor(spawn, 404)).toBeUndefined()
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
  const hot = { bridgePct: 99, claudePct: 1, bridgePid: 7, claudePid: 6, idle: true }
  const cool = { bridgePct: 0, claudePct: 1, bridgePid: 7, claudePid: 6, idle: true }

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

  test('the streak follows one process: a different bridge pid, or bridge then Claude, starts over', () => {
    const t = createSpinTracker(90, 2)
    t.observe('a', hot)
    expect(t.observe('a', { ...hot, bridgePid: 8 }).spinning).toBeNull()             // another bridge
    expect(t.observe('a', { ...hot, bridgePid: 8 })).toEqual({ spinning: 'bridge', newly: true })
    t.observe('b', hot)
    expect(t.observe('b', { bridgePct: 0, claudePct: 99, bridgePid: 7, claudePid: 6, idle: true }).spinning).toBeNull()
  })

  test('a new hot process after an alerted episode alerts again', () => {
    const t = createSpinTracker(90, 2)
    t.observe('a', hot); t.observe('a', hot)
    t.observe('a', { ...hot, bridgePid: 8 })
    expect(t.observe('a', { ...hot, bridgePid: 8 }).newly).toBe(true)
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
    expect(parseSwapUsage('vm.swapusage: total = 6144.00M  used = 4836.00M  free = 1308.00M  (encrypted)')).toEqual({ usedMB: 4836, totalMB: 6144 })
    expect(parseSwapUsage('total = 2.00G  used = 1.50G  free = 0.50G')).toEqual({ usedMB: 1536, totalMB: 2048 })
    expect(parseSwapUsage('nonsense')).toBeUndefined()
  })
  test('macOS pressure level and swap, from the one sysctl read', () => {
    const out = 'kern.memorystatus_vm_pressure_level: 1\nvm.swapusage: total = 5120.00M  used = 3387.31M  free = 1732.69M  (encrypted)\n'
    expect(parseMemoryPressure(out)).toBe('normal')
    expect(parseSwapUsage(out)).toEqual({ usedMB: 3387, totalMB: 5120 })
    expect(parseMemoryPressure('kern.memorystatus_vm_pressure_level: 2')).toBe('warn')
    expect(parseMemoryPressure('kern.memorystatus_vm_pressure_level: 4')).toBe('critical')
    // An unknown level, or none (an OID this macOS lacks), is no reading.
    expect(parseMemoryPressure('kern.memorystatus_vm_pressure_level: 3')).toBeUndefined()
    expect(parseMemoryPressure(out.split('\n')[1])).toBeUndefined()
  })
  test('Linux /proc/meminfo', () => {
    expect(parseMeminfoSwap('MemTotal:  1 kB\nSwapTotal:     2097152 kB\nSwapFree:      1048576 kB\n')).toEqual({ usedMB: 1024, totalMB: 2048 })
    expect(parseMeminfoSwap('MemTotal: 1 kB\n')).toBeUndefined()
  })
  test('formatPressure', () => {
    expect(formatPressure({ load1: 7.234, cores: 10, swapUsedMB: 4836 })).toBe('load=7.2/10cores swap=4836MB')
    expect(formatPressure({ load1: 0.5, cores: 4 })).toBe('load=0.5/4cores')
    // Everything host health judges by, so the log explains each verdict.
    expect(formatPressure({ load1: 40.2, load15: 31.04, cores: 16, idlePct: 44, swapUsedMB: 15100, swapTotalMB: 16384 }))
      .toBe('load=40.2/16cores load15=31.0 idle=44% swap=15100/16384MB')
    expect(formatPressure({ load1: 1, cores: 4, memoryPressure: 'warn', swapUsedMB: 3387, swapTotalMB: 5120 })).toBe('load=1.0/4cores memory=warn swap=3387/5120MB')
    // Idle floored: 14.6% under a 15% limit never reads as 15%.
    expect(formatPressure({ load1: 1, cores: 4, idlePct: 14.6 })).toBe('load=1.0/4cores idle=14%')
  })
  test('host idle: from the change in every core\'s times, none on the first reading', () => {
    const meter = createHostIdleMeter()
    const core = (busy: number, idle: number) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 })
    expect(meter([core(100, 100), core(100, 100)])).toBeUndefined()
    // 400 ms elapsed across both cores, 60 of it idle.
    expect(meter([core(270, 130), core(270, 130)])).toBe(15)
    // Unrounded: 400 ms elapsed, 58.4 of it idle.
    expect(meter([core(440.8, 159.2), core(440.8, 159.2)])).toBeCloseTo(14.6, 5)
    // A clock that did not move has no answer, nor does a change in core count.
    expect(meter([core(440.8, 159.2), core(440.8, 159.2)])).toBeUndefined()
    expect(meter([core(300, 200)])).toBeUndefined()
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
  expect(lines[1]).toBe('• [pixel](https://x/1) — TD build · bridge pid 111 at 99%: `kill 111`; if it\'s still there, `kill -9 111`, then `resume` in the thread')
  // Never advise killing Claude itself.
  expect(lines[2]).toBe('• `orbit` · Claude pid 222 at 95% while idle: check its pane')
  expect(lines[2]).not.toContain('kill')
  expect(lines[3]).toBe('• `session 0523124d` · orphan bridge pid 333 at 100%, its launcher gone: `kill 333`; if it\'s still there, `kill -9 333`')
})

// A launchd-started daemon's PATH has no /usr/sbin, where sysctl lives: swap must still be read. In-process, so a
// loaded suite can't time it out.
test.if(process.platform === 'darwin')('swap is read with a PATH that leaves out /usr/sbin', async () => {
  const path = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  try { const p = await systemPressure(); expect(p.swapUsedMB).toBeNumber(); expect(p.swapTotalMB).toBeNumber(); expect(['normal', 'warn', 'critical']).toContain(p.memoryPressure!) } finally { process.env.PATH = path }
})
