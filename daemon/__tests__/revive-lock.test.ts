// The target lock (specialists.ts) as the one serializer of "who is home" decisions, and the boot loader
// writing a death's endedAt alongside its deadAt.
import { expect, test } from 'bun:test'
import { handOff, handoffIO } from '../session-lifecycle.js'
import { registry, ThreadRegistry, type SessionInfo } from '../sessions.js'
import { withThreadLock } from '../../specialists/specialists.js'

process.stderr.write = (() => true) as any

test('handoff holds the thread lock from kill to spawn: a revive queued meanwhile runs after the successor exists', async () => {
  const orig = { ...handoffIO }
  const threadId = 'rl-thread-1'
  registry.set('rl-1', { sessionId: 'rl-1', tmuxName: 'rl-old', topic: 't', threadId, createdAt: 1, lastActive: 1, listening: false, engine: 'claude', sessionType: 'thread_owner', adapter: { stop: async () => {} } } as any)
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const order: string[] = []
  handoffIO.killSession = (async (i: SessionInfo) => { order.push('kill'); await gate; registry.delete(i.sessionId) }) as any
  handoffIO.doSpawnSession = (async () => { order.push('spawn'); return { name: 'rl-new', sessionId: 'rl-2', threadId, url: '' } }) as any
  try {
    const handoff = handOff(registry.get('rl-1')!, '/h.md')
    await Bun.sleep(5)
    const revive = withThreadLock(threadId, async () => { order.push('revive') })
    await Bun.sleep(5)
    release()
    await Promise.all([handoff, revive])
    expect(order).toEqual(['kill', 'spawn', 'revive'])
  } finally {
    Object.assign(handoffIO, orig)
    registry.delete('rl-1')
  }
})

test('boot: a session that died while the daemon was down gets its history entry closed at its deadAt', () => {
  const threads = new ThreadRegistry()
  ;(threads as any).persist = () => {}
  ;(threads as any).threadsFile = '/nonexistent/threads.json'
  const dead = { sessionId: 'rl-dead', tmuxName: 'rl-dead', topic: 't', threadId: 'rl-thread-2', createdAt: 1, lastActive: 1, deadAt: 42, sessionType: 'thread_owner' } as SessionInfo
  const live = { ...dead, sessionId: 'rl-live', threadId: 'rl-thread-3', deadAt: undefined } as SessionInfo
  threads.boot({ values: () => [dead, live][Symbol.iterator]() } as any)
  expect(threads.get('rl-thread-2')!.sessionHistory[0].endedAt).toBe(42)
  expect(threads.get('rl-thread-3')!.sessionHistory[0].endedAt).toBeUndefined()
})
