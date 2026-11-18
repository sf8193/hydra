// Differential fuzz: what the Slack connector does with a message, under a generated hydra.toml, against the same file plus the
// operator's rule (`[[rules]] app = "app:default" person = "person:op" target = "main"`, the app holding the operator's token). Both apps'
// connections handle every message, as each hears it: each outcome and each delivery's target must agree, except where the operator tags
// their own app in a thread nothing holds and no rule sends: there it was unrouted and now goes to main. The left side is the parent's:
// this PR's one change to what the connector does (a session's thread is not taken back by main through a rule that names no place) acts
// only where a rule sends every place to main, and the generated files without the operator's rule never have one.
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHydraConfig } from '../../../config/load.js'
import { testLoadEnv } from '../../../config/__tests__/load-env.js'
import { ConversationTable, SLACK_LIMITS, type ConversationConfig, type DeliverResult, type HandleOutcome } from '../watch.js'
import { BOT, SALES_BOT, directory } from './slack-config.js'

process.stderr.write = (() => true) as any

function rng(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
type R = () => number
const pick = <T,>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const chance = (r: R, p: number) => r() < p

const OPERATOR_RULE = '\n[[rules]]\napp = "app:default"\nperson = "person:op"\ntarget = "main"\n'
const CHANNELS = ['C0DESK', 'C0SALES', 'C0BOTH', 'C0ELSE'] as const
const DMS = { D0BOT0001: 'bot', D0ALICE01: 'UALICE' } as const
const USERS = ['UOP', 'UALICE', 'UBOB', 'UNOBODY'] as const
const SESSION = '1552619225032425525'

/** A hydra.toml: the operator's app (`default`, with the operator token) and sometimes a restricted app with its own pinned specialist. */
function genToml(r: R): string {
  const sales = chance(r, 0.7)
  const lines = [
    'operator = "op"',
    '[slack.apps.default]\nbot_token_env = "A_BOT"\nsocket_token_env = "A_APP"\noperator_token_env = "A_USER"',
    ...(sales ? ['[slack.apps.sales]\nbot_token_env = "S_BOT"\nsocket_token_env = "S_APP"'] : []),
    '[people.op]\naddresses = ["slack:UOP"]',
    '[people.alice]\naddresses = ["slack:UALICE"]\nroles = ["staff"]',
    '[people.bob]\naddresses = ["slack:UBOB"]',
    `[specialists.desk]\nworkdir = "/w/desk"\nreachable_by = [${pick(r, ['"role:anyone"', '"role:people"', '"role:staff"', ''])}]`,
    ...(sales ? [`[specialists.deals]\nworkdir = "/w/deals"\npinned_to = ["app:sales"]\nrestricted = true\nreachable_by = [${pick(r, ['"role:anyone"', '"role:people"', '"role:staff"'])}]`] : []),
  ]
  const rule = (place: string | undefined, target: string, extra = '') => `[[rules]]\n${place ? `place = "slack:${place}"\n` : ''}${extra}target = "${target}"`
  if (chance(r, 0.8)) lines.push(rule(pick(r, ['C0DESK', 'C0BOTH']), 'specialist:desk', chance(r, 0.2) ? 'person = "role:staff"\n' : ''))
  if (sales && chance(r, 0.8)) lines.push(rule(pick(r, ['C0SALES', 'C0BOTH']), 'specialist:deals', 'app = "app:sales"\n'))
  if (sales && chance(r, 0.2)) lines.push(rule(undefined, 'specialist:deals', 'app = "app:sales"\n'))
  if (chance(r, 0.15)) lines.push(rule(pick(r, ['C0ELSE', 'C0DESK']), 'main'))
  if (chance(r, 0.15)) lines.push(rule('app-dm:default', 'specialist:desk'))
  if (chance(r, 0.3)) lines.push(`[places."slack:${pick(r, CHANNELS)}"]\nmessages = "${pick(r, ['all', 'addressed'])}"${sales && chance(r, 0.5) ? `\ndefault_app = "app:${pick(r, ['default', 'sales'])}"` : ''}`)
  return lines.join('\n')
}

const env = testLoadEnv({ home: '/home/op', sessionNames: [] })
const counts = { configs: 0, skippedConfigs: 0, messages: 0, handled: 0, agree: 0, differ: 0, differOperatorTag: 0, differOperatorWholePlace: 0, differOperatorGoneBinding: 0 }
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

type Msg = { channel: string; ts: string; threadTs?: string; user: string; text: string; bound?: string; boundApp?: string }

/** One app's connection, under one file: what it does with each message, and where each thread's deliveries went. */
function run(toml: string, app: string, members: Record<string, string[]>, msgs: Msg[]): { outcomes: HandleOutcome[]; to: Map<string, string[]> } | null {
  const loaded = loadHydraConfig(toml, env)
  if (!loaded.ok) return null
  if (!loaded.config.slackApps[app]) return { outcomes: msgs.map(() => 'ignored'), to: new Map() }
  const several = Object.keys(loaded.config.slackApps).length > 1
  const ids: Record<string, { botUserId: string }> = { default: { botUserId: BOT }, ...(several && { sales: { botUserId: SALES_BOT } }) }
  const cfg: ConversationConfig = {
    hydra: loaded.config, app, botUserId: ids[app].botUserId, workspaceUrl: 'https://x.slack.com',
    directory: directory({}, { ...DMS }), ...SLACK_LIMITS, coalesceMs: 1, maxConversations: 10_000, maxMentionsPer10Min: 10_000,   // no cap: a cap counts conversations opened, which the operator's rule adds to
    ...(several && { identities: ids, heardBy: (ch: string) => members[ch] ?? [], connected: () => Object.keys(ids) }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'op-tag-fuzz-'))
  dirs.push(dir)
  const to = new Map<string, string[]>()
  const w = new ConversationTable({
    now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => cfg, alert: () => {},
    deliver: async (t, _msg): Promise<DeliverResult> => { const k = t.conversation ?? '?'; to.set(k, [...(to.get(k) ?? []), t.to]); return { ok: true } },
  })
  const outcomes = msgs.map(m => {
    if (m.bound && (m.boundApp ?? 'default') === app) w.bind(m.channel, m.threadTs ?? m.ts, m.bound, 'cli', app === 'default' ? undefined : app)
    return w.handle({ channel: m.channel, ts: m.ts, ...(m.threadTs && { threadTs: m.threadTs }), user: m.user, text: m.text, app: app === 'default' ? undefined : app })
  })
  return { outcomes, to }
}

describe("differential fuzz: the operator's rule against the same hydra.toml without it", () => {
  test('both connections agree on every message, but for the operator tagging their own app where nothing holds the thread', async () => {
    const r = rng(20261118)
    for (let i = 0; i < 300; i++) {
      const base = genToml(r)
      const members: Record<string, string[]> = Object.fromEntries(CHANNELS.map(c => [c, ['default', 'sales'].filter(() => chance(r, 0.5))]))
      const msgs: Msg[] = Array.from({ length: 40 }, (_, j) => {
        const where = pick(r, [...CHANNELS, ...CHANNELS, 'D0BOT0001', 'D0ALICE01'])
        const ts = `${2000 + j}.000001`
        const reply = chance(r, 0.4)
        const tags = pick(r, ['', `<@${BOT}> `, `<@${SALES_BOT}> `, `<@${SALES_BOT}> <@${BOT}> `, `<@${BOT}> `])
        const bound = !where.startsWith('D') && chance(r, 0.25) ? pick(r, ['desk', 'deals', 'main', SESSION]) : undefined
        return { channel: where, ts: reply ? `${2000 + j}.000002` : ts, ...(reply && { threadTs: ts }), user: pick(r, USERS), text: `${tags}hello`, ...(bound && { bound, boundApp: pick(r, ['default', 'sales']) }) }
      })
      const sides = ['default', 'sales'].map(app => [run(base, app, members, msgs), run(base + OPERATOR_RULE, app, members, msgs)] as const)
      if (sides.some(([a, b]) => !a || !b)) { counts.skippedConfigs++; continue }
      counts.configs++
      for (const [app, [a, b]] of [['default', sides[0]], ['sales', sides[1]]] as const) {
        await Bun.sleep(5)
        for (const [j, m] of msgs.entries()) {
          counts.messages += app === 'default' ? 1 : 0
          counts.handled++
          const conv = `slack:${app === 'default' ? '' : `${app}:`}${m.channel}:${m.channel.startsWith('D') && !m.threadTs ? 'top' : m.threadTs ?? m.ts}`
          const left = { outcome: a!.outcomes[j], to: a!.to.get(conv) ?? [] }
          const right = { outcome: b!.outcomes[j], to: b!.to.get(conv) ?? [] }
          if (JSON.stringify(left) === JSON.stringify(right)) { counts.agree++; continue }
          counts.differ++
          // The one difference meant: the operator's own message through their own app, which nothing holds and no rule sends (unrouted
          // before), now goes to main. Unrouted on the left means nothing held the thread: a binding that holds always delivers or refuses.
          const own = app === 'default' && m.user === 'UOP' && left.outcome === 'unrouted' && right.to.length > 0 && right.to.every(t => t === 'main')
          expect(own, `config #${i}\n${base}\nmessage ${JSON.stringify(m)} through ${app}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`).toBe(true)
          // How it was addressed: a tag of the app; a place that hears every message (`messages = "all"`); or a conversation whose specialist hydra.toml no longer declares.
          if (m.text.includes(`<@${BOT}>`)) counts.differOperatorTag++
          else if (m.bound && !new RegExp(`\\[specialists\\.${m.bound}\\]`).test(base)) counts.differOperatorGoneBinding++
          else counts.differOperatorWholePlace++
        }
      }
    }
    expect(counts.differOperatorTag).toBeGreaterThan(0)
    expect(counts.configs).toBeGreaterThan(200)
  })

  test('the counts', () => {
    process.stdout.write(`operator-tag fuzz: ${JSON.stringify(counts)}\n`)
  })
})
