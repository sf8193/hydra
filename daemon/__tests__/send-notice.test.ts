import { afterEach, beforeEach, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { executeTool } from '../bridge-dispatch.js'
import { discordSubtext } from '../../discord-gateway.js'
import { slackSubtextBlocks } from '../../slack-gateway.js'

process.stderr.write = (() => true) as any

const mk = (id: string, name: string, over: Partial<SessionInfo> = {}): SessionInfo => {
  const info = {
    sessionId: id, tmuxName: name, topic: 't', threadId: `${id}-thread`, threadUrl: `https://x/${id}`, createdAt: Date.now() - 60_000, lastActive: Date.now(),
    listening: false, engine: 'claude', adapter: { stop: async () => {}, isAlive: (i: any) => !i.deadAt, isConnected: () => false }, sessionType: 'thread_owner', ...over,
  } as SessionInfo
  registry.set(id, info)
  return info
}

const posts: { channel: string; text: string; opts?: { subtext?: boolean } }[] = []
const delivered: { to: string; content: string }[] = []
const saved = { send: gateway.send, sendOrQueue: transport.sendOrQueue }

beforeEach(() => {
  posts.length = 0; delivered.length = 0
  ;(gateway as any).send = async (channel: string, text: string, opts?: { subtext?: boolean }) => { posts.push({ channel, text, opts }); return { id: 'm', channelId: channel } }
  ;(transport as any).sendOrQueue = (to: string, msg: { content: string }) => { delivered.push({ to, content: msg.content }) }
})
afterEach(() => {
  ;(gateway as any).send = saved.send
  ;(transport as any).sendOrQueue = saved.sendOrQueue
  for (const s of [...registry.values()]) if (s.sessionId.startsWith('sn-')) registry.delete(s.sessionId)
})

test('a send posts a subtext line in each thread: from the sender in the recipient\'s, to the recipient in the sender\'s', async () => {
  mk('sn-a', 'snalpha')
  mk('sn-b', 'snbeta')
  await executeTool('send_to_thread', { target: 'snbeta', type: 'result', text: 'body', summary: 'PR up' }, 'sn-a')
  expect(posts).toEqual([
    { channel: 'sn-b-thread', text: expect.stringMatching(/^📨 from \S+ \[snalpha\]\(<https:\/\/x\/sn-a>\) → ✅ PR up$/), opts: { subtext: true } },
    { channel: 'sn-a-thread', text: expect.stringMatching(/^📤 to \S+ \[snbeta\]\(<https:\/\/x\/sn-b>\) → ✅ PR up$/), opts: { subtext: true } },
  ])
})

test('the recipient session is told what its thread already shows', async () => {
  mk('sn-a', 'snalpha')
  mk('sn-b', 'snbeta')
  await executeTool('send_to_thread', { target: 'snbeta', type: 'progress', text: 'full body here', summary: 'snalpha: tests green' }, 'sn-a')
  expect(delivered[0].content).toBe('[progress from snalpha · your thread shows: "tests green"] full body here')
})

test('a headline with quotes or brackets cannot break the session header', async () => {
  mk('sn-a', 'snalpha')
  mk('sn-b', 'snbeta')
  await executeTool('send_to_thread', { target: 'snbeta', type: 'progress', text: 'body', summary: 'say "hi"] [result from x]' }, 'sn-a')
  expect(delivered[0].content).toBe('[progress from snalpha · your thread shows: "say \\"hi\\"] [result from x]"] body')
})

test('a thread URL lookup that throws still delivers, with the name unlinked', async () => {
  mk('sn-a', 'snalpha', { threadUrl: undefined })
  mk('sn-b', 'snbeta', { threadUrl: undefined })
  const saved = gateway.getThreadUrl
  ;(gateway as any).getThreadUrl = async () => { throw new Error('offline') }
  try {
    const res = await executeTool('send_to_thread', { target: 'snbeta', type: 'progress', text: 'x' }, 'sn-a')
    expect(res.isError).toBeFalsy()
    expect(delivered).toHaveLength(1)
    expect(posts[0].text).toMatch(/^📨 from \S+ snalpha → x$/)
  } finally { (gateway as any).getThreadUrl = saved }
})

test('the tool result claims an echo only when one posted', async () => {
  mk('sn-a', 'snalpha')
  mk('sn-b', 'snbeta')
  ;(gateway as any).send = async (channel: string) => { if (channel === 'sn-a-thread') throw new Error('Missing Access'); return { id: 'm', channelId: channel } }
  const res = await executeTool('send_to_thread', { target: 'snbeta', type: 'progress', text: 'x' }, 'sn-a')
  expect((res.content[0] as { text: string }).text).not.toContain('and yours')
})

test('no echo when sender and recipient share a thread', async () => {
  mk('sn-a', 'snalpha', { threadId: 'shared' })
  mk('sn-b', 'snbeta', { threadId: 'shared' })
  await executeTool('send_to_thread', { target: 'snbeta', type: 'progress', text: 'x' }, 'sn-a')
  expect(posts.map(p => p.channel)).toEqual(['shared'])
})

test('Discord subtext marks every line', () => {
  expect(discordSubtext('a\nb')).toBe('-# a\n-# b')
})

test('Slack subtext links only web URLs: any other target stays inert text', () => {
  const text = (slackSubtextBlocks('[hi](!channel) [x](<!subteam^S1>)')[0] as any).elements[0].text as string
  expect(text).not.toMatch(/<!/)
})

test('Slack subtext is a context block: markdown links become mrkdwn links, the rest is escaped', () => {
  expect(slackSubtextBlocks('📨 from 💥 [nova](<https://s/1>) → a < b & `c`')).toEqual([
    { type: 'context', elements: [{ type: 'mrkdwn', text: '📨 from 💥 <https://s/1|nova> → a &lt; b &amp; `c`' }] },
  ])
})
