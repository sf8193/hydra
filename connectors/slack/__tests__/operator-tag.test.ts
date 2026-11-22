// The operator tags their own app (bot + operator token) in a thread nothing holds: a place-less `[[rules]]` entry for that app and the
// operator sends it to main. Main answers it, or binds it to a session, and the bind tells the thread. The bot answers as itself, in the
// thread where it is a member; where it is not, the answer goes to the operator's DM with the app, with a link. The bot never joins a channel.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../infra/config.js'
import { registry } from '../../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { ConversationTable, EXTERNAL_AUDIENCE_NOTE, NEW_TO_MAIN_NOTE, TOP_LEVEL, type ConversationConfig, type DeliverResult, type SlackMessageEvent } from '../watch.js'
import { getConversationTable, operatorBind, replyInConversation, slackConversationLink, slackRuntimeDeps } from '../runtime.js'
import { BASE, BOT, hydra, view } from './slack-config.js'
import { owningApp, route } from '../../../routing/route.js'
import { loadHydraConfig } from '../../../config/load.js'
import { testLoadEnv } from '../../../config/__tests__/load-env.js'
import { handleCLIRequest } from '../../../app/cli-handler.js'
import { placeOf } from '../../../config/types.js'

process.stderr.write = (() => true) as any

const OP_TOKEN = (toml: string) => toml.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
/** What the operator adds to hydra.toml: their own tag of their app, anywhere, goes to main. */
const OPERATOR_TAG_RULE = '[[rules]]\napp = "app:default"\nperson = "person:op"\ntarget = "main"\n'
const PEOPLE = '[people.alice]\naddresses = ["slack:UALICE"]\n'
const DESK = '[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\ntarget = "specialist:desk"\n'
const WITH = OP_TOKEN(`${BASE}${PEOPLE}${DESK}${OPERATOR_TAG_RULE}`)
const WITHOUT = OP_TOKEN(`${BASE}${PEOPLE}${DESK}`)
const ELSEWHERE = 'C0ELSE'         // a channel no rule or [places] entry names, which the operator is in and the bot is not
const SESSION = '1552619225032425525'
const tag = `<@${BOT}> can you look at this?`

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-tag-'))
  dirs.push(dir)
  const sent: { to: string; msg: string }[] = []
  const logs: string[] = []
  const config: ConversationConfig = view(toml, { coalesceMs: 1, dms: { D0ALICE01: 'UALICE', D0BOT0001: 'bot' }, groupDms: ['G0GROUP01'] })
  const w = new ConversationTable({
    now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: l => logs.push(l), config: () => config, alert: () => {},
    deliver: async ({ to }, msg): Promise<DeliverResult> => { sent.push({ to, msg }); return { ok: true } },
  })
  return { w, sent, logs }
}
const ev = (over: Partial<SlackMessageEvent>): SlackMessageEvent => ({ channel: ELSEWHERE, ts: '1000.000001', user: 'UOP', text: tag, ...over })

describe("the operator's tag of their own app, in a thread nothing holds", () => {
  test('without the rule it is unrouted, as before; with it, it goes to main and binds the thread to main', async () => {
    const before = setup(WITHOUT)
    expect(before.w.handle(ev({}))).toBe('unrouted')
    expect(before.logs.join()).toContain('unrouted UOP')

    const s = setup(WITH)
    expect(s.w.handle(ev({}))).toBe('mention')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['main'])
    expect(s.w.get(ELSEWHERE, '1000.000001')?.specialist).toBe('main')
  })

  test("someone else's tag of the operator's app stays unrouted, and is logged", async () => {
    const s = setup(WITH)
    expect(s.w.handle(ev({ user: 'UALICE' }))).toBe('unrouted')
    await s.w.flush()
    expect(s.sent).toEqual([])
    expect(s.logs.join()).toContain('unrouted UALICE')
  })

  test('the operator\'s untagged chatter, and their DMs with other people, still reach nothing: the rule names no place', async () => {
    const s = setup(WITH)
    expect(s.w.handle(ev({ text: 'just talking' }))).toBe('ignored')
    expect(s.w.handle(ev({ channel: 'D0ALICE01', text: tag }))).toBe('ignored')   // a DM with a person: the bot is not part of it
    await s.w.flush()
    expect(s.sent).toEqual([])
  })

  test('order is unchanged: a rule that names the place wins, and a bound thread follows its binding', async () => {
    const s = setup(WITH)
    expect(s.w.handle(ev({ channel: 'C0DESK' }))).toBe('mention')
    s.w.bind(ELSEWHERE, '2000.000001', 'desk', 'cli')
    expect(s.w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001' }))).toBe('mention')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['desk', 'desk'])
  })

  test('every later message in the thread follows the binding untagged: to main, then to the session it is bound to', async () => {
    const s = setup(WITH)
    s.w.handle(ev({}))
    await s.w.flush()
    expect(s.w.handle(ev({ ts: '1001.000001', threadTs: '1000.000001', text: 'and another thing' }))).toBe('follow-up')
    await s.w.flush()
    s.w.bind(ELSEWHERE, '1000.000001', SESSION, 'cli')                                     // main attaches it to a session
    expect(s.w.handle(ev({ ts: '1002.000001', threadTs: '1000.000001', user: 'UALICE', text: 'from a colleague' }))).toBe('follow-up')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['main', 'main', SESSION])
  })

  test('main is told what it may do with a thread new to it, once: the first delivery carries the note, the next does not', async () => {
    const s = setup(WITH)
    s.w.handle(ev({}))
    await s.w.flush()
    s.w.handle(ev({ ts: '1001.000001', threadTs: '1000.000001', text: 'more' }))
    await s.w.flush()
    expect(s.sent[0].msg).toContain(NEW_TO_MAIN_NOTE)
    expect(s.sent[0].msg).toContain('conversation="slack:C0ELSE:1000.000001"')
    expect(s.sent[1].msg).not.toContain(NEW_TO_MAIN_NOTE)
    // a specialist's delivery never carries it
    const d = setup(WITH)
    d.w.handle(ev({ channel: 'C0DESK' }))
    await d.w.flush()
    expect(d.sent[0].msg).not.toContain(NEW_TO_MAIN_NOTE)
    // a thread in a group DM is main's to answer: no note
    const g = setup(WITH + '[[rules]]\nplace = "slack:group-dm:G0GROUP01"\ntarget = "main"\n')
    g.w.handle(ev({ channel: 'G0GROUP01', ts: '4001.000001', threadTs: '4000.000001' }))
    await g.w.flush()
    expect(g.sent.map(x => x.to)).toEqual(['main'])
    expect(g.sent[0].msg).not.toContain(NEW_TO_MAIN_NOTE)
    // the note is hydra's line, outside the quoted words: no sender line can pose as it
    expect(s.sent[0].msg.split('\n').filter(l => l === NEW_TO_MAIN_NOTE)).toHaveLength(1)
  })
})

describe('every delivery from a Slack conversation carries hydra\'s external-audience line', () => {
  test('to main, to a specialist and to a session bound to the thread: once, outside the quoted words, before them', async () => {
    const toMain = setup(WITH)
    toMain.w.handle(ev({}))
    await toMain.w.flush()
    const toSpecialist = setup(WITH)
    toSpecialist.w.handle(ev({ channel: 'C0DESK' }))
    await toSpecialist.w.flush()
    const toSession = setup(WITH)
    toSession.w.bind(ELSEWHERE, '3000.000001', SESSION, 'cli')
    toSession.w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001' }))
    await toSession.w.flush()
    for (const s of [toMain, toSpecialist, toSession]) {
      const lines = s.sent[0].msg.split('\n')
      expect(lines.filter(l => l === EXTERNAL_AUDIENCE_NOTE)).toHaveLength(1)
      expect(lines[1]).toBe(EXTERNAL_AUDIENCE_NOTE)
    }
    expect(EXTERNAL_AUDIENCE_NOTE).toContain('audience is outside hydra')
    expect(EXTERNAL_AUDIENCE_NOTE).toContain('never post links to Discord, hydra or private Slack conversations, or internal session names')
  })
})

describe('the operator\'s rule is a catch-all (`isCatchAll`): it takes only what nothing holds or claims', () => {
  test('a thread attached to a session stays with it when the operator tags the app there again', async () => {
    const s = setup(WITH)
    s.w.bind(ELSEWHERE, '3000.000001', SESSION, 'cli')
    expect(s.w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001' }))).toBe('mention')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual([SESSION])
    expect(s.w.get(ELSEWHERE, '3000.000001')?.specialist).toBe(SESSION)
    // A rule that names the place still takes it, as before: main answers there.
    const named = setup(WITH.replace('[[rules]]\napp = "app:default"', `[[rules]]\nplace = "slack:${ELSEWHERE}"\ntarget = "main"\n[[rules]]\napp = "app:default"`))
    named.w.bind(ELSEWHERE, '3000.000001', SESSION, 'cli')
    named.w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001' }))
    expect(named.w.get(ELSEWHERE, '3000.000001')?.specialist).toBe('main')
  })

  test('written first, it is still tried after every other rule: a rule that names the place wins', async () => {
    const first = OP_TOKEN(`${BASE}${PEOPLE}${OPERATOR_TAG_RULE}${DESK}`)
    const s = setup(first)
    expect(s.w.handle(ev({ channel: 'C0DESK' }))).toBe('mention')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['desk'])
  })

  test('the loader reads the order the same way: a rule after a catch-all is not "never matches"; a second catch-all is', () => {
    const load = (toml: string) => { const r = loadHydraConfig(toml, testLoadEnv({ home: '/home/op', sessionNames: [] })); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.warnings.map(w => `${w.path}: ${w.message}`) }
    const first = OP_TOKEN(`${BASE}${PEOPLE}${OPERATOR_TAG_RULE}[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\napp = "app:default"\nperson = "person:op"\ntarget = "specialist:desk"\n`)
    expect(load(first).filter(w => w.includes('never matches'))).toEqual([])
    expect(load(WITH + OPERATOR_TAG_RULE).filter(w => w.includes('never matches'))).toHaveLength(1)
  })

  test('a rule naming the place for someone else does not let the catch-all take a session\'s thread', async () => {
    const s = setup(WITH.replace('[[rules]]\napp = "app:default"', `[[rules]]\nplace = "slack:${ELSEWHERE}"\nperson = "person:alice"\ntarget = "main"\n[[rules]]\napp = "app:default"`))
    s.w.bind(ELSEWHERE, '3000.000001', SESSION, 'cli')
    s.w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001' }))
    expect(s.w.get(ELSEWHERE, '3000.000001')?.specialist).toBe(SESSION)
  })

  test('it never makes the operator\'s app the owning app of a channel another app answers: that app keeps the chatter', () => {
    const toml = OP_TOKEN(`${BASE}${PEOPLE}[slack.apps.sales]\nbot_token_env = "S_BOT"\nsocket_token_env = "S_APP"\n[specialists.deals]\nworkdir = "/w/deals"\npinned_to = ["app:sales"]\nrestricted = true\nreachable_by = ["role:anyone"]\n[[rules]]\napp = "app:sales"\ntarget = "specialist:deals"\n${OPERATOR_TAG_RULE}[places."slack:C0SHARED"]\nmessages = "all"\n`)
    const h = hydra(toml)
    const at = [placeOf('slack', 'channel', 'C0SHARED')]
    expect(owningApp(h, { app: 'sales', heardBy: ['default', 'sales'], at })?.app).toBe('sales')
    expect(route(h, { from: 'slack:UNOBODY', at, addressed: false, app: 'sales', heardBy: ['default', 'sales'] })).toMatchObject({ fate: 'deliver', to: 'deals' })
  })
})

// --- the runtime: main's reply, and the operator's bind -----------------------------------------------------------------------
describe("main's answer, and the bind's notice: in the thread where the bot is a member, else in the operator's DM with the app", () => {
  const CONV = `slack:${ELSEWHERE}:1000.000001`
  const realPost = slackRuntimeDeps.post
  const realView = slackRuntimeDeps.view
  const posts: string[] = []
  /** `member`: the channels the bot is in. A post anywhere else is refused as Slack refuses it; a user id is that person's DM with the app. */
  const slack = (member: Set<string>) => {
    posts.length = 0
    slackRuntimeDeps.post = async (c, t, text) => {
      if (!c.startsWith('U') && !member.has(c)) throw new Error('An API error occurred: not_in_channel')
      posts.push(`${c}|${t ?? '-'}|${text}`); return `${posts.length}.000001`
    }
  }
  const configure = (toml: string) => {
    _setHydraConfigForTesting(hydra(toml))
    const v = view(toml)
    slackRuntimeDeps.view = () => v
  }
  const attached = () => registry.set('sw-attached', { sessionId: 'sw-attached', tmuxName: 'sw-attached', threadId: SESSION, threadUrl: `https://chat.example/t/${SESSION}`, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
  beforeEach(() => { configure(WITH); getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli') })
  afterEach(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs)
    registry.delete('sw-attached')
    slackRuntimeDeps.post = realPost; slackRuntimeDeps.view = realView
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  })

  test('where the bot is a member, main\'s answer goes in the thread', async () => {
    slack(new Set([ELSEWHERE]))
    expect(await replyInConversation('main', CONV, 'on it')).toBe(`posted 1 message to ${CONV}`)
    expect(posts).toEqual([`${ELSEWHERE}|1000.000001|on it`])
  })

  test('where it is not, the answer goes to the operator\'s DM with the app, with a link to the thread, and the result says so; the bot never joins', async () => {
    slack(new Set())
    const out = await replyInConversation('main', CONV, 'on it')
    expect(out).toContain(`not posted to ${CONV}: the bot isn't in that channel`)
    expect(out).toContain("to the operator's DM with")
    expect(posts).toHaveLength(1)
    expect(posts[0]).toStartWith('UOP|-|From main, not posted in https://x.slack.com/archives/C0ELSE/p1000000001: ')
    expect(posts[0]).toContain('invite it to the channel to post there')
    expect(posts[0]).toEndWith('on it')
  })

  test('an app without the operator token hears only where its bot is: Slack\'s refusal stands, nothing goes to the operator', async () => {
    configure(`${BASE}${PEOPLE}${DESK}${OPERATOR_TAG_RULE}`)
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    slack(new Set())
    await expect(replyInConversation('main', CONV, 'on it')).rejects.toThrow('not_in_channel')
    expect(posts).toEqual([])
  })

  test('a restricted specialist\'s answer never goes to the operator\'s DM, and nothing posted in a DM with a person does', async () => {
    configure(WITH + '[specialists.vault]\nworkdir = "/w/vault"\nrestricted = true\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0VAULT"\ntarget = "specialist:vault"\n')
    registry.set('sw-vault', { sessionId: 'sw-vault', tmuxName: 'sw-vault', threadId: 'vault-thread', sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    const { setSpecialistThread } = await import('../../../sessions/specialists.js')
    setSpecialistThread('vault', 'vault-thread')
    try {
      getConversationTable().bind('C0VAULT', '1000.000001', 'vault', 'cli')
      slack(new Set())
      await expect(replyInConversation('sw-vault', 'slack:C0VAULT:1000.000001', 'secret')).rejects.toThrow("the bot isn't in that channel")
      expect(posts).toEqual([])
    } finally { registry.delete('sw-vault') }
    // A DM, or a group DM, between people is not a channel the bot can be invited to: Slack's refusal stands.
    configure(WITH)
    slackRuntimeDeps.view = () => view(WITH, { groupDms: ['G0GROUP01'] })
    getConversationTable().bind('G0GROUP01', '5000.000001', 'main', 'cli')
    slack(new Set())
    await expect(replyInConversation('main', 'slack:G0GROUP01:5000.000001', 'hi')).rejects.toThrow('not_in_channel')
    expect(posts).toEqual([])
    getConversationTable().bind('D0ALICE01', TOP_LEVEL, 'main', 'cli')
    slack(new Set())
    await expect(replyInConversation('main', 'slack:D0ALICE01', 'hi')).rejects.toThrow('not_in_channel')
    expect(posts).toEqual([])
  })

  // The notice goes to the session's own thread (gateway.send), never into the Slack conversation (slackRuntimeDeps.post).
  const sessionThread: Array<{ to: string; text: string; opts?: any }> = []
  const logged: string[] = []
  const realSend = gateway.send
  const realWrite = process.stderr.write
  let sendFails: Error | undefined
  beforeEach(() => {
    sessionThread.length = 0; logged.length = 0; sendFails = undefined
    ;(gateway as any).send = async (to: string, text: string, opts?: any) => { if (sendFails) throw sendFails; sessionThread.push({ to, text, opts }); return { id: '1', channelId: to } }
    process.stderr.write = ((c: any) => { logged.push(String(c)); return true }) as any
  })
  afterEach(() => { (gateway as any).send = realSend; process.stderr.write = realWrite })
  const NOTICE = (link: string) => `→ sw-attached https://chat.example/t/${SESSION}: it owns the ledger work\nSlack conversation: ${link}`

  test('binding the thread to a session posts nothing in the Slack conversation: the notice goes to the session\'s own thread, with the permalink', async () => {
    slack(new Set([ELSEWHERE]))
    attached()
    const out = await operatorBind(CONV, `thread:${SESSION}`, 'it owns the ledger work')
    expect(out).toStartWith(`${CONV} → ${SESSION}; posted in the session's thread ${SESSION}`)
    expect(posts).toEqual([])
    expect(sessionThread).toEqual([{ to: SESSION, text: NOTICE(slackConversationLink(CONV)!), opts: { unfurl: false } }])
    expect(slackConversationLink(CONV)).toContain('slack.com/archives/C0ELSE')
    expect(getConversationTable().get(ELSEWHERE, '1000.000001')?.specialist).toBe(SESSION)
  })

  test('a Discord link or session name never reaches a Slack conversation, wherever the bot is a member or not', async () => {
    for (const member of [new Set([ELSEWHERE]), new Set<string>()]) {
      slack(member)
      attached()
      await operatorBind(CONV, `thread:${SESSION}`, 'why')
      expect(posts.filter(p => !p.startsWith('UOP|'))).toEqual([])
      getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    }
  })

  test('where the session\'s thread cannot be posted in, the notice goes to the operator\'s DM with the app, which is private', async () => {
    slack(new Set([ELSEWHERE]))
    attached()
    sendFails = new Error('Missing Access')
    const out = await operatorBind(CONV, `thread:${SESSION}`, 'it owns the ledger work')
    expect(out).toContain("to the operator's DM with")
    expect(posts).toHaveLength(1)
    expect(posts[0]).toStartWith('UOP|-|The bind notice, not posted in ')
    expect(posts[0]).toContain('Missing Access')
    expect(posts[0]).toContain(NOTICE(slackConversationLink(CONV)!))
  })

  test('every outcome of the notice is logged: posted, posted in the operator\'s DM, and failed with why', async () => {
    slack(new Set([ELSEWHERE]))
    attached()
    await operatorBind(CONV, `thread:${SESSION}`, 'it owns the ledger work')
    expect(logged.join('')).toContain(`bind notice for ${CONV} → ${SESSION}: posted in the session's thread ${SESSION}`)
    logged.length = 0
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    sendFails = new Error('Missing Access')
    await operatorBind(CONV, `thread:${SESSION}`, 'again')
    expect(logged.join('')).toContain(`bind notice for ${CONV} → ${SESSION}: not posted to ${CONV}: the session's thread ${SESSION} could not be posted in (Missing Access)`)
    expect(logged.join('')).toContain("operator's DM")
    logged.length = 0
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    slackRuntimeDeps.post = async () => { throw new Error('An API error occurred: ratelimited') }
    await operatorBind(CONV, `thread:${SESSION}`, 'third')
    expect(logged.join('')).toContain(`bind notice for ${CONV} → ${SESSION}: not posted: Missing Access; the operator's DM did not take it either: `)
  })

  test('`hydra conversations bind … --why` carries the reason to the daemon, which binds and sends the notice to the session\'s thread in one request', async () => {
    slack(new Set([ELSEWHERE]))
    attached()
    const r = await handleCLIRequest({ type: 'cli', command: 'conversations', id: 'op-tag-1', params: { action: 'bind', conversation: CONV, to: `thread:${SESSION}`, why: 'it owns the ledger work' } })
    expect(r.ok).toBe(true)
    expect((r.data as { bound: string }).bound).toContain('→ sw-attached')
    expect(posts).toEqual([])
    expect(sessionThread.map(m => m.to)).toEqual([SESSION])
  })

  test('the bind holds when the notice cannot be posted, and says so; --why is refused on a bind that posts no notice', async () => {
    sendFails = new Error('ratelimited')
    slackRuntimeDeps.post = async () => { throw new Error('An API error occurred: ratelimited') }
    const gw = gateway.getThreadUrl
    ;(gateway as any).getThreadUrl = async () => ''
    try {
      const out = await operatorBind(CONV, `thread:${SESSION}`)
      expect(out).toContain('not posted')
      expect(getConversationTable().get(ELSEWHERE, '1000.000001')?.specialist).toBe(SESSION)
    } finally { (gateway as any).getThreadUrl = gw }
    await expect(operatorBind(CONV, 'main', 'why not')).rejects.toThrow('--why gives the reason in the notice that a bind to a session')
  })
})

describe('a tag the tag cap drops in a group DM the bot is not part of', () => {
  test('is counted and logged, never reacted to; the same over-cap tag in a channel gets the 🚫', async () => {
    const run = (channel: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'operator-tag-cap-'))
      dirs.push(dir)
      const reactions: string[] = []
      const config = view(WITH + '[[rules]]\nplace = "slack:group-dm:G0GROUP01"\ntarget = "main"\n', { coalesceMs: 1, dms: { D0ALICE01: 'UALICE', D0BOT0001: 'bot' }, groupDms: ['G0GROUP01'], maxMentionsPer10Min: 1 })
      const w = new ConversationTable({
        now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {},
        deliver: async (): Promise<DeliverResult> => ({ ok: true }),
      })
      w.setSlackActions({ react: async (c: string, ts: string, name: string) => { reactions.push(`${c}:${ts}:${name}`) } } as any)
      // Threads, so each tag opens its own conversation (top-level messages in a DM are one conversation, which the cap does not touch).
      w.handle(ev({ channel, ts: '5000.000002', threadTs: '5000.000001' }))
      expect(w.handle(ev({ channel, ts: '5001.000002', threadTs: '5001.000001' }))).toBe('ignored')   // a second new conversation inside 10 minutes: over the cap
      return { w, reactions }
    }
    const group = run('G0GROUP01')
    await Bun.sleep(1)
    expect(group.w.stats().dropped).toEqual({ 'tag-cap': 1 })
    expect(group.reactions).toEqual([])
    const channel = run('C0DESK')
    await Bun.sleep(1)
    expect(channel.w.stats().dropped).toEqual({ 'tag-cap': 1 })
    expect(channel.reactions).toHaveLength(1)
  })
})
