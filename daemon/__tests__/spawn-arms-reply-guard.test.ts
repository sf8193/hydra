import { afterAll, beforeAll, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { doSpawnSession } from '../session-lifecycle.js'
import { registry, threadRegistry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import { _pendingForTesting, _resetReplyGuardForTesting } from '../reply-guard.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

// A fresh thread spawn is a request: a text-only first answer must be relayed by the silence escalation.
const fakeClaude = {
  provider: 'claude', channel: 'bridge',
  launch: async () => ({ provider: 'claude', model: 'claude-x', identity: { claudeSessionId: 'c1' } }),
  stop: async () => ({ status: 'stopped' }), isAlive: () => false, surface: () => null,
}
const orig: Record<string, any> = {}
let fake: FakeTmux

beforeAll(() => {
  fake = withFakeTmux()
  orig.claude = engines.claude; orig.send = gateway.send; orig.fetchChannel = gateway.fetchChannel
  orig.getThreadUrl = gateway.getThreadUrl; orig.createThread = gateway.createThread; orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist; orig.cwd = process.env.SPAWN_CWD
  engines.claude = fakeClaude as any
  ;(gateway as any).send = async (c: string) => ({ id: 'anchor-1', channelId: c })
  ;(gateway as any).createThread = async () => ({ id: 'thread-1' })
  ;(gateway as any).fetchChannel = async (id: string) => ({ isThread: id !== 'P', isDM: false, parentId: 'P' })
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  ;(transport as any).has = () => false
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = process.cwd()
  _resetReplyGuardForTesting()
})

afterAll(() => {
  engines.claude = orig.claude
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread'] as const) (gateway as any)[k] = orig[k]
  ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
  if (orig.cwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.cwd
  _resetReplyGuardForTesting()
  fake.restore()
})

test('spawning a thread session arms the reply guard on the spawn message', async () => {
  const r = await doSpawnSession('t', 'P', 'spawn-msg-1', { initiator: 'sam' })
  const p = [..._pendingForTesting().values()].find(x => x.sessionId === r.sessionId)
  expect(p).toMatchObject({ chatId: r.threadId, messageId: 'spawn-msg-1', user: 'sam' })
  registry.delete(r.sessionId)
})

test('a headless spawn does not arm it', async () => {
  const r = await doSpawnSession('t', 'P', undefined, { headless: true })
  expect([..._pendingForTesting().values()].some(x => x.sessionId === r.sessionId)).toBe(false)
  registry.delete(r.sessionId)
})

// CLI spawns (weekly-replay-cron) pass no message id: the anchor message the daemon posts stands in.
test('a CLI spawn with no message id arms it on the anchor message', async () => {
  const r = await doSpawnSession('t', 'P', undefined, { initiator: 'cron', trigger: 'CLI' })
  const p = [..._pendingForTesting().values()].find(x => x.sessionId === r.sessionId)
  expect(p).toMatchObject({ chatId: r.threadId, messageId: 'anchor-1', user: 'cron' })
  registry.delete(r.sessionId)
})

test('a resume or respawn into an existing thread does not arm it', async () => {
  for (const o of [{ resumeFrom: 'C-old', existingThreadId: 'thread-1' }, { existingThreadId: 'thread-1' }]) {
    const r = await doSpawnSession('t', undefined, undefined, o)
    expect([..._pendingForTesting().values()].some(x => x.sessionId === r.sessionId)).toBe(false)
    registry.delete(r.sessionId)
    registry.deleteThread('thread-1')
  }
})
