import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { ConversationTable, placesOf, type SlackReactionEvent } from '../watch.js'
import { alsoHeard, hydra as load, hydra, oneListener, view, BASE } from './slack-config.js'
import { EMPTY_CONFIG } from '../../../config/load.js'
import { mustParsePlace, type HydraConfig } from '../../../config/types.js'
import { MARKDOWN_TEXT_MAX } from '../../../shared/slack-client.js'
import { SlackListener, DM_LIST_BACKOFF_MS, postPayload, DOWN_ALERT_AFTER_MS, implicitScopeOptions, scopesNeeded, type ToldScopes, CATCH_UP_STALE_AFTER_MS, EVENTS_OFF_AFTER_PASSES, explainSlackError, readReplies, READ_MAX_PAGES, type SlackAppLike, type RawEvent } from '../listener.js'
import type { SlackApi, RawMessage } from '../catchup.js'
import type { SocketEmitter } from '../../../shared/socket-supervisor.js'
import { createResumeDetector, type LastSleep } from '../../../shared/resume.js'
import { slackHealthLines } from '../../../cli/helpers.js'
import { route } from '../../../routing/route.js'
import { LANDED } from './outcomes.js'

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

type Lister = { channel: string; user?: string }[] | Error | (() => Promise<{ channel: string; user?: string }[]>)
const lister = (name: string, calls: string[], l: Lister | undefined) => l && (async () => { calls.push(name); if (l instanceof Error) throw l; return typeof l === 'function' ? l() : l })
function setup(over: { tokens?: { app?: string; bot?: string }; toml?: string | null; failStart?: boolean; firstRetryBaseMs?: number; scopes?: string[]; historyError?: string; history?: RawMessage[]; threads?: Record<string, RawMessage[]>; duringStart?: (deliverLive: (e: RawEvent) => void) => void; channels?: { id: string; name: string }[]; channelsError?: string; told?: ToldScopes; otherParties?: Lister; dms?: Lister; operatorId?: string; repliesPage?: number } = {}) {
  const toml = over.toml === undefined ? TOML : over.toml
  const h: HydraConfig = toml === null ? EMPTY_CONFIG : load(toml)
  const dir = mkdtempSync(join(tmpdir(), 'slack-listener-'))
  dirs.push(dir)
  let now = 1_793_000_000_000
  const sent: string[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const apps: { handler: (e: RawEvent) => void; react: (e: SlackReactionEvent) => void; client: FakeClient; stopped: boolean; started: number; apiCalls: string[] }[] = []
  const state = { failStart: !!over.failStart, historyError: over.historyError as string | undefined, history: over.history ?? [], threads: over.threads ?? {}, nameLookups: [] as string[], duringHistory: undefined as (() => void) | undefined, network: true, lastSleep: null as Awaited<ReturnType<LastSleep>> }
  const resumes = createResumeDetector({ now: () => now, lastSleep: async () => state.lastSleep, log: l => logs.push(l) })
  // Before it has connected, the watcher sees the same file through a stand-in view, so setup can lay down a cursor.
  let listener: SlackListener | undefined
  const before = toml === null ? null : view(toml, { names: Object.fromEntries((over.channels ?? []).map(c => [c.id, c.name])) })
  const watcher = new ConversationTable({
    now: () => now, file: join(dir, 'w.json'), filesDir: join(dir, 'files'), log: l => logs.push(l), config: () => listener?.view() ?? before,
    deliver: async (_s, msg) => { sent.push(msg); return LANDED },
  })
  // a cursor so the boot pass reads something instead of starting from now
  watcher.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'old chat' })
  listener = new SlackListener({
    watcher,
    hydra: () => h,
    ...(over.told && { told: over.told }),
    tokens: () => over.tokens ?? TOKENS,
    now: () => now,
    log: l => logs.push(l),
    alert: t => alerts.push(t),
    resumes,
    fetch: async () => ({ ok: state.network }),
    ...(over.firstRetryBaseMs !== undefined && { firstRetryBaseMs: over.firstRetryBaseMs }),
    createApp: tokens => {
      expect(tokens).toEqual(TOKENS)
      const rec = { handler: (_: RawEvent) => {}, react: (_: SlackReactionEvent) => {}, client: new FakeClient(), stopped: false, started: 0, apiCalls: [] as string[] }
      apps.push(rec)
      const api: SlackApi = {
        async history(a) { rec.apiCalls.push(`history:${a.oldest}`); state.duringHistory?.(); if (state.historyError) throw new Error(state.historyError); return { messages: state.history.filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)) } },
        ...(over.otherParties && { otherParties: lister('otherParties', rec.apiCalls, over.otherParties) }),
        ...(over.dms && { dms: lister('dms', rec.apiCalls, over.dms) }),
        async replies(a) {
          rec.apiCalls.push(`replies:${a.ts}${a.botOnly ? ':botOnly' : ''}${a.cursor ? `@${a.cursor}` : ''}`)
          const all = (state.threads[`${a.channel}:${a.ts}`] ?? []).filter(m => a.inclusive ? parseFloat(m.ts!) >= parseFloat(a.oldest) : parseFloat(m.ts!) > parseFloat(a.oldest))
          if (!over.repliesPage) return { messages: all }
          // Paged as Slack pages a thread: oldest first, each later page led by the thread's first message again.
          const start = Number(a.cursor ?? 0), end = start + over.repliesPage
          const body = all.slice(start, end)
          return { messages: start > 0 ? [all[0], ...body] : body, ...(end < all.length && { next: String(end) }) }
        },
      }
      return {
        onMessage: h => { rec.handler = h },
        onReaction: h => { rec.react = h },
        onRename: () => {},
        channels: async () => { if (over.channelsError) throw new Error(over.channelsError); return over.channels ?? [] },
        start: async () => { rec.started++; if (state.failStart) throw new Error('invalid_auth'); over.duringStart?.(rec.handler); rec.client.emit('connected') },
        stop: async () => { rec.stopped = true },
        emitter: () => rec.client,
        authTest: async () => ({ botId: 'BBOT', userId: BOT, url: 'https://x.slack.com/', ...(over.scopes && { scopes: over.scopes }) }),
        userName: async id => { state.nameLookups.push(id); return id === 'UB' ? 'Bea B' : undefined },
        react: async (c, ts, name) => { rec.apiCalls.push(`react:${c}:${ts}:${name}`) },
        edit: async (c, ts, text, as) => { rec.apiCalls.push(`edit:${as}:${c}:${ts}:${text}`) },
        remove: async (c, ts, as) => { rec.apiCalls.push(`remove:${as}:${c}:${ts}`) },
        operatorUserId: async () => over.operatorId,
        post: async (c, thread, text, opts) => { rec.apiCalls.push(`post:${c}:${thread ?? '-'}:${text}${opts ? `:${JSON.stringify(opts)}` : ''}`); return '9999.000001' },
        download: async (url, dest) => { rec.apiCalls.push(`download:${url}`); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, 'bytes', { mode: 0o600 }) },
        api,
      } as SlackAppLike
    },
  })
  listeners.push(listener!)
  return {
    listener: listener!, watcher, sent, logs, alerts, apps, state, now: () => now, tick: (ms: number) => { now += ms },
    /** The machine sleeps `ms`; on wake the loop watch hands the gap to the detector, and the bus to the listener. */
    sleep: (ms: number) => {
      now += ms
      state.lastSleep = { sleptAt: now - ms, wokeAt: now }
      resumes.noteResume(ms, now, now - ms)
      listener!.onResume()
    },
  }
}
const message = (over: Partial<RawEvent>): RawEvent => ({ channel: CH, ts: '1100.000001', user: 'UB', text: mention, ...over })

describe('inbound reactions through the connection', () => {
  const ON = oneListener(CH, 'helper', '["role:anyone"]', `[places."slack:${CH}"]\nreactions = "all"\n`)
  const reaction = { channel: CH, itemTs: '1000.000001', reaction: 'white_check_mark', user: 'UB', eventTs: '1200.000001' }

  test('a reaction on a message of a conversation the connection holds is delivered once, even when Slack sends it twice', async () => {
    const t = setup({ toml: ON })
    await t.listener.start()
    t.apps[0].handler(message({ ts: '1000.000001' }))
    await t.watcher.flush()
    t.sent.length = 0
    t.apps[0].react(reaction)
    t.apps[0].react({ ...reaction, eventTs: '1200.000002' })
    await t.watcher.flush()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('reacted :white_check_mark: to https://x.slack.com/archives/C0FOOD/p1000000001')
  })

  test('a reaction while the place has them off is not delivered', async () => {
    const t = setup({ toml: TOML })
    await t.listener.start()
    t.apps[0].handler(message({ ts: '1000.000001' }))
    await t.watcher.flush()
    t.sent.length = 0
    t.apps[0].react(reaction)
    await t.watcher.flush()
    expect(t.sent).toHaveLength(0)
  })

  test('the startup scope check asks for reactions:read only where a place has reactions on', () => {
    const asked = (toml: string) => scopesNeeded(hydra(toml)).some(n => n.any.includes('reactions:read'))
    expect(asked(ON)).toBe(true)
    expect(asked(TOML)).toBe(false)
  })
})

describe('diagnosing a refused token', () => {
  test('the scopes the token has are logged, and a token that can read no history is called out', async () => {
    const ok = setup({ scopes: ['channels:history', 'users:read', 'im:history', 'im:read', 'reactions:write', 'chat:write'] })
    await ok.listener.start()
    expect(ok.logs.join()).toContain('bot token scopes: channels:history, users:read, im:history, im:read, reactions:write, chat:write')
    expect(ok.logs.join()).not.toContain('WARN')
    const bad = setup({ scopes: ['chat:write', 'reactions:write'] })
    await bad.listener.start()
    expect(bad.logs.join()).toContain('bot token scopes: chat:write, reactions:write')
    expect(bad.logs.join()).toContain('WARN channels needs channels:history or groups:history, which the bot token lacks')
    expect(bad.logs.join()).toContain('WARN sender names needs users:read')
  })

  test('a live DM with a file: downloaded, delivered to the slack:app-dm:* listener, and acked', async () => {
    const t = setup({ toml: TOML + `[people.bea]\naddresses = ["slack:UB"]\nname = "Bea B"\nroles = ["owner"]\n[specialists.assistant]\nworkdir = "/w/a"\nreachable_by = ["role:owner"]\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:assistant"\n[places."slack:app-dm:*"]\nfiles = true\nack = "eyes"\n` })
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

  test('a channel no rule names, where the app was tagged before, is held and read from its cursor like a routed one', async () => {
    const ELSE = 'C0ELSE'
    const t = setup({
      history: [{ ts: '1050.000001', user: 'UB', text: mention }],
      duringStart: live => live({ channel: ELSE, ts: '1100.000001', user: 'UC', text: mention }),
    })
    t.watcher.handle({ channel: ELSE, ts: '1000.000001', user: 'UB', text: mention })
    await t.listener.start()
    await t.watcher.flush()
    // the tag at 1050, missed while down, is replayed even though a live tag at 1100 came in while the socket opened
    expect(t.watcher.stats().unrouted).toBe(3)
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('history:'))).toEqual(['history:1000.000001', 'history:1000.000001'])
  })

  test('startup names the scopes each enabled option needs, and warns for each one the token lacks', async () => {
    const t = setup({ toml: oneListener('#food', 'helper', '["role:anyone"]', `[places."slack:#food"]\nfiles = true\nack = "eyes"\n`), scopes: ['channels:history', 'users:read', 'im:history'] })
    await t.listener.start()
    const log = t.logs.join()
    expect(log).toContain('enabled options need: channels → channels:history or groups:history; channel names (slack:#name) → channels:read or groups:read; sender names → users:read; dms → im:history; catching up DMs opened while disconnected → im:read; files → files:read; ack and 🚫 reactions → reactions:write; replies → chat:write')
    expect(log).toContain('WARN files needs files:read')
    expect(log).toContain('WARN ack and 🚫 reactions needs reactions:write')
    expect(log).not.toContain('WARN dms')
  })

  test('a refusal a retry cannot fix is alerted once, at once, with what to do; a good pass re-arms it', async () => {
    const t = setup({ historyError: 'missing_scope: the token needs groups:history and has chat:write' })
    await t.listener.start()
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('missing_scope: the token needs groups:history and has chat:write')
    expect(t.alerts[0]).toContain('`bot_token_env` of hydra (`[slack.apps.default]`)')
    await t.listener.runCatchUp(true, 'retry')
    expect(t.alerts).toHaveLength(1) // not again for the same cause
    t.state.historyError = undefined
    await t.listener.runCatchUp(true, 'retry')
    expect(t.listener.health().catchUp).toMatchObject({ ok: true })
    t.state.historyError = 'not_in_channel'
    await t.listener.runCatchUp(true, 'retry')
    expect(t.alerts).toHaveLength(2)
    expect(t.alerts[1]).toContain('Invite the bot to the channel named above')
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
  test('without a declared app or a token it stays off and names what is missing, never a token', async () => {
    const noCfg = setup({ toml: null })
    expect(await noCfg.listener.start()).toBe(false)
    expect(noCfg.logs.join()).toContain('hydra.toml declares no Slack app: add `[slack.apps.<id>]`')
    const noApp = setup({ tokens: { bot: TOKENS.bot } })
    expect(await noApp.listener.start()).toBe(false)
    expect(noApp.logs.join()).toContain('SLOPBOT_SLACK_APP_TOKEN is not set')
    const noBot = setup({ tokens: { app: TOKENS.app } })
    expect(await noBot.listener.start()).toBe(false)
    expect(noBot.logs.join()).toContain('SLOPBOT_SLACK_BOT_TOKEN is not set')
    expect(noBot.logs.join()).toContain('daemon: slack connector off (')   // the connector's name; "listener" names one app's connection, never the system
    expect(noBot.logs.join()).not.toMatch(/slack listener/i)
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

describe('posting', () => {
  test('a reply posts into the thread, or the top level; it waits for a connection', async () => {
    const t = setup()
    await expect(t.listener.post(CH, '1.000001', 'x')).rejects.toThrow('Slack is not connected')
    await t.listener.start()
    expect(await t.listener.post(CH, '1.000001', 'in the thread')).toBe('9999.000001')
    await t.listener.post('D0A', undefined, 'top level')
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:1.000001:in the thread`, 'post:D0A:-:top level'])
  })
})

describe('posting where link previews are off', () => {
  const off = (extra = '') => oneListener(CH) + `[places."slack:${CH}"]\nlink_previews = false\n${extra}`
  test('a post into a place with link_previews = false asks for no unfurl; a place without the option posts as before', async () => {
    const t = setup({ toml: off() })
    await t.listener.start()
    await t.listener.post(CH, '1.000001', 'see https://example.com')
    await t.listener.post('C0OTHER', undefined, 'elsewhere')
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:1.000001:see https://example.com:{"unfurl":false}`, 'post:C0OTHER:-:elsewhere'])
  })
  test('the place may be named by its channel name once the directory knows it', async () => {
    const t = setup({ toml: oneListener('#food') + '[places."slack:#food"]\nlink_previews = false\n', channels: [{ id: CH, name: 'food' }] })
    await t.listener.start()
    await t.listener.post(CH, undefined, 'x')
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:-:x:{"unfurl":false}`])
  })
  test('a connected app\'s post where link_previews = "single": one link posts as before, two ask for no unfurl', async () => {
    const t = setup({ toml: oneListener(CH) + `[places."slack:${CH}"]\nlink_previews = "single"\n` })
    await t.listener.start()
    await t.listener.post(CH, undefined, 'see https://example.com')
    await t.listener.post(CH, undefined, 'see https://example.com and <https://example.org|this>')
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('post:'))).toEqual([`post:${CH}:-:see https://example.com`, `post:${CH}:-:see https://example.com and <https://example.org|this>:{"unfurl":false}`])
  })
  test('the Slack arguments: unfurl_links and unfurl_media false with the option, and exactly today\'s arguments without it', () => {
    expect(postPayload('C1', '1.0', 'hi', { unfurl: false })).toEqual({ channel: 'C1', markdown_text: 'hi', thread_ts: '1.0', unfurl_links: false, unfurl_media: false })
    expect(postPayload('C1', undefined, 'hi')).toEqual({ channel: 'C1', markdown_text: 'hi' })
    expect(postPayload('C1', '1.0', 'hi', {})).toEqual({ channel: 'C1', markdown_text: 'hi', thread_ts: '1.0' })
  })
  test('a reply goes as markdown_text, so **bold** and tables render; links and code reach Slack byte for byte', () => {
    const md = 'Fixed **it** in [#889](https://github.com/o/r/pull/889)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n```ts\nconst a = `x` < 2 && b > 1\n```'
    const p = postPayload('C1', '1.0', md)
    expect(p.markdown_text).toBe(md)
    expect(p).not.toHaveProperty('text')
  })
  test('a reply with Slack syntax goes as classic text, so a tag still reaches the tagged app (#953)', () => {
    for (const t of ['over to <@U0OTHER> **now**', 'cc <@U0OTHER|opal>', '<!here> heads up', 'see <!subteam^S1|team>', 'in <#C0123|dev>', 'see <https://example.com|this>', 'mail <mailto:a@b.co|a>']) {
      const p = postPayload('C1', '1.0', t)
      expect(p.text).toBe(t)
      expect(p).not.toHaveProperty('markdown_text')
    }
    expect(postPayload('C1', undefined, 'a < b and <https://example.com> and [x](<https://example.com>)')).toHaveProperty('markdown_text')
  })
  test('the cap: at MARKDOWN_TEXT_MAX still markdown_text, one past it classic text, unchanged', () => {
    expect(postPayload('C1', undefined, 'x'.repeat(MARKDOWN_TEXT_MAX))).toHaveProperty('markdown_text')
    const long = 'x'.repeat(MARKDOWN_TEXT_MAX + 1)
    const p = postPayload('C1', undefined, long)
    expect(p.text).toBe(long)
    expect(p).not.toHaveProperty('markdown_text')
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
  /** A message posted just now, on the test clock: inside any window that opened before this moment. `n` keeps two apart. */
  const stamp = (t: { now: () => number }, n: number) => `${Math.floor(t.now() / 1000) - 1}.${String(n).padStart(6, '0')}`
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
    t.tick(60_000)
    t.apps[0].handler(message({ ts: '1900.000001' })) // live events arrive, so the stream is split, not off
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }] // the live stream never delivered this
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('never delivered')
    t.state.history = [...t.state.history, { ts: stamp(t, 2), user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1) // rate limited
  })

  test('a periodic pass that finds only a message older than its window raises no alarm; one posted inside the window still does', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(10 * 60_000)
    // Older than the window that opened at the last complete pass (the way a read brings back a thread's root), though newer than the channel cursor (the live event's).
    t.state.history = [{ ts: '1950.000001', user: 'UB', text: mention }]
    t.apps[0].handler(message({ ts: '1900.000001' })) // live events arrive, so a miss would read as a split
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.logs.some(l => l.includes('catch-up (periodic, deep)') && l.includes('1 message(s)'))).toBe(true) // the pass did accept it
    expect(t.alerts).toHaveLength(0)
    t.tick(10 * 60_000)
    t.state.history = [...t.state.history, { ts: stamp(t, 1), user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('found 1 message(s)')
  })

  /** A pass whose window opened at the boot pass finds one message posted `secondsBefore` seconds before that window opened. */
  const skewPass = async (secondsBefore: number) => {
    const t = setup()
    await t.listener.start()
    const opened = Math.floor(t.now() / 1000)
    t.tick(10 * 60_000)
    t.apps[0].handler(message({ ts: '1900.000001' }))
    t.state.history = [{ ts: `${opened - secondsBefore}.000001`, user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
    return t
  }
  test("the window opens a few seconds early, for the difference between Slack's clock and ours", async () => {
    const near = await skewPass(5)
    expect(near.alerts).toHaveLength(1)
    expect(near.logs.some(l => l.includes('1 message(s) the live stream had not delivered (1 posted since the last complete pass began)'))).toBe(true)
    const far = await skewPass(15)
    expect(far.alerts).toHaveLength(0)
    expect(far.logs.some(l => l.includes('1 message(s) the live stream had not delivered (0 posted since the last complete pass began)'))).toBe(true)
  })

  test('finding messages right after a reconnect is expected, not an alarm', async () => {
    const t = setup()
    await t.listener.start()
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }]
    t.apps[0].client.emit('connected')
    await Bun.sleep(20)
    await t.listener.runCatchUp(true, 'periodic') // the first periodic pass after a reconnect
    expect(t.alerts).toHaveLength(0)
  })

  test('a reconnect while a periodic pass runs is a gap in its window, not another process', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(60_000)
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }]
    t.state.duringHistory = () => { t.state.duringHistory = undefined; t.tick(1_000); t.apps[0].client.emit('connected'); t.tick(1_000) }
    await t.listener.runCatchUp(true, 'periodic') // the wake: the pass starts before the dead socket is replaced
    expect(t.alerts).toHaveLength(0)
    await Bun.sleep(20) // the reconnect's catch-up, queued behind it, closes the window
    expect(t.logs.some(l => l.includes('slack connector: catch-up (queued'))).toBe(true)
    t.tick(10 * 60_000)
    t.apps[0].handler(message({ ts: '2050.000001' }))
    t.state.history = [...t.state.history, { ts: stamp(t, 2), user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic') // no gap since that pass started
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('never delivered')
  })

  test('the pass that starts at a reconnect covers its gap: a message missed after it, with the socket up, alerts', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(60_000)
    t.apps[0].client.emit('reconnecting')
    t.tick(10_000)
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }] // posted during the gap
    t.apps[0].client.emit('connected') // the gap and the reconnect's catch-up start in the same moment
    await Bun.sleep(20)
    expect(t.logs.some(l => l.includes('slack connector: catch-up (reconnected') && l.includes('1 message(s)'))).toBe(true)
    t.tick(10 * 60_000)
    t.apps[0].handler(message({ ts: '2050.000001' }))
    t.state.history = [...t.state.history, { ts: stamp(t, 2), user: 'UB', text: mention }] // after that pass read, socket up
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('the connection stayed up since the previous complete pass began')
  })

  test('a socket closed mid-pass, before the SDK starts reconnecting, is down at pass end: no alert', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(60_000)
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }]
    t.state.duringHistory = () => { t.state.duringHistory = undefined; t.tick(1_000); t.apps[0].client.emit('close') }
    await t.listener.runCatchUp(true, 'periodic') // the ping monitor closed the dead socket mid-pass; reconnecting is 5s away
    expect(t.alerts).toHaveLength(0)
  })

  test('a socket down since before the window is down at pass end: no alert, though no gap lands in the window', async () => {
    const t = setup()
    await t.listener.start()
    t.apps[0].client.emit('close') // down before the last pass started, and never back
    t.tick(60_000)
    await t.listener.runCatchUp(true, 'periodic') // a pass completes while down: the window now starts after the drop
    t.tick(10 * 60_000)
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.alerts).toHaveLength(0)
  })

  test('a resume during a pass is a gap in its window: no "another process?" alert, even with the socket never replaced', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(10 * 60_000)
    t.state.network = false // on wake the network is not back yet, so the supervisor cannot replace the socket
    t.state.history = [{ ts: stamp(t, 1), user: 'UB', text: mention }] // posted while the machine slept
    t.state.duringHistory = () => { t.state.duringHistory = undefined; t.sleep(99 * 60_000) } // the periodic pass overdue at wake runs first
    await t.listener.runCatchUp(true, 'periodic')
    expect(t.apps).toHaveLength(1)
    expect(t.alerts).toHaveLength(0)
  })

  /** One periodic pass, ten minutes on, that finds a message the socket never delivered. */
  const missedPass = async (t: ReturnType<typeof setup>, n: number) => {
    t.tick(10 * 60_000)
    t.state.history = [...t.state.history, { ts: stamp(t, n), user: 'UB', text: mention }]
    await t.listener.runCatchUp(true, 'periodic')
  }

  test(`live events off: ${EVENTS_OFF_AFTER_PASSES} held passes that find socket-missed messages, with nothing live, alert once; a live event clears it`, async () => {
    const t = setup()
    await t.listener.start()
    await t.listener.runCatchUp(true, 'periodic') // the first complete pass opens the window
    for (let n = 1; n < EVENTS_OFF_AFTER_PASSES; n++) await missedPass(t, n)
    expect(t.alerts).toHaveLength(0) // no "another process?" either: nothing arrived live, so the stream is not split
    expect(t.listener.health().eventsOff).toBe(false)
    await missedPass(t, EVENTS_OFF_AFTER_PASSES)
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain(`Slack has probably switched off live events for ${load(TOML).slackApps.default.displayName}:`)
    expect(t.alerts[0]).toContain('turn **Enable Events** back on (Socket Mode needs no Request URL)')
    expect(t.listener.health().eventsOff).toBe(true)
    for (let n = 1; n <= 3; n++) await missedPass(t, EVENTS_OFF_AFTER_PASSES + n)
    expect(t.alerts).toHaveLength(1) // once per episode
    t.tick(60_000)
    t.apps[0].react({ channel: CH, itemTs: '1000.000001', reaction: 'eyes', user: 'UB', eventTs: '4000.000001' }) // the operator turned events back on: any live event ends it
    expect(t.listener.health().eventsOff).toBe(false)
    expect(t.alerts).toHaveLength(2)
    expect(t.alerts[1]).toContain('Live events are arriving again')
    await missedPass(t, 2000) // what the stream missed while it was off: a gap filled, not "another process?"
    expect(t.alerts).toHaveLength(2)
    for (let n = 1; n < EVENTS_OFF_AFTER_PASSES; n++) await missedPass(t, 2000 + n)
    expect(t.alerts).toHaveLength(2) // the count starts again from the live event
  })

  test('messages that catch-up finds after reconnects never count toward live events off', async () => {
    const t = setup()
    await t.listener.start()
    await t.listener.runCatchUp(true, 'periodic')
    for (let n = 1; n <= EVENTS_OFF_AFTER_PASSES + 2; n++) {
      t.tick(10 * 60_000)
      t.apps[0].client.emit('reconnecting')
      t.tick(30_000)
      t.state.history = [...t.state.history, { ts: stamp(t, n), user: 'UB', text: mention }] // posted during the gap
      t.apps[0].client.emit('connected')
      await Bun.sleep(20) // the reconnect's pass fills the gap
      await t.listener.runCatchUp(true, 'periodic')
    }
    expect(t.logs.filter(l => l.includes('catch-up (reconnected') && l.includes('1 message(s)'))).toHaveLength(EVENTS_OFF_AFTER_PASSES + 2)
    expect(t.alerts).toHaveLength(0)
    expect(t.listener.health().eventsOff).toBe(false)
    // Held passes still count from there: the reconnects neither counted nor hid the episode.
    for (let n = 1; n <= EVENTS_OFF_AFTER_PASSES; n++) await missedPass(t, 100 + n)
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('switched off live events')
  })

  test('one pass at a time: a request during a pass runs once more afterwards', async () => {
    const t = setup()
    await t.listener.start()
    const slow = t.listener.runCatchUp(true, 'periodic')
    const queued = await t.listener.runCatchUp(true, 'periodic')
    expect(queued).toBeNull()
    await slow
    await Bun.sleep(20)
    expect(t.logs.filter(l => l.includes('slack connector: catch-up (queued')).length).toBe(1)
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

  test('after a sleep, the catch-up alarm counts awake time, and when it does fire it names the sleep', async () => {
    const t = setup()
    await t.listener.start()
    t.state.historyError = 'ratelimited' // no pass completes from here on
    t.tick(5 * 60_000)
    t.sleep(99 * 60_000)
    await Bun.sleep(20)
    expect(t.logs).toContain('daemon: resumed after 99m (the machine was asleep for 99m)\n')
    expect(t.logs.some(l => l.includes('slack connector: catch-up (resumed, deep): incomplete'))).toBe(true)
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('catch-up pass has not completed'))).toHaveLength(0) // 5 min awake, not 104
    t.tick(CATCH_UP_STALE_AFTER_MS - 5 * 60_000 - 60_000)
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('catch-up pass has not completed'))).toHaveLength(0)
    t.tick(60_000)
    await t.listener.checkAlerts()
    expect(t.alerts).toEqual([`⚠️ The Slack catch-up pass has not completed for 25 min awake (the machine was asleep for 99 min; ratelimited). Live delivery is unaffected, but a gap would not be filled. \`hydra health\` shows the last pass and why it failed.`])
  })

  test('a socket that closed just before a sleep is down for its awake minutes on wake, not the sleep: no down alert', async () => {
    const t = setup()
    await t.listener.start()
    t.state.network = false // the supervisor cannot replace it on wake
    t.apps[0].client.emit('close')
    t.tick(60_000)
    t.sleep(99 * 60_000)
    await Bun.sleep(20)
    expect(t.listener.health()).toMatchObject({ state: 'down', downMin: 1 })
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('has been down'))).toHaveLength(0)
    t.tick(DOWN_ALERT_AFTER_MS)
    await t.listener.checkAlerts()
    expect(t.alerts.filter(a => a.includes('has been down for 6 min'))).toHaveLength(1)
  })

  test('a resume replaces the socket at once and runs one resumed pass', async () => {
    const t = setup()
    await t.listener.start()
    t.tick(5 * 60_000)
    t.sleep(99 * 60_000)
    await Bun.sleep(20)
    expect(t.apps).toHaveLength(2) // a fresh socket, before any timer noticed the old one
    expect(t.logs.filter(l => l.includes('slack connector: catch-up (resumed, deep): done'))).toHaveLength(1)
    expect(t.logs.some(l => l.includes('slack connector: catch-up (reconnected'))).toBe(false)
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

describe('readReplies: the bot first, the operator where the bot is not a member', () => {
  const page = { messages: [{ ts: '1.000002' }] }
  const script = (answers: Record<string, () => Promise<typeof page>>) => {
    const asked: string[] = []
    return { asked, read: (token: string) => { asked.push(token); return answers[token]() } }
  }
  const fail = (msg: string) => () => Promise.reject(new Error(msg))
  const ok = () => Promise.resolve(page)

  test('the bot reads it: one call, no via', async () => {
    const s = script({ xoxb: ok, xoxp: ok })
    expect(await readReplies(s.read, { bot: 'xoxb', user: 'xoxp' })).toEqual(page)
    expect(s.asked).toEqual(['xoxb'])
  })

  test("the bot isn't a member: read as the operator, via 'user'; the bot is still asked first, so an invite moves it back", async () => {
    const s = script({ xoxb: fail('An API error occurred: not_in_channel'), xoxp: ok })
    expect(await readReplies(s.read, { bot: 'xoxb', user: 'xoxp' })).toEqual({ ...page, via: 'user' })
    expect(s.asked).toEqual(['xoxb', 'xoxp'])
  })

  test('without a user token, or on any other bot error, the bot error stands', async () => {
    await expect(readReplies(script({ xoxb: fail('An API error occurred: not_in_channel') }).read, { bot: 'xoxb' })).rejects.toThrow('not_in_channel')
    const s = script({ xoxb: fail('An API error occurred: ratelimited'), xoxp: ok })
    await expect(readReplies(s.read, { bot: 'xoxb', user: 'xoxp' })).rejects.toThrow('ratelimited')
    expect(s.asked).toEqual(['xoxb'])
  })

  test("the operator can't read it either: the bot's not_in_channel is kept, so catch-up lets go of that thread", async () => {
    for (const why of ['not_in_channel', 'thread_not_found']) {
      const s = script({ xoxb: fail('An API error occurred: not_in_channel'), xoxp: fail(`An API error occurred: ${why}`) })
      await expect(readReplies(s.read, { bot: 'xoxb', user: 'xoxp' })).rejects.toThrow(`not_in_channel; as the operator: An API error occurred: ${why}`)
    }
  })

  test("a refused operator token is said as such: catch-up skips the thread and keeps it", async () => {
    for (const why of ['token_revoked', 'invalid_auth', 'missing_scope: the token needs groups:history']) {
      const s = script({ xoxb: fail('An API error occurred: not_in_channel'), xoxp: fail(`An API error occurred: ${why}`) })
      const err = await readReplies(s.read, { bot: 'xoxb', user: 'xoxp' }).then(() => new Error('read'), (e: Error) => e)
      expect(err.message).toBe(`the operator's Slack token was refused (An API error occurred: ${why})`)
      expect(err.message).not.toContain('not_in_channel')
    }
  })

  test("a passing failure of the operator's read is thrown as itself, without not_in_channel: the pass retries, nothing is let go", async () => {
    const s = script({ xoxb: fail('An API error occurred: not_in_channel'), xoxp: fail('An API error occurred: ratelimited') })
    const err = await readReplies(s.read, { bot: 'xoxb', user: 'xoxp' }).then(() => new Error('read'), (e: Error) => e)
    expect(err.message).toBe('An API error occurred: ratelimited')
  })
})

describe('an old single-app config runs unchanged', () => {
  const ALL = ['channels:history', 'users:read', 'im:history', 'im:read', 'reactions:write', 'chat:write']
  test('routes: a tag in the listened channel goes to its specialist, and the conversation id has no app in it', async () => {
    const t = setup({ scopes: ALL })
    await t.listener.start()
    const d = route(t.listener.view()!.hydra, { from: 'slack:UB', at: [`slack:${CH}`].map(mustParsePlace), addressed: true, app: 'default' })
    expect(d).toMatchObject({ fate: 'deliver', to: 'helper', via: 'rule' })
    t.apps[0].handler(message({ ts: '1100.000001' }))
    await t.watcher.flush()
    expect(t.watcher.get(CH, '1100.000001')).toMatchObject({ specialist: 'helper' })
    expect(t.watcher.get(CH, '1100.000001')!.app).toBeUndefined()
  })

  test('health: the one line it always printed, and `listener` still there beside `apps`', async () => {
    const t = setup({ scopes: ALL })
    await t.listener.start()
    const h = t.listener.health()
    expect(h).toMatchObject({ state: 'up', downMin: null, catchUp: { ok: true }, missingScopes: [] })
    expect(slackHealthLines({ listener: h, apps: { default: h }, conversations: 1, readAsOperator: 0, owed: 0, oldestOwedAgeMin: null })).toEqual(['slack connector: up · catch-up ok 0 min ago · 1 conversation · 0 owed'])
    expect(slackHealthLines({ conversations: 0, readAsOperator: 0, owed: 3, oldestOwedAgeMin: 12 })).toEqual(['slack connector: off · 0 conversations · 3 owed, oldest 12 min'])
  })

  test('nothing the connector logs or alerts calls it a listener, and every "slack" log prefix says "slack connector"', async () => {
    const off = setup({ tokens: { app: TOKENS.app } })
    await off.listener.start()
    const t = setup({ scopes: [] })
    await t.listener.start()
    await t.listener.runCatchUp(true, 'retry')
    t.apps[0].client.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    await t.listener.checkAlerts()
    const said = [...off.logs, ...t.logs, ...t.alerts]
    expect(said.length).toBeGreaterThan(3)
    for (const l of said) expect(l).not.toMatch(/slack listener/i)
    for (const l of [...off.logs, ...t.logs]) if (/^daemon: slack/.test(l)) expect(l).toStartWith('daemon: slack connector')
  })

  test('alert wording: no app is named', async () => {
    const t = setup({ scopes: ALL })
    await t.listener.start()
    t.apps[0].client.emit('disconnected')
    t.tick(DOWN_ALERT_AFTER_MS + 60_000)
    await t.listener.checkAlerts()
    t.apps[0].client.emit('connected')
    await t.listener.checkAlerts()
    expect(t.alerts).toEqual([
      '⚠️ The Slack connector has been down for 6 min awake. Mentions are not arriving live; the catch-up pass replays them once it reconnects. Check the tokens and the app\'s Socket Mode setting at api.slack.com/apps; `hydra health` shows its state.',
      '✅ The Slack connector is connected again.',
    ])
  })

  test('the scope check names the fix without an app', async () => {
    const t = setup({ scopes: ['channels:history'] })
    await t.listener.start()
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toMatch(/^⚠️ The Slack bot token lacks users:read \(sender names\); /)
    expect(t.alerts[0]).toContain('`hydra slack manifest`')
  })
})

describe('the scope check alerts for what was declared, once per episode', () => {
  const FULL = ['channels:history', 'users:read', 'im:history', 'im:read', 'reactions:write', 'chat:write']
  const without = (...gone: string[]) => FULL.filter(sc => !gone.includes(sc))
  const memory = (): ToldScopes => { const m = new Map<string, string>(); return { get: a => m.get(a), set: (a, k) => { if (k === null) m.delete(a); else m.set(a, k) } } }

  test('a token with no im:* where only the operator’s own Slack address asks for DMs: no alert at boot, and health says what is missing', async () => {
    // BASE: the operator has a Slack address; a specialist listens on a channel; nothing names slack:app-dm:*.
    const t = setup({ scopes: without('im:history', 'im:read') })
    await t.listener.start()
    expect(t.alerts).toEqual([])
    expect(t.listener.health().missingScopes?.map(m => m.any[0])).toEqual(['im:history', 'im:read'])
    expect(t.logs.join()).toContain('WARN dms needs im:history')
    expect(implicitScopeOptions(t.listener.view()!.hydra)).toEqual(['dms', 'catching up DMs opened while disconnected'])
    expect(slackHealthLines({ listener: t.listener.health(), conversations: 0, readAsOperator: 0, owed: 0, oldestOwedAgeMin: null })[0]).toContain('· missing im:history (dms); im:read (catching up DMs opened while disconnected)')
  })

  test('the same DM scopes, when a specialist names slack:app-dm:*, are declared: they alert', async () => {
    const t = setup({ scopes: without('im:history', 'im:read'), toml: alsoHeard(oneListener(CH, "helper", "[\"role:anyone\"]"), "helper", "slack:app-dm:*") })
    await t.listener.start()
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('im:history (dms)')
  })

  test('a declared place’s missing scope alerts once; a second boot does not say it again; complete again, then missing again, alerts again', async () => {
    const told = memory()
    const boot = async (scopes: string[]) => { const t = setup({ scopes, told }); await t.listener.start(); return t }
    const first = await boot(without('channels:history'))
    expect(first.alerts).toHaveLength(1)
    expect(first.alerts[0]).toContain('channels:history or groups:history (channels)')
    expect((await boot(without('channels:history'))).alerts).toEqual([])   // the next boot: the same episode
    expect((await boot(FULL)).alerts).toEqual([])                          // complete again: the episode ends
    expect((await boot(without('channels:history'))).alerts).toHaveLength(1)
  })

  test('within one run, a reconnect that finds the same scope missing says nothing more', async () => {
    const t = setup({ scopes: without('channels:history') })
    await t.listener.start()
    t.apps[0].client.emit('disconnected')
    t.apps[0].client.emit('connected')
    await Bun.sleep(10)
    expect(t.alerts.filter(a => a.includes('bot token'))).toHaveLength(1)
  })
})

describe("the operator's own app hears DMs and group DMs", () => {
  const USER = (toml: string) => toml.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
  const CONF = (rules: string) => USER(oneListener(CH, 'helper', '["role:anyone"]', `[people.alice]\naddresses = ["slack:UALICE"]\n[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = ["role:anyone"]\n${rules}`))
  const BOT_LIST = [{ channel: 'D0BOT0001', user: 'UOP' }]
  const USER_LIST = [{ channel: 'D0BOT0001', user: BOT }, { channel: 'D0ALICE01', user: 'UALICE' }, { channel: 'D0NOBODY1', user: 'UNOBODY' }]
  const reads = (t: ReturnType<typeof setup>, name: string) => t.apps[0].apiCalls.filter(c => c === name).length
  const live = (t: ReturnType<typeof setup>, e: Partial<RawEvent>) => { t.apps[0].handler({ ts: '1793000001.000001', user: 'UALICE', text: 'hi', ...e } as RawEvent) }
  const settle = async (t: ReturnType<typeof setup>) => { await Bun.sleep(5); await t.watcher.flush() }
  const RULE = '[[rules]]\nplace = "slack:person-dm:alice"\ntarget = "specialist:desk"\n'

  test("the bot's own DM list says which DM is the bot's (the operator's goes to main); the user's list names a DM with a person, or nobody", async () => {
    const t = setup({ toml: CONF(RULE), dms: BOT_LIST, otherParties: USER_LIST })
    await t.listener.start()
    const opened = t.watcher.list().length
    live(t, { channel: 'D0BOT0001', user: 'UOP', channel_type: 'im', text: 'to the bot' })
    live(t, { channel: 'D0ALICE01', ts: '1793000002.000001', channel_type: 'im', text: 'from alice' })
    live(t, { channel: 'D0NOBODY1', ts: '1793000003.000001', user: 'UNOBODY', channel_type: 'im', text: 'from someone not in people' })
    await settle(t)
    expect(t.sent.filter(m => m.includes('place="slack:app-dm:default"'))).toHaveLength(1)
    expect(t.sent.filter(m => m.includes('place="slack:person-dm:alice"'))).toHaveLength(1)
    expect(t.sent.some(m => m.includes('not in people'))).toBe(false)
    expect(t.watcher.list().length).toBe(opened + 2)
    expect(reads(t, 'otherParties')).toBe(1)
    expect(t.apps[0].apiCalls.filter(c => c.startsWith('react:'))).toEqual([])
  })

  test("without the user scope the lookup fails: the DM with the bot still works, a DM with a person is dropped, and the log says why", async () => {
    const t = setup({ toml: CONF(RULE), dms: BOT_LIST, otherParties: new Error('missing_scope') })
    await t.listener.start()
    live(t, { channel: 'D0BOT0001', user: 'UOP', channel_type: 'im', text: 'to the bot' })
    live(t, { channel: 'D0ALICE01', ts: '1793000002.000001', channel_type: 'im', text: 'from alice' })
    await settle(t)
    expect(t.sent.some(m => m.includes('to the bot') && m.includes('place="slack:app-dm:default"'))).toBe(true)
    expect(t.sent.some(m => m.includes('from alice'))).toBe(false)
    expect(t.logs.join()).toContain('needs im:read on the user token')
  })

  test('a failed user list is read once a minute however many DMs ask; the next window reads again', async () => {
    const t = setup({ toml: CONF(''), dms: BOT_LIST, otherParties: new Error('missing_scope') })
    await t.listener.start()
    const base = reads(t, 'otherParties')   // the read at connect failed
    live(t, { channel: 'D0ALICE01', channel_type: 'im', text: 'one' })
    live(t, { channel: 'D0BOB00001', ts: '1793000002.000001', channel_type: 'im', text: 'two' })
    await settle(t)
    expect(reads(t, 'otherParties') - base).toBe(0)
    // A failed lookup never names a DM as the bot's: the operator's own message there goes nowhere, opens nothing, and is not slack:app-dm:*.
    const opened = t.watcher.list().length
    live(t, { channel: 'D0ALICE01', ts: '1793000003.000001', user: 'UOP', channel_type: 'im', text: 'the operator, in a DM the lookup could not name' })
    await settle(t)
    expect(t.sent.some(m => m.includes('the operator, in a DM'))).toBe(false)
    expect(t.watcher.list().length).toBe(opened)
    expect(placesOf(t.listener.view()!, 'D0ALICE01')).not.toContain('slack:app-dm:*')
    t.tick(DM_LIST_BACKOFF_MS + 1)
    live(t, { channel: 'D0CARA0001', ts: '1793000004.000001', channel_type: 'im', text: 'three' })
    live(t, { channel: 'D0FOUR0001', ts: '1793000005.000001', channel_type: 'im', text: 'four' })
    await settle(t)
    expect(reads(t, 'otherParties') - base).toBe(1)
  })

  test('a DM on neither list is read for once on each, then dropped without another read', async () => {
    const t = setup({ toml: CONF(''), dms: BOT_LIST, otherParties: USER_LIST })
    await t.listener.start()
    const bots = reads(t, 'dms'), users = reads(t, 'otherParties')
    live(t, { channel: 'D0NEW00001', channel_type: 'im', text: 'a DM on neither list' })
    live(t, { channel: 'D0NEW00001', ts: '1793000002.000001', channel_type: 'im', text: 'and again' })
    await settle(t)
    expect(t.sent.some(m => m.includes('neither list') || m.includes('and again'))).toBe(false)
    expect(reads(t, 'dms') - bots).toBe(1)
    expect(reads(t, 'otherParties') - users).toBe(1)
  })

  test("a DM opened while the bot's list is being read is read for again: a brand-new DM with the bot is never left nameless", async () => {
    const ctl: { fn: () => Promise<{ channel: string; user?: string }[]> } = { fn: async () => [] }
    const t = setup({ toml: CONF(''), dms: () => ctl.fn(), otherParties: [] })
    await t.listener.start()
    const base = reads(t, 'dms')
    let release!: (v: { channel: string }[]) => void
    ctl.fn = () => new Promise(r => { release = r })
    live(t, { channel: 'D0ALICE01', channel_type: 'im', text: 'from alice' })
    await Bun.sleep(2)
    t.tick(5)   // the operator opens a DM with the bot after that read began
    live(t, { channel: 'D0BOT0001', ts: '1793000002.000001', user: 'UOP', channel_type: 'im', text: 'first message to the bot' })
    ctl.fn = async () => [{ channel: 'D0BOT0001' }]
    release([])   // the read in flight began before it, and lacks it
    await settle(t)
    expect(t.sent.some(m => m.includes('first message to the bot'))).toBe(true)
    expect(reads(t, 'dms') - base).toBe(2)
  })

  test("a DM with a person opened while the user's list is being read is read for again, and named", async () => {
    const ctl: { fn: () => Promise<{ channel: string; user?: string }[]> } = { fn: async () => [] }
    const t = setup({ toml: CONF(RULE), dms: [], otherParties: () => ctl.fn() })
    await t.listener.start()
    const base = reads(t, 'otherParties')
    let release!: (v: { channel: string }[]) => void
    ctl.fn = () => new Promise(r => { release = r })
    live(t, { channel: 'D0OTHER001', user: 'UOTHER', channel_type: 'im', text: 'first read starts here' })
    await Bun.sleep(2)
    t.tick(5)
    live(t, { channel: 'D0ALICE01', ts: '1793000002.000001', channel_type: 'im', text: 'alice, a new DM' })
    ctl.fn = async () => [{ channel: 'D0ALICE01', user: 'UALICE' }]
    release([])
    await settle(t)
    expect(t.sent.some(m => m.includes('alice, a new DM') && m.includes('place="slack:person-dm:alice"'))).toBe(true)
    expect(reads(t, 'otherParties') - base).toBe(2)
  })

  test("a group DM is told by its channel_type (its id looks like a channel's), and is delivered only where a rule or listener names slack:group-dm:* or its id", async () => {
    const t = setup({ toml: CONF('[[rules]]\nplace = "slack:group-dm:*"\ntarget = "specialist:desk"\n'), dms: [], otherParties: [] })
    await t.listener.start()
    const base = reads(t, 'otherParties')
    live(t, { channel: 'G0GROUP01', channel_type: 'mpim', text: 'group hello' })
    live(t, { channel: 'C0GROUP02', ts: '1793000002.000001', channel_type: 'mpim', text: 'a newer group DM, whose id starts with C' })
    await settle(t)
    expect(t.sent.filter(m => m.includes(`place="slack:group-dm:G0GROUP01"`) || m.includes(`place="slack:group-dm:C0GROUP02"`))).toHaveLength(2)
    expect(reads(t, 'otherParties') - base).toBe(0)
    const none = setup({ toml: USER(TOML), dms: [], otherParties: [] })
    await none.listener.start()
    live(none, { channel: 'G0GROUP01', channel_type: 'mpim', text: 'group hello' })
    await settle(none)
    expect(none.sent.some(m => m.includes('group hello'))).toBe(false)
  })

  test("an app with no operator token hears only the bot's DMs: every DM is the bot's, and it reads no list", async () => {
    const t = setup({ toml: TOML + `[people.bea]\naddresses = ["slack:UB"]\nroles = ["owner"]\n[specialists.assistant]\nworkdir = "/w/a"\nreachable_by = ["role:owner"]\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:assistant"\n`, dms: [], otherParties: [] })
    await t.listener.start()
    const base = reads(t, 'dms')
    live(t, { channel: 'D0BEA0001', user: 'UB', channel_type: 'im', text: 'a DM to the bot' })
    await settle(t)
    expect(t.sent.some(m => m.includes('a DM to the bot'))).toBe(true)
    expect(reads(t, 'otherParties')).toBe(0)
    expect(reads(t, 'dms') - base).toBe(0)
  })
})

describe('rewriting a message through the connection', () => {
  const THREAD = `${CH}:2000.000001`
  const thread = (...m: RawMessage[]) => ({ [THREAD]: [{ ts: '2000.000001', user: 'UB' }, ...m] })

  test('whose a message is: the bot’s (by user or bot id), the operator’s, or someone else’s', async () => {
    const t = setup({ operatorId: 'UOP', threads: thread({ ts: '2001.000001', user: BOT, bot_id: 'BBOT' }, { ts: '2002.000001', bot_id: 'BBOT' }, { ts: '2003.000001', user: 'UOP' }, { ts: '2004.000001', user: 'UB' }) })
    await t.listener.start()
    const of = (ts: string) => t.listener.author(CH, ts, '2000.000001')
    expect(await of('2001.000001')).toBe('app')
    expect(await of('2002.000001')).toBe('app')
    expect(await of('2003.000001')).toBe('operator')
    expect(await of('2004.000001')).toBe('other')
    await expect(of('2999.000001')).rejects.toThrow('message 2999.000001 was not found')
  })

  test('the operator is known only with the operator’s token: without one their message is someone else’s', async () => {
    const t = setup({ threads: thread({ ts: '2003.000001', user: 'UOP' }) })
    await t.listener.start()
    expect(await t.listener.author(CH, '2003.000001', '2000.000001')).toBe('other')
  })

  test('a reply is found when Slack puts the thread’s first message ahead of it, and a nested reply is not a top-level conversation’s', async () => {
    const t = setup({ threads: thread({ ts: '2001.000001', user: BOT }), operatorId: 'UOP' })
    await t.listener.start()
    // The fake serves a thread whole; a reply is the second message of the page, as Slack serves it.
    expect(await t.listener.author(CH, '2001.000001', '2000.000001')).toBe('app')
    const top = setup({ threads: { [`${CH}:3000.000001`]: [{ ts: '3000.000001', user: 'UB' }, { ts: '3001.000001', thread_ts: '3000.000001', user: BOT }], [`${CH}:3001.000001`]: [{ ts: '3001.000001', thread_ts: '3000.000001', user: BOT }] } })
    await top.listener.start()
    await expect(top.listener.author(CH, '3001.000001', undefined)).rejects.toThrow('is a reply inside the thread 3000.000001')
    expect(await top.listener.author(CH, '3001.000001', '3000.000001')).toBe('app')
  })

  test('a top-level message is read as its own thread', async () => {
    const t = setup({ threads: { [`${CH}:3000.000001`]: [{ ts: '3000.000001', user: BOT }] } })
    await t.listener.start()
    expect(await t.listener.author(CH, '3000.000001', undefined)).toBe('app')
    expect(t.apps[0].apiCalls).toContain('replies:3000.000001')
  })

  test('edit and delete reach the client with the writer named, and need a connection', async () => {
    const t = setup()
    await expect(t.listener.edit(CH, '1.000001', 'x', 'app')).rejects.toThrow('Slack is not connected')
    await t.listener.start()
    await t.listener.edit(CH, '2001.000001', 'new', 'app')
    await t.listener.edit(CH, '2001.000001', 'newer', 'operator')
    await t.listener.remove(CH, '2001.000001', 'operator')
    expect(t.apps[0].apiCalls.filter(c => /^(edit|remove)/.test(c))).toEqual([`edit:app:${CH}:2001.000001:new`, `edit:operator:${CH}:2001.000001:newer`, `remove:operator:${CH}:2001.000001`])
  })
})

describe('reading a conversation through the connection (fetch_messages)', () => {
  test('a thread: its newest messages oldest first, the bot’s own as “me”, a person by name, files counted; it needs a connection', async () => {
    const t = setup({ threads: { [`${CH}:2000.000001`]: [
      { ts: '2000.000001', user: 'UB', text: 'first' },
      { ts: '2001.000001', user: BOT, text: 'answer' },
      { ts: '2002.000001', bot_id: 'BOTHER', text: 'other bot' },
      { ts: '2003.000001', user: 'UX', text: 'line\ntwo', files: [{ id: 'F1' }] },
    ] } })
    await expect(t.listener.read(CH, '2000.000001', 10, false)).rejects.toThrow('Slack is not connected')
    await t.listener.start()
    expect(await t.listener.read(CH, '2000.000001', 10, false)).toEqual([
      { ts: '2000.000001', author: 'Bea B', mine: false, text: 'first', files: 0 },
      { ts: '2001.000001', author: 'me', mine: true, text: 'answer', files: 0 },
      { ts: '2002.000001', author: 'BOTHER', mine: false, text: 'other bot', files: 0 },
      { ts: '2003.000001', author: 'UX', mine: false, text: 'line\ntwo', files: 1 },
    ])
    expect((await t.listener.read(CH, '2000.000001', 2, false)).map(m => m.ts)).toEqual(['2002.000001', '2003.000001'])
  })

  test('a thread is read with the bot’s token alone unless the caller says the operator’s may read it', async () => {
    const t = setup({ threads: { [`${CH}:2000.000001`]: [{ ts: '2000.000001', user: 'UB', text: 'first' }] } })
    await t.listener.start()
    t.apps[0].apiCalls.length = 0
    await t.listener.read(CH, '2000.000001', 10, false)
    await t.listener.read(CH, '2000.000001', 10, true)
    expect(t.apps[0].apiCalls).toEqual(['replies:2000.000001:botOnly', 'replies:2000.000001'])
  })

  test('a thread longer than a page is read to its end: its newest messages, its first message once, oldest first', async () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ ts: `${3000 + i}.000001`, user: 'UB', text: `m${i}` }))
    const t = setup({ repliesPage: 10, threads: { [`${CH}:3000.000001`]: msgs } })
    await t.listener.start()
    t.apps[0].apiCalls.length = 0
    expect((await t.listener.read(CH, '3000.000001', 7, false)).map(m => m.text)).toEqual(['m18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24'])
    expect(t.apps[0].apiCalls).toEqual(['replies:3000.000001:botOnly', 'replies:3000.000001:botOnly@10', 'replies:3000.000001:botOnly@20'])
    expect((await t.listener.read(CH, '3000.000001', 100, false)).map(m => m.text)).toEqual(msgs.map(m => m.text))
  })

  test(`a thread longer than ${READ_MAX_PAGES} pages is refused, never answered with its oldest messages`, async () => {
    const thread = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: `${4000 + i}.000001`, user: 'UB', text: `m${i}` }))
    const t = setup({ repliesPage: 3, threads: { [`${CH}:4000.000001`]: thread(READ_MAX_PAGES * 3 + 1), [`${CH}:5000.000001`]: thread(READ_MAX_PAGES * 3).map(m => ({ ...m, ts: m.ts.replace(/^4/, '5') })) } })
    await t.listener.start()
    await expect(t.listener.read(CH, '4000.000001', 5, false)).rejects.toThrow(`the thread 4000.000001 is longer than ${READ_MAX_PAGES * 200} messages, more than fetch_messages reads: its newest can't be reached`)
    expect((await t.listener.read(CH, '5000.000001', 1, false)).map(m => m.text)).toEqual([`m${READ_MAX_PAGES * 3 - 1}`])
  })

  test('a channel’s or DM’s top level: Slack’s newest-first history, turned oldest first', async () => {
    const t = setup({ history: [{ ts: '1003.000001', user: 'UB', text: 'c' }, { ts: '1002.000001', user: BOT, text: 'b' }, { ts: '1001.000001', user: 'UB', text: 'a' }] })
    await t.listener.start()
    expect((await t.listener.read(CH, undefined, 2, false)).map(m => [m.ts, m.author])).toEqual([['1002.000001', 'me'], ['1003.000001', 'Bea B']])
    expect((await t.listener.read(CH, undefined, 100, false)).map(m => m.ts)).toEqual(['1001.000001', '1002.000001', '1003.000001'])
  })
})
