// "Ended" is written by two functions that pair: markDead stamps `deadAt` on the record and `endedAt` on its history entry;
// markRevived clears both. A boot that finds a session alive does the same for its entry.
import { describe, expect, test } from 'bun:test'
import { SessionRegistry, ThreadRegistry, markDead, markRevived, registry, threadRegistry, type SessionInfo } from '../../sessions/registry.js'
import { reconnectCodexAfterDisconnect, reconnectCodexSessions } from '../../app/codex-runtime.js'
import { reconnecting } from './reconnecting.js'

const threadsIn = (): ThreadRegistry => {
  const threads = new ThreadRegistry()
  const t = threads as unknown as { persist: () => void; threadsFile: string }
  t.persist = () => {}
  t.threadsFile = '/nonexistent/threads.json'
  return threads
}
const recordOf = (sessionId: string, threadId: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId, tmuxName: sessionId, topic: 't', threadId, createdAt: 1, lastActive: 1, sessionType: 'thread_owner', engine: 'claude', ...extra }) as SessionInfo

describe('a session found alive at boot has an open history entry', () => {
  test('an entry a death closed is reopened when its session is alive again', () => {
    const threads = threadsIn()
    threads.recordSpawn('th-1', { topic: 't', respawnCount: 0, sessionId: 's-1', tmuxName: 'one', originType: 'spawn', label: undefined, engine: 'claude' })
    threads.closeHistoryEntry('th-1', { sessionId: 's-1', messageCount: 4 })
    expect(threads.get('th-1')!.sessionHistory[0].endedAt).toBeNumber()
    threads.boot({ values: () => [recordOf('s-1', 'th-1')][Symbol.iterator]() } as unknown as SessionRegistry)
    expect(threads.get('th-1')!.sessionHistory[0].endedAt).toBeUndefined()
  })

  test('a session dead at boot keeps its entry closed, at the stamp', () => {
    const threads = threadsIn()
    threads.recordSpawn('th-2', { topic: 't', respawnCount: 0, sessionId: 's-2', tmuxName: 'two', originType: 'spawn', label: undefined, engine: 'claude' })
    threads.boot({ values: () => [recordOf('s-2', 'th-2', { deadAt: 7 })][Symbol.iterator]() } as unknown as SessionRegistry)
    expect(threads.get('th-2')!.sessionHistory[0].endedAt).toBe(7)
  })
})

describe('markRevived', () => {
  test('clears the death on the record and on its entry, so a later kill closes the entry whole', () => {
    threadRegistry.recordSpawn('th-r', { topic: 't', respawnCount: 0, sessionId: 's-r', tmuxName: 'revive-r', originType: 'spawn', label: undefined, engine: 'codex' })
    const info = recordOf('s-r', 'th-r', { engine: 'codex' })
    registry.set(info.sessionId, info)
    markDead(info)
    const entry = () => threadRegistry.get('th-r')!.sessionHistory[0]
    expect(info.deadAt).toBeNumber()
    expect(entry().endedAt).toBeNumber()

    markRevived(info)
    expect(info.deadAt).toBeUndefined()
    expect(entry().endedAt).toBeUndefined()

    threadRegistry.closeHistoryEntry('th-r', { sessionId: 's-r', messageCount: 9 })
    expect(entry()).toMatchObject({ messageCount: 9 })
    expect(entry().endedAt).toBeNumber()
  })

  test('a Codex reconnect that succeeds revives through it', async () => {
    threadRegistry.recordSpawn('th-c', { topic: 't', respawnCount: 0, sessionId: 's-c', tmuxName: 'revive-c', originType: 'spawn', label: undefined, engine: 'codex' })
    const info = recordOf('s-c', 'th-c', { engine: 'codex', codexThreadId: 'cx', codexHomeName: 'revive-c', adapter: { ...reconnecting(async () => true), surface: () => 'x' } as any })
    registry.set(info.sessionId, info)
    markDead(info)
    const ok = await reconnectCodexAfterDisconnect('s-c', { get: () => info, wait: async () => {}, persist: () => {}, failed: () => {} })
    expect(ok).toBe(true)
    expect(info.deadAt).toBeUndefined()
    expect(threadRegistry.get('th-c')!.sessionHistory[0].endedAt).toBeUndefined()
  })

  test('a record ended while it waited its turn in the boot sweep stays ended and is not surfaced', async () => {
    threadRegistry.recordSpawn('th-w', { topic: 't', respawnCount: 0, sessionId: 's-w', tmuxName: 'sweep-w', originType: 'spawn', label: undefined, engine: 'codex' })
    let surfaced = 0
    const waiting = recordOf('s-w', 'th-w', { engine: 'codex', codexThreadId: 'cx-w', codexHomeName: 'sweep-w', adapter: { ...reconnecting(async () => true), surface: () => { surfaced++; return 'x' } } as any })
    const first = recordOf('s-f', 'th-f', { engine: 'codex', codexThreadId: 'cx-f', codexHomeName: 'sweep-f', adapter: { ...reconnecting(async () => { waiting.suppressAutoRecover = true; markDead(waiting); return true }), surface: () => 'x' } as any })
    registry.set(first.sessionId, first)
    registry.set(waiting.sessionId, waiting)
    await reconnectCodexSessions([first, waiting])
    expect(waiting.deadAt).toBeNumber()
    expect(surfaced).toBe(0)
    expect(threadRegistry.get('th-w')!.sessionHistory[0].endedAt).toBeNumber()
  })

  test('a late disconnect does not bring back a record whose end was deliberate', async () => {
    let tried = 0
    const info = recordOf('s-k', 'th-k', { engine: 'codex', codexThreadId: 'cx', codexHomeName: 'k', deadAt: 5, suppressAutoRecover: true, adapter: { ...reconnecting(async () => { tried++; return true }), surface: () => 'x' } as any })
    const ok = await reconnectCodexAfterDisconnect('s-k', { get: () => info, wait: async () => {}, persist: () => {}, failed: () => {} })
    expect(ok).toBe(false)
    expect(tried).toBe(0)
    expect(info.deadAt).toBe(5)
  })
})
