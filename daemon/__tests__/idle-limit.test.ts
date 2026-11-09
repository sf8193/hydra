import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import { touchIdleLimit, resumeIdleLimit, clearIdleLimit, initIdleLimits, idleTtlMs, awaitingReply, busyFrom, IDLE_GRACE_MS, _idleTimersForTesting, _resetIdleLimitsForTesting } from '../idle-limit.js'
import { idleReapMs } from '../config.js'
import { setSpecialist, removeSpecialist } from '../specialists.js'
import { registerProtocol, _resetForTesting as resetProtocols } from '../protocol-registry.js'
import { transport } from '../bridge-transport.js'
import { registry, type SessionInfo } from '../sessions.js'
import { DEFAULT_IDLE_TTL_MS } from '../../shared/constants.js'

const sent: Array<{ sessionId: string; content: string }> = []
let origSendOrQueue: typeof transport.sendOrQueue
let origPersist: typeof registry.persist
let origStderr: typeof process.stderr.write
const reaped: string[] = []
const reapCalls: Array<{ id: string; reason: string; opts?: { keepRecord?: boolean } }> = []
let working = false
// Fake timers fire the callbacks; their awaits still need the microtask queue to drain.
const settle = () => new Promise<void>(r => queueMicrotask(() => queueMicrotask(() => queueMicrotask(r))))

function add(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: id, listening: false, sessionType: 'thread_owner', ephemeral: true,
    adapter: { isAlive: (i: any) => !i.deadAt, isConnected: () => false } as any, ...over,  // running unless stamped dead
  } as SessionInfo
  registry.set(id, info)
  return info
}

beforeEach(() => {
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  origSendOrQueue = transport.sendOrQueue.bind(transport)
  transport.sendOrQueue = ((sessionId: string, msg: { content: string }) => { sent.push({ sessionId, content: msg.content }) }) as any
  origPersist = registry.persist.bind(registry)
  registry.persist = () => {}
  sent.length = 0
  reaped.length = 0
  reapCalls.length = 0
  working = false
  _resetIdleLimitsForTesting(async (info, reason, opts) => { reaped.push(info.sessionId); reapCalls.push({ id: info.sessionId, reason, opts }) }, async () => working)
})

afterEach(() => {
  jest.useRealTimers()
  delete process.env.HYDRA_IDLE_REAP_DAYS
  _resetIdleLimitsForTesting()
  for (const id of ['a', 'b', 'c', 'd', 'kid']) registry.delete(id)
  transport.sendOrQueue = origSendOrQueue
  registry.persist = origPersist
  process.stderr.write = origStderr
})

describe('idle limit', () => {
  test('a first arm persists a deadline at now + the session\'s TTL (default 30m)', () => {
    const a = add('a')
    const b = add('b', { idleTtlMs: 4 * 86_400_000 })
    const before = Date.now()
    resumeIdleLimit('a')
    resumeIdleLimit('b')
    expect(a.idleDeadline! - before).toBeGreaterThanOrEqual(DEFAULT_IDLE_TTL_MS)
    expect(a.idleDeadline! - before).toBeLessThan(DEFAULT_IDLE_TTL_MS + 1000)
    expect(b.idleDeadline! - before).toBeGreaterThanOrEqual(4 * 86_400_000)
    expect(idleTtlMs(b)).toBe(4 * 86_400_000)
  })

  test('resume keeps a persisted deadline (restart re-arms with what was left); touch restarts it', () => {
    const left = Date.now() + 60_000
    const a = add('a', { idleTtlMs: 3_600_000, idleDeadline: left })
    resumeIdleLimit('a')
    expect(a.idleDeadline).toBe(left)
    touchIdleLimit('a')
    expect(a.idleDeadline!).toBeGreaterThanOrEqual(left - 60_000 + 3_600_000)
  })

  test('non-ephemeral and dead sessions are never armed, including at boot', () => {
    add('a', { ephemeral: false })
    add('b', { deadAt: Date.now(), idleDeadline: Date.now() - 1 })
    add('c', { idleDeadline: Date.now() + 60_000 })
    initIdleLimits(async info => { reaped.push(info.sessionId) })
    const armed = [..._idleTimersForTesting().keys()]
    expect(armed).toContain('c')
    expect(armed).not.toContain('a')
    expect(armed).not.toContain('b')
    expect(registry.get('a')!.idleDeadline).toBeUndefined()
  })

  test('an expired deadline nudges the session first and does not reap yet', async () => {
    add('a', { idleDeadline: Date.now() - 1 })
    resumeIdleLimit('a')
    await Bun.sleep(20)
    expect(sent.some(m => m.sessionId === 'a' && m.content.includes('No one has posted in your thread'))).toBe(true)
    expect(reaped).toEqual([])
    expect(_idleTimersForTesting().get('a')?.reap).toBeDefined()
  })

  test('a bridge reconnect during the grace period neither re-nudges nor restarts the reap', async () => {
    add('a', { idleDeadline: Date.now() - 1 })
    resumeIdleLimit('a')
    await Bun.sleep(20)
    const reap = _idleTimersForTesting().get('a')!.reap
    expect(sent.length).toBe(1)
    resumeIdleLimit('a')
    await Bun.sleep(20)
    expect(sent.length).toBe(1)
    expect(_idleTimersForTesting().get('a')!.reap).toBe(reap)
  })

  test('a person posting during the grace period cancels the reap', async () => {
    const a = add('a', { idleDeadline: Date.now() - 1 })
    resumeIdleLimit('a')
    await Bun.sleep(20)
    touchIdleLimit('a')
    const t = _idleTimersForTesting().get('a')!
    expect(t.reap).toBeUndefined()
    expect(a.idleDeadline!).toBeGreaterThan(Date.now())
  })

  test('clear stops the clock; a session that died before the nudge is left alone', async () => {
    add('a', { idleDeadline: Date.now() + 10 })
    resumeIdleLimit('a')
    clearIdleLimit('a')
    expect(_idleTimersForTesting().has('a')).toBe(false)
    const d = add('d', { idleDeadline: Date.now() + 10 })
    resumeIdleLimit('d')
    d.deadAt = Date.now()
    await Bun.sleep(40)
    expect(sent).toEqual([])
    expect(reaped).toEqual([])
  })
})

const DAY = 86_400_000

describe('idle reap (HYDRA_IDLE_REAP_DAYS)', () => {
  const owner = (id: string, over: Partial<SessionInfo> = {}) => add(id, { ephemeral: false, ...over })

  test('the knob is a positive number of days; anything else is off', () => {
    for (const [raw, ms] of [['7', 7 * DAY], [' 1.5 ', 1.5 * DAY], ['', undefined], ['0', undefined], ['-2', undefined], ['7d', undefined], ['abc', undefined]] as const) {
      process.env.HYDRA_IDLE_REAP_DAYS = raw
      expect(idleReapMs()).toBe(ms)
    }
  })

  test('with it set, a plain thread owner gets a fresh window of that many days, however long it has been idle', () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '3'
    const a = owner('a', { lastActive: Date.now() - 6 * DAY })
    const before = Date.now()
    initIdleLimits(async () => {})
    expect(a.idleDeadline! - before).toBeGreaterThanOrEqual(3 * DAY)
    expect(idleTtlMs(a)).toBe(3 * DAY)
    expect(_idleTimersForTesting().has('a')).toBe(true)
  })

  test('the orchestrator, thread guests, specialist occupants and protocol participants are exempt; an ephemeral session keeps its own TTL', () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '3'
    owner('a', { sessionType: 'master_orchestrator' })
    owner('b', { sessionType: 'thread_guest' })
    owner('c', { threadId: 'spec-thread' })
    owner('d')
    const e = add('e', { idleTtlMs: 3_600_000 })
    setSpecialist('idle-test-spec', { threadId: 'spec-thread', kickoff: 'k' })
    registerProtocol('idle-test', { isParticipant: (id: string) => id === 'd' } as any)
    try {
      initIdleLimits(async () => {})
      expect([..._idleTimersForTesting().keys()].sort()).toEqual(['e'])
      expect(idleTtlMs(e)).toBe(3_600_000)
    } finally {
      removeSpecialist('idle-test-spec')
      resetProtocols()
      registry.delete('e')
    }
  })

  test('a deadline left from a run with the knob on is dropped while it is off, so turning it back on starts fresh', () => {
    const a = owner('a', { idleDeadline: Date.now() - DAY })
    initIdleLimits(async () => {})
    expect(a.idleDeadline).toBeUndefined()
    expect(_idleTimersForTesting().has('a')).toBe(false)
  })

  test('at the deadline, a session with an unanswered message gets a fresh window instead of a nudge', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    const now = Date.now()
    const a = owner('a', { idleDeadline: now - 1, lastActive: now - 3 * DAY, lastReplyAt: now - 3 * DAY, lastUserMessageAt: now - 3 * DAY + 1 })
    expect(awaitingReply(a)).toBe(true)
    resumeIdleLimit('a')
    await Bun.sleep(20)
    expect(sent).toEqual([])
    expect(a.idleDeadline!).toBeGreaterThanOrEqual(now + 2 * DAY)
  })

  test('at the deadline, a session active since the window opened is re-armed from its last activity', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    const now = Date.now()
    const a = owner('a', { idleDeadline: now - 1, lastActive: now - DAY })
    resumeIdleLimit('a')
    await Bun.sleep(20)
    expect(sent).toEqual([])
    expect(a.idleDeadline).toBe(now - DAY + 2 * DAY)
  })

  test('an idle session is nudged with how to resume, then reaped keeping its record, with a resume notice', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent.length).toBe(1)
    expect(sent[0].content).toContain('typing resume in the thread continues it')
    a.lastActive = Date.now()  // its answer to the nudge is a tool call; that must not save it
    jest.advanceTimersByTime(IDLE_GRACE_MS)
    await settle()
    expect(reapCalls).toEqual([{ id: 'a', reason: 'idle 2d, ended — type `resume` here to continue this conversation', opts: { keepRecord: true } }])
  })

  test('a session working at its deadline is not nudged; one working when the grace runs out is not reaped', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    working = true
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent).toEqual([])
    expect(a.idleDeadline!).toBeGreaterThan(Date.now() + DAY)

    a.idleDeadline = Date.now() - 1
    working = false
    clearIdleLimit('a')
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent.length).toBe(1)
    working = true
    jest.advanceTimersByTime(IDLE_GRACE_MS)
    await settle()
    expect(reapCalls).toEqual([])
    expect(a.idleDeadline!).toBeGreaterThan(Date.now() + DAY)
  })

  test('an ephemeral reap is unchanged by the knob, working or not', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    working = true
    add('a', { idleDeadline: Date.now() - 1, lastUserMessageAt: Date.now() })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    jest.advanceTimersByTime(IDLE_GRACE_MS)
    await settle()
    expect(sent[0].content).not.toContain('resume')
    expect(reapCalls).toEqual([{ id: 'a', reason: 'idle limit expired', opts: undefined }])
  })

  test('busy is working, blocked at a prompt only a person can answer, or running a background shell', () => {
    expect(busyFrom({ live: 'working', working: true })).toBe(true)
    expect(busyFrom({ live: 'blocked', working: false })).toBe(true)
    expect(busyFrom({ live: 'idle', working: false })).toBe(false)
    expect(busyFrom({ live: null, working: false })).toBe(false)
    expect(busyFrom({ live: null, working: false, background: true })).toBe(true)
  })

  test('a session with a live child is not nudged; once the child is gone it is', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    const kid = owner('kid', { parentId: 'a', idleDeadline: Date.now() + 10 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent).toEqual([])
    expect(a.idleDeadline!).toBeGreaterThan(Date.now() + DAY)
    kid.deadAt = Date.now()
    a.idleDeadline = Date.now() - 1
    clearIdleLimit('a')
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent.map(m => m.sessionId)).toEqual(['a'])
  })

  test('an unanswered message that arrives during the grace saves the session at the reap', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    expect(sent.length).toBe(1)
    a.lastUserMessageAt = Date.now()  // delivered without restarting the clock (e.g. a typed delivery)
    jest.advanceTimersByTime(IDLE_GRACE_MS)
    await settle()
    expect(reapCalls).toEqual([])
    expect(a.idleDeadline!).toBeGreaterThan(Date.now() + DAY)
  })

  test('a person posting while the busy check runs wins: no nudge, and their new window stands', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    let release!: (busy: boolean) => void
    _resetIdleLimitsForTesting(async (info, reason, opts) => { reapCalls.push({ id: info.sessionId, reason, opts }) }, () => new Promise(r => { release = r }))
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    touchIdleLimit('a')
    const window = a.idleDeadline
    release(false)
    await settle()
    expect(sent).toEqual([])
    expect(a.idleDeadline).toBe(window)
  })

  test('a person posting while the reap\'s busy check runs wins: no reap', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    const releases: Array<(busy: boolean) => void> = []
    _resetIdleLimitsForTesting(async (info, reason, opts) => { reapCalls.push({ id: info.sessionId, reason, opts }) }, () => new Promise(r => { releases.push(r) }))
    owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    releases.shift()!(false)  // the deadline's check: not busy, so it nudges
    await settle()
    expect(sent.length).toBe(1)
    jest.advanceTimersByTime(IDLE_GRACE_MS)
    await settle()
    touchIdleLimit('a')
    releases.shift()!(false)  // the reap's check returns after the person posted
    await settle()
    expect(reapCalls).toEqual([])
  })

  test('a session that dies while the busy check runs is not re-armed', async () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '2'
    jest.useFakeTimers()
    let release!: (busy: boolean) => void
    _resetIdleLimitsForTesting(async () => {}, () => new Promise(r => { release = r }))
    const a = owner('a', { idleDeadline: Date.now() - 1, lastActive: Date.now() - 3 * DAY })
    resumeIdleLimit('a')
    jest.advanceTimersByTime(1)
    await settle()
    a.deadAt = Date.now()
    release(true)
    await settle()
    expect(_idleTimersForTesting().has('a')).toBe(false)
    expect(a.idleDeadline!).toBeLessThan(Date.now())
  })

  test('no timer is ever set past setTimeout\'s ceiling: a 40-day wait is taken in steps', () => {
    process.env.HYDRA_IDLE_REAP_DAYS = '40'
    const delays: number[] = []
    const orig = globalThis.setTimeout
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => { delays.push(ms ?? 0); return orig(fn, 2 ** 31 - 1, ...rest) }) as any
    try {
      owner('a', { lastActive: Date.now() })
      resumeIdleLimit('a')
    } finally {
      globalThis.setTimeout = orig
    }
    expect(delays.length).toBe(1)
    expect(delays[0]).toBeLessThanOrEqual(2 ** 31 - 1)
    clearIdleLimit('a')
  })
})
