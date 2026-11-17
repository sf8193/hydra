// The operator's DMs on the LIVE socket path, end to end through the real listener and watcher, for each app shape.
// Uses only the repo's public harness (SlackListener, SlackWatcher, slack-config), so it runs unchanged across commits.
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher } from '../watch.js'
import { hydra as load, view } from './slack-config.js'
import { ConnectedApps } from '../apps.js'
import { SlackListener, type SlackAppLike, type RawEvent } from '../listener.js'
import type { SlackApi } from '../catchup.js'
import type { SocketEmitter } from '../../../shared/socket-supervisor.js'
import { createResumeDetector } from '../../../shared/resume.js'

const BOT = 'UBOT'
class FakeClient implements SocketEmitter {
  private h = new Map<string, (() => void)[]>()
  on(e: string, fn: () => void) { this.h.set(e, [...(this.h.get(e) ?? []), fn]); return this }
  emit(e: string) { for (const fn of this.h.get(e) ?? []) fn() }
}
const dirs: string[] = []
const listeners: SlackListener[] = []
afterEach(() => { for (const l of listeners.splice(0)) l.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The operator, and one app named `appName`, with or without the operator's user token. `extra` is more toml. */
const toml = (appName: string, userToken: boolean, extra = '') => `
operator = "op"
${appName === 'default' ? '' : '[slack.apps.default]\nbot_token_env = "OTHER_BOT"\nsocket_token_env = "OTHER_SOCKET"\n'}[slack.apps.${appName}]
bot_token_env = "BOT_TOKEN"
socket_token_env = "SOCKET_TOKEN"
${userToken ? 'operator_token_env = "USER_TOKEN"\n' : ''}[people.op]
addresses = ["slack:UOP"]
[people.alice]
addresses = ["slack:UALICE"]
[specialists.desk]
workdir = "/w/desk"
reachable_by = ["role:anyone"]
${extra}`

function setup(appName: string, userToken: boolean, extra = '', lists: { dms: { channel: string; user?: string }[]; otherParties: { channel: string; user?: string }[] } = { dms: [{ channel: 'D0BOT0001' }], otherParties: [{ channel: 'D0ALICE01', user: 'UALICE' }, { channel: 'D0BOT0001', user: BOT }] }, sibling = false, history: { ts: string; user: string; text: string }[] = []) {
  const shared = new ConnectedApps()
  if (sibling) shared.join('sibling', { botUserId: 'USIB' }, async () => false)
  const h = load(toml(appName, userToken, extra))
  const dir = mkdtempSync(join(tmpdir(), 'live-dm-'))
  dirs.push(dir)
  const now = 1_793_000_000_000
  const sent: { to: string; msg: string }[] = []
  const logs: string[] = []
  let handler: (e: RawEvent) => void = () => {}
  let wire: (e: RawEvent, via: 'bot' | 'user' | 'unknown') => void = () => {}
  const gate = { wait: Promise.resolve() as Promise<unknown> }
  let listener: SlackListener | undefined
  const before = view(toml(appName, userToken, extra), { app: appName })
  const watcher = new SlackWatcher({
    now: () => now, file: join(dir, 'w.json'), filesDir: join(dir, 'files'), log: l => logs.push(l), config: () => listener?.view() ?? before,
    deliver: async (s, msg) => { await gate.wait; sent.push({ to: String((s as { specialist?: string })?.specialist ?? s), msg }); return { ok: true } },
  })
  const client = new FakeClient()
  const api: SlackApi = {
    async history(a) { return { messages: a.channel === 'D0BOT0001' ? history.filter(m => !m.ts || parseFloat(m.ts) > parseFloat(a.oldest)) : [] } },
    otherParties: async () => lists.otherParties,
    dms: async () => lists.dms,
    async replies() { return { messages: [] } },
  }
  listener = new SlackListener({
    watcher, hydra: () => h, app: appName, apps: shared,
    tokens: () => ({ app: 'xapp-S', bot: 'xoxb-S', ...(userToken && { user: 'xoxp-S' }) }),
    now: () => now, log: l => logs.push(l), alert: () => {},
    resumes: createResumeDetector({ now: () => now, lastSleep: async () => null, log: () => {} }),
    fetch: async () => ({ ok: true }), membershipWaitMs: 20,
    createApp: () => ({
      onMessage: fn => { handler = fn }, onWire: fn => { wire = fn }, onReaction: () => {}, onRename: () => {},
      channels: async () => [], start: async () => { client.emit('connected') }, stop: async () => {}, emitter: () => client,
      authTest: async () => ({ botId: 'BBOT', userId: BOT, url: 'https://x.slack.com/' }),
      userName: async () => undefined, react: async () => {}, post: async () => '9.000001',
      download: async () => {}, api,
    } as SlackAppLike),
  })
  listeners.push(listener)
  return { listener, watcher, sent, logs, shared, gate, wire: (e: Partial<RawEvent>, via: 'bot' | 'user' | 'unknown' = 'user') => wire({ ts: '1793000001.000001', user: 'UOP', ...e } as RawEvent, via), raw: (e: Partial<RawEvent>) => handler(e as RawEvent), live: (e: Partial<RawEvent>) => handler({ ts: '1793000001.000001', user: 'UOP', text: 'hi', ...e } as RawEvent) }
}
const settle = async (t: { watcher: SlackWatcher }) => { await Bun.sleep(5); await t.watcher.flush() }

for (const appName of ['default', 'krust']) {
  for (const sibling of [false, true]) for (const userToken of [false, true]) {
    describe(`live DMs: app "${appName}", ${sibling ? 'a sibling app connected, ' : ''}${userToken ? 'with' : 'without'} the operator's user token`, () => {
      const T = (extra = '') => setup(appName, userToken, extra, undefined, sibling)

      test("the operator's DM with the bot reaches main", async () => {
        const t = T()
        await t.listener.start()
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'hello main' })
        await settle(t)
        expect(t.sent.filter(s => s.msg.includes('hello main'))).toHaveLength(1)
        expect(t.sent.find(s => s.msg.includes('hello main'))!.msg).toContain(`place="slack:app-dm:${appName}"`)
      })

      test("the bot's list is empty and only the user's list names the DM as the bot's", async () => {
        const t = setup(appName, userToken, '', { dms: [], otherParties: [{ channel: 'D0BOT0001', user: BOT }] }, sibling)
        await t.listener.start()
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'hello main' })
        await settle(t)
        expect(t.sent.filter(s => s.msg.includes('hello main'))).toHaveLength(1)
      })

      test("a bot event and a user event for the same message deliver it once", async () => {
        const t = T()
        await t.listener.start()
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'hello main', user: 'UOP' })
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'hello main', user: 'UOP', bot_id: undefined })
        await settle(t)
        expect(t.sent.filter(s => s.msg.includes('hello main'))).toHaveLength(1)
      })

      test("a thread reply in the DM, and a second top-level message, reach main", async () => {
        const t = T()
        await t.listener.start()
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'first' })
        await settle(t)
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'second', ts: '1793000002.000001' })
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'in thread', ts: '1793000003.000001', thread_ts: '1793000001.000001' } as Partial<RawEvent>)
        await settle(t)
        for (const w of ['first', 'second', 'in thread']) expect(t.sent.filter(s => s.msg.includes(w))).toHaveLength(1)
      })

      test("a DM opened by the boot catch-up, then a live message in it, reaches main", async () => {
        const t = setup(appName, userToken, '', { dms: [{ channel: 'D0BOT0001', user: 'UOP' }], otherParties: [{ channel: 'D0BOT0001', user: BOT }] }, sibling, [{ ts: '1793000000.000100', user: 'UOP', text: 'owed while down' }])
        await t.listener.start()
        await settle(t)
        expect(t.sent.filter(s => s.msg.includes('owed while down'))).toHaveLength(1)
        t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'live after catch-up', ts: '1793000500.000200' })
        await settle(t)
        expect(t.sent.filter(s => s.msg.includes('live after catch-up'))).toHaveLength(1)
      })

      test("a DM passed over is said in the log with the reason, and one that arrives is said too", async () => {
        if (!userToken) return
        const t = setup(appName, userToken, '', { dms: [], otherParties: [{ channel: 'D0STRANGE', user: 'UNOBODY' }] }, sibling)
        await t.listener.start()
        t.live({ channel: 'D0STRANGE', channel_type: 'im', user: 'UNOBODY', text: 'who am I' })
        await settle(t)
        const log = t.logs.join('')
        expect(log).toContain('heard a message in D0STRANGE')
        expect(log).toMatch(/dropped D0STRANGE 1793000001\.000001 from UNOBODY .*no rule, \[places\] entry or open conversation names this place/)
        expect(t.sent.some(s => s.msg.includes('who am I'))).toBe(false)
      })
    })
  }
}

// Every early return on a DM's path says so in the log, with the reason. A test per reason: deleting one `dropped` call fails its test.
describe('a DM that is passed over says why', () => {
  const logOf = (t: { logs: string[] }) => t.logs.join('')
  const dropped = (channel: string, ts: string, why: RegExp) => new RegExp(`dropped ${channel} ${ts.replace('.', '\\.')} from \\S+ \\(.*\\): .*${why.source}`)
  const OPEN = (sibling = false) => setup('krust', true, '', undefined, sibling)
  const TS = '1793000001.000001'

  test('a subtype that is not heard', async () => {
    const t = OPEN(); await t.listener.start()
    t.live({ channel: 'D0BOT0001', channel_type: 'im', subtype: 'channel_join' })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /subtype channel_join/))
  })
  test("another hydra app's bot", async () => {
    const t = OPEN(true); await t.listener.start()
    t.live({ channel: 'D0BOT0001', channel_type: 'im', user: 'USIB' })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /another hydra app's bot/))
  })
  test('another bot, where the place does not hear bots', async () => {
    const t = OPEN(); await t.listener.start()
    t.live({ channel: 'D0BOT0001', channel_type: 'im', user: undefined, bot_id: 'BOTHER' })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /another bot/))
  })
  test("the bot's own message in a DM", async () => {
    const t = OPEN(); await t.listener.start()
    t.live({ channel: 'D0BOT0001', channel_type: 'im', user: BOT })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /the bot's own message in a DM/))
  })
  test('a message already in flight', async () => {
    const t = OPEN(); await t.listener.start()
    let release!: () => void
    t.gate.wait = new Promise<void>(r => { release = r })
    t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'once' })
    const flushing = t.watcher.flush()
    await Bun.sleep(5)
    t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'once' })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /in flight already/))
    release(); await flushing
  })
  test('a message already delivered', async () => {
    const t = OPEN(); await t.listener.start()
    t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'once' })
    await settle(t)
    t.live({ channel: 'D0BOT0001', channel_type: 'im', text: 'once' })
    expect(logOf(t)).toMatch(dropped('D0BOT0001', TS, /already delivered/))
  })
  test('a DM no rule, place entry or conversation names', async () => {
    const t = setup('krust', true, '', { dms: [], otherParties: [{ channel: 'D0STRANGE', user: 'UNOBODY' }] }); await t.listener.start()
    t.live({ channel: 'D0STRANGE', channel_type: 'im', user: 'UNOBODY' })
    await settle(t)
    expect(logOf(t)).toMatch(dropped('D0STRANGE', TS, /no rule, \[places\] entry or open conversation/))
  })
  test('a refused message heard again is said once more, as already said', async () => {
    const t = setup('krust', true, '[places."slack:person-dm:alice"]\nfiles = true\n', { dms: [], otherParties: [{ channel: 'D0ALICE01', user: 'UALICE' }] }); await t.listener.start()
    t.live({ channel: 'D0ALICE01', channel_type: 'im', user: 'UALICE' })
    await settle(t)
    t.live({ channel: 'D0ALICE01', channel_type: 'im', user: 'UALICE' })
    await settle(t)
    expect(logOf(t)).toMatch(dropped('D0ALICE01', TS, /(unrouted|refused) again, already said/))
  })
  test('an app with no live view, and a timestamp Slack does not write', () => {
    const logs: string[] = []
    const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(tmpdir(), `live-dm-${Math.random()}.json`), log: l => logs.push(l), config: () => null, deliver: async () => ({ ok: true }) })
    expect(w.handle({ channel: 'D0BOT0001', ts: TS, user: 'UOP' })).toBe('ignored')
    expect(logs.join('')).toMatch(dropped('D0BOT0001', TS, /no live view of hydra\.toml/))
    const w2 = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(tmpdir(), `live-dm-${Math.random()}.json`), log: l => logs.push(l), config: () => view(toml('krust', true), { app: 'krust' }), deliver: async () => ({ ok: true }) })
    expect(w2.handle({ channel: 'D0BOT0001', ts: 'not-a-ts', user: 'UOP', app: 'krust' })).toBe('ignored')
    expect(logs.join('')).toMatch(dropped('D0BOT0001', 'not-a-ts', /is not one Slack writes/))
  })
  test('an event with no timestamp, and one with no channel', async () => {
    const t = OPEN(); await t.listener.start()
    t.raw({ channel: 'D0BOT0001', channel_type: 'im', user: 'UOP' })
    expect(logOf(t)).toContain('dropped D0BOT0001: the event has no timestamp')
    t.raw({ ts: TS, type: 'message', subtype: 'weird' })
    expect(logOf(t)).toContain(`dropped: event with no channel (type=message subtype=weird ts=${TS})`)
  })
  test('a DM held to learn whose it is, and released with the answer', async () => {
    const t = setup('krust', true, '', { dms: [], otherParties: [] }); await t.listener.start()
    t.live({ channel: 'D0NEWDM001', channel_type: 'im', user: 'UOP' })
    await settle(t)
    expect(logOf(t)).toContain(`holding D0NEWDM001 ${TS} to learn whose DM it is`)
    expect(logOf(t)).toMatch(/released D0NEWDM001 1793000001\.000001: on neither list/)
  })
  test('a message held while an app is still joining', async () => {
    const t = setup('krust', false, '[[rules]]\nplace = "slack:C0FOOD"\ntarget = "specialist:desk"\n'); await t.listener.start()
    t.shared.expectJoin(['late'])
    t.live({ channel: 'C0FOOD', text: 'a message in a routed channel' })
    await Bun.sleep(30)
    t.shared.failedToJoin('late')
    await Bun.sleep(10)
    expect(logOf(t)).toContain(`held C0FOOD ${TS}: an app is still joining`)
  }, 15_000)
  test('a catch-up message with no timestamp', async () => {
    const t = setup('krust', true, '', { dms: [{ channel: 'D0BOT0001', user: 'UOP' }], otherParties: [] }, false, [{ ts: undefined as unknown as string, user: 'UOP', text: 'no ts' }])
    await t.listener.start()
    await Bun.sleep(20)
    expect(logOf(t)).toContain('catch-up: dropped a message in D0BOT0001 from UOP: it has no timestamp')
  })
  test('the socket layer says a DM arrived, before any filter, with the token it came through', async () => {
    const t = OPEN(); await t.listener.start()
    t.wire({ channel: 'D0BOT0001', channel_type: 'im', subtype: undefined }, 'user')
    expect(logOf(t)).toContain(`krust socket received message in D0BOT0001 (${TS}) from UOP subtype=- bot_id=- via user token`)
    t.wire({ channel: 'C0FOOD', channel_type: 'channel' }, 'bot')
    expect(logOf(t)).not.toContain('message in C0FOOD')
  })
})
