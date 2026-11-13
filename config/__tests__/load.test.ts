import { describe, test, expect } from 'bun:test'
import { loadHydraConfig, VITALS_DEFAULTS } from '../load.js'
import { SLACK_APP_DEFAULTS } from '../../connectors/slack/app.js'
import { defaultSlackApp, type HydraConfig, type LoadEnv, type LoadResult } from '../types.js'
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
      sessions: 'per-conversation', max: 5, idleMs: 4 * 3_600_000, was: [], access: 'operator',
    })
    // Its own prompt_file replaces the default prompt; a relative prompt_file is under the workdir.
    expect(config.specialists.ops).toMatchObject({ promptFile: '/home/op/agents/ops/kickoff.md', allow: [], engine: 'codex', was: ['old-ops'], sessions: 'shared', max: 20 })
    expect(config.specialists.ops.prompt).toBeUndefined()
    expect(config.specialists.review.allow).toEqual(['people'])
    expect(config.places['slack:#help']).toEqual({ ack: 'eyes', files: false, listen: 'all', bots: false, linkPreviews: true })
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
`)).toEqual(['specialists.crm.listens[0]: ops already listens on slack:#ops, and every app nobody is pinned to reaches both: two specialists may share a place only when no app reaches both: give one `apps` the other lacks, or pin only one of them'])
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
  test('an app need not be named `default`: it is one of the apps hydra connects, and loads with no warning', () => {
    const r = ok(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SALES_SLACK_BOT_TOKEN"\n`)
    expect(defaultSlackApp(r.config)).toBeUndefined()
    expect(Object.keys(r.config.slackApps)).toEqual(['sales'])
    expect(r.warnings).toEqual([])
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
  test('a slack-listening specialist with no Slack app declared is warned, naming what to add', () => {
    expect(ok(`${BASE}\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:#y"]\n`).warnings)
      .toEqual(['specialists.ops: listens on slack:#y, but hydra.toml declares no Slack app: add [slack.apps.<id>], or it won\'t hear it'])
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
  const spec = (lines: string) => `${two}\n[specialists.x]\nworkdir = "~/agents/crm"\nlistens = ["slack:#a"]\n${lines}\n`
  test('it names a declared app; it is kept on the specialist', () => {
    expect(ok(spec('speaks_as = "sales"')).config.specialists.x.speaksAs).toBe('sales')
    expect(ok(spec('')).config.specialists.x.speaksAs).toBeUndefined()
  })
  test('an undeclared app is an error that names the key and the apps declared', () => {
    expect(errorsOf(spec('speaks_as = "ghost"'))).toEqual(['specialists.x.speaks_as: no app "ghost": declare [slack.apps.ghost]; hydra.toml declares default, sales, support'])
  })
  test('a pinned specialist speaks only through its own apps', () => {
    expect(errorsOf(spec('apps = ["sales"]\nspeaks_as = "support"'))).toEqual(['specialists.x.speaks_as: support is not one of the apps x is pinned to (sales): a pinned specialist speaks only through its own apps'])
    expect(ok(spec('apps = ["sales", "support"]\nspeaks_as = "support"')).config.specialists.x.speaksAs).toBe('support')
  })
  test('an unpinned specialist cannot speak as an app that is pinned to someone else, or its replies could not come back', () => {
    const pinned = `${spec('speaks_as = "sales"')}[specialists.y]\nworkdir = "~/agents/desk"\napps = ["sales"]\nlistens = ["slack:#b"]\n`
    expect(errorsOf(pinned)).toEqual(['specialists.x.speaks_as: app sales serves only specialists pinned to it (y), and x is not pinned: set `speaks_as` to an app x can be reached through, or pin x to sales'])
  })
  test('a specialist with a Slack home must have an app to post as: with several apps and none `default`, `speaks_as` is required, and the error names the key', () => {
    const none = `${BASE}\n[slack.apps.a]\nbot_token_env = "A_BOT"\n[slack.apps.b]\nbot_token_env = "B_BOT"\n`
    const x = (extra: string) => `${none}[specialists.x]\nworkdir = "~/agents/crm"\nlistens = ["slack:#a"]\nhome = "slack:#ops"\n${extra}`
    expect(errorsOf(x(''))).toEqual(['specialists.x.speaks_as: x has a Slack home, and 2 Slack apps are declared and none is `default`: set `speaks_as` to the app it posts as'])
    expect(ok(x('speaks_as = "b"')).config.specialists.x.speaksAs).toBe('b')
    // No home, no post of its own: nothing to require.
    expect(ok(`${none}[specialists.x]\nworkdir = "~/agents/crm"\nlistens = ["slack:#a"]\n`).config.specialists.x.speaksAs).toBeUndefined()
  })
  test('the app it would post as, derived when `speaks_as` is absent, must be able to reach it', () => {
    // `default` is pinned by y, so an unpinned x with a home would post through an app that never delivers to it.
    const toml = `${two}[specialists.y]\nworkdir = "~/agents/desk"\napps = ["default"]\nlistens = ["slack:#b"]\n[specialists.x]\nworkdir = "~/agents/crm"\nlistens = ["slack:#a"]\nhome = "slack:#ops"\n`
    expect(errorsOf(toml)).toEqual(['specialists.x.speaks_as: app default serves only specialists pinned to it (y), and x is not pinned: set `speaks_as` to an app x can be reached through, or pin x to default'])
  })
  test('speaks_as is a string', () => {
    expect(errorsOf(spec('speaks_as = 3'))).toEqual(['specialists.x.speaks_as: must be a non-empty string'])
  })
})

describe('apps in routing: pinned specialists, rules by app, default_app', () => {
  const APPS = `${BASE}
[people.alice]
ids = ["slack:U0ALICE"]
roles = ["staff"]
[slack.apps.default]
bot_token_env = "DEFAULT_BOT"
[slack.apps.sales]
bot_token_env = "SALES_BOT"
[slack.apps.support]
bot_token_env = "SUPPORT_BOT"
`
  const spec = (id: string, body = '') => `[specialists.${id}]\nworkdir = "~/agents/ops"\n${body}\n`

  describe('a specialist\'s apps', () => {
    test('pins it, as written; no apps leaves it unpinned', () => {
      const c = ok(`${APPS}${spec('deals', 'apps = ["sales", "sales"]\nlistens = ["slack:#help"]')}${spec('crm', 'listens = ["slack:#lobby"]')}`).config
      expect(c.specialists.deals.apps).toEqual(['sales'])
      expect(c.specialists.crm.apps).toBeUndefined()
      expect('apps' in c.specialists.crm).toBe(false)
    })
    test('must name declared apps, each error at its key path', () => {
      expect(errorsOf(`${APPS}${spec('deals', 'apps = ["sales", "nope"]')}`)).toEqual(['specialists.deals.apps[1]: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales, support'])
      expect(errorsOf(`${BASE}${spec('deals', 'apps = ["sales"]')}`)).toEqual(['specialists.deals.apps[0]: no app "sales": declare [slack.apps.sales]; hydra.toml declares no apps'])
      expect(errorsOf(`${APPS}${spec('deals', 'apps = []')}`)).toEqual(['specialists.deals.apps: must name at least one app; leave `apps` out to take every app that no specialist is pinned to'])
      expect(errorsOf(`${APPS}${spec('deals', 'apps = "sales"')}`)).toEqual(['specialists.deals.apps: must be a list of strings'])
    })
    test('an inherited apps is checked at the specialist that inherits it', () => {
      expect(errorsOf(`${APPS}[defaults.specialist]\napps = ["nope"]\n${spec('deals')}`)).toEqual(['specialists.deals.apps (from defaults.specialist)[0]: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales, support'])
    })
    test('a pinned specialist may not listen on a place that is not Slack', () => {
      expect(errorsOf(`${APPS}[connectors.github]\nrepos = ["acme/w"]\n${spec('deals', 'apps = ["sales"]\nlistens = ["slack:#help", "github:acme/w", "discord:#feed"]')}`)).toEqual([
        'specialists.deals.listens[1]: github:acme/w is not a Slack place, and `apps` pins this specialist to Slack apps: remove `apps`, or listen on a `slack:` place',
        'specialists.deals.listens[2]: discord:#feed is not a Slack place, and `apps` pins this specialist to Slack apps: remove `apps`, or listen on a `slack:` place',
      ])
    })
  })

  describe('sharing a place', () => {
    test('two specialists with disjoint apps may listen on the same place; so may a pinned and an unpinned one', () => {
      const { config, warnings } = ok(`${APPS}${spec('deals', 'apps = ["sales"]\nlistens = ["slack:#help"]')}${spec('desk', 'apps = ["support"]\nlistens = ["slack:#help"]')}${spec('crm', 'listens = ["slack:#help"]')}`)
      expect(['deals', 'desk', 'crm'].map(id => config.specialists[id].listens)).toEqual([['slack:#help'], ['slack:#help'], ['slack:#help']])
      expect(warnings).toEqual([])
    })
    test('overlapping apps, or two unpinned, still clash', () => {
      expect(errorsOf(`${APPS}${spec('deals', 'apps = ["sales", "support"]\nlistens = ["slack:#help"]')}${spec('desk', 'apps = ["support"]\nlistens = ["slack:#help"]')}`))
        .toEqual(['specialists.desk.listens[0]: deals already listens on slack:#help, and app support reaches both: two specialists may share a place only when no app reaches both: give one `apps` the other lacks, or pin only one of them'])
      expect(errorsOf(`${APPS}${spec('a', 'listens = ["slack:#help"]')}${spec('b', 'listens = ["slack:#help"]')}`))
        .toEqual(['specialists.b.listens[0]: a already listens on slack:#help, and every app nobody is pinned to reaches both: two specialists may share a place only when no app reaches both: give one `apps` the other lacks, or pin only one of them'])
    })
  })

  describe('a rule\'s app', () => {
    const rule = (body: string, specs = spec('deals', 'apps = ["sales"]') + spec('crm')) => `${APPS}${specs}[[rules]]\n${body}\n`
    test('a rule needs a place, an app, or both; from alone is an error', () => {
      expect(ok(rule('app = "sales"\nto = "deals"')).config.rules).toEqual([{ app: 'sales', to: 'deals' }])
      expect(ok(rule('at = "slack:#help"\nto = "crm"')).config.rules).toEqual([{ at: 'slack:#help', to: 'crm' }])
      expect(ok(rule('at = "slack:#help"\napp = "sales"\nfrom = "alice"\nto = "deals"')).config.rules).toEqual([{ at: 'slack:#help', app: 'sales', from: 'alice', to: 'deals' }])
      expect(errorsOf(rule('to = "crm"'))).toEqual(['rules[0]: a rule needs `at`, `app` or both; `from` only narrows who it applies to'])
      expect(errorsOf(rule('from = "alice"\nto = "crm"'))).toEqual(['rules[0]: a rule needs `at`, `app` or both; `from` only narrows who it applies to'])
    })
    test('its app must be declared, and its place a Slack place', () => {
      expect(errorsOf(rule('app = "nope"\nto = "crm"'))).toEqual(['rules[0].app: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales, support'])
      expect(errorsOf(rule('at = "discord:#feed"\napp = "sales"\nto = "deals"'))).toEqual(['rules[0].app: an app is a Slack app, but discord:#feed is not a Slack place: set `at` to a `slack:` place, remove `at`, or remove `app`'])
    })
    test('it can never send an app to a specialist that app cannot reach', () => {
      expect(errorsOf(rule('app = "support"\nto = "deals"'))).toEqual(['rules[0].to: deals is pinned to sales, so app support can never deliver to it: add support to deals\'s `apps`, or change the rule\'s `app`'])
      expect(errorsOf(rule('app = "sales"\nto = "crm"'))).toEqual(['rules[0].to: app sales serves only specialists pinned to it (deals), and crm is not pinned to it: add sales to crm\'s `apps`, or change the rule\'s `app`'])
      expect(errorsOf(rule('at = "discord:#feed"\nto = "deals"'))).toEqual(['rules[0].to: deals is pinned to Slack apps, so it can never take a message at discord:#feed: remove `apps` from deals, or change `at` to a `slack:` place'])
      // no app: fine, the rule reaches deals through sales only
      expect(ok(rule('at = "slack:#help"\nto = "deals"')).config.rules).toHaveLength(1)
    })
    test('an earlier rule shadows a later one that its place and app cover', () => {
      const two = (a: string, b: string) => ok(`${rule(a + '\n[[rules]]\n' + b, spec('deals', 'apps = ["sales"]') + spec('crm') + spec('desk', 'apps = ["support"]'))}`).warnings.filter(w => w.startsWith('rules['))
      // app-only covers place+app, and place-only covers place+app
      expect(two('app = "sales"\nto = "deals"', 'at = "slack:#help"\napp = "sales"\nto = "deals"')).toEqual(['rules[1]: never matches: rules[0] already takes every message at slack:#help through app sales'])
      // a rule to an unpinned specialist is skipped for an app that has pinned specialists, so it does not shadow a later rule for that app
      expect(two('at = "slack:#help"\nto = "crm"', 'at = "slack:#help"\napp = "sales"\nto = "deals"')).toEqual([])
      expect(two('at = "slack:#help"\napp = "default"\nto = "crm"', 'at = "slack:#help"\napp = "default"\nfrom = "alice"\nto = "crm"')).toEqual(["rules[1]: never matches: rules[0] already takes alice's messages at slack:#help through app default"])
      expect(two('at = "slack:#help"\nto = "crm"', 'app = "support"\nfrom = "alice"\nto = "desk"')).toEqual([])
      // a narrower rule first does not shadow a wider one
      expect(two('at = "slack:#help"\napp = "sales"\nto = "deals"', 'app = "sales"\nto = "deals"')).toEqual([])
      expect(two('app = "sales"\nto = "deals"', 'app = "sales"\nfrom = "alice"\nto = "deals"')).toEqual(["rules[1]: never matches: rules[0] already takes alice's messages through app sales"])
    })
    test('a rule for everyone takes the place from a listener that hears its app, and from no other', () => {
      const specs = spec('deals', 'apps = ["sales"]\nlistens = ["slack:#help"]') + spec('crm', 'listens = ["slack:#help"]') + spec('triage')
      const w = (body: string) => ok(rule(body, specs)).warnings.filter(x => x.startsWith('rules['))
      // no app, to an unpinned specialist: only apps nobody is pinned to take it, so crm loses #help; deals, pinned to sales, does not
      expect(w('at = "slack:#help"\nto = "triage"')).toEqual(['rules[0]: takes every message at slack:#help, so crm, which listens there, never hears it'])
      // through `default` only crm hears #help: deals is pinned to sales, so it loses nothing
      expect(w('at = "slack:#help"\napp = "default"\nto = "triage"')).toEqual(['rules[0]: takes every message at slack:#help through app default, so crm, which listens there, never hears it'])
      // an app-only rule takes every place that app hears
      expect(w('app = "sales"\nto = "deals"')).toEqual([])
      // support is pinned by no one here, so crm (unpinned) hears it, and the rule takes it from crm
      expect(w('app = "support"\nto = "triage"')).toEqual(['rules[0]: takes every message through app support, so crm, which listens on slack:#help, never hears it through that app'])
    })
    test('an app-only rule takes the app from a pinned listener elsewhere, as the warning says', () => {
      const w = ok(rule('to = "deals"\napp = "sales"', spec('deals', 'apps = ["sales"]') + spec('crm', 'listens = ["slack:#a"]') + spec('desk', 'apps = ["sales", "support"]\nlistens = ["slack:#b"]'))).warnings.filter(x => x.startsWith('rules['))
      expect(w).toEqual(['rules[0]: takes every message through app sales, so desk, which listens on slack:#b, never hears it through that app'])
    })
  })

  describe('pins and the warnings about rules and listeners', () => {
    const rules = (specs: string, body: string) => ok(`${APPS}${specs}${body}`).warnings
    test('a later rule is not shadowed by an earlier one that pins skip for its apps', () => {
      // rules[0] to p (pinned to sales) takes only sales; rules[1] to the unpinned u takes the other apps: both can match
      const specs = spec('p', 'apps = ["sales"]') + spec('u')
      expect(rules(specs, '[[rules]]\nat = "slack:#x"\nto = "p"\n[[rules]]\nat = "slack:#x"\nto = "u"\n')).toEqual([])
      // two rules to unpinned specialists at the same place, with no pins at all, shadow as before
      expect(rules(spec('u') + spec('v'), '[[rules]]\nat = "slack:#x"\nto = "u"\n[[rules]]\nat = "slack:#x"\nto = "v"\n')).toEqual(['rules[1]: never matches: rules[0] already takes every message at slack:#x'])
    })
    test('a rule to an unpinned specialist does not shadow a listener pinned to an app that rule skips', () => {
      const specs = spec('v') + spec('p', 'apps = ["sales"]\nlistens = ["slack:#x"]')
      expect(rules(specs, '[[rules]]\nat = "slack:#x"\nto = "v"\n').filter(w => w.startsWith('rules['))).toEqual([])
    })
    test('pinning an app takes it from an unpinned listener that no pinned specialist backs up: a warning', () => {
      expect(rules(spec('x', 'listens = ["slack:#a"]') + spec('y', 'apps = ["sales"]\nlistens = ["slack:#b"]'), '')).toEqual(['specialists.x: x is unpinned, and app sales is pinned by y, so x no longer hears sales on slack:#a'])
      // y listens on #a too: the split is deliberate
      expect(rules(spec('x', 'listens = ["slack:#a"]') + spec('y', 'apps = ["sales"]\nlistens = ["slack:#a"]'), '')).toEqual([])
    })
  })

  describe('default_app', () => {
    test('names a declared app on a Slack channel', () => {
      const c = ok(`${APPS}[places."slack:#help"]\ndefault_app = "sales"\n[places."slack:C0HELP"]\ndefault_app = "support"\n`).config
      expect(c.places['slack:#help'].defaultApp).toBe('sales')
      expect(c.places['slack:C0HELP'].defaultApp).toBe('support')
      expect(ok(`${APPS}[places."slack:#help"]\nlisten = "all"\n`).config.places['slack:#help'].defaultApp).toBeUndefined()
    })
    test('an undeclared app, or a place that is not a Slack channel, is an error at its key path', () => {
      expect(errorsOf(`${APPS}[places."slack:#help"]\ndefault_app = "nope"\n`)).toEqual(['places."slack:#help".default_app: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales, support'])
      expect(errorsOf(`${APPS}[places."discord:#feed"]\ndefault_app = "sales"\n`)).toEqual(['places."discord:#feed".default_app: discord:#feed is not a Slack channel: `default_app` picks among the apps in a channel'])
      expect(errorsOf(`${APPS}[places."slack:dm"]\ndefault_app = "sales"\n`)).toEqual(['places."slack:dm".default_app: slack:dm is not a Slack channel: `default_app` picks among the apps in a channel'])
    })
  })
})
