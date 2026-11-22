// A start that cannot sit in the thread it was given. A handoff, respawn or revive of a record that stored an id the gateway cannot address
// (a session id where a thread id belongs) is a fresh thread under its parent's channel, never a refusal: the predecessor may already be
// killed. A joined or made thread that is not addressable fails before anything is made, or cleans up what was.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { doSpawnSession } from '../../app/session-lifecycle.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { engines } from '../../sessions/engine-instances.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { fakeAdapter } from './test-harness.js'

process.stderr.write = (() => true) as any

const SID = '472d35be-061a-43d8-bd50-eba33b094694'
const PARENT_CHANNEL = '1563248896690626651'
const NEW_THREAD = '1573000000000000009'

const fakeClaude = {
  provider: 'claude', channel: 'bridge',
  launch: async () => ({ provider: 'claude', model: 'claude-x', identity: { claudeSessionId: 'c1' } }),
  stop: async () => ({ status: 'stopped' }), isAlive: () => false, surface: () => null,
}
const orig: Record<string, any> = {}
let fake: FakeTmux
const sent: string[] = []; const created: string[] = []; const deleted: string[] = []
let madeId = NEW_THREAD

beforeAll(() => {
  fake = withFakeTmux()
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'deleteThread', 'delete'] as const) orig[k] = (gateway as any)[k]
  orig.claude = engines.claude; orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist; orig.cwd = process.env.SPAWN_CWD
  engines.claude = fakeClaude as any
  ;(gateway as any).send = async (c: string) => { sent.push(c); return { id: 'anchor-1', channelId: c } }
  ;(gateway as any).createThread = async (c: string) => { created.push(c); return { id: madeId } }
  ;(gateway as any).deleteThread = async (id: string) => { deleted.push(`thread:${id}`) }
  ;(gateway as any).delete = async (c: string, m: string) => { deleted.push(`msg:${c}/${m}`) }
  ;(gateway as any).fetchChannel = async (id: string) => ({ isThread: false, isDM: false, parentId: null, id })
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  ;(transport as any).has = () => false
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = process.cwd()
})
afterAll(() => {
  engines.claude = orig.claude
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'deleteThread', 'delete'] as const) (gateway as any)[k] = orig[k]
  ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
  if (orig.cwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.cwd
  fake.restore()
})
afterEach(() => {
  sent.length = 0; created.length = 0; deleted.length = 0; madeId = NEW_THREAD
  for (const s of [...registry.values()]) if (s.sessionId.startsWith('trs-')) registry.delete(s.sessionId)
})

function seed(id: string, over: Record<string, unknown>) {
  registry.set(id, { sessionId: id, tmuxName: id, topic: 't', createdAt: Date.now() - 60_000, lastActive: 1, listening: false, engine: 'claude', sessionType: 'thread_owner',
    adapter: fakeAdapter({ isAlive: () => false, stop: async () => undefined }), ...over } as any)
}

test('a respawn or revive of a record that stored a session id gets a fresh thread under its parent\'s channel, not a refusal', async () => {
  seed('trs-parent', { threadId: '1567260167517503609', anchorChannelId: PARENT_CHANNEL, adapter: fakeAdapter({ isAlive: () => true, stop: async () => undefined }) })
  seed('trs-bad', { threadId: SID, parentId: 'trs-parent', deadAt: 1 })
  registry.setThread(SID, 'trs-bad')
  const r = await doSpawnSession('t', undefined, undefined, { existingThreadId: SID, resurrectFrom: 'trs-bad', carryOver: { parentId: 'trs-parent' } as any })
  expect(r.threadId).toBe(NEW_THREAD)
  expect(created).toEqual([PARENT_CHANNEL])
  expect(registry.get(r.sessionId)?.threadId).toBe(NEW_THREAD)
  expect(registry.get(r.sessionId)?.respawnCount).toBe(1)   // it replaced the dead record (carried its count)
  expect(registry.get('trs-bad')).toBeUndefined()   // the record that stored the bad id is replaced, not left beside its successor
  registry.delete(r.sessionId)
})

test('with no parent to name a channel it is the default one', async () => {
  const r = await doSpawnSession('t', undefined, undefined, { existingThreadId: SID })
  expect(r.threadId).toBe(NEW_THREAD)
  expect(created).toHaveLength(1)
  registry.delete(r.sessionId)
})

test('a joined thread that is not addressable fails before anything is made', async () => {
  await expect(doSpawnSession('t', undefined, undefined, { joinThread: SID })).rejects.toThrow('is not a discord thread id')
  expect(sent).toEqual([]); expect(created).toEqual([])
})

test('a thread the gateway makes and cannot address is removed with its anchor, and the start fails', async () => {
  madeId = SID
  const before = [...registry.values()].length
  await expect(doSpawnSession('t', PARENT_CHANNEL, undefined, {})).rejects.toThrow('is not a discord thread id')
  expect(deleted).toEqual([`thread:${SID}`, `msg:${PARENT_CHANNEL}/anchor-1`])
  expect([...registry.values()].length).toBe(before)
})

test('one made on the spawn message is refused the same way', async () => {
  madeId = SID
  await expect(doSpawnSession('t', PARENT_CHANNEL, 'spawn-msg', {})).rejects.toThrow('is not a discord thread id')
  expect(deleted).toContain(`thread:${SID}`)
})
