import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { SlackWatcher } from '../slack-watch.js'
import { hydra as load, oneListener, view, BASE } from './slack-config.js'
import { EMPTY_CONFIG } from '../../config/load.js'
import type { HydraConfig } from '../../config/types.js'
import { SlackListener, DOWN_ALERT_AFTER_MS, CATCH_UP_STALE_AFTER_MS, explainSlackError, type SlackAppLike, type RawEvent } from '../slack-listener.js'
import type { SlackApi, RawMessage } from '../slack-catchup.js'
import type { SocketEmitter } from '../../shared/socket-supervisor.js'

const BOT = 'UBOT'
const CH = 'C0FOOD'
const TOML = oneListener(CH)
const mention = `<@${BOT}> a cart please`
const TOKENS = { app: 'xapp-SECRET-APP', bot: 'xoxb-SECRET-BOT' }

class FakeClient implements SocketEmitter {
  private h = new Map<string, (() => void)[]>()
  on(e: string, fn: () => void) { this.h.set(e, [...(this.h.get(e) ?? []), fn]); return this }
  emit(e: string) { for (const fn of this.h.get(e) ?? []) fn() }
}

const dirs: string[] = []
const listeners: SlackListener[] = []
afterEach(() => { for (const l of listeners.splice(0)) l.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(over: { tokens?: { app?: string; bot?: string }; toml?: string | null; failStart?: boolean; firstRetryBaseMs?: number; scopes?: string[]; historyError?: string; history?: RawMessage[]; threads?: Record<string, RawMessage[]>; duringStart?: (deliverLive: (e: RawEvent) => void) => void; channels?: { id: string; name: string }[]; channelsError?: string } = {}) {
  const toml = over.toml === undefined ? TOML : over.toml
  const h: HydraConfig = toml === null ? EMPTY_CONFIG : load(toml)
  const dir = mkdtempSync(join(tmpdir(), 'slack-listener-'))
  dirs.push(dir)
  let now = 1_793_000_000_000
  const sent: string[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const apps: { handler: (e: RawEvent) => void; client: FakeClient; stopped: boolean; started: number; apiCalls: string[] }[] = []
  const state = { failStart: !!over.failStart, historyError: over.historyError as string | undefined, history: over.history ?? [], threads: over.threads ?? {}, nameLookups: [] as string[] }
  // Before it has connected, the watcher sees the same file through a stand-in view, so setup can lay down a cursor.
  let listener: SlackListener | undefined
  const before = toml === null ? null : view(toml, { names: Object.fromEntries((over.channels ?? []).map(c => [c.id, c.name])) })
  const watcher = new SlackWatcher({
    now: () => now, file: join(dir, 'w.json'), filesDir: join(dir, 'files'), log: l => logs.push(l), config: () => listener?.view() ?? before,
    deliver: async (_s, msg) => { sent.push(msg); return { ok: true } },
  })
  // a cursor so the boot pass reads something instead of starting from now
  watcher.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'old chat' })
  listener = new SlackListener({
    watcher,
    hydra: () => h,
    tokens: () => over.tokens ?? TOKENS,
    now: () => now,
    log: l => logs.push(l),
    alert: t => alerts.push(t),
    fetch: async () => ({ ok: true }),
    ...(over.firstRetryBaseMs !== undefined && { firstRetryBaseMs: over.firstRetryBaseMs }),
    createApp: tokens => {
      expect(tokens).toEqual(TOKENS)
      const rec = { handler: (_: RawEvent) => {}, client: new FakeClient(), stopped: false, started: 0, apiCalls: [] as string[] }
      apps.push(rec)
      const api: SlackApi = {
        async history(a) { rec.apiCalls.push(`history:${a.oldest}`); if (state.historyError) throw new Error(state.historyError); return { messages: state.history.filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)) } },
        async replies(a) { rec.apiCalls.push(`replies:${a.ts}`); return { messages: (state.threads[`${a.channel}:${a.ts}`] ?? []).filter(m => a.inclusive ? parseFloat(m.ts!) >= parseFloat(a.oldest) : parseFloat(m.ts!) > parseFloat(a.oldest)) } },
      }
      return {
        onMessage: h => { rec.handler = h },
        onRename: () => {},
        channels: async () => { if (over.channelsError) throw new Error(over.channelsError); return over.channels ?? [] },
        start: async () => { rec.started++; if (state.failStart) throw new Error('invalid_auth'); over.duringStart?.(rec.handler); rec.client.emit('connected') },
        stop: async () => { rec.stopped = true },
        emitter: () => rec.client,
        authTest: async () => ({ botId: 'BBOT', userId: BOT, url: 'https://x.slack.com/', ...(over.scopes && { scopes: over.scopes }) }),
        userName: async id => { state.nameLookups.push(id); return id === 'UB' ? 'Bea B' : undefined },
        react: async (c, ts, name) => { rec.apiCalls.push(`react:${c}:${ts}:${name}`) },
        download: async (url, dest) => { rec.apiCalls.push(`download:${url}`); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, 'bytes', { mode: 0o600 }) },
        api,
      } as SlackAppLike
    },
  })
  listeners.push(listener!)
  return { listener: listener!, watcher, sent, logs, alerts, apps, state, tick: (ms: number) => { now += ms } }
}
const message = (over: Partial<RawEvent>): RawEvent => ({ channel: CH, ts: '1100.000001', user: 'UB', text: mention, ...over })

describe('diagnosing a refused token', () => {
  test('the scopes the token has are logged, and a token that can read no history is called out', async () => {
    const ok = setup({ scopes: ['channels:history', 'users:read', 'im:history', 'im:read', 'reactions:write'] })
    await ok.listener.start()
    expect(ok.logs.join()).toContain('bot token scopes: channels:history, users:read, im:history, im:read, reactions:write')
    expect(ok.logs.join()).not.toContain('WARN')
    const bad = setup({ scopes: ['chat:write', 'reactions:write'] })
    await bad.listener.start()
    expect(bad.logs.join()).toContain('bot token scopes: chat:write, reactions:write')
    expect(bad.logs.join()).toContain('WARN channels needs channels:history or groups:history, which the bot token lacks')
    expect(bad.logs.join()).toContain('WARN sender names needs users:read')
  })

  test('a live DM with a file: downloaded, delivered to the slack:dm listener, and acked', async () => {
    const t = setup({ toml: TOML + `[people.bea]\nids = ["slack:UB"]\nname = "Bea B"\nroles = ["owner"]\n[specialists.assistant]\nworkdir = "/w/a"\nlistens = ["slack:dm"]\nallow = ["owner"]\n[places."slack:dm"]\nfiles = true\nack = "eyes"\n` })
    await t.listener.start()
    t.apps[0].handler({ channel: 'D0BEA0001', ts: '1793000001.000001', user: 'UB', text: 'see attached', channel_type: 'im',
      files: [{ id: 'F1', name: 'a.pdf', size: 3, url_private_download: 'https://files.slack.com/F1' }] } as RawEvent)
    await t.watcher.flush()
    await Bun.sleep(5)
    expect(t.sent.at(-1)).toContain('person="bea" roles="owner,people,anyone" operator=false address="slack:UB" name="Bea B"]')
    expect(t.apps[0].apiCalls).toContain('download:https://files.slack.com/F1')
    expect(t.apps[0].apiCalls).toContain('react:D0BEA0001:1793000001.000001:eyes')
  })

  test('a live message while the socket is opening does not move a cursor past the downtime gap', async () => {
    // cursor 1000 (from setup); a tag at 1050 while the daemon was down; live chat at 1100 arrives as the socket opens
    const t = setup({
      history: [{ ts: '1050.000001', user: 'UB', text: `${mention} (sent while down)` }, { ts: '1100.000001', user: 'UC', text: 'live chat' }],
      duringStart: live => live({ channel: CH, ts: '1100.000001', user: 'UC', text: 'live chat' }),
    })
    await t.listener.start()
    await t.watcher.flush()
    expect(t.sent.some(m => m.includes('sent while down'))).toBe(true)
    expect(t.watcher.channelCursor(CH)).toBe('1100.000001')
  })

  test('startup names the scopes each enabled option needs, and warns for each one the token lacks', async () => {
    const t = setup({ toml: oneListener('#food', 'slopbot', '["anyone"]', `[places."slack:#food"]\nfiles = true\nack = "eyes"\n`), scopes: ['channels:history', 'users:read', 'im:history'] })
    await t.listener.start()
    const log = t.logs.join()
    expect(log).toContain('enabled options need: channels → channels:history or groups:history; channel names (slack:#name) → channels:read or groups:read; sender names → users:read; dms → im:history; catching up DMs opened while disconnected → im:read; files → files:read; ack and 🚫 reactions → reactions:write')
    expect(log).toContain('WARN files needs files:read')
    expect(log).toContain('WARN ack and 🚫 reactions needs reactions:write')
    expect(log).not.toContain('WARN dms')
  })

  test('a refusal a retry cannot fix is alerted once, at once, with what to do; a good pass re-arms it', async () => {
    const t = setup({ historyError: 'missing_scope: the token needs groups:history and has chat:write' })
    await t.listener.start()
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('missing_scope: the token needs groups:history and has chat:write')
    expect(t.alerts[0]).toContain('[connectors.slack] bot_token_env')
    await t.listener.runCatchUp(true, 'retry')
    expect(t.alerts).toHaveLength(1) // not again for the same cause
    t.state.historyError = undefined
    await t.listener.runCatchUp(true, 'retry')
    expect(t.listener.health().catchUp).toMatchObject({ ok: true })
    t.state.historyError = 'not_in_channel'
    await t.listener.runCatchUp(true, 'retry')
    expect(t.alerts).toHaveLength(2)
    expect(t.alerts[1]).toContain('Invite it to the channel')
  })

  test("an error that is not permanent, such as a rate limit, raises no alert", async () => {
    const t = setup({ historyError: 'An API error occurred: ratelimited' })
    await t.listener.start()
    expect(t.alerts).toHaveLength(0)
  })

  test("Slack's missing_scope names the scope it needed and the ones the token has", () => {
    const sdkError = Object.assign(new Error('An API error occurred: missing_scope'), { data: { ok: false, error: 'missing_scope', needed: 'groups:history', provided: 'chat:write,reactions:write' } })
    expect(explainSlackError(sdkError).message).toBe('missing_scope: the token needs groups:history and has chat:write,reactions:write')
    const other = new Error('boom')
    expect(explainSlackError(other)).toBe(other)
    expect(explainSlackError('plain').message).toBe('plain')
  })
})

describe('starting', () => {
  test('without [connectors.slack] or a token it stays off and names what is missing, never a token', async () => {
    const noCfg = setup({ toml: null })
    expect(await noCfg.listener.start()).toBe(false)
    expect(noCfg.logs.join()).toContain('hydra.toml has no [connectors.slack]')
    const noApp = setup({ tokens: { bot: TOKENS.bot } })
    expect(await noApp.listener.start()).toBe(false)
    expect(noApp.logs.join()).toContain('SLOPBOT_SLACK_APP_TOKEN is not set')
    const noBot = setup({ tokens: { app: TOKENS.app } })
    expect(await noBot.listener.start()).toBe(false)
    expect(noBot.logs.join()).toContain('SLOPBOT_SLACK_BOT_TOKEN is not set')
    for (const t of [noCfg, noApp, noBot]) { expect(t.logs.join()).not.toContain('SECRET'); expect(t.apps).toHaveLength(0) }
    expect(noCfg.listener.health().state).toBe('off')
  })

  test('connects, learns the bot id, reports up, and runs a deep catch-up at boot', async () => {
    const t = setup({
      history: [{ ts: '1050.000001', user: 'UB', text: mention }],
    })
    expect(await t.listener.start()).toBe(true)
    expect(t.apps).toHaveLength(1)
    expect(t.listener.health()).toMatchObject({ state: 'up', downMin: null, catchUp: { ok: true, accepted: 1 } })
    await t.watcher.flush()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('name="Bea B"]') // the name resolver was installed
    expect(t.apps[0].apiCalls[0]).toBe('history:1000.000001')
  })

  test('a failed first connection does not throw: it reports down and keeps the supervisor trying', async () => {
    const t = setup({ failStart: true })
    expect(await t.listener.start()).toBe(true)
    expect(t.logs.join()).toContain('first connection failed')
    expect(['connecting', 'down']).toContain(t.listener.health().state)
    expect(t.logs.join()).not.toContain('SECRET')
  })

  test('a first connection that never came up is retried until it connects, then catches up', async () => {
    const t = setup({ failStart: true, firstRetryBaseMs: 5, history: [{ ts: '1050.000001', user: 'UB', text: mention }] })
    await t.listener.start()
    expect(t.apps[0].started).toBe(1)
    t.state.failStart = false
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10)) }
    await until(() => t.listener.health().state === 'up' && t.listener.health().catchUp !== null)
    expect(t.listener.health()).toMatchObject({ state: 'up', catchUp: { ok: true, accepted: 1 } })
    expect(t.apps.length).toBeGreaterThan(1)
  })

  test('the bot user id, bot id and workspace come from auth.test; channel names from conversations.list', async () => {
    const t = setup({ toml: oneListener('#food'), channels: [{ id: CH, name: 'food' }], history: [{ ts: '1050.000001', user: 'UB', text: mention }] })
    await t.listener.start()
    expect(t.listener.view()).toMatchObject({ botUserId: BOT, botId: 'BBOT', workspaceUrl: 'https://x.slack.com' })
    expect(t.listener.view()!.directory.idOf('food')).toBe(CH)
    await t.watcher.flush()
    expect(t.sent[0]).toContain('place="slack:#food"')
  })

  test('channel names that cannot be read are said once, naming the scopes and the places that hear nothing', async () => {
    const t = setup({ toml: oneListener('#food'), channelsError: 'missing_scope: the token needs channels:read and has chat:write' })
    await t.listener.start()
    await t.listener.runCatchUp(true, 'retry')
    const warns = t.logs.filter(l => l.includes("channel names can't be read"))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('add channels:read and groups:read and reinstall the app, or name channels by id (slack:C…); slack:#food hears nothing until then')
  })
})

describe('live events', () => {
  test('messages reach the watcher; one that throws is logged and does not stop the stream', async () => {
    const t = setup()
    await t.listener.start()
    t.apps[0].handler(message({ ts: '1200.000001' }))
    t.apps[0].handler({ ts: '1300.000001', channel: undefined, text: 'no channel' })
    t.apps[0].handler(null as unknown as RawEvent) // a malformed event must not throw out of the handler
    t.apps[0].handler(message({ ts: '1400.000001', user: 'UC', text: mention }))
    await t.watcher.flush()
    expect(t.sent).toHaveLength(2)
    expect(t.logs.join()).toContain('handling a message failed')
  })
})

describe('catch-up', () => {
  test('every reconnect triggers a deep catch-up, however short the gap', async () => {
    const t = setup({ threads: { [`${CH}:1050.000001`]: [{ ts: '1060.000001', thread_ts: '1050.000001', user: 'UB', text: 'reply during the gap' }] } })
    await t.listener.start()
    t.apps[0].handler(message({ ts: '1050.000001' })) // a watched thread
    await t.watcher.flush()
    const before = t.apps[0].apiCalls.length
    t.apps[0].client.emit('connected') // the SDK reconnected on its own
    await Bun.sleep(20)
    expect(t.apps[0].apiCalls.length).toBeGreaterThan(before)
    expect(t.apps[0].apiCalls.some(c => c === 'replies:1050.000001')).toBe(true)
    await t.watcher.flush()
    expect(t.sent.some(s => s.includes('reply during the gap'))).toBe(true)
  })

  test('a quiet periodic pass raises no alarm; one that finds live-missed messages does, at most hourly', async () => {
    const t = setup()
    await t.listener.start()
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(0)
    t.state.history = [{ ts: '2000.000001', user: 'UB', text: mention }] // the live stream never delivered this
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('never delivered')
    t.state.history = [...t.state.history, { ts: '2100.000001', user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1) // rate limited
  })

  test('finding messages right after a reconnect is expected, not an alarm', async () => {
    const t = setup()
    await t.listener.start()
    t.state.history = [{ ts: '2000.000001', user: 'UB', text: mention }]
    t.apps[0].client.emit('connected')
    await Bun.sleep(20)
    await t.listener.runCatchUp(true, 'periodic') // the first periodic pass after a reconnect
    expect(t.alerts).toHaveLength(0)
  })

  test('one pass at a time: a request during a pass runs once more afterwards', async () => {
    const t = setup()
    await t.listener.start()
    const slow = t.listener.runCatchUp(true, 'periodic')
    const queued = await t.listener.runCatchUp(true, 'periodic')
    expect(queued).toBeNull()
    await slow
    await Bun.sleep(20)
    expect(t.logs.filter(l => l.includes('slack catch-up (queued')).length).toBe(1)
  })
})

describe('health and alerts', () => {
  test('down past five minutes alerts once, and recovery says so once', async () => {
    const t = setup()
    await t.listener.start()
    t.apps[0].client.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    expect(t.listener.health().state).toBe('down')
    await t.listener.checkAlerts()
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('has been down'))).toHaveLength(1)
    t.apps[0].client.emit('connected')
    await t.listener.checkAlerts()
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('connected again'))).toHaveLength(1)
  })

  test('a catch-up that has not completed for a long time alerts once and clears when one completes', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(CATCH_UP_STALE_AFTER_MS + 60_000)
    await t.listener.checkAlerts()
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('catch-up pass has not completed'))).toHaveLength(1)
    await t.listener.runCatchUp(true, 'periodic')
    t.tick(CATCH_UP_STALE_AFTER_MS + 60_000)
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('catch-up pass has not completed'))).toHaveLength(2)
  })

  test('health before start and after stop is off', async () => {
    const t = setup()
    expect(t.listener.health().state).toBe('off')
    await t.listener.start()
    t.listener.stop()
    expect(t.listener.health().state).toBe('off')
    expect(t.apps[0].stopped).toBe(true)
  })
})
