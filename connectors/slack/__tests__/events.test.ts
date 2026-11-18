// The event stream, from the Slack connector's side: a route is recorded when something takes the message or when a tag finds no one; a bind
// or unbind is recorded by every path that makes one (a session's tool, the operator's CLI, main, the router). No line holds message text.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../../../daemon/config.js'
import { registry } from '../../../daemon/sessions.js'
import { transport } from '../../../daemon/bridge-transport.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import { executeTool } from '../../../daemon/bridge-dispatch.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { eventsDir } from '../../../shared/events.js'
import { readEvents } from '../../../cli/events.js'
import { ConversationTable, type ConversationConfig, type DeliverResult, type SlackMessageEvent } from '../watch.js'
import { bindConversation, unbindConversation, operatorBind, operatorUnbind, getConversationTable, slackRuntimeDeps } from '../runtime.js'
import { BASE, BOT, hydra, view } from './slack-config.js'

process.stderr.write = (() => true) as any

const OP_TOKEN = (toml: string) => toml.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
const PEOPLE = '[people.alice]\naddresses = ["slack:UALICE"]\n'
const ROUTER = '[specialists.slack-router]\nworkdir = "/w/router"\n'
const DESK = '[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\ntarget = "specialist:desk"\n'
const WITHOUT = OP_TOKEN(`${BASE}${PEOPLE}${ROUTER}${DESK}`)
const WITH = WITHOUT.replace('operator_token_env = "HYDRA_SLACK_USER_TOKEN"', 'operator_token_env = "HYDRA_SLACK_USER_TOKEN"\nrouter = "specialist:slack-router"')
const ELSEWHERE = 'C0ELSE'
const CONV = `slack:${ELSEWHERE}:1000.000001`
const ROUTER_THREAD = '1552619225032425001'
const LEDGER_THREAD = '1552619225032425002'
const MINE = '1552619225032425003'
const SECRET = 'the-launch-code-is-hunter2'
const tag = `<@${BOT}> ${SECRET}`

const dirs: string[] = []
const clearEvents = () => rmSync(eventsDir(STATE_DIR), { recursive: true, force: true })
beforeEach(clearEvents)
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); clearEvents() })
const events = () => readEvents(STATE_DIR, {})

function table(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'events-'))
  dirs.push(dir)
  const config: ConversationConfig = view(toml, { coalesceMs: 1 })
  const w = new ConversationTable({
    now: () => Date.now(), file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {},
    deliver: async (): Promise<DeliverResult> => ({ ok: true }),
  })
  return w
}
const ev = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({ channel: ELSEWHERE, ts: '1000.000001', user: 'UOP', text: tag, ...over })

describe('route: recorded when something takes the message, or when a tag finds no one', () => {
  test('the router takes a tag: one route event with the app, conversation, sender, tag, how and to whom', () => {
    const w = table(WITH)
    expect(w.handle(ev())).toBe('mention')
    expect(events()).toMatchObject([{ kind: 'route', app: 'default', conversation: CONV, by: 'slack:UOP', tagged: true, via: 'router', to: 'slack-router' }])
  })

  test('a rule, then a binding: each is a route with its own `via`', () => {
    const w = table(WITH)
    w.handle(ev({ channel: 'C0DESK', ts: '2000.000001' }))
    w.bind(ELSEWHERE, '3000.000001', 'desk', 'cli')
    w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001', text: 'a follow-up, untagged' }))
    expect(events().map(e => e.kind === 'route' && [e.via, e.to, e.tagged])).toEqual([['rule', 'desk', true], ['binding', 'desk', false]])
  })

  test('a tag nothing took is recorded with via none: no router, and a sender the router refuses', () => {
    const none = table(WITHOUT)
    expect(none.handle(ev())).toBe('unrouted')
    const refused = table(WITH)
    expect(refused.handle(ev({ user: 'UNOBODY', ts: '6100.000001' }))).toBe('refused')
    expect(events()).toMatchObject([
      { kind: 'route', conversation: CONV, by: 'slack:UOP', tagged: true, via: 'none' },
      { kind: 'route', conversation: 'slack:C0ELSE:6100.000001', by: 'slack:UNOBODY', tagged: true, via: 'none' },
    ])
    expect(events().every(e => e.kind === 'route' && e.to === undefined)).toBe(true)
  })

  test('an untagged message nobody takes is not recorded: chatter, and an untagged message a refusal turns away', () => {
    const w = table(WITH)
    expect(w.handle(ev({ text: 'just talking' }))).toBe('ignored')
    w.bind(ELSEWHERE, '2000.000001', 'slack-router', 'cli')   // the router admits people only: a stranger's follow-up is refused
    expect(w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001', user: 'UNOBODY', text: 'a stranger, untagged' }))).toBe('refused')
    const none = table(WITHOUT)
    none.handle(ev({ text: 'untagged, no router', ts: '8000.000001' }))
    expect(events()).toEqual([])
  })

  test('a replay is not a second event: the same message handled again (a deep catch-up pass) records once', () => {
    const none = table(WITHOUT)
    for (let i = 0; i < 3; i++) none.handle(ev())
    const refused = table(WITH)
    for (let i = 0; i < 3; i++) refused.handle(ev({ user: 'UNOBODY', ts: '6100.000001' }))
    expect(events().map(e => e.kind === 'route' && [e.conversation, e.via])).toEqual([[CONV, 'none'], ['slack:C0ELSE:6100.000001', 'none']])
  })

  test('a message still owed when it is replayed is not recorded twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'events-'))
    dirs.push(dir)
    const config: ConversationConfig = view(WITH, { coalesceMs: 1 })
    const w = new ConversationTable({ now: () => Date.now(), file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {}, deliver: async (): Promise<DeliverResult> => ({ ok: false, error: 'busy' } as any) })
    w.handle(ev())
    w.handle(ev())   // owed, replayed
    expect(events().filter(e => e.kind === 'route')).toHaveLength(1)
  })

  test('no line holds message text, whatever the message says', () => {
    const w = table(WITH)
    w.handle(ev())
    table(WITHOUT).handle(ev({ ts: '2000.000001' }))
    const raw = readdirSync(eventsDir(STATE_DIR)).map(f => readFileSync(join(eventsDir(STATE_DIR), f), 'utf8')).join('')
    expect(raw.trim().split('\n')).toHaveLength(2)
    expect(raw).not.toContain(SECRET)
  })
})

describe('bind and unbind: recorded by every path that makes one', () => {
  const realPost = slackRuntimeDeps.post
  const realView = slackRuntimeDeps.view
  const realRead = slackRuntimeDeps.readThread
  const configure = (toml: string) => { _setHydraConfigForTesting(hydra(toml)); const v = view(toml); slackRuntimeDeps.view = () => v }
  const live = (id: string, threadId: string) => { transport.bridges.set(id, {} as any); registry.set(id, { sessionId: id, tmuxName: id, threadId, threadUrl: `https://chat.example/t/${threadId}`, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any) }
  beforeEach(() => {
    slackRuntimeDeps.post = async () => '1.000001'
    slackRuntimeDeps.readThread = async () => 'bot'
    configure(WITH)
    setSpecialistThread('slack-router', ROUTER_THREAD)
    live('slack-router', ROUTER_THREAD); live('sw-ledger', LEDGER_THREAD); live('sw-mine', MINE)
  })
  afterEach(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
    for (const id of ['slack-router', 'sw-ledger', 'sw-mine']) { registry.delete(id); transport.bridges.delete(id) }
    slackRuntimeDeps.post = realPost; slackRuntimeDeps.view = realView; slackRuntimeDeps.readThread = realRead
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
    _reloadSpecialists()
  })

  test("the operator's CLI: a bind carries its reason, a move says where it came from, an unbind says what it let go", async () => {
    await operatorBind(CONV, 'specialist:desk')
    await operatorBind(CONV, `thread:${LEDGER_THREAD}`, 'it owns the ledger work')
    operatorUnbind(CONV)
    expect(operatorUnbind(CONV)).toContain('was not bound')   // nothing to let go: no event
    expect(events()).toMatchObject([
      { kind: 'bind', conversation: CONV, to: 'desk', by: 'operator' },
      { kind: 'bind', conversation: CONV, from: 'desk', to: LEDGER_THREAD, why: 'it owns the ledger work', by: 'operator' },
      { kind: 'unbind', conversation: CONV, from: LEDGER_THREAD, by: 'operator' },
    ])
    expect(events()).toHaveLength(3)
  })

  test("a session's own tool: bind_conversation and unbind_conversation, by the session's thread", async () => {
    await bindConversation({ threadId: MINE }, CONV)
    unbindConversation({ threadId: MINE }, CONV)
    expect(events()).toMatchObject([
      { kind: 'bind', conversation: CONV, to: MINE, by: MINE },
      { kind: 'unbind', conversation: CONV, from: MINE, by: MINE },
    ])
  })

  test('the router and main hand a conversation on: the bind says who did it and why', async () => {
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'slack-router', 'cli')
    await executeTool('bind_conversation', { conversation: CONV, target: 'sw-ledger', why: 'fits' }, 'slack-router')
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    await bindConversation(undefined, CONV, { target: 'sw-ledger', why: 'main knows', callerSessionId: 'main' })
    expect(events()).toMatchObject([
      { kind: 'bind', conversation: CONV, from: 'slack-router', to: LEDGER_THREAD, why: 'fits', by: 'slack-router' },
      { kind: 'bind', conversation: CONV, from: 'main', to: LEDGER_THREAD, why: 'main knows', by: 'main' },
    ])
  })

  test('binding to who already holds it is not a bind: no event for a no-op, by hand or by tool', async () => {
    await operatorBind(CONV, 'specialist:desk')
    await operatorBind(CONV, 'specialist:desk')
    await bindConversation({ threadId: MINE }, CONV.replace('1000', '2000'))
    await bindConversation({ threadId: MINE }, CONV.replace('1000', '2000'))
    expect(events().map(e => e.kind === 'bind' && [e.conversation, e.to])).toEqual([[CONV, 'desk'], [CONV.replace('1000', '2000'), MINE]])
  })

  test('a refused bind records nothing', async () => {
    await expect(operatorBind(CONV, 'specialist:no-such')).rejects.toThrow()
    await expect(bindConversation(undefined, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('only main and the router')
    expect(events()).toEqual([])
  })
})
