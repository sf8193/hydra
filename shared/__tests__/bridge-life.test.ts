import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'net'

import {
  appendBridgeLife, bridgeLifeDir, bridgeLifePath, describeBridgeExit, pidAlive, pruneBridgeLife, readBridgeLife,
  type BridgeLifeEvent,
} from '../bridge-life.js'

const T0 = 1_760_000_000_000
const start: BridgeLifeEvent = { ev: 'start', ts: T0, pid: 42, ppid: 41, sessionId: 's1' }

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-bridge-life-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

describe('describeBridgeExit', () => {
  it('names a signal and the exit code, with uptime', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'signal', ts: T0 + 90_000, ppid: 41, detail: 'SIGHUP' }, { ev: 'exit', ts: T0 + 91_000, code: 0 }]
    expect(describeBridgeExit(events, false, T0 + 95_000)).toBe('SIGHUP → exit 0 (up 91s)')
  })

  it('names stdin close as the cause', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'stdin', ts: T0 + 1_000, ppid: 41, detail: 'close' }, { ev: 'exit', ts: T0 + 2_000, code: 0 }]
    expect(describeBridgeExit(events, false, T0 + 5_000)).toBe('stdin close → exit 0 (up 2s)')
  })

  it('says a bridge mid-shutdown has not exited yet', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'signal', ts: T0 + 1_000, ppid: 41, detail: 'SIGTERM' }]
    expect(describeBridgeExit(events, true, T0 + 3_000)).toBe('SIGTERM → no exit yet, pid still alive (up 1s)')
  })

  it('notes when the parent died before the bridge', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'stdin', ts: T0 + 5_000, ppid: 1, detail: 'end' }, { ev: 'exit', ts: T0 + 6_000, code: 0 }]
    expect(describeBridgeExit(events, false, T0 + 8_000)).toBe('stdin end → exit 0 (up 6s; parent gone (ppid 41 → 1))')
  })

  it('reports an exit with no recorded cause', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'exit', ts: T0 + 3_000, code: 7 }]
    expect(describeBridgeExit(events, false, T0 + 5_000)).toBe('no recorded cause → exit 7 (up 3s)')
  })

  it('blames SIGKILL or a native crash when a dead bridge left no exit record', () => {
    expect(describeBridgeExit([start], false, T0 + 60_000)).toBe('pid gone with no exit record — likely SIGKILL or a native crash (up 60s)')
  })

  it('does not guess a cause when there is no record at all', () => {
    expect(describeBridgeExit([], false, T0)).toBe('pid gone and no life record (file missing or unreadable)')
  })

  it('says the bridge is still alive when only the socket dropped', () => {
    expect(describeBridgeExit([start], true, T0 + 60_000)).toBe('no exit record, pid still alive (up 60s)')
  })

  it('notes the latest wake and how long before the end it came', () => {
    const events: BridgeLifeEvent[] = [
      start,
      { ev: 'wake', ts: T0 + 600_000, gapMs: 300_000 },
      { ev: 'wake', ts: T0 + 7_200_000, gapMs: 3_600_000 },
    ]
    expect(describeBridgeExit(events, false, T0 + 7_205_000))
      .toBe('pid gone with no exit record — likely SIGKILL or a native crash (up 2h; woke from a 60m gap 5s before)')
  })

  it('measures uptime and the wake to the cause, not to now', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'wake', ts: T0 + 50_000, gapMs: 600_000 }, { ev: 'stdin', ts: T0 + 60_000, ppid: 41, detail: 'close' }]
    expect(describeBridgeExit(events, false, T0 + 900_000)).toBe('stdin close → pid gone without an exit record (up 60s; woke from a 10m gap 10s before)')
  })

  it('counts uncaught errors and quotes the last one', () => {
    const events: BridgeLifeEvent[] = [
      start,
      { ev: 'error', ts: T0 + 1_000, detail: 'uncaughtException: first' },
      { ev: 'error', ts: T0 + 2_000, detail: 'unhandledRejection: Error: EPIPE\n    at write (bridge.ts:1:1)' },
    ]
    expect(describeBridgeExit(events, false, T0 + 3_000))
      .toBe('pid gone with no exit record — likely SIGKILL or a native crash (up 3s; 2 uncaught error(s) recorded, last: unhandledRejection: Error: EPIPE at write (bridge.ts:1:1))')
  })

  it('flags a missing start record', () => {
    expect(describeBridgeExit([{ ev: 'exit', ts: T0, code: 1 }], false, T0)).toBe('no recorded cause → exit 1 (no start record)')
  })

  it('never reports a negative interval when a wake lands after the exit', () => {
    const events: BridgeLifeEvent[] = [start, { ev: 'exit', ts: T0 + 10_000, code: 0 }, { ev: 'wake', ts: T0 + 12_000, gapMs: 120_000 }]
    expect(describeBridgeExit(events, false, T0 + 13_000)).toBe('no recorded cause → exit 0 (up 10s; woke from a 2m gap 0s before)')
  })
})

describe('bridge-life file', () => {
  it('round-trips appended events and skips a torn last line', () => {
    const dir = tempDir()
    const path = bridgeLifePath(dir, 's1', 42)
    appendBridgeLife(path, start)
    appendBridgeLife(path, { ev: 'exit', ts: T0 + 1, code: 0 })
    writeFileSync(path, readBridgeLife(path).map(e => JSON.stringify(e)).join('\n') + '\n{"ev":"wa', { flag: 'w' })
    expect(readBridgeLife(path)).toEqual([start, { ev: 'exit', ts: T0 + 1, code: 0 }])
  })

  it('keeps a hostile session id inside the record directory', () => {
    expect(bridgeLifePath('/state', '../../etc/x', 7)).toBe('/state/bridge-life/______etc_x-7.jsonl')
  })

  it('reads a missing file as no events', () => {
    expect(readBridgeLife(join(tmpdir(), 'hydra-no-such-dir', 'x.jsonl'))).toEqual([])
  })

  it('does nothing when the directory does not exist yet', () => {
    expect(() => pruneBridgeLife(tempDir(), 0, Date.now())).not.toThrow()
  })

  it('keeps an old file whose bridge is still running', () => {
    const dir = tempDir()
    mkdirSync(bridgeLifeDir(dir))
    const live = bridgeLifePath(dir, 'live', process.pid)
    writeFileSync(live, '')
    const now = Date.now()
    utimesSync(live, new Date(now - 10_000), new Date(now - 10_000))
    pruneBridgeLife(dir, 5_000, now)
    expect(existsSync(live)).toBe(true)
  })

  it('prunes only files older than the cutoff', () => {
    const dir = tempDir()
    mkdirSync(bridgeLifeDir(dir))
    const old = bridgeLifePath(dir, 'old', 999_999_999)
    const fresh = bridgeLifePath(dir, 'fresh', 999_999_998)
    writeFileSync(old, '')
    writeFileSync(fresh, '')
    const now = Date.now()
    utimesSync(old, new Date(now - 10_000), new Date(now - 10_000))
    pruneBridgeLife(dir, 5_000, now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('pidAlive', () => {
  it('is true for this process and false for a reaped child', async () => {
    expect(pidAlive(process.pid)).toBe(true)
    const child = Bun.spawn(['true'])
    await child.exited
    expect(pidAlive(child.pid)).toBe(false)
  })
})

describe('bridge.ts records its own exit', () => {
  const bridgePath = join(import.meta.dir, '..', '..', 'bridge.ts')

  async function runBridge(stop: (child: ReturnType<typeof Bun.spawn>) => void): Promise<BridgeLifeEvent[]> {
    const stateDir = tempDir()
    const child = Bun.spawn(['bun', bridgePath], {
      env: { ...process.env, DAEMON_SOCK: join(stateDir, 'daemon.sock'), HYDRA_SESSION_ID: 'life-test' },
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    })
    const path = bridgeLifePath(stateDir, 'life-test', child.pid)
    for (let i = 0; i < 5_000 && readBridgeLife(path).length === 0; i++) await Bun.sleep(1)
    try {
      stop(child)
      await child.exited
    } finally {
      child.kill('SIGKILL')
    }
    return readBridgeLife(path)
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    it(`records ${signal} and the exit code`, async () => {
      const events = await runBridge(child => child.kill(signal))
      expect(events.map(e => e.ev)).toEqual(['start', 'signal', 'exit'])
      expect(events[1]).toMatchObject({ ev: 'signal', detail: signal })
      expect(events[2]).toMatchObject({ ev: 'exit', code: 0 })
    }, 10_000)
  }

  it('records stdin closing', async () => {
    const events = await runBridge(child => { (child.stdin as import('bun').FileSink).end() })
    expect(events.map(e => e.ev)).toEqual(['start', 'stdin', 'exit'])
    expect(events[1]).toMatchObject({ ev: 'stdin', detail: 'end', ppid: (events[0] as { ppid: number }).ppid })
  }, 10_000)

  async function registerOf(env: Record<string, string | undefined>) {
    const stateDir = tempDir()
    const daemonSock = join(stateDir, 'daemon.sock')
    let resolveRegister: (msg: Record<string, unknown>) => void = () => {}
    const registered = new Promise<Record<string, unknown>>(r => { resolveRegister = r })
    const server = createServer(conn => conn.on('data', d => resolveRegister(JSON.parse(d.toString().split('\n')[0]))))
    await new Promise<void>(r => server.listen(daemonSock, r))
    const child = Bun.spawn(['bun', bridgePath], { env: { ...env, DAEMON_SOCK: daemonSock }, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
    try {
      return { msg: await registered, pid: child.pid, stateDir }
    } finally {
      child.kill('SIGKILL')
      server.close()
    }
  }

  it('sends its pid when it registers', async () => {
    const { msg, pid } = await registerOf({ ...process.env, HYDRA_SESSION_ID: 'life-test' })
    expect(msg).toMatchObject({ type: 'register', sessionId: 'life-test', pid })
  }, 10_000)

  it('a stray bridge records nothing and sends no pid, so the daemon never reports it', async () => {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.HYDRA_SESSION_ID
    delete env.HYDRA_ROLE
    const { msg, stateDir } = await registerOf(env)
    expect(String(msg.sessionId)).toStartWith('stray-')
    expect(msg.pid).toBeUndefined()
    expect(existsSync(bridgeLifeDir(stateDir))).toBe(false)
  }, 10_000)

  it('leaves only the start record on SIGKILL', async () => {
    const events = await runBridge(child => child.kill('SIGKILL'))
    expect(events.map(e => e.ev)).toEqual(['start'])
  }, 10_000)
})
