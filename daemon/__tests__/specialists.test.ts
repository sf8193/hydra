import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { registry, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { specialistDeps } from '../specialist-deliver.js'
import { removeSpecialist, setSpecialist, getSpecialist, withSpecialistLock, listSpecialists } from '../specialists.js'
import { fakeAdapter } from './test-harness.js'
import { getIdempotencyEntry } from '../idempotency.js'

process.stderr.write = (() => true) as any

let n = 0
const req = (command: string, params: Record<string, unknown>): CLIRequest => ({ type: 'cli', command, id: `specialist-${++n}`, params })
const deliver = (specialist: string, extra: Record<string, unknown> = {}) =>
  handleCLIRequest(req('deliver', { specialist, message: 'a mention', initiator: 'forwarder', ...extra }))

describe('specialists', () => {
  const realSpawn = specialistDeps.spawn
  const names: string[] = []
  const sessions: string[] = []
  const threads: string[] = []
  afterEach(() => {
    specialistDeps.spawn = realSpawn
    for (const s of sessions.splice(0)) { registry.delete(s); transport.bridges.delete(s) }
    for (const t of threads.splice(0)) { registry.threadToSession.delete(t); threadRegistry.delete(t) }
    for (const name of names.splice(0)) removeSpecialist(name)
  })

  const specialist = (thread: string, extra: Record<string, unknown> = {}) => {
    const name = `t-specialist-${++n}`
    names.push(name)
    setSpecialist(name, { threadId: thread, kickoff: 'be the slopbot', ...extra })
    return name
  }
  function occupy(thread: string) {
    const sessionId = `specialist-sess-${++n}`
    sessions.push(sessionId)
    registry.set(sessionId, { sessionId, tmuxName: `${sessionId}-tmux`, threadId: thread, engine: 'claude', createdAt: Date.now(), adapter: fakeAdapter({ isAlive: () => true }) } as any)
    registry.threadToSession.set(thread, sessionId)
    threads.push(thread)
    return sessionId
  }
  /** A spawn that behaves like doSpawnSession: registers a live session and reports its thread. */
  function fakeSpawn() {
    const calls: unknown[][] = []
    specialistDeps.spawn = (async (...args: unknown[]) => {
      calls.push(args)
      await Bun.sleep(15) // a real spawn yields; concurrent callers must still share it
      const opts = args[3] as { existingThreadId?: string }
      const threadId = opts.existingThreadId ?? `fresh-thread-${++n}`
      const sessionId = occupy(threadId)
      return { name: `${sessionId}-tmux`, sessionId, threadId, url: '' }
    }) as typeof specialistDeps.spawn
    return calls
  }

  test('a live occupant gets the message and nothing is spawned', async () => {
    const calls = fakeSpawn()
    const sid = occupy('thread-live')
    const name = specialist('thread-live')
    const res = await deliver(name)
    expect(res).toMatchObject({ ok: true, data: { sessionId: sid, specialist: name, spawned: false, threadId: 'thread-live' } })
    expect(calls).toHaveLength(0)
  })

  test('a vacant specialist spawns once from its kickoff, reusing its thread when hydra knows it', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-known')
    // The thread must be known to hydra for it to be reused.
    threads.push('thread-known')
    threadRegistry.set('thread-known', { threadId: 'thread-known', sessionHistory: [] } as any)
    const res = await deliver(name, { model: undefined })
    expect(res.ok).toBe(true)
    expect((res.data as any).spawned).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('be the slopbot')
    expect((calls[0][3] as any).existingThreadId).toBe('thread-known')
    expect(getSpecialist(name)!.threadId).toBe('thread-known')
  })

  test('two concurrent mentions on a vacant specialist share one spawn', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-vacant', { channel: 'chan-1' })
    const [a, b] = await Promise.all([deliver(name, { idempotencyKey: `specialist-k-${++n}` }), deliver(name, { idempotencyKey: `specialist-k-${++n}` })])
    expect(a.ok && b.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect((a.data as any).sessionId).toBe((b.data as any).sessionId)
    expect([(a.data as any).spawned, (b.data as any).spawned].sort()).toEqual([false, true])
  })

  test('when the thread is unknown the specialist moves to the fresh thread the spawn opened', async () => {
    fakeSpawn()
    const name = specialist('thread-deleted', { channel: 'chan-1' })
    const res = await deliver(name)
    expect(res.ok).toBe(true)
    expect(getSpecialist(name)!.threadId).toBe((res.data as any).threadId)
    expect(getSpecialist(name)!.threadId).not.toBe('thread-deleted')
    expect(getSpecialist(name)!.kickoff).toBe('be the slopbot')
  })

  test('unknown thread with no channel, no kickoff, and unknown specialist each fail clearly and spawn nothing', async () => {
    const calls = fakeSpawn()
    expect(await deliver(specialist('thread-gone'))).toMatchObject({ ok: false, error: expect.stringContaining('no channel') })
    expect(await deliver(specialist('thread-gone-2', { kickoff: undefined, channel: 'c' }))).toMatchObject({ ok: false, error: expect.stringContaining('no kickoff') })
    expect(await deliver('no-such-specialist')).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
    expect(calls).toHaveLength(0)
  })

  test('kickoffFile is re-read on every spawn', async () => {
    const calls = fakeSpawn()
    const dir = mkdtempSync(join(tmpdir(), 'specialist-'))
    try {
      const file = join(dir, 'kick.md')
      writeFileSync(file, 'first kickoff\n')
      const name = specialist('thread-file', { kickoff: undefined, kickoffFile: file, channel: 'c' })
      await deliver(name)
      for (const s of sessions.splice(0)) registry.delete(s)
      for (const t of threads.splice(0)) registry.threadToSession.delete(t)
      writeFileSync(file, 'second kickoff\n')
      await deliver(name)
      expect(calls.map(c => c[0])).toEqual(['first kickoff', 'second kickoff'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the idempotency key blocks a repeat, and a failed delivery frees it', async () => {
    fakeSpawn()
    const name = specialist('thread-idem', { channel: 'c' })
    const key = `specialist-idem-${++n}`
    expect((await deliver(name, { idempotencyKey: key })).ok).toBe(true)
    expect(getIdempotencyEntry(key)?.status).toBe('completed')
    expect(await deliver(name, { idempotencyKey: key })).toMatchObject({ ok: false, exitCode: 2 })

    const failing = specialist('thread-fails')
    const k2 = `specialist-idem-${++n}`
    expect((await deliver(failing, { idempotencyKey: k2 })).ok).toBe(false)
    expect(getIdempotencyEntry(k2)).toBeUndefined()
  })

  test('--specialist excludes --thread/--session', async () => {
    const res = await deliver(specialist('t'), { thread: 'x' })
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('drop --thread/--session') })
  })

  test('specialist set merges: re-pointing the thread keeps the kickoff; rm and list agree', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    const first = await handleCLIRequest(req('specialist', { action: 'set', name, thread: 't1', channel: 'c1', kickoff: 'k' }))
    expect(first).toMatchObject({ ok: true, data: { name, threadId: 't1', channel: 'c1', kickoff: 'k' } })
    const second = await handleCLIRequest(req('specialist', { action: 'set', name, thread: 't2' }))
    expect(second).toMatchObject({ ok: true, data: { threadId: 't2', channel: 'c1', kickoff: 'k' } })
    expect(listSpecialists().some(([s]) => s === name)).toBe(true)
    expect(await handleCLIRequest(req('specialist', { action: 'rm', name }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('specialist', { action: 'show', name }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('specialist', { action: 'set', name: 'Bad Name', thread: 't' }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('specialist', { action: 'set', name: `t-specialist-new-${n}` }))).toMatchObject({ ok: false, error: expect.stringContaining('--thread') })
  })
})

describe('withSpecialistLock', () => {
  test('runs tasks for one specialist in order, even when an earlier one throws', async () => {
    const order: string[] = []
    const a = withSpecialistLock('lock-a', async () => { await Bun.sleep(20); order.push('a1') })
    const b = withSpecialistLock('lock-a', async () => { order.push('a2'); throw new Error('boom') })
    const c = withSpecialistLock('lock-a', async () => { order.push('a3') })
    const other = withSpecialistLock('lock-b', async () => { order.push('b') })
    await Promise.allSettled([a, b, c, other])
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a1'))
    expect(order.filter(x => x.startsWith('a'))).toEqual(['a1', 'a2', 'a3'])
  })
})
