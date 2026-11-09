import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { _setIO, _resetIO, detectBlockingState, type PaneProbeIO } from '../pane-probe.js'
import {
  tryTypedDelivery, typedDeliveryText, deliveryDecision, deliverUserMessage, flushHeld, flushAllHeld,
  _setDeliveryDeps, _resetDelivery, _heldCount, HOLD_QUEUE_MAX, type DeliveryOutcome, type DeliveryFacts,
} from '../typed-delivery.js'
import { emit } from '../event-bus.js'
import type { SessionInfo } from '../sessions.js'

process.stderr.write = (() => true) as any

const DAN = '1023364055215386634'
const meta = (over: Record<string, string> = {}): Record<string, string> => ({
  chat_id: 'thread-9', message_id: 'm-42', user: 'dan', user_id: DAN, ts: '2026-11-03T00:00:00.000Z', ...over,
})

const pasted: Array<{ tmuxName: string; text: string; buffer?: string }> = []
let tail: string | null = '❯ \nctx: 12%'
let pasteOk = true
const io = {
  capturePaneTail: async () => tail,
  pastePrompt: async (tmuxName: string, text: string, opts?: { buffer?: string }) => {
    pasted.push({ tmuxName, text, buffer: opts?.buffer }); return pasteOk
  },
} as unknown as PaneProbeIO

let sess: SessionInfo
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', tmuxName: 'ipseity', engine: 'claude',
  adapter: { detectBlockingState: (_i: unknown, t: string) => detectBlockingState(t) },
  ...over,
}) as unknown as SessionInfo

let working = true
let clock = 1_000_000
const outcomes: DeliveryOutcome[] = []
const sent: string[] = []   // ids that took the channel path, in order
const via = (id: string) => () => { sent.push(id) }
const send = (id: string, over: Record<string, string> = {}) =>
  deliverUserMessage('s1', `body ${id}`, meta({ message_id: id, ...over }), via(id))

beforeEach(() => {
  pasted.length = 0; sent.length = 0; outcomes.length = 0
  working = true; clock = 1_000_000; tail = '❯ \nctx: 12%'; pasteOk = true
  sess = session()
  process.env.HYDRA_TYPED_DELIVERY_USER_IDS = DAN
  process.env.HYDRA_TYPED_DELIVERY_MODE = 'paste'
  delete process.env.HYDRA_TYPED_DELIVERY_HOLD_MAX_S
  _setIO(io)
  _setDeliveryDeps({
    isWorking: async () => working, now: () => clock, getSession: () => sess,
    occupancy: s => s.deadAt ? 'dead' : 'reachable', // a stand-in record stamped dead is dead
    onOutcome: (_s, _m, o) => { outcomes.push(o) },
  })
})
afterEach(() => {
  delete process.env.HYDRA_TYPED_DELIVERY_USER_IDS; delete process.env.HYDRA_TYPED_DELIVERY_MODE
  _resetIO(); _resetDelivery()
})

describe('deliveryDecision', () => {
  const f = (o: Partial<DeliveryFacts> = {}): DeliveryFacts => ({ trusted: true, claudeLive: true, working: true, holdFull: false, ...o })
  test('off is always channel', () => expect(deliveryDecision('off', f()).kind).toBe('channel'))
  test('paste: working -> paste, idle -> channel', () => {
    expect(deliveryDecision('paste', f()).kind).toBe('paste')
    expect(deliveryDecision('paste', f({ working: false })).kind).toBe('channel')
  })
  test('hold: working -> hold, full -> paste, idle -> channel', () => {
    expect(deliveryDecision('hold', f()).kind).toBe('hold')
    expect(deliveryDecision('hold', f({ holdFull: true })).kind).toBe('paste')
    expect(deliveryDecision('hold', f({ working: false })).kind).toBe('channel')
  })
  test('untrusted or non-claude is channel in every mode', () => {
    for (const m of ['off', 'paste', 'hold'] as const) {
      expect(deliveryDecision(m, f({ trusted: false })).kind).toBe('channel')
      expect(deliveryDecision(m, f({ claudeLive: false })).kind).toBe('channel')
    }
  })
})

describe('mode paste', () => {
  test('trusted + working pastes the tagged line, no channel', async () => {
    expect(await send('m1')).toEqual({ by: 'paste' })
    expect(pasted).toEqual([{ tmuxName: 'ipseity', text: '[Discord · dan · msg m1 · thread thread-9] body m1', buffer: 'hydra-typed' }])
    expect(sent).toEqual([])
  })
  test('trusted + idle takes the channel', async () => {
    working = false
    expect(await send('m1')).toEqual({ by: 'channel' })
    expect(pasted).toHaveLength(0); expect(sent).toEqual(['m1'])
  })
  test('untrusted takes the channel', async () => {
    expect(await send('m1', { user_id: '999' })).toEqual({ by: 'channel' })
    expect(pasted).toHaveLength(0); expect(sent).toEqual(['m1'])
  })
  test('non-claude and dead sessions take the channel', async () => {
    sess = session({ engine: 'codex' }); await send('a')
    sess = session({ deadAt: 1 }); await send('b')
    expect(pasted).toHaveLength(0); expect(sent).toEqual(['a', 'b'])
  })
  test('paste failure, throw and unreadable pane fall back to the channel', async () => {
    pasteOk = false; expect(await send('a')).toEqual({ by: 'channel' })
    pasteOk = true; tail = null; expect(await send('b')).toEqual({ by: 'channel' })
    tail = '❯ \nctx: 1%'; _setIO({ ...io, pastePrompt: async () => { throw new Error('boom') } } as PaneProbeIO)
    expect(await send('c')).toEqual({ by: 'channel' })
    expect(sent).toEqual(['a', 'b', 'c'])
  })
  test.each([
    ['plan mode', '  Yes, and bypass permissions\n  Yes, manually approve edits\n  Tell Claude what to change'],
    ['unknown dialog', '  Pick one\n  Enter to confirm · Esc to cancel'],
    ['permission prompt', ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel'],
  ])('%s on screen falls back without pasting', async (_n, t) => {
    tail = t
    expect(await send('m1')).toEqual({ by: 'channel' })
    expect(pasted).toHaveLength(0)
  })
})

describe('mode off and unknown', () => {
  test('off: channel even for a trusted, working session', async () => {
    process.env.HYDRA_TYPED_DELIVERY_MODE = 'off'
    expect(await send('m1')).toEqual({ by: 'channel' })
    expect(pasted).toHaveLength(0); expect(_heldCount('s1')).toBe(0)
  })
  test('unset and unknown values behave as off', async () => {
    delete process.env.HYDRA_TYPED_DELIVERY_MODE
    expect((await send('a')).by).toBe('channel')
    process.env.HYDRA_TYPED_DELIVERY_MODE = 'turbo'
    expect((await send('b')).by).toBe('channel')
    expect(pasted).toHaveLength(0); expect(sent).toEqual(['a', 'b'])
  })
  test('trusted ids empty: channel even in paste mode', async () => {
    delete process.env.HYDRA_TYPED_DELIVERY_USER_IDS
    expect((await send('a')).by).toBe('channel')
    expect(pasted).toHaveLength(0)
  })
})

describe('mode hold', () => {
  beforeEach(() => { process.env.HYDRA_TYPED_DELIVERY_MODE = 'hold' })

  test('working: held, nothing sent; idle: flushed through the channel in order', async () => {
    expect(await send('a')).toEqual({ by: 'held', queued: 1 })
    expect(await send('b')).toEqual({ by: 'held', queued: 2 })
    expect(sent).toEqual([]); expect(pasted).toHaveLength(0)
    await flushHeld('s1')                       // still working, not expired
    expect(sent).toEqual([]); expect(_heldCount('s1')).toBe(2)
    working = false
    await flushAllHeld()
    expect(sent).toEqual(['a', 'b']); expect(_heldCount('s1')).toBe(0)
    expect(outcomes.slice(2)).toEqual([
      { by: 'flushed', via: 'channel', reason: 'idle' }, { by: 'flushed', via: 'channel', reason: 'idle' },
    ])
  })

  test('idle on arrival goes straight to the channel', async () => {
    working = false
    expect(await send('a')).toEqual({ by: 'channel' })
    expect(sent).toEqual(['a'])
  })

  test('a message arriving idle does not overtake earlier held ones', async () => {
    await send('a'); await send('b')
    working = false
    await send('c')
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  test('past the max hold, a still-working session gets the message pasted', async () => {
    process.env.HYDRA_TYPED_DELIVERY_HOLD_MAX_S = '120'
    await send('a'); clock += 60_000; await send('b')
    clock += 61_000                              // a: 121s held, b: 61s
    await flushHeld('s1')
    expect(pasted.map(p => p.text)).toEqual(['[Discord · dan · msg a · thread thread-9] body a'])
    expect(sent).toEqual([]); expect(_heldCount('s1')).toBe(1)
    clock += 60_000
    await flushHeld('s1')
    expect(pasted).toHaveLength(2); expect(_heldCount('s1')).toBe(0)
    expect(outcomes.filter(o => o.by === 'flushed')).toEqual([
      { by: 'flushed', via: 'paste', reason: 'max-hold' }, { by: 'flushed', via: 'paste', reason: 'max-hold' },
    ])
  })

  test('max-hold paste that fails falls back to the channel', async () => {
    await send('a'); clock += 121_000; pasteOk = false
    await flushHeld('s1')
    expect(sent).toEqual(['a'])
    expect(outcomes.at(-1)).toEqual({ by: 'flushed', via: 'channel', reason: 'max-hold' })
  })

  test('session death flushes the queue through the channel', async () => {
    await send('a'); await send('b')
    emit('session:death', { sessionId: 's1', threadId: 't', wasOwner: true, tmuxName: 'ipseity' })
    await new Promise(r => setTimeout(r, 0))
    expect(sent).toEqual(['a', 'b']); expect(_heldCount('s1')).toBe(0)
    expect(outcomes.at(-1)).toEqual({ by: 'flushed', via: 'channel', reason: 'death' })
  })

  test('a session already marked dead flushes on the tick', async () => {
    await send('a'); sess = session({ deadAt: 5 })
    await flushAllHeld()
    expect(sent).toEqual(['a'])
  })

  test('queue overflow pastes immediately; the held ones stay queued', async () => {
    for (let i = 0; i < HOLD_QUEUE_MAX; i++) await send(`h${i}`)
    expect(_heldCount('s1')).toBe(HOLD_QUEUE_MAX)
    expect(await send('over')).toEqual({ by: 'paste' })
    expect(pasted).toHaveLength(1); expect(_heldCount('s1')).toBe(HOLD_QUEUE_MAX)
  })

  test('overflow with a failing paste falls back to the channel', async () => {
    for (let i = 0; i < HOLD_QUEUE_MAX; i++) await send(`h${i}`)
    pasteOk = false
    expect((await send('over')).by).toBe('channel')
    expect(sent).toContain('over')
  })

  test('untrusted senders are never held', async () => {
    expect((await send('a', { user_id: '999' })).by).toBe('channel')
    expect(_heldCount('s1')).toBe(0)
  })
})

describe('typed text', () => {
  test.each(['/clear', '!rm -rf x', '/spawn: x'])('%s cannot lead the line', content => {
    const text = typedDeliveryText(content, meta(), 'discord')
    expect(text.startsWith('[Discord · dan')).toBe(true)
    expect(text.endsWith(content)).toBe(true)
  })
  test('attachment paths are included', () => {
    expect(typedDeliveryText('see', meta({ downloaded_files: '/a/x.png; /a/y.txt' }), 'discord'))
      .toBe('[Discord · dan · msg m-42 · thread thread-9] see\n[attachments: /a/x.png; /a/y.txt]')
  })
  test('tag fields cannot break out of the tag', () => {
    expect(typedDeliveryText('x', meta({ user: 'a] b\nc' }), 'discord')).toContain('[Discord · a b c · msg')
  })
  test('tryTypedDelivery pastes the tagged text', async () => {
    expect(await tryTypedDelivery(sess, 'hi', meta())).toBe(true)
    expect(pasted[0]!.text).toBe('[Discord · dan · msg m-42 · thread thread-9] hi')
  })
})
