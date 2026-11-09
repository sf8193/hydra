import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { cpuPercent, checkDaemonCpu, MIN_INTERVAL_S } from '../watchdog-cpu.js'
import { SPIN_CONSECUTIVE_SAMPLES } from '../../shared/constants.js'

describe('cpuPercent', () => {
  test('CPU over wall time between two readings of one process, as percent of a core', () => {
    expect(cpuPercent({ pid: 1, cpuSeconds: 10, at: 0 }, { pid: 1, cpuSeconds: 130, at: 120 })).toBe(100)
    expect(cpuPercent({ pid: 1, cpuSeconds: 10, at: 0 }, { pid: 1, cpuSeconds: 16, at: 120 })).toBe(5)
  })
  test('no comparison across a restart (new pid), without a previous reading, over too short an interval, or when CPU went down', () => {
    expect(cpuPercent(undefined, { pid: 1, cpuSeconds: 10, at: 0 })).toBeNull()
    expect(cpuPercent({ pid: 1, cpuSeconds: 0, at: 0 }, { pid: 2, cpuSeconds: 500, at: 120 })).toBeNull()
    expect(cpuPercent({ pid: 1, cpuSeconds: 0, at: 0 }, { pid: 1, cpuSeconds: 30, at: MIN_INTERVAL_S - 1 })).toBeNull()
    expect(cpuPercent({ pid: 1, cpuSeconds: 50, at: 0 }, { pid: 1, cpuSeconds: 10, at: 120 })).toBeNull()
  })
})

describe('checkDaemonCpu', () => {
  let dir: string
  // The test process stands in for the daemon: real ps, a known pid. A previous sample far
  // below its real CPU time reads as hot; one far above, as cool (CPU can't go down: no reading).
  const pid = process.pid
  const samplePath = () => join(dir, 'watchdog-cpu.json')
  const saved = () => JSON.parse(readFileSync(samplePath(), 'utf8'))
  const seed = (s: object) => writeFileSync(samplePath(), JSON.stringify({ pid, cpuSeconds: 0, hot: 0, ...s }))
  const logs: string[] = []
  const log = (m: string) => { logs.push(m) }
  // Each hot tick moves the stored reading forward 120s and back to "far behind" on CPU.
  const hotTick = (at: number) => {
    seed({ ...saved(), cpuSeconds: -1_000_000, at: at - 120 })
    return checkDaemonCpu(dir, at, log)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-cpu-'))
    writeFileSync(join(dir, 'daemon.pid'), `${pid}\n`)
    logs.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('the first tick only records a sample', () => {
    expect(checkDaemonCpu(dir, 1_000, log)).toBeNull()
    expect(saved()).toMatchObject({ pid, at: 1_000, hot: 0 })
  })

  test(`spinning takes ${SPIN_CONSECUTIVE_SAMPLES} hot ticks in a row, the vitals definition`, () => {
    seed({ at: 0 })
    let r = null
    for (let i = 1; i < SPIN_CONSECUTIVE_SAMPLES; i++) {
      r = hotTick(10_000 * i)
      expect(r).toBeNull()
      expect(saved().hot).toBe(i)
    }
    r = hotTick(10_000 * SPIN_CONSECUTIVE_SAMPLES)
    expect(r).toMatchObject({ samples: SPIN_CONSECUTIVE_SAMPLES })
    expect(r!.pct).toBeGreaterThanOrEqual(90)
  })

  test('a cool tick starts the count over', () => {
    seed({ at: 0, hot: SPIN_CONSECUTIVE_SAMPLES - 1 })
    seed({ ...saved(), cpuSeconds: 1e12, at: 9_880 })
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    expect(saved()).toMatchObject({ at: 10_000, hot: 0 })
  })

  test('a tick too soon after the last keeps the older sample and its count', () => {
    seed({ at: 10_000, hot: 1 })
    expect(checkDaemonCpu(dir, 10_010, log)).toBeNull()
    expect(saved()).toMatchObject({ at: 10_000, hot: 1 })
  })

  test('a sample from after this tick (the clock went back) is replaced and the count starts over', () => {
    seed({ at: 20_000, hot: 1 })
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    expect(saved()).toMatchObject({ at: 10_000, hot: 0 })
  })

  test('a sample from an earlier daemon is a fresh baseline, not a comparison', () => {
    seed({ pid: pid + 99_999, cpuSeconds: -1_000, at: 9_880, hot: 5 })
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    expect(saved()).toMatchObject({ pid, hot: 0 })
  })

  test('losing the pid file is logged once and drops the sample', () => {
    seed({ at: 9_880 })
    rmSync(join(dir, 'daemon.pid'))
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    expect(checkDaemonCpu(dir, 10_120, log)).toBeNull()
    expect(logs.length).toBe(1)
    expect(existsSync(samplePath())).toBe(false)
  })

  test('no pid file or a gone process: nothing measured, nothing saved', () => {
    rmSync(join(dir, 'daemon.pid'))
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    writeFileSync(join(dir, 'daemon.pid'), '999999\n')
    expect(checkDaemonCpu(dir, 10_000, log)).toBeNull()
    expect(existsSync(samplePath())).toBe(false)
    expect(logs).toEqual([])
  })
})
