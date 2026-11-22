// `hydra kill <name|thread id> --destroy` and `kill_session {thread_id, destroy}` on a thread no live session is in
// (its session ended, or none ever lived there): behind `[threads] allow_destroy`, off by default.
//
// What must hold: off, it refuses and names the key, and nothing is deleted; on, the thread goes and so do its records
// (threads.json entry, PR watches, a bound conversation's hold, via `thread:destroyed`); each guard refuses with its reason.
// A live session's destroy is untouched by the setting.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { engines } from '../../sessions/engine-instances.js'
import { executeTool } from '../../app/bridge-dispatch.js'
import { handleCLIRequest } from '../../app/cli-handler.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { on } from '../../infra/event-bus.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import type { SessionInfo } from '../../sessions/registry.js'
import type { HydraConfig } from '../../config/types.js'
import { listWatches } from '../../connectors/github/pr-watch.js'
import { setSpecialist, removeSpecialist } from '../../sessions/specialists.js'
import { gateway } from '../../infra/config.js'
import { registerProtocol } from '../../sessions/protocol-registry.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { seedPrWatch } from './test-harness.js'
import { sessionTokenHash } from '../../sessions/cli-caller.js'

const PARENT_CH = 'parent-channel-det'
const base = { connectors: {}, gateways: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] } as unknown as HydraConfig
const on_ = () => _setHydraConfigForTesting({ ...base, allowThreadDestroy: true })
const off = () => _setHydraConfigForTesting({ ...base })

let deleted: string[] = []
let isThread = true
let orig: Record<string, unknown> = {}
let tmux: FakeTmux
let origStderr: typeof process.stderr.write
let seq = 0
let announced: string[] = []
let offEvent = () => {}
const seeded = new Set<string>()
const threadsSeeded = new Set<string>()

beforeAll(() => {
  orig = { deleteThread: gateway.deleteThread, delete: gateway.delete, react: gateway.react, send: gateway.send, fetchChannel: gateway.fetchChannel, getThreadStarterInfo: gateway.getThreadStarterInfo, rp: registry.persist, tp: threadRegistry.persist }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})
afterAll(() => {
  Object.assign(gateway as any, { deleteThread: orig.deleteThread, delete: orig.delete, react: orig.react, send: orig.send, fetchChannel: orig.fetchChannel, getThreadStarterInfo: orig.getThreadStarterInfo })
  ;(registry as any).persist = orig.rp
  ;(threadRegistry as any).persist = orig.tp
  _setHydraConfigForTesting(undefined)
})
beforeEach(() => {
  tmux = withFakeTmux()
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  deleted = []
  announced = []
  isThread = true
  off()
  offEvent = on('thread:destroyed', ({ threadId }) => { announced.push(threadId) }, 'test: thread:destroyed')
  Object.assign(gateway as any, {
    deleteThread: async (id: string) => { deleted.push(id) },
    delete: async () => {},
    react: async () => {},
    send: async (c: string) => ({ id: 'm1', channelId: c }),
    fetchChannel: async () => ({ isThread, isDM: false, parentId: PARENT_CH }),
    getThreadStarterInfo: async () => ({ starterId: 'anchor' }),
  })
})
afterEach(() => {
  offEvent()
  tmux.restore()
  for (const id of seeded) {
    const t = registry.get(id)?.threadId
    registry.delete(id)
    if (t) registry.deleteThread(t)
  }
  seeded.clear()
  for (const t of threadsSeeded) threadRegistry.threads.delete(t)
  threadsSeeded.clear()
  process.stderr.write = origStderr
})

/** A thread whose session ended: its record lists the session, none is in the registry. */
function ended(name: string, threadId: string, spawnerThreadId?: string, hydraMade = true): void {
  threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, ...(hydraMade && { hydraMade }),
    sessionHistory: [{ sessionId: `gone-${name}`, tmuxName: name, originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 0, ...(spawnerThreadId && { spawnerThreadId }) }] })
  threadsSeeded.add(threadId)
}
function live(name: string, threadId: string): SessionInfo {
  const info = {
    sessionId: `sess-det-${++seq}`, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: name, listening: false, engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner',
    anchorChannelId: PARENT_CH, anchorMessageId: 'anchor',
  } as SessionInfo
  info.sessionTokenHash = sessionTokenHash(`tok-${info.sessionId}`)
  registry.set(info.sessionId, info)
  registry.setThread(threadId, info.sessionId)
  seeded.add(info.sessionId)
  threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [], hydraMade: true })
  threadsSeeded.add(threadId)
  tmux.alive(name)
  return info
}

const cli = (params: Record<string, unknown>, caller?: unknown) => handleCLIRequest({ type: 'cli' as const, command: 'kill', id: `det-${++seq}`, params, ...(caller !== undefined && { caller }) })
/** The CLI in a session's shell presents its session's token (shared/caller.ts). */
const token = (sessionId: string) => ({ token: `tok-${sessionId}` })
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

describe('off (the default): it refuses, names the key, and deletes nothing', () => {
  test('hydra kill <ended name> --destroy', async () => {
    ended('old', '9001')
    const res = await cli({ name: 'old', destroy: true })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('[threads] allow_destroy = true')
    expect(deleted).toEqual([])
    expect(threadRegistry.get('9001')).toBeDefined()
  })
  test('hydra kill <thread id> --destroy', async () => {
    const res = await cli({ name: '9002', destroy: true })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('allow_destroy')
    expect(deleted).toEqual([])
  })
  test('kill_session {thread_id, destroy}', async () => {
    ended('old', '9003')
    const r = await executeTool('kill_session', { thread_id: '9003', destroy: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('[threads] allow_destroy = true')
    expect(deleted).toEqual([])
  })
  test('without --destroy an ended name is still "not found"', async () => {
    ended('old', '9004')
    on_()
    const res = await cli({ name: 'old' })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('not found')
    expect(deleted).toEqual([])
  })
})

describe('on: the thread is deleted and its records cleared', () => {
  beforeEach(on_)

  test('hydra kill <ended name> --destroy', async () => {
    ended('old', '9101')
    seedPrWatch('https://github.com/o/r/pull/9101', '9101')
    seedPrWatch('https://github.com/o/r/pull/9102', 'elsewhere')
    const res = await cli({ name: 'old', destroy: true })
    expect(res.ok).toBe(true)
    expect((res.data as any).destroyed).toBe('9101')
    expect(deleted).toEqual(['9101'])
    expect(threadRegistry.get('9101')).toBeUndefined()
    expect(listWatches().map(w => w.prNumber)).not.toContain(9101)
    expect(listWatches().map(w => w.prNumber)).toContain(9102)
    expect(announced).toEqual(['9101'])
  })
  test('hydra kill <thread id> --destroy, a thread hydra has no record of', async () => {
    const res = await cli({ name: '9102', destroy: true })
    expect(res.ok).toBe(true)
    expect(deleted).toEqual(['9102'])
    expect(announced).toEqual(['9102'])
  })
  test('kill_session {thread_id, destroy} from main', async () => {
    ended('old', '9103')
    const r = await executeTool('kill_session', { thread_id: '9103', destroy: true })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('deleted thread 9103')
    expect(deleted).toEqual(['9103'])
    expect(threadRegistry.get('9103')).toBeUndefined()
  })
})

describe('on: the two edges of "ended"', () => {
  beforeEach(on_)

  test('a recycled name that ended two threads is ambiguous: nothing is deleted, the ids are listed', async () => {
    ended('cedar', '9401'); ended('cedar', '9402')
    const res = await cli({ name: 'cedar', destroy: true })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('9401')
    expect(JSON.stringify(res)).toContain('9402')
    expect(deleted).toEqual([])
    expect((await cli({ name: '9402', destroy: true })).ok).toBe(true)
    expect(deleted).toEqual(['9402'])
  })
  test('the starting message goes only where hydra posted it', async () => {
    const removed: string[] = []
    ;(gateway as any).delete = async (_c: string, m: string) => { removed.push(m) }
    ended('mine', '9403')
    expect((await cli({ name: '9403', destroy: true })).ok).toBe(true)
    expect(removed).toEqual(['anchor'])
    removed.length = 0
    expect((await cli({ name: '9404', destroy: true })).ok).toBe(true)   // no record: a person may have started it
    expect(deleted).toEqual(['9403', '9404'])
    expect(removed).toEqual([])
  })
})

describe('on, and a guard refuses', () => {
  beforeEach(on_)

  test('a channel or DM (main lives there)', async () => {
    isThread = false
    const res = await cli({ name: '9201', destroy: true })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('not a thread')
    expect(deleted).toEqual([])
  })
  test('a specialist\'s home thread', async () => {
    setSpecialist('det-ops', { threadId: '9202', workdir: '/tmp' } as never)
    try {
      const res = await cli({ name: '9202', destroy: true })
      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).toContain("specialist **det-ops**'s home thread")
      expect(deleted).toEqual([])
    } finally { removeSpecialist('det-ops') }
  })
  test('a thread a live session is in: the live destroy is the way, and says so', async () => {
    live('alive', '9203')
    const out = await import('../../app/destroy.js').then(m => m.destroyThreadById('9203', 'test'))
    expect(out.ok).toBe(false)
    expect((out as any).text).toContain('Kill it first')
    expect((out as any).text).toContain('kill +d')
    expect(deleted).toEqual([])
  })
  test('a session cannot destroy by thread id: only the operator\'s shell or main', async () => {
    const pm = live('pm', '9204')
    ended('old', '9205')
    const res = await cli({ name: 'old', destroy: true }, token(pm.sessionId))
    expect(res.ok).toBe(false)
    expect(deleted).toEqual([])
    const r = await executeTool('kill_session', { thread_id: '9205', destroy: true }, pm.sessionId)
    expect(r.isError).toBe(true)
    expect(deleted).toEqual([])
  })
})

describe('a live session\'s destroy is untouched by the setting (off, as today)', () => {
  test('hydra kill <live name> --destroy deletes with allow_destroy unset', async () => {
    live('kid', '9301')
    const res = await cli({ name: 'kid', destroy: true })
    expect(res.ok).toBe(true)
    expect(deleted).toEqual(['9301'])
  })
})

describe('on: the session that spawned an ended session may destroy its thread', () => {
  beforeEach(on_)
  const asTool = (callerId: string, thread: string) => executeTool('kill_session', { thread_id: thread, destroy: true }, callerId)
  const asCli = (callerId: string, thread: string) => cli({ name: thread, destroy: true }, token(callerId))

  test('the spawner, by tool and by CLI', async () => {
    const pm = live('pm', '9501')
    ended('kid', '9502', '9501'); ended('kid2', '9503', '9501')
    const r = await asTool(pm.sessionId, '9502')
    expect(r.isError).toBeFalsy()
    expect((await asCli(pm.sessionId, '9503')).ok).toBe(true)
    expect(deleted).toEqual(['9502', '9503'])
    expect(threadRegistry.get('9502')).toBeUndefined()
  })
  test('its handoff successor: another session in the same thread', async () => {
    const pm = live('pm', '9511')
    const successor = { ...pm, sessionId: `sess-det-${++seq}`, createdAt: Date.now() + 1 } as SessionInfo
    successor.sessionTokenHash = sessionTokenHash(`tok-${successor.sessionId}`)
    registry.set(successor.sessionId, successor); seeded.add(successor.sessionId)
    registry.setThread('9511', successor.sessionId)   // a handoff makes the successor the thread's owner
    ended('kid', '9512', '9511')
    expect((await asTool(successor.sessionId, '9512')).isError).toBeFalsy()
    expect(deleted).toEqual(['9512'])
  })
  test('a protocol guest in the spawner\'s thread (the review Critic) is refused: in the thread is not owning it', async () => {
    const pm = live('pm', '9571')
    const critic = { ...pm, sessionId: `sess-det-${++seq}`, tmuxName: 'critic', sessionType: 'thread_guest' } as SessionInfo
    critic.sessionTokenHash = sessionTokenHash(`tok-${critic.sessionId}`)
    registry.set(critic.sessionId, critic); seeded.add(critic.sessionId)   // a guest: never setThread'd, the owner stays pm
    ended('kid', '9572', '9571')
    const r = await asTool(critic.sessionId, '9572')
    expect(r.isError).toBe(true)
    expect((await asCli(critic.sessionId, '9572')).ok).toBe(false)
    expect(deleted).toEqual([])
    expect((await asTool(pm.sessionId, '9572')).isError).toBeFalsy()   // the owner still may
  })
  test('a protocol participant that owns the spawner\'s thread is refused, as the live destroy refuses it', async () => {
    const pm = live('pm', '9581')
    registerProtocol('ended-destroy-test', { getByThread: () => false, isParticipant: id => id === pm.sessionId, onReply: () => {}, onDisconnect: () => {}, onReconnect: () => {} })
    try {
      ended('kid', '9582', '9581')
      expect((await asTool(pm.sessionId, '9582')).isError).toBe(true)
      expect(deleted).toEqual([])
    } finally { (await import('../../sessions/protocol-registry.js'))._resetForTesting() }
  })
  test('a sibling, the child itself and a stranger are refused, and the refusal names who may', async () => {
    const pm = live('pm', '9521')
    const sibling = live('sib', '9522')
    const stranger = live('str', '9523')
    ended('kid', '9524', '9521')
    for (const c of [sibling, stranger]) {
      const r = await asTool(c.sessionId, '9524')
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('spawned it')
      expect(text(r)).toContain('handoff successor')
      expect((await asCli(c.sessionId, '9524')).ok).toBe(false)
    }
    // The child itself: a session answering in its own thread (the thread it was spawned into is the spawner's, not its own).
    const child = live('kidlive', '9524')
    expect((await asTool(child.sessionId, '9524')).isError).toBe(true)
    expect(deleted).toEqual([])
    void pm
  })
  test('an old entry without the field is refused as before', async () => {
    const pm = live('pm', '9531')
    ended('kid', '9532')
    expect((await asTool(pm.sessionId, '9532')).isError).toBe(true)
    expect((await asCli(pm.sessionId, '9532')).ok).toBe(false)
    expect(deleted).toEqual([])
  })
  test('a caller with no record, against an entry without the field, is refused (no thread on either side must not match)', async () => {
    ended('kid', '9536')
    expect((await asTool('no-such-session', '9536')).isError).toBe(true)
    expect((await asCli('no-such-session', '9536')).ok).toBe(false)
    expect(deleted).toEqual([])
  })
  test('a thread hydra did not make is refused, as the live destroy refuses it', async () => {
    const pm = live('pm', '9541')
    ended('kid', '9542', '9541', false)
    expect((await asTool(pm.sessionId, '9542')).isError).toBe(true)
    expect(deleted).toEqual([])
  })
  test('allow_destroy = false refuses the spawner too, and names the key', async () => {
    const pm = live('pm', '9551')
    ended('kid', '9552', '9551')
    off()
    const r = await asTool(pm.sessionId, '9552')
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('[threads] allow_destroy = true')
    expect(JSON.stringify(await asCli(pm.sessionId, '9552'))).toContain('allow_destroy')
    expect(deleted).toEqual([])
  })
  test('the spawner is recorded at spawn: its thread id, kept across a handoff', async () => {
    const { recordSpawnFor } = { recordSpawnFor: (t: string, sp?: string) => threadRegistry.recordSpawn(t, { topic: 't', respawnCount: 0, sessionId: `s-${t}`, tmuxName: 'k', originType: 'spawn', label: undefined, ...(sp && { spawnerThreadId: sp }) }) }
    recordSpawnFor('9561', '9560'); threadsSeeded.add('9561')
    expect(threadRegistry.get('9561')!.sessionHistory.at(-1)!.spawnerThreadId).toBe('9560')
    recordSpawnFor('9562'); threadsSeeded.add('9562')
    expect('spawnerThreadId' in threadRegistry.get('9562')!.sessionHistory.at(-1)!).toBe(false)
  })
})
