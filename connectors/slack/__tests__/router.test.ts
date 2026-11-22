// The router: the specialist an app's `router` names. A tag of the app in a channel thread that no conversation binds and no rule takes goes to it
// (the app's `router`, third in order after a binding and a rule); it may hand the conversation to another session, with a reason, which posts the
// notice; and the app answers the tag with 👀 at once. Nothing is declared on the specialist: remove the `router` line and it is an ordinary one.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../infra/config.js'
import { registry } from '../../../sessions/registry.js'
import { transport } from '../../../sessions/bridge-transport.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { executeTool } from '../../../app/bridge-dispatch.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../sessions/specialists.js'
import { ConversationTable, ROUTED_REACTION, type ConversationConfig, type DeliverResult, type SlackActions, type SlackMessageEvent } from '../watch.js'
import { bindConversation, getConversationTable, slackConversationLink, slackRuntimeDeps, ROUTER_BIND_MAX } from '../runtime.js'
import { BASE, BOT, TWO_APPS, hydra, view } from './slack-config.js'
import { loadHydraConfig } from '../../../config/load.js'
import { isRouter, routerOf, placeOf } from '../../../config/types.js'
import { explain, route } from '../../../routing/route.js'
import { testLoadEnv } from '../../../config/__tests__/load-env.js'

process.stderr.write = (() => true) as any

const OP_TOKEN = (toml: string) => toml.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
/** What the operator adds to the app: where its tag goes that nothing binds and no rule takes. */
const ROUTES_TO = (target: string) => (toml: string) => toml.replace('operator_token_env = "HYDRA_SLACK_USER_TOKEN"', `operator_token_env = "HYDRA_SLACK_USER_TOKEN"\nrouter = "${target}"`)
const PEOPLE = '[people.alice]\naddresses = ["slack:UALICE"]\n'
const ROUTER = '[specialists.slack-router]\nworkdir = "/w/router"\n'
const DESK = '[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:C0DESK"\ntarget = "specialist:desk"\n'
const WITHOUT = OP_TOKEN(`${BASE}${PEOPLE}${ROUTER}${DESK}`)
const WITH = ROUTES_TO('specialist:slack-router')(WITHOUT)
const WITH_MAIN = ROUTES_TO('main')(WITHOUT)
const ELSEWHERE = 'C0ELSE'
const CONV = `slack:${ELSEWHERE}:1000.000001`
const ROUTER_THREAD = '1552619225032425001'
const CANDIDATE_THREAD = '1552619225032425002'
const tag = `<@${BOT}> whose is this?`
/** The router named by an app a specialist is pinned away from. */
const TWO_APPS_ROUTER = TWO_APPS.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\nrouter = "specialist:slack-router"')
const env = testLoadEnv({ home: '/home/op', sessionNames: [] })
const load = (toml: string) => loadHydraConfig(toml, env)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function table(toml: string, a?: SlackActions) {
  const dir = mkdtempSync(join(tmpdir(), 'router-'))
  dirs.push(dir)
  const sent: { to: string; msg: string }[] = []
  const config: ConversationConfig = view(toml, { coalesceMs: 1 })
  const w = new ConversationTable({
    now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => config, alert: () => {},
    deliver: async ({ to }, msg): Promise<DeliverResult> => { sent.push({ to, msg }); return { ok: true } },
  })
  if (a) w.setSlackActions(a)
  return { w, sent }
}
const ev = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({ channel: ELSEWHERE, ts: '1000.000001', user: 'UOP', text: tag, ...over })

describe("the app's router: where a tag goes that no conversation binds and no rule takes", () => {
  test('a tag is unrouted without a router and delivered to it with one; the thread binds to the router', async () => {
    const before = table(WITHOUT)
    expect(before.w.handle(ev())).toBe('unrouted')

    const s = table(WITH)
    expect(s.w.handle(ev())).toBe('mention')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['slack-router'])
    expect(s.w.get(ELSEWHERE, '1000.000001')?.specialist).toBe('slack-router')
  })

  test("order, first match wins: a binding to a session, then a rule matching place, app and sender, then the router", async () => {
    const s = table(WITH)
    s.w.bind(ELSEWHERE, '3000.000001', CANDIDATE_THREAD, 'cli')
    expect(s.w.handle(ev({ ts: '3001.000001', threadTs: '3000.000001' }))).toBe('mention')          // (1) bound to a session
    expect(s.w.handle(ev({ channel: 'C0DESK', ts: '2000.000001' }))).toBe('mention')                // (2) a rule names the place
    expect(s.w.handle(ev({ ts: '4000.000001' }))).toBe('mention')                                   // (3) the router
    await s.w.flush()
    expect(s.sent.map(x => x.to).sort()).toEqual([CANDIDATE_THREAD, 'desk', 'slack-router'].sort())
    expect(s.w.get(ELSEWHERE, '3000.000001')?.specialist).toBe(CANDIDATE_THREAD)
    // The router never sees a bound thread or a message a rule matched: a tag in a thread bound to the router's rival goes on to its binding.
    const bound = table(WITH)
    bound.w.bind(ELSEWHERE, '5000.000001', 'desk', 'cli')
    bound.w.handle(ev({ ts: '5001.000001', threadTs: '5000.000001' }))
    await bound.w.flush()
    expect(bound.sent.map(x => x.to)).toEqual(['desk'])
  })

  test("who may trigger it is the router's own `reachable_by` (people by default): a declared person is heard, a stranger is refused; main is the operator's alone", async () => {
    const s = table(WITH)
    expect(s.w.handle(ev({ user: 'UALICE', ts: '6000.000001' }))).toBe('mention')
    expect(s.w.handle(ev({ user: 'UNOBODY', ts: '6100.000001' }))).toBe('refused')
    await s.w.flush()
    expect(s.sent.map(x => x.to)).toEqual(['slack-router'])
    const narrow = table(WITH.replace('workdir = "/w/router"', 'workdir = "/w/router"\nreachable_by = []'))
    expect(narrow.w.handle(ev({ user: 'UALICE', ts: '6200.000001' }))).toBe('refused')
    expect(narrow.w.handle(ev({ ts: '6300.000001' }))).toBe('mention')

    const main = table(WITH_MAIN)
    expect(main.w.handle(ev())).toBe('mention')
    expect(main.w.handle(ev({ user: 'UALICE', ts: '7000.000001' }))).toBe('refused')
    await main.w.flush()
    expect(main.sent.map(x => x.to)).toEqual(['main'])
  })

  test('only a tag in a channel thread: untagged chatter, an untagged follow-up in an open conversation nobody is bound to, and a DM, do not reach it', async () => {
    const s = table(WITH)
    expect(s.w.handle(ev({ text: 'just talking' }))).toBe('ignored')
    s.w.watch(ELSEWHERE, '2000.000001', undefined as any, undefined, undefined)
    s.w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001', text: 'a follow-up, untagged' }))
    await s.w.flush()
    expect(s.sent).toEqual([])
    const h = hydra(WITH)
    expect(route(h, { from: 'slack:UOP', at: [placeOf('slack', 'channel', ELSEWHERE)], addressed: true, app: 'default' })).toMatchObject({ fate: 'unrouted' })
  })

  test('the log line says where it went: `→ router <name>`', async () => {
    const logs: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'router-'))
    dirs.push(dir)
    const config: ConversationConfig = view(WITH, { coalesceMs: 1 })
    const w = new ConversationTable({ now: () => 1e12, file: join(dir, 'w.json'), log: l => logs.push(l), config: () => config, alert: () => {}, deliver: async () => ({ ok: true }) })
    w.handle(ev())
    expect(logs.join()).toContain('→ router specialist:slack-router for')
    expect(logs.join()).not.toContain('unrouted')
    logs.length = 0
    w.handle(ev({ user: 'UNOBODY', ts: '8000.000001' }))
    expect(logs.join()).toContain('refused')
  })

  test('a router is derived from the apps: it is what an app names, and nothing else is', () => {
    const on = load(WITH)
    const off = load(WITHOUT)
    if (!on.ok || !off.ok) throw new Error('did not load')
    expect(isRouter(on.config, 'slack-router')).toBe(true)
    expect(isRouter(on.config, 'desk')).toBe(false)
    expect(isRouter(on.config, 'main')).toBe(false)
    expect(isRouter(off.config, 'slack-router')).toBe(false)
    expect(routerOf(on.config, 'default')).toBe('slack-router')
    expect(routerOf(off.config, 'default')).toBeUndefined()
  })

  test('a restricted router is a load error that says why; so is a write-confined one; an unrestricted one loads', () => {
    const restricted = load(WITH.replace('workdir = "/w/router"', 'workdir = "/w/router"\nrestricted = true'))
    expect(restricted.ok).toBe(false)
    if (!restricted.ok) expect(restricted.errors.map(e => `${e.path}: ${e.message}`).join('\n')).toContain('slack.apps.default.router: slack-router is restricted, and a router binds conversations to other sessions')
    const confined = load(WITH.replace('workdir = "/w/router"', 'workdir = "/w/router"\ncan_only_write_to = "workdir"'))
    expect(confined.ok).toBe(false)
    if (!confined.ok) expect(confined.errors.map(e => e.message).join('\n')).toContain('slack-router is write-confined')
    // Without `router` the same specialist is fine: the limit comes from being the router, not from the specialist.
    expect(load(WITHOUT.replace('workdir = "/w/router"', 'workdir = "/w/router"\nrestricted = true')).ok).toBe(true)
    expect(load(WITH).ok).toBe(true)
  })

  test('`router` names main or a declared specialist, as a rule\'s target does; a pin that cannot deliver is an error', () => {
    for (const [bad, why] of [['specialist:nobody', 'nobody'], ['thread:123', 'is a thread'], ['slack-router', 'kind']] as const) {
      const r = load(ROUTES_TO(bad)(WITHOUT))
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.errors.map(e => e.message).join('\n')).toContain(why)
    }
    const pinned = load(`${TWO_APPS_ROUTER}[specialists.slack-router]\nworkdir = "/w/router"\npinned_to = ["app:sales"]\n`)
    expect(pinned.ok).toBe(false)
    if (!pinned.ok) expect(pinned.errors.map(e => e.message).join('\n')).toContain('slack-router is pinned to')
  })

  test('the old shape (a rule with no place to main) still routes as before, and the loader names the fix', () => {
    const legacy = load(OP_TOKEN(`${BASE}${PEOPLE}[[rules]]\napp = "app:default"\nperson = "person:op"\ntarget = "main"\n`))
    if (!legacy.ok) throw new Error('did not load')
    expect(legacy.warnings.map(w => w.message).join('\n')).toContain('set `router = "main"` on [slack.apps.default] and remove this rule')
    const named = load(WITH_MAIN)
    if (!named.ok) throw new Error('did not load')
    expect(named.warnings.map(w => w.message).join('\n')).not.toContain('catch-all')
    // A catch-all rule left beside a router takes every tag first: the loader says the router is never reached.
    const shadow = load(WITH + '[[rules]]\napp = "app:default"\nperson = "person:op"\ntarget = "main"\n')
    if (!shadow.ok) throw new Error('did not load')
    expect(shadow.warnings.map(w => w.message).join('\n')).toContain('is never reached')
    // A router is reachable (the app names it) and cannot be restricted: the warning says what to do instead.
    const reach = load(WITH)
    if (!reach.ok) throw new Error('did not load')
    expect(reach.warnings.map(w => w.message).join('\n')).not.toContain('nobody can reach it')
    expect(reach.warnings.map(w => w.message).join('\n')).toContain('it is a router, so it cannot be restricted: narrow reachable_by')
  })

  test('routing and `hydra route` read the same router', () => {
    const h = hydra(WITH)
    const d = route(h, { from: 'slack:UOP', at: [placeOf('slack', 'channel', ELSEWHERE)], addressed: true, tagged: true, app: 'default' })
    expect(d).toMatchObject({ fate: 'deliver', to: 'slack-router', via: 'router' })
    expect(explain(d)).toContain('→ router specialist:slack-router')
  })
})

describe('the ack: a tag that reaches the router is answered with 👀 at once', () => {
  const reactions = () => { const seen: string[] = []; const a: SlackActions = { download: async () => {}, react: async (c, ts, name) => { seen.push(`${c}:${ts}:${name}`) } }; return { a, seen } }

  test('the app reacts 👀 on the tagging message, whatever the place says', async () => {
    const { a, seen } = reactions()
    const s = table(WITH, a)
    s.w.handle(ev())
    await Bun.sleep(5)
    expect(seen).toEqual([`${ELSEWHERE}:1000.000001:${ROUTED_REACTION}`])
    expect(ROUTED_REACTION).toBe('eyes')
  })

  test('also where the router is main; a tag in a thread still bound to the router is answered too', async () => {
    const { a, seen } = reactions()
    const main = table(WITH_MAIN, a)
    main.w.handle(ev())
    const again = table(WITH, a)
    again.w.bind(ELSEWHERE, '2000.000001', 'slack-router', 'cli')
    again.w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001' }))
    await Bun.sleep(5)
    expect(seen.sort()).toEqual([`${ELSEWHERE}:1000.000001:eyes`, `${ELSEWHERE}:2001.000001:eyes`])
  })

  test('no 👀 where the tag goes by a rule or a binding to a session, or is not a tag', async () => {
    const { a, seen } = reactions()
    const s = table(WITH, a)
    s.w.handle(ev({ channel: 'C0DESK', ts: '2000.000001' }))
    s.w.handle(ev({ text: 'no tag', ts: '3000.000001' }))
    s.w.bind(ELSEWHERE, '4000.000001', CANDIDATE_THREAD, 'cli')
    s.w.handle(ev({ ts: '4001.000001', threadTs: '4000.000001' }))
    await Bun.sleep(5)
    expect(seen).toEqual([])
  })

  test('without `router`, the same specialist gets no 👀: it comes from the app, not the specialist', async () => {
    const { a, seen } = reactions()
    const s = table(WITHOUT.replace('[specialists.desk]', '[[rules]]\nplace = "slack:C0ELSE"\ntarget = "specialist:slack-router"\n[specialists.desk]'), a)
    expect(s.w.handle(ev())).toBe('mention')   // a rule takes it
    await Bun.sleep(5)
    expect(seen).toEqual([])
  })
})

describe('the power: bind a conversation it was handed to another session, with a reason', () => {
  const realPost = slackRuntimeDeps.post
  const realView = slackRuntimeDeps.view
  const posts: string[] = []
  const routerSession = { threadId: ROUTER_THREAD }
  const configure = (toml: string) => {
    _setHydraConfigForTesting(hydra(toml))
    const v = view(toml)
    slackRuntimeDeps.view = () => v
  }
  const live = (id: string, threadId: string, over: Record<string, unknown> = {}) => { transport.bridges.set(id, {} as any); registry.set(id, { ...over, sessionId: id, tmuxName: id, threadId, threadUrl: `https://chat.example/t/${threadId}`, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), ...over } as any) }
  const inSessionThreads: string[] = []
  const realSend = gateway.send
  beforeEach(() => {
    posts.length = 0
    inSessionThreads.length = 0
    ;(gateway as any).send = async (to: string, text: string) => { inSessionThreads.push(`${to}|${text}`); return { id: '1', channelId: to } }
    slackRuntimeDeps.post = async (c, t, text) => { posts.push(`${c}|${t ?? '-'}|${text}`); return `${posts.length}.000001` }
    configure(WITH)
    setSpecialistThread('slack-router', ROUTER_THREAD)
    live('slack-router', ROUTER_THREAD)
    live('sw-ledger', CANDIDATE_THREAD)
    live('sw-plain', '1552619225032425003')
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'slack-router', 'cli')
  })
  afterEach(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs)
    for (const id of ['slack-router', 'sw-ledger', 'sw-plain', 'sw-guest', 'sw-locked', 'sw-policy']) { registry.delete(id); transport.bridges.delete(id) }
    ;(gateway as any).send = realSend
    slackRuntimeDeps.post = realPost; slackRuntimeDeps.view = realView
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
    _reloadSpecialists()
  })
  const heldBy = () => getConversationTable().get(ELSEWHERE, '1000.000001')?.specialist

  test('the router binds it to a session by name, with the reason; the notice is in the bound session\'s thread, not the Slack thread, and the binding moves', async () => {
    const out = await bindConversation(routerSession, CONV, { target: 'sw-ledger', why: 'it owns the ledger work' })
    expect(out).toStartWith(`${CONV} → ${CANDIDATE_THREAD}; posted in the session's thread ${CANDIDATE_THREAD}`)
    // Nothing in the Slack thread (its audience is outside hydra); the notice is in the bound session's own thread.
    expect(posts).toEqual([])
    expect(inSessionThreads).toEqual([`${CANDIDATE_THREAD}|→ sw-ledger https://chat.example/t/${CANDIDATE_THREAD}: it owns the ledger work\nSlack conversation: ${slackConversationLink(CONV)}`])
    expect(heldBy()).toBe(CANDIDATE_THREAD)
  })

  test('a hand-off is the router\'s hold, capped: the table can\'t be filled through it; an operator bind is the operator\'s', async () => {
    await bindConversation(routerSession, CONV, { target: 'sw-ledger', why: 'fits' })
    expect(getConversationTable().get(ELSEWHERE, '1000.000001')).toMatchObject({ boundBy: 'router', specialist: CANDIDATE_THREAD })
    for (let i = 2; i <= ROUTER_BIND_MAX; i++) {
      getConversationTable().bind(ELSEWHERE, `${i}000.000001`, 'slack-router', 'cli')
      await bindConversation(routerSession, `slack:${ELSEWHERE}:${i}000.000001`, { target: 'sw-ledger', why: 'fits' })
    }
    getConversationTable().bind(ELSEWHERE, '9999.000001', 'slack-router', 'cli')
    await expect(bindConversation(routerSession, `slack:${ELSEWHERE}:9999.000001`, { target: 'sw-ledger', why: 'x' })).rejects.toThrow(`already holds ${ROUTER_BIND_MAX} conversations it handed on`)
    expect(getConversationTable().get(ELSEWHERE, '9999.000001')?.specialist).toBe('slack-router')
    // main speaks for the operator: not counted against the router.
    getConversationTable().bind(ELSEWHERE, '9999.000001', 'main', 'cli')
    await bindConversation(undefined, `slack:${ELSEWHERE}:9999.000001`, { target: 'sw-ledger', why: 'fits', callerSessionId: 'main' })
    expect(getConversationTable().get(ELSEWHERE, '9999.000001')).toMatchObject({ boundBy: 'cli' })
    // Letting one go frees a place.
    getConversationTable().unwatch(ELSEWHERE, '1000.000001')
    getConversationTable().bind(ELSEWHERE, '9998.000001', 'slack-router', 'cli')
    await bindConversation(routerSession, `slack:${ELSEWHERE}:9998.000001`, { target: 'sw-ledger', why: 'fits' })
  })

  test('by thread id too, and through the bridge tool', async () => {
    const out = await executeTool('bind_conversation', { conversation: CONV, target: `thread:${CANDIDATE_THREAD}`, why: 'fits' }, 'slack-router')
    expect((out.content[0] as { text: string }).text).toContain(`${CONV} → ${CANDIDATE_THREAD}`)
    expect(heldBy()).toBe(CANDIDATE_THREAD)
  })

  test('main may too, for a conversation delivered to it', async () => {
    getConversationTable().bind(ELSEWHERE, '1000.000001', 'main', 'cli')
    await bindConversation(undefined, CONV, { target: 'sw-ledger', why: 'fits', callerSessionId: 'main' })
    expect(heldBy()).toBe(CANDIDATE_THREAD)
  })

  test('any other session is refused, and nothing moves or posts: a plain session, and a specialist that is not the router', async () => {
    await expect(bindConversation({ threadId: '1552619225032425003' }, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('only main and the router')
    setSpecialistThread('desk', '1552619225032425004')
    await expect(bindConversation({ threadId: '1552619225032425004' }, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('only main and the router')
    await expect(bindConversation(undefined, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('only main and the router')
    expect(heldBy()).toBe('slack-router')
    expect(posts).toEqual([])
    // And through the bridge, as the plain session itself.
    await expect(executeTool('bind_conversation', { conversation: CONV, target: 'sw-ledger', why: 'x' }, 'sw-plain')).resolves.toMatchObject({ isError: true })
    expect(heldBy()).toBe('slack-router')
  })

  test('with no rule there is no router: the same specialist is refused', async () => {
    configure(WITHOUT)
    await expect(bindConversation(routerSession, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('only main and the router')
    expect(heldBy()).toBe('slack-router')
  })

  test('never to the router itself, and a reason is required', async () => {
    await expect(bindConversation(routerSession, CONV, { target: 'slack-router', why: 'x' })).rejects.toThrow('is the router')
    await expect(bindConversation(routerSession, CONV, { target: `thread:${ROUTER_THREAD}`, why: 'x' })).rejects.toThrow('is the router')
    // Main may not hand a conversation to the router either: it would come back to it.
    getConversationTable().bind(ELSEWHERE, '2000.000001', 'main', 'cli')
    await expect(bindConversation(undefined, `slack:${ELSEWHERE}:2000.000001`, { target: 'slack-router', why: 'x', callerSessionId: 'main' })).rejects.toThrow('is the router')
    expect(getConversationTable().get(ELSEWHERE, '2000.000001')?.specialist).toBe('main')
    await expect(bindConversation(routerSession, CONV, { target: 'sw-ledger' })).rejects.toThrow('why is required')
    await expect(bindConversation(routerSession, CONV, { target: 'sw-ledger', why: '  ' })).rejects.toThrow('why is required')
    await expect(bindConversation(routerSession, CONV, { why: 'x' })).rejects.toThrow('target must name a session')
    await expect(bindConversation(routerSession, CONV, { target: 'no-such', why: 'x' })).rejects.toThrow('no live session "no-such"')
    expect(heldBy()).toBe('slack-router')
  })

  test("it hands on what it was handed: a conversation bound to someone else, or to no one, is not its to move", async () => {
    getConversationTable().bind(ELSEWHERE, '2000.000001', 'desk', 'cli')
    await expect(bindConversation(routerSession, `slack:${ELSEWHERE}:2000.000001`, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('is bound to desk, not to slack-router')
    await expect(bindConversation(routerSession, `slack:${ELSEWHERE}:9000.000001`, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('not an open conversation')
    expect(getConversationTable().get(ELSEWHERE, '2000.000001')?.specialist).toBe('desk')
  })

  test('never a DM or a channel top level; never a restricted, write-confined or guest session; never a session nobody is home in', async () => {
    getConversationTable().bind('D0DM0001', '__top__', 'slack-router', 'cli')
    await expect(bindConversation(routerSession, 'slack:D0DM0001', { target: 'sw-ledger', why: 'x' })).rejects.toThrow('not a thread in a channel')
    live('sw-guest', '1552619225032425010', { sessionType: 'thread_guest' })
    await expect(bindConversation(routerSession, CONV, { target: 'sw-guest', why: 'x' })).rejects.toThrow('restricted, write-confined or guest')
    configure(`${WITH}[specialists.locked]\nworkdir = "/w/locked"\nrestricted = true\n`)
    setSpecialistThread('locked', '1552619225032425011')
    live('sw-locked', '1552619225032425011')
    await expect(bindConversation(routerSession, CONV, { target: 'sw-locked', why: 'x' })).rejects.toThrow('restricted, write-confined or guest')
    live('sw-policy', '1552619225032425012', { policy: { restricted: true } })
    await expect(bindConversation(routerSession, CONV, { target: 'sw-policy', why: 'x' })).rejects.toThrow('restricted, write-confined or guest')
    transport.bridges.delete('sw-ledger')
    await expect(bindConversation(routerSession, CONV, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('no live session')
    expect(heldBy()).toBe('slack-router')
  })

  test("a router hands on only conversations of the app that names it", async () => {
    configure(`${TWO_APPS_ROUTER.replace('[specialists.slack-router]', '')}${ROUTER}${DESK}`.replace(/\[slack\.apps\.default\]/, '[slack.apps.default]'))
    getConversationTable().bind(ELSEWHERE, '2000.000001', 'slack-router', 'cli', 'sales')
    await expect(bindConversation(routerSession, `slack:sales:${ELSEWHERE}:2000.000001`, { target: 'sw-ledger', why: 'x' })).rejects.toThrow('whose router is not slack-router')
  })

  test('without a target the tool is exactly what it was: a plain session binds the thread to itself', async () => {
    getConversationTable().unwatch(ELSEWHERE, '1000.000001')
    expect(await bindConversation({ threadId: '1552619225032425003' }, CONV)).toContain('is bound to this session')
    expect(heldBy()).toBe('1552619225032425003')
  })
})
