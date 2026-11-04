import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { executeTool } from '../bridge-dispatch.js'
import * as access from '../access.js'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'

const SID = 'hsw-owner'
let spies: { mockRestore(): void }[] = []

beforeEach(() => {
  process.stderr.write = (() => true) as any
  registry.set(SID, {
    sessionId: SID, tmuxName: SID, topic: '', threadId: 'hsw-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner',
  } as any)
  spies = [
    spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'm1' })) as any),
    spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => ({ id, isThread: true, parentId: 'hsw-parent' })) as any),
    spyOn(access, 'loadAccess').mockImplementation((() => ({ allowFrom: ['u1'], groups: { 'hsw-parent': {} }, pending: {} })) as any),
  ]
})

afterEach(() => {
  registry.delete(SID)
  for (const s of spies) s.mockRestore()
})

describe('your-turn writers', () => {
  test('a reply into the session’s own thread makes it your turn', async () => {
    const res = await executeTool('reply', { chat_id: 'hsw-thread', text: 'done' }, SID)
    expect(res.isError).toBeUndefined()
    expect(registry.get(SID)!.lastReplyAt).toBeGreaterThan(0)
  })

  test('a reply into another thread does not', async () => {
    const res = await executeTool('reply', { chat_id: 'hsw-elsewhere', text: 'fyi' }, SID)
    expect(res.isError).toBeUndefined()
    expect(registry.get(SID)!.lastReplyId).toBe('m1')
    expect(registry.get(SID)!.lastReplyAt).toBeUndefined()
  })
})
