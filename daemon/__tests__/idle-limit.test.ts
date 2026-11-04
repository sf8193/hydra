import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { touchIdleLimit, resumeIdleLimit, clearIdleLimit, initIdleLimits, idleTtlMs, _idleTimersForTesting, _resetIdleLimitsForTesting } from '../idle-limit.js'
import { transport } from '../bridge-transport.js'
import { registry, type SessionInfo } from '../sessions.js'
import { DEFAULT_IDLE_TTL_MS } from '../../shared/constants.js'

const sent: Array<{ sessionId: string; content: string }> = []
let origSendOrQueue: typeof transport.sendOrQueue
let origPersist: typeof registry.persist
let origStderr: typeof process.stderr.write
const reaped: string[] = []

function add(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: id, listening: false, sessionType: 'thread_owner', ephemeral: true, ...over,
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
  _resetIdleLimitsForTesting(async info => { reaped.push(info.sessionId) })
})

afterEach(() => {
  _resetIdleLimitsForTesting()
  for (const id of ['a', 'b', 'c', 'd']) registry.delete(id)
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
