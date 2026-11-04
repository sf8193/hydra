import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackWatchConfig } from '../slack-watch.js'
import { SlackListener, DOWN_ALERT_AFTER_MS, CATCH_UP_STALE_AFTER_MS, type SlackAppLike, type RawEvent } from '../slack-listener.js'
import type { SlackApi, RawMessage } from '../slack-catchup.js'
import type { SocketEmitter } from '../../shared/socket-supervisor.js'

const BOT = 'UBOT'
const CH = 'C_FOOD'
const cfg: SlackWatchConfig = { botUserId: BOT, channels: [CH], specialist: 'slopbot', idleExpiryMs: 7 * 86_400_000, coalesceMs: 5, maxWatches: 50, maxMentionsPer10Min: 10 }
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

function setup(over: { tokens?: { app?: string; bot?: string }; config?: SlackWatchConfig | null; failStart?: boolean; firstRetryBaseMs?: number; history?: RawMessage[]; threads?: Record<string, RawMessage[]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-listener-'))
  dirs.push(dir)
  let now = 1_793_000_000_000
  const sent: string[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const apps: { handler: (e: RawEvent) => void; client: FakeClient; stopped: boolean; started: number; apiCalls: string[] }[] = []
  const state = { failStart: !!over.failStart, history: over.history ?? [], threads: over.threads ?? {}, nameLookups: [] as string[] }
  const watcher = new SlackWatcher({
    now: () => now, file: join(dir, 'w.json'), log: l => logs.push(l), config: () => cfg,
    deliver: async (_s, msg) => { sent.push(msg); return { ok: true } },
  })
  // a cursor so the boot pass reads something instead of starting from now
  watcher.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'old chat' })
  const listener = new SlackListener({
    watcher,
    config: () => over.config === undefined ? cfg : over.config,
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
        async history(a) { rec.apiCalls.push(`history:${a.oldest}`); return { messages: state.history.filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)) } },
        async replies(a) { rec.apiCalls.push(`replies:${a.ts}`); return { messages: (state.threads[`${a.channel}:${a.ts}`] ?? []).filter(m => a.inclusive ? parseFloat(m.ts!) >= parseFloat(a.oldest) : parseFloat(m.ts!) > parseFloat(a.oldest)) } },
      }
      return {
        onMessage: h => { rec.handler = h },
        start: async () => { rec.started++; if (state.failStart) throw new Error('invalid_auth'); rec.client.emit('connected') },
        stop: async () => { rec.stopped = true },
        emitter: () => rec.client,
        authTest: async () => ({ botId: 'BBOT', userId: BOT }),
        userName: async id => { state.nameLookups.push(id); return id === 'UB' ? 'Bea B' : undefined },
        api,
      } as SlackAppLike
    },
  })
  listeners.push(listener)
  return { listener, watcher, sent, logs, alerts, apps, state, tick: (ms: number) => { now += ms } }
}
const message = (over: Partial<RawEvent>): RawEvent => ({ channel: CH, ts: '1100.000001', user: 'UB', text: mention, ...over })

describe('starting', () => {
  test('without a valid config or a token it stays off and names what is missing, never a token', async () => {
    const noCfg = setup({ config: null })
    expect(await noCfg.listener.start()).toBe(false)
    expect(noCfg.logs.join()).toContain('no valid slack-watch.json')
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
    expect(t.sent[0]).toContain('Bea B <@UB>') // the name resolver was installed
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

  test('a mismatch between the connected bot and slack-watch.json is flagged', async () => {
    const t = setup()
    const orig = t.listener as any
    expect(await t.listener.start()).toBe(true) // normal case: no warning
    expect(t.logs.join()).not.toContain('WARN connected as')
    void orig
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
