// A session's own chat thread shows its Slack traffic the way it shows session-to-session sends: one quiet line for each message an approved person
// tags the app with (📨), one for each reply the session posts into Slack (📤). Never into Slack; untagged chatter and strangers get none.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../infra/config.js'
import { setSpecialistThread } from '../../../sessions/specialists.js'
import { registry } from '../../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { readEvents } from '../../../cli/events.js'
import { eventsDir } from '../../../shared/events.js'
import { ConversationTable, type ConversationConfig, type SlackMessageEvent } from '../watch.js'
import { getConversationTable, replyInConversation, slackRuntimeDeps } from '../runtime.js'
import { resolveLineEmoji, receivedLine, postedLine } from '../lines.js'
import { BOT, BASE, hydra, view } from './slack-config.js'
import { LANDED } from './outcomes.js'
import type { DeliverOutcome } from '../../../app/targets.js'
import * as slackTargets from '../../../app/targets.js'
import { bindSlackDelivery } from '../runtime.js'
bindSlackDelivery(slackTargets)

process.stderr.write = (() => true) as any

const CUSTOM = '<:slack:1573045794259603566>'
const TOML = `${BASE}[people.alice]\naddresses = ["slack:UALICE"]\nname = "alice"\n`
const ELSEWHERE = 'C0ELSE'
const MINE = '1552619225032425525'
const TS = '1000.000001'
const CONV = `slack:${ELSEWHERE}:${TS}`
const tag = `<@${BOT}> can you look at the launch plan?`

const dirs: string[] = []
const routes = () => readEvents(STATE_DIR, { kind: 'route' })
const clearEvents = () => rmSync(eventsDir(STATE_DIR), { recursive: true, force: true })
beforeEach(clearEvents)
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); clearEvents() })

describe('📨: a tag by someone in [people], shown in the thread of the session it was delivered to', () => {
  function setup(toml = TOML) {
    const dir = mkdtempSync(join(tmpdir(), 'lines-'))
    dirs.push(dir)
    const lines: { to: string; line: string }[] = []
    const config: ConversationConfig = view(toml, { coalesceMs: 1 })
    const w = new ConversationTable({
      now: () => Date.now(), file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {},
      deliver: async (): Promise<DeliverOutcome> => LANDED,
      line: (to, make) => lines.push({ to, line: make('💬') }),
    })
    w.bind(ELSEWHERE, TS, MINE, 'cli')
    return { w, lines }
  }
  const ev = (ts: string, user: string, text: string): SlackMessageEvent => ({ channel: ELSEWHERE, ts, threadTs: TS, user, text })

  test('a tag by an approved person: one line, naming them, linking their message, with the words but not the tag', async () => {
    const { w, lines } = setup()
    w.handle(ev('1001.000001', 'UALICE', tag))
    await w.flush()
    expect(lines).toEqual([{ to: MINE, line: '📨 from 💬 [alice](<https://x.slack.com/archives/C0ELSE/p1001000001?thread_ts=1000.000001>) → can you look at the launch plan?' }])
  })

  test('the operator is a person too, and a message that opens the conversation links the thread itself', async () => {
    const { w, lines } = setup()
    w.handle({ channel: ELSEWHERE, ts: TS, user: 'UOP', text: tag })
    await w.flush()
    expect(lines.map(l => l.line)).toEqual(['📨 from 💬 [op](<https://x.slack.com/archives/C0ELSE/p1000000001>) → can you look at the launch plan?'])
  })

  test('no line for an untagged message, even from an approved person (the delivery still happens)', async () => {
    const { w, lines } = setup()
    w.handle(ev('1001.000001', 'UALICE', 'fyi, this is moving'))
    await w.flush()
    expect(routes()).toMatchObject([{ tagged: false, to: MINE }])
    expect(lines).toEqual([])
  })

  test('no line for a tag by someone not in [people]', async () => {
    const { w, lines } = setup()
    w.handle(ev('1001.000001', 'UNOBODY', tag))
    await w.flush()
    expect(routes()).toMatchObject([{ tagged: true, by: 'slack:UNOBODY', to: MINE }])
    expect(lines).toEqual([])
  })

  test('no line where nothing took the message, or a specialist rather than a session did', async () => {
    const { w, lines } = setup(`${TOML}[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\ntarget = "specialist:desk"\n`)
    w.handle({ channel: 'C0DESK', ts: '2000.000001', user: 'UALICE', text: tag })
    w.handle({ channel: 'C0NONE', ts: '3000.000001', user: 'UALICE', text: tag })
    await w.flush()
    expect(routes().filter(e => e.kind === 'route' && e.to).map(e => e.kind === 'route' && e.to)).toEqual(['desk'])
    expect(lines).toEqual([])
  })

  test('lines and route events agree: one line for each tagged, approved route event that reached a session, written at the same settle', async () => {
    const { w, lines } = setup()
    w.handle(ev('1001.000001', 'UALICE', tag))
    w.handle(ev('1002.000001', 'UALICE', 'untagged'))
    w.handle(ev('1003.000001', 'UNOBODY', tag))
    expect(lines).toEqual([])   // accepted, not yet delivered: nothing settled, so neither an event nor a line
    expect(routes()).toEqual([])
    await w.flush()
    const taken = routes().flatMap(e => e.kind === 'route' && e.to === MINE && e.tagged && e.by === 'slack:UALICE' ? [e] : [])
    expect(lines.length).toBe(taken.length)
    expect(lines.length).toBe(1)
  })

  test('with no workspace address the name stays plain, and the line is still one line', () => {
    expect(receivedLine('💬', 'alice', undefined, tag)).toBe('📨 from 💬 alice → can you look at the launch plan?')
    expect(receivedLine('💬', 'alice', undefined, `<@${BOT}>`)).toBe('📨 from 💬 alice → (a tag with no words)')
  })
})

describe('📤: a reply into a Slack conversation, shown in the replying session\'s own thread', () => {
  const realPost = slackRuntimeDeps.post
  const realView = slackRuntimeDeps.view
  const realSend = (gateway as any).send
  const realIsThreadId = gateway.isThreadId
  const realCan = gateway.canRenderEmoji
  const posts: string[] = []
  const shown: { to: string; text: string; opts: any }[] = []
  const configure = (toml: string) => { _setHydraConfigForTesting(hydra(toml)); const v = view(toml); slackRuntimeDeps.view = () => v }
  beforeEach(() => {
    posts.length = 0; shown.length = 0
    configure(TOML)
    slackRuntimeDeps.post = async (c, t, text) => { posts.push(`${c}|${t ?? '-'}|${text}`); return `${posts.length}.000001` }
    ;(gateway as any).send = async (to: string, text: string, opts?: any) => { shown.push({ to, text, opts }); return { id: '1', channelId: to } }
    gateway.isThreadId = () => true
    gateway.canRenderEmoji = () => true
    registry.set('ln-mine', { sessionId: 'ln-mine', tmuxName: 'ln-mine', threadId: MINE, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    getConversationTable().bind(ELSEWHERE, TS, MINE, 'cli')
  })
  afterEach(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
    registry.delete('ln-mine')
    slackRuntimeDeps.post = realPost; slackRuntimeDeps.view = realView
    ;(gateway as any).send = realSend; gateway.isThreadId = realIsThreadId; gateway.canRenderEmoji = realCan
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  })
  const settle = () => new Promise(r => setTimeout(r, 5))

  test('one line per reply, in the session\'s own thread: subtext, no link preview, linking the conversation, with the summary', async () => {
    await replyInConversation('ln-mine', CONV, 'on it, back with a plan by noon')
    await settle()
    expect(posts).toEqual([`${ELSEWHERE}|${TS}|on it, back with a plan by noon`])
    expect(shown).toEqual([{ to: MINE, text: '📤 to 💬 [thread](<https://x.slack.com/archives/C0ELSE/p1000000001>) → on it, back with a plan by noon', opts: { subtext: true, unfurl: false } }])
  })

  test('a specialist\'s reply, in a conversation bound to its name rather than a session\'s own thread, gets no line (as no 📨 is shown for it)', async () => {
    configure(`${TOML}[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n`)
    registry.set('ln-desk', { sessionId: 'ln-desk', tmuxName: 'desk', threadId: '1552619225032425999', sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    setSpecialistThread('desk', '1552619225032425999')
    getConversationTable().bind(ELSEWHERE, '5000.000001', 'desk', 'cli')
    const said = await replyInConversation('ln-desk', `slack:${ELSEWHERE}:5000.000001`, 'hello')
    expect(said).toBe(`posted 1 message to slack:${ELSEWHERE}:5000.000001`)
    await settle()
    registry.delete('ln-desk')
    expect(shown).toEqual([])
  })

  test('no line when nothing was posted: a refused reply', async () => {
    await expect(replyInConversation('ln-mine', 'slack:C0NOPE:1.000001', 'x')).rejects.toThrow()
    await settle()
    expect(shown).toEqual([])
  })

  test('a line that cannot be posted never fails the reply', async () => {
    ;(gateway as any).send = async () => { throw new Error('thread archived') }
    expect(await replyInConversation('ln-mine', CONV, 'hi')).toBe(`posted 1 message to ${CONV}`)
    await settle()
  })

  test('the configured emoji is shown when the gateway can render it, else 💬', async () => {
    configure(`operator = "op"\n[slack]\nline_emoji = "${CUSTOM}"\n${TOML.replace('operator = "op"\n', '')}`)
    gateway.canRenderEmoji = e => e === CUSTOM
    await replyInConversation('ln-mine', CONV, 'one')
    gateway.canRenderEmoji = () => false
    await replyInConversation('ln-mine', CONV, 'two')
    await settle()
    expect(shown.map(s => s.text.slice(0, s.text.indexOf(' [')))).toEqual([`📤 to ${CUSTOM}`, '📤 to 💬'])
  })
})

describe('the emoji a line shows', () => {
  test('the configured one when the gateway can render it; 💬 when it cannot, or when none is set', () => {
    expect(resolveLineEmoji(CUSTOM, { canRenderEmoji: () => true })).toBe(CUSTOM)
    expect(resolveLineEmoji(CUSTOM, { canRenderEmoji: () => false })).toBe('💬')
    expect(resolveLineEmoji(undefined, { canRenderEmoji: () => true })).toBe('💬')
  })

  test('both lines carry it outside the link, where Discord keeps a masked link whole', () => {
    expect(receivedLine(CUSTOM, 'sam', 'https://x/p1', 'hi')).toBe(`📨 from ${CUSTOM} [sam](<https://x/p1>) → hi`)
    expect(postedLine(CUSTOM, 'https://x/p2', 'hello')).toBe(`📤 to ${CUSTOM} [thread](<https://x/p2>) → hello`)
  })

  test('a summary cannot add a link or a mention of its own: it is the one-line summary quiet-send makes', () => {
    expect(postedLine('💬', 'https://x/p2', 'see [here](https://evil) <@U1> @everyone')).toBe('📤 to 💬 [thread](<https://x/p2>) → see [here] (https://evil) <​@​U1> @​everyone')
  })
})
