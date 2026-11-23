// One answer to "can this session take a message?": an orphaned session (running, no bridge past the grace window) is refused
// out loud, not acked and queued; a booting or connected one takes it. Every engine's adapter is asked the same way.
import { afterEach, describe, expect, test } from 'bun:test'
import { on } from '../../infra/event-bus.js'
import { threadNotices } from '../../shared/notice-limit.js'
import { gateway } from '../../infra/config.js'
import { transport, deliverToAdapter } from '../../sessions/bridge-transport.js'
import { ORPHAN_GRACE_MS, _setDaemonStartedAtForTesting } from '../../sessions/occupancy.js'
import { registry } from '../../sessions/registry.js'
import { engines } from '../../sessions/engine-instances.js'
import '../../app/restricted.js'   // sets the delivery gate, as the daemon does

process.stderr.write = (() => true) as any

// The daemon has been up longer than the grace window, so a session's wait is counted from its own start.
_setDaemonStartedAtForTesting(0)
const ids: string[] = []
function session(id: string, over: { alive: boolean; ageMs: number; deadAt?: number }) {
  ids.push(id)
  registry.set(id, {
    sessionId: id, tmuxName: `${id}-tmux`, topic: 't', threadId: `th-${id}`, createdAt: Date.now() - over.ageMs, lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner', ...(over.deadAt && { deadAt: over.deadAt }),
    adapter: Object.assign(Object.create(engines.claude), { isAlive: () => over.alive }),
  } as any)
  return registry.get(id)!
}
afterEach(() => { for (const id of ids.splice(0)) { registry.delete(id); transport.bridges.delete(id); transport.messageQueues.delete(id) } })

const text = (id: string) => ({ type: 'notification' as const, content: 'hello', meta: { message_id: 'm1', chat_id: `th-${id}` } })
const failures = (): any[] => { const out: any[] = []; on('delivery:failed', e => { out.push(e) }, `t-${Math.random()}`); return out }

describe('transport.deliver asks the one answer', () => {
  test('an orphaned Claude session refuses, tells the thread, and queues nothing', async () => {
    const failed = failures()
    session('o1', { alive: true, ageMs: ORPHAN_GRACE_MS * 2 })
    const r = await transport.deliver('o1', text('o1'))
    expect(r.status).toBe('rejected')
    expect(transport.messageQueues.get('o1') ?? []).toHaveLength(0)
    expect(failed.map(f => f.sessionId)).toEqual(['o1'])
  })
  test('a booting Claude session (no bridge yet, inside the grace window) queues for its bridge', async () => {
    const failed = failures()
    session('b1', { alive: true, ageMs: 1000 })
    const r = await transport.deliver('b1', text('b1'))
    expect(r).toMatchObject({ status: 'accepted', via: 'queued' })
    expect(transport.messageQueues.get('b1')).toHaveLength(1)
    expect(failed).toEqual([])
  })
  test('a dead Claude session refuses', async () => {
    session('d1', { alive: false, ageMs: ORPHAN_GRACE_MS * 2 })
    expect((await transport.deliver('d1', text('d1'))).status).toBe('rejected')
    expect(transport.messageQueues.get('d1') ?? []).toHaveLength(0)
  })
  test('the same holds on the path that bypasses the transport entry (deliverToAdapter)', async () => {
    const info = session('o2', { alive: true, ageMs: ORPHAN_GRACE_MS * 2 })
    expect((await deliverToAdapter(info, text('o2'), { connected: false })).status).toBe('rejected')
  })
})

describe('a bridge that dropped is booting for the grace window, not an orphan', () => {
  const socket = () => ({ sessionId: '', buf: '', socket: { write: () => true, end() {}, destroyed: false } as any })
  test('a mid-life drop (old session, daemon up for an hour) queues for the bridge that retries; after the grace it refuses', async () => {
    _setDaemonStartedAtForTesting(Date.now() - 3600_000)
    try {
      session('bl1', { alive: true, ageMs: 600_000 })
      transport.set('bl1', { ...socket(), sessionId: 'bl1' })
      expect((await transport.deliver('bl1', text('bl1'))).status).toBe('accepted')
      transport.delete('bl1')                                   // socket close
      expect(await transport.deliver('bl1', text('bl1'))).toMatchObject({ status: 'accepted', via: 'queued' })
      expect(transport.messageQueues.get('bl1')).toHaveLength(1)
      ;(transport as any).droppedAt.set('bl1', Date.now() - ORPHAN_GRACE_MS - 1)   // it never came back
      expect((await transport.deliver('bl1', text('bl1'))).status).toBe('rejected')
      transport.set('bl1', { ...socket(), sessionId: 'bl1' })   // registering again clears the drop
      expect((transport as any).droppedAt.has('bl1')).toBe(false)
    } finally { _setDaemonStartedAtForTesting(0) }
  })
})

describe('the refusal notice is limited', () => {
  test('three messages to an orphan post one ⚠️ in its thread, not three', async () => {
    const real = gateway.send
    const posted: string[] = []
    threadNotices.clear()
    ;(gateway as any).send = async (_c: string, t: string) => { posted.push(t); return { id: 'm' } }
    try {
      session('n1', { alive: true, ageMs: ORPHAN_GRACE_MS * 2 })
      for (let i = 0; i < 3; i++) await transport.deliver('n1', text('n1'))
      await Bun.sleep(30)
      expect(posted.filter(t => t.includes('orphaned'))).toHaveLength(1)
    } finally { ;(gateway as any).send = real; threadNotices.clear() }
  })
})
