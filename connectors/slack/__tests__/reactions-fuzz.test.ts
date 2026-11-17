// A reaction is a message from its person to the conversation it lands in, so it must reach a session exactly when a message from that person there would.
// Generated cases run both on identical histories and compare what was delivered end to end (routing, the guard, the owning app), and count where they agree.
import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackWatchConfig } from '../watch.js'
import { BOT, SALES_BOT, oneListener, alsoHeard, sharedChannel, view } from './slack-config.js'

const CH = 'C0FOOD'
const DM = 'D0BOT1'
const OWN = '3000.000001'
const THREAD_REPLY = '3100.000001'
const OWN_REPLY = '3100.000005'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// A small seeded generator: the same cases on every run.
let seed = 711
const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n }
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]

const PEOPLE = `[people.bea]\naddresses = ["slack:UBEA"]\nroles = ["owner"]\n[people.cal]\naddresses = ["slack:UCAL"]\n[people.dee]\naddresses = ["slack:UDEE"]\nroles = ["owner", "ops"]\n`
const USERS = ['UOP', 'UBEA', 'UCAL', 'UDEE', 'USTRANGER', 'UOTHER', BOT, SALES_BOT] as const
const REACH = ['[]', '["role:anyone"]', '["role:owner"]', '["role:people"]', '["role:ops"]', '["role:owner", "role:ops"]'] as const
const SHAPES = ['top', 'reply', 'ownReply', 'dm', 'two'] as const
type Shape = typeof SHAPES[number]
type Case = { shape: Shape; reach: string; mode: 'off' | 'bot-messages' | 'all'; guard: boolean; via: boolean; user: string; app: 'default' | 'sales'; item: 'known' | 'person' | 'unknown' }

/** A watcher holding the case's history, and a way to learn whether the next thing it was given reached a session. */
function holder(c: Case) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-fuzz-'))
  dirs.push(dir)
  const dm = c.shape === 'dm'
  const place = `[places."${dm ? 'slack:dm' : `slack:${CH}`}"]\nreactions = "${c.mode}"\n`
  const extra = `${PEOPLE}${c.guard ? '[guard]\ncommand = "guard"\n' : ''}${place}`
  const toml = dm ? alsoHeard(oneListener(CH, 'helper', c.reach, extra), 'helper', 'slack:dm')
    : c.shape === 'two' ? sharedChannel(CH, extra).replaceAll('["role:anyone"]', c.reach)
    : oneListener(CH, 'helper', c.reach, extra)
  const identities = { default: { botUserId: BOT }, sales: { botUserId: SALES_BOT } }
  const byApp: Record<string, SlackWatchConfig> = { default: view(toml, { identities }), sales: view(toml, { app: 'sales', botUserId: SALES_BOT, identities }) }
  let now = 1_000_000_000_000
  let sent = 0
  const w = new SlackWatcher({
    now: () => now, file: join(dir, 'w.json'), log: () => {}, config: app => byApp[app ?? 'default'],
    deliver: async () => { sent++; return { ok: true } },
    guard: async (_g, input) => input.person === null ? { fate: 'drop' } : { fate: 'deliver' },
  })
  if (dm) {
    w.handle({ channel: DM, ts: '5000.000001', user: 'UOP', text: 'hello' })
    w.handle({ channel: DM, ts: '5000.000002', user: BOT, text: 'how can I help' })
  } else {
    w.handle({ channel: CH, ts: OWN, user: BOT, text: 'daily post' })
    if (c.shape === 'two') { now += 1000; w.handle({ app: 'sales', channel: CH, ts: OWN, user: SALES_BOT, text: 'daily post' }) }
    if (c.shape === 'reply') w.handle({ channel: CH, ts: THREAD_REPLY, threadTs: OWN, user: 'UOP', text: 'more' })
    if (c.shape === 'ownReply') w.handle({ channel: CH, ts: OWN_REPLY, threadTs: OWN, user: BOT, text: 'here you go' })
    if (c.via) w.setVia(CH, OWN, 'user', c.shape === 'two' ? c.app : undefined)
  }
  const app = c.shape === 'two' ? c.app : undefined
  const botOf = c.app === 'sales' && c.shape === 'two' ? SALES_BOT : BOT
  const target = dm ? { channel: DM, itemTs: c.item === 'person' ? '5000.000001' : '5000.000002', itemUser: c.item === 'person' ? 'UOP' : BOT }
    : c.shape === 'reply' ? { channel: CH, itemTs: THREAD_REPLY, itemUser: 'UOP' }
    : c.shape === 'ownReply' ? { channel: CH, itemTs: OWN_REPLY, itemUser: BOT }
    : { channel: CH, itemTs: OWN, itemUser: c.item === 'person' ? 'UOTHER' : botOf }
  return {
    async settled() { await w.flush(); sent = 0 },
    async message(): Promise<boolean> { w.handle({ ...(app && { app }), channel: dm ? DM : CH, ts: dm ? '5000.000050' : '3000.000050', ...(!dm && { threadTs: OWN }), user: c.user, text: 'x' }); await w.flush(); return sent > 0 },
    async reaction(): Promise<boolean> {
      w.handleReaction({ ...(app && { app }), ...target, ...(c.item === 'unknown' && { itemTs: '9999.000001' }), reaction: 'white_check_mark', user: c.user, eventTs: '4000.000001' })
      await w.flush()
      return sent > 0
    },
  }
}

test('a reaction reaches the session exactly where a message from the same person in that conversation would', async () => {
  const comparable: Record<string, { cases: number; both: number; neither: number }> = Object.fromEntries(SHAPES.map(s => [s, { cases: 0, both: 0, neither: 0 }]))
  const design = { optionOff: 0, botMessagesOnPersonsMessage: 0, noConversation: 0, readWithOperatorToken: 0 }
  let total = 0, differ = 0, guarded = 0
  for (let i = 0; i < 4000; i++) {
    const c: Case = {
      shape: pick(SHAPES), reach: pick(REACH), user: pick(USERS), guard: rnd(3) === 0, via: rnd(8) === 0, app: pick(['default', 'sales'] as const),
      mode: pick(['off', 'bot-messages', 'bot-messages', 'all', 'all', 'all'] as const), item: pick(['known', 'known', 'known', 'person', 'unknown'] as const),
    }
    total++
    // Where the option or the kind of message says no, or the conversation is the operator's own token's, a reaction stops by design: pinned, not compared.
    const stop = c.mode === 'off' ? 'optionOff' : c.item === 'unknown' ? 'noConversation' : c.via && c.shape !== 'dm' ? 'readWithOperatorToken'
      : c.mode === 'bot-messages' && (c.shape === 'reply' || (c.item === 'person' && c.shape !== 'ownReply')) ? 'botMessagesOnPersonsMessage' : undefined
    const child = holder(c)
    await child.settled()
    const got = await child.reaction()
    if (stop) { design[stop]++; expect(got, `${stop}: ${JSON.stringify(c)}`).toBe(false); continue }
    const parent = holder(c)
    await parent.settled()
    const want = await parent.message()
    const bucket = comparable[c.shape]
    bucket.cases++
    if (c.guard) guarded++
    if (got !== want) { differ++; throw new Error(`differs: ${JSON.stringify(c)}: a message ${want ? 'is' : 'is not'} delivered, a reaction ${got ? 'is' : 'is not'}`) }
    if (got) bucket.both++; else bucket.neither++
  }
  const compared = Object.values(comparable).reduce((n, b) => n + b.cases, 0)
  console.log(`reaction fuzz: ${JSON.stringify({ total, compared, differ, guardedAmongCompared: guarded, byShape: comparable, stoppedByDesign: design })}`)
  expect(differ).toBe(0)
  for (const s of SHAPES) { expect(comparable[s].both, s).toBeGreaterThan(20); expect(comparable[s].neither, s).toBeGreaterThan(20) }
}, 120_000)
