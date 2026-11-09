// targets.ts: one vocabulary for where a message goes (spec §3), and one landing for all of them. The spawn is
// stubbed through recovery.ts's seam (and doSpawnSession's module for `spawn` targets), so nothing is launched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway, STATE_DIR } from '../config.js'
import { executeTool } from '../bridge-dispatch.js'
import { _setRecoveryDeps, _resetRecoveryDeps, reviveDeps } from '../recovery.js'
import { _resetBackoff, getBackoff } from '../recovery-backoff.js'
import { _reloadSpecialists, getSpecialist, listSpecialists, removeSpecialist, setSpecialist, withThreadLock } from '../specialists.js'
import { deliverToTarget, parseTarget, conversationSessionName, sessionByName, targetDeps } from '../targets.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { hydra } from './slack-config.js'
import { fakeAdapter } from './test-harness.js'
import { _setDaemonStartedAtForTesting } from '../session-reachability.js'

process.stderr.write = (() => true) as any

let n = 0
const sessions: string[] = []
const threads: string[] = []
const names: string[] = []
const real = { threadExists: reviveDeps.threadExists, stuck: targetDeps.stuckState, send: gateway.send, sendOrQueue: transport.sendOrQueue }
let spawns: any[][] = []

/** A session in `threadId`: alive and bridged unless told otherwise; ten minutes old unless just spawned. */
function occupy(threadId: string, o: { alive?: boolean; connected?: boolean; tmuxName?: string; createdAt?: number } = {}): SessionInfo {
  const sessionId = `tg-sess-${++n}`
  const info = {
    sessionId, tmuxName: o.tmuxName ?? `tg-${n}`, topic: 't', threadId, createdAt: o.createdAt ?? Date.now() - 600_000, lastActive: 1, listening: false,
    engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => o.alive ?? true, usage: () => null }),
  } as unknown as SessionInfo
  registry.set(sessionId, info)
  registry.setThread(threadId, sessionId)
  if (o.connected ?? true) transport.bridges.set(sessionId, { sessionId, socket: { destroyed: false, write: () => true } } as any)
  sessions.push(sessionId); threads.push(threadId)
  return info
}

function stubSpawn() {
  const spawn = async (...args: any[]) => {
    spawns.push(args)
    await new Promise(r => setImmediate(r))  // a spawn is never instant: concurrent deliveries pile up behind it
    const threadId = args[3]?.existingThreadId ?? `tg-new-thread-${++n}`
    // Just spawned: no bridge yet, inside its grace window, so it reads starting (a ten-minute-old one reads orphaned).
    const info = occupy(threadId, { tmuxName: args[3]?.name ?? `tg-new-${n}`, connected: false, createdAt: Date.now() })
    return { name: info.tmuxName, sessionId: info.sessionId, threadId, url: '' }
  }
  _setRecoveryDeps({
    doSpawnSession: spawn as any, tryResume: async () => null,
    tryRespawn: ((threadId: string, topic: string, from: string, model: string, extra: any) => spawn(topic, undefined, undefined, { ...extra, existingThreadId: threadId, resurrectFrom: from, model })) as any,
  })
  return spawn
}

const specialist = (threadId: string | undefined, extra: Record<string, unknown> = {}) => {
  const name = `tgspec${++n}`
  names.push(name)
  setSpecialist(name, { ...(threadId && { threadId }), channel: 'chan-tg', kickoff: 'be the specialist', ...extra })
  return name
}
const opts = { initiator: 'tester' }

// The daemon has been up for hours: a bridgeless session's grace runs from its own start, never from this process's.
// (Left to the process clock, it read starting only while the test process was under 90s old.)
beforeEach(() => { spawns = []; reviveDeps.threadExists = async () => true; stubSpawn(); _setDaemonStartedAtForTesting(0) })
afterEach(() => {
  _setHydraConfigForTesting(undefined)
  _setDaemonStartedAtForTesting(undefined)
  _resetRecoveryDeps(); _resetBackoff()
  Object.assign(reviveDeps, { threadExists: real.threadExists }); targetDeps.stuckState = real.stuck
  ;(gateway as any).send = real.send; (transport as any).sendOrQueue = real.sendOrQueue
  for (const s of sessions.splice(0)) { registry.delete(s); transport.bridges.delete(s) }
  for (const t of threads.splice(0)) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
  for (const name of names.splice(0)) removeSpecialist(name)
})

describe('parseTarget', () => {
  test('exactly one of to, spawn; revive only with to; recipes are checked; errors name where', () => {
    expect(parseTarget({ to: 'ops' }, 'job x')).toEqual({ to: 'ops' })
    expect(parseTarget({ to: '123', revive: true }, 'job x')).toEqual({ to: '123', revive: true })
    expect(parseTarget({ spawn: { channel: 'C1', kickoff: 'k', idle: '4h' } }, 'job x')).toEqual({ spawn: { channel: 'C1', kickoff: 'k', idle: '4h' } })
    expect(() => parseTarget({ to: 'ops', spawn: { channel: 'C1', kickoff: 'k' } }, 'job x')).toThrow('job x: give exactly one of to, spawn')
    expect(() => parseTarget({}, 'job x')).toThrow('job x')
    expect(() => parseTarget({ spawn: { channel: 'C1', kickoff: 'k' }, revive: true }, 'job x')).toThrow('revive goes with to')
    expect(() => parseTarget({ spawn: { channel: 'C1' } }, 'job x')).toThrow('job x.spawn: kickoff or kickoffFile is required')
    expect(() => parseTarget({ spawn: { channel: 'C1', kickoff: 'k', idle: 'soon' } }, 'job x')).toThrow('idle "soon"')
    expect(() => parseTarget({ spawn: { channel: 'C1', kickoff: 'k', prompt: 'p' } }, 'job x')).toThrow('unknown recipe field "prompt"')
    expect(() => parseTarget({ perThread: { channel: 'C1', kickoff: 'k' }, key: 'k' }, 'route 1')).toThrow('give exactly one of to, spawn (got none)')
  })
})

describe('deliverToTarget: `to` resolves main, then a specialist, then an all-digit thread id, else exit 8', () => {
  test('I: a name that is none of them is exit 8, never a specialist made from a typo', async () => {
    expect(await deliverToTarget({ to: 'bookkeper' }, 'm', opts)).toEqual({ ok: false, exit: 8, reason: 'no such specialist: bookkeper' })
    expect(getSpecialist('bookkeper')).toBeUndefined()
    expect(spawns).toHaveLength(0)
  })

  test('a declared specialist wins over a thread id that happens to match nothing; an all-digit `to` is a thread', async () => {
    const live = occupy('987654321')
    expect(await deliverToTarget({ to: '987654321' }, 'm', opts)).toMatchObject({ ok: true, sessionId: live.sessionId, revived: false })
    const name = specialist('987654321')
    expect(await deliverToTarget({ to: name }, 'm', opts)).toMatchObject({ ok: true, sessionId: live.sessionId, specialist: name })
  })

  test('A: first use of a declared specialist opens its thread in its channel, starts a session and queues the message', async () => {
    const name = specialist(undefined)
    const r = await deliverToTarget({ to: name }, 'nightly: 3 failures', opts)
    expect(r).toMatchObject({ ok: true, revived: true, specialist: name, sessionName: name })
    expect(spawns[0][1]).toBe('chan-tg')
    expect(getSpecialist(name)!.threadId).toBe((r as any).threadId)
  })

  test('main is reached by its bridge and is never revived', async () => {
    expect(await deliverToTarget({ to: 'main', revive: true }, 'm', opts)).toMatchObject({ ok: false, exit: 4 })
    expect(spawns).toHaveLength(0)
  })
})

describe('the landing', () => {
  test('a reachable session stuck on a dialog is not a landing: exit 5 "stuck: <verdict>", never delivered into', async () => {
    const live = occupy('tg-stuck')
    let written = 0
    transport.bridges.set(live.sessionId, { sessionId: live.sessionId, socket: { destroyed: false, write: () => { written++; return true } } } as any)
    targetDeps.stuckState = (name: string) => name === live.tmuxName ? { kind: 'unknown_dialog' } as any : null
    expect(await deliverToTarget({ to: 'tg-stuck' }, 'm', opts)).toEqual({ ok: false, exit: 8, reason: 'no such specialist: tg-stuck' }) // not all digits
    const name = specialist('tg-stuck')
    expect(await deliverToTarget({ to: name }, 'm', { ...opts, idempotencyKey: `tg-k-${++n}` })).toEqual({ ok: false, exit: 5, reason: 'stuck: unknown_dialog' })
    expect(written).toBe(0)
    targetDeps.stuckState = () => null
    expect(await deliverToTarget({ to: name }, 'm', opts)).toMatchObject({ ok: true, status: 'delivered' })
  })

  test('a message too large is refused permanently (exit 3), never retried', async () => {
    const name = specialist('tg-big')
    occupy('tg-big')
    expect(await deliverToTarget({ to: name }, 'x'.repeat(200_000), opts)).toMatchObject({ ok: false, exit: 3, permanent: true })
  })

  test('an idempotency key that already landed answers ok and duplicate, without a second delivery', async () => {
    const name = specialist('tg-dup')
    occupy('tg-dup')
    const key = `tg-dup-${++n}`
    const first = await deliverToTarget({ to: name }, 'm', { ...opts, idempotencyKey: key })
    expect(first).toMatchObject({ ok: true })
    expect(await deliverToTarget({ to: name }, 'm', { ...opts, idempotencyKey: key })).toMatchObject({ ok: true, duplicate: true, sessionId: (first as any).sessionId })
  })

  test('a key still in flight is exit 7, never 5: wait, it is landing', async () => {
    const name = specialist('tg-flight')
    occupy('tg-flight')
    const key = `tg-flight-${++n}`
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    _setRecoveryDeps({ tryResume: async () => null, tryRespawn: async () => { await gate; return null as any } })
    registry.deleteThread('tg-flight') // vacant: the first send waits in the refill
    const first = deliverToTarget({ to: name }, 'm', { ...opts, idempotencyKey: key })  // reserves the key before its first await
    expect(await deliverToTarget({ to: name }, 'm', { ...opts, idempotencyKey: key })).toMatchObject({ ok: false, exit: 7 })
    release()
    await first
  })
})

describe('recipes', () => {
  test('spawn: every message gets a fresh session from the recipe, idle-limited when it says so', async () => {
    const t = { spawn: { channel: 'C-scan', kickoff: 'scan the deps', idle: '4h' } }
    const a = await deliverToTarget(t, 'run', opts), b = await deliverToTarget(t, 'run', opts)
    expect([a.ok, b.ok]).toEqual([true, true])
    expect((a as any).sessionId).not.toBe((b as any).sessionId)
    expect(spawns.map(s => [s[0], s[1], s[3].ephemeral, s[3].idleTtlMs])).toEqual([
      ['scan the deps', 'C-scan', true, 4 * 3_600_000], ['scan the deps', 'C-scan', true, 4 * 3_600_000],
    ])
  })

  test("perConversation: one session per conversation from the specialist's recipe, never stored; a second message reaches the same session", async () => {
    setSpecialist('req', { channel: 'chan-req', threadId: 'req-shared-thread', kickoff: 'handle this request', idle: '1d' }); names.push('req')
    const key = 'slack:C0REQ:1700000000.0001'
    const name = conversationSessionName('req', key)
    const t = { perConversation: 'req', conversation: key }
    const a = await deliverToTarget(t, 'first', opts)
    expect(a).toMatchObject({ ok: true, revived: true, specialist: name, sessionName: name })
    expect(name).toBe('req_c0req-1700000000-0001')
    expect(spawns[0][0]).toBe('handle this request')
    expect(spawns[0][1]).toBe('chan-req') // its own thread in the specialist's channel, never the shared thread
    expect(registry.get((a as any).sessionId)).toMatchObject({ ephemeral: true, idleTtlMs: 86_400_000 })
    const b = await deliverToTarget(t, 'second', opts)
    expect(b).toMatchObject({ ok: true, revived: false, sessionId: (a as any).sessionId })
    expect(spawns).toHaveLength(1)
    expect(getSpecialist(name)).toBeUndefined()
    expect(await deliverToTarget({ perConversation: 'nobody', conversation: key }, 'x', opts)).toMatchObject({ ok: false, exit: 8 })

    // Killed (its record gone): the next message revives it in the same Slack-thread's session thread, not a new one.
    const threadId = (a as any).threadId
    threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: (a as any).sessionId, tmuxName: name, originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 0 }] } as any)
    registry.delete((a as any).sessionId); registry.deleteThread(threadId)
    const c = await deliverToTarget(t, 'third', opts)
    expect(c).toMatchObject({ ok: true, revived: true, threadId })
    expect(spawns[1][3]).toMatchObject({ existingThreadId: threadId })
  })
})

describe('a conversation session\'s thread', () => {
  test('a specialists.json specialist declared by its thread alone opens its conversations\' threads in that thread\'s channel', async () => {
    setSpecialist('thr', { threadId: 'thr-shared', kickoff: 'k' }); names.push('thr')
    const realFetch = gateway.fetchChannel
    ;(gateway as any).fetchChannel = async (id: string) => ({ id, parentId: id === 'thr-shared' ? 'chan-parent' : null, isThread: true })
    try {
      const r = await deliverToTarget({ perConversation: 'thr', conversation: 'slack:C0T:1.000001' }, 'x', opts)
      expect(r).toMatchObject({ ok: true })
      expect(spawns[0][1]).toBe('chan-parent')
    } finally { (gateway as any).fetchChannel = realFetch }
  })

  test("a hydra.toml specialist's conversations take its recipe: its idle, its home channel", async () => {
    _setHydraConfigForTesting(hydra(`operator = "op"\n[people.op]\nids = ["slack:UOP"]\n[specialists.hid]\nworkdir = "/w"\nprompt = "k"\nhome = "123456"\nsessions = "per-conversation"\nidle = "90m"\n`))
    const r = await deliverToTarget({ perConversation: 'hid', conversation: 'slack:C0T:1.000001' }, 'x', opts)
    expect(r).toMatchObject({ ok: true, sessionName: 'hid_c0t-1-000001' })
    expect(spawns[0][1]).toBe('123456')
    expect(registry.get((r as any).sessionId)).toMatchObject({ ephemeral: true, idleTtlMs: 90 * 60_000 })
  })
})

describe('max: counted under one lock per specialist, from the sessions running under its names', () => {
  const PER = (extra = '') => hydra(`operator = "op"\n[people.op]\nids = ["slack:UOP"]\n[specialists.mx]\nworkdir = "/w"\nprompt = "k"\nsessions = "per-conversation"\nmax = 2\n${extra}\n[specialists.mx-c1]\nworkdir = "/w"\nprompt = "k"\n`)
  beforeEach(() => { setSpecialist('mx', { channel: 'chan-mx', kickoff: 'k' }); names.push('mx') })

  test('past max, a conversation without a running session waits (exit 5, atMax); one with a session goes', async () => {
    _setHydraConfigForTesting(PER())
    occupy('t-mx-1', { tmuxName: 'mx_c1-1-000001' })
    occupy('t-mx-2', { tmuxName: 'mx_c1-2-000001' })
    occupy('t-other', { tmuxName: 'other_c1-9-000001' }) // another specialist's: not counted
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:3.000001' }, 'x', opts))
      .toMatchObject({ ok: false, exit: 5, atMax: true, reason: expect.stringContaining('mx already runs 2 conversation sessions (max 2); slack:C1:3.000001 waits for one to end, and none ends on its own: give the specialist an idle') })
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:1.000001' }, 'x', opts)).toMatchObject({ ok: true, sessionName: 'mx_c1-1-000001' })
    expect(spawns).toHaveLength(0)
  })

  test("a real specialist named like a session (mx-c1) is never taken for one: the `_` keeps them apart", async () => {
    _setHydraConfigForTesting(PER())
    occupy('t-real', { tmuxName: 'mx-c1' })
    const r = await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1' }, 'x', opts)
    expect(r).toMatchObject({ ok: true, sessionName: 'mx_c1', revived: true })
  })

  test('a rename through `was` keeps the conversation in the session it runs in, and its sessions still count', async () => {
    _setHydraConfigForTesting(PER('was = ["old-mx"]'))
    occupy('t-old-1', { tmuxName: 'old-mx_c1-1-000001' })
    occupy('t-old-2', { tmuxName: 'old-mx_c1-2-000001' })
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:1.000001' }, 'x', opts)).toMatchObject({ ok: true, sessionName: 'old-mx_c1-1-000001' })
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:3.000001' }, 'x', opts)).toMatchObject({ ok: false, atMax: true })
  })

  test('a slow cold start holds up no one: the lock covers only the decision, and the start counts against max while it runs', async () => {
    _setHydraConfigForTesting(PER())
    occupy('t-live', { tmuxName: 'mx_c1-1-000001' })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const realSpawn = (await import('../recovery.js')).currentRecoveryDeps().doSpawnSession
    _setRecoveryDeps({ doSpawnSession: (async (...a: any[]) => { await gate; return (realSpawn as any)(...a) }) as any })
    const cold = deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:2.000001' }, 'x', opts) // hangs in its start
    await Bun.sleep(10)
    // a conversation whose session runs goes straight through
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:1.000001' }, 'y', opts)).toMatchObject({ ok: true, sessionName: 'mx_c1-1-000001' })
    // a third, cold, is told no at once: the hanging start holds the second place
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:3.000001' }, 'z', opts)).toMatchObject({ ok: false, atMax: true })
    release()
    expect(await cold).toMatchObject({ ok: true, sessionName: 'mx_c1-2-000001' })
  })

  test("a conversation's own live session is found even when a dead predecessor's record is listed first", async () => {
    _setHydraConfigForTesting(hydra(`operator = "op"\n[people.op]\nids = ["slack:UOP"]\n[specialists.mx]\nworkdir = "/w"\nprompt = "k"\nsessions = "per-conversation"\nmax = 1\n`))
    occupy('t-dead', { tmuxName: 'mx_c1-1-000001', alive: false, connected: false })
    occupy('t-alive', { tmuxName: 'mx_c1-1-000001' })
    expect(await deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:1.000001' }, 'x', opts)).toMatchObject({ ok: true, threadId: 't-alive' })
  })

  test('two conversations at once cannot both take the last place', async () => {
    _setHydraConfigForTesting(hydra(`operator = "op"\n[people.op]\nids = ["slack:UOP"]\n[specialists.mx]\nworkdir = "/w"\nprompt = "k"\nsessions = "per-conversation"\nmax = 1\n`))
    const [a, b] = await Promise.all([
      deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:1.000001' }, 'x', opts),
      deliverToTarget({ perConversation: 'mx', conversation: 'slack:C1:2.000001' }, 'x', opts),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(spawns).toHaveLength(1)
  })
})

describe('a conversation\'s session shares its thread\'s lock and back-off once it has a thread', () => {
  test('a refill waits on a resume holding the thread, and its failure counts under the thread', async () => {
    setSpecialist('lk', { channel: 'chan-req', kickoff: 'handle it' }); names.push('lk')
    const key = 'slack:C0LK:1700000000.0002'
    const t = { perConversation: 'lk', conversation: key }
    const a = await deliverToTarget(t, 'first', opts)
    const threadId = (a as any).threadId
    threads.push(threadId)
    threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: (a as any).sessionId, tmuxName: conversationSessionName('lk', key), originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 0 }] } as any)
    registry.delete((a as any).sessionId); registry.deleteThread(threadId)

    _setRecoveryDeps({ tryResume: async () => null, tryRespawn: async () => { throw new Error('boom') } })
    let release!: () => void
    const held = withThreadLock(threadId, () => new Promise<void>(r => { release = r }))  // e.g. a `resume` typed in that thread
    let settled = false
    const refill = deliverToTarget(t, 'second', opts).then(r => { settled = true; return r })
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))  // turns of the loop, not wall time: held, it cannot settle
    expect(settled).toBe(false)
    release(); await held
    expect(await refill).toMatchObject({ ok: false, exit: 6 })
    expect(getBackoff(threadId)).toBeDefined()
    expect(getBackoff(conversationSessionName('lk', key))).toBeUndefined()
  })
})

describe('names on every verb', () => {
  const cli = (command: string, params: Record<string, unknown>) => handleCLIRequest({ type: 'cli', command, id: `tg-${++n}`, params } as CLIRequest)

  test('status takes a session name, a specialist\'s name (whoever is in its thread) or a thread id', async () => {
    const live = occupy('tg-verbs', { tmuxName: 'tg-occupant' })
    const name = specialist('tg-verbs')
    for (const by of ['tg-occupant', name, 'tg-verbs']) {
      expect(await cli('status', { name: by })).toMatchObject({ ok: true, data: { name: 'tg-occupant', sessionId: live.sessionId } })
    }
    expect(sessionByName('nobody')).toBeUndefined()
  })

  test('deliver --session S --thread T with S unknown falls back to whoever is in T', async () => {
    const live = occupy('tg-fallback')
    expect(await cli('deliver', { session: 'nobody', thread: 'tg-fallback', message: 'm', initiator: 't' })).toMatchObject({ ok: true, data: { sessionId: live.sessionId } })
  })

  test('the CLI passes `permanent` through, so a sender can drop rather than retry', async () => {
    const name = specialist('tg-perm')
    occupy('tg-perm')
    expect(await cli('deliver', { to: name, message: 'x'.repeat(200_000), initiator: 't' })).toMatchObject({ ok: false, exitCode: 3, data: { permanent: true } })
  })

  test('specialist show reads the stored entry, flagged, as rm does', async () => {
    const file = join(STATE_DIR, 'specialists.json')
    const saved = (() => { try { return require('fs').readFileSync(file, 'utf8') } catch { return undefined } })()
    try {
      writeFileSync(file, JSON.stringify({ '4243': { threadId: 't-4243', updatedAt: 1 } }))
      _reloadSpecialists()
      expect(await cli('specialist', { action: 'show', name: '4243' })).toMatchObject({ ok: true, data: { name: '4243', invalid: expect.stringContaining('needs a letter') } })
    } finally {
      if (saved === undefined) rmSync(file, { force: true }); else writeFileSync(file, saved)
      _reloadSpecialists()
    }
  })

  test('main and parent are reserved: never a specialist name', async () => {
    for (const name of ['main', 'parent']) {
      expect(await cli('specialist', { action: 'set', name, channel: 'c', kickoff: 'k' })).toMatchObject({ ok: false, error: expect.stringContaining('reserved') })
    }
  })

  test('deliver --to on the CLI: a specialist, or exit 8', async () => {
    const name = specialist('tg-cli')
    occupy('tg-cli')
    expect(await cli('deliver', { to: name, message: 'm', initiator: 't' })).toMatchObject({ ok: true, data: { specialist: name } })
    expect(await cli('deliver', { to: 'nobody-here', message: 'm', initiator: 't' })).toMatchObject({ ok: false, exitCode: 8 })
  })
})

describe('send_to_thread', () => {
  test('to a specialist with nobody home: it is filled by its rule, and the message reaches the new session', async () => {
    const sent: string[] = [], delivered: string[] = []
    ;(gateway as any).send = async (channel: string) => { sent.push(channel); return { id: 'm', channelId: channel } }
    ;(transport as any).sendOrQueue = (to: string) => { delivered.push(to) }
    const name = specialist('tg-heal')
    occupy('tg-heal', { alive: false, connected: false, tmuxName: name })
    const caller = occupy('tg-caller')
    const r = await executeTool('send_to_thread', { target: name, type: 'progress', text: 'hello' }, caller.sessionId)
    expect(r.isError).toBeFalsy()
    expect(spawns).toHaveLength(1)
    const healed = registry.getByThread('tg-heal')!
    expect(delivered).toContain(healed)
  })

  test('a live session holding the name reaches the sender even when the specialist points elsewhere', async () => {
    const delivered: string[] = []
    ;(gateway as any).send = async (channel: string) => ({ id: 'm', channelId: channel })
    ;(transport as any).sendOrQueue = (to: string) => { delivered.push(to) }
    const name = specialist('tg-pointed')
    const stray = occupy('tg-stray', { tmuxName: name })
    const caller = occupy('tg-caller2')
    expect((await executeTool('send_to_thread', { target: name, type: 'progress', text: 'hi' }, caller.sessionId)).isError).toBeFalsy()
    expect(delivered).toContain(stray.sessionId)
    expect(spawns).toHaveLength(0)
  })
})

describe('specialists.json', () => {
  test('a stored all-digit name is reported and refused, never renamed', () => {
    const file = join(STATE_DIR, 'specialists.json')
    const saved = (() => { try { return require('fs').readFileSync(file, 'utf8') } catch { return undefined } })()
    try {
      writeFileSync(file, JSON.stringify({ '4242': { threadId: 't-4242', updatedAt: 1 }, ops: { channel: 'c', updatedAt: 1 } }))
      _reloadSpecialists()
      expect(getSpecialist('4242')).toBeUndefined()
      expect(getSpecialist('ops')).toBeDefined()
      expect(listSpecialists().find(([n]) => n === '4242')![1].invalid).toContain('needs a letter')
      expect(require('fs').readFileSync(file, 'utf8')).toContain('"4242"') // kept as it was
    } finally {
      if (saved === undefined) rmSync(file, { force: true }); else writeFileSync(file, saved)
      _reloadSpecialists()
    }
  })
})

describe('hydra deliver --conversation: a per-conversation specialist opens that conversation (a schedule run)', () => {
  const cli = (params: Record<string, unknown>) => handleCLIRequest({ type: 'cli', command: 'deliver', id: `tg-conv-${++n}`, params } as CLIRequest)
  const CFG = `operator = "op"\n[people.op]\nids = ["slack:UOP"]\n[specialists.rev]\nworkdir = "/w"\nprompt = "Weekly review."\nhome = "777"\nsessions = "per-conversation"\nidle = "4d"\n[specialists.shared]\nworkdir = "/w"\nprompt = "k"\n`

  test("its own session, a fresh thread in the specialist's home, run as the sender (jobs:<name>); the same key reaches it again", async () => {
    _setHydraConfigForTesting(hydra(CFG))
    const conversation = 'clock:jobs-rev-2026-11-13T19:00:00.000Z'
    const r = await cli({ to: 'rev', conversation, message: 'Check output:\nweek 45', initiator: 'jobs:rev' })
    expect(r).toMatchObject({ ok: true, data: { sessionName: 'rev_clock-jobs-rev-2026-11-13t19-00-00-000z' } })
    expect(spawns[0][0]).toBe('Weekly review.')                                   // the prompt first; the check output follows
    expect(spawns[0][1]).toBe('777')
    expect(spawns[0][3]).toMatchObject({ initiator: 'jobs:rev' })
    expect(await cli({ to: 'rev', conversation, message: 'again', initiator: 'jobs:rev' })).toMatchObject({ ok: true })
    expect(spawns).toHaveLength(1)
  })

  test('refused without --to, for a shared specialist, or with no key', async () => {
    _setHydraConfigForTesting(hydra(CFG))
    expect(await cli({ thread: '1', conversation: 'clock:x', message: 'm' })).toMatchObject({ ok: false, error: '--conversation <key> goes with --to <specialist>' })
    expect(await cli({ to: 'rev', conversation: '', message: 'm' })).toMatchObject({ ok: false, error: '--conversation <key> goes with --to <specialist>' })
    expect(await cli({ to: 'shared', conversation: 'clock:x', message: 'm' })).toMatchObject({ ok: false, error: "shared isn't a per-conversation specialist in hydra.toml, so it has no conversations to open" })
    expect(spawns).toHaveLength(0)
  })
})
