import { describe, test, expect } from 'bun:test'
import { loadHydraConfig, VITALS_DEFAULTS } from '../load.js'
import { SLACK_APP_DEFAULTS } from '../../connectors/slack/app.js'
import { defaultSlackApp, type HydraConfig, type LoadEnv, type LoadResult } from '../types.js'

const env: LoadEnv = {
  home: '/home/op',
  isDir: p => ['/home/op', '/home/op/agents/ops', '/home/op/agents/crm', '/home/op/agents/desk', '/srv/review'].includes(p),
  isCommand: c => c === '/home/op/bin/guard' || c === 'bun',
  sessionNames: ['spark', 'glyph'],
}

const ok = (text: string): { config: HydraConfig; warnings: string[] } => {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.map(e => `${e.path}: ${e.message}`).join('\n')}`)
  return { config: r.config, warnings: r.warnings.map(w => `${w.path}: ${w.message}`) }
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
ids = ["slack:U0OP"]
`

describe('an empty file', () => {
  test('is valid: no operator, nothing heard', () => {
    expect(ok('').config).toEqual({ connectors: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] })
    expect(ok('# just a comment\n').warnings).toEqual([])
  })
})

describe('a full file', () => {
  const text = `
operator = "op"
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
app_token_env = "SLACK_APP_TOKEN"
[connectors.github]
repos = ["Acme/Widget"]
[people.op]
ids = ["slack:U0OP", "github:Op-Login"]
[people.alice]
ids = ["slack:U0ALICE"]
roles = ["staff"]
name = "Alice"
[defaults.specialist]
prompt = "/orient {id}"
idle = "4h"
[specialists.crm]
workdir = "~/agents/crm"
listens = ["slack:#help"]
allow = ["staff"]
sessions = "per-conversation"
max = 5
[specialists.ops]
workdir = "~/agents/ops"
prompt_file = "kickoff.md"
listens = ["slack:dm"]
allow = []
engine = "codex"
was = ["old-ops"]
[specialists.review]
workdir = "/srv/review"
listens = ["github:acme/widget"]
[places."slack:#help"]
listen = "all"
ack = "eyes"
[schedules.nightly]
cron = "0 3 * * *"
to = "ops"
prompt = "Nightly run."
[[rules]]
at = "slack:#help"
from = "alice"
to = "ops"
[guard]
command = "~/bin/guard --strict"
timeout = "2s"
`
  test('loads with every default filled in', () => {
    const { config, warnings } = ok(text)
    expect(warnings).toEqual([])
    expect(config.operator).toBe('op')
    expect(config.connectors).toEqual({ github: { repos: ['acme/widget'], pollMs: 180_000 } })
    expect(config.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'SLACK_BOT_TOKEN', appTokenEnv: 'SLACK_APP_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
    expect(config.people.op).toEqual({ id: 'op', ids: ['slack:U0OP', 'github:op-login'], roles: [], name: 'op' })
    expect(config.people.alice.name).toBe('Alice')
    expect(config.specialists.crm).toEqual({
      id: 'crm', workdir: '/home/op/agents/crm', prompt: '/orient crm', listens: ['slack:#help'], allow: ['staff'],
      sessions: 'per-conversation', max: 5, idleMs: 4 * 3_600_000, was: [],
    })
    // Its own prompt_file replaces the default prompt; a relative prompt_file is under the workdir.
    expect(config.specialists.ops).toMatchObject({ promptFile: '/home/op/agents/ops/kickoff.md', allow: [], engine: 'codex', was: ['old-ops'], sessions: 'shared', max: 20 })
    expect(config.specialists.ops.prompt).toBeUndefined()
    expect(config.specialists.review.allow).toEqual(['people'])
    expect(config.places['slack:#help']).toEqual({ ack: 'eyes', files: false, listen: 'all', bots: false })
    expect(config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', to: 'ops', prompt: 'Nightly run.', runner: 'launchd' })
    expect(config.rules).toEqual([{ at: 'slack:#help', from: 'alice', to: 'ops' }])
    expect(config.guard).toEqual({ command: '~/bin/guard --strict', timeoutMs: 2000, includeText: false, owedMaxMs: 3_600_000 })
  })
})

describe('places', () => {
  test('a channel by name or by platform id', () => {
    const { config } = ok(`${BASE}
[connectors.slack]
bot_token_env = "T"
[connectors.discord]
bot_token_env = "D"
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:C0TEST", "discord:100000000000000001"]
sessions = "per-conversation"
[places."slack:G0PRIV"]
files = true
`)
    expect(config.specialists.ops.listens).toEqual(['slack:C0TEST', 'discord:100000000000000001'])
    expect(config.places['slack:G0PRIV'].files).toBe(true)
  })
})

describe('[defaults.specialist]', () => {
  test('fills {id} into any key, lists included, and a specialist\'s own key wins', () => {
    const { config } = ok(`${BASE}
[defaults.specialist]
workdir = "~/agents/{id}"
listens = ["slack:#{id}"]
model = "default-model"
[specialists.ops]
[specialists.crm]
model = "own-model"
`)
    expect(config.specialists.ops).toMatchObject({ workdir: '/home/op/agents/ops', listens: ['slack:#ops'], model: 'default-model' })
    expect(config.specialists.crm).toMatchObject({ workdir: '/home/op/agents/crm', listens: ['slack:#crm'], model: 'own-model' })
  })
  test('a bad default is reported once, at the default', () => {
    expect(errorsOf(`${BASE}
[defaults.specialist]
max = 0
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:#a"]
[specialists.crm]
workdir = "~/agents/crm"
listens = ["slack:#b"]
`)).toEqual(['defaults.specialist.max: must be a whole number above 0'])
  })
})

describe('load errors', () => {
  const spec = (body: string, id = 'ops') => `${BASE}\n[specialists.${id}]\nworkdir = "~/agents/ops"\nlistens = ["slack:#ops"]\n${body}`

  test('an unknown specialist, person or role reference', () => {
    expect(errorsOf(`${spec('allow = ["staff"]')}
[schedules.nightly]
cron = "0 3 * * *"
to = "nobody"
[[rules]]
at = "slack:#ops"
from = "bob"
to = "ghost"
`)).toEqual([
      'specialists.ops.allow[0]: no one holds the role "staff"',
      'schedules.nightly.to: no specialist "nobody"',
      'rules[0].from: "bob" is neither a person nor a role anyone holds',
      'rules[0].to: no specialist "ghost"',
    ])
    expect(errorsOf('operator = "ghost"\n')).toEqual(['operator: "ghost" is not a person: declare [people.ghost]'])
    expect(errorsOf(`${spec('allow = ["alice"]')}\n[people.alice]\nids = ["slack:U0A"]\n`))
      .toEqual(['specialists.ops.allow[0]: "alice" is a person, not a role: give them a role and allow that'])
  })

  test('two specialists listening on the same place', () => {
    expect(errorsOf(`${spec('')}
[specialists.crm]
workdir = "~/agents/crm"
listens = ["slack:#ops"]
`)).toEqual(['specialists.crm.listens[0]: ops already listens on slack:#ops: one place, one specialist'])
  })

  test('one address under two people (GitHub logins compare without case)', () => {
    expect(errorsOf(`${BASE}
[people.alice]
ids = ["github:Alice"]
[people.al]
ids = ["github:alice"]
`)).toEqual(['people.al.ids[0]: github:alice already belongs to alice: one address, one person'])
  })

  test('a missing workdir key, or a workdir that isn\'t a folder', () => {
    expect(errorsOf(`${BASE}\n[specialists.ops]\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.ops.workdir: is required: the folder it runs in'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/gone"\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.ops.workdir: /home/op/agents/gone is not a folder'])
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nworkdir = "~/agents/{id}"\n[specialists.gone]\nlistens = ["slack:#ops"]\n`))
      .toEqual(['specialists.gone.workdir (from defaults.specialist): /home/op/agents/gone is not a folder'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "agents/ops"\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.ops.workdir: "agents/ops" must be an absolute path or start with ~'])
  })

  test('a schedule with no to is a sensor: it needs a check and takes no prompt', () => {
    expect(ok(`${BASE}\n[schedules.keepalive]\ncron = "*/5 * * * *"\ncheck = "~/ensure.sh"\n`).config.schedules.keepalive)
      .toEqual({ id: 'keepalive', cron: '*/5 * * * *', prompt: '', check: '~/ensure.sh', runner: 'launchd' })
    expect(errorsOf(`${BASE}\n[schedules.a]\ncron = "@daily"\n[schedules.b]\ncron = "@daily"\ncheck = "c.sh"\nprompt = "hi"\n`)).toEqual([
      'schedules.a.to: is required unless there is a check (a sensor): a specialist, or main',
      'schedules.b.prompt: a schedule with no to sends nothing, so it takes no prompt',
    ])
  })

  test('needs and alert_after: a daemon schedule\'s, refused on launchd', () => {
    const { config } = ok(`${BASE}\n[schedules.pull]\ncron = "23 * * * *"\ncheck = "pull.sh"\nrunner = "daemon"\nneeds = ["internet", "internet"]\nalert_after = "2d"\n`)
    expect(config.schedules.pull).toEqual({ id: 'pull', cron: '23 * * * *', prompt: '', check: 'pull.sh', runner: 'daemon', needs: ['internet'], alertAfterMs: 2 * 86_400_000 })
    expect(errorsOf(`${BASE}\n[schedules.a]\ncron = "@daily"\ncheck = "c.sh"\nneeds = ["internet"]\nalert_after = "1h"\n[schedules.b]\ncron = "@daily"\ncheck = "c.sh"\nrunner = "daemon"\nneeds = ["power"]\nalert_after = "31d"\n`)).toEqual([
      'schedules.a.needs: needs runner = "daemon"',
      'schedules.a.alert_after: needs runner = "daemon"',
      'schedules.b.needs[0]: unknown precondition "power" (known: internet)',
      'schedules.b.alert_after: "31d" must be a duration like 90s, 5m or 2h, at most 30d',
    ])
  })

  test('main is a target for a schedule or a rule, though never declared', () => {
    const { config } = ok(`${BASE}\n[schedules.digest]\ncron = "@daily"\nto = "main"\n[[rules]]\nat = "slack:#ops"\nto = "main"\n`)
    expect(config.schedules.digest.to).toBe('main')
    expect(config.rules).toEqual([{ at: 'slack:#ops', to: 'main' }])
  })

  test('a bad cron', () => {
    expect(errorsOf(`${spec('')}\n[schedules.nightly]\ncron = "0 25 * * *"\nto = "ops"\n`)).toEqual(['schedules.nightly.cron: invalid cron expression "0 25 * * *": 25 is out of range 0-23'])
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
    expect(errorsOf(`${BASE}\n[specialists.123]\nworkdir = "~/agents/ops"\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.123: specialist name "123" needs a letter: an all-digit name reads as a thread id'])
    expect(errorsOf(`${BASE}\n[specialists.spark]\nworkdir = "~/agents/ops"\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.spark: "spark" is a default session name; a specialist needs its own name'])
    expect(errorsOf(`${BASE}\n[specialists.main]\nworkdir = "~/agents/ops"\nlistens = ["slack:#ops"]\n`)).toEqual(['specialists.main: "main" is a reserved address (to = "main", send_to_thread target "parent")'])
    expect(errorsOf(spec('was = ["Ops_Old"]'))).toEqual(['specialists.ops.was[0]: specialist name must be lowercase letters, digits and dashes'])
    expect(errorsOf(`${spec('was = ["crm"]')}\n[specialists.crm]\nworkdir = "~/agents/crm"\nlistens = ["slack:#crm"]\n`)).toEqual(['specialists.ops.was[0]: "crm" is a current specialist; an old id can\'t be in use'])
  })

  test('strict: unknown keys, malformed places and addresses', () => {
    expect(errorsOf(`colour = "red"\n${BASE}`)).toEqual(['colour: unknown key "colour"'])
    expect(errorsOf(spec('listen = ["slack:#x"]'))).toEqual(['specialists.ops.listen: unknown key "listen"'])
    expect(errorsOf(`${BASE}\n[connectors.irc]\nx = 1\n`)).toEqual(['connectors.irc: unknown platform "irc": use discord, slack or github'])
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:help", "discord:#Feed"]\n`)).toEqual([
      'specialists.ops.listens[0]: "slack:help" is not a place: use slack:#channel, slack:<channel id>, slack:dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli',
      'specialists.ops.listens[1]: "discord:#Feed" is not a place: use slack:#channel, slack:<channel id>, slack:dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli',
    ])
    expect(errorsOf(`operator = "op"\n[people.op]\nids = ["U0OP", "discord:abc", "slack:u0op"]\n`)).toEqual([
      'people.op.ids[0]: "U0OP" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.ids[1]: "discord:abc" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.ids[2]: "slack:u0op" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
    ])
    expect(errorsOf(`${BASE}\n[places."slack:#ops"]\nlisten = "everything"\n`)).toEqual(['places."slack:#ops".listen: must be one of "mentions", "all"'])
  })

  test('operator is required once anything is declared, and roles can\'t shadow people or built-ins', () => {
    expect(errorsOf('[people.op]\nids = ["slack:U0OP"]\n')).toEqual(['operator: is required: name the person whose DMs reach main and who may reach every specialist'])
    expect(errorsOf(`${BASE}\n[people.alice]\nids = ["slack:U0A"]\nroles = ["op", "anyone"]\n`)).toEqual([
      'people.alice.roles[1]: "anyone" is built in: anyone at all holds it already',
      'people.op: "op" is both a person and a role; rename one',
    ])
  })

  test('not valid TOML', () => {
    expect(errorsOf('operator = \n')[0]).toStartWith(': not valid TOML:')
  })
})

describe('found in review', () => {
  test('names an object inherits (constructor, toString) are not declarations', () => {
    expect(errorsOf(`${BASE}\n[schedules.s]\ncron = "@daily"\nto = "constructor"\n[[rules]]\nat = "slack:#x"\nfrom = "hasOwnProperty"\nto = "toString"\n`)).toEqual([
      'schedules.s.to: no specialist "constructor"',
      'rules[0].from: "hasOwnProperty" is neither a person nor a role anyone holds',
      'rules[0].to: no specialist "toString"',
    ])
    expect(errorsOf('operator = "constructor"\n')).toEqual(['operator: "constructor" is not a person: declare [people.constructor]'])
  })
  test('a person can\'t take a built-in role\'s name', () => {
    expect(errorsOf(`${BASE}\n[people.anyone]\nids = ["slack:U0X"]\n`)).toEqual(['people.anyone: "anyone" is a built-in role; a person needs another id'])
  })
  test('a place listed twice by one specialist is one place, not a collision', () => {
    expect(ok(`${BASE}\n[connectors.github]\nrepos = ["me/r"]\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["github:Me/R", "github:me/r"]\n`).config.specialists.ops.listens).toEqual(['github:me/r'])
  })
  test('operator is required beside any other table', () => {
    expect(errorsOf('[connectors.discord]\nbot_token_env = "T"\n')).toEqual(['operator: is required: name the person whose DMs reach main and who may reach every specialist'])
  })
  test('the same GitHub place twice, differing in case', () => {
    expect(errorsOf(`${BASE}\n[places."github:Me/R"]\nfiles = true\n[places."github:me/r"]\nfiles = false\n`)).toEqual(['places."github:me/r": github:me/r is already set: places compare without case on GitHub'])
  })
  test('a guard command\'s program is found past env assignments and quotes', () => {
    expect(ok(`${BASE}\n[guard]\ncommand = "FOO=1 '~/bin/guard' --x"\n`).config.guard?.command).toBe("FOO=1 '~/bin/guard' --x")
  })
  test('a bad default is reported once, and a default allow is checked with no specialists', () => {
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nidle = "banana"\nallow = ["ghost"]\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#a"]\n[specialists.crm]\nworkdir = "~/agents/crm"\nlistens = ["slack:#b"]\n`)).toEqual([
      'defaults.specialist.idle: "banana" must be a duration like 90m, 12h or 4d, at most 7d',
      'defaults.specialist.allow[0]: no one holds the role "ghost"',
    ])
    expect(errorsOf(`${BASE}\n[defaults.specialist]\nallow = ["ghost"]\n`)).toEqual(['defaults.specialist.allow[0]: no one holds the role "ghost"'])
  })
})

describe('found in the second review', () => {
  test('a rule from anyone takes the place from its listener too', () => {
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#y"]\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nat = "slack:#y"\nfrom = "anyone"\nto = "crm"\n`).warnings)
      .toEqual(['rules[0]: takes every message at slack:#y, so ops, which listens there, never hears it'])
  })
  test('relative paths resolve under the workdir, or the schedule\'s cwd, or are refused', () => {
    const { config } = ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nenv_file = ".env"\n[schedules.a]\ncron = "@daily"\nto = "ops"\ncwd = "~/jobs"\nenv_file = "a.env"\n`)
    expect(config.specialists.ops.envFile).toBe('/home/op/agents/ops/.env')
    expect(config.schedules.a).toMatchObject({ cwd: '/home/op/jobs', envFile: '/home/op/jobs/a.env' })
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[schedules.a]\ncron = "@daily"\nto = "ops"\ncwd = "jobs"\n[schedules.b]\ncron = "@daily"\nto = "ops"\nenv_file = "b.env"\n`)).toEqual([
      'schedules.a.cwd: "jobs" must be an absolute path or start with ~',
      'schedules.b.env_file: "b.env" is relative, so it needs an absolute cwd',
    ])
  })
  test('home is a place or a channel id', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["cli"]\nhome = "discord:#ops"\n`).config.specialists.ops.home).toBe('discord:#ops')
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["cli"]\nhome = "1234567890"\n`).config.specialists.ops.home).toBe('1234567890')
    expect(errorsOf(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["cli"]\nhome = "my channel"\n`)).toEqual(['specialists.ops.home: "my channel" must be a place (slack:#channel, discord:#channel, …) or a channel id'])
  })
})

describe('load warnings', () => {
  test('a rule for everyone at a place takes it from its listener', () => {
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#y"]\n[specialists.crm]\nworkdir = "~/agents/crm"\n[[rules]]\nat = "slack:#y"\nto = "crm"\n`).warnings)
      .toEqual(['rules[0]: takes every message at slack:#y, so ops, which listens there, never hears it'])
  })
  test('a rule for a role whose holders all hold an earlier rule\'s role is shadowed', () => {
    const { warnings } = ok(`${BASE}
[people.alice]
ids = ["slack:U0A"]
roles = ["staff", "lead"]
[people.bob]
ids = ["slack:U0B"]
roles = ["staff"]
[specialists.crm]
workdir = "~/agents/crm"
[specialists.desk]
workdir = "~/agents/desk"
[[rules]]
at = "slack:#help"
from = "staff"
to = "crm"
[[rules]]
at = "slack:#help"
from = "lead"
to = "desk"
[[rules]]
at = "slack:#help"
from = "people"
to = "desk"
`)
    expect(warnings).toEqual(["rules[1]: never matches: rules[0] already takes lead's messages at slack:#help"])
  })

  test('a rule that an earlier rule shadows', () => {
    const { warnings } = ok(`${BASE}
[connectors.slack]
bot_token_env = "T"
[people.alice]
ids = ["slack:U0A"]
roles = ["staff"]
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:#help"]
[specialists.crm]
workdir = "~/agents/crm"
[specialists.desk]
workdir = "~/agents/desk"
[[rules]]
at = "slack:#help"
from = "staff"
to = "crm"
[[rules]]
at = "slack:#help"
from = "alice"
to = "desk"
[[rules]]
at = "slack:#other"
to = "desk"
`)
    expect(warnings).toEqual(["rules[1]: never matches: rules[0] already takes alice's messages at slack:#help"])
  })

  test('a specialist nobody can reach', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n`).warnings)
      .toEqual(['specialists.ops: nobody can reach it: it listens nowhere, and no rule or schedule sends to it'])
    // A schedule's `to` is a way in.
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\n[schedules.daily]\ncron = "@daily"\nto = "ops"\n`).warnings).toEqual([])
  })

  test('a shared session with different audiences: two places, or DMs open beyond the operator', () => {
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#a", "slack:#b"]\n`).warnings)
      .toEqual(['specialists.ops: one shared session hears slack:#a, slack:#b, so what\'s said in one place is remembered in the others; use sessions = "per-conversation" or one specialist per place'])
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:dm"]\n`).warnings)
      .toEqual(['specialists.ops: one shared session hears everyone\'s DMs (allow = ["people"]), so one person\'s DM is remembered in another\'s; use sessions = "per-conversation" or allow = []'])
    // Only the operator's DMs, or one session per conversation: one audience each.
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:dm"]\nallow = []\n`).warnings).toEqual([])
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#a", "slack:#b"]\nsessions = "per-conversation"\nidle = "1h"\n`).warnings).toEqual([])
  })

  test('per-conversation sessions with no idle: past max, conversations wait for a session ended by hand', () => {
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#a"]\nsessions = "per-conversation"\nmax = 5\n`).warnings)
      .toEqual(['specialists.ops: conversations past max (5) will wait until a session is ended by hand; set idle'])
    expect(ok(`${BASE}\n[connectors.slack]\nbot_token_env = "T"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#a"]\nsessions = "per-conversation"\nidle = "2h"\n`).warnings).toEqual([])
  })

  test('a workdir that is the whole home folder warns: hydra won\'t mark it trusted', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~"\nlistens = ["cli"]\n`).warnings)
      .toEqual(['specialists.ops.workdir: /home/op is your whole home folder: its sessions can read everything there, and hydra won\'t pre-approve Claude\'s trust for it; give the specialist a folder of its own'])
  })

  test('an operator with no address on a connected platform warns: nobody is in charge there', () => {
    expect(ok(`${BASE}\n[connectors.discord]\nbot_token_env = "T"\n`).warnings)
      .toEqual(['operator: op has no discord: address, so on discord nobody passes admin checks or reaches main by DM'])
  })

  test('an address naming an inherited property is refused, not a crash', () => {
    expect(errorsOf(`operator = "op"\n[people.op]\nids = ["constructor:x", "__proto__:y"]\n`)).toEqual([
      'people.op.ids[0]: "constructor:x" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
      'people.op.ids[1]: "__proto__:y" is not an address: use discord:<user id>, slack:<user id> or github:<login>',
    ])
  })

  test('a place on a platform that isn\'t connected', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["discord:#feed"]\n`).warnings)
      .toEqual(["specialists.ops: listens on discord:#feed, but [connectors.discord] isn't set, so it won't hear it"])
  })
})

describe('[connectors.slack] app_name and app_description', () => {
  const slack = (lines: string) => `${BASE}\n[connectors.slack]\nbot_token_env = "SLACK_BOT_TOKEN"\n${lines}\n`
  test('are kept as given, and defaulted when unset', () => {
    expect(ok(slack('app_name = "Krust"\napp_description = "Answers the threads it is tagged in."')).config.slackApps.default)
      .toEqual({ id: 'default', botTokenEnv: 'SLACK_BOT_TOKEN', displayName: 'Krust', description: 'Answers the threads it is tagged in.' })
    expect(ok(slack('')).config.slackApps.default).toEqual({ id: 'default', botTokenEnv: 'SLACK_BOT_TOKEN', displayName: 'hydra', description: SLACK_APP_DEFAULTS.description })
  })
  test('past Slack\'s limits (35 and 140 characters) are refused', () => {
    // Characters, not UTF-16 units: 34 letters and an emoji is 35.
    expect(ok(slack(`app_name = "${'k'.repeat(34)}🦀"\napp_description = "${'d'.repeat(140)}"`)).config.slackApps.default.displayName).toBe(`${'k'.repeat(34)}🦀`)
    expect(errorsOf(slack(`app_name = "${'k'.repeat(36)}"\napp_description = "${'d'.repeat(141)}"`))).toEqual([
      'connectors.slack.app_name: is 36 characters; Slack allows at most 35',
      'connectors.slack.app_description: is 141 characters; Slack allows at most 140',
    ])
  })
})

describe('Slack apps', () => {
  const single = (lines = '') => `${BASE}\n[connectors.slack]\nbot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"\napp_token_env = "SLOPBOT_SLACK_APP_TOKEN"\n${lines}\n`
  const two = `${BASE}
[slack.apps.default]
bot_token_env = "HYDRA_SLACK_BOT_TOKEN"
app_token_env = "HYDRA_SLACK_APP_TOKEN"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
app_token_env = "SALES_SLACK_APP_TOKEN"
user_token_env = "SALES_SLACK_USER_TOKEN"
display_name = "Sales helper"
description = "Answers sales threads."
`
  test('[connectors.slack] loads as the app `default`, with every default filled in; there is no second copy', () => {
    const c = ok(single('user_token_env = "HYDRA_SLACK_USER_TOKEN"\napp_name = "Krust"\napp_description = "Hears threads."')).config
    expect(c.slackApps).toEqual({ default: { id: 'default', botTokenEnv: 'SLOPBOT_SLACK_BOT_TOKEN', appTokenEnv: 'SLOPBOT_SLACK_APP_TOKEN', userTokenEnv: 'HYDRA_SLACK_USER_TOKEN', displayName: 'Krust', description: 'Hears threads.' } })
    expect(c.connectors).toEqual({})
    expect(defaultSlackApp(c)).toBe(c.slackApps.default)
  })
  test('the same single app declared as [slack.apps.default] is the same config', () => {
    const viaApps = ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"\napp_token_env = "SLOPBOT_SLACK_APP_TOKEN"\n`).config
    expect(viaApps).toEqual(ok(single()).config)
  })
  test('defaults: `hydra` for default, the id for another app; the description mentions a user token only when there is one', () => {
    const c = ok(`${BASE}\n[slack.apps.default]\nbot_token_env = "A_BOT"\nuser_token_env = "A_USER"\n[slack.apps.sales]\nbot_token_env = "S_BOT"\n`).config
    expect(c.slackApps.default).toMatchObject({ displayName: 'hydra', description: SLACK_APP_DEFAULTS.description + SLACK_APP_DEFAULTS.userTokenNote })
    expect(c.slackApps.sales).toMatchObject({ displayName: 'sales', description: SLACK_APP_DEFAULTS.description })
  })
  test('two apps load; the default one is the one hydra connects', () => {
    const r = ok(two)
    expect(Object.keys(r.config.slackApps)).toEqual(['default', 'sales'])
    expect(r.config.slackApps.sales).toEqual({ id: 'sales', botTokenEnv: 'SALES_SLACK_BOT_TOKEN', appTokenEnv: 'SALES_SLACK_APP_TOKEN', userTokenEnv: 'SALES_SLACK_USER_TOKEN', displayName: 'Sales helper', description: 'Answers sales threads.' })
    expect(defaultSlackApp(r.config)?.botTokenEnv).toBe('HYDRA_SLACK_BOT_TOKEN')
    expect(r.warnings).toEqual([])
  })
  test('without an app named `default`, hydra connects none, and says so', () => {
    const r = ok(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SALES_SLACK_BOT_TOKEN"\n`)
    expect(defaultSlackApp(r.config)).toBeUndefined()
    expect(r.warnings).toEqual(['slack.apps: no app is named "default", and Slack connects only the app named "default", so Slack stays off. Name the app to connect "default".'])
  })
  test('both [connectors.slack] and [slack.apps.default] is an error', () => {
    expect(errorsOf(`${single()}[slack.apps.default]\nbot_token_env = "OTHER_BOT_TOKEN"\n`)).toEqual(['slack.apps.default: is the same app as [connectors.slack]: declare it once, in either table'])
  })
  test('one variable on two keys is an error at the later one: two apps, one app, or Slack and Discord', () => {
    expect(errorsOf(two.replace('"SALES_SLACK_BOT_TOKEN"', '"HYDRA_SLACK_BOT_TOKEN"'))).toEqual([
      'slack.apps.sales.bot_token_env: "HYDRA_SLACK_BOT_TOKEN" is already the token variable of slack.apps.default.bot_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${single()}[slack.apps.sales]\nbot_token_env = "X_BOT"\napp_token_env = "SLOPBOT_SLACK_APP_TOKEN"\n`)).toEqual([
      'slack.apps.sales.app_token_env: "SLOPBOT_SLACK_APP_TOKEN" is already the token variable of connectors.slack.app_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SAME_TOKEN"\napp_token_env = "SAME_TOKEN"\n`)).toEqual([
      'slack.apps.sales.app_token_env: "SAME_TOKEN" is already the token variable of slack.apps.sales.bot_token_env: each token needs its own variable',
    ])
    expect(errorsOf(`${BASE}\n[connectors.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n[slack.apps.sales]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)).toEqual([
      'slack.apps.sales.bot_token_env: "DISCORD_BOT_TOKEN" is already the token variable of connectors.discord.bot_token_env: each token needs its own variable',
    ])
  })
  test('a variable sessions need cannot hold a token, however the app is declared', () => {
    const sessions = 'is a variable sessions need, so it cannot hold a token; name one only the daemon needs, like SLACK_BOT_TOKEN'
    expect(errorsOf(`${BASE}\n[slack.apps.default]\nbot_token_env = "PATH"\n`)).toEqual([`slack.apps.default.bot_token_env: "PATH" ${sessions}`])
    expect(errorsOf(`${BASE}\n[connectors.slack]\nbot_token_env = "OK_BOT"\napp_token_env = "HYDRA_SESSION_ID"\n`)).toEqual([`connectors.slack.app_token_env: "HYDRA_SESSION_ID" ${sessions}`])
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
      'slack.apps.sales.bot_token_env: "lower" must name an environment variable, like SLACK_BOT_TOKEN',
    ])
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\napp_token_env = "A"\nflavor = "x"\ndisplay_name = "${'n'.repeat(36)}"\n`)).toEqual([
      'slack.apps.sales.flavor: unknown key "flavor"',
      'slack.apps.sales.bot_token_env: is required',
      'slack.apps.sales.display_name: is 36 characters; Slack allows at most 35',
    ])
    expect(errorsOf(`${BASE}\n[slack]\nbogus = 1\n`)).toEqual(['slack.bogus: unknown key "bogus"'])
    // Only [connectors.slack] spells the name `app_name`; in [slack.apps.<id>] that, and `name`, are unknown.
    expect(errorsOf(single('display_name = "x"'))).toEqual(['connectors.slack.display_name: unknown key "display_name"'])
    expect(errorsOf(`${BASE}\n[slack.apps.sales]\nbot_token_env = "X"\napp_name = "x"\nname = "y"\n`)).toEqual(['slack.apps.sales.app_name: unknown key "app_name"', 'slack.apps.sales.name: unknown key "name"'])
  })
  test('an id like `constructor` is a plain app, and an absent one is not found through the prototype', () => {
    const c = ok(`${BASE}\n[slack.apps.constructor]\nbot_token_env = "X_BOT"\n`).config
    expect(c.slackApps.constructor).toMatchObject({ id: 'constructor' })
    expect(Object.hasOwn(c.slackApps, 'toString')).toBe(false)
    expect(defaultSlackApp(c)).toBeUndefined()
  })
  test('a slack-listening specialist with no default app is warned, naming what to add', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#y"]\n`).warnings)
      .toEqual(['specialists.ops: listens on slack:#y, but hydra.toml has no app named "default": add [slack.apps.default], or it won\'t hear it'])
  })
})
