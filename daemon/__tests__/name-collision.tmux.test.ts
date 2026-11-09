// One name runs one session. When a successor takes a name (a specialist moved threads, a
// respawn that kept its name), the record it replaced is dead even though tmux answers to the
// name: the execution is the successor's. A real tmux server, not stand-in adapters: a stand-in
// answers per record, which hides the collision.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { occupancy, _setDaemonStartedAtForTesting } from '../session-reachability.js'
import { registry, resolveSendTarget, type SessionInfo } from '../sessions.js'
import { resumeIdleLimit, _resetIdleLimitsForTesting, _idleTimersForTesting } from '../idle-limit.js'
import { initPhaseBudgets, _resetPhaseBudgetsForTesting } from '../phase-budget.js'
import { transport } from '../bridge-transport.js'
import { tmuxNewSession } from '../../shared/spawn-env.js'
import { killSession } from '../session-lifecycle.js'
import { engines } from '../engines/instances.js'
import { gateway } from '../config.js'
import { tmuxHasSession } from '../util.js'

const available = Bun.spawnSync(['tmux', '-V']).exitCode === 0
const NAME = 'collide'
let dir = ''
let socket = ''
const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }

function record(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: NAME, listening: false, sessionType: 'thread_owner', ...over,
  } as SessionInfo
  registry.set(id, info)
  return info
}

// The predecessor ran under the name; then it was given up on and a successor took the name.
function succeed(old: SessionInfo): SessionInfo {
  old.deadAt = Date.now()
  return record('new')
}

const sent: string[] = []
const reaped: string[] = []
let origPersist: typeof registry.persist
let origSendOrQueue: typeof transport.sendOrQueue

beforeAll(() => {
  if (!available) return
  dir = mkdtempSync('/tmp/hnc-')
  process.env.TMUX_TMPDIR = dir
  delete process.env.TMUX
  socket = join(dir, `tmux-${process.getuid!()}`, 'default')
  tmuxNewSession(['-d', '-s', NAME, 'sleep 60'])
  _setDaemonStartedAtForTesting(Date.now() - 3_600_000)
})

afterAll(() => {
  if (!available) return
  _setDaemonStartedAtForTesting(undefined)
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'pipe' }) } catch {}
  rmSync(dir, { recursive: true, force: true })
  process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR
  if (saved.TMUX) process.env.TMUX = saved.TMUX
})

beforeEach(() => {
  origPersist = registry.persist.bind(registry)
  registry.persist = () => {}
  origSendOrQueue = transport.sendOrQueue.bind(transport)
  transport.sendOrQueue = ((sessionId: string) => { sent.push(sessionId) }) as any
  sent.length = 0
  reaped.length = 0
})

afterEach(() => {
  _resetIdleLimitsForTesting()
  _resetPhaseBudgetsForTesting()
  for (const id of ['old', 'new']) registry.delete(id)
  registry.persist = origPersist
  transport.sendOrQueue = origSendOrQueue
})

describe.skipIf(!available)('a name taken by a successor', () => {
  test('the predecessor reads dead, the successor holds the name', () => {
    const old = record('old', { createdAt: Date.now() - 3_600_000 })
    expect(occupancy(old)).toBe('orphaned')
    const next = succeed(old)
    expect(occupancy(old)).toBe('dead')
    expect(occupancy(next)).toBe('starting')
  })

  test('a send by name reaches the successor, not the predecessor\'s queue', () => {
    const old = record('old', { createdAt: Date.now() - 3_600_000, threadId: 'thread-left' })
    const next = succeed(old)
    expect(resolveSendTarget(NAME)?.session.sessionId).toBe(next.sessionId)
  })

  test('the predecessor\'s idle clock does not fire on the successor', async () => {
    _resetIdleLimitsForTesting(async info => { reaped.push(info.sessionId) }, async () => false)
    const old = record('old', { ephemeral: true, idleDeadline: Date.now() + 10 })
    resumeIdleLimit('old')
    expect(_idleTimersForTesting().has('old')).toBe(true)
    succeed(old)
    await Bun.sleep(40)
    expect(sent).toEqual([])
    expect(reaped).toEqual([])
  })

  test('the predecessor\'s phase budget does not fire on the successor', async () => {
    const old = record('old', { budgetDeadline: Date.now() + 10 })
    initPhaseBudgets(async info => { reaped.push(info.sessionId) })
    succeed(old)
    await Bun.sleep(40)
    expect(sent).toEqual([])
    expect(reaped).toEqual([])
  })

  // Last: without the guard it kills the shared tmux session the tests above need.
  test('ending the predecessor\'s record stops nothing under the successor\'s name', async () => {
    const send = gateway.send
    ;(gateway as any).send = async () => ({ id: 'm' })
    try {
      const old = record('old', { adapter: engines.claude, engine: 'claude' } as Partial<SessionInfo>)
      succeed(old)
      await killSession(old, 'test', { keepRecord: true })
      expect(tmuxHasSession(NAME)).toBe(true)
    } finally { (gateway as any).send = send }
  })
})
