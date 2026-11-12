import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, appOfEntry, conversationId } from '../watch.js'
import { SlackListener, scopesNeeded, DOWN_ALERT_AFTER_MS, CATCH_UP_STALE_AFTER_MS, type SlackAppLike, type RawEvent } from '../listener.js'
import { ConnectedApps, MEMBER_TTL_MS } from '../apps.js'
import { parseConversation } from '../conversation.js'
import { conversationSessionName } from '../../../specialists/targets.js'
import { createResumeDetector } from '../../../shared/resume.js'
import type { SlackApi, RawMessage } from '../catchup.js'
import type { SocketEmitter } from '../../../shared/socket-supervisor.js'
import { hydra as load, sharedChannel, BOT, SALES_BOT, TWO_APPS } from './slack-config.js'
import { SLACK_APP_NEEDS } from '../app.js'

const CH = 'C0FOOD'
const OTHER = 'C0OTHER'
const SALES = 'sales'

class FakeClient implements SocketEmitter {
  private h = new Map<string, (() => void)[]>()
  on(e: string, fn: () => void) { this.h.set(e, [...(this.h.get(e) ?? []), fn]); return this }
  emit(e: string) { for (const fn of this.h.get(e) ?? []) fn() }
}

const dirs: string[] = []
const listeners: SlackListener[] = []
afterEach(() => { for (const l of listeners.splice(0)) l.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type Sent = { to: string; conversation?: string; key: string; msg: string }
type Fake = { client?: FakeClient; historyError?: string; scopes?: string[]; handler: (e: RawEvent) => void; stopped: boolean; calls: string[]; history: RawMessage[]; threads: Record<string, RawMessage[]>; members: Set<string>; probes: string[]; probeError?: string }

/** Two real listeners (the app `default` and `sales`) on one watcher, with fake Slack behind each. */
function setup(toml: string, over: { members?: Record<string, string[]>; probeError?: Record<string, string>; cursors?: Record<string, string>; guard?: (to: string) => { fate: 'deliver'; to: string }; seed?: Record<string, { botUserId: string }>; failStart?: Record<string, number>; firstRetryBaseMs?: number; authGate?: Promise<void>; probeGate?: (channel: string) => Promise<void>; membershipWaitMs?: number; expectJoin?: boolean; scopes?: Record<string, string[]>; historyError?: Record<string, string> } = {}) {
  const h = load(toml)
  const dir = mkdtempSync(join(tmpdir(), 'slack-apps-'))
  dirs.push(dir)
  let now = 1_793_000_000_000
  const sent: Sent[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const alertApps: (string | undefined)[] = []
  const fakes: Record<string, Fake> = {}
  const fails: Record<string, number> = { default: 0, [SALES]: 0 }
  const resumes = createResumeDetector({ now: () => now, lastSleep: async () => null, log: l => logs.push(l) })
  const byId: Record<string, SlackListener> = {}
  const file = join(dir, 'w.json')
  // Cursors laid down before the daemon starts: what each pass reads from.
  if (over.cursors) writeFileSync(file, JSON.stringify({ entries: [], channelCursors: over.cursors }))
  const watcher = new SlackWatcher({
    now: () => now, file, filesDir: join(dir, 'files'), log: l => logs.push(l), config: app => byId[app ?? 'default']?.view() ?? null,
    alert: t => alerts.push(t),
    ...(over.guard && { guard: async (_g, input) => over.guard!(input.to) }),
    deliver: async (t, msg, key) => { sent.push({ to: t.to, ...(t.conversation && { conversation: t.conversation }), key, msg }); return { ok: true } },
  })
  const shared = new ConnectedApps({ now: () => now, log: l => logs.push(l), alert: (t, app) => { alerts.push(t); alertApps.push(app) } })
  if (over.seed) shared.seedIdentities(over.seed)
  if (over.expectJoin) shared.expectJoin(['default', SALES])
  for (const id of ['default', SALES]) {
    const f: Fake = { handler: () => {}, stopped: false, calls: [], history: [], threads: {}, members: new Set(over.members?.[id] ?? []), probes: [], ...(over.probeError?.[id] && { probeError: over.probeError[id] }), ...(over.scopes?.[id] && { scopes: over.scopes[id] }), ...(over.historyError?.[id] && { historyError: over.historyError[id] }) }
    fakes[id] = f
    const l = new SlackListener({
      app: id, apps: shared, watcher, hydra: () => h, now: () => now, resumes, log: x => logs.push(x), alert: t => alerts.push(t),
      fetch: async () => ({ ok: true }), ...(over.membershipWaitMs !== undefined && { membershipWaitMs: over.membershipWaitMs }), firstRetryBaseMs: over.firstRetryBaseMs ?? 3_600_000,
      tokens: () => ({ app: `xapp-${id}`, bot: `xoxb-${id}` }),
      createApp: () => {
        const client = new FakeClient()
        f.client = client
        const api: SlackApi = {
          async history(a) { f.calls.push(`history:${a.channel}`); if (f.historyError) throw new Error(f.historyError); return { messages: f.history.filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)) } },
          async replies(a) { f.calls.push(`replies:${a.channel}:${a.ts}`); return { messages: (f.threads[`${a.channel}:${a.ts}`] ?? []).filter(m => parseFloat(m.ts!) >= parseFloat(a.oldest)) } },
        }
        return {
          onMessage: x => { f.handler = x },
          onRename: () => {},
          channels: async () => [],
          start: async () => { if ((over.failStart?.[id] ?? 0) > fails[id]++) throw new Error('invalid_auth'); client.emit('connected') },
          stop: async () => { f.stopped = true },
          emitter: () => client,
          authTest: async () => { await over.authGate; return { botId: id === 'default' ? 'BDEF' : 'BSAL', userId: id === 'default' ? BOT : SALES_BOT, url: 'https://x.slack.com/', ...(f.scopes && { scopes: f.scopes }) } },
          isMember: async ch => { f.probes.push(ch); await over.probeGate?.(ch); if (f.probeError) throw new Error(f.probeError); return f.members.has(ch) },
          userName: async () => undefined,
          react: async (c, ts, name) => { f.calls.push(`react:${c}:${ts}:${name}`) },
          post: async (c, t, text) => { f.calls.push(`post:${c}:${t ?? '-'}:${text}`); return '9999.000001' },
          download: async () => {},
          api,
        } as SlackAppLike
      },
    })
    byId[id] = l
    listeners.push(l)
  }
  return {
    h, watcher, sent, logs, alerts, alertApps, fakes, listeners: byId, shared, file, dir, tick: (ms: number) => { now += ms },
    start: async () => { for (const l of Object.values(byId)) await l.start() },
    /** The same Slack message, delivered to every app whose bot is in its channel, as Slack does. */
    say: (ev: Partial<RawEvent> & { ts: string }, to: string[] = ['default', SALES]) => { for (const id of to) fakes[id].handler({ channel: CH, user: 'UB', text: 'hello', ...ev }) },
    settle: async () => { await Bun.sleep(10); await watcher.flush() },
  }
}

const LISTEN_ALL = `[places."slack:${CH}"]\nlisten = "all"\n`
const BOTH = { default: [CH, OTHER], [SALES]: [CH] }

describe('two apps in one channel: exactly one answers', () => {
  test('an untagged top-level message goes to the app `default`, once, however many copies Slack sent', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.start()
    t.say({ ts: '1100.000001' })
    await t.settle()
    expect(t.sent.map(s => [s.to, s.conversation])).toEqual([['crm', `slack:${CH}:1100.000001`]])
  })

  test('a tag picks its app: the tagged app answers, through its own conversation, and the other does not', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> a quote` })
    await t.settle()
    expect(t.sent.map(s => [s.to, s.conversation])).toEqual([['deals', `slack:${SALES}:${CH}:1200.000001`]])
    expect(t.watcher.get(CH, '1200.000001', SALES)).toMatchObject({ app: SALES, specialist: 'deals' })
    expect(t.watcher.get(CH, '1200.000001')).toBeUndefined()
    t.say({ ts: '1300.000001', text: `<@${BOT}> hi` })
    await t.settle()
    expect(t.sent.at(-1)).toMatchObject({ to: 'crm', conversation: `slack:${CH}:1300.000001` })
    expect(t.sent).toHaveLength(2)
  })

  test('a thread stays with the app that opened it: an untagged follow-up goes there and nowhere else', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> a quote` })
    await t.settle()
    t.say({ ts: '1201.000001', thread_ts: '1200.000001', user: 'UC', text: 'and a second one' })
    await t.settle()
    expect(t.sent.map(s => [s.to, s.conversation])).toEqual([['deals', `slack:${SALES}:${CH}:1200.000001`], ['deals', `slack:${SALES}:${CH}:1200.000001`]])
    expect(t.sent[1].msg).toContain('and a second one')
  })

  test('a channel only one app is in is that app’s alone, with no one else asked', async () => {
    const t = setup(sharedChannel(OTHER, `[places."slack:${OTHER}"]\nlisten = "all"\n`), { members: BOTH })
    await t.start()
    t.say({ channel: OTHER, ts: '1100.000001' }, ['default'])
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['crm'])
    expect(t.fakes.default.probes).toContain(OTHER)
  })

  test('another app’s bot is another bot: its message is passed over, and one it posts does not echo back', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.start()
    t.say({ ts: '1100.000001', user: SALES_BOT, bot_id: 'BSAL', text: `<@${BOT}> are you there` })
    await t.settle()
    expect(t.sent).toEqual([])
  })

  test('the first message in a channel waits to learn who is in it; messages stay in order', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.start()
    // Not known yet for a channel no pass has read: a second channel, named nowhere.
    t.say({ channel: OTHER, ts: '1100.000001', text: `<@${SALES_BOT}> one` })
    t.say({ channel: CH, ts: '1101.000001', text: `<@${SALES_BOT}> two` })
    await t.settle()
    expect(t.sent.map(s => s.conversation)).toEqual([`slack:${SALES}:${CH}:1101.000001`])
  })
})

describe('membership', () => {
  test('read once per app and channel (never an app’s own), kept for the cache’s time, and read again after a join or a leave', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.start()
    const asked = () => t.fakes.sales.probes.filter(c => c === CH).length
    await t.shared.ensure(CH, 'default')
    expect(asked()).toBe(1)
    expect(t.fakes.default.probes.filter(c => c === CH)).toHaveLength(1)   // `sales` read `default` once when it connected; `default` read no one about itself
    t.say({ ts: '1100.000001' })
    t.say({ ts: '1101.000001' })
    await t.settle()
    expect(asked()).toBe(1)
    t.tick(MEMBER_TTL_MS + 1)
    expect(t.shared.settled(CH, 'default')).toBe(false)
    await t.shared.ensure(CH, 'default')
    expect(asked()).toBe(2)
    t.shared.changed(CH)
    expect(t.shared.settled(CH, 'default')).toBe(false)
  })

  test('with one app connected nothing is asked, and the app hears whatever it receives', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.listeners.default.start()
    t.fakes.default.handler({ channel: CH, ts: '1100.000001', user: 'UB', text: 'hello' })
    await t.settle()
    expect(t.fakes.default.probes).toEqual([])
    expect(t.sent.map(s => s.to)).toEqual(['crm'])
  })

  test('when membership can’t be read, each app answers what it receives, and the operator is told once, with the fix', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH, probeError: { default: 'missing_scope: the token needs channels:read', [SALES]: 'missing_scope: the token needs channels:read' } })
    await t.start()
    t.say({ ts: '1100.000001' })
    t.say({ ts: '1101.000001', text: `<@${SALES_BOT}> ping` })
    await t.settle()
    const said = t.alerts.filter(a => a.includes("can't tell which channels"))
    expect(said).toHaveLength(2)   // once per app
    expect(said[0]).toContain('`default`')
    expect(said[1]).toContain('`sales`')
    expect(said[0]).toContain('channels:read')
    expect(said[0]).toContain('`bot_token_env` of the app named `default`')
    // The alert names its app to the sink, so only the specialists that app serves hear it.
    expect(t.alertApps).toEqual(['default', SALES])
    // Each app is alone in what it knows: the one that received it answers, the other has nothing to answer.
    expect(t.sent.length).toBeGreaterThan(0)
  })
})

describe('a pinned specialist is not reached through another app, even by the guard', () => {
  const guarded = `${sharedChannel(CH, LISTEN_ALL)}[guard]\ncommand = "/bin/true"\n`
  test('a guard that redirects an app’s message to a specialist pinned elsewhere is overruled, once, and the message goes where it was bound', async () => {
    const t = setup(guarded, { members: BOTH, guard: () => ({ fate: 'deliver', to: 'deals' }) })
    await t.start()
    t.say({ ts: '1100.000001' })   // untagged: the app `default` answers, to crm
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['crm'])
    expect(t.logs.join()).toContain('the guard redirected')
    expect(t.alerts.some(a => a.includes('deals is pinned to app sales, and this message came through app default'))).toBe(true)
  })

  test('through its own app the same redirect is honoured', async () => {
    const t = setup(guarded, { members: BOTH, guard: () => ({ fate: 'deliver', to: 'deals' }) })
    await t.start()
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> a quote` })
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['deals'])
  })
})

describe('apps that are still connecting', () => {
  test('nothing about a channel is settled until each expected app has joined or given up', async () => {
    const shared = new ConnectedApps()
    const yes = async () => true
    shared.expectJoin(['default', SALES])
    shared.join('default', { botUserId: BOT }, yes)
    expect(shared.settled(CH, 'default')).toBe(false)
    let ready = false
    void shared.allJoined().then(() => { ready = true })
    await Bun.sleep(1)
    expect(ready).toBe(false)
    shared.failedToJoin(SALES)
    await Bun.sleep(1)
    expect(ready).toBe(true)
    expect(shared.settled(CH, 'default')).toBe(true)   // one app: nothing to tell apart
    shared.join(SALES, { botUserId: SALES_BOT }, yes)
    expect(shared.settled(CH, 'default')).toBe(false)  // two now: who is in the channel is unread
    await shared.ensure(CH, 'default')
    expect(shared.heardBy(CH, 'default')).toEqual(['default', SALES])
    shared.leave(SALES)
    expect(shared.heardBy(CH, 'default')).toEqual(['default'])
    expect(shared.identities()).toEqual({ default: { botUserId: BOT } })
  })

  test('an app that holds a thread keeps its untagged follow-ups even while its connection is down', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    t.watcher.bind(CH, '1200.000001', 'deals', 'tool', SALES)
    await t.listeners.default.start()   // `sales` is not connected
    t.fakes.default.handler({ channel: CH, ts: '1201.000001', thread_ts: '1200.000001', user: 'UB', text: 'and another' })
    await t.settle()
    expect(t.sent).toEqual([])
  })
})

describe('catching up, one pass per app', () => {
  test('each app reads its own history with its own client, and routes what it finds through itself', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, cursors: { [CH]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    t.fakes[SALES].history = [{ ts: '1050.000001', user: 'UB', text: `<@${SALES_BOT}> sent while down` }]
    t.fakes.default.history = [{ ts: '1060.000001', user: 'UB', text: `<@${BOT}> sent while down too` }]
    await t.start()
    await t.watcher.flush()
    expect(t.sent.map(s => [s.to, s.conversation]).sort()).toEqual([['crm', `slack:${CH}:1060.000001`], ['deals', `slack:${SALES}:${CH}:1050.000001`]])
    expect(t.fakes.default.calls.some(c => c.startsWith('history:'))).toBe(true)
    expect(t.fakes[SALES].calls.some(c => c.startsWith('history:'))).toBe(true)
    // Cursors are kept apart: the app `default`'s under the bare channel id, as before, the other's under its id.
    expect(t.watcher.channelCursor(CH)).toBe('1060.000001')
    expect(t.watcher.channelCursor(CH, SALES)).toBe('1050.000001')
    await t.watcher.flush()
    const stored = JSON.parse(readFileSync(t.file, 'utf8'))
    expect(Object.keys(stored.channelCursors).sort()).toEqual([CH, `${SALES}:${CH}`])
  })

  test('an app is asked to read only the channels it can deliver to', async () => {
    // deals (pinned to sales) listens on C0OTHER alone: the app `default` has nothing to do there.
    const toml = sharedChannel(CH).replace(`apps = ["sales"]\nlistens = ["slack:${CH}"]`, `apps = ["sales"]\nlistens = ["slack:${OTHER}"]`)
    expect(toml).toContain(`listens = ["slack:${OTHER}"]`)
    const t = setup(toml, { members: BOTH, cursors: { [CH]: '1000.000001', [`${SALES}:${OTHER}`]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    await t.start()
    expect(t.fakes.default.calls.filter(c => c.startsWith('history:')).map(c => c.slice(8))).toEqual([CH])
    expect(t.fakes[SALES].calls.filter(c => c.startsWith('history:')).map(c => c.slice(8))).toEqual([OTHER])
  })

  test('a thread owed through an app is reread through that app', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    t.watcher.bind(CH, '1500.000001', 'deals', 'tool', SALES)
    await t.start()
    await t.listeners[SALES].runCatchUp(true, 'test')
    expect(t.fakes[SALES].calls).toContain(`replies:${CH}:1500.000001`)
    expect(t.fakes.default.calls).not.toContain(`replies:${CH}:1500.000001`)
  })
})

describe('alerts name the app once there are several', () => {
  test('an overdue catch-up pass says which app', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.tick(60 * 60_000)
    await t.listeners[SALES].checkAlerts()
    await t.listeners.default.checkAlerts()
    expect(t.alerts.some(a => a.startsWith('⚠️ The Slack catch-up pass for the app named `sales` has not completed'))).toBe(true)
    expect(t.alerts.some(a => a.startsWith('⚠️ The Slack catch-up pass for the app named `default` has not completed'))).toBe(true)
  })
})

describe('conversation identity', () => {
  test('the app `default` is written exactly as before; any other has its id first; both parse back', () => {
    expect(conversationId({ channel: 'C0ABC', threadTs: '17.000001' })).toBe('slack:C0ABC:17.000001')
    expect(conversationId({ app: 'default', channel: 'C0ABC', threadTs: '17.000001' })).toBe('slack:C0ABC:17.000001')
    expect(conversationId({ channel: 'D0ABC', threadTs: '0.000000' })).toBe('slack:D0ABC')
    expect(conversationId({ app: 'sales', channel: 'C0ABC', threadTs: '17.000001' })).toBe('slack:sales:C0ABC:17.000001')
    expect(conversationId({ app: 'sales', channel: 'D0ABC', threadTs: '0.000000' })).toBe('slack:sales:D0ABC')
    for (const e of [{ channel: 'C0ABC', threadTs: '17.000001' }, { app: 'sales', channel: 'C0ABC', threadTs: '17.000001' }, { app: 'my-app_2', channel: 'D0ABC', threadTs: '0.000000' }]) {
      expect(parseConversation(conversationId(e))).toEqual(e)
    }
    // The old form is `default`; naming `default` is the same conversation.
    expect(parseConversation('slack:C0ABC:17.000001')).toEqual({ channel: 'C0ABC', threadTs: '17.000001' })
    expect(parseConversation('slack:default:C0ABC:17.000001')).toEqual({ channel: 'C0ABC', threadTs: '17.000001' })
    expect(appOfEntry(parseConversation('slack:C0ABC'))).toBe('default')
    expect(() => parseConversation('slack:Sales:C0ABC:17.000001')).toThrow('conversation must look like')
    expect(() => parseConversation('slack:sales:c0abc')).toThrow('conversation must look like')
  })

  test('a session’s name is unchanged for `default`, and carries the app for any other', () => {
    expect(conversationSessionName('crm', 'slack:C0X:17.01')).toBe('crm_c0x-17-01')
    expect(conversationSessionName('crm', 'slack:D0X')).toBe('crm_d0x')
    expect(conversationSessionName('deals', 'slack:sales:C0X:17.01')).toBe('deals_sales-c0x-17-01')
    expect(conversationSessionName('deals', 'slack:sales:C0X:17.01')).not.toBe(conversationSessionName('deals', 'slack:C0X:17.01'))
  })

  test('the same thread through two apps is two conversations, each with its own idempotency key', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> a quote` })
    await t.settle()
    t.say({ ts: '1201.000001', thread_ts: '1200.000001', text: `<@${BOT}> and you?` })
    await t.settle()
    expect(t.watcher.get(CH, '1200.000001', SALES)).toBeDefined()
    expect(t.watcher.get(CH, '1200.000001')).toBeDefined()
    const keys = t.sent.map(s => s.key)
    expect(keys[0]).toBe(`slack-watch-${SALES}-${CH}-1200.000001-1200.000001-1200.000001-deals`)
    expect(keys[1]).toBe(`slack-watch-${CH}-1200.000001-1201.000001-1201.000001-crm`)
  })
})

describe('what is stored', () => {
  test('a store written before apps loads as the app `default`, and is not rewritten with an app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-store-'))
    dirs.push(dir)
    const file = join(dir, 'w.json')
    const old = { entries: [{ channel: CH, threadTs: '5.000001', specialist: 'crm', createdAt: 1, lastEventAt: 1 }], channelCursors: { [CH]: '9.000001' } }
    writeFileSync(file, JSON.stringify(old))
    const w = new SlackWatcher({ now: () => 5, file, log: () => {}, config: () => null, deliver: async () => ({ ok: true }) })
    expect(w.get(CH, '5.000001')?.specialist).toBe('crm')
    expect(w.get(CH, '5.000001', 'default')?.specialist).toBe('crm')
    expect(w.get(CH, '5.000001', SALES)).toBeUndefined()
    expect(w.channelCursor(CH)).toBe('9.000001')
    expect(w.list().map(appOfEntry)).toEqual(['default'])
    w.bind(CH, '6.000001', 'crm', 'tool')
    w.bind(CH, '6.000001', 'deals', 'tool', SALES)
    await w.flush()
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.entries.find((e: { threadTs: string; app?: string }) => e.threadTs === '5.000001')).not.toHaveProperty('app')
    expect(stored.entries.find((e: { specialist: string }) => e.specialist === 'crm' && true)).not.toHaveProperty('app')
    expect(stored.entries.filter((e: { app?: string }) => e.app === SALES)).toHaveLength(1)
    // And it loads back as it was.
    const again = new SlackWatcher({ now: () => 5, file, log: () => {}, config: () => null, deliver: async () => ({ ok: true }) })
    expect(again.get(CH, '6.000001', SALES)?.specialist).toBe('deals')
    expect(again.get(CH, '6.000001')?.specialist).toBe('crm')
  })

  test('attachments of another app are kept under that app’s own folder', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    const saved: string[] = []
    t.watcher.setSlackActions({ react: async () => {}, download: async (_u, dest) => { saved.push(dest) } }, SALES)
    t.watcher.setSlackActions({ react: async () => {}, download: async (_u, dest) => { saved.push(dest) } })
    // `files` on for the place; one message through each app
    ;(t.h.places as Record<string, { files?: boolean }>)[`slack:${CH}`] = { files: true }
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> see`, files: [{ id: 'F1', name: 'a.pdf', size: 3, url_private_download: 'https://files.slack.com/F1' }] } as Partial<RawEvent> & { ts: string })
    t.say({ ts: '1300.000001', text: `<@${BOT}> see`, files: [{ id: 'F2', name: 'b.pdf', size: 3, url_private_download: 'https://files.slack.com/F2' }] } as Partial<RawEvent> & { ts: string })
    await t.settle()
    expect(saved.map(p => p.slice(t.dir.length + 1))).toEqual([`files/${SALES}/${CH}/F1-a.pdf`, `files/${CH}/F2-b.pdf`])
  })
})

describe('an app that is not connected', () => {
  const tagSales = (ts: string, extra: Partial<RawEvent> = {}) => ({ ts, text: `<@${SALES_BOT}> a quote`, ...extra })

  test('a restart still recognises a tag of an app that has not joined: the tagged app owns it, and the other does not answer', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH, seed: { [SALES]: { botUserId: SALES_BOT } } })
    await t.listeners.default.start()   // `sales` never connects
    t.fakes.default.handler({ channel: CH, user: 'UB', ...tagSales('1100.000001') })
    await t.settle()
    expect(t.sent).toEqual([])
    // An untagged message in the same channel is still answered, once.
    t.fakes.default.handler({ channel: CH, user: 'UB', ts: '1101.000001', text: 'hello' })
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['crm'])
  })

  test('without a saved id, nothing tells a tag of the absent app from chatter: that is why the ids are kept', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH })
    await t.listeners.default.start()
    t.fakes.default.handler({ channel: CH, user: 'UB', ...tagSales('1100.000001') })
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['crm'])   // answered as chatter (listen = "all")
  })

  test('the bot ids are written when an app joins, and read back at the next start', async () => {
    const saved: Record<string, unknown>[] = []
    const first = new ConnectedApps({ persist: ids => saved.push(ids) })
    first.join(SALES, { botUserId: SALES_BOT, botId: 'BSAL' }, async () => true)
    first.join(SALES, { botUserId: SALES_BOT, botId: 'BSAL' }, async () => true)   // unchanged: not written again
    expect(saved).toEqual([{ [SALES]: { botUserId: SALES_BOT, botId: 'BSAL' } }])
    const next = new ConnectedApps()
    next.seedIdentities(saved[0] as Record<string, { botUserId: string }>)
    expect(next.identities()).toEqual({ [SALES]: { botUserId: SALES_BOT, botId: 'BSAL' } })
    expect(next.connectedApps()).toEqual([])   // known, not connected
  })

  test('while a started app has not joined, a message in a named channel is not answered: its cursor is held, and a pass reads it once the app has failed to join', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH, membershipWaitMs: 20, cursors: { [CH]: '1000.000001' } })
    t.shared.expectJoin(['default', SALES], 60_000)
    t.fakes.default.history = []
    await t.listeners.default.start()   // `sales` is started but has not joined
    t.fakes.default.handler({ channel: CH, user: 'UB', ts: '1100.000001', text: 'hello' })
    await Bun.sleep(60)   // past the bounded wait
    await t.watcher.flush()
    expect(t.sent).toEqual([])
    expect(t.watcher.channelCursor(CH)).toBe('1000.000001')   // not advanced: a later pass reads it
    // The pass reads it from history once the other app has given up.
    t.fakes.default.history = [{ ts: '1100.000001', user: 'UB', text: 'hello' }]
    t.shared.failedToJoin(SALES)
    await Bun.sleep(30)
    await t.watcher.flush()
    expect(t.sent.map(s => [s.to, s.conversation])).toEqual([['crm', `slack:${CH}:1100.000001`]])
  })

  test('the flaky second app: it fails to connect, is not waited on, comes up later, and no message is answered twice', async () => {
    const t = setup(sharedChannel(CH, LISTEN_ALL), { members: BOTH, seed: { [SALES]: { botUserId: SALES_BOT } }, failStart: { [SALES]: 1 }, firstRetryBaseMs: 30, membershipWaitMs: 20, expectJoin: true, cursors: { [CH]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    await t.listeners.default.start()
    await t.listeners[SALES].start()   // first connection fails: it gives up joining, and keeps trying
    expect(t.shared.isJoining()).toBe(false)
    t.fakes[SALES].history = [{ ts: '1100.000001', user: 'UB', text: `<@${SALES_BOT}> a quote` }, { ts: '1101.000001', user: 'UB', text: 'hello' }]
    t.fakes.default.handler({ channel: CH, user: 'UB', ...tagSales('1100.000001') })              // tags the absent app
    t.fakes.default.handler({ channel: CH, user: 'UB', ts: '1101.000001', text: 'hello' })       // chatter
    await t.settle()
    expect(t.sent.map(s => s.conversation)).toEqual([`slack:${CH}:1101.000001`])
    // It comes up (its retry), reads what it missed, and answers its tag; the chatter is not answered again.
    for (let i = 0; i < 100 && !t.shared.connectedApps().includes(SALES); i++) await Bun.sleep(20)
    expect(t.shared.connectedApps()).toContain(SALES)
    await Bun.sleep(50)
    await t.watcher.flush()
    expect(t.sent.map(s => [s.to, s.conversation]).sort()).toEqual([['crm', `slack:${CH}:1101.000001`], ['deals', `slack:${SALES}:${CH}:1100.000001`]])
  })

  test('removed while connecting: nothing is left registered, and no one waits on it', async () => {
    let open!: () => void
    const authGate = new Promise<void>(resolve => { open = resolve })
    const t = setup(sharedChannel(CH), { members: BOTH, authGate, expectJoin: true })
    const starting = t.listeners[SALES].start()
    await Bun.sleep(5)
    t.listeners[SALES].stop()   // hot reload took the app out while its connection was opening
    open()
    await starting.catch(() => {})
    expect(t.shared.connectedApps()).not.toContain(SALES)
    expect(t.shared.identities()).not.toHaveProperty(SALES)
    expect(t.fakes[SALES].stopped).toBe(true)
    // `default` is not made to wait on an app that is gone.
    t.shared.failedToJoin('default')
    expect(t.shared.isJoining()).toBe(false)
  })
})

describe('a thread bound through two apps', () => {
  test('an untagged follow-up goes to the app most recently active in it, not the first in hydra.toml', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.watcher.bind(CH, '1200.000001', 'crm', 'tool')
    t.tick(60_000)
    t.watcher.bind(CH, '1200.000001', 'deals', 'tool', SALES)
    t.tick(60_000)
    t.say({ ts: '1201.000001', thread_ts: '1200.000001', user: 'UC', text: 'and another' })
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['deals'])
  })
})

describe('the owner is fixed by the first copy', () => {
  test('if who is in the channel changes between two apps’ copies of one message, still exactly one answers', async () => {
    const t = setup(sharedChannel(CH, `[places."slack:${CH}"]\nlisten = "all"\ndefault_app = "sales"\n`), { members: { default: [CH], [SALES]: [] } })
    await t.start()
    // `default` decides first: `sales` is not known to be in the channel, so it owns the message.
    t.fakes.default.handler({ channel: CH, user: 'UB', ts: '1100.000001', text: 'hello' })
    await t.settle()
    expect(t.sent.map(s => s.to)).toEqual(['crm'])
    // Then `sales` turns out to be in it, and its copy arrives: without the memory it would own it (default_app).
    t.fakes[SALES].members.add(CH)
    t.fakes.default.members.add(CH)
    t.shared.changed(CH)
    t.fakes[SALES].handler({ channel: CH, user: 'UB', ts: '1100.000001', text: 'hello' })
    await t.settle()
    expect(t.sent).toHaveLength(1)
  })
})

describe('bots = true never lets two of hydra’s own apps answer each other', () => {
  test('a sibling app’s message is passed over, another bot’s is heard', async () => {
    const t = setup(sharedChannel(CH, `[places."slack:${CH}"]\nlisten = "all"\nbots = true\n`), { members: BOTH })
    await t.start()
    t.say({ ts: '1100.000001', user: SALES_BOT, bot_id: 'BSAL', text: 'a post from the sales app' }, ['default'])
    t.say({ ts: '1101.000001', user: 'UOTHERBOT', bot_id: 'BOTHER', text: 'a post from somebody’s bot' }, ['default'])
    await t.settle()
    expect(t.sent.map(s => s.conversation)).toEqual([`slack:${CH}:1101.000001`])
  })
})

describe('per-channel queues', () => {
  test('a channel waiting for a membership read does not hold up a settled one', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    const t = setup(sharedChannel(CH, LISTEN_ALL + `[places."slack:${OTHER}"]\nlisten = "all"\n`), { members: BOTH, probeGate: ch => ch === OTHER ? gate : Promise.resolve(), membershipWaitMs: 2_000 })
    await t.start()
    await t.shared.ensure(CH, 'default')
    t.say({ channel: OTHER, ts: '1100.000001' }, ['default'])   // waits on the gated read
    t.say({ ts: '1101.000001' }, ['default'])                    // a settled channel: handled at once
    await Bun.sleep(10)
    await t.watcher.flush()
    expect(t.sent.map(s => s.conversation)).toEqual([`slack:${CH}:1101.000001`])
    open()
    await t.settle()
  })
})

// -- Health is per app ---------------------------------------------------------------------------------------------------

const ALL_SCOPES = ['channels:history', 'channels:read', 'users:read', 'im:history', 'im:read', 'reactions:write', 'chat:write']
const perApp = (text: string, app: string) => (a: string) => a.includes(text) && a.includes(`app named \`${app}\``)

describe('health is per app: A down while B is fine', () => {
  test('a down app is alerted once, by name, and its recovery said once; the other app’s state, catch-up and alerts are untouched', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.fakes[SALES].client!.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    for (const l of Object.values(t.listeners)) { await l.checkAlerts(); await l.checkAlerts() }
    expect(t.listeners[SALES].health().state).toBe('down')
    expect(t.listeners.default.health()).toMatchObject({ state: 'up', downMin: null })
    expect(t.alerts.filter(perApp('has been down', SALES))).toHaveLength(1)
    expect(t.alerts.filter(a => a.includes('has been down') && a.includes('`default`'))).toHaveLength(0)
    t.fakes[SALES].client!.emit('connected')
    for (const l of Object.values(t.listeners)) await l.checkAlerts()
    expect(t.alerts.filter(perApp('connected again', SALES))).toHaveLength(1)
    expect(t.alerts.filter(a => a.includes('connected again') && a.includes('`default`'))).toHaveLength(0)
  })

  test('both down is two alerts, one each: one app’s episode neither hides nor repeats the other’s', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    t.fakes.default.client!.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    await t.listeners.default.checkAlerts()
    t.fakes[SALES].client!.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    for (const l of Object.values(t.listeners)) { await l.checkAlerts(); await l.checkAlerts() }
    expect(t.alerts.filter(a => a.includes('has been down'))).toHaveLength(2)
    expect(t.alerts.filter(perApp('has been down', SALES))).toHaveLength(1)
    expect(t.alerts.filter(perApp('has been down', 'default'))).toHaveLength(1)
  })
})

describe('health is per app: scopes', () => {
  test('a scope missing for one app alerts that app alone, naming the app, the scope and the fix, once; the other app’s check is its own', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, scopes: { default: ALL_SCOPES, [SALES]: ALL_SCOPES.filter(s => s !== 'chat:write') } })
    await t.start()
    await t.listeners[SALES].runCatchUp(true, 'again')
    const said = t.alerts.filter(a => a.includes('bot token'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('The Slack bot token for the app named `sales` lacks chat:write (replies)')
    expect(said[0]).toContain('`hydra slack manifest sales`')
    expect(said[0]).toContain('reinstall')
    expect(t.listeners[SALES].health().missingScopes).toEqual([{ option: 'replies', any: ['chat:write'] }])
    expect(t.listeners.default.health().missingScopes).toEqual([])
  })

  test('a lone `default` says no app, and names the manifest command without one', async () => {
    const t = setup(`${TWO_APPS}`.split('[slack.apps.sales]')[0] + '[specialists.crm]\nworkdir = "/w/crm"\nlistens = ["slack:C0FOOD"]\nallow = ["anyone"]\n', { scopes: { default: ['channels:history'] } })
    await t.listeners.default.start()
    const said = t.alerts.filter(a => a.includes('bot token'))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^⚠️ The Slack bot token lacks /)
    expect(said[0]).toContain('`hydra slack manifest`')
    expect(said[0]).not.toContain('for the app named')
  })

  test('each app is asked only for what it does: no private-channel read without a private place, no im:* without a DM listener', () => {
    const h = load(`operator = "op"
[connectors.slack]
bot_token_env = "A_BOT"
app_token_env = "A_APP"
[slack.apps.sales]
bot_token_env = "S_BOT"
app_token_env = "S_APP"
[people.op]
ids = ["github:op"]
[specialists.crm]
workdir = "/w/crm"
listens = ["slack:G0PRIV"]
allow = ["anyone"]
[specialists.deals]
workdir = "/w/deals"
apps = ["sales"]
listens = ["slack:dm", "slack:${CH}"]
allow = ["anyone"]
`)
    const def = scopesNeeded(h, 'default')
    const sales = scopesNeeded(h, SALES)
    expect(def).toContain(SLACK_APP_NEEDS.membership.private)
    expect(sales).not.toContain(SLACK_APP_NEEDS.membership.private)
    expect(def).not.toContain(SLACK_APP_NEEDS.botScopes.dms)
    expect(sales).toContain(SLACK_APP_NEEDS.botScopes.dms)
    expect(sales).toContain(SLACK_APP_NEEDS.botScopes.dmCatchUp)
    // The channel-name read follows the `#name` places the app reaches.
    expect(def).not.toContain(SLACK_APP_NEEDS.botScopes.channelNames)
  })

  test('an app with no listener of its own at all still needs only the basics', () => {
    const h = load(sharedChannel(CH))
    expect(scopesNeeded(h, SALES).some(n => n === SLACK_APP_NEEDS.botScopes.channels)).toBe(true)
    const none = load(`${TWO_APPS}`)
    expect(scopesNeeded(none, SALES)).not.toContain(SLACK_APP_NEEDS.botScopes.channels)
  })
})

describe('health is per app: catch-up', () => {
  test('one app’s failing catch-up is its own: the other’s pass completes, its health is ok, and only the failing app is alerted once', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, historyError: { [SALES]: 'ratelimited' }, cursors: { [CH]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    await t.start()
    expect(t.listeners.default.health()).toMatchObject({ catchUp: { ok: true }, lastOkCatchUpAgeMin: 0 })
    expect(t.listeners[SALES].health().catchUp).toMatchObject({ ok: false, reason: 'ratelimited' })
    expect(t.listeners[SALES].health().lastOkCatchUpAgeMin).toBeNull()
    t.tick(CATCH_UP_STALE_AFTER_MS + 60_000)
    for (const l of Object.values(t.listeners)) { await l.checkAlerts(); await l.checkAlerts() }
    expect(t.alerts.filter(perApp('catch-up pass', SALES))).toHaveLength(1)
    expect(t.alerts.filter(perApp('catch-up pass', 'default')).length).toBe(1)   // default is overdue too: nothing ran for it since boot
    // The failing app’s alarm is its own: a complete pass of `default` clears default’s, not sales’s.
    await t.listeners.default.runCatchUp(true, 'periodic')
    t.tick(CATCH_UP_STALE_AFTER_MS + 60_000)
    for (const l of Object.values(t.listeners)) await l.checkAlerts()
    expect(t.alerts.filter(perApp('catch-up pass', SALES))).toHaveLength(1)
    expect(t.alerts.filter(perApp('catch-up pass', 'default'))).toHaveLength(2)
  })

  test('a permanent refusal on one app is alerted for that app alone, and the other app’s cursor still advances', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, historyError: { [SALES]: 'missing_scope: the token needs channels:history' }, cursors: { [CH]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    t.fakes.default.history = [{ ts: '1060.000001', user: 'UB', text: 'chatter' }]
    await t.start()
    const refused = t.alerts.filter(a => a.includes('Slack refused the catch-up read'))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('for the app named `sales`')
    expect(t.watcher.channelCursor(CH, SALES)).toBe('1000.000001')
    expect(t.watcher.channelCursor(CH)).toBe('1060.000001')
  })

  test('a slow pass of one app does not hold the other’s', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH })
    await t.start()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    // Hold sales’s next pass inside its directory read: `channels()` is awaited at the start of a pass.
    const salesListener = t.listeners[SALES] as unknown as { app: { channels: () => Promise<unknown[]> } }
    const realChannels = salesListener.app.channels
    salesListener.app.channels = async () => { await gate; return realChannels() }
    const pending = t.listeners[SALES].runCatchUp(true, 'slow')
    const quick = await t.listeners.default.runCatchUp(true, 'quick')
    expect(quick?.complete).toBe(true)
    release()
    expect((await pending)?.complete).toBe(true)
  })
})

describe('health is per app: what an operator reads', () => {
  test('each declared app has a record: its tokens, its connection, and why its membership read failed', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, probeError: { [SALES]: 'missing_scope: channels:read' } })
    await t.start()
    await t.listeners.default.runCatchUp(true, 'periodic')   // asks whether sales is in the channels it reads
    expect(t.shared.probeError(SALES)).toContain('missing_scope')
    expect(t.shared.probeError('default')).toBeUndefined()
  })
})

// -- Acceptance, from the brief's Done-when -------------------------------------------------------------------------------

describe('a two-app config routes, replies and catches up per app', () => {
  test('a message through each app is routed by that app, answered through that app, and caught up with that app’s own client and cursor', async () => {
    const t = setup(sharedChannel(CH), { members: BOTH, cursors: { [CH]: '1000.000001', [`${SALES}:${CH}`]: '1000.000001' } })
    t.fakes[SALES].history = [{ ts: '1050.000001', user: 'UB', text: `<@${SALES_BOT}> while down` }]
    await t.start()
    await t.watcher.flush()
    t.say({ ts: '1100.000001', text: `<@${BOT}> live, default` })
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> live, sales` })
    await t.settle()
    expect(t.sent.map(s => [s.to, s.conversation]).sort()).toEqual([
      ['crm', `slack:${CH}:1100.000001`],
      ['deals', `slack:${SALES}:${CH}:1050.000001`],
      ['deals', `slack:${SALES}:${CH}:1200.000001`],
    ])
    // Replies leave through the app that heard the conversation, and no other.
    await t.listeners[SALES].post(CH, '1200.000001', 'answer')
    await t.listeners.default.post(CH, '1100.000001', 'answer')
    expect(t.fakes[SALES].calls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:1200.000001:answer`])
    expect(t.fakes.default.calls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:1100.000001:answer`])
    // Catch-up: each app’s cursor is its own.
    expect(t.watcher.channelCursor(CH, SALES)).toBe('1200.000001')
    expect(t.watcher.channelCursor(CH)).toBeDefined()   // `default`’s own, under the bare channel id
  })
})

describe('a pinned specialist cannot be reached through any other app', () => {
  test('where only a specialist pinned to sales listens, a tag of the app `default` reaches no one, and a tag of sales reaches it', async () => {
    const toml = `${TWO_APPS}\n[specialists.deals]\nworkdir = "/w/deals"\napps = ["sales"]\nlistens = ["slack:${CH}"]\nallow = ["anyone"]\n`
    const t = setup(toml, { members: BOTH })
    await t.start()
    t.say({ ts: '1100.000001', text: `<@${BOT}> hello?` })
    await t.settle()
    expect(t.sent).toEqual([])
    expect(t.watcher.get(CH, '1100.000001')).toBeUndefined()
    t.say({ ts: '1200.000001', text: `<@${SALES_BOT}> hello?` })
    await t.settle()
    expect(t.sent.map(s => [s.to, s.conversation])).toEqual([['deals', `slack:${SALES}:${CH}:1200.000001`]])
  })
})
