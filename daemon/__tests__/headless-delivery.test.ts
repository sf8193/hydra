import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { ANSWERED_KILL_DELAY_MS, answeredIO, executeTool } from '../bridge-dispatch.js'
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
const killed: { id: string; reason: string }[] = []
const saved = { send: gateway.send, sendOrQueue: transport.sendOrQueue, kill: answeredIO.killSession }

beforeEach(() => {
  sent.length = 0; delivered.length = 0; killed.length = 0
  ;(gateway as any).send = async (channel: string) => { sent.push(channel); return { id: 'm', channelId: channel } }
  ;(transport as any).sendOrQueue = (to: string, msg: { content: string }) => { delivered.push({ to, content: msg.content }) }
  answeredIO.killSession = (async (i: SessionInfo, reason: string) => { killed.push({ id: i.sessionId, reason }) }) as any
})
afterEach(() => {
  ;(gateway as any).send = saved.send
  ;(transport as any).sendOrQueue = saved.sendOrQueue
  answeredIO.killSession = saved.kill
  for (const s of [...registry.values()]) if (s.sessionId.startsWith('hd-')) registry.delete(s.sessionId)
})

const send = (from: string, target: string, type = 'result', extra: Record<string, unknown> = {}) =>
  executeTool('send_to_thread', { target, type, text: 'answer', ...extra }, from)
const errText = (r: any) => (r.content[0] as { text: string }).text

test('a public result to a headless parent is delivered privately — no gateway send', async () => {
  const parent = mk('hd-parent', 'hdparent', { headless: true })
  parent.threadId = parent.sessionId  // a headless session's threadId is synthetic
  mk('hd-child', 'hdchild', { parentId: 'hd-parent', headless: true })
  const r = await send('hd-child', 'hdparent')
  expect(r.isError).toBeFalsy()
  expect(sent).toEqual([])
  expect(delivered.map(d => d.to)).toEqual(['hd-parent'])
  expect(errText(r)).toContain('headless, so delivered privately')
})

test('a headless target refuses sessions that are not its children, and questions', async () => {
  mk('hd-parent', 'hdparent', { headless: true })
  mk('hd-child', 'hdchild', { parentId: 'hd-parent' })
  mk('hd-stranger', 'hdstranger', { parentId: null })
  expect(errText(await send('hd-stranger', 'hdparent'))).toContain('only be reached privately by its own child sessions')
  expect(errText(await send('hd-child', 'hdparent', 'question'))).toContain('progress and result only')
  expect(sent).toEqual([])
  expect(delivered).toEqual([])
})

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

test('an answer-once fork is ended after its first delivered result — not before, and only once', async () => {
  mk('hd-parent', 'hdparent')
  mk('hd-fork', 'hdfork', { parentId: 'hd-parent', headless: true, answerOnce: true })
  await send('hd-fork', 'parent', 'progress')
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toEqual([])
  const r = await send('hd-fork', 'parent')
  expect(r.isError).toBeFalsy()
  expect(killed).toEqual([])  // the tool call answers before the session is ended
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toEqual([{ id: 'hd-fork', reason: 'answered' }])
  await send('hd-fork', 'parent')
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toHaveLength(1)
})

test('a record replaced inside the delay (resume, recovery) is not ended by the old record\'s timer', async () => {
  mk('hd-parent', 'hdparent')
  mk('hd-fork', 'hdfork', { parentId: 'hd-parent', headless: true, answerOnce: true })
  expect((await send('hd-fork', 'parent')).isError).toBeFalsy()
  mk('hd-fork', 'hdfork', { parentId: 'hd-parent', headless: true, answerOnce: true })
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toEqual([])
})

test('an answer-once fork answering a headless parent (the private path) is ended too', async () => {
  mk('hd-parent', 'hdparent', { headless: true })
  mk('hd-fork', 'hdfork', { parentId: 'hd-parent', headless: true, answerOnce: true })
  expect((await send('hd-fork', 'parent')).isError).toBeFalsy()
  expect(sent).toEqual([])
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toEqual([{ id: 'hd-fork', reason: 'answered' }])
})

test('a headless session that is not answer-once is not ended by its result', async () => {
  mk('hd-parent', 'hdparent')
  mk('hd-worker', 'hdworker', { parentId: 'hd-parent', headless: true })
  expect((await send('hd-worker', 'parent')).isError).toBeFalsy()
  await Bun.sleep(ANSWERED_KILL_DELAY_MS + 100)
  expect(killed).toEqual([])
})

test('reply and fetch_messages on a headless session\'s synthetic thread say so', async () => {
  const h = mk('hd-ghost', 'hdghost', { headless: true })
  h.threadId = h.sessionId
  expect(errText(await executeTool('reply', { chat_id: 'hd-ghost', text: 'x' }, 'hd-ghost'))).toContain('headless sessions have no thread')
  expect(errText(await executeTool('fetch_messages', { channel: 'hd-ghost' }, 'hd-ghost'))).toContain('headless sessions have no thread')
})

describe('the death notice from killSession', () => {
  // A distinct id per kill: killSession ignores an id it killed in the last 3s.
  let n = 0
  const fork = (parentId: string) =>
    mk(`hd-dead-${++n}`, `hddead${n}`, { parentId, originType: 'fork', originFrom: 'hdsrc', headless: true, answerOnce: true })

  test('an answered fork sends no death notice, to a threaded or a headless parent', async () => {
    mk('hd-parent', 'hdparent')
    await killSession(fork('hd-parent'), 'answered')
    const ghost = mk('hd-ghost', 'hdghost', { headless: true })
    ghost.threadId = ghost.sessionId
    await killSession(fork('hd-ghost'), 'answered')
    expect(sent).toEqual([])
  })

  test('a real death with a headless parent posts nothing to its synthetic thread', async () => {
    const ghost = mk('hd-ghost', 'hdghost', { headless: true })
    ghost.threadId = ghost.sessionId
    await killSession(fork('hd-ghost'), 'phase budget expired')
    expect(sent).toEqual([])
  })

  test('a real death with a threaded parent is still posted there', async () => {
    mk('hd-parent', 'hdparent')
    await killSession(fork('hd-parent'), 'phase budget expired')
    expect(sent).toEqual(['hd-parent-thread'])
  })
})
