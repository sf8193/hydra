// A person's reaction to a message in a conversation hydra holds, delivered to the session that owns it (`[places]` `reactions`).
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackWatchConfig, type SlackWatchDeps, type DeliverResult, type SlackActions, type SlackReactionEvent } from '../watch.js'
import { BOT, oneListener, alsoHeard, view, sharedChannel, SALES_BOT, type ViewOver } from './slack-config.js'

const CH = 'C0FOOD'
const OWN = '3000.000001'      // the bot's own top-level post
const THEIRS = '3100.000001'   // a person's message, delivered
const places = (mode: string) => `[places."slack:${CH}"]\nreactions = "${mode}"\n`
const cfg = (mode: string, over: ViewOver = {}): SlackWatchConfig => view(oneListener(CH, 'helper', '["role:anyone"]', mode ? places(mode) : ''), { workspaceUrl: 'https://acme.slack.com', ...over })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(config: SlackWatchConfig, deliver?: (key: string) => DeliverResult, guard?: SlackWatchDeps['guard']) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-reactions-'))
  dirs.push(dir)
  const file = join(dir, 'slack-watches.json')
  const sent: { to: string; msg: string; key: string }[] = []
  const reacted: string[] = []
  const logs: string[] = []
  let cur = config
  const make = () => {
    const w = new SlackWatcher({
      now: () => 1_000_000_000_000, file, log: l => logs.push(l), config: () => cur, guard,
      deliver: async ({ to }, msg, key) => { sent.push({ to, msg, key }); return deliver ? deliver(key) : { ok: true } },
    })
    const actions: SlackActions = { download: async () => {}, react: async (c, ts, name) => { reacted.push(`${c}:${ts}:${name}`) } }
    w.setSlackActions(actions)
    return w
  }
  const w = make()
  // A bot post, and a person's message the bot answers: two things to react to.
  w.handle({ channel: CH, ts: OWN, user: BOT, text: 'daily post' })
  w.handle({ channel: CH, ts: THEIRS, user: 'UALICE', text: `<@${BOT}> hi` })
  return { w, make, sent, reacted, logs, file, set: (c: SlackWatchConfig) => { cur = c } }
}
const react = (over: Partial<SlackReactionEvent> = {}): SlackReactionEvent => ({ channel: CH, itemTs: OWN, itemUser: BOT, reaction: 'white_check_mark', user: 'UALICE', eventTs: '4000.000001', ...over })

describe('inbound reactions', () => {
  test('a person\'s reaction on a bot post is delivered once, to the conversation\'s session, as one line with a link', async () => {
    const { w, sent } = setup(cfg('bot-messages'))
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react())).toBe('accepted')
    await w.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('helper')
    expect(sent[0].msg).toContain('reacted :white_check_mark: to https://acme.slack.com/archives/C0FOOD/p3000000001')
    expect(sent[0].msg).toContain('[reaction ')
  })

  test('the same person, reaction and message again is not delivered again, across a restart too', async () => {
    const { w, make, sent } = setup(cfg('bot-messages'))
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react())).toBe('accepted')
    expect(w.handleReaction(react({ eventTs: '4000.000002' }))).toBe('ignored')
    await w.flush()
    const again = make()
    expect(again.handleReaction(react({ eventTs: '4000.000003' }))).toBe('ignored')
    await again.flush()
    expect(sent).toHaveLength(1)
    // A different reaction, or a different person, is a different reaction.
    expect(again.handleReaction(react({ reaction: '+1' }))).toBe('accepted')
    expect(again.handleReaction(react({ user: 'UBOB' }))).toBe('accepted')
  })

  test('off (the default) delivers nothing; bot-messages ignores a person\'s message; all delivers it', async () => {
    for (const [mode, onBot, onPerson] of [['', 'ignored', 'ignored'], ['off', 'ignored', 'ignored'], ['bot-messages', 'accepted', 'ignored'], ['all', 'accepted', 'accepted']] as const) {
      const { w } = setup(cfg(mode))
      expect([mode, w.handleReaction(react()), w.handleReaction(react({ itemTs: THEIRS, itemUser: 'UALICE' }))]).toEqual([mode, onBot, onPerson])
    }
  })

  test('a message no conversation holds takes no reaction', () => {
    const { w } = setup(cfg('all'))
    expect(w.handleReaction(react({ itemTs: '9999.000001', itemUser: 'UALICE' }))).toBe('ignored')
    expect(w.handleReaction(react({ channel: 'C0ELSE' }))).toBe('ignored')
  })

  test('a stranger the place\'s rules do not admit is dropped without a trace: no delivery, no 🚫, nothing counted', async () => {
    const { w, sent, reacted } = setup(cfg('bot-messages', { toml: oneListener(CH, 'helper', '[]', places('bot-messages')) }))
    await w.flush(); sent.length = 0; reacted.length = 0
    const before = w.stats()
    expect(w.handleReaction(react({ user: 'USTRANGER' }))).toBe('ignored')
    await w.flush()
    expect(sent).toHaveLength(0)
    expect(reacted).toHaveLength(0)
    expect(w.stats()).toEqual(before)
    // The operator, on the same post, is heard.
    expect(w.handleReaction(react({ user: 'UOP' }))).toBe('accepted')
  })

  test('the bot\'s own reaction (its ack) and a sibling app\'s are never delivered', () => {
    const { w } = setup(cfg('all'))
    expect(w.handleReaction(react({ user: BOT }))).toBe('ignored')
    const two = setup(cfg('all', { identities: { default: { botUserId: BOT }, sales: { botUserId: SALES_BOT } } }))
    expect(two.w.handleReaction(react({ user: SALES_BOT }))).toBe('ignored')
  })

  test('a reaction never enters the delivered list or the owed list: a catch-up cursor is built from messages only', async () => {
    const { w } = setup(cfg('bot-messages'))
    await w.flush()
    const before = JSON.stringify(w.get(CH, OWN))
    w.handleReaction(react())
    await w.flush()
    const { reacted, ...rest } = w.get(CH, OWN)!
    expect(JSON.stringify(rest)).toBe(before)
    expect(reacted).toEqual(['3000.000001:white_check_mark:UALICE'])
    expect(w.get(CH, OWN)!.owed).toBeUndefined()
  })

  test('a delivery that failed is tried again when the same reaction comes again', async () => {
    let fail = true
    const { w, sent } = setup(cfg('bot-messages'), () => fail ? { ok: false, error: 'down' } : { ok: true })
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react())).toBe('accepted')
    await w.flush()
    fail = false
    expect(w.handleReaction(react({ eventTs: '4000.000002' }))).toBe('accepted')
    await w.flush()
    expect(sent).toHaveLength(2)
  })

  test('a reaction on a message in a thread goes to that thread\'s conversation', async () => {
    const { w, sent } = setup(cfg('all'))
    w.handle({ channel: CH, ts: '3100.000009', threadTs: THEIRS, user: 'UALICE', text: 'more' })
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react({ itemTs: '3100.000009', itemUser: 'UALICE' }))).toBe('accepted')
    await w.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].msg).toContain('conversation=')
  })

  test('with two apps in a thread, only the one it was most recently bound through hears the reaction', async () => {
    const toml = sharedChannel(CH, places('all'))
    const identities = { default: { botUserId: BOT }, sales: { botUserId: SALES_BOT } }
    const dflt = view(toml, { identities })
    const sales = view(toml, { app: 'sales', botUserId: SALES_BOT, identities })
    const dir = mkdtempSync(join(tmpdir(), 'slack-reactions-'))
    dirs.push(dir)
    let now = 1_000_000_000_000
    const sent: string[] = []
    const w = new SlackWatcher({ now: () => now, file: join(dir, 'w.json'), log: () => {}, config: app => app === 'sales' ? sales : dflt, deliver: async ({ to }) => { sent.push(to); return { ok: true } } })
    w.handle({ channel: CH, ts: OWN, user: BOT, text: 'post' })
    now += 1000
    w.handle({ app: 'sales', channel: CH, ts: OWN, user: SALES_BOT, text: 'post' })
    expect(w.handleReaction(react({ app: 'sales', itemUser: SALES_BOT }))).toBe('accepted')
    expect(w.handleReaction(react({ itemUser: BOT, user: 'UBOB' }))).toBe('ignored')
    await w.flush()
    expect(sent).toEqual(['deals'])
  })

  test('a skin-toned reaction is heard, and reads as the emoji with its tone; a made-up tone is not', async () => {
    const { w, sent } = setup(cfg('bot-messages'))
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react({ reaction: '+1::skin-tone-3' }))).toBe('accepted')
    expect(w.handleReaction(react({ reaction: '+1::skin-tone-9' }))).toBe('ignored')
    await w.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].msg).toContain('reacted :+1: (skin tone 3) to https://acme.slack.com/archives/C0FOOD/p3000000001')
  })

  test('a reaction on the bot\'s own reply inside a thread is heard under bot-messages', async () => {
    const { w, sent } = setup(cfg('bot-messages'))
    w.handle({ channel: CH, ts: '3100.000005', threadTs: THEIRS, user: BOT, text: 'here is your cart' })
    await w.flush(); sent.length = 0
    expect(w.handleReaction(react({ itemTs: '3100.000005', itemUser: BOT }))).toBe('accepted')
    await w.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].msg).toContain(`p3100000005?thread_ts=${THEIRS}`)
    expect(w.get(CH, THEIRS)!.delivered).not.toContain('3100.000005')   // its own words are still never owed or delivered
  })

  test('a reaction on the bot\'s post in its own DM is heard, once the conversation is open; a place with reactions off notes nothing', async () => {
    const DM = 'D0BOT1'
    const toml = (mode: string) => alsoHeard(oneListener(CH, 'helper', '["role:anyone"]', `[places."slack:dm"]\nreactions = "${mode}"\n`), 'helper', 'slack:dm')
    const on = setup(view(toml('bot-messages'), { workspaceUrl: 'https://acme.slack.com' }))
    on.w.handle({ channel: DM, ts: '5000.000001', user: 'UOP', text: 'hello' })
    on.w.handle({ channel: DM, ts: '5000.000002', user: BOT, text: 'hi, how can I help' })
    await on.w.flush(); on.sent.length = 0
    expect(on.w.handleReaction(react({ channel: DM, itemTs: '5000.000002', itemUser: BOT, user: 'UOP' }))).toBe('accepted')
    await on.w.flush()
    expect(on.sent).toHaveLength(1)
    const off = setup(view(toml('off')))
    off.w.handle({ channel: DM, ts: '5000.000001', user: 'UOP', text: 'hello' })
    off.w.handle({ channel: DM, ts: '5000.000002', user: BOT, text: 'hi' })
    expect(off.w.list().find(e => e.channel === DM)).toBeDefined()
    expect(off.w.list().find(e => e.channel === DM)!.ours).toBeUndefined()
  })

  test('one person\'s flood is capped, counted and quiet; another person is not held back', async () => {
    const { w, sent, reacted } = setup(cfg('bot-messages', { maxReactionsPer10Min: 3 }))
    await w.flush(); sent.length = 0; reacted.length = 0
    const out = ['a', 'b', 'c', 'd', 'e'].map((n, i) => w.handleReaction(react({ reaction: n, eventTs: `4000.00001${i}` })))
    expect(out).toEqual(['accepted', 'accepted', 'accepted', 'ignored', 'ignored'])
    expect(w.handleReaction(react({ user: 'UBOB', reaction: 'a' }))).toBe('accepted')
    await w.flush()
    expect(sent).toHaveLength(4)
    expect(w.stats().dropped).toEqual({ 'reaction-cap': 2 })
    expect(reacted).toHaveLength(0)
  })

  test('the gates of a message hold for a reaction: a role taken away before it lands, and the guard', async () => {
    const open = cfg('bot-messages')
    const closed = cfg('bot-messages', { toml: oneListener(CH, 'helper', '[]', places('bot-messages')) })
    const a = setup(open)
    await a.w.flush(); a.sent.length = 0
    expect(a.w.handleReaction(react({ user: 'USTRANGER' }))).toBe('accepted')
    a.set(closed)                                    // before the delivery runs
    await a.w.flush()
    expect(a.sent).toHaveLength(0)
    expect(a.w.handleReaction(react({ user: 'USTRANGER', eventTs: '4000.000009' }))).toBe('ignored')

    const guarded = cfg('bot-messages', { toml: oneListener(CH, 'helper', '["role:anyone"]', `[guard]\ncommand = "guard"\n${places('bot-messages')}`) })
    const inputs: string[] = []
    const g = setup(guarded, undefined, async (_g, input) => { inputs.push(input.person ?? 'stranger'); return input.person === null ? { verdict: 'drop' } : { verdict: 'deliver' } })
    await g.w.flush(); g.sent.length = 0
    expect(g.w.handleReaction(react({ user: 'USTRANGER' }))).toBe('accepted')
    expect(g.w.handleReaction(react({ user: 'UOP', reaction: '+1' }))).toBe('accepted')   // the operator is never judged
    await g.w.flush()
    expect(g.sent).toHaveLength(1)
    expect(inputs).toContain('stranger')
    // A reaction the guard dropped may come again.
    expect(g.w.handleReaction(react({ user: 'USTRANGER', eventTs: '4000.000008' }))).toBe('accepted')
  })
})
