// A person's `ids`, a schedule's `prompt` and `cwd`, and a Slack app's `app_token_env` and `user_token_env` are now `addresses`,
// `message`, `workdir`, `socket_token_env` and `operator_token_env`; `[connectors.slack]` is the app `default` in `[slack.apps.default]`,
// and its `app_name` and `app_description` are `display_name` and `description`. The old forms still load, as the new ones, with a
// warning that names the new key; both in one table is an error; unknown keys are still refused.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue, HydraConfig } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const text = (f: string) => readFileSync(join(import.meta.dir, 'fixtures', f), 'utf8')
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const relevant = (i: ConfigIssue) => !i.message.startsWith('nobody can reach it')

const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.filter(relevant).map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.filter(relevant).map(line) }
}
const ok = (toml: string) => {
  const r = load(toml)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.join('\n')}`)
  return r
}
const errors = (toml: string) => load(toml).errors
/** Only the warnings about a renamed key. */
const renameWarnings = (w: string[]) => w.filter(x => x.includes('still loads and will be removed'))

const BASE = `
operator = "op"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
[people.op]
addresses = ["slack:U0OP"]
[specialists.ops]
workdir = "/home/op/ops"
restricted = true
`
const PEOPLE = `operator = "op"\n[people.op]\n`

describe('a full config in the old people, schedule and Slack app names', () => {
  // old-platform-names.loaded.json is what the loader gave for old-platform-names.toml before the rename (made on origin/main),
  // in the internal names of that day. The rename must change those names and nothing else: every value, default and warning is as it was.
  type Json = Record<string, any>
  const before = JSON.parse(text('old-platform-names.loaded.json')) as { config: Json; warnings: ConfigIssue[] }
  const rename = (o: Json, from: string, to: string): Json => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]))
  const each = (o: Json, f: (v: Json) => Json): Json => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v as Json)]))
  const inNewNames = (c: Json): Json => ({
    ...c,
    people: each(c.people, p => rename(p, 'ids', 'addresses')),
    slackApps: each(c.slackApps, a => rename(rename(a, 'appTokenEnv', 'socketTokenEnv'), 'userTokenEnv', 'operatorTokenEnv')),
    schedules: each(c.schedules, s => rename(rename(s, 'prompt', 'message'), 'cwd', 'workdir')),
  })

  test('loads to the same config, under the new internal names, and each old key warns once', () => {
    const r = ok(text('old-platform-names.toml'))
    expect(r.config).toEqual(inNewNames(before.config) as HydraConfig)
    expect(r.warnings.filter(w => !renameWarnings([w]).length)).toEqual(before.warnings.map(line))
    expect(renameWarnings(r.warnings)).toEqual([
      'connectors.slack: rename the table [connectors.slack] to [slack.apps.default]; it still loads and will be removed',
      'connectors.slack.app_token_env: rename `app_token_env` to `socket_token_env`; `app_token_env` still loads and will be removed',
      'connectors.slack.user_token_env: rename `user_token_env` to `operator_token_env`; `user_token_env` still loads and will be removed',
      'connectors.slack.app_name: rename `app_name` to `display_name`; `app_name` still loads and will be removed',
      'connectors.slack.app_description: rename `app_description` to `description`; `app_description` still loads and will be removed',
      'slack.apps.sales.app_token_env: rename `app_token_env` to `socket_token_env`; `app_token_env` still loads and will be removed',
      'slack.apps.sales.user_token_env: rename `user_token_env` to `operator_token_env`; `user_token_env` still loads and will be removed',
      'people.op.ids: rename `ids` to `addresses`; `ids` still loads and will be removed',
      'people.alice.ids: rename `ids` to `addresses`; `ids` still loads and will be removed',
      'schedules.nightly.prompt: rename `prompt` to `message`; `prompt` still loads and will be removed',
      'schedules.disk.prompt: rename `prompt` to `message`; `prompt` still loads and will be removed',
      'schedules.disk.cwd: rename `cwd` to `workdir`; `cwd` still loads and will be removed',
      'schedules.sensor.cwd: rename `cwd` to `workdir`; `cwd` still loads and will be removed',
    ])
  })

  test('the same file in the new names loads to the identical config, with no rename warning', () => {
    const renamed = text('old-platform-names.toml')
      .replace(/^\[connectors\.slack\]/m, '[slack.apps.default]')
      .replace(/^app_token_env = /gm, 'socket_token_env = ').replace(/^user_token_env = /gm, 'operator_token_env = ')
      .replace(/^app_name = /gm, 'display_name = ').replace(/^app_description = /gm, 'description = ')
      .replace(/^ids = /gm, 'addresses = ').replace(/^prompt = /gm, 'message = ').replace(/^cwd = /gm, 'workdir = ')
    const [a, b] = [ok(text('old-platform-names.toml')), ok(renamed)]
    expect(b.config).toEqual(a.config)
    expect(b.warnings).toEqual(a.warnings.filter(w => !renameWarnings([w]).length))
    expect(renameWarnings(b.warnings)).toEqual([])
  })
})

describe('a person\'s `ids` is now `addresses`', () => {
  test('the new name works', () => {
    const r = ok(`${PEOPLE}addresses = ["slack:U0OP", "github:Op"]\n`)
    expect(r.config.people.op.addresses).toEqual(['slack:U0OP', 'github:op'])
    expect(r.warnings).toEqual([])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(`${PEOPLE}ids = ["slack:U0OP", "github:Op"]\n`)
    expect(r.config.people.op.addresses).toEqual(['slack:U0OP', 'github:op'])
    expect(renameWarnings(r.warnings)).toEqual(['people.op.ids: rename `ids` to `addresses`; `ids` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(errors(`${PEOPLE}ids = ["slack:U0OP"]\naddresses = ["slack:U0OP"]\n`)).toEqual(['people.op.ids: is the old name of `addresses`, which is also set: keep `addresses` and delete `ids`'])
  })
  test('a bad value points at the key the file has', () => {
    expect(errors(`${PEOPLE}ids = ["U0OP"]\n`)).toEqual(['people.op.ids[0]: "U0OP" is not an address: use discord:<user id>, slack:<user id> or github:<login>'])
    expect(errors(`${PEOPLE}addresses = ["U0OP"]\n`)).toEqual(['people.op.addresses[0]: "U0OP" is not an address: use discord:<user id>, slack:<user id> or github:<login>'])
    expect(errors(`${PEOPLE}ids = "slack:U0OP"\n`)).toEqual(['people.op.ids: must be a list of strings'])
    expect(errors(`${PEOPLE}ids = []\n`)).toEqual(['people.op.ids: is required: at least one address, like "slack:U0TEST" or "github:alice"'])
    expect(errors(`${PEOPLE}name = "Op"\n`)).toEqual(['people.op.addresses: is required: at least one address, like "slack:U0TEST" or "github:alice"'])
  })
  test('an address two people hold is refused under the key the file has', () => {
    expect(errors(`operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[people.al]\nids = ["slack:U0OP"]\n`)).toEqual(['people.al.ids[0]: slack:U0OP already belongs to op: one address, one person'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(errors(`${PEOPLE}addresses = ["slack:U0OP"]\nusers = []\n`)).toEqual(['people.op.users: unknown key "users"'])
  })
})

describe('a schedule\'s `prompt` and `cwd` are now `message` and `workdir`', () => {
  const sched = (body: string) => `${BASE}[schedules.nightly]\ncron = "0 3 * * *"\n${body}\n`
  test('the new names work', () => {
    const r = ok(sched('target = "ops"\nmessage = "go"\ncheck = "./c.sh"\nworkdir = "~/jobs"\nenv_file = "a.env"'))
    expect(r.config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', message: 'go', runner: 'launchd', target: 'ops', check: './c.sh', workdir: '/home/op/jobs', envFile: '/home/op/jobs/a.env' })
    expect(r.warnings).toEqual([])
  })
  test('the old names work, and each warning names the new key', () => {
    const r = ok(sched('target = "ops"\nprompt = "go"\ncheck = "./c.sh"\ncwd = "~/jobs"\nenv_file = "a.env"'))
    expect(r.config.schedules.nightly).toEqual({ id: 'nightly', cron: '0 3 * * *', message: 'go', runner: 'launchd', target: 'ops', check: './c.sh', workdir: '/home/op/jobs', envFile: '/home/op/jobs/a.env' })
    expect(renameWarnings(r.warnings)).toEqual([
      'schedules.nightly.prompt: rename `prompt` to `message`; `prompt` still loads and will be removed',
      'schedules.nightly.cwd: rename `cwd` to `workdir`; `cwd` still loads and will be removed',
    ])
  })
  test('an empty message is still a message (and not an absent one), under either name', () => {
    expect(ok(sched('target = "ops"\nmessage = ""\ncheck = "c.sh"')).config.schedules.nightly.message).toBe('')
    expect(ok(sched('target = "ops"\nprompt = ""\ncheck = "c.sh"')).config.schedules.nightly.message).toBe('')
  })
  test('both names is an error', () => {
    expect(errors(sched('target = "ops"\nprompt = "a"\nmessage = "b"'))).toEqual(['schedules.nightly.prompt: is the old name of `message`, which is also set: keep `message` and delete `prompt`'])
    expect(errors(sched('target = "ops"\ncwd = "~/a"\nworkdir = "~/b"'))).toEqual(['schedules.nightly.cwd: is the old name of `workdir`, which is also set: keep `workdir` and delete `cwd`'])
  })
  test('a bad value points at the key the file has', () => {
    expect(errors(sched('target = "ops"\ncwd = "jobs"'))).toEqual(['schedules.nightly.cwd: "jobs" must be an absolute path or start with ~'])
    expect(errors(sched('target = "ops"\nworkdir = "jobs"'))).toEqual(['schedules.nightly.workdir: "jobs" must be an absolute path or start with ~'])
    expect(errors(sched('check = "c.sh"\nprompt = "hi"'))).toEqual(['schedules.nightly.prompt: a schedule with no target sends nothing, so it takes no message'])
    expect(errors(sched('check = "c.sh"\nmessage = "hi"'))).toEqual(['schedules.nightly.message: a schedule with no target sends nothing, so it takes no message'])
    expect(errors(sched('target = "ops"\nprompt = 5'))).toEqual(['schedules.nightly.prompt: must be a non-empty string'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(errors(sched('target = "ops"\ntext = "x"'))).toEqual(['schedules.nightly.text: unknown key "text"'])
  })
})

describe('a Slack app\'s `app_token_env` and `user_token_env` are now `socket_token_env` and `operator_token_env`', () => {
  const app = (body: string) => `${BASE}[slack.apps.ops]\nbot_token_env = "OPS_BOT"\n${body}\n`
  test('the new names work', () => {
    const r = ok(app('socket_token_env = "OPS_SOCKET"\noperator_token_env = "OPS_OPERATOR"'))
    expect(r.config.slackApps.ops).toMatchObject({ botTokenEnv: 'OPS_BOT', socketTokenEnv: 'OPS_SOCKET', operatorTokenEnv: 'OPS_OPERATOR' })
    expect(r.warnings).toEqual([])
  })
  test('the old names work, and each warning names the new key', () => {
    const r = ok(app('app_token_env = "OPS_SOCKET"\nuser_token_env = "OPS_OPERATOR"'))
    expect(r.config.slackApps.ops).toMatchObject({ botTokenEnv: 'OPS_BOT', socketTokenEnv: 'OPS_SOCKET', operatorTokenEnv: 'OPS_OPERATOR' })
    expect(renameWarnings(r.warnings)).toEqual([
      'slack.apps.ops.app_token_env: rename `app_token_env` to `socket_token_env`; `app_token_env` still loads and will be removed',
      'slack.apps.ops.user_token_env: rename `user_token_env` to `operator_token_env`; `user_token_env` still loads and will be removed',
    ])
  })
  test('one old name and one new is fine: each key stands alone', () => {
    const r = ok(app('app_token_env = "OPS_SOCKET"\noperator_token_env = "OPS_OPERATOR"'))
    expect(r.config.slackApps.ops).toMatchObject({ socketTokenEnv: 'OPS_SOCKET', operatorTokenEnv: 'OPS_OPERATOR' })
    expect(renameWarnings(r.warnings)).toEqual(['slack.apps.ops.app_token_env: rename `app_token_env` to `socket_token_env`; `app_token_env` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(errors(app('app_token_env = "A"\nsocket_token_env = "B"'))).toEqual(['slack.apps.ops.app_token_env: is the old name of `socket_token_env`, which is also set: keep `socket_token_env` and delete `app_token_env`'])
    expect(errors(app('user_token_env = "A"\noperator_token_env = "B"'))).toEqual(['slack.apps.ops.user_token_env: is the old name of `operator_token_env`, which is also set: keep `operator_token_env` and delete `user_token_env`'])
  })
  test('a bad value, or a variable another key holds, points at the key the file has', () => {
    expect(errors(app('app_token_env = "lower"'))).toEqual(['slack.apps.ops.app_token_env: "lower" must name an environment variable, like CONNECTOR_SLACK_BOT_TOKEN'])
    expect(errors(app('socket_token_env = "lower"'))).toEqual(['slack.apps.ops.socket_token_env: "lower" must name an environment variable, like CONNECTOR_SLACK_BOT_TOKEN'])
    expect(errors(app('user_token_env = "PATH"'))).toEqual(['slack.apps.ops.user_token_env: "PATH" is a variable sessions need, so it cannot hold a token; name one only the daemon needs, like CONNECTOR_SLACK_BOT_TOKEN'])
    // The earlier key is named as the file spells it, too.
    expect(errors(`${app('app_token_env = "SAME"')}[slack.apps.other]\nbot_token_env = "OTHER_BOT"\nuser_token_env = "SAME"\n`)).toEqual(['slack.apps.other.user_token_env: "SAME" is already the token variable of slack.apps.ops.app_token_env: each token needs its own variable'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(errors(app('token_env = "X"'))).toEqual(['slack.apps.ops.token_env: unknown key "token_env"'])
  })
})

describe('the old [connectors.slack] is the app `default`', () => {
  const old = (body = '') => `${BASE}[connectors.slack]\nbot_token_env = "OLD_BOT"\n${body}\n`
  test('it loads as the app `default`, with one warning that names the new home, and is the config the new table gives', () => {
    const r = ok(old('socket_token_env = "OLD_SOCKET"'))
    expect(renameWarnings(r.warnings)).toEqual(['connectors.slack: rename the table [connectors.slack] to [slack.apps.default]; it still loads and will be removed'])
    expect(r.config.connectors).toEqual({})
    const viaApps = ok(`${BASE}[slack.apps.default]\nbot_token_env = "OLD_BOT"\nsocket_token_env = "OLD_SOCKET"\n`)
    expect(r.config).toEqual(viaApps.config)
    expect(viaApps.warnings).toEqual([])
  })
  test('`app_name` and `app_description` are read as `display_name` and `description`, and each warns', () => {
    const r = ok(old('app_name = "Acme helper"\napp_description = "Hears threads."'))
    expect(r.config.slackApps.default).toMatchObject({ displayName: 'Acme helper', description: 'Hears threads.' })
    expect(renameWarnings(r.warnings)).toEqual([
      'connectors.slack: rename the table [connectors.slack] to [slack.apps.default]; it still loads and will be removed',
      'connectors.slack.app_name: rename `app_name` to `display_name`; `app_name` still loads and will be removed',
      'connectors.slack.app_description: rename `app_description` to `description`; `app_description` still loads and will be removed',
    ])
  })
  test('the new text keys work in the old table too', () => {
    expect(ok(old('display_name = "Acme helper"')).config.slackApps.default.displayName).toBe('Acme helper')
  })
  test('both names for the text is an error', () => {
    expect(errors(old('app_name = "A"\ndisplay_name = "B"'))).toEqual(['connectors.slack.app_name: is the old name of `display_name`, which is also set: keep `display_name` and delete `app_name`'])
    expect(errors(old('app_description = "A"\ndescription = "B"'))).toEqual(['connectors.slack.app_description: is the old name of `description`, which is also set: keep `description` and delete `app_description`'])
  })
  test('declaring `default` in both forms is an error, naming the table to keep', () => {
    expect(errors(`${old()}[slack.apps.default]\nbot_token_env = "OTHER_BOT"\n`)).toEqual(['slack.apps.default: declares the same app as [connectors.slack]: keep [slack.apps.default] and delete [connectors.slack]'])
  })
  test('a bad value points at the key the file has', () => {
    expect(errors(old(`app_name = "${'k'.repeat(36)}"\napp_description = "${'d'.repeat(141)}"`))).toEqual([
      'connectors.slack.app_name: is 36 characters; Slack allows at most 35',
      'connectors.slack.app_description: is 141 characters; Slack allows at most 140',
    ])
    expect(errors(old('app_token_env = "lower"'))).toEqual(['connectors.slack.app_token_env: "lower" must name an environment variable, like CONNECTOR_SLACK_BOT_TOKEN'])
    expect(errors(`${BASE}[connectors.slack]\napp_token_env = "A"\n`)).toEqual(['connectors.slack.bot_token_env: is required'])
  })
  test('the loader stays strict: an unknown key is still refused', () => {
    expect(errors(old('flavor = "x"'))).toEqual(['connectors.slack.flavor: unknown key "flavor"'])
  })
  test('on the Slack gateway\'s daemon, the gateway\'s variables are refused under the old key too', () => {
    const r = loadHydraConfig(`${BASE}[connectors.slack]\nbot_token_env = "OLD_BOT"\napp_token_env = "SLACK_APP_TOKEN"\n`, testLoadEnv({ platform: 'slack' }))
    expect(r.ok ? [] : r.errors.map(line)).toEqual([expect.stringMatching(/^connectors\.slack\.app_token_env: "SLACK_APP_TOKEN" is already the token variable of the Slack gateway/)])
  })
})
