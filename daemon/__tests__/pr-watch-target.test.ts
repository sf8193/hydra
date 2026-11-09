// A PR watch delivers to a target (a thread, a specialist, main), resolved at each delivery, so a dead owner heals
// instead of stranding the watch. Nothing counts as seen until the update lands: an update that does not land is
// owed, and the next poll sends it again from the same read position.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  prWatchDeps, listWatches, unwatchPr, unwatchBySession, retargetWatches, getWatchesBySession, parsePersistedWatches,
  _pollForTesting, _pollAllForTesting, _setWatchForTesting, type WatchEntry,
} from '../pr-watch.js'
import { deliverToSession, targetDeps, type DeliverOutcome } from '../targets.js'
import { registry, type SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { setSpecialist, removeSpecialist } from '../specialists.js'
import { killSession } from '../session-lifecycle.js'
import { gateway } from '../config.js'
import { reviveThreadForDelivery, reviveDeps } from '../recovery.js'
import { deliveryOutcome } from '../delivery-outcome.js'

process.stderr.write = (() => true) as any

const URL = 'https://github.com/o/r/pull/11'
const real = { api: prWatchDeps.api, deliver: prWatchDeps.deliver, send: gateway.send, persist: registry.persist }
let calls: Array<{ t: { to: string; revive?: true }; text: string; opts: any }> = []
let answer: DeliverOutcome
let comments: any[] = []
let posted: string[] = []

const landed = (): DeliverOutcome => ({ ok: true, status: 'queued', sessionId: 's-new', sessionName: 'new', threadId: 'thread-w', revived: true })
const entry = () => listWatches().find(w => w.prUrl === URL)

function seed(extra: Partial<WatchEntry> = {}): void {
  _setWatchForTesting({
    prUrl: URL, owner: 'o', repo: 'r', prNumber: 11, to: 'thread-w', revive: true, threadId: 'thread-w',
    lastCheckedAt: '2026-11-08T00:00:00Z', lastReviewCommentId: 10, lastIssueCommentId: 0, lastReviewId: 0,
    lastHeadSha: 'h1', lastCheckStatus: 'success', createdAt: 1, ...extra,
  })
}

function record(id: string, threadId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info = {
    sessionId: id, threadId, tmuxName: id, topic: 't', createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner',
    adapter: { stop: async () => ({ status: 'stopped' }), isAlive: () => false, isConnected: () => false }, ...over,
  } as unknown as SessionInfo
  registry.set(id, info)
  return info
}

beforeEach(() => {
  calls = []; posted = []
  comments = [{ id: 11, user: { login: 'rev' }, body: 'fix this', path: 'a.ts', line: 3, html_url: 'u', created_at: '2026-11-08T01:00:00Z' }]
  answer = landed()
  prWatchDeps.api = async (endpoint: string) => {
    if (endpoint.endsWith('pulls/11')) return { state: 'open', head: { sha: 'h1' }, mergeable: true }
    if (endpoint.includes('pulls/11/comments')) return comments
    if (endpoint.includes('/reviews')) return []
    if (endpoint.includes('issues/11/comments')) return []
    if (endpoint.includes('check-runs')) return { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: '' }] }
    if (endpoint.endsWith('/status')) return { statuses: [] }
    return null
  }
  prWatchDeps.deliver = async (t, text, opts) => { calls.push({ t, text, opts }); return answer }
  ;(gateway as any).send = async (_c: string, text: string) => { posted.push(text); return { id: 'm' } }
  ;(registry as any).persist = () => {}
})

afterEach(() => {
  unwatchPr(URL)
  Object.assign(prWatchDeps, { api: real.api, deliver: real.deliver })
  ;(gateway as any).send = real.send
  ;(registry as any).persist = real.persist
  for (const id of ['w-old', 'w-kept', 'w-sync', 'w-guest', 'w-live', 'w-sib']) registry.delete(id)
  removeSpecialist('reviewer')
})

describe('poll → target', () => {
  test('a new comment goes to the watch\'s target, as a low-priority, keyed, queued delivery; then it is seen', async () => {
    seed()
    await _pollForTesting(entry()!)
    expect(calls).toHaveLength(1)
    expect(calls[0].t).toEqual({ to: 'thread-w', revive: true })
    expect(calls[0].text).toContain('fix this')
    expect(calls[0].opts).toMatchObject({ initiator: 'pr-watch', source: 'pr-watch', queue: true, lowPriority: true })
    expect(calls[0].opts.idempotencyKey).toStartWith(`prwatch:${URL}:`)
    expect(entry()!.lastReviewCommentId).toBe(11)
  })

  test('a dead owner is no longer skipped: the update goes to its thread, which revives', async () => {
    record('w-old', 'thread-w', { deadAt: Date.now() })
    seed()
    await _pollForTesting(entry()!)
    expect(calls.map(c => c.t)).toEqual([{ to: 'thread-w', revive: true }])
  })

  test('an update that does not land is owed: the read position stays, and the next poll sends it again under the same key', async () => {
    seed()
    const before = { ...entry()! }
    answer = { ok: false, exit: 6, reason: 'backing off' }
    await _pollForTesting(entry()!)
    expect(entry()!.lastReviewCommentId).toBe(before.lastReviewCommentId)
    expect(entry()!.lastCheckedAt).toBe(before.lastCheckedAt)
    answer = landed()
    setSystemTime(new Date(Date.now() + 180_000))  // the next poll, minutes later: the key is what it carries, not when
    try { await _pollForTesting(entry()!) } finally { setSystemTime() }
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toContain('fix this')
    expect(calls[1].opts.idempotencyKey).toBe(calls[0].opts.idempotencyKey)
    expect(entry()!.lastReviewCommentId).toBe(11)
  })

  test('a CI change that does not land is reported again on the next poll', async () => {
    seed({ lastCheckStatus: 'pending' })
    comments = []
    prWatchDeps.api = (orig => async (e: string) => e.includes('check-runs')
      ? { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure', html_url: '' }] }
      : orig(e))(prWatchDeps.api)
    answer = { ok: false, exit: 5, reason: 'not now' }
    await _pollForTesting(entry()!)
    expect(entry()!.lastCheckStatus).toBe('pending')
    answer = landed()
    await _pollForTesting(entry()!)
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toContain('CI Failed')
    expect(entry()!.lastCheckStatus).toBe('failure')
  })

  test('CI failing again at the same head after a re-run is a new update, not a duplicate of the first', async () => {
    seed({ lastCheckStatus: 'pending' })
    comments = []
    let run = 1
    const api = prWatchDeps.api
    let status = 'failure'
    prWatchDeps.api = async (e: string) => e.includes('check-runs')
      ? { check_runs: [{ name: 'ci', status: 'completed', conclusion: status, html_url: `https://ci/run/${run}` }] }
      : api(e)
    await _pollForTesting(entry()!)              // fails at h1: delivered
    status = 'in_progress'; run = 2
    prWatchDeps.api = (orig => async (e: string) => e.includes('check-runs')
      ? { check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null, html_url: 'https://ci/run/2' }] }
      : orig(e))(api)
    await _pollForTesting(entry()!)              // re-run pending: nothing to say
    prWatchDeps.api = async (e: string) => e.includes('check-runs')
      ? { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure', html_url: 'https://ci/run/2' }] }
      : api(e)
    await _pollForTesting(entry()!)              // fails again at h1
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.idempotencyKey).not.toBe(calls[0].opts.idempotencyKey)
  })

  test('a burst of feedback past the delivery cap is cut to fit, not dropped, and the watch goes on', async () => {
    seed()
    comments = Array.from({ length: 30 }, (_, i) => ({ id: 11 + i, user: { login: 'bot' }, body: 'x'.repeat(500), path: 'a.ts', line: i, html_url: `u${i}`, created_at: '2026-11-08T01:00:00Z' }))
    await _pollForTesting(entry()!)
    expect(calls).toHaveLength(1)
    expect(Buffer.byteLength(calls[0].text)).toBeLessThanOrEqual(10_000)
    expect(calls[0].text).toContain(`more on the PR: ${URL}`)
    expect(calls[0].text).toContain('Categorize the above')
    expect(entry()!.lastReviewCommentId).toBe(40)
  })

  test('a watch ended while its poll fetched delivers nothing: a killed thread is not revived', async () => {
    seed()
    const api = prWatchDeps.api
    prWatchDeps.api = async (e: string) => { if (e.includes('/reviews')) unwatchPr(URL); return api(e) }
    await _pollForTesting(listWatches().find(w => w.prUrl === URL)!)
    expect(calls).toEqual([])
  })

  test('no such specialist ends the watch and says why in its thread', async () => {
    seed({ to: 'reviewer', revive: undefined })
    answer = { ok: false, exit: 8, reason: 'no such specialist: reviewer' }
    await _pollForTesting(entry()!)
    expect(entry()).toBeUndefined()
    expect(posted.some(t => t.includes('Stopped watching') && t.includes('no such specialist'))).toBe(true)
  })
})

describe('the target outlives its sessions', () => {
  test('a deliberate kill ends the thread\'s watches: a later review revives nothing', async () => {
    const info = record('w-old', 'thread-w')
    seed()
    await killSession(info, 'session ended')
    expect(entry()).toBeUndefined()
    // The review that arrives after the kill finds no watch to deliver it, so nothing revives the thread.
    await _pollAllForTesting()
    expect(calls).toEqual([])
  })

  test('a teardown that keeps the thread going (handoff, replacement, revive) keeps its watches', async () => {
    const info = record('w-kept', 'thread-w')  // its own id: killSession ignores a second kill of an id for 3s
    seed()
    await killSession(info, 'handed off', { skipWorktreeDestroy: true, keepWatches: true })
    expect(entry()?.to).toBe('thread-w')
  })

  test('a guest\'s kill does not end the thread owner\'s watches', async () => {
    const guest = record('w-guest', 'thread-w', { sessionType: 'thread_guest' } as Partial<SessionInfo>)
    seed()
    await killSession(guest, 'session ended')
    expect(entry()?.to).toBe('thread-w')
  })

  test('recovery dedup retargets a skipped session\'s watches to the session doing the same work', () => {
    const sib = record('w-sib', 'thread-w')
    const live = record('w-live', 'thread-live')
    seed({ lastReviewCommentId: 42 })
    const polled = entry()!  // a poll in flight holds this object; its restore must reach the watch
    expect(retargetWatches(sib, live)).toBe(1)
    expect(entry()).toBe(polled)
    expect(entry()).toMatchObject({ to: 'thread-live', revive: true, threadId: 'thread-live', lastReviewCommentId: 42 })
  })

  test('a specialist\'s watch is its session\'s too, but outlives a kill of it: the specialist refills (`specialist rm` ends it)', () => {
    setSpecialist('reviewer', { channel: 'c', threadId: 'thread-w', kickoff: 'k', updatedAt: 1 } as any)
    const info = record('w-old', 'thread-w')
    seed({ to: 'reviewer', revive: undefined })
    expect(getWatchesBySession('w-old').map(w => w.to)).toEqual(['reviewer'])
    expect(unwatchBySession(info)).toBe(0)
    expect(entry()?.to).toBe('reviewer')
  })
})

describe('a kill and a poll in flight', () => {
  test('a deliberate kill ends the watches before its first await', () => {
    const info = record('w-sync', 'thread-w')
    seed()
    const kill = killSession(info, 'session ended')
    expect(entry()).toBeUndefined()
    return kill
  })

  test('a revive asks its sender under the thread\'s lock, after its last await: a withdrawn sender revives nothing', async () => {
    const exists = reviveDeps.threadExists
    reviveDeps.threadExists = async () => true
    try {
      expect(await reviveThreadForDelivery('thread-withdrawn', 'pr-watch', () => false)).toEqual({ ok: false, exitCode: 3, reason: 'withdrawn by its sender' })
    } finally { reviveDeps.threadExists = exists }
  })

  test('a write requeued on a dying socket is queued when the sender asked to queue (not exit 6, which would resend it)', () => {
    expect(deliveryOutcome({ status: 'accepted', via: 'requeued' } as any, true)).toEqual({ ok: true, status: 'queued', proof: 'persisted' })
    expect(deliveryOutcome({ status: 'accepted', via: 'requeued' } as any, false)).toMatchObject({ ok: false, exitCode: 6 })
  })
})

describe('watches persisted before targets', () => {
  const old = (extra: Record<string, unknown>) => JSON.stringify([{ prUrl: URL, owner: 'o', repo: 'r', prNumber: 11, threadId: 'thread-w', lastCheckedAt: '', lastReviewCommentId: 0, lastIssueCommentId: 0, lastReviewId: 0, createdAt: 1, ...extra }])

  test('an owner record\'s thread, revived when dead', () => {
    record('w-old', 'thread-w')
    const [e] = parsePersistedWatches(old({ sessionId: 'w-old' }))
    expect(e).toMatchObject({ to: 'thread-w', revive: true })
    expect('sessionId' in e).toBe(false)
  })

  test('an owner in a specialist\'s thread: the specialist', () => {
    setSpecialist('reviewer', { channel: 'c', threadId: 'thread-w', kickoff: 'k', updatedAt: 1 } as any)
    record('w-old', 'thread-w')
    expect(parsePersistedWatches(old({ sessionId: 'w-old' }))[0]).toMatchObject({ to: 'reviewer' })
  })

  test('an owner whose record is gone: dropped, as the old rule ended it, never revived', () => {
    expect(parsePersistedWatches(old({ sessionId: 'gone' }))).toEqual([])
  })

  test('main stays main', () => {
    const [e] = parsePersistedWatches(old({ sessionId: 'main' }))
    expect(e.to).toBe('main')
    expect(e.revive).toBeUndefined()
  })
})

test('a low-priority delivery reaches the engine as low priority (Codex may hold it for its next turn)', async () => {
  const seen: any[] = []
  const info = record('w-live', 'thread-live', {
    adapter: { isAlive: () => true, isConnected: () => true, deliver: async (_i: any, m: any) => { seen.push(m); return { status: 'accepted' } } },
  } as unknown as Partial<SessionInfo>)
  const has = transport.has
  const stuck = targetDeps.stuckState
  ;(transport as any).has = (id: string) => id === info.sessionId
  targetDeps.stuckState = () => null
  try {
    expect((await deliverToSession(info, 'x', { lowPriority: true })).ok).toBe(true)
    expect(seen[0].lowPriority).toBe(true)
  } finally { (transport as any).has = has; targetDeps.stuckState = stuck }
})
