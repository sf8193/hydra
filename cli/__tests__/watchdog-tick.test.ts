import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { daemonRestartReason, type DaemonProbe } from '../lifecycle.js'
import { checkDaemonCpu } from '../watchdog-cpu.js'

const STALE = 300

// A healthy daemon: tmux up, fresh heartbeat, network up, not spinning.
function probe(over: Partial<DaemonProbe> = {}, calls: string[] = []): DaemonProbe {
  const track = <T>(name: string, v: () => T) => () => { calls.push(name); return v() }
  return {
    tmuxExists: track('tmux', () => true),
    heartbeatAgeS: track('heartbeat', () => 10),
    tmuxAgeS: track('tmuxAge', () => 1_000),
    networkUp: track('network', () => true),
    cpu: track('cpu', () => null),
    ...over,
  }
}

describe('daemonRestartReason', () => {
  test('a healthy daemon is left alone, and the network is never probed', () => {
    const calls: string[] = []
    expect(daemonRestartReason(probe({}, calls), STALE)).toBeNull()
    expect(calls).not.toContain('network')
    expect(calls).toContain('cpu')
  })

  test('a spinning daemon is restarted, with the CPU log line', () => {
    expect(daemonRestartReason(probe({ cpu: () => ({ pct: 98, samples: 2 }) }), STALE))
      .toBe('Daemon CPU pinned (98% >= 90% for 2 ticks), restarting daemon')
  })

  test('a spinning daemon is left alone while the network is down', () => {
    expect(daemonRestartReason(probe({ cpu: () => ({ pct: 98, samples: 2 }), networkUp: () => false }), STALE)).toBeNull()
  })

  test('a restart for a missing tmux session or a stale heartbeat comes first, and the CPU is not sampled', () => {
    const missing: string[] = []
    expect(daemonRestartReason(probe({ tmuxExists: () => false }, missing), STALE)).toBe('Daemon tmux session missing, starting')
    expect(missing).not.toContain('cpu')
    const stale: string[] = []
    expect(daemonRestartReason(probe({ heartbeatAgeS: () => 364 }, stale), STALE)).toBe('Heartbeat stale (364s > 300s), restarting daemon')
    expect(stale).not.toContain('cpu')
  })

  test('a stale heartbeat while the network is down falls through to the CPU check, which still samples', () => {
    const calls: string[] = []
    expect(daemonRestartReason(probe({ heartbeatAgeS: () => 364, networkUp: () => false }, calls), STALE)).toBeNull()
    expect(calls).toContain('cpu')
  })

  test('no heartbeat file: restart once the daemon has run past the stale threshold', () => {
    expect(daemonRestartReason(probe({ heartbeatAgeS: () => null, tmuxAgeS: () => 400 }), STALE)).toBe('No heartbeat after 400s, restarting daemon')
    expect(daemonRestartReason(probe({ heartbeatAgeS: () => null, tmuxAgeS: () => 60 }), STALE)).toBeNull()
  })
})

// The tick end to end over the real CPU check: the test process plays the daemon, and each
// "hot" tick rewinds the stored CPU reading so the interval reads as pinned.
describe('watchdog ticks over a spinning daemon', () => {
  let dir: string
  let network = true
  const sample = () => join(dir, 'watchdog-cpu.json')
  const tick = (at: number, hot: boolean) => {
    try {
      const s = JSON.parse(readFileSync(sample(), 'utf8'))
      writeFileSync(sample(), JSON.stringify({ ...s, cpuSeconds: hot ? -1_000_000 : 1e12, at: at - 120 }))
    } catch {}
    return daemonRestartReason(probe({ networkUp: () => network, cpu: () => checkDaemonCpu(dir, at, () => {}) }), STALE)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-tick-'))
    writeFileSync(join(dir, 'daemon.pid'), `${process.pid}\n`)
    network = true
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('baseline, then the second hot tick in a row restarts', () => {
    expect(tick(1_000, false)).toBeNull()
    expect(tick(2_000, true)).toBeNull()
    expect(tick(3_000, true)).toStartWith('Daemon CPU pinned')
  })

  test('a cool tick between hot ones starts the count over', () => {
    tick(1_000, false)
    tick(2_000, true)
    expect(tick(3_000, false)).toBeNull()
    expect(tick(4_000, true)).toBeNull()
    expect(tick(5_000, true)).toStartWith('Daemon CPU pinned')
  })

  test('pinned while the network is down: no restart, the count keeps going, and the first tick back online restarts', () => {
    tick(1_000, false)
    network = false
    expect(tick(2_000, true)).toBeNull()
    expect(tick(3_000, true)).toBeNull()
    network = true
    const back = tick(4_000, true)
    expect(back).toStartWith('Daemon CPU pinned')
    expect(back).toContain('for 3 ticks')
  })
})
