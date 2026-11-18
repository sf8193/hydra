// `list_sessions` with include_ended and `hydra list --ended`: the sessions that have ended, read off the thread history. Read-only,
// bounded (a window and a count), one per thread, and never a thread somebody is home in.
import { describe, test, expect, afterEach } from 'bun:test'
import { threadRegistry, registry, type ThreadMetadata } from '../sessions.js'
import { endedSessions, endedWithinDays, ENDED_LIMIT } from '../ended-sessions.js'
import { handleCLIRequest } from '../cli-handler.js'
import { executeTool } from '../bridge-dispatch.js'
import { transport } from '../bridge-transport.js'
import { fakeAdapter } from './test-harness.js'

process.stderr.write = (() => true) as any

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18, 12)
const thread = (id: string, over: Partial<ThreadMetadata> & { name?: string; endedAt?: number | null } = {}): ThreadMetadata => ({
  threadId: id, topic: over.topic ?? `topic of ${id}`, ...(over.description && { description: over.description }), threadUrl: `https://chat.example/t/${id}`,
  respawnCount: 0, createdAt: NOW - 30 * DAY, lastActive: NOW - DAY, totalMessages: over.totalMessages ?? 7,
  sessionHistory: [{ sessionId: `s-${id}`, tmuxName: over.name ?? `n-${id}`, originType: 'spawn', startedAt: NOW - 20 * DAY, ...(over.endedAt !== null && { endedAt: over.endedAt ?? NOW - 2 * DAY }), messageCount: 7 }],
})

const added: string[] = []
afterEach(() => {
  for (const id of added.splice(0)) { threadRegistry.threads.delete(id); registry.delete(`live-${id}`); transport.bridges.delete(`live-${id}`) }
})
const put = (t: ThreadMetadata) => { threadRegistry.threads.set(t.threadId, t); added.push(t.threadId); return t }

describe('endedSessions', () => {
  test('the newest ended session of each thread, newest end first, with what a router needs to choose: name, description, thread id, url, when', () => {
    const a = put(thread('9100', { name: 'ledger', description: 'reconciles the ledger', endedAt: NOW - 3 * DAY }))
    const b = put(thread('9101', { name: 'billing', endedAt: NOW - DAY }))
    const out = endedSessions(14, NOW, [a, b])
    expect(out.map(x => x.name)).toEqual(['billing', 'ledger'])
    expect(out[1]).toEqual({ name: 'ledger', description: 'reconciles the ledger', thread_id: '9100', url: 'https://chat.example/t/9100', status: 'ended', ended_at: new Date(NOW - 3 * DAY).toISOString(), ended_ago: '3d', messages: 7 })
    expect(out[0].description).toBe('topic of 9101')   // no description: the first line of the topic, as for a live session
  })

  test('only within the window; not a thread whose latest session has not ended; not a thread somebody is home in', () => {
    const old = put(thread('9110', { endedAt: NOW - 20 * DAY }))
    const open = put(thread('9111', { endedAt: null }))
    const homed = put(thread('9112'))
    registry.set('live-9112', { sessionId: 'live-9112', tmuxName: 'live-9112', threadId: '9112', sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), adapter: fakeAdapter() } as any)
    transport.bridges.set('live-9112', {} as any)
    const fresh = put(thread('9113', { endedAt: NOW - 13 * DAY }))
    const out = endedSessions(14, NOW, [old, open, homed, fresh])
    expect(out.map(x => x.thread_id)).toEqual(['9113'])
    expect(endedSessions(30, NOW, [old, open, homed, fresh]).map(x => x.thread_id)).toEqual(['9113', '9110'])
  })

  test('at most ENDED_LIMIT, the newest; and the window must be a whole number of days from 1 to 90', () => {
    const many = Array.from({ length: ENDED_LIMIT + 5 }, (_, i) => thread(`92${String(i).padStart(2, '0')}`, { endedAt: NOW - (i + 1) * 60_000 }))
    const out = endedSessions(14, NOW, many)
    expect(out).toHaveLength(ENDED_LIMIT)
    expect(out[0].thread_id).toBe('9200')
    expect(endedWithinDays(undefined)).toBe(14)
    expect(endedWithinDays(90)).toBe(90)
    for (const bad of [0, 91, 1.5, '7', NaN]) expect(() => endedWithinDays(bad)).toThrow('whole number from 1 to 90')
  })

  test('it only reads: the history is as it was', () => {
    const a = put(thread('9120'))
    const before = JSON.stringify(a)
    endedSessions(14, NOW, [a])
    expect(JSON.stringify(a)).toBe(before)
  })
})

describe('list_sessions and hydra list', () => {
  const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text

  test('without include_ended the answer is what it was; with it, ended sessions follow the live ones', async () => {
    put(thread('9130', { name: 'ended-fixture-gone', endedAt: Date.now() - 2 * DAY }))
    const plain = JSON.parse(textOf(await executeTool('list_sessions', {}, 'main'))) as { name: string }[]
    expect(plain.map(x => x.name)).not.toContain('ended-fixture-gone')
    const withEnded = JSON.parse(textOf(await executeTool('list_sessions', { include_ended: true }, 'main'))) as { name: string; status: string; thread_id: string }[]
    expect(withEnded.find(x => x.name === 'ended-fixture-gone')).toMatchObject({ status: 'ended', thread_id: '9130' })
    const narrow = JSON.parse(textOf(await executeTool('list_sessions', { include_ended: true, ended_within_days: 1 }, 'main'))) as { name: string }[]
    expect(narrow.map(x => x.name)).not.toContain('ended-fixture-gone')
  })

  test('the CLI: --ended appends them; a bad window is an error; a dead record already listed is not listed twice', async () => {
    put(thread('9150', { name: 'ended-fixture-cli', endedAt: Date.now() - DAY }))
    const res = (params: Record<string, unknown>) => handleCLIRequest({ type: 'cli', command: 'list', id: 'l1', params })
    const plain = await res({})
    expect((plain.data as { name: string }[]).map(x => x.name)).not.toContain('ended-fixture-cli')
    const ended = await res({ ended: true })
    expect((ended.data as { name: string; status: string }[]).find(x => x.name === 'ended-fixture-cli')?.status).toBe('ended')
    // A record that died but is still in the registry is already listed: it is not listed again as ended.
    put(thread('9160', { name: 'ended-fixture-dead', endedAt: Date.now() - DAY }))
    registry.set('live-9160', { sessionId: 'live-9160', tmuxName: 'ended-fixture-dead', threadId: '9160', sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() - 2 * DAY, deadAt: Date.now() - DAY, adapter: fakeAdapter({ usage: () => undefined }) } as any)
    const againRes = await res({ ended: true })
    expect(againRes.ok, String(againRes.error)).toBe(true)
    const again = againRes.data as { name: string; status: string }[]
    expect(again.filter(x => x.name === 'ended-fixture-dead')).toHaveLength(1)
    const bad = await res({ ended: true, withinDays: 400 })
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toContain('whole number from 1 to 90')
  })
})
