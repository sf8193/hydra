import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { registry, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { specialistDeps, _resetSpecialistBackoff, SPAWN_BACKOFF_BASE_MS } from '../specialist-deliver.js'
import { removeSpecialist, setSpecialist, getSpecialist, withSpecialistLock, listSpecialists } from '../specialists.js'
import { fakeAdapter } from './test-harness.js'
import { getIdempotencyEntry } from '../idempotency.js'

process.stderr.write = (() => true) as any

let n = 0
const req = (command: string, params: Record<string, unknown>): CLIRequest => ({ type: 'cli', command, id: `specialist-${++n}`, params })
const deliver = (specialist: string, extra: Record<string, unknown> = {}) =>
  handleCLIRequest(req('deliver', { specialist, message: 'a mention', initiator: 'forwarder', ...extra }))

describe('specialists', () => {
  test('a specialist cannot take a default session name', () => {
    expect(() => setSpecialist('comet', { threadId: 't-1' })).toThrow(/default session name/)
    expect(getSpecialist('comet')).toBeUndefined()
  })

  const realDeps = { ...specialistDeps }
  const names: string[] = []
  const sessions: string[] = []
  const threads: string[] = []
  afterEach(() => {
    Object.assign(specialistDeps, realDeps)
    _resetSpecialistBackoff()
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
  function occupy(thread: string, over: Record<string, unknown> = {}) {
    const sessionId = `specialist-sess-${++n}`
    sessions.push(sessionId)
    registry.set(sessionId, { sessionId, tmuxName: `${sessionId}-tmux`, threadId: thread, engine: 'claude', createdAt: Date.now(), adapter: fakeAdapter({ isAlive: () => true }), ...over } as any)
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

  test('a refill into a known thread is a respawn that names the last occupant and its model', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-hist')
    threads.push('thread-hist')
    threadRegistry.set('thread-hist', { threadId: 'thread-hist', sessionHistory: [{ tmuxName: 'comet', model: 'claude-opus-5-5' }] } as any)
    expect((await deliver(name)).ok).toBe(true)
    expect(calls[0][3]).toMatchObject({ existingThreadId: 'thread-hist', resurrectFrom: 'comet', model: 'claude-opus-5-5', trigger: `specialist:${name}`, name })
  })

  const cli = (action: string, name: string | undefined, extra: Record<string, unknown> = {}) => handleCLIRequest(req('specialist', { action, ...(name && { name }), ...extra }))

  const spawnAs = (name: string, extra: Record<string, unknown> = {}) => handleCLIRequest(req('spawn', { specialist: name, initiator: 'tester', idempotencyKey: `spawn-as-${++n}`, ...extra }))

  test('a specialist declared with only a channel opens its thread, named for it, on the first delivery', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    names.push(name)
    expect(await cli('set', name, { channel: 'chan-new', kickoff: 'be the slopbot' })).toMatchObject({ ok: true })
    expect(getSpecialist(name)!.threadId).toBeUndefined()
    expect((await deliver(name)).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe('chan-new')
    expect((calls[0][3] as any).existingThreadId).toBeUndefined()
    expect((calls[0][3] as any).name).toBe(name)
    expect(getSpecialist(name)!.threadId).toMatch(/^fresh-thread-/)
  })

  test('a new specialist needs a channel or a thread', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    expect(await cli('set', name, { kickoff: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('--channel') })
    expect(getSpecialist(name)).toBeUndefined()
  })

  test('spawn --specialist fills a vacant specialist; a second spawn, concurrent or later, refuses naming the occupant', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-up', kickoff: 'be the slopbot' })
    const results = await Promise.all([spawnAs(name), spawnAs(name)]) as any[]
    expect(calls).toHaveLength(1) // one spawn, however many callers
    const ok = results.find(r => r.ok)
    const refused = results.find(r => !r.ok)
    const filledBy: string = ok.data.name // read before toMatchObject, which leaves its matchers in the object under Bun
    expect(ok.data.threadId).toBe(getSpecialist(name)!.threadId)
    expect(refused.exitCode).toBe(3)
    expect(refused.error).toContain('already filled by')
    expect(refused.error).toContain(filledBy)
    expect(await spawnAs(name)).toMatchObject({ ok: false, exitCode: 3 })
    expect(calls).toHaveLength(1)
    expect((calls[0][3] as any).initiator).toBe('tester')
    expect((calls[0][3] as any).name).toBe(name)
  })

  test('spawn --specialist: an unknown name, flags the declaration owns, a repeated key, and the refill back-off', async () => {
    const calls = fakeSpawn()
    expect(await spawnAs('no-such-one')).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
    const sid = occupy('thread-spawn-live')
    const live = specialist('thread-spawn-live')
    const filled = await spawnAs(live) as any
    expect(filled).toMatchObject({ ok: false, exitCode: 3 })
    expect(filled.error).toContain(`${sid}-tmux`)
    expect(calls).toHaveLength(0)

    const e = await spawnAs(live, { prompt: 'do x', model: 'm', channel: 'c' }) as any
    expect(e.ok).toBe(false)
    expect(e.error).toContain('prompt, channel, model')

    const key = `spawn-key-${++n}`
    const vacant = specialist('thread-spawn-vacant', { channel: 'c' })
    expect((await spawnAs(vacant, { idempotencyKey: key }) as any).ok).toBe(true)
    expect(await spawnAs(vacant, { idempotencyKey: key })).toMatchObject({ ok: false, exitCode: 2 })

    let attempts = 0
    specialistDeps.spawn = (async () => { attempts++; throw new Error('tmux exploded') }) as typeof specialistDeps.spawn
    const bad = specialist('thread-spawn-bad', { channel: 'c' })
    expect(await deliver(bad)).toMatchObject({ ok: false, error: 'tmux exploded' })
    expect(await deliver(bad)).toMatchObject({ ok: false, exitCode: 6 }) // an automatic refill waits out the back-off
    expect(await spawnAs(bad)).toMatchObject({ ok: false, error: 'tmux exploded' }) // an operator's spawn tries now
    expect(attempts).toBe(2)
    expect(((await cli('show', bad)) as any).data.refillBackoff.failures).toBe(2) // and its failure counts
    fakeSpawn()
    expect((await spawnAs(bad) as any).ok).toBe(true)
    expect(((await cli('show', bad)) as any).data.refillBackoff).toBeUndefined() // a manual success clears it
  })

  test('show and list say who fills the specialist and whether refills are backing off', async () => {
    const sid = occupy('thread-show')
    const filled = specialist('thread-show')
    expect(await cli('show', filled)).toMatchObject({ ok: true, data: { name: filled, occupant: { session: `${sid}-tmux`, connected: false } } })
    specialistDeps.spawn = (async () => { throw new Error('tmux exploded') }) as typeof specialistDeps.spawn
    const bad = specialist('thread-show-bad', { channel: 'c' })
    await deliver(bad)
    const listed = (await cli('list', undefined) as any).data.find((s: any) => s.name === bad)
    expect(listed.occupant).toBeUndefined()
    expect(listed.refillBackoff).toMatchObject({ failures: 1 })
  })

  test('a set or rm that lands while the spawn is running is not undone when the new thread is recorded', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-race', kickoff: 'old kickoff' })
    specialistDeps.spawn = (async () => {
      await Bun.sleep(30)
      const threadId = `fresh-thread-${++n}`
      const sessionId = occupy(threadId)
      return { name: `${sessionId}-tmux`, sessionId, threadId, url: '' }
    }) as typeof specialistDeps.spawn
    const up = spawnAs(name)
    await Bun.sleep(5)
    await cli('set', name, { kickoff: 'new kickoff', model: 'm-2' }) // lands mid-spawn
    expect(await up).toMatchObject({ ok: true })
    expect(getSpecialist(name)).toMatchObject({ kickoff: 'new kickoff', model: 'm-2' })
    expect(getSpecialist(name)!.threadId).toMatch(/^fresh-thread-/) // and the new thread is still recorded, on top of the newer declaration

    const gone = `t-specialist-${++n}`
    names.push(gone)
    await cli('set', gone, { channel: 'chan-race', kickoff: 'k' })
    const up2 = spawnAs(gone)
    await Bun.sleep(5)
    await cli('rm', gone)
    await up2
    expect(getSpecialist(gone)).toBeUndefined() // a removed specialist stays removed
  })

  test('a set --thread that lands while the spawn is running wins; the call fails naming the stray session, which keeps running', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-repoint', kickoff: 'k' })
    let strayThread = ''
    specialistDeps.spawn = (async () => {
      await Bun.sleep(30)
      strayThread = `fresh-thread-${++n}`
      const sessionId = occupy(strayThread)
      return { name: `${sessionId}-tmux`, sessionId, threadId: strayThread, url: '' }
    }) as typeof specialistDeps.spawn
    const key = `spawn-repoint-${++n}`
    const up = spawnAs(name, { idempotencyKey: key })
    await Bun.sleep(5)
    await cli('set', name, { thread: 'thread-chosen-by-operator' })
    const res = await up as any
    const error: string = res.error // read before toMatchObject, which leaves the matcher in its place under Bun
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(3)
    expect(getIdempotencyEntry(key)).toMatchObject({ status: 'spawned' }) // a session did start: a retry with this key is blocked
    expect(error).toContain('re-pointed to thread thread-chosen-by-operator')
    expect(error).toContain(strayThread)
    expect(getSpecialist(name)!.threadId).toBe('thread-chosen-by-operator') // the operator's choice survives
    expect(registry.getByThread(strayThread)).toBeDefined() // and the stray session is left alone
  })

  test('a live session holding the specialist\'s name elsewhere makes a fill refuse (exit 3, naming it) without counting as a failed refill', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-own', { channel: 'c' })
    const strayId = occupy('thread-elsewhere', { tmuxName: name })
    for (const attempt of [1, 2]) {
      const res = await deliver(name) as any
      expect(res.ok).toBe(false)
      expect(res.exitCode).toBe(3) // not 6: this is not a back-off
      expect(res.error).toContain('thread-elsewhere')
      void attempt
    }
    const manual = await spawnAs(name) as any
    expect(manual.exitCode).toBe(3)
    expect(calls).toHaveLength(0)
    expect(registry.get(strayId)).toBeDefined()
  })

  test('a thread Discord no longer has moves the specialist to its channel; without a channel it fails', async () => {
    const calls = fakeSpawn()
    specialistDeps.threadExists = async () => false
    threads.push('thread-del', 'thread-del2')
    threadRegistry.set('thread-del', { threadId: 'thread-del', sessionHistory: [] } as any)
    threadRegistry.set('thread-del2', { threadId: 'thread-del2', sessionHistory: [] } as any)
    const moved = specialist('thread-del', { channel: 'chan-9' })
    const res = await deliver(moved)
    expect(res.ok).toBe(true)
    expect((calls[0][3] as any).existingThreadId).toBeUndefined()
    expect(calls[0][1]).toBe('chan-9')
    expect(getSpecialist(moved)!.threadId).not.toBe('thread-del')
    expect(await deliver(specialist('thread-del2'))).toMatchObject({ ok: false, error: expect.stringContaining('gone') })
  })

  test('failed refills back off per specialist, then try again once the wait passes', async () => {
    let now = 1_000_000
    specialistDeps.now = () => now
    let attempts = 0
    specialistDeps.spawn = (async () => { attempts++; throw new Error('tmux exploded') }) as typeof specialistDeps.spawn
    const name = specialist('thread-backoff', { channel: 'c' })
    expect(await deliver(name)).toMatchObject({ ok: false, error: 'tmux exploded' })
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('backing off') })
    expect(attempts).toBe(1)
    now += SPAWN_BACKOFF_BASE_MS + 1
    expect(await deliver(name)).toMatchObject({ ok: false, error: 'tmux exploded' })
    expect(attempts).toBe(2)
    now += SPAWN_BACKOFF_BASE_MS * 2 + 1 // the second failure doubled the wait
    fakeSpawn()
    expect((await deliver(name)).ok).toBe(true)
  })

  test('an occupant with no bridge past the grace window is orphaned: a failure the caller keeps owing', async () => {
    const calls = fakeSpawn()
    occupy('thread-orphan', { createdAt: Date.now() - 10 * 60_000 })
    const name = specialist('thread-orphan')
    const k = `specialist-orphan-${++n}`
    expect(await deliver(name, { idempotencyKey: k })).toMatchObject({ ok: false, exitCode: 4, error: expect.stringContaining('orphaned') })
    expect(getIdempotencyEntry(k)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('a freshly booting occupant (no bridge yet, inside the grace window) accepts the queued message', async () => {
    occupy('thread-booting')
    const res = await deliver(specialist('thread-booting'))
    expect(res).toMatchObject({ ok: true, data: { spawned: false } })
  })

  test('queued behind an occupant that died during delivery is a failure', async () => {
    let alive = true
    occupy('thread-dies', { adapter: fakeAdapter({ isAlive: () => alive, deliver: async () => { alive = false; return { status: 'accepted', via: 'queued' } } }) })
    transport.set(sessions[sessions.length - 1], { sessionId: sessions[sessions.length - 1], socket: { destroyed: false, write: () => true } } as any)
    // bridge present => not "queued" by the outcome mapping; use a booting session instead
    transport.bridges.delete(sessions[sessions.length - 1])
    const res = await deliver(specialist('thread-dies'))
    expect(res).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('died') })
  })

  test('the delivery carries the caller\'s source label; an oversized message is refused permanently', async () => {
    const seen: any[] = []
    occupy('thread-src', { adapter: fakeAdapter({ isAlive: () => true, deliver: async (_i: unknown, m: unknown) => { seen.push(m); return { status: 'accepted' } } }) })
    const name = specialist('thread-src')
    const { deliverToSpecialist } = await import('../specialist-deliver.js')
    expect((await deliverToSpecialist({ specialist: name, message: 'hi', source: 'slack-watch', initiator: 'slack-watch' })).ok).toBe(true)
    expect(seen[0].meta).toMatchObject({ source: 'slack-watch', specialist: name, initiator: 'slack-watch' })
    const big = await deliverToSpecialist({ specialist: name, message: 'x'.repeat(10_001) })
    expect(big).toMatchObject({ ok: false, permanent: true })
    expect(seen).toHaveLength(1)
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
