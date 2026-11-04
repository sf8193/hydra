import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackWatchConfig, type DeliverResult } from '../slack-watch.js'
import { catchUp, toEvent, type SlackApi, type RawMessage, type Page } from '../slack-catchup.js'

const BOT = 'UBOT'
const CH = 'C_FOOD'
const cfg: SlackWatchConfig = { botUserId: BOT, channels: [CH], specialist: 'slopbot', idleExpiryMs: 7 * 86_400_000, coalesceMs: 5, maxWatches: 50, maxMentionsPer10Min: 10 }
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

describe('catchUp', () => {
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
    expect(sent[0]).toContain('[mention] <@UB>')
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
    expect(sent.join()).toContain('<@U3>')
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
