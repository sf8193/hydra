// sampleCpu against real processes: a busy child of this test stands in for a spinning bridge,
// found the way the daemon finds one, through its bridge-life record.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process'
import { sampleCpu, getCpuVitals, liveBridgePids, _setSpinThresholdForTesting } from '../cpu-watch.js'
import { STATE_DIR, ACCESS_FILE, gateway } from '../config.js'
import { bridgeLifePath } from '../../shared/bridge-life.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { fakeAdapter } from './test-harness.js'
import { _setHealDepsForTesting, healSession, type HealDeps, type HealReason } from '../spin-heal.js'

const PRESSURE = { load1: 1, cores: 10 }
// The busy child is the bridge. Its Claude is its nearest `claude` ancestor, which exists when the suite runs
// inside a Claude session and not otherwise; then the pane fallback (this process) stands in. Which one is the
// environment's business: claudeAncestor itself is pinned on the live tree shapes in cpu-spin.test.ts.
const PANE = { pid: process.pid }
const BUSY = 'for(;;){}'
let busy: ChildProcess
let busyStartedAt = 0
let dms: string[] = []
let origSendDM: any
const records: string[] = []
const strays: number[] = []

function session(id: string, live: 'idle' | 'working' = 'idle'): SessionInfo {
  return {
    sessionId: id, topic: 'topic', threadId: `thread-${id}`, createdAt: 0, lastActive: 0,
    tmuxName: `hydra-cpu-${id}`, listening: false, engine: 'claude', sessionType: 'thread_owner',
    adapter: fakeAdapter({ turn: () => ({ live, activityAt: null, confirmedComplete: false, answer: () => null }), recoveryPlan: () => ({ generic: true, resume: null, fork: null }) }),
  } as unknown as SessionInfo
}

function record(sessionId: string, pid: number, ppid: number, ts: number): void {
  const path = bridgeLifePath(STATE_DIR, sessionId, pid)
  mkdirSync(join(STATE_DIR, 'bridge-life'), { recursive: true })
  writeFileSync(path, JSON.stringify({ ev: 'start', ts, pid, ppid, sessionId }) + '\n' + JSON.stringify({ ev: 'wake', ts: ts + 1, gapMs: 1 }) + '\n')
  records.push(path)
}

const tick = () => new Promise(r => setTimeout(r, 1000))
// Real processes on a shared machine: a busy loop may get far less than a core, so these tests classify at a
// threshold any running loop clears (the 90% rule is pinned in cpu-spin.test.ts), and allow time for the ticks.
const LOW_THRESHOLD = 10
const LOOP_TIMEOUT_MS = 30_000

beforeAll(() => {
  _setSpinThresholdForTesting(LOW_THRESHOLD)
  busyStartedAt = Date.now()
  busy = spawn(process.execPath, ['-e', BUSY], { stdio: 'ignore' })
  origSendDM = gateway.sendDM
  ;(gateway as any).sendDM = async (_u: string, text: string) => { dms.push(text) }
  writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-op'] }))
})

afterAll(() => {
  _setSpinThresholdForTesting(undefined)
  busy.kill('SIGKILL')
  for (const pid of strays) try { process.kill(pid, 'SIGKILL') } catch {}
  ;(gateway as any).sendDM = origSendDM
  rmSync(ACCESS_FILE, { force: true })
})

afterEach(() => {
  for (const p of records.splice(0)) rmSync(p, { force: true })
  sampleCpu([], () => undefined, PRESSURE) // forget every session and orphan between cases
  dms = []
})

describe('sampleCpu', () => {
  test('an idle session whose bridge spins is classified from the third sample on and alerted once', async () => {
    const s = session('spin-1')
    record(s.sessionId, busy.pid!, process.pid, busyStartedAt)
    const states = []
    // Bounded: under a loaded test run a single busy loop can dip below the threshold for a tick.
    for (let i = 0; i < 10 && !states.at(-1)?.spinning; i++) {
      states.push(sampleCpu([s], () => PANE, PRESSURE).sessions.get(s.sessionId)!)
      await tick()
    }
    expect(states[0].bridgePid).toBe(busy.pid)
    expect(states[0].claudePid).toBeNumber()
    expect(states[0].claudePid).not.toBe(busy.pid)
    expect(states[0].bridgePct).toBeUndefined()   // first reading has no percentage
    expect(states[1].spinning).toBeNull()         // one hot sample is not enough
    expect(states.at(-1)!.spinning).toBe('bridge')
    sampleCpu([s], () => PANE, PRESSURE)
    expect(dms.length).toBe(1)
    expect(dms[0]).toContain('1 idle process is spinning')
    expect(dms[0]).toContain(`bridge pid ${busy.pid}`)
    expect(getCpuVitals(s.sessionId)?.spinning).toBe('bridge')
  }, LOOP_TIMEOUT_MS)

  test('main (byte) is sampled from its `main` records, though it has no registry record, and alerted by name', async () => {
    record('main', busy.pid!, process.pid, busyStartedAt)
    const main = { tmuxName: 'hydra-cpu-byte', pid: process.pid }
    let sample
    for (let i = 0; i < 10 && !sample?.main?.spinning; i++) { sample = sampleCpu([], () => undefined, PRESSURE, main); await tick() }
    expect(sample!.main).toMatchObject({ bridgePid: busy.pid, spinning: 'bridge' })
    expect(sample!.orphans).toEqual([])
    expect(dms.length).toBe(1)
    expect(dms[0]).toContain('`hydra-cpu-byte (main)`')
  }, LOOP_TIMEOUT_MS)

  describe('with HYDRA_SPIN_HEAL on', () => {
    let prev: string | undefined
    let healed: Array<{ thread: string; reason: HealReason }>
    const threads: string[] = []
    const healDeps = (): Partial<HealDeps> => ({
      send: async () => ({ id: 'notice' }), bridges: () => [], kill: () => {}, connected: () => false,
      sleep: async () => {}, occupancy: async () => 'orphaned', lock: (_t, fn) => fn(), backedOff: async () => undefined,
      stillNeeded: async (info, reason) => { healed.push({ thread: info.threadId, reason }); return 'needed' },
      revive: async () => ({ ok: true, method: 'resumed', result: { name: 'n', sessionId: 'n' }, lastTmuxName: 'x' }) as any,
    })
    function owned(id: string): SessionInfo {
      const s = session(id)
      registry.setThread(s.threadId, s.sessionId)
      threadRegistry.recordSpawn(s.threadId, { topic: 't', respawnCount: 0, sessionId: s.sessionId, tmuxName: s.tmuxName, originType: 'spawn', label: undefined })
      threads.push(s.threadId)
      return s
    }
    beforeEach(() => {
      prev = process.env.HYDRA_SPIN_HEAL
      process.env.HYDRA_SPIN_HEAL = '1'
      healed = []
      _setHealDepsForTesting(healDeps())
    })
    afterEach(() => {
      for (const t of threads.splice(0)) { registry.deleteThread(t); threadRegistry.delete(t) }
      _setHealDepsForTesting(undefined)
      if (prev === undefined) delete process.env.HYDRA_SPIN_HEAL
      else process.env.HYDRA_SPIN_HEAL = prev
    })

    test('a spinning bridge is healed, naming the hot pid, and not alerted', async () => {
      const s = owned('spin-heal')
      record(s.sessionId, busy.pid!, process.pid, busyStartedAt)
      for (let i = 0; i < 10 && healed.length === 0; i++) { sampleCpu([s], () => PANE, PRESSURE, undefined, healSession); await tick() }
      expect(healed).toEqual([{ thread: s.threadId, reason: expect.objectContaining({ kind: 'spinning', pid: busy.pid }) }])
      expect(dms.length).toBe(0) // healed: the thread notice replaces the operator alert
    }, LOOP_TIMEOUT_MS)

    test('a hot Claude is never healed (killing its bridge would not cool it), even with a live bridge: alerted as before', async () => {
      // A busy loop named `claude` (a copy of bun) with a cool child as its bridge: the bridge is found through its
      // record, its Claude by walking up to the nearest `claude`, and only the Claude is hot.
      const dir = mkdtempSync(join(tmpdir(), 'hydra-fake-claude-'))
      const fakeClaude = join(dir, 'claude')
      copyFileSync(process.execPath, fakeClaude)
      chmodSync(fakeClaude, 0o755)
      const startedAt = Date.now()
      const claude = spawn(fakeClaude, ['-e', `require('child_process').spawn('sleep', ['600'], { stdio: 'ignore' }); ${BUSY}`], { stdio: 'ignore' })
      strays.push(claude.pid!)
      try {
        let bridgePid: number | undefined
        for (let i = 0; i < 50 && !bridgePid; i++) {
          await new Promise(r => setTimeout(r, 100))
          bridgePid = Number(spawnSync('pgrep', ['-P', String(claude.pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || undefined
        }
        strays.push(bridgePid!)
        const s = owned('spin-claude')
        record(s.sessionId, bridgePid!, claude.pid!, startedAt)
        for (let i = 0; i < 10 && dms.length === 0; i++) { sampleCpu([s], () => PANE, PRESSURE, undefined, healSession); await tick() }
        const v = getCpuVitals(s.sessionId)
        expect(v?.bridgePid).toBe(bridgePid)
        expect(v?.claudePid).toBe(claude.pid)
        expect(v?.spinning).toBe('claude')
        expect(healed).toEqual([])
        expect(dms.length).toBe(1)
      } finally {
        claude.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    }, LOOP_TIMEOUT_MS)
  })

  describe('liveBridgePids (what a heal may kill)', () => {
    test('a record whose pid is running, started when it says, under the parent it names', () => {
      record('live-ok', busy.pid!, process.pid, busyStartedAt)
      expect(liveBridgePids('live-ok')).toEqual([busy.pid!])
    })
    test('a pid now under another parent (recycled, or the launcher died) is not killed', () => {
      record('live-ppid', busy.pid!, process.pid + 1, busyStartedAt)
      expect(liveBridgePids('live-ppid')).toEqual([])
    })
    test('a pid that started at another time than its record (recycled) is not killed', () => {
      record('live-ts', busy.pid!, process.pid, busyStartedAt - 86_400_000)
      expect(liveBridgePids('live-ts')).toEqual([])
    })
    test('another session\'s bridge is not this session\'s', () => {
      record('live-other', busy.pid!, process.pid, busyStartedAt)
      expect(liveBridgePids('live-mine')).toEqual([])
    })
  })

  test('a working session is not spinning, however hot its bridge', async () => {
    const s = session('spin-2', 'working')
    record(s.sessionId, busy.pid!, process.pid, busyStartedAt)
    let last
    for (let i = 0; i < 3; i++) { last = sampleCpu([s], () => PANE, PRESSURE).sessions.get(s.sessionId)!; await tick() }
    expect(last!.bridgePct!).toBeGreaterThanOrEqual(LOW_THRESHOLD)
    expect(last!.spinning).toBeNull()
    expect(dms.length).toBe(0)
  }, LOOP_TIMEOUT_MS)

  test('a record older than its pid (recycled pid) is neither the bridge nor an orphan', () => {
    const s = session('spin-3')
    record(s.sessionId, busy.pid!, process.pid, busyStartedAt - 86_400_000)
    const sample = sampleCpu([s], () => PANE, PRESSURE)
    expect(sample.sessions.get(s.sessionId)!.bridgePid).toBeUndefined()
    expect(sample.orphans).toEqual([])
  })

  test('a live bridge whose launcher still runs is not an orphan, even with no session (the main bridge)', () => {
    record('main-123', busy.pid!, process.pid, busyStartedAt)
    expect(sampleCpu([], () => undefined, PRESSURE).orphans).toEqual([])
  })

  test('a reparented bridge spinning with no launcher is alerted as an orphan', async () => {
    // sh starts the busy loop in the background and exits, so the loop is reparented away from sh.
    const out = execFileSync('sh', ['-c', `"${process.execPath}" -e '${BUSY}' >/dev/null 2>&1 & echo $! $$`], { encoding: 'utf8' })
    const [pid, shPid] = out.trim().split(' ').map(Number)
    strays.push(pid)
    record('gone-session', pid, shPid, Date.now())
    let sample
    for (let i = 0; i < 10 && !sample?.orphans[0]?.spinning; i++) { sample = sampleCpu([], () => undefined, PRESSURE); await tick() }
    expect(sample!.orphans).toEqual([expect.objectContaining({ pid, key: 'gone-session', spinning: true })])
    expect(dms.length).toBe(1)
    expect(dms[0]).toContain(`orphan bridge pid ${pid}`)
  }, LOOP_TIMEOUT_MS)

  test('with no bridge record the pane\'s first child is sampled as Claude', async () => {
    const s = session('spin-4')
    sampleCpu([s], () => PANE, PRESSURE)
    await tick()
    const v = sampleCpu([s], () => PANE, PRESSURE).sessions.get(s.sessionId)!
    expect(v.claudePid).toBe(process.pid)
    expect(v.claudePct).toBeGreaterThanOrEqual(0)
    expect(v.bridgePid).toBeUndefined()
  })

  test('a failed pane lookup keeps last tick\'s Claude', () => {
    const s = session('spin-5')
    sampleCpu([s], () => PANE, PRESSURE)
    expect(sampleCpu([s], () => undefined, PRESSURE).sessions.get(s.sessionId)!.claudePid).toBe(process.pid)
  })

  test('a half-written record is picked up once its start line lands', () => {
    const s = session('spin-6')
    const path = bridgeLifePath(STATE_DIR, s.sessionId, busy.pid!)
    mkdirSync(join(STATE_DIR, 'bridge-life'), { recursive: true })
    writeFileSync(path, '')
    records.push(path)
    expect(sampleCpu([s], () => PANE, PRESSURE).sessions.get(s.sessionId)!.bridgePid).toBeUndefined()
    writeFileSync(path, JSON.stringify({ ev: 'start', ts: busyStartedAt, pid: busy.pid, ppid: process.pid, sessionId: s.sessionId }) + '\n')
    expect(sampleCpu([s], () => PANE, PRESSURE).sessions.get(s.sessionId)!.bridgePid).toBe(busy.pid)
  })

  test('a session no longer live is dropped from the readings', () => {
    const s = session('spin-7')
    sampleCpu([s], () => PANE, PRESSURE)
    expect(getCpuVitals(s.sessionId)).toBeDefined()
    sampleCpu([], () => undefined, PRESSURE)
    expect(getCpuVitals(s.sessionId)).toBeUndefined()
  })
})
