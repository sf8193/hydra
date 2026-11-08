// sampleCpu against real processes: a busy child of this test stands in for a spinning bridge,
// found the way the daemon finds one, through its bridge-life record.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { sampleCpu, getCpuVitals, _setSpinThresholdForTesting } from '../cpu-watch.js'
import { STATE_DIR, ACCESS_FILE, gateway } from '../config.js'
import { bridgeLifePath } from '../../shared/bridge-life.js'
import type { SessionInfo } from '../sessions.js'
import { fakeAdapter } from './test-harness.js'

const PRESSURE = { load1: 1, cores: 10 }
// This test process plays Claude: its parent is the "pane", and the busy child is its bridge.
const PANE = { panePid: process.ppid, pid: process.pid }
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
    adapter: fakeAdapter({ turn: () => ({ live, activityAt: null, confirmedComplete: false, answer: () => null }) }),
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
    expect(states[0].claudePid).toBe(process.pid) // walked up from the bridge to the pane's child
    expect(states[0].bridgePct).toBeUndefined()   // first reading has no percentage
    expect(states[1].spinning).toBeNull()         // one hot sample is not enough
    expect(states.at(-1)!.spinning).toBe('bridge')
    sampleCpu([s], () => PANE, PRESSURE)
    expect(dms.length).toBe(1)
    expect(dms[0]).toContain('1 idle process is spinning')
    expect(dms[0]).toContain(`bridge pid ${busy.pid}`)
    expect(getCpuVitals(s.sessionId)?.spinning).toBe('bridge')
  }, LOOP_TIMEOUT_MS)

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
