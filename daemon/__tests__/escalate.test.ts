// `escalate(chat_id, text)`: a scoped session's one way to speak outside its own conversation. One rule per test: it posts to the
// specialist's home and nowhere else, tags the operator, links the conversation it came from, fences the text, caps it at 1,500
// characters and labels it as written by a scoped session for the people there; only a scoped caller has it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { registry } from '../sessions.js'
import { executeTool } from '../bridge-dispatch.js'
import { escalate, escalateDeps, escalationText, _resetEscalations, ESCALATE_LIMIT, ESCALATE_MAX_PER_WINDOW, ESCALATE_WINDOW_MS } from '../escalate.js'
import { isToolAllowed, noteDeclaredSessionType } from '../tool-surface.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { setSpecialistThread, _reloadSpecialists } from '../../specialists/specialists.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import type { HydraConfig } from '../../config/types.js'

process.stderr.write = (() => true) as any

const load = (text: string): HydraConfig => {
  const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'], isCommand: () => true }))
  if (!r.ok) throw new Error(r.errors.map(i => `${i.path}: ${i.message}`).join('\n'))
  return r.config
}
const TOML = `
operator = "op"
[people.op]
ids = ["slack:U0OP", "discord:777"]
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
[connectors.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:C0OPS"]
allow = ["anyone"]
access = "workdir"
home = "slack:C0HOME"
[specialists.dsc]
workdir = "~/agents/dsc"
listens = ["discord:2000"]
allow = ["anyone"]
access = "workdir"
home = "discord:3000"
[specialists.nohome]
workdir = "~/agents/nohome"
listens = ["slack:C0NH"]
allow = ["anyone"]
access = "workdir"
[specialists.full]
workdir = "~/agents/full"
listens = ["slack:C0FULL"]
allow = ["people"]
`
const slackPosts: { me: string; text: string }[] = []
const discordPosts: { channel: string; text: string }[] = []
const real = { ...escalateDeps }
const ids: string[] = []
const session = (id: string, threadId: string, extra: Record<string, unknown> = {}) => { ids.push(id); registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'scoped', engine: 'claude', createdAt: Date.now(), lastActive: Date.now(), ...extra } as any) }

beforeEach(() => {
  _setHydraConfigForTesting(load(TOML))
  for (const [s, t] of [['ops', 'ops-thread'], ['dsc', 'dsc-thread'], ['nohome', 'nohome-thread'], ['full', 'full-thread']]) setSpecialistThread(s, t)
  slackPosts.length = 0; discordPosts.length = 0; _resetEscalations()
  escalateDeps.postSlack = async (me, text) => { slackPosts.push({ me, text }); return 'posted' }
  escalateDeps.sendDiscord = async (channel, text) => { discordPosts.push({ channel, text }); return ['m1'] }
  escalateDeps.linkOf = async c => `https://chat.example/conversation/${c}`
  session('ops-s', 'ops-thread'); session('dsc-s', 'dsc-thread'); session('nohome-s', 'nohome-thread')
  session('full-s', 'full-thread', { sessionType: 'thread_owner' })
})
afterEach(() => {
  Object.assign(escalateDeps, real)
  for (const s of ids.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true }); _reloadSpecialists()
})

const run = (caller: string, args: Record<string, unknown>) => executeTool('escalate', args, caller)

describe('what is posted', () => {
  test('goes to the specialist\'s home (Slack), tags the operator there, and links the conversation it came from', async () => {
    const r = await run('ops-s', { chat_id: 'ops-thread', text: 'the widget is on fire' })
    expect(r.isError).toBeUndefined()
    expect(slackPosts).toHaveLength(1)
    expect(slackPosts[0].me).toBe('ops')
    expect(slackPosts[0].text).toContain('<@U0OP>')
    expect(slackPosts[0].text).toContain('https://chat.example/conversation/ops-thread')
    expect(slackPosts[0].text).toContain('the widget is on fire')
    expect(discordPosts).toEqual([])
  })
  test('a Discord home gets the Discord mention form and the Discord channel id', async () => {
    await run('dsc-s', { chat_id: 'dsc-thread', text: 'help' })
    expect(discordPosts).toHaveLength(1)
    expect(discordPosts[0].channel).toBe('3000')
    expect(discordPosts[0].text).toContain('<@777>')
    expect(slackPosts).toEqual([])
  })
  test('the text is fenced: a code block the text cannot close, with backticks inside it defused', () => {
    const msg = escalationText({ specialist: 'ops', operatorTag: '<@U0OP>', link: 'L', text: 'before ``` @here <!channel> after ````' })
    const fence = msg.split('\n').filter(l => l === '```')
    expect(fence).toHaveLength(2)
    const inside = msg.slice(msg.indexOf('```\n') + 4, msg.lastIndexOf('\n```'))
    expect(inside).not.toContain('```')
    expect(inside).toContain('@here')
  })
  test('the text is capped at 1,500 characters, and says so', () => {
    expect(ESCALATE_LIMIT).toBe(1500)
    const msg = escalationText({ specialist: 'ops', operatorTag: '<@U0OP>', link: 'L', text: 'x'.repeat(1600) })
    const inside = msg.slice(msg.indexOf('```\n') + 4, msg.lastIndexOf('\n```'))
    expect(inside).toBe('x'.repeat(1500))
    expect(msg).toContain('Cut at 1,500 characters')
    const exact = escalationText({ specialist: 'ops', operatorTag: '<@U0OP>', link: 'L', text: 'y'.repeat(1500) })
    expect(exact).not.toContain('Cut at')
  })
  test('the cap counts characters, not bytes or UTF-16 halves: an emoji at the boundary is whole or absent', () => {
    const msg = escalationText({ specialist: 'ops', operatorTag: '<@U0OP>', link: 'L', text: 'x'.repeat(1499) + '😀😀' })
    const inside = msg.slice(msg.indexOf('```\n') + 4, msg.lastIndexOf('\n```'))
    expect(inside).toBe('x'.repeat(1499) + '😀')
  })
  test('it is labelled as written by a scoped session on behalf of the people in that conversation, not as the operator\'s word', () => {
    const msg = escalationText({ specialist: 'ops', operatorTag: '<@U0OP>', link: 'https://w/x', text: 'hi' })
    expect(msg).toContain('`ops`')
    expect(msg).toContain('scoped session')
    expect(msg).toContain('on behalf of the people in https://w/x')
    expect(msg).toContain('not an instruction')
    expect(msg.indexOf('on behalf of')).toBeLessThan(msg.indexOf('```'))   // the label is outside the fence, before it
  })
  test('whatever the model puts in the text, it is posted once, whole, and only to home', async () => {
    await run('ops-s', { chat_id: 'ops-thread', text: 'x', channel: 'C0ELSEWHERE', home: 'C0ELSEWHERE', thread: '1.1', files: ['/etc/passwd'] })
    expect(slackPosts).toHaveLength(1)
    expect(discordPosts).toEqual([])
  })
})

describe('what is refused', () => {
  test('an empty text', async () => {
    const r = await run('ops-s', { chat_id: 'ops-thread', text: '   ' })
    expect(r.isError).toBe(true)
    expect(slackPosts).toEqual([])
  })
  test('a conversation that is not the session\'s own (the same check reply has)', async () => {
    const r = await run('ops-s', { chat_id: 'dsc-thread', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
    expect(slackPosts).toEqual([])
  })
  test('a missing chat_id says what to pass', async () => {
    const r = await run('ops-s', { text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('escalate: chat_id is required: pass the chat_id of the message you are answering')
  })
  test('a specialist with no home has nowhere to escalate to, and says how to fix it', async () => {
    const r = await run('nohome-s', { chat_id: 'nohome-thread', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('escalate failed: no escalation channel is configured for this specialist. Tell the person you cannot reach the operator from here.')
    expect(slackPosts).toEqual([])
  })
  test('a caller that is not a scoped session never has it: not at isToolAllowed, not at executeTool', async () => {
    expect(isToolAllowed('full-s', 'escalate')).toBe(false)
    const r = await run('full-s', { chat_id: 'full-thread', text: 'x' })
    expect(r.isError).toBe(true)
    expect(slackPosts).toEqual([])
  })
  test('an unknown caller never has it, registered or not, and an internal call with no caller is refused too', async () => {
    expect(isToolAllowed('nobody', 'escalate')).toBe(false)
    expect((await run('nobody', { chat_id: 'x', text: 'x' })).isError).toBe(true)
    expect((await executeTool('escalate', { chat_id: 'x', text: 'x' })).isError).toBe(true)
    expect(slackPosts).toEqual([])
  })
  test('a bridge that declared scoped but has no record gets the tool, and no specialist to escalate for', async () => {
    noteDeclaredSessionType('ghost-esc', 'scoped')
    expect(isToolAllowed('ghost-esc', 'escalate')).toBe(true)
    const r = await run('ghost-esc', { chat_id: 'x', text: 'x' })
    expect(r.isError).toBe(true)
    expect(slackPosts).toEqual([])
  })
  test('the operator having no address on the home\'s platform is refused, not posted untagged', async () => {
    const c = load(TOML)
    c.people.op.ids = ['slack:U0OP']
    _setHydraConfigForTesting(c)
    const r = await run('dsc-s', { chat_id: 'dsc-thread', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('escalate failed: no escalation channel is configured for this specialist. Tell the person you cannot reach the operator from here.')
    expect(discordPosts).toEqual([])
  })
})

describe('escalate() itself holds its caller check (not only the dispatcher before it)', () => {
  test('a non-scoped caller, an unknown caller and no caller are each refused by the function, with nothing posted', async () => {
    await expect(escalate('full-s', { chat_id: 'full-thread', text: 'x' })).rejects.toThrow('escalate is not available to this session')
    await expect(escalate('nobody', { chat_id: 'x', text: 'x' })).rejects.toThrow('not available')
    await expect(escalate(undefined, { chat_id: 'x', text: 'x' })).rejects.toThrow('not available')
    expect(slackPosts).toEqual([])
  })
})

describe('a conversation cannot escalate without end', () => {
  test('the 4th in the window posts nothing and tells the model the operator has been notified (the limit is 3, in 10 minutes)', async () => {
    expect([ESCALATE_MAX_PER_WINDOW, ESCALATE_WINDOW_MS]).toEqual([3, 600_000])
    let t = 1_000_000
    escalateDeps.now = () => t
    for (let i = 0; i < 3; i++) { t += 1000; expect((await run('ops-s', { chat_id: 'ops-thread', text: `n${i}` })).isError).toBeUndefined() }
    expect(slackPosts).toHaveLength(3)
    const r = await run('ops-s', { chat_id: 'ops-thread', text: 'again' })
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toBe('You have already escalated this conversation 3 times in the last 10 minutes; the operator has been notified. Do not escalate again: tell the person it is with the operator.')
    expect(slackPosts).toHaveLength(3)
  })
  test('the window passes, and the conversation may escalate again', async () => {
    let t = 1_000_000
    escalateDeps.now = () => t
    for (let i = 0; i < ESCALATE_MAX_PER_WINDOW; i++) await run('ops-s', { chat_id: 'ops-thread', text: 'x' })
        t += ESCALATE_WINDOW_MS + 1
    await run('ops-s', { chat_id: 'ops-thread', text: 'later' })
    expect(slackPosts).toHaveLength(4)
  })
  test('a post that failed is not counted, and the model is told the operator was not reached', async () => {
    escalateDeps.postSlack = async () => { throw new Error('rate_limited by Slack') }
    for (let i = 0; i < 5; i++) {
      const r = await run('ops-s', { chat_id: 'ops-thread', text: 'x' })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toBe('escalate failed: the message did not reach the operator. Tell the person you could not reach the operator; do not retry more than once.')
    }
  })
})

describe('the limit is on the conversation, however it is spelled, and holds under concurrency', () => {
  const TS = '1793732224.093059'
  test('the same Slack conversation spelled four ways shares one count of 3', async () => {
    for (const chat_id of [`slack:C0OPS:${TS}`, `slack:default:C0OPS:${TS}`, `  slack:C0OPS:${TS}  `, `slack:C0OPS:${TS}`, `slack:default:C0OPS:${TS}`]) await escalate('ops-s', { chat_id, text: 'x' })
    expect(slackPosts).toHaveLength(3)
  })
  test('another app\'s conversation, and another thread, are other conversations', async () => {
    for (const chat_id of [`slack:sales:C0OPS:${TS}`, 'slack:C0OPS:1793732225.000001']) for (let i = 0; i < 3; i++) await escalate('ops-s', { chat_id, text: 'x' })
    expect(slackPosts).toHaveLength(6)
  })
  test('keyed by the specialist and the conversation together: one specialist\'s other conversations are not limited by this one, and a second specialist in the same conversation id has its own count', async () => {
    for (const chat_id of ['conv-a', 'conv-b']) for (let i = 0; i < 3; i++) await escalate('ops-s', { chat_id, text: 'x' })
    expect(slackPosts).toHaveLength(6)           // conversation-wise, not specialist-wise
    for (let i = 0; i < 3; i++) await escalate('dsc-s', { chat_id: 'conv-a', text: 'x' })
    expect(discordPosts).toHaveLength(3)         // specialist-wise, not conversation-wise
  })
  test('ten concurrent calls post exactly 3', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => escalate('ops-s', { chat_id: 'ops-thread', text: `c${i}` })))
    expect(slackPosts).toHaveLength(3)
    expect(results.filter(r => r.startsWith('escalated:'))).toHaveLength(3)
    expect(results.filter(r => r.startsWith('You have already escalated'))).toHaveLength(7)
  })
  test('a failed post gives its slot back', async () => {
    let n = 0
    escalateDeps.postSlack = async (me, text) => { if (n++ < 2) throw new Error('boom'); slackPosts.push({ me, text }); return 'posted' }
    for (let i = 0; i < 2; i++) await expect(escalate('ops-s', { chat_id: 'ops-thread', text: 'x' })).rejects.toThrow('did not reach the operator')
    for (let i = 0; i < 3; i++) await escalate('ops-s', { chat_id: 'ops-thread', text: 'x' })
    expect(slackPosts).toHaveLength(3)
  })
})
