import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateSlackWatch, type SlackWatchMigration } from '../migrate-slack-watch.js'
import { planMigrate, applyMigrate } from '../migrate.js'
import { loadHydraConfig } from '../load.js'
import { route } from '../../routing/route.js'
import { mustParsePlace, type HydraConfig } from '../types.js'
import { SLACK_APP_DEFAULTS } from '../types.js'
import { testLoadEnv, answeredKeys, ruleKeys } from './load-env.js'

/** What `hydra migrate` would write: the step's tables, plus an operator and the workdirs specialists.json supplies. */
function toToml(m: SlackWatchMigration): string {
  const v = (x: unknown): string => Array.isArray(x) ? `[${x.map(v).join(', ')}]` : typeof x === 'string' ? JSON.stringify(x) : String(x)
  const table = (head: string, t: Record<string, unknown>) => `[${head}]\n${Object.entries(t).map(([k, x]) => `${k} = ${v(x)}`).join('\n')}\n`
  return [
    'operator = "op"',
    table('slack.apps.default', m.slack.apps.default),
    table('people.op', { addresses: ['slack:U0OPERATOR'] }),
    ...Object.entries(m.people).map(([id, p]) => table(`people.${id}`, p)),
    ...Object.entries(m.specialists).map(([id, s]) => table(`specialists.${id}`, { workdir: `/w/${id}`, ...s })),
    ...m.rules.map(r => `[[rules]]\nplace = ${v(r.place)}\ntarget = ${v(r.target)}\n`),
    ...Object.entries(m.places).map(([p, o]) => table(`places."${p}"`, o)),
    ...(m.guard ? [table('guard', m.guard)] : []),
  ].join('\n')
}
const load = (text: string): HydraConfig => {
  const r = loadHydraConfig(text, testLoadEnv({ home: '/h', sessionNames: [] }))
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n') + '\n' + text)
  return r.config
}
const fate = (h: HydraConfig, user: string, place: string) => {
  const d = route(h, { from: `slack:${user}`, at: [place].map(mustParsePlace), addressed: true })
  return d.fate === 'deliver' || d.fate === 'refused' ? `${d.fate}:${d.to}` : d.fate
}

describe('slack-watch.json → hydra.toml', () => {
  const OLD = {
    botUserId: 'U0BOT',
    people: { U0OLIVE00: { name: 'Olive', role: 'owner' }, U0MAX0000: { name: 'Max', role: 'Floor Manager' }, U0GUS0000: { name: 'Gus' } },
    routes: [
      { channels: ['C0FINANCE'], to: 'books', from: ['owner', 'Floor Manager'], files: true, ack: 'eyes' },
      { channels: ['C0OPS', 'C0OPS2'], to: 'ops' },
      { channels: ['C0LOBBY'], to: 'lobby', from: 'anyone' },
      { dms: true, to: 'assistant', from: ['owner', 'U0GUEST00'] },
    ],
    beforeDeliver: { command: '~/bin/guard.sh', timeout: '2s', includeText: true },
    maxWatches: 80,
  }

  test('routes become rules and reachable_by, and route the same senders the same way', () => {
    const m = migrateSlackWatch(OLD)
    const h = load(toToml(m))
    expect(h.specialists.books).toMatchObject({ reachableBy: ['owner', 'floor-manager'] })
    expect(answeredKeys(h, 'books')).toEqual(['slack:C0FINANCE'])
    expect(m.specialists.books).not.toHaveProperty('listens')
    expect(h.specialists.ops).toMatchObject({ reachableBy: ['people'] })
    expect(answeredKeys(h, 'ops')).toEqual(['slack:C0OPS', 'slack:C0OPS2'])
    expect(h.specialists.assistant).toMatchObject({ reachableBy: ['owner', 'reach-assistant'] })
    expect(answeredKeys(h, 'assistant')).toEqual(['slack:app-dm:*'])
    // Every place a route names is one rule, aimed at the specialist by its kind.
    expect(m.rules).toContainEqual({ place: 'slack:app-dm:*', target: 'specialist:assistant' })
    expect(h.places['slack:C0FINANCE']).toMatchObject({ files: true, ack: 'eyes' })
    expect(h.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'SLOPBOT_SLACK_BOT_TOKEN', socketTokenEnv: 'SLOPBOT_SLACK_APP_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
    expect(h.guard).toMatchObject({ command: '~/bin/guard.sh', timeoutMs: 2000, includeText: true })
    // the same decisions the old routes made
    expect(fate(h, 'U0OLIVE00', 'slack:C0FINANCE')).toBe('deliver:books')
    expect(fate(h, 'U0MAX0000', 'slack:C0FINANCE')).toBe('deliver:books')
    expect(fate(h, 'U0GUS0000', 'slack:C0FINANCE')).toBe('refused:books')
    expect(fate(h, 'U0GUS0000', 'slack:C0OPS2')).toBe('deliver:ops')
    expect(fate(h, 'U0STRANGE', 'slack:C0OPS')).toBe('refused:ops')
    expect(fate(h, 'U0STRANGE', 'slack:C0LOBBY')).toBe('deliver:lobby')
    expect(fate(h, 'U0GUEST00', 'slack:app-dm:*')).toBe('deliver:assistant')
    expect(fate(h, 'U0MAX0000', 'slack:app-dm:*')).toBe('refused:assistant')
  })

  test('what has no hydra.toml form is said, not silently dropped', () => {
    const { notes } = migrateSlackWatch(OLD)
    expect(notes).toEqual([
      'people.U0MAX0000: role "Floor Manager" is now the label "floor-manager"',
      'routes[3].from: U0GUEST00 is a user id, so they now hold the role "reach-assistant"',
      expect.stringContaining("routes[3]: the operator's own DMs reach assistant too"),
      expect.stringContaining('beforeDeliver is now [guard]'),
      'maxWatches = 80 has no hydra.toml key; the default (50) applies',
    ])
    const split = migrateSlackWatch({ botUserId: 'U', people: { U0A: { role: 'a' } }, routes: [{ channels: ['C1'], to: 's', from: ['a'] }, { channels: ['C2'], to: 's', from: 'anyone', beforeDeliver: false }] })
    expect(split.specialists.s.reachable_by).toEqual(['role:a', 'role:anyone'])
    expect(split.notes).toContain('routes[1]: s is reached from several routes with different "from"; its reachable_by is now their union, since one specialist has one reachable_by')
    expect(split.notes).toContain('routes[1].beforeDeliver: a guard per route has no hydra.toml form; [guard] applies to every specialist')
  })

  test("the legacy one-route form, with no roster, stays open to anyone", () => {
    const h = load(toToml(migrateSlackWatch({ botUserId: 'U', channels: ['C1'], specialist: 'helper' })))
    expect(h.specialists.helper).toMatchObject({ reachableBy: ['anyone'] })
    expect(answeredKeys(h, 'helper')).toEqual(['slack:C1'])
  })
})

test('hydra migrate runs it with the other steps: one hydra.toml that loads and routes as before, slack-watch.json retired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-slack-'))
  try {
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['U0OPERATOR'] }))
    writeFileSync(join(dir, 'specialists.json'), JSON.stringify({ books: { channel: 'C0HOME', kickoff: 'k' }, ops: { channel: 'C0HOME', kickoff: 'k' } }))
    writeFileSync(join(dir, 'slack-watch.json'), JSON.stringify({
      botUserId: 'U0BOT',
      people: { U0OPERATOR: { name: 'Op', role: 'owner' }, U0MAX0000: { name: 'Max', role: 'staff' } },
      routes: [{ channels: ['C0FINANCE'], to: 'books', from: ['owner', 'staff'] }, { dms: true, to: 'ops', from: ['owner'] }],
    }))
    const env = testLoadEnv({ home: '/h', sessionNames: [] })
    const plan = planMigrate({ stateDir: dir, env, spawnCwd: '/w', platform: 'slack' })
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    const h = load(plan.text)
    expect(h.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'SLOPBOT_SLACK_BOT_TOKEN', socketTokenEnv: 'SLOPBOT_SLACK_APP_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
    expect(Object.values(h.people).find(p => p.addresses.includes('slack:U0OPERATOR'))!.roles).toEqual(['owner']) // one person, merged by address
    expect(h.specialists.books).toMatchObject({ workdir: '/w', reachableBy: ['owner', 'staff'] })
    expect(answeredKeys(h, 'books')).toEqual(['slack:C0FINANCE'])
    expect(fate(h, 'U0MAX0000', 'slack:C0FINANCE')).toBe('deliver:books')
    expect(fate(h, 'U0STRANGE', 'slack:C0FINANCE')).toBe('refused:books')
    expect(fate(h, 'U0OPERATOR', 'slack:app-dm:*')).toBe('deliver:ops')
    applyMigrate(dir, plan)
    expect(existsSync(join(dir, 'slack-watch.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'slack-watch.json.migrated'), 'utf8')).botUserId).toBe('U0BOT')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
