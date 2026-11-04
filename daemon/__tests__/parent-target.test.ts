import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { executeTool } from '../bridge-dispatch.js'
import { killSession } from '../session-lifecycle.js'

process.stderr.write = (() => true) as any

const old = Date.now() - 60_000
const mk = (id: string, name: string, over: Partial<SessionInfo> = {}): SessionInfo => {
  const info = {
    sessionId: id, tmuxName: name, topic: 't', threadId: `${id}-thread`, createdAt: old, lastActive: Date.now(),
    listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner', ...over,
  } as SessionInfo
  registry.set(id, info)
  return info
}

const sent: string[] = []
const delivered: { to: string; content: string }[] = []
const saved = { send: gateway.send, sendOrQueue: transport.sendOrQueue }

beforeEach(() => {
  sent.length = 0; delivered.length = 0
  ;(gateway as any).send = async (channel: string) => { sent.push(channel); return { id: 'm', channelId: channel } }
  ;(transport as any).sendOrQueue = (to: string, msg: { content: string }) => { delivered.push({ to, content: msg.content }) }
})
afterEach(() => {
  ;(gateway as any).send = saved.send
  ;(transport as any).sendOrQueue = saved.sendOrQueue
  for (const s of [...registry.values()]) if (s.sessionId.startsWith('hd-')) registry.delete(s.sessionId)
})

const send = (from: string, target: string, type = 'result', extra: Record<string, unknown> = {}) =>
  executeTool('send_to_thread', { target, type, text: 'answer', ...extra }, from)
const errText = (r: any) => (r.content[0] as { text: string }).text

test('target="parent" resolves the caller\'s parent by id; errors with no parent or an ended one', async () => {
  mk('hd-parent', 'hdparent')
  mk('hd-imposter', 'hdparent2')
  mk('hd-child', 'hdchild', { parentId: 'hd-parent', initiator: 'hdparent2' })
  expect((await send('hd-child', 'parent', 'progress')).isError).toBeFalsy()
  expect(sent).toEqual(['hd-parent-thread'])
  expect(delivered.map(d => d.to)).toEqual(['hd-parent'])

  mk('hd-orphan', 'hdorphan', { parentId: null })
  expect(errText(await send('hd-orphan', 'parent'))).toContain('has no parent session')
  registry.get('hd-parent')!.deadAt = Date.now()
  expect(errText(await send('hd-child', 'parent'))).toContain('has ended')
})

test('a child\'s death is posted to its parent\'s thread', async () => {
  mk('hd-parent', 'hdparent')
  const child = mk('hd-dead', 'hddead', { parentId: 'hd-parent', originType: 'fork', originFrom: 'hdsrc' })
  await killSession(child, 'phase budget expired')
  expect(sent).toContain('hd-parent-thread')
})
