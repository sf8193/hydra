import { describe, test, expect } from 'bun:test'
import { loadHydraConfig, VITALS_DEFAULTS } from '../load.js'
import { SLACK_APP_DEFAULTS } from '../../connectors/slack/app.js'
import { defaultSlackApp, placesAnsweredBy, type HydraConfig, type LoadEnv, type LoadResult } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env: LoadEnv = testLoadEnv({
  home: '/home/op',
  isDir: p => ['/home/op', '/home/op/agents/ops', '/home/op/agents/crm', '/home/op/agents/desk', '/srv/review'].includes(p),
  isCommand: c => c === '/home/op/bin/guard' || c === 'bun',
  sessionNames: ['spark', 'glyph'],
})

const ok = (text: string): { config: HydraConfig; warnings: string[] } => {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.map(e => `${e.path}: ${e.message}`).join('\n')}`)
  // The reachability warning (specialists.<id>: ... reach the operator's account) has its own tests, in access.test.ts.
  return { config: r.config, warnings: r.warnings.filter(w => !w.message.includes("the operator's account")).map(w => `${w.path}: ${w.message}`) }
}
const errorsOf = (text: string): string[] => {
  const r: LoadResult = loadHydraConfig(text, env)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(e => `${e.path}: ${e.message}`)
}

// The smallest file with an operator, to build cases on.
const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
`

describe('an empty file', () => {
  test('is valid: no operator, nothing heard', () => {
    expect(ok('').config).toEqual({ connectors: {}, gateways: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] })
    expect(ok('# just a comment\n').warnings).toEqual([])
  })
})

describe('a full file', () => {
  const text = `
operator = "op"
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
socket_token_env = "CONNECTOR_SLACK_APP_TOKEN"
[connectors.github]
repos = ["Acme/Widget"]
[people.op]
addresses = ["slack:U0OP", "github:Op-Login"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
name = "Alice"
[defaults.specialist]
kickoff = "/orient {id}"
idle = "4h"
[specialists.crm]
workdir = "~/agents/crm"
reachable_by = ["role:staff"]
sessions = "per-conversation"
max_sessions = 5
[specialists.ops]
workdir = "~/agents/ops"
kickoff_file = "kickoff.md"
reachable_by = []
engine = "codex"
renamed_from = ["old-ops"]
[specialists.review]
workdir = "/srv/review"
[places."slack:#help"]
messages = "all"
ack = "eyes"
[schedules.nightly]
cron = "0 3 * * *"
target = "specialist:ops"
message = "Nightly run."
[[rules]]
place = "slack:#help"
person = "person:alice"
target = "specialist:ops"
[guard]
command = "~/bin/guard --strict"
timeout = "2s"
[[rules]]
place = "slack:#help"
target = "specialist:crm"
[[rules]]
place = "slack:dm"
target = "specialist:ops"
[[rules]]
place = "github:acme/widget"
target = "specialist:review"
`
  test('loads with every default filled in', () => {
    const { config, warnings } = ok(text)
    expect(warnings).toEqual([])
    expect(config.operator).toBe('op')
    expect(config.connectors).toEqual({ github: { repos: ['acme/widget'], pollMs: 180_000 } })
    expect(config.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'CONNECTOR_SLACK_BOT_TOKEN', socketTokenEnv: 'CONNECTOR_SLACK_APP_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
    expect(config.people.op).toEqual({ id: 'op', addresses: ['slack:U0OP', 'github:op-login'], roles: [] })
    expect('name' in config.people.op).toBe(false)
    expect(config.people.alice.name).toBe('Alice')
    expect(config.specialists.crm).toEqual({
      id: 'crm', workdir: '/home/op/agents/crm', kickoff: '/orient crm', reachableBy: ['staff'],
      sessions: 'per-conversation', maxSessions: 5, idleMs: 4 * 3_600_000, renamedFrom: [], restricted: false,
    })
    // Its own kickoff_file replaces the default kickoff; a relative kickoff_file is under the workdir.
    expect(config.specialists.ops).toMatchObject({ kickoffFile: '/home/op/agents/ops/kickoff.md', reachableBy: [], engine: 'codex', renamedFrom: ['old-ops'], sessions: 'shared', maxSessions: 20 })
    expect(config.specialists.ops.kickoff).toBeUndefined()
    expect(config.specialists.review.reachableBy).toEqual(['people'])
    expect(config.places['slack:#help']).toEqual({ ack: 'eyes', files: false, messages: 'all', bots: false, reactions: 'off', linkPreviews: true })
    expect(config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', target: 'ops', message: 'Nightly run.', runner: 'launchd' })
    expect(config.rules).toEqual([{ place: 'slack:#help', person: 'alice', target: 'ops' }, { place: 'slack:#help', target: 'crm' }, { place: 'slack:dm', target: 'ops' }, { place: 'github:acme/widget', target: 'review' }])
    // `crm` and `ops` hear where the rules say.
    expect(placesAnsweredBy(config, 'crm')).toEqual(['slack:#help'])
    expect(config.guard).toEqual({ command: '~/bin/guard --strict', timeoutMs: 2000, includeText: false, owedMaxMs: 3_600_000 })
  })
})

describe('the Discord gateway: [gateways.discord]', () => {
  const B = BASE.replace('addresses = ["slack:U0OP"]', 'addresses = ["slack:U0OP", "discord:1"]')
  const GW = '[gateways.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n'
  test('loads, with no warning', () => {
    const r = ok(`${B}\n${GW}`)
    expect(r.config.gateways).toEqual({ discord: { botTokenEnv: 'DISCORD_BOT_TOKEN' } })
    expect(r.config.connectors).toEqual({})
    expect(r.warnings).toEqual([])
  })
  test('its keys are checked like any table', () => {
    expect(errorsOf(`${B}\n[gateways.discord]\nbot_token_env = "lower"\nx = 1\n`)).toEqual([
      'gateways.discord.x: unknown key "x"',
      'gateways.discord.bot_token_env: "lower" must name an environment variable, like DISCORD_BOT_TOKEN',
    ])
    expect(errorsOf(`${B}\n[gateways.discord]\n`)).toEqual(['gateways.discord.bot_token_env: is required'])
    expect(errorsOf(`${B}\n[gateways.irc]\nx = 1\n`)).toEqual(['gateways.irc: unknown key "irc"'])
  })
  test('the old home, [connectors.discord], is an unknown key', () => {
    expect(errorsOf(`${B}\n[connectors.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)).toEqual(['connectors.discord: unknown key "discord"'])
  })
  test('a specialist listening on discord with neither warns, naming the new key', () => {
    expect(ok(`${B}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "discord:#feed"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(["specialists.ops: a rule sends discord:#feed to it, but [gateways.discord] isn't set, so it won't hear it"])
  })
})

describe('places', () => {
  test('a channel by name or by platform id', () => {
    const { config } = ok(`${BASE}
[slack.apps.default]
bot_token_env = "T"
[gateways.discord]
bot_token_env = "D"
[specialists.ops]
workdir = "~/agents/ops"
sessions = "per-conversation"
[places."slack:G0PRIV"]
files = true
[[rules]]
place = "slack:C0TEST"
target = "specialist:ops"
[[rules]]
place = "discord:100000000000000001"
target = "specialist:ops"
`)
    expect(placesAnsweredBy(config, 'ops')).toEqual(['slack:C0TEST', 'discord:100000000000000001'])
    expect(config.places['slack:G0PRIV'].files).toBe(true)
  })
})

describe('[defaults.specialist]', () => {
  test('fills {id} into any key, lists included, and a specialist\'s own key wins', () => {
    const { config } = ok(`${BASE}
[defaults.specialist]
workdir = "~/agents/{id}"
renamed_from = ["old-{id}"]
model = "default-model"
[specialists.ops]
[specialists.crm]
model = "own-model"
`)
    expect(config.specialists.ops).toMatchObject({ workdir: '/home/op/agents/ops', model: 'default-model' })
    expect(config.specialists.ops.renamedFrom).toEqual(['old-ops'])
    expect(config.specialists.crm).toMatchObject({ workdir: '/home/op/agents/crm', model: 'own-model' })
    expect(config.specialists.crm.renamedFrom).toEqual(['old-crm'])
  })
  test('a bad default is reported once, at the default', () => {
    expect(errorsOf(`${BASE}
[defaults.specialist]
max_sessions = 0
[specialists.ops]
workdir = "~/agents/ops"
[specialists.crm]
workdir = "~/agents/crm"
[[rules]]
place = "slack:#a"
target = "specialist:ops"
[[rules]]
place = "slack:#b"
target = "specialist:crm"
`)).toEqual(['defaults.specialist.max_sessions: must be a whole number above 0'])
  })
})

describe('load errors', () => {
  const spec = (body: string, id = 'ops') => `${BASE}\n[specialists.${id}]\nworkdir = "~/agents/ops"\n${body}\n[[rules]]\nplace = "slack:#ops"\ntarget = "specialist:${id}"\n`

  test('an unknown specialist, person or role reference', () => {
    expect(errorsOf(`${spec('reachable_by = ["role:staff"]')}
[schedules.nightly]
cron = "0 3 * * *"
target = "specialist:nobody"
[[rules]]
place = "slack:#ops"
person = "person:bob"
target = "specialist:ghost"
`)).toEqual([
      'specialists.ops.reachable_by[0]: no one holds the role "staff": reachable_by lists roles, so give a person that role in [people.<id>] roles',
      'schedules.nightly.target: no specialist "nobody": declare [specialists.nobody], or use main',
      'rules[1].person: "person:bob" is not a person: declare [people.bob]',
      'rules[1].target: no specialist "ghost": declare [specialists.ghost], or use main',
    ])
    expect(errorsOf('operator = "ghost"\n')).toEqual(['operator: "ghost" is not a person: declare [people.ghost]'])
    expect(errorsOf(`${spec('reachable_by = ["alice"]')}\n[people.alice]\naddresses = ["slack:U0A"]\n`))
      .toEqual(['specialists.ops.reachable_by[0]: "alice" does not say its kind: write role:<name>'])
  })

  test('two specialists listening on the same place', () => {
    expect(errorsOf(`${spec('')}
[specialists.crm]
workdir = "~/agents/crm"
[[rules]]
place = "slack:#ops"
target = "specialist:crm"
`)).toEqual(['rules[1]: sends every message at slack:#ops through any app to specialist:crm, but rules[0] already sends them to specialist:ops: give rules[1] a `person`, or remove it'])
  })

  test('one address under two people (GitHub logins compare without case)', () => {
    expect(errorsOf(`${BASE}
[people.alice]
addresses = ["github:Alice"]
[people.al]
addresses = ["github:alice"]
`)).toEqual(['people.al.addresses[0]: github:alice already belongs to alice: one address, one person'])
  })

  test('a missing workdir key, or a workdir that isn\'t a folder', () => {
    expect(errorsOf(`${BASE}\n[specialists.ops]\n[[rules]]\nplace = "slack:#ops"\ntarget = "specialist:ops"\n`)).toEqual(['specialists.ops.workdir: is required: the folder it runs in'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/gone"\n[[rules]]\nplace = "slack:#ops"\ntarget = "specialist:ops"\n`)).toEqual(['specialists.ops.workdir: /home/op/agents/gone is not a folder'])
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nworkdir = "~/agents/{id}"\n[specialists.gone]\n[[rules]]\nplace = "slack:#ops"\ntarget = "specialist:gone"\n`))
      .toEqual(['specialists.gone.workdir (from defaults.specialist): /home/op/agents/gone is not a folder'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "agents/ops"\n[[rules]]\nplace = "slack:#ops"\ntarget = "specialist:ops"\n`)).toEqual(['specialists.ops.workdir: "agents/ops" must be an absolute path or start with ~'])
  })

  test('a schedule with no target is a sensor: it needs a check and takes no message', () => {
    expect(ok(`${BASE}\n[schedules.keepalive]\ncron = "*/5 * * * *"\ncheck = "~/ensure.sh"\n`).config.schedules.keepalive)
      .toEqual({ id: 'keepalive', cron: '*/5 * * * *', message: '', check: '~/ensure.sh', runner: 'launchd' })
    expect(errorsOf(`${BASE}\n[schedules.a]\ncron = "@daily"\n[schedules.b]\ncron = "@daily"\ncheck = "c.sh"\nmessage = "hi"\n`)).toEqual([
      'schedules.a.target: is required unless there is a check (a sensor): specialist:<name>, or main',
      'schedules.b.message: a schedule with no target sends nothing, so it takes no message',
    ])
  })

  test('needs and alert_after: a daemon schedule\'s, refused on launchd', () => {
    const { config } = ok(`${BASE}\n[schedules.pull]\ncron = "23 * * * *"\ncheck = "pull.sh"\nrunner = "daemon"\nneeds = ["internet", "internet"]\nalert_after = "2d"\n`)
    expect(config.schedules.pull).toEqual({ id: 'pull', cron: '23 * * * *', message: '', check: 'pull.sh', runner: 'daemon', needs: ['internet'], alertAfterMs: 2 * 86_400_000 })
    expect(errorsOf(`${BASE}\n[schedules.a]\ncron = "@daily"\ncheck = "c.sh"\nneeds = ["internet"]\nalert_after = "1h"\n[schedules.b]\ncron = "@daily"\ncheck = "c.sh"\nrunner = "daemon"\nneeds = ["power"]\nalert_after = "31d"\n`)).toEqual([
      'schedules.a.needs: needs runner = "daemon"',
      'schedules.a.alert_after: needs runner = "daemon"',
      'schedules.b.needs[0]: unknown precondition "power" (known: internet)',
      'schedules.b.alert_after: "31d" must be a duration like 90s, 5m or 2h, at most 30d',
    ])
  })

  test('main is a target for a schedule or a rule, though never declared', () => {
    const { config } = ok(`${BASE}\n[schedules.digest]\ncron = "@daily"\ntarget = "main"\n[[rules]]\nplace = "slack:#ops"\ntarget = "main"\n`)
    expect(config.schedules.digest.target).toBe('main')
    expect(config.rules).toEqual([{ place: 'slack:#ops', target: 'main' }])
  })

  test('a bad cron', () => {
    expect(errorsOf(`${spec('')}\n[schedules.nightly]\ncron = "0 25 * * *"\ntarget = "specialist:ops"\n`)).toEqual(['schedules.nightly.cron: invalid cron expression "0 25 * * *": 25 is out of range 0-23'])
  })

  test('[vitals]: absent is the defaults; an empty table fills them in; keys override', () => {
    expect(ok(BASE).config.vitals).toBeUndefined()
    expect(VITALS_DEFAULTS).toEqual({ overloadLoadPerCore: 1.5, overloadIdlePct: 15, swapUsedPct: 85, ticks: 3, resumeSettleMs: 20 * 60_000, memoryCooldownMs: 24 * 3_600_000 })
    expect(ok(`${BASE}\n[vitals]\n`).config.vitals).toEqual(VITALS_DEFAULTS)
    expect(ok(`${BASE}\n[vitals]\noverload_load_per_core = 2\noverload_idle_pct = 10\nswap_used_pct = 90.5\nticks = 5\nresume_settle = "30m"\nmemory_cooldown = "12h"\n`).config.vitals)
      .toEqual({ overloadLoadPerCore: 2, overloadIdlePct: 10, swapUsedPct: 90.5, ticks: 5, resumeSettleMs: 30 * 60_000, memoryCooldownMs: 12 * 3_600_000 })
  })

  test('[vitals]: a bad value or unknown key is reported at its path', () => {
    expect(errorsOf(`${BASE}\n[vitals]\nswap_used_pct = 120\nticks = 0\nresume_settle = "soon"\nidle = 3\n`)).toEqual([
      'vitals.idle: unknown key "idle"',
      'vitals.swap_used_pct: must be a number above 0, at most 100',
      'vitals.ticks: must be a whole number above 0',
      'vitals.resume_settle: "soon" must be a duration like 90s, 5m or 2h, at most 1d',
    ])
    expect(errorsOf(`${BASE}\n[vitals]\noverload_idle_pct = "15%"\n`)).toEqual(['vitals.overload_idle_pct: must be a number above 0, at most 100'])
  })

  test('a guard command that doesn\'t exist', () => {
    expect(errorsOf(`${BASE}\n[guard]\ncommand = "~/bin/missing --x"\n`)).toEqual(['guard.command: /home/op/bin/missing is not an executable file or a command on PATH'])
    expect(ok(`${BASE}\n[guard]\ncommand = "bun ~/hook.ts"\n`).config.guard?.command).toBe('bun ~/hook.ts')
  })

  test('specialist ids follow the daemon\'s name rule, old ids too', () => {
    expect(errorsOf(`${BASE}\n[specialists.123]\nworkdir = "~/agents/ops"\n`)).toEqual(['specialists.123: specialist name "123" needs a letter: an all-digit name reads as a thread id'])
    expect(errorsOf(`${BASE}\n[specialists.spark]\nworkdir = "~/agents/ops"\n`)).toEqual(['specialists.spark: "spark" is a default session name; a specialist needs its own name'])
    expect(errorsOf(`${BASE}\n[specialists.main]\nworkdir = "~/agents/ops"\n`)).toEqual(['specialists.main: "main" is a reserved address (to = "main", send_to_thread target "parent")'])
    expect(errorsOf(spec('renamed_from = ["Ops_Old"]'))).toEqual(['specialists.ops.renamed_from[0]: specialist name must be lowercase letters, digits and dashes'])
    expect(errorsOf(`${spec('renamed_from = ["crm"]')}\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nplace = "slack:#crm"\ntarget = "specialist:crm"\n`)).toEqual(['specialists.ops.renamed_from[0]: "crm" is a current specialist; an old id can\'t be in use'])
  })

  test('a DM with a person is slack:dm:<person>, a group DM slack:group-dm or its id; slack:dm stays the bot\'s', () => {
    const base = `${BASE}\n[people.alice]\naddresses = ["slack:U0A"]\n`
    const c = ok(`${base}[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = []\n[places."slack:dm:alice"]\nack = "eyes"\n[[rules]]\nplace = "slack:dm:alice"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:group-dm"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:G0GROUP1"\ntarget = "specialist:ops"\n`).config
    expect(placesAnsweredBy(c, 'ops')).toEqual(['slack:dm:alice', 'slack:group-dm', 'slack:G0GROUP1'])
    expect(c.places['slack:dm:alice'].ack).toBe('eyes')
    expect(c.rules[0].place).toBe('slack:dm:alice')
    expect(errorsOf(`${base}[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:group-dm:x"\ntarget = "specialist:ops"\n[[rules]]\nplace = "discord:group-dm"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:dm:"\ntarget = "specialist:ops"\n`).map(e => e.split(':')[0])).toEqual(['rules[0].place', 'rules[1].place', 'rules[2].place'])
  })

  test('slack:dm:<person> names a person declared in [people] with a Slack address', () => {
    const spec = (place: string, people = '[people.alice]\naddresses = ["slack:U0A"]\n') => `${BASE}\n${people}[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = []\n[[rules]]\nplace = "${place}"\ntarget = "specialist:ops"\n`
    expect(errorsOf(spec('slack:dm:ghost'))).toEqual(['rules[0].place: "slack:dm:ghost": ghost is not a person: declare [people.ghost]'])
    expect(errorsOf(spec('slack:dm:bea', '[people.bea]\naddresses = ["github:bea"]\n'))).toEqual(['rules[0].place: "slack:dm:bea": bea has no slack: address; add one to people.bea.addresses'])
    expect(errorsOf(`${BASE}\n[[rules]]\nplace = "slack:dm:ghost"\ntarget = "main"\n`)).toEqual(['rules[0].place: "slack:dm:ghost": ghost is not a person: declare [people.ghost]'])
  })

  test('link_previews, messages and bots on a DM with a person or a group DM are errors (ack and files apply); the bot\'s DM keeps them', () => {
    const people = '[people.alice]\naddresses = ["slack:U0A"]\n'
    for (const [place, key, value] of [['slack:group-dm', 'link_previews', 'false'], ['slack:dm:alice', 'link_previews', 'false'], ['slack:dm:alice', 'messages', '"all"'], ['slack:group-dm', 'bots', 'true']]) {
      expect(errorsOf(`${BASE}\n${people}[places."${place}"]\n${key} = ${value}\n`)).toEqual([`places."${place}".${key}: ${key} does not apply to ${place}: only ack and files do. Remove it.`])
    }
    expect(ok(`${BASE}\n[places."slack:dm"]\nlink_previews = false\nbots = true\n`).config.places['slack:dm'].linkPreviews).toBe(false)
    expect(ok(`${BASE}\n[places."slack:group-dm"]\nack = "eyes"\nfiles = true\n`).config.places['slack:group-dm']).toMatchObject({ ack: 'eyes', files: true })
  })

  test('a person id is lowercase, so slack:dm:Alice is not a place', () => {
    expect(errorsOf(`${BASE}\n[people.alice]\naddresses = ["slack:U0A"]\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:dm:Alice"\ntarget = "specialist:ops"\n`)[0]).toContain('"slack:dm:Alice" is not a place')
  })

  test('strict: unknown keys, malformed places and addresses', () => {
    expect(errorsOf(`colour = "red"\n${BASE}`)).toEqual(['colour: unknown key "colour"'])
    expect(errorsOf(spec('listen = ["slack:#x"]'))).toEqual(['specialists.ops.listen: unknown key "listen"'])
    expect(errorsOf(`${BASE}\n[connectors.irc]\nx = 1\n`)).toEqual(['connectors.irc: unknown key "irc"'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:help"\ntarget = "specialist:ops"\n[[rules]]\nplace = "discord:#Feed"\ntarget = "specialist:ops"\n`)).toEqual([
      'rules[0].place: "slack:help" is not a place: use slack:#channel, slack:<channel id>, slack:dm, slack:dm:<person>, slack:group-dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli',
      'rules[1].place: "discord:#Feed" is not a place: use slack:#channel, slack:<channel id>, slack:dm, slack:dm:<person>, slack:group-dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli',
    ])
    expect(errorsOf(`operator = "op"\n[people.op]\naddresses = ["U0OP", "discord:abc", "slack:u0op"]\n`)).toEqual([
      'people.op.addresses[0]: "U0OP" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.addresses[1]: "discord:abc" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.addresses[2]: "slack:u0op" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
    ])
    expect(errorsOf(`${BASE}\n[places."slack:#ops"]\nmessages = "everything"\n`)).toEqual(['places."slack:#ops".messages: must be one of "addressed", "all"'])
  })

  test('operator is required once anything is declared, and roles can\'t shadow people or built-ins', () => {
    expect(errorsOf('[people.op]\naddresses = ["slack:U0OP"]\n')).toEqual(['operator: is required: name the person whose DMs reach main and who may reach every specialist'])
    expect(errorsOf(`${BASE}\n[people.alice]\naddresses = ["slack:U0A"]\nroles = ["op", "anyone"]\n`)).toEqual([
      'people.alice.roles[1]: "anyone" is built in: anyone at all holds it already',
      'people.op: "op" is both a person and a role (person:op and role:op); rename one',
    ])
  })

  test('not valid TOML', () => {
    expect(errorsOf('operator = \n')[0]).toStartWith(': not valid TOML:')
  })
})

describe('found in review', () => {
  test('names an object inherits (constructor, toString) are not declarations', () => {
    expect(errorsOf(`${BASE}\n[schedules.s]\ncron = "@daily"\ntarget = "specialist:constructor"\n[[rules]]\nplace = "slack:#x"\nperson = "person:hasOwnProperty"\ntarget = "specialist:toString"\n`)).toEqual([
      'schedules.s.target: no specialist "constructor": declare [specialists.constructor], or use main',
      'rules[0].person: "person:hasOwnProperty" is not a person: declare [people.hasOwnProperty]',
      'rules[0].target: no specialist "toString": declare [specialists.toString], or use main',
    ])
    expect(errorsOf('operator = "constructor"\n')).toEqual(['operator: "constructor" is not a person: declare [people.constructor]'])
  })
  test('a person can\'t take a built-in role\'s name', () => {
    expect(errorsOf(`${BASE}\n[people.anyone]\naddresses = ["slack:U0X"]\n`)).toEqual(['people.anyone: "anyone" is a built-in role; a person needs another id'])
  })
  test('operator is required beside any other table', () => {
    expect(errorsOf('[gateways.discord]\nbot_token_env = "T"\n')).toEqual(['operator: is required: name the person whose DMs reach main and who may reach every specialist'])
  })
  test('the same GitHub place twice, differing in case', () => {
    expect(errorsOf(`${BASE}\n[places."github:Me/R"]\nfiles = true\n[places."github:me/r"]\nfiles = false\n`)).toEqual(['places."github:me/r": github:me/r is already set: places compare without case on GitHub'])
  })
  test('a guard command\'s program is found past env assignments and quotes', () => {
    expect(ok(`${BASE}\n[guard]\ncommand = "FOO=1 '~/bin/guard' --x"\n`).config.guard?.command).toBe("FOO=1 '~/bin/guard' --x")
  })
  test('a bad default is reported once, and a default reachable_by is checked with no specialists', () => {
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nidle = "banana"\nreachable_by = ["role:ghost"]\n[specialists.ops]\nworkdir = "~/agents/ops"\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:#b"\ntarget = "specialist:crm"\n`)).toEqual([
      'defaults.specialist.idle: "banana" must be a duration like 90m, 12h or 4d, at most 7d',
      'defaults.specialist.reachable_by[0]: no one holds the role "ghost": reachable_by lists roles, so give a person that role in [people.<id>] roles',
    ])
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nreachable_by = ["role:ghost"]\n`)).toEqual(['defaults.specialist.reachable_by[0]: no one holds the role "ghost": reachable_by lists roles, so give a person that role in [people.<id>] roles'])
  })
})

describe('found in the second review', () => {
  test('a rule for role:anyone takes the place from the rule after it: an error', () => {
    expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nplace = "slack:#y"\nperson = "role:anyone"\ntarget = "specialist:crm"\n[[rules]]\nplace = "slack:#y"\ntarget = "specialist:ops"\n`))
      .toEqual(['rules[1]: sends every message at slack:#y through any app to specialist:ops, but rules[0] already sends them to specialist:crm: give rules[1] a `person`, or remove it'])
  })
  test('relative paths resolve under the workdir, or the schedule\'s cwd, or are refused', () => {
    const { config } = ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nenv_file = ".env"\n[schedules.a]\ncron = "@daily"\ntarget = "specialist:ops"\nworkdir = "~/jobs"\nenv_file = "a.env"\n`)
    expect(config.specialists.ops.envFile).toBe('/home/op/agents/ops/.env')
    expect(config.schedules.a).toMatchObject({ workdir: '/home/op/jobs', envFile: '/home/op/jobs/a.env' })
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[schedules.a]\ncron = "@daily"\ntarget = "specialist:ops"\nworkdir = "jobs"\n[schedules.b]\ncron = "@daily"\ntarget = "specialist:ops"\nenv_file = "b.env"\n`)).toEqual([
      'schedules.a.workdir: "jobs" must be an absolute path or start with ~',
      'schedules.b.env_file: "b.env" is relative, so it needs an absolute workdir',
    ])
  })
  test('home_place is a place or a channel id', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nhome_place = "discord:#ops"\n[[rules]]\nplace = "cli"\ntarget = "specialist:ops"\n`).config.specialists.ops.homePlace).toBe('discord:#ops')
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nhome_place = "1234567890"\n[[rules]]\nplace = "cli"\ntarget = "specialist:ops"\n`).config.specialists.ops.homePlace).toBe('1234567890')
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nhome_place = "my channel"\n[[rules]]\nplace = "cli"\ntarget = "specialist:ops"\n`)).toEqual(['specialists.ops.home_place: "my channel" must be a place (slack:#channel, discord:#channel, …) or a channel id'])
  })
})

describe('load warnings', () => {
  test('a second rule for everyone at a place is an error naming both', () => {
    expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nplace = "slack:#y"\ntarget = "specialist:crm"\n[[rules]]\nplace = "slack:#y"\ntarget = "specialist:ops"\n`))
      .toEqual(['rules[1]: sends every message at slack:#y through any app to specialist:ops, but rules[0] already sends them to specialist:crm: give rules[1] a `person`, or remove it'])
  })
  test('a rule for a role whose holders all hold an earlier rule\'s role is shadowed', () => {
    const { warnings } = ok(`${BASE}
[people.alice]
addresses = ["slack:U0A"]
roles = ["staff", "lead"]
[people.bob]
addresses = ["slack:U0B"]
roles = ["staff"]
[specialists.crm]
workdir = "~/agents/crm"
[specialists.desk]
workdir = "~/agents/desk"
[[rules]]
place = "slack:#help"
person = "role:staff"
target = "specialist:crm"
[[rules]]
place = "slack:#help"
person = "role:lead"
target = "specialist:desk"
[[rules]]
place = "slack:#help"
person = "role:people"
target = "specialist:desk"
`)
    expect(warnings).toEqual(["rules[1]: never matches: rules[0] already takes role:lead's messages at slack:#help"])
  })

  test('a rule that an earlier rule shadows', () => {
    const { warnings } = ok(`${BASE}
[slack.apps.default]
bot_token_env = "T"
[people.alice]
addresses = ["slack:U0A"]
roles = ["staff"]
[specialists.ops]
workdir = "~/agents/ops"
[specialists.crm]
workdir = "~/agents/crm"
[specialists.desk]
workdir = "~/agents/desk"
[[rules]]
place = "slack:#help"
person = "role:staff"
target = "specialist:crm"
[[rules]]
place = "slack:#help"
person = "person:alice"
target = "specialist:desk"
[[rules]]
place = "slack:#other"
target = "specialist:desk"
[[rules]]
place = "slack:#help"
target = "specialist:ops"
`)
    expect(warnings).toEqual(["rules[1]: never matches: rules[0] already takes person:alice's messages at slack:#help"])
  })

  test('a specialist nobody can reach', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n`).warnings)
      .toEqual(['specialists.ops: nobody can reach it: no rule, schedule or `sends_to` names it'])
    // A schedule's `to` is a way in.
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[schedules.daily]\ncron = "@daily"\ntarget = "specialist:ops"\n`).warnings).toEqual([])
  })

  test('a shared session with different audiences: two places, or DMs open beyond the operator', () => {
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:#b"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops: one shared session hears slack:#a, slack:#b, so what\'s said in one place is remembered in the others; use sessions = "per-conversation" or one specialist per place'])
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:dm"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops: one shared session hears everyone\'s DMs (reachable_by = ["role:people"]), so one person\'s DM is remembered in another\'s; use sessions = "per-conversation" or reachable_by = []'])
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:group-dm"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops: one shared session hears every group DM (reachable_by = ["role:people"]), so what one group says is remembered in another; use sessions = "per-conversation" or reachable_by = []'])
    // Only the operator's DMs, or one session per conversation: one audience each.
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = []\n[[rules]]\nplace = "slack:dm"\ntarget = "specialist:ops"\n`).warnings).toEqual([])
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nsessions = "per-conversation"\nidle = "1h"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n[[rules]]\nplace = "slack:#b"\ntarget = "specialist:ops"\n`).warnings).toEqual([])
  })

  test('per-conversation sessions with no idle: past max, conversations wait for a session ended by hand', () => {
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nsessions = "per-conversation"\nmax_sessions = 5\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops: conversations past max_sessions (5) will wait until a session is ended by hand; set idle'])
    expect(ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nsessions = "per-conversation"\nidle = "2h"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:ops"\n`).warnings).toEqual([])
  })

  test('a workdir that is the whole home folder warns: hydra won\'t mark it trusted', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~"\n[[rules]]\nplace = "cli"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops.workdir: /home/op is your whole home folder: its sessions can read everything there, and hydra won\'t pre-approve Claude\'s trust for it; give the specialist a folder of its own'])
  })

  test('an operator with no address on a connected platform warns: nobody is in charge there', () => {
    expect(ok(`${BASE}\n[gateways.discord]\nbot_token_env = "T"\n`).warnings)
      .toEqual(['operator: op has no discord: address, so on discord nobody passes admin checks or reaches main by DM'])
  })

  test('an address naming an inherited property is refused, not a crash', () => {
    expect(errorsOf(`operator = "op"\n[people.op]\naddresses = ["constructor:x", "__proto__:y"]\n`)).toEqual([
      'people.op.addresses[0]: "constructor:x" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.addresses[1]: "__proto__:y" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
    ])
  })

  test('a place on a platform that isn\'t connected', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "discord:#feed"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(["specialists.ops: a rule sends discord:#feed to it, but [gateways.discord] isn't set, so it won't hear it"])
  })
  test('a github place with no [connectors.github] names that table', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "github:me/r"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(["specialists.ops: a rule sends github:me/r to it, but [connectors.github] isn't set, so it won't hear it"])
  })
})

describe('a Slack app\'s display_name and description', () => {
  const slack = (lines: string) => `${BASE}\n[slack.apps.default]\nbot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"\n${lines}\n`
  test('are kept as given, and defaulted when unset', () => {
    expect(ok(slack('display_name = "Acme helper"\ndescription = "Answers the threads it is tagged in."')).config.slackApps.default)
      .toEqual({ id: 'default', botTokenEnv: 'CONNECTOR_SLACK_BOT_TOKEN', displayName: 'Acme helper', description: 'Answers the threads it is tagged in.' })
    expect(ok(slack('')).config.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'CONNECTOR_SLACK_BOT_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
  })
  test('one name for two apps is refused: a message names an app by it alone', () => {
    const two = (name: string) => `${slack('')}\n[slack.apps.sales]\nbot_token_env = "SALES_SLACK_BOT_TOKEN"\ndisplay_name = "${name}"\n`
    expect(errorsOf(two('Hydra'))).toEqual(['slack.apps.sales.display_name: "Hydra" is already the name of [slack.apps.default]: alerts and `hydra health` name an app by it, so each app needs its own'])
    expect(ok(two('Sales desk')).config.slackApps.sales.displayName).toBe('Sales desk')
  })
  test('past Slack\'s limits (35 and 140 characters) are refused', () => {
    // Characters, not UTF-16 units: 34 letters and an emoji is 35.
    expect(ok(slack(`display_name = "${'k'.repeat(34)}🦀"\ndescription = "${'d'.repeat(140)}"`)).config.slackApps.default.displayName).toBe(`${'k'.repeat(34)}🦀`)
    expect(errorsOf(slack(`display_name = "${'k'.repeat(36)}"\ndescription = "${'d'.repeat(141)}"`))).toEqual([
      'slack.apps.default.display_name: is 36 characters; Slack allows at most 35',
      'slack.apps.default.description: is 141 characters; Slack allows at most 140',
    ])
  })
})

describe('Slack apps', () => {
  const single = (lines = '') => `${BASE}\n[slack.apps.default]\nbot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"\nsocket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\n${lines}\n`
  const two = `${BASE}
[slack.apps.default]
bot_token_env = "HYDRA_SLACK_BOT_TOKEN"
socket_token_env = "HYDRA_SLACK_APP_TOKEN"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
socket_token_env = "SALES_SLACK_APP_TOKEN"
operator_token_env = "SALES_SLACK_USER_TOKEN"
display_name = "Sales helper"
description = "Answers sales threads."
`
  test('[slack.apps.default] loads as the app `default`, with every default filled in; there is no second copy', () => {
    const c = ok(single('operator_token_env = "HYDRA_SLACK_USER_TOKEN"\ndisplay_name = "Acme helper"\ndescription = "Hears threads."')).config
    expect(c.slackApps).toEqual({ default: { id: 'default', botTokenEnv: 'SLOPBOT_SLACK_BOT_TOKEN', socketTokenEnv: 'SLOPBOT_SLACK_APP_TOKEN', operatorTokenEnv: 'HYDRA_SLACK_USER_TOKEN', displayName: 'Acme helper', description: 'Hears threads.' } })
    expect(c.connectors).toEqual({})
    expect(defaultSlackApp(c)).toBe(c.slackApps.default)
  })
  test('defaults: `hydra` for default, the id for another app; the description mentions the operator token only when there is one', () => {
    const c = ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "A_BOT"\noperator_token_env = "A_USER"\n[slack.apps.sales]\nbot_token_env = "S_BOT"\n`).config
    expect(c.slackApps.default).toMatchObject({ displayName: 'hydra', description: SLACK_APP_DEFAULTS.description + SLACK_APP_DEFAULTS.operatorTokenNote })
    expect(c.slackApps.sales).toMatchObject({ displayName: 'sales', description: SLACK_APP_DEFAULTS.description })
  })
  test('two apps load; the default one is the one hydra connects', () => {
    const r = ok(two)
    expect(Object.keys(r.config.slackApps)).toEqual(['default', 'sales'])
    expect(r.config.slackApps.sales).toEqual({ id: 'sales', botTokenEnv: 'SALES_SLACK_BOT_TOKEN', socketTokenEnv: 'SALES_SLACK_APP_TOKEN', operatorTokenEnv: 'SALES_SLACK_USER_TOKEN', displayName: 'Sales helper', description: 'Answers sales threads.' })
    expect(defaultSlackApp(r.config)?.botTokenEnv).toBe('HYDRA_SLACK_BOT_TOKEN')
    expect(r.warnings).toEqual([])
  })
  test('an app need not be named `default`: it is one of the apps hydra connects, and loads with no warning', () => {
    const r = ok(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SALES_SLACK_BOT_TOKEN"\n`)
    expect(defaultSlackApp(r.config)).toBeUndefined()
    expect(Object.keys(r.config.slackApps)).toEqual(['sales'])
    expect(r.warnings).toEqual([])
  })
  describe('on the Slack gateway\'s daemon, the gateway\'s own app is not a connector app', () => {
    const slackEnv: LoadEnv = testLoadEnv({ platform: 'slack' })
    const errs = (text: string) => { const r = loadHydraConfig(text, slackEnv); if (r.ok) throw new Error('expected the load to fail'); return r.errors.map(x => `${x.path}: ${x.message}`) }
    const gateway = 'is already the token variable of the Slack gateway (CHAT_PLATFORM=slack): each token needs its own variable; give the connector its own Slack app, with its own variables like CONNECTOR_SLACK_BOT_TOKEN'
    test('a connector app naming either of the gateway\'s variables is refused, naming the key and the fix', () => {
      expect(errs(`${BASE}\n[slack.apps.default]\nbot_token_env = "SLACK_BOT_TOKEN"\nsocket_token_env = "SLACK_APP_TOKEN"\n`)).toEqual([
        `slack.apps.default.bot_token_env: "SLACK_BOT_TOKEN" ${gateway}`,
        `slack.apps.default.socket_token_env: "SLACK_APP_TOKEN" ${gateway}`,
      ])
      expect(errs(`${BASE}\n[slack.apps.default]\nbot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"\nsocket_token_env = "SLACK_APP_TOKEN"\n`)).toEqual([
        `slack.apps.default.socket_token_env: "SLACK_APP_TOKEN" ${gateway}`,
      ])
    })
    test('a connector app with its own variables loads', () => {
      expect(loadHydraConfig(`${BASE}\n[slack.apps.default]\nbot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"\nsocket_token_env = "CONNECTOR_SLACK_APP_TOKEN"\n`, slackEnv).ok).toBe(true)
    })
    test('an MCP server never gets the gateway\'s variables either', () => {
      expect(errs(`${BASE}\n[mcp_servers.x]\ncommand = "bun"\ntoken_env = ["SLACK_APP_TOKEN"]\n`))
        .toEqual(['mcp_servers.x.token_env[0]: "SLACK_APP_TOKEN" is the token variable of the Slack gateway (CHAT_PLATFORM=slack): a server never gets hydra\'s own tokens'])
    })
    test('on a Discord daemon the same file loads: its gateway holds no Slack tokens', () => {
      expect(loadHydraConfig(`${BASE}\n[slack.apps.default]\nbot_token_env = "SLACK_BOT_TOKEN"\nsocket_token_env = "SLACK_APP_TOKEN"\n`, env).ok).toBe(true)
    })
  })
  test('one variable on two keys is an error at the later one: two apps, one app, or Slack and Discord', () => {
    expect(errorsOf(two.replace('"SALES_SLACK_BOT_TOKEN"', '"HYDRA_SLACK_BOT_TOKEN"'))).toEqual([
      'slack.apps.sales.bot_token_env: "HYDRA_SLACK_BOT_TOKEN" is already the token variable of slack.apps.default.bot_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${single()}[slack.apps.sales]\nbot_token_env = "X_BOT"\nsocket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\n`)).toEqual([
      'slack.apps.sales.socket_token_env: "SLOPBOT_SLACK_APP_TOKEN" is already the token variable of slack.apps.default.socket_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SAME_TOKEN"\nsocket_token_env = "SAME_TOKEN"\n`)).toEqual([
      'slack.apps.sales.socket_token_env: "SAME_TOKEN" is already the token variable of slack.apps.sales.bot_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${BASE}\n[gateways.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n[slack.apps.sales]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)).toEqual([
      'slack.apps.sales.bot_token_env: "DISCORD_BOT_TOKEN" is already the token variable of gateways.discord.bot_token_env: each token needs its own variable',
    ])
  })
  test('a variable sessions need cannot hold a token, however the app is declared', () => {
    const sessions = 'is a variable sessions need, so it cannot hold a token; name one only the daemon needs, like CONNECTOR_SLACK_BOT_TOKEN'
    expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "PATH"\n`)).toEqual([`slack.apps.default.bot_token_env: "PATH" ${sessions}`])
    expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "OK_BOT"\nsocket_token_env = "HYDRA_SESSION_ID"\n`)).toEqual([`slack.apps.default.socket_token_env: "HYDRA_SESSION_ID" ${sessions}`])
    for (const v of ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'LC_ALL', 'XDG_RUNTIME_DIR']) {
      expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "${v}"\n`)).toHaveLength(1)
    }
    // The names hydra has always scrubbed, and any HYDRA_SLACK_ one, stay usable.
    for (const v of ['SLOPBOT_SLACK_BOT_TOKEN', 'HYDRA_SLACK_BOT_TOKEN', 'HYDRA_SLACK_SALES_BOT']) ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "${v}"\n`)
  })
  test('app ids are lowercase and at most 35 characters, so none is a channel id; env names keep their shape; keys are checked at their path', () => {
    expect(errorsOf(`${BASE}\n[slack.apps.Sales]\nbot_token_env = "X"\n[slack.apps.C0TEST]\nbot_token_env = "Y"\n[slack.apps.${'a'.repeat(36)}]\nbot_token_env = "Z"\n`)).toEqual([
      expect.stringContaining('slack.apps.Sales: "Sales" is not a valid app name'),
      expect.stringContaining('slack.apps.C0TEST: "C0TEST" is not a valid app name'),
      expect.stringContaining(`slack.apps.${'a'.repeat(36)}: `),
    ])
    expect(ok(`${BASE}\n[slack.apps.a-1_b]\nbot_token_env = "X"\n`).config.slackApps['a-1_b']).toBeDefined()
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nbot_token_env = "lower"\n`)).toEqual([
      'slack.apps.sales.bot_token_env: "lower" must name an environment variable, like CONNECTOR_SLACK_BOT_TOKEN',
    ])
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nsocket_token_env = "A"\nflavor = "x"\ndisplay_name = "${'n'.repeat(36)}"\n`)).toEqual([
      'slack.apps.sales.flavor: unknown key "flavor"',
      'slack.apps.sales.bot_token_env: is required',
      'slack.apps.sales.display_name: is 36 characters; Slack allows at most 35',
    ])
    expect(errorsOf(`${BASE}\n[slack]\nbogus = 1\n`)).toEqual(['slack.bogus: unknown key "bogus"'])
    // `app_name` is the old [connectors.slack] spelling only; in [slack.apps.<id>] that, and `name`, are unknown.
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nbot_token_env = "X"\napp_name = "x"\nname = "y"\n`)).toEqual(['slack.apps.sales.app_name: unknown key "app_name"', 'slack.apps.sales.name: unknown key "name"'])
  })
  test('an id like `constructor` is a plain app, and an absent one is not found through the prototype', () => {
    const c = ok(`${BASE}\n[slack.apps.constructor]\nbot_token_env = "X_BOT"\n`).config
    expect(c.slackApps.constructor).toMatchObject({ id: 'constructor' })
    expect(Object.hasOwn(c.slackApps, 'toString')).toBe(false)
    expect(defaultSlackApp(c)).toBeUndefined()
  })
  test('a slack-listening specialist with no Slack app declared is warned, naming what to add', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[[rules]]\nplace = "slack:#y"\ntarget = "specialist:ops"\n`).warnings)
      .toEqual(['specialists.ops: a rule sends slack:#y to it, but hydra.toml declares no Slack app: add [slack.apps.<id>], or it won\'t hear it'])
  })
})

describe('speaks_as: the app a specialist posts as when no message came in', () => {
  const two = `${BASE}
[slack.apps.default]
bot_token_env = "HYDRA_SLACK_BOT_TOKEN"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
[slack.apps.support]
bot_token_env = "SUPPORT_SLACK_BOT_TOKEN"
`
  const spec = (lines: string) => `${two}\n[specialists.x]\nworkdir = "~/agents/crm"\n${lines}\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:x"\n`
  test('it names a declared app; it is kept on the specialist', () => {
    expect(ok(spec('speaks_as = "app:sales"')).config.specialists.x.speaksAs).toBe('sales')
    expect(ok(spec('')).config.specialists.x.speaksAs).toBeUndefined()
  })
  test('an undeclared app is an error that names the key and the apps declared', () => {
    expect(errorsOf(spec('speaks_as = "app:ghost"'))).toEqual(['specialists.x.speaks_as: no app "ghost": declare [slack.apps.ghost]; hydra.toml declares app:default, app:sales, app:support'])
  })
  test('a pinned specialist speaks only through its own apps', () => {
    expect(errorsOf(spec('pinned_to = ["app:sales"]\nspeaks_as = "app:support"'))).toEqual(['specialists.x.speaks_as: app:support is not one of the apps x is pinned to (app:sales): a pinned specialist speaks only through its own apps'])
    expect(ok(spec('pinned_to = ["app:sales", "app:support"]\nspeaks_as = "app:support"')).config.specialists.x.speaksAs).toBe('support')
  })
  test('an unpinned specialist cannot speak as an app that is pinned to someone else, or its replies could not come back', () => {
    const pinned = `${spec('speaks_as = "app:sales"')}[specialists.y]\nworkdir = "~/agents/desk"\npinned_to = ["app:sales"]\n[[rules]]\nplace = "slack:#b"\ntarget = "specialist:y"\n`
    expect(errorsOf(pinned)).toEqual(['specialists.x.speaks_as: app:sales serves only specialists pinned to it (y), and x is not pinned: set `speaks_as` to an app x can be reached through, or pin x to app:sales'])
  })
  test('a specialist with a Slack home_place must have an app to post as: with several apps and none `default`, `speaks_as` is required, and the error names the key', () => {
    const none = `${BASE}\n[slack.apps.a]\nbot_token_env = "A_BOT"\n[slack.apps.b]\nbot_token_env = "B_BOT"\n`
    const x = (extra: string) => `${none}[specialists.x]\nworkdir = "~/agents/crm"\nhome_place = "slack:#ops"\n${extra}\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:x"\n`
    expect(errorsOf(x(''))).toEqual(['specialists.x.speaks_as: x has a Slack home_place, and 2 Slack apps are declared and none is `default`: set `speaks_as` to the app it posts as'])
    expect(ok(x('speaks_as = "app:b"')).config.specialists.x.speaksAs).toBe('b')
    // No home_place, no post of its own: nothing to require.
    expect(ok(`${none}[specialists.x]\nworkdir = "~/agents/crm"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:x"\n`).config.specialists.x.speaksAs).toBeUndefined()
  })
  test('the app it would post as, derived when `speaks_as` is absent, must be able to reach it', () => {
    // `default` is pinned by y, so an unpinned x with a home_place would post through an app that never delivers to it.
    const toml = `${two}[specialists.y]\nworkdir = "~/agents/desk"\npinned_to = ["app:default"]\n[specialists.x]\nworkdir = "~/agents/crm"\nhome_place = "slack:#ops"\n[[rules]]\nplace = "slack:#b"\ntarget = "specialist:y"\n[[rules]]\nplace = "slack:#a"\ntarget = "specialist:x"\n`
    expect(errorsOf(toml)).toEqual(['specialists.x.speaks_as: app:default serves only specialists pinned to it (y), and x is not pinned: set `speaks_as` to an app x can be reached through, or pin x to app:default'])
  })
  test('speaks_as is a string', () => {
    expect(errorsOf(spec('speaks_as = 3'))).toEqual(['specialists.x.speaks_as: must be a non-empty string'])
  })
})

describe('apps in routing: pinned specialists, rules by app, default_app', () => {
  const APPS = `${BASE}
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
[slack.apps.support]
bot_token_env = "SUPPORT_BOT"
`
  const spec = (id: string, body = '') => `[specialists.${id}]\nworkdir = "~/agents/ops"\n${body}\n`
  /** `[[rules]]` sending each place to a specialist: where it is heard. */
  const heard = (id: string, ...places: string[]) => places.map(p => `[[rules]]\nplace = "${p}"\ntarget = "specialist:${id}"\n`).join('')

  describe('a specialist\'s apps', () => {
    test('pins it, as written; no apps leaves it unpinned', () => {
      const c = ok(`${APPS}${spec('deals', 'pinned_to = ["app:sales", "app:sales"]') + heard('deals', "slack:#help")}${spec('crm', '') + heard('crm', "slack:#lobby")}`).config
      expect(c.specialists.deals.pinnedTo).toEqual(['sales'])
      expect(c.specialists.crm.pinnedTo).toBeUndefined()
      expect('apps' in c.specialists.crm).toBe(false)
    })
    test('must name declared apps, each error at its key path', () => {
      expect(errorsOf(`${APPS}${spec('deals', 'pinned_to = ["app:sales", "app:nope"]')}`)).toEqual(['specialists.deals.pinned_to[1]: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales, app:support'])
      expect(errorsOf(`${BASE}${spec('deals', 'pinned_to = ["app:sales"]')}`)).toEqual(['specialists.deals.pinned_to[0]: no app "sales": declare [slack.apps.sales]; hydra.toml declares no apps'])
      expect(errorsOf(`${APPS}${spec('deals', 'pinned_to = []')}`)).toEqual(['specialists.deals.pinned_to: must name at least one app; leave `pinned_to` out to take every app that no specialist is pinned to'])
      expect(errorsOf(`${APPS}${spec('deals', 'pinned_to = "sales"')}`)).toEqual(['specialists.deals.pinned_to: must be a list of strings'])
    })
    test('an inherited apps is checked at the specialist that inherits it', () => {
      expect(errorsOf(`${APPS}[defaults.specialist]\npinned_to = ["app:nope"]\n${spec('deals')}`)).toEqual(['specialists.deals.pinned_to (from defaults.specialist)[0]: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales, app:support'])
    })
    test('a pinned specialist may not listen on a place that is not Slack', () => {
      expect(errorsOf(`${APPS}[connectors.github]\nrepos = ["acme/w"]\n${spec('deals', 'pinned_to = ["app:sales"]') + heard('deals', "slack:#help", "github:acme/w", "discord:#feed")}`)).toEqual([
        'rules[1].target: deals is pinned to Slack apps, so it can never take a message at github:acme/w: remove `pinned_to` from deals, or send it a `slack:` place instead',
        'rules[2].target: deals is pinned to Slack apps, so it can never take a message at discord:#feed: remove `pinned_to` from deals, or send it a `slack:` place instead',
      ])
    })
  })

  describe('sharing a place', () => {
    test('two specialists with disjoint apps may listen on the same place; so may a pinned and an unpinned one', () => {
      const { config, warnings } = ok(`${APPS}${spec('deals', 'pinned_to = ["app:sales"]') + heard('deals', "slack:#help")}${spec('desk', 'pinned_to = ["app:support"]') + heard('desk', "slack:#help")}${spec('crm', '') + heard('crm', "slack:#help")}`)
      expect(['deals', 'desk', 'crm'].map(id => placesAnsweredBy(config, id))).toEqual([['slack:#help'], ['slack:#help'], ['slack:#help']])
      expect(warnings).toEqual([])
    })
    test('overlapping apps, or two unpinned, still clash', () => {
      expect(errorsOf(`${APPS}${spec('deals', 'pinned_to = ["app:sales", "app:support"]') + heard('deals', "slack:#help")}${spec('desk', 'pinned_to = ["app:support"]') + heard('desk', "slack:#help")}`))
        .toEqual(['rules[1]: sends every message at slack:#help through app:support to specialist:desk, but rules[0] already sends them to specialist:deals: give rules[1] a `person`, or remove it'])
      expect(errorsOf(`${APPS}${spec('a', '') + heard('a', "slack:#help")}${spec('b', '') + heard('b', "slack:#help")}`))
        .toEqual(['rules[1]: sends every message at slack:#help through any app to specialist:b, but rules[0] already sends them to specialist:a: give rules[1] a `person`, or remove it'])
    })
  })

  describe('a rule\'s app', () => {
    const rule = (body: string, specs = spec('deals', 'pinned_to = ["app:sales"]') + spec('crm')) => `${APPS}${specs}[[rules]]\n${body}\n`
    test('a rule needs a place, an app, or both; person alone is an error', () => {
      expect(ok(rule('app = "app:sales"\ntarget = "specialist:deals"')).config.rules).toEqual([{ app: 'sales', target: 'deals' }])
      expect(ok(rule('place = "slack:#help"\ntarget = "specialist:crm"')).config.rules).toEqual([{ place: 'slack:#help', target: 'crm' }])
      expect(ok(rule('place = "slack:#help"\napp = "app:sales"\nperson = "person:alice"\ntarget = "specialist:deals"')).config.rules).toEqual([{ place: 'slack:#help', app: 'sales', person: 'alice', target: 'deals' }])
      expect(errorsOf(rule('target = "specialist:crm"'))).toEqual(['rules[0]: a rule needs `place`, `app` or both; `person` only narrows who it applies to'])
      expect(errorsOf(rule('person = "person:alice"\ntarget = "specialist:crm"'))).toEqual(['rules[0]: a rule needs `place`, `app` or both; `person` only narrows who it applies to'])
    })
    test('its app must be declared, and its place a Slack place', () => {
      expect(errorsOf(rule('app = "app:nope"\ntarget = "specialist:crm"'))).toEqual(['rules[0].app: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales, app:support'])
      expect(errorsOf(rule('place = "discord:#feed"\napp = "app:sales"\ntarget = "specialist:deals"'))).toEqual(['rules[0].app: an app is a Slack app, but discord:#feed is not a Slack place: set `place` to a `slack:` place, remove `place`, or remove `app`'])
    })
    test('it can never send an app to a specialist that app cannot reach', () => {
      expect(errorsOf(rule('app = "app:support"\ntarget = "specialist:deals"'))).toEqual(['rules[0].target: deals is pinned to app:sales, so app:support can never deliver to it: add app:support to deals\'s `pinned_to`, or change the rule\'s `app`'])
      expect(errorsOf(rule('app = "app:sales"\ntarget = "specialist:crm"'))).toEqual(['rules[0].target: app:sales serves only specialists pinned to it (deals), and crm is not pinned to it: add app:sales to crm\'s `pinned_to`, or change the rule\'s `app`'])
      expect(errorsOf(rule('place = "discord:#feed"\ntarget = "specialist:deals"'))).toEqual(['rules[0].target: deals is pinned to Slack apps, so it can never take a message at discord:#feed: remove `pinned_to` from deals, or send it a `slack:` place instead'])
      // no app: fine, the rule reaches deals through sales only
      expect(ok(rule('place = "slack:#help"\ntarget = "specialist:deals"')).config.rules).toHaveLength(1)
    })
    test('an earlier rule shadows a later one that its place and app cover', () => {
      const two = (a: string, b: string) => ok(`${rule(a + '\n[[rules]]\n' + b, spec('deals', 'pinned_to = ["app:sales"]') + spec('crm') + spec('desk', 'pinned_to = ["app:support"]'))}`).warnings.filter(w => w.startsWith('rules['))
      // app-only covers place+app, and place-only covers place+app
      expect(two('app = "app:sales"\ntarget = "specialist:deals"', 'place = "slack:#help"\napp = "app:sales"\ntarget = "specialist:deals"')).toEqual(['rules[1]: never matches: rules[0] already takes every message at slack:#help through app:sales'])
      // a rule to an unpinned specialist is skipped for an app that has pinned specialists, so it does not shadow a later rule for that app
      expect(two('place = "slack:#help"\ntarget = "specialist:crm"', 'place = "slack:#help"\napp = "app:sales"\ntarget = "specialist:deals"')).toEqual([])
      expect(two('place = "slack:#help"\napp = "app:default"\ntarget = "specialist:crm"', 'place = "slack:#help"\napp = "app:default"\nperson = "person:alice"\ntarget = "specialist:crm"')).toEqual(["rules[1]: never matches: rules[0] already takes person:alice's messages at slack:#help through app:default"])
      expect(two('place = "slack:#help"\ntarget = "specialist:crm"', 'app = "app:support"\nperson = "person:alice"\ntarget = "specialist:desk"')).toEqual([])
      // a narrower rule first does not shadow a wider one
      expect(two('place = "slack:#help"\napp = "app:sales"\ntarget = "specialist:deals"', 'app = "app:sales"\ntarget = "specialist:deals"')).toEqual([])
      expect(two('app = "app:sales"\ntarget = "specialist:deals"', 'app = "app:sales"\nperson = "person:alice"\ntarget = "specialist:deals"')).toEqual(["rules[1]: never matches: rules[0] already takes person:alice's messages through app:sales"])
    })
  })

  describe('pins and the warnings about rules and who hears them', () => {
    const rules = (specs: string, body: string) => ok(`${APPS}${specs}${body}`).warnings
    test('a later rule is not shadowed by an earlier one that pins skip for its apps', () => {
      // rules[0] to p (pinned to sales) takes only sales; rules[1] to the unpinned u takes the other apps: both can match
      const specs = spec('p', 'pinned_to = ["app:sales"]') + spec('u')
      expect(rules(specs, '[[rules]]\nplace = "slack:#x"\ntarget = "specialist:p"\n[[rules]]\nplace = "slack:#x"\ntarget = "specialist:u"\n')).toEqual([])
      // two rules to unpinned specialists at the same place, with no pins at all, are a clash: an error
      expect(() => rules(spec('u') + spec('v'), '[[rules]]\nplace = "slack:#x"\ntarget = "specialist:u"\n[[rules]]\nplace = "slack:#x"\ntarget = "specialist:v"\n')).toThrow('rules[1]: sends every message at slack:#x through any app to specialist:v, but rules[0] already sends them to specialist:u')
    })
    test('a rule to an unpinned specialist does not shadow a listener pinned to an app that rule skips', () => {
      const specs = spec('v') + spec('p', 'pinned_to = ["app:sales"]') + heard('p', "slack:#x")
      expect(rules(specs, '[[rules]]\nplace = "slack:#x"\ntarget = "specialist:v"\n').filter(w => w.startsWith('rules['))).toEqual([])
    })
    test('pinning an app takes it from an unpinned listener that no pinned specialist backs up: a warning', () => {
      expect(rules(spec('x', '') + heard('x', "slack:#a") + spec('y', 'pinned_to = ["app:sales"]') + heard('y', "slack:#b"), '')).toEqual(['specialists.x: x is unpinned, and app:sales is pinned by y, so x no longer hears app:sales on slack:#a'])
      // y hears #a too: the split is deliberate
      expect(rules(spec('x', '') + heard('x', "slack:#a") + spec('y', 'pinned_to = ["app:sales"]') + heard('y', "slack:#a"), '')).toEqual([])
    })
  })

  describe('default_app', () => {
    test('names a declared app on a Slack channel', () => {
      const c = ok(`${APPS}[places."slack:#help"]\ndefault_app = "app:sales"\n[places."slack:C0HELP"]\ndefault_app = "app:support"\n`).config
      expect(c.places['slack:#help'].defaultApp).toBe('sales')
      expect(c.places['slack:C0HELP'].defaultApp).toBe('support')
      expect(ok(`${APPS}[places."slack:#help"]\nmessages = "all"\n`).config.places['slack:#help'].defaultApp).toBeUndefined()
    })
    test('an undeclared app, or a place that is not a Slack channel, is an error at its key path', () => {
      expect(errorsOf(`${APPS}[places."slack:#help"]\ndefault_app = "app:nope"\n`)).toEqual(['places."slack:#help".default_app: no app "nope": declare [slack.apps.nope]; hydra.toml declares app:default, app:sales, app:support'])
      expect(errorsOf(`${APPS}[places."discord:#feed"]\ndefault_app = "app:sales"\n`)).toEqual(['places."discord:#feed".default_app: discord:#feed is not a Slack channel: `default_app` picks among the apps in a channel'])
      expect(errorsOf(`${APPS}[places."slack:dm"]\ndefault_app = "app:sales"\n`)).toEqual(['places."slack:dm".default_app: slack:dm is not a Slack channel: `default_app` picks among the apps in a channel'])
      expect(errorsOf(`${APPS}[places."slack:group-dm"]\ndefault_app = "app:sales"\n`)).toEqual(['places."slack:group-dm".default_app: slack:group-dm is not a Slack channel: `default_app` picks among the apps in a channel'])
    })
  })
})
