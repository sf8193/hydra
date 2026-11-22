// A thread bound to a session's own thread (bind_conversation, or `hydra conversations bind … thread:<id>`) is that session's: a plain
// session speaks in it through the app that heard it, as the bot; a restricted or write-confined one only listens. Each delivery from such a
// thread says, per message, whether the app was tagged and who sent it (the operator, someone declared in [people], anyone else), and one
// hydra line on what that likely means. Speaking is the session's judgment: nothing in the rule reads the tag.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../../../infra/config.js'
import { registry } from '../../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { noteDeclaredRestrictions } from '../../../sessions/tool-surface.js'
import { executeTool } from '../../../app/bridge-dispatch.js'
import { setSpecialistThread } from '../../../sessions/specialists.js'
import { ConversationTable, boundSessionNote, boundSessionFacts, renderItem, type ConversationConfig, type Item, type SlackMessageEvent } from '../watch.js'
import { bindConversation, getConversationTable, replyInConversation, slackRuntimeDeps } from '../runtime.js'
import { BOT, TWO_APPS, hydra, view } from './slack-config.js'
import { DELIVER_MAX_MESSAGE_BYTES } from '../../../shared/constants.js'
import { LANDED } from './outcomes.js'
import type { DeliverOutcome } from '../../../specialists/targets.js'

process.stderr.write = (() => true) as any

const OP_TOKEN = (toml: string) => toml.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
const PEOPLE = '[people.alice]\naddresses = ["slack:UALICE"]\n'
const DESK = '[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\ntarget = "specialist:desk"\n'
const TOML = OP_TOKEN(`${TWO_APPS}${PEOPLE}${DESK}`)
const ELSEWHERE = 'C0ELSE'               // a channel no rule names: only a bind puts a thread here in anyone's hands
const MINE = '1552619225032425525'       // the thread of the session the conversation is bound to
const OTHER = '1552619225032425526'
const TS = '1000.000001'
const CONV = `slack:${ELSEWHERE}:${TS}`
const SALES_CONV = `slack:sales:${ELSEWHERE}:${TS}`

const ids: string[] = []
const session = (id: string, threadId: string, over: Record<string, unknown> = {}) => {
  ids.push(id)
  registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), ...over } as any)
}

describe("reply in a thread bound to a session's own thread", () => {
  const realPost = slackRuntimeDeps.post
  const realView = slackRuntimeDeps.view
  const posts: string[] = []
  /** `member`: the channels the bot is in; a post anywhere else is refused as Slack refuses it. A user id is that person's DM with the app. */
  const slack = (member = new Set([ELSEWHERE])) => {
    posts.length = 0
    slackRuntimeDeps.post = async (c, t, text, app) => {
      if (!c.startsWith('U') && !member.has(c)) throw new Error('An API error occurred: not_in_channel')
      posts.push(`${app ?? 'default'}|${c}|${t ?? '-'}|${text}`); return `${posts.length}.000001`
    }
  }
  const configure = (toml = TOML) => { _setHydraConfigForTesting(hydra(toml)); const v = view(toml); slackRuntimeDeps.view = () => v }
  beforeEach(() => { configure(); slack() })
  afterEach(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
    for (const id of ids.splice(0)) registry.delete(id)
    slackRuntimeDeps.post = realPost; slackRuntimeDeps.view = realView
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  })

  test('the plain session it is bound to posts there, as the bot of the app the conversation names', async () => {
    session('sw-mine', MINE)
    getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli', 'sales')
    expect(await replyInConversation('sw-mine', SALES_CONV, 'on it')).toBe(`posted 1 message to ${SALES_CONV}`)
    expect(posts).toEqual([`sales|${ELSEWHERE}|${TS}|on it`])
  })

  test('so does reply through the dispatcher, the path a session\'s tool call takes', async () => {
    session('sw-mine', MINE)
    getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli')
    const out = await executeTool('reply', { chat_id: CONV, text: 'looking' }, 'sw-mine')
    expect(out.content[0].text).toBe(`posted 1 message to ${CONV}`)
    expect(posts).toEqual([`default|${ELSEWHERE}|${TS}|looking`])
  })

  test('a session that bound the thread itself (bind_conversation) speaks there too', async () => {
    session('sw-mine', MINE)
    slackRuntimeDeps.readThread = async () => 'bot'
    const bound = await bindConversation({ threadId: MINE }, CONV)
    expect(bound).toContain('is bound to this session')
    expect(bound).toContain('Answer in it with reply')
    expect(await replyInConversation('sw-mine', CONV, 'hi')).toBe(`posted 1 message to ${CONV}`)
  })

  test('no one else posts there: main, another session, a specialist, a guest in that session\'s thread, or a caller with no record', async () => {
    session('sw-mine', MINE)
    session('sw-other', OTHER)
    session('sw-desk', 'desk-thread')
    setSpecialistThread('desk', 'desk-thread')
    session('sw-guest', MINE, { sessionType: 'thread_guest' })
    getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli')
    for (const caller of ['main', 'sw-other', 'sw-desk', 'sw-guest', 'sw-ghost']) {
      await expect(replyInConversation(caller, CONV, 'me too')).rejects.toThrow(`is bound to ${MINE}`)
    }
    expect(posts).toEqual([])
  })

  test('a restricted or write-confined session it is bound to only listens, by its record or by its bridge\'s declaration', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['sw-restricted', { policy: { restricted: true } }],
      ['sw-confined', { policy: { restricted: false, canOnlyWriteTo: ['/tmp/x'] } }],
      ['sw-declared', {}],
    ]
    noteDeclaredRestrictions('sw-declared', { restricted: true })
    for (const [id, over] of cases) {
      session(id, MINE, over)
      getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli')
      await expect(replyInConversation(id, CONV, 'hi')).rejects.toThrow('a restricted or write-confined session uses Slack only in a conversation bound to its specialist')
      registry.delete(id)
    }
    expect(posts).toEqual([])
  })

  test('where the bot is not in the channel, the answer goes to the operator\'s DM with the app, naming the session and linking the thread', async () => {
    session('sw-mine', MINE)
    getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli')
    slack(new Set())
    const out = await replyInConversation('sw-mine', CONV, 'on it')
    expect(out).toContain(`not posted to ${CONV}: the bot isn't in that channel`)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toStartWith('default|UOP|-|From sw-mine, not posted in https://x.slack.com/archives/C0ELSE/p1000000001: ')
    expect(posts[0]).toEndWith('on it')
  })
})

describe('a delivery to the session a thread is bound to: the facts per message, and one line on what they likely mean', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  /** `speaks`: whether the session in the thread is a plain one (the runtime's `speaksIn`). */
  function setup(speaks = true, toml = TOML) {
    const dir = mkdtempSync(join(tmpdir(), 'bound-'))
    dirs.push(dir)
    const sent: { to: string; msg: string }[] = []
    const config: ConversationConfig = view(toml, { coalesceMs: 1 })
    const w = new ConversationTable({
      now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {}, speaksIn: t => speaks && t === MINE,
      deliver: async ({ to }, msg): Promise<DeliverOutcome> => { sent.push({ to, msg }); return LANDED },
    })
    w.bind(ELSEWHERE, TS, MINE, 'cli')
    return { w, sent }
  }
  const ev = (ts: string, user: string, text: string): SlackMessageEvent => ({ channel: ELSEWHERE, ts, threadTs: TS, user, text })
  const tag = `<@${BOT}> can you look at this?`
  const ASKED = 'you are likely being asked. Answer in the thread (reply with the conversation above as chat_id) if it asks or needs something from you; a pure cc needs no reply.'
  const LISTENING = 'Stay quiet in Slack.'

  test.each([
    ['the operator', 'operator', 'UOP'],
    ['someone declared in [people]', 'approved', 'UALICE'],
  ] as const)('a tag from %s: tagged=true, from=%s, and the line says it likely asks', async (_who, from, user) => {
    const { w, sent } = setup()
    w.handle(ev('1001.000001', user, tag))
    await w.flush()
    expect(sent.map(s => s.to)).toEqual([MINE])
    expect(sent[0].msg).toContain(`tagged=true from=${from}]`)
    expect(sent[0].msg).toContain(`tagged hydra in ts=1001.000001: ${ASKED}`)
  })

  test('a tag from anyone else is for listening: tagged=true, from=other', async () => {
    const { w, sent } = setup()
    w.handle(ev('1001.000001', 'UNOBODY', tag))
    await w.flush()
    expect(sent[0].msg).toContain('tagged=true from=other]')
    expect(sent[0].msg).not.toContain(ASKED)
    expect(sent[0].msg).toContain(LISTENING)
  })

  test('the operator\'s untagged words are for listening: tagged=false, from=operator', async () => {
    const { w, sent } = setup()
    w.handle(ev('1001.000001', 'UOP', 'fyi, this is moving'))
    await w.flush()
    expect(sent[0].msg).toContain('tagged=false from=operator]')
    expect(sent[0].msg).toContain(`hydra: this Slack thread is bound to you, and you are listening: nothing here tags hydra from the operator or an approved person (from=operator or from=approved). ${LISTENING}`)
  })

  test('in one delivery of several, the line names the message that likely asks, and says the rest are for listening', async () => {
    const { w, sent } = setup()
    w.handle(ev('1001.000001', 'UNOBODY', 'chatter'))
    w.handle(ev('1002.000001', 'UOP', tag))
    await w.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].msg).toContain(`tagged hydra in ts=1002.000001: ${ASKED} The other messages here are for listening.`)
  })

  test('a delivery to a specialist is as before: no tagged=, from= or line for a bound session', async () => {
    const { w, sent } = setup()
    w.handle({ channel: 'C0DESK', ts: '2000.000001', user: 'UOP', text: tag })
    await w.flush()
    expect(sent.map(s => s.to)).toEqual(['desk'])
    expect(sent[0].msg).not.toContain('tagged=')
    expect(sent[0].msg).not.toContain('from=')
    expect(sent[0].msg).not.toContain('this Slack thread is bound to you')
  })

  test('only a tag asks: a DM\'s untagged message and a reaction are tagged=false, and for listening', () => {
    const base: Item = { ts: '1.000001', kind: 'dm', text: 'x', person: 'alice' }
    for (const kind of ['dm', 'reaction', 'follow-up'] as const) {
      const [i] = boundSessionFacts([{ ...base, kind }])
      expect(renderItem(i)).toContain('tagged=false from=approved]')
      expect(boundSessionNote([i], 'hydra', true)).toContain('you are listening')
    }
    expect(boundSessionNote(boundSessionFacts([{ ...base, kind: 'mention' }]), 'hydra', true)).toContain('likely being asked')
  })

  test('a reaction delivered to it carries the facts too: tagged=false, and for listening', async () => {
    const { w, sent } = setup(true, `${TOML}[places."slack:${ELSEWHERE}"]\nreactions = "all"\n`)
    expect(w.handleReaction({ channel: ELSEWHERE, itemTs: TS, reaction: 'eyes', user: 'UOP', eventTs: '4000.000001' })).toBe('accepted')
    await w.flush()
    expect(sent.map(s => s.to)).toEqual([MINE])
    expect(sent[0].msg).toContain('[reaction ts="4000.000001"')
    expect(sent[0].msg).toContain('tagged=false from=operator]')
    expect(sent[0].msg).toContain('you are listening')
  })

  test('a restricted or write-confined session the thread is bound to gets the facts and a line that it only listens, even for the operator\'s tag', async () => {
    const { w, sent } = setup(false)
    w.handle(ev('1001.000001', 'UOP', tag))
    await w.flush()
    expect(sent[0].msg).toContain('tagged=true from=operator]')
    expect(sent[0].msg).toContain('hydra: this Slack thread is bound to you to listen to: this session does not speak in Slack here (reply would be refused), so take it in and stay quiet.')
    expect(sent[0].msg).not.toContain(ASKED)
  })

  test('a burst of many short tags is packed with room for the facts and the line: every delivery fits, nothing is dropped as too large', async () => {
    const { w, sent } = setup()
    for (let n = 0; n < 150; n++) w.handle(ev(`${1100 + n}.000001`, 'UOP', `<@${BOT}> x`))
    await w.flush()
    expect(sent.length).toBeGreaterThan(1)
    for (const s of sent) expect(Buffer.byteLength(s.msg)).toBeLessThanOrEqual(DELIVER_MAX_MESSAGE_BYTES)
    expect(sent.reduce((n, s) => n + (s.msg.match(/tagged=true/g)?.length ?? 0), 0)).toBe(150)
    expect(sent[0].msg).toContain('ts=1100.000001, ts=1101.000001, ts=1102.000001, ts=1103.000001, ts=1104.000001, ')
    expect(sent[0].msg).toMatch(/ts=1104\.000001, \d+ more: you are likely being asked/)
  })
})
