import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackWatchConfig, type DeliverResult } from '../watch.js'
import { catchUp, toEvent, _resetCatchUpLogs, type SlackApi, type RawMessage, type Page } from '../catchup.js'

import { BASE, BOT, oneListener, view } from './slack-config.js'

const CH = 'C0FOOD'
const cfg: SlackWatchConfig = view(oneListener(CH))
const mention = `<@${BOT}> a cart please`

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(deliver?: () => DeliverResult, config: SlackWatchConfig = cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
  dirs.push(dir)
  const sent: string[] = []
  const logs: string[] = []
  const w = new SlackWatcher({
    now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: l => logs.push(l), config: () => config,
    deliver: async (_s, msg) => { sent.push(msg); return deliver ? deliver() : { ok: true } },
  })
  return { w, sent, logs }
}

/** A Slack stand-in with scripted history and thread contents. */
function fakeApi(history: Record<string, RawMessage[]>, threads: Record<string, RawMessage[]> = {}, pageSize = 100) {
  const calls: { kind: string; args: any }[] = []
  const page = (all: RawMessage[], cursor: string | undefined, oldest: string, inclusive = false): Page => {
    const eligible = all.filter(m => inclusive ? parseFloat(m.ts!) >= parseFloat(oldest) : parseFloat(m.ts!) > parseFloat(oldest))
    const start = cursor ? parseInt(cursor, 10) : 0
    const slice = eligible.slice(start, start + pageSize)
    return { messages: slice, ...(start + pageSize < eligible.length && { next: String(start + pageSize) }) }
  }
  const api: SlackApi = {
    async history(a) { calls.push({ kind: 'history', args: a }); return page(history[a.channel] ?? [], a.cursor, a.oldest) },
    async replies(a) { calls.push({ kind: 'replies', args: a }); return page(threads[`${a.channel}:${a.ts}`] ?? [], a.cursor, a.oldest, a.inclusive) },
  }
  return { api, calls }
}
const opts = (over = {}) => ({ deep: false, now: () => 1_793_000_000_000, log: () => {}, ...over })

describe('toEvent', () => {
  test('maps the API shape; no ts means nothing to replay', () => {
    expect(toEvent(CH, { ts: '1.000001', thread_ts: '1.000001', user: 'U1', bot_id: 'B1', subtype: 'bot_message', text: 'x' }))
      .toEqual({ channel: CH, ts: '1.000001', threadTs: '1.000001', user: 'U1', botId: 'B1', subtype: 'bot_message', text: 'x' })
    expect(toEvent(CH, { text: 'no ts' })).toBeNull()
  })
})

describe('catchUp: a thread a session listens to, where no specialist listens', () => {
  test('the deep pass rereads it from its own last delivery, though its channel has no cursor; nothing older is replayed', async () => {
    const { w, sent } = setup()
    w.bind('C0ELSE', '1792999000.000001', '1552619225032425525', 'tool')    // bound at now (1_793_000_000 s)
    const thread = { 'C0ELSE:1792999000.000001': [
      { ts: '1792999500.000001', thread_ts: '1792999000.000001', user: 'UOLD', text: 'before the bind' },
      { ts: '1793000100.000001', thread_ts: '1792999000.000001', user: 'UNEW', text: 'missed while down' },
    ] }
    await catchUp(w, fakeApi({ [CH]: [] }, thread).api, cfg, opts({ deep: true }))
    await w.flush()
    expect(sent.join()).toContain('missed while down')
    expect(sent.join()).not.toContain('before the bind')
  })
})

describe('catchUp', () => {
  test('a refused sender found in the gap is refused once, like live, and is not counted as recovered', async () => {
    const closed: SlackWatchConfig = view(oneListener(CH, 'slopbot', '["people"]') + '[people.owner]\nids = ["slack:UOWNER"]\nname = "Owner"\nroles = ["boss"]\n')
    const { w, sent } = setup(undefined, closed)
    w.handle({ channel: CH, ts: '1000.000001', user: 'UOWNER', text: 'old chat' }) // sets the cursor
    const { api } = fakeApi({ [CH]: [
      { ts: '1005.000001', user: 'USTRANGER', text: mention },
      { ts: '1010.000001', user: 'UOWNER', text: mention },
    ] })
    const r = await catchUp(w, api, closed, opts())
    await catchUp(w, fakeApi({ [CH]: [{ ts: '1005.000001', user: 'USTRANGER', text: mention }] }).api, closed, { ...opts(), deep: true })
    await w.flush()
    expect(r).toMatchObject({ complete: true, handled: 2, accepted: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('person="owner" roles="boss,people,anyone"')
    expect(w.get(CH, '1005.000001')).toBeUndefined()
    expect(w.stats()).toMatchObject({ refused: 1, refusedBy: { USTRANGER: 1 } })
  })

  test('the first run has no cursor: it starts from now and reads nothing', async () => {
    const { w } = setup()
    const { api, calls } = fakeApi({ [CH]: [{ ts: '1792999999.000001', text: mention, user: 'UA' }] })
    const r = await catchUp(w, api, cfg, opts())
    expect(r).toMatchObject({ complete: true, calls: 0 })
    expect(calls).toHaveLength(0)
    expect(w.channelCursor(CH)).toBe('1793000000.000000')
  })

  test('a tag in a brand-new thread during the gap is found by the channel scan and delivered', async () => {
    const { w, sent } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'old chat' }) // sets the cursor
    const { api, calls } = fakeApi({ [CH]: [
      { ts: '1005.000001', user: 'UA', text: 'chat' },
      { ts: '1010.000001', user: 'UB', text: mention },
    ] })
    const r = await catchUp(w, api, cfg, opts())
    await w.flush()
    expect(r).toMatchObject({ complete: true, handled: 2, accepted: 1 })
    expect(calls[0].args.oldest).toBe('1000.000001')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('address="slack:UB"]')
    expect(w.channelCursor(CH)).toBe('1010.000001')
  })

  test('owed messages are refetched from their thread and delivered once; delivered ones are not repeated', async () => {
    let fail = true
    const { w, sent } = setup(() => fail ? { ok: false, error: 'specialist down' } : { ok: true })
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: mention })
    await w.flush() // fails: owed
    fail = false
    const thread: RawMessage[] = [{ ts: '1000.000001', user: 'UA', text: mention }, { ts: '1001.000001', thread_ts: '1000.000001', user: 'UB', text: 'and Souvla' }]
    const { api, calls } = fakeApi({ [CH]: [] }, { [`${CH}:1000.000001`]: thread })
    await catchUp(w, api, cfg, opts())
    await w.flush()
    expect(calls.find(c => c.kind === 'replies')!.args).toMatchObject({ ts: '1000.000001', oldest: '1000.000001', inclusive: true })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('and Souvla')
    expect(w.owedHints()).toEqual([])
    // a second pass changes nothing
    const again = await catchUp(w, fakeApi({ [CH]: [] }, { [`${CH}:1000.000001`]: thread }).api, cfg, opts({ deep: true }))
    await w.flush()
    expect(sent).toHaveLength(2)
    expect(again.accepted).toBe(0) // nothing the live stream had not already delivered
  })

  test("the bot's own post made during the gap is found by the scan, and the replies of every thread that began in the gap are read", async () => {
    const { w, sent } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    const { api, calls } = fakeApi(
      { [CH]: [
        { ts: '1200.000001', thread_ts: '1200.000001', reply_count: 1, user: BOT, text: 'cart post' },
        { ts: '1300.000001', thread_ts: '1300.000001', reply_count: 4, user: 'UC', text: 'someone elses thread' },
      ] },
      { [`${CH}:1200.000001`]: [{ ts: '1250.000001', thread_ts: '1200.000001', user: 'UB', text: 'reply while down' }],
        [`${CH}:1300.000001`]: [{ ts: '1310.000001', thread_ts: '1300.000001', user: 'UD', text: 'chatter, no tag' }, { ts: '1320.000001', thread_ts: '1300.000001', user: 'UE', text: mention }] },
    )
    await catchUp(w, api, cfg, opts())
    await w.flush()
    expect(calls.filter(c => c.kind === 'replies').map(c => c.args.ts)).toEqual(['1200.000001', '1300.000001'])
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('reply while down')
    expect(sent[1]).toContain('a cart please') // a tag in a reply of a thread nobody watched, posted while down
    expect(sent[1]).not.toContain('chatter, no tag')
  })

  test("a deep pass over a thread under the bot's own post does not count that post as missed", async () => {
    const { w, sent } = setup()
    expect(w.handle({ channel: CH, ts: '1000.000001', user: BOT, text: 'proposal' })).toBe('subscribed')
    w.handle({ channel: CH, ts: '1100.000001', threadTs: '1000.000001', user: 'UA', text: 'sounds good' })
    await w.flush()
    expect(sent).toHaveLength(1)
    // Slack returns the parent with every replies call, whatever `oldest` is
    const thread = { [`${CH}:1000.000001`]: [
      { ts: '1000.000001', thread_ts: '1000.000001', reply_count: 1, user: BOT, text: 'proposal' },
      { ts: '1100.000001', thread_ts: '1000.000001', user: 'UA', text: 'sounds good' },
    ] }
    const parentAlways: SlackApi = { ...fakeApi({ [CH]: [] }, thread).api, async replies() { return { messages: thread[`${CH}:1000.000001`] } } }
    for (let i = 0; i < 2; i++) expect((await catchUp(w, parentAlways, cfg, opts({ deep: true }))).accepted).toBe(0)
    await w.flush()
    expect(sent).toHaveLength(1)
  })

  test('an old watched thread that got replies during the gap is only reachable by a deep pass', async () => {
    const { w, sent } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: mention })
    await w.flush()
    w.handle({ channel: CH, ts: '1100.000001', user: 'UA', text: 'chat' })
    const thread = { [`${CH}:1000.000001`]: [{ ts: '1150.000001', thread_ts: '1000.000001', user: 'UB', text: 'missed reply' }] }
    // history lists parents only, and the parent is older than the cursor: a light pass cannot see the reply
    await catchUp(w, fakeApi({ [CH]: [] }, thread).api, cfg, opts())
    expect(sent).toHaveLength(1)
    await catchUp(w, fakeApi({ [CH]: [] }, thread).api, cfg, opts({ deep: true }))
    await w.flush()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('missed reply')
  })

  test('a deep pass rereads every watched thread; a light one does not', async () => {
    const { w } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: mention })
    w.handle({ channel: CH, ts: '2000.000001', user: 'UA', text: mention })
    await w.flush()
    const light = fakeApi({ [CH]: [] })
    await catchUp(w, light.api, cfg, opts())
    expect(light.calls.filter(c => c.kind === 'replies')).toHaveLength(0)
    const deep = fakeApi({ [CH]: [] })
    await catchUp(w, deep.api, cfg, opts({ deep: true }))
    expect(deep.calls.filter(c => c.kind === 'replies').map(c => c.args.ts).sort()).toEqual(['1000.000001', '2000.000001'])
  })

  test('pagination follows the next cursor', async () => {
    const { w, sent } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    const msgs = [1, 2, 3].map(i => ({ ts: `${1000 + i}.000001`, user: `U${i}`, text: mention }))
    const { api, calls } = fakeApi({ [CH]: msgs }, {}, 2)
    const r = await catchUp(w, api, cfg, opts())
    await w.flush()
    expect(r.complete).toBe(true)
    expect(calls.filter(c => c.kind === 'history')).toHaveLength(2)
    expect(sent.join()).toContain('address="slack:U3"')
  })

  test('the call budget grows with the watch table, so a deep pass over many watches still completes', async () => {
    const big = { ...cfg, maxWatches: 200 }
    const { w } = setup(undefined, big)
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    for (let i = 0; i < 100; i++) w.watch(CH, `${2000 + i}.000001`, 'slopbot')
    const { api, calls } = fakeApi({ [CH]: [] })
    const r = await catchUp(w, api, big, opts({ deep: true }))
    expect(r).toMatchObject({ complete: true })
    expect(calls.filter(c => c.kind === 'replies')).toHaveLength(100)
  })

  test('an exhausted call budget or an API error leaves the cursor held; the next pass finishes the job', async () => {
    const { w, sent, logs } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    const history = { [CH]: [{ ts: '1010.000001', user: 'UB', text: mention }] }
    const failing: SlackApi = { async history() { throw new Error('ratelimited') }, async replies() { throw new Error('ratelimited') } }
    const r1 = await catchUp(w, failing, cfg, opts({ log: (l: string) => logs.push(l) }))
    expect(r1).toMatchObject({ complete: false, reason: 'ratelimited' })
    expect(logs.join()).toContain('catch-up incomplete')
    // live traffic during the open gap must not move the cursor past it
    w.handle({ channel: CH, ts: '1500.000001', user: 'UA', text: 'live chat' })
    expect(w.channelCursor(CH)).toBe('1000.000001')
    const budget = await catchUp(w, fakeApi(history).api, cfg, opts({ maxCalls: 0 }))
    expect(budget).toMatchObject({ complete: false })
    expect(w.channelCursor(CH)).toBe('1000.000001')
    const r3 = await catchUp(w, fakeApi(history).api, cfg, opts())
    await w.flush()
    expect(r3.complete).toBe(true)
    expect(sent).toHaveLength(1)
    expect(w.channelCursor(CH)).toBe('1010.000001')
  })
})

test("a thread Slack says isn't there (a made-up ts) is skipped and logged; the pass still reads the rest", async () => {
  const { w, sent } = setup(() => ({ ok: true }))
  const logs: string[] = []
  w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
  w.bind(CH, '1.000001', 'slopbot', 'tool') // made up
  w.bind(CH, '1001.000001', 'slopbot')
  const api: SlackApi = {
    history: async () => ({ messages: [] }),
    replies: async a => { if (a.ts === '1.000001') throw new Error('An API error occurred: thread_not_found'); return { messages: [{ ts: '1002.000001', thread_ts: '1001.000001', user: 'UA', text: 'missed reply' }] } },
  }
  const r = await catchUp(w, api, cfg, opts({ deep: true, log: (l: string) => logs.push(l) }))
  await w.flush()
  expect(r).toMatchObject({ complete: true, accepted: 1 })
  expect(sent.join()).toContain('missed reply')
  expect(logs.join()).toContain(`thread ${CH}:1.000001 can't be read`)
})

test("a thread whose channel the bot can no longer read is dropped like a gone one: the pass goes on, the queue isn't pinned", async () => {
  const { w } = setup(() => ({ ok: false, error: 'down' }))
  w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
  w.bind(CH, '1500.000001', 'slopbot')
  const e = w.get(CH, '1500.000001')!
  e.owed = ['1500.000002']; e.waitingSince = 1
  const api: SlackApi = { history: async () => ({ messages: [] }), replies: async () => { throw new Error('An API error occurred: not_in_channel') } }
  expect(await catchUp(w, api, cfg, opts())).toMatchObject({ complete: true })
  expect(w.get(CH, '1500.000001')!.waitingSince).toBeUndefined()
  expect(w.stats().dropped).toEqual({ expired: 1 })
})

test('a gone thread that still owed messages drops them (and stops waiting): they can never be fetched', async () => {
  const { w } = setup(() => ({ ok: false, error: 'down' }))
  w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
  w.bind(CH, '1500.000001', 'slopbot')
  const e = w.get(CH, '1500.000001')!
  e.owed = ['1500.000002']; e.waitingSince = 1
  const api: SlackApi = { history: async () => ({ messages: [] }), replies: async () => { throw new Error('An API error occurred: thread_not_found') } }
  await catchUp(w, api, cfg, opts())
  expect(w.get(CH, '1500.000001')!.owed).toBeUndefined()
  expect(w.get(CH, '1500.000001')!.waitingSince).toBeUndefined()
  expect(w.stats().dropped).toEqual({ expired: 1 })
})

describe('catch-up across routes', () => {
  test('every routed channel is scanned, and each recovered tag goes to its own route', async () => {
    const routed: SlackWatchConfig = view(`${BASE}
[specialists.food]
workdir = "/w/food"
listens = ["slack:${CH}"]
allow = ["anyone"]
[specialists.ops]
workdir = "/w/ops"
listens = ["slack:C0OPS"]
allow = ["anyone"]
`)
    const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
    dirs.push(dir)
    const sent: string[] = []
    const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => routed, deliver: async t => { sent.push(t.to); return { ok: true } } })
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    w.handle({ channel: 'C0OPS', ts: '1000.000001', user: 'UA', text: 'chat' })
    const { api } = fakeApi({ [CH]: [{ ts: '1005.000001', user: 'UA', text: mention }], C0OPS: [{ ts: '1006.000001', user: 'UB', text: mention }] })
    expect(await catchUp(w, api, routed, opts())).toMatchObject({ complete: true, accepted: 2 })
    await w.flush()
    expect(sent.sort()).toEqual(['food', 'ops'])
    expect(w.channelCursor('C0OPS')).toBe('1006.000001')
  })
})

test('owed threads follow their binding: refetched even once no specialist listens in that channel', async () => {
  let routed: SlackWatchConfig = cfg
  const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
  dirs.push(dir)
  const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => routed, deliver: async () => ({ ok: false, error: 'down' }) })
  w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: mention })
  await w.flush()
  routed = view(oneListener('C0ELSE', 'slopbot'))
  const { api, calls } = fakeApi({ C0ELSE: [] })
  await catchUp(w, api, routed, opts())
  expect(calls.filter(c => c.kind === 'replies').map(c => `${c.args.channel}:${c.args.ts}`)).toEqual([`${CH}:1000.000001`])
})

test('a message the guard put off (exit 75) is refetched by catch-up and judged again, like any owed message', async () => {
  const guarded: SlackWatchConfig = view(oneListener(CH, 'slopbot', '["anyone"]', '[guard]\ncommand = "g"\n'))
  const T = '1792999990.000001' // within owed_max of now: a "not now" holds it rather than failing it
  const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
  dirs.push(dir)
  let fate: 'later' | 'deliver' = 'later'
  const sent: string[] = []
  const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => guarded,
    guard: async () => ({ fate }), deliver: async (_t, msg) => { sent.push(msg); return { ok: true } } })
  w.handle({ channel: CH, ts: T, user: 'UA', text: mention })
  await w.flush()
  expect(sent).toHaveLength(0)
  fate = 'deliver'
  const thread = { [`${CH}:${T}`]: [{ ts: T, user: 'UA', text: mention }] }
  const r = await catchUp(w, fakeApi({ [CH]: [] }, thread).api, guarded, opts())
  await w.flush()
  expect(r.accepted).toBe(1)
  expect(sent).toHaveLength(1)
  expect(w.owedHints()).toEqual([])
})

describe('catch-up for DMs and files', () => {
  const DM = 'D0ALICE01'
  const DMS = (allow: string) => oneListener(CH) + `[people.a]\nids = ["slack:UA"]\nroles = ["owner"]\n[specialists.assistant]\nworkdir = "/w/assistant"\nlistens = ["slack:dm"]\nallow = ${allow}\n`
  const dmCfg: SlackWatchConfig = view(DMS('["owner"]'))
  const mk = (deliver: () => DeliverResult = () => ({ ok: true })) => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
    dirs.push(dir)
    const sent: { to: string; msg: string }[] = []
    const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => dmCfg, deliver: async (t, msg) => { sent.push({ to: t.to, msg }); return deliver() } })
    return { w, sent }
  }

  test('a known DM conversation is scanned by history like a channel; what it missed is delivered as a DM', async () => {
    const { w, sent } = mk()
    w.handle({ channel: DM, ts: '1000.000001', user: 'UA', text: 'first' })
    await w.flush()
    const { api, calls } = fakeApi({ [CH]: [], [DM]: [{ ts: '1005.000001', user: 'UA', text: 'while you were away' }] })
    expect(await catchUp(w, api, dmCfg, opts({ deep: true }))).toMatchObject({ complete: true, accepted: 1 })
    await w.flush()
    expect(sent.map(x => x.to)).toEqual(['assistant', 'assistant'])
    expect(sent[1].msg).toContain('[dm ')
    expect(calls.some(c => c.kind === 'replies')).toBe(false) // a DM has no thread of its own to read
    expect(w.channelCursor(DM)).toBe('1005.000001')
  })

  test('an owed DM is refetched from just before it, by history', async () => {
    let fail = true
    const { w, sent } = mk(() => fail ? { ok: false, error: 'down' } : { ok: true })
    w.handle({ channel: DM, ts: '1000.000001', user: 'UA', text: 'owed' })
    w.handle({ channel: DM, ts: '1010.000001', user: 'UA', text: 'later' })
    await w.flush()
    fail = false
    const { api, calls } = fakeApi({ [CH]: [], [DM]: [{ ts: '1000.000001', user: 'UA', text: 'owed' }, { ts: '1010.000001', user: 'UA', text: 'later' }] })
    await catchUp(w, api, dmCfg, opts())
    await w.flush()
    expect(calls.find(c => c.kind === 'history' && c.args.channel === DM)?.args.oldest).toBe('1000.000000')
    expect(sent.at(-1)!.msg).toContain('ts="1000.000001"')
    expect(w.owedHints()).toEqual([])
  })

  test('an owed reply in a thread inside a DM is refetched from that thread, like a channel thread', async () => {
    let fail = false
    const { w, sent } = mk(() => fail ? { ok: false, error: 'down' } : { ok: true })
    w.handle({ channel: DM, ts: '1000.000001', user: 'UA', text: 'parent' }) // delivered; older than the cursor from here on
    await w.flush()
    fail = true
    w.handle({ channel: DM, ts: '1010.000001', threadTs: '1000.000001', user: 'UA', text: 'reply' })
    await w.flush()
    fail = false
    const thread = { [`${DM}:1000.000001`]: [{ ts: '1000.000001', user: 'UA', text: 'parent' }, { ts: '1010.000001', thread_ts: '1000.000001', user: 'UA', text: 'reply' }] }
    // history since the cursor holds nothing: only the owed reply's own thread can bring it back
    const { api, calls } = fakeApi({ [CH]: [], [DM]: [] }, thread)
    await catchUp(w, api, dmCfg, opts())
    await w.flush()
    expect(calls.some(c => c.kind === 'replies' && c.args.channel === DM && c.args.ts === '1000.000001')).toBe(true)
    expect(calls.some(c => c.kind === 'replies' && c.args.ts === '0.000000')).toBe(false)
    expect(w.owedHints()).toEqual([])
    expect(sent.at(-1)!.msg).toContain('reply')
  })

  test("a DM opened while disconnected is found by listing the bot's DMs, if the dms route admits its sender", async () => {
    const { w, sent } = mk()
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' }) // a channel cursor, so this is not a first run
    const { api, calls } = fakeApi({ [CH]: [], D0NEW0001: [{ ts: '1792999500.000001', user: 'UA', text: 'are you there' }], D0STRANGE: [{ ts: '1792999500.000002', user: 'UZ', text: 'hi' }] })
    api.dms = async () => [{ channel: 'D0NEW0001', user: 'UA' }, { channel: 'D0STRANGE', user: 'UZ' }]
    expect(await catchUp(w, api, dmCfg, opts())).toMatchObject({ complete: true, accepted: 1 })
    await w.flush()
    expect(sent.map(x => x.to)).toEqual(['assistant'])
    expect(calls.some(c => c.kind === 'history' && c.args.channel === 'D0STRANGE')).toBe(false)
    expect(w.channelCursor('D0NEW0001')).toBe('1792999500.000001')
  })

  test('listing DMs failing (no im:read) costs a log line once an hour, not the pass', async () => {
    _resetCatchUpLogs()
    const { w } = mk()
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' })
    const logs: string[] = []
    const { api } = fakeApi({ [CH]: [] })
    api.dms = async () => { throw new Error('missing_scope: the token needs im:read') }
    let now = 1_793_000_000_000
    const o = () => opts({ log: (l: string) => logs.push(l), now: () => now })
    expect(await catchUp(w, api, dmCfg, o())).toMatchObject({ complete: true })
    now += 10 * 60_000
    await catchUp(w, api, dmCfg, o())
    expect(logs.filter(l => l.includes('listing DM conversations failed'))).toHaveLength(1)
    now += 61 * 60_000
    await catchUp(w, api, dmCfg, o())
    expect(logs.filter(l => l.includes('listing DM conversations failed'))).toHaveLength(2)
  })

  test('more DM conversations than one pass can read: the pass still completes, and later passes get round to all of them', async () => {
    const { w } = mk()
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' })
    const many = Array.from({ length: 600 }, (_, i) => ({ channel: `D0MANY${String(i).padStart(4, '0')}`, user: 'UA' }))
    const { api, calls } = fakeApi({ [CH]: [] })
    api.dms = async () => many
    const logs: string[] = []
    for (let pass = 0; pass < 3; pass++) expect(await catchUp(w, api, dmCfg, opts({ log: (l: string) => logs.push(l) }))).toMatchObject({ complete: true })
    expect(logs.join()).toContain('left for the next pass')
    const read = new Set(calls.filter(c => c.kind === 'history').map(c => c.args.channel))
    expect(many.every(d => read.has(d.channel))).toBe(true)
  })

  test('a DM a short pass skipped keeps its gap: a live message there does not move its cursor past it', async () => {
    let now = 1_793_000_000_000
    const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
    dirs.push(dir)
    const sent: string[] = []
    const openDms: SlackWatchConfig = view(DMS('["anyone"]'), { maxWatches: 1000 })
    const w = new SlackWatcher({ now: () => now, file: join(dir, 'w.json'), log: () => {}, config: () => openDms, deliver: async (_t, msg) => { sent.push(msg); return { ok: true } } })
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' })
    const dms = Array.from({ length: 600 }, (_, i) => ({ channel: `D0GAP${String(i).padStart(4, '0')}`, user: 'UA' }))
    const hist: Record<string, RawMessage[]> = {}
    const api: SlackApi = {
      history: async a => ({ messages: (hist[a.channel] ?? []).filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)) }),
      replies: async () => ({ messages: [] }),
      dms: async () => dms,
    }
    const o = () => opts({ now: () => now })
    for (let p = 0; p < 4; p++) await catchUp(w, api, openDms, o()) // every DM known, with a cursor
    now += 600_000
    const gapTs = `${Math.floor(now / 1000) - 100}.000001`
    for (const d of dms) hist[d.channel] = [{ ts: gapTs, user: 'UA', text: `gap-${d.channel}` }]
    const before = new Map(dms.map(d => [d.channel, w.channelCursor(d.channel)]))
    await catchUp(w, api, openDms, o())
    const skipped = dms.map(d => d.channel).filter(c => w.channelCursor(c) === before.get(c))
    expect(skipped.length).toBeGreaterThan(0)
    now += 1000
    for (const c of skipped) { const t = `${Math.floor(now / 1000)}.000001`; hist[c].push({ ts: t, user: 'UA', text: `live-${c}` }); w.handle({ channel: c, ts: t, user: 'UA', text: `live-${c}` }) }
    expect(skipped.every(c => w.channelCursor(c) === before.get(c))).toBe(true) // held
    for (let p = 0; p < 4; p++) { now += 600_000; await catchUp(w, api, openDms, o()) }
    await w.flush()
    const all = sent.join('\n')
    expect(skipped.filter(c => all.includes(`gap-${c}`))).toHaveLength(skipped.length)
  })

  test('a full watch table and many DMs: deep passes still complete, keeping the calls their threads need', async () => {
    const { w } = mk()
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' })
    for (let i = 0; i < 50; i++) w.handle({ channel: CH, ts: `${1792999100 + i}.000001`, user: `UT${i}`, text: mention })
    await w.flush()
    expect(w.list()).toHaveLength(50)
    const { api } = fakeApi({ [CH]: [] })
    api.dms = async () => Array.from({ length: 350 }, (_, i) => ({ channel: `D9MANY${String(i).padStart(4, '0')}`, user: 'UA' }))
    for (let p = 0; p < 4; p++) expect(await catchUp(w, api, dmCfg, opts({ deep: true }))).toMatchObject({ complete: true })
  })

  test('quiet DMs found by listing get a cursor even with nothing to read, so they never eat the budget', async () => {
    const { w } = mk()
    w.handle({ channel: CH, ts: '1792999000.000001', user: 'UA', text: 'chat' })
    const quiet = Array.from({ length: 80 }, (_, i) => ({ channel: `D0QUIET${String(i).padStart(3, '0')}`, user: 'UA' }))
    const { api, calls } = fakeApi({ [CH]: [] })
    api.dms = async () => quiet
    for (let pass = 0; pass < 3; pass++) expect(await catchUp(w, api, dmCfg, opts())).toMatchObject({ complete: true })
    // the read back a day happens once per conversation; later passes read from its cursor
    expect(calls.filter(c => c.kind === 'history' && c.args.channel === 'D0QUIET000' && c.args.oldest.startsWith('1792913600')).length).toBe(1)
    expect(w.channelCursor('D0QUIET000')).toBe('1793000000.000000')
  })

  test('files on messages found by catch-up are carried like live ones', async () => {
    const { w, sent } = mk()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    const { api } = fakeApi({ [CH]: [{ ts: '1005.000001', user: 'UA', text: mention, files: [{ id: 'F1', name: 'a.pdf', size: 10, url_private_download: 'https://files.slack.com/F1' }] }] })
    await catchUp(w, api, dmCfg, opts())
    await w.flush()
    expect(sent[0].msg).toContain('  file: a.pdf (10 B): not downloaded (files is off for this place)')
  })
})

describe('catch-up never passes over a gap', () => {
  test("a thread reply's ts does not move the channel cursor past a top-level message the pass has not read", async () => {
    const { w, sent } = setup()
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' }) // cursor 1000
    const hist: RawMessage[] = [{ ts: '1005.000001', user: 'UA', text: 'thread parent', reply_count: 1 }]
    const replies: RawMessage[] = [{ ts: '1005.000001', user: 'UA', text: 'thread parent' }]
    const after = (a: string, b: string) => parseFloat(a) > parseFloat(b)
    const api: SlackApi = {
      async history(a) {
        const r = { messages: hist.filter(m => after(m.ts!, a.oldest)) }
        // after this read, with the live stream down: a top-level tag, then a reply in the thread
        if (hist.length === 1) { hist.push({ ts: '1010.000001', user: 'UB', text: mention }); replies.push({ ts: '1020.000001', user: 'UA', thread_ts: '1005.000001', text: 'reply' }) }
        return r
      },
      async replies(a) { return { messages: replies.filter(m => a.inclusive ? !after(a.oldest, m.ts!) : after(m.ts!, a.oldest)) } },
    }
    await catchUp(w, api, cfg, opts())
    expect(w.channelCursor(CH)).toBe('1005.000001')
    await catchUp(w, api, cfg, opts({ deep: true }))
    await w.flush()
    expect(sent.some(m => m.includes('a cart please'))).toBe(true)
  })

  test('a channel with more than a pass can read moves on with the gap surfaced, instead of failing every pass', async () => {
    const alerts: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'slack-catchup-'))
    dirs.push(dir)
    const w = new SlackWatcher({ now: () => 1_793_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => cfg, alert: t => alerts.push(t), deliver: async () => ({ ok: true }) })
    w.handle({ channel: CH, ts: '1000.000001', user: 'UA', text: 'chat' })
    const hist: RawMessage[] = Array.from({ length: 1001 }, (_, i) => ({ ts: `${1001 + i}.000001`, user: 'UA', text: 'busy' }))
    const api: SlackApi = {
      async history(a) { const el = hist.filter(m => parseFloat(m.ts!) > parseFloat(a.oldest)); const s = a.cursor ? +a.cursor : 0; return { messages: el.slice(s, s + 200), ...(s + 200 < el.length && { next: String(s + 200) }) } },
      async replies() { return { messages: [] } },
    }
    for (let p = 1; p <= 3; p++) {
      expect(await catchUp(w, api, cfg, opts({ deep: true }))).toMatchObject({ complete: true })
      const t = `${5000 + p}.000001`
      hist.push({ ts: t, user: 'UA', text: 'live' })
      w.handle({ channel: CH, ts: t, user: 'UA', text: 'live' })
    }
    expect(w.channelCursor(CH)).toBe('5003.000001')
    expect(w.stats().dropped['catch-up-gap']).toBe(1)
    expect(alerts.join()).toContain('catch-up read the newest 1000 messages in C0FOOD since 1000.000001')
  })
})
