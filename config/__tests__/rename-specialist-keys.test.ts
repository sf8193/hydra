// A specialist's `access`, `prompt`, `prompt_file`, `max`, `was` and `apps` are now `restricted`, `kickoff`, `kickoff_file`, `max_sessions`,
// `renamed_from` and `pinned_to`. The old names still load, as the new ones, with a warning that names the new key (and, for `access`,
// the value it became); both names is an error; an invalid value is reported at the key the file has.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue, HydraConfig } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const text = (f: string) => readFileSync(join(import.meta.dir, 'fixtures', f), 'utf8')
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
// The fixtures declare specialists nobody sends to; that warning is not what these tests are about.
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
const renameWarnings = (w: string[]) => w.filter(x => x.includes('still loads and will be removed'))

const BASE = `
operator = "op"
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
[people.op]
addresses = ["slack:U0OP"]
`
const spec = (body: string, id = 'ops') => `${BASE}[specialists.${id}]\nworkdir = "/home/op/${id}"\nlistens = ["slack:#help"]\n${body}\n`

describe('a full specialist config in the old names', () => {
  // old-specialist-names.loaded.json is what the loader gave for old-specialist-names.toml before the rename, in the internal names of that day.
  // The rename must change those names and nothing else: every value, default and warning is as it was.
  type Json = Record<string, any>
  const before = JSON.parse(text('old-specialist-names.loaded.json')) as { config: Json; warnings: ConfigIssue[] }
  const rename = (o: Json, from: string, to: string): Json => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]))
  const inNewNames = (c: Json): Json => ({
    ...c,
    // The people, schedule and Slack app keys renamed after this test was written (rename-platform-keys.test.ts has their own).
    people: Object.fromEntries(Object.entries(c.people as Json).map(([id, p]) => [id, rename(p as Json, 'ids', 'addresses')])),
    slackApps: Object.fromEntries(Object.entries(c.slackApps as Json).map(([id, a]) => [id, rename(rename(a as Json, 'appTokenEnv', 'socketTokenEnv'), 'userTokenEnv', 'operatorTokenEnv')])),
    schedules: Object.fromEntries(Object.entries(c.schedules as Json).map(([id, s]) => [id, rename(rename(s as Json, 'prompt', 'message'), 'cwd', 'workdir')])),
    specialists: Object.fromEntries(Object.entries(c.specialists as Json).map(([id, s]) => {
      const { access, ...rest } = s as Json
      let o: Json = { ...rest, restricted: access === 'workdir' }
      for (const [from, to] of [['prompt', 'kickoff'], ['promptFile', 'kickoffFile'], ['max', 'maxSessions'], ['was', 'renamedFrom'], ['apps', 'pinnedTo']]) o = rename(o, from, to)
      return [id, o]
    })),
  })

  test('loads to the same config under the new internal names, and each old key warns once', () => {
    const r = ok(text('old-specialist-names.toml'))
    expect(r.config).toEqual(inNewNames(before.config) as HydraConfig)
    // Every other warning is as before; only the one that quoted `access` now says `restricted`.
    const asBefore = before.warnings.map(line).map(w => w.replace('(access = "operator")', '(restricted = false)').replace('give ops access = "workdir" with the broader folder it needs', 'make ops restricted = true, with the broader folder it needs'))
    expect(r.warnings.filter(w => !renameWarnings([w]).length)).toEqual(asBefore)
    // 2 in [defaults.specialist] (prompt, max); crm: access, prompt_file, max, was; ops: access; deals: apps, prompt.
    expect(renameWarnings(r.warnings).length).toBe(9)
  })

  test('the same file in the new names loads to the identical config, with no rename warning', () => {
    const renamed = text('old-specialist-names.toml')
      .replace(/^access = "workdir"/gm, 'restricted = true').replace(/^access = "operator"/gm, 'restricted = false')
      .replace(/^prompt_file = /gm, 'kickoff_file = ').replace(/^prompt = /gm, 'kickoff = ')
      .replace(/^max = /gm, 'max_sessions = ').replace(/^was = /gm, 'renamed_from = ').replace(/^apps = /gm, 'pinned_to = ')
    const [a, b] = [ok(text('old-specialist-names.toml')), ok(renamed)]
    expect(b.config).toEqual(a.config)
    expect(renameWarnings(b.warnings)).toEqual([])
  })
})

describe('`access` is now `restricted`', () => {
  test('the new name works: true restricts, false (and absent) does not', () => {
    expect(ok(spec('restricted = true')).config.specialists.ops.restricted).toBe(true)
    expect(ok(spec('restricted = false')).config.specialists.ops.restricted).toBe(false)
    expect(ok(spec('')).config.specialists.ops.restricted).toBe(false)
    expect(renameWarnings(ok(spec('restricted = true')).warnings)).toEqual([])
  })
  test('the old name works, and the warning names the new key and the value it became', () => {
    const w = ok(spec('access = "workdir"'))
    expect(w.config.specialists.ops.restricted).toBe(true)
    expect(renameWarnings(w.warnings)).toEqual(['specialists.ops.access: rename `access` to `restricted` and its value "workdir" is now true; `access` still loads and will be removed'])
    const o = ok(spec('access = "operator"'))
    expect(o.config.specialists.ops.restricted).toBe(false)
    expect(renameWarnings(o.warnings)).toEqual(['specialists.ops.access: rename `access` to `restricted` and its value "operator" is now false; `access` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('access = "workdir"\nrestricted = true')).errors).toEqual(['specialists.ops.access: is the old name of `restricted`, which is also set: keep `restricted` and delete `access`'])
  })
  test('a value that came through the old key is refused at the old key', () => {
    expect(load(spec('access = "admin"')).errors).toEqual(['specialists.ops.access: must be "workdir" or "operator"; `restricted = true` or `restricted = false` says the same'])
  })
  test('a value that came through the new key is refused at the new key', () => {
    expect(load(spec('restricted = "yes"')).errors).toEqual(['specialists.ops.restricted: must be true or false'])
  })
  test('the old name is still not a default, and says so in the new name', () => {
    expect(load(`${BASE}[defaults.specialist]\naccess = "workdir"\n[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#help"]\n`).errors)
      .toEqual(["defaults.specialist.access: can't be a default: restricted says what one specialist's session may reach. Set it under [specialists.<id>] by editing hydra.toml"])
  })
  test('the error that names it says restricted, not access', () => {
    expect(load(spec('talks_to = ["x"]')).errors).toEqual(['specialists.ops.talks_to: has no effect while restricted = false: it already has every tool and server the operator does, and send_to_thread to any session; set restricted = true to choose them'])
  })
})

describe('`prompt` and `prompt_file` are now `kickoff` and `kickoff_file`', () => {
  test('the new names work', () => {
    expect(ok(spec('kickoff = "go"')).config.specialists.ops.kickoff).toBe('go')
    expect(ok(spec('kickoff_file = "k.md"')).config.specialists.ops.kickoffFile).toBe('/home/op/ops/k.md')
  })
  test('the old names work, and the warnings name the new ones', () => {
    const a = ok(spec('prompt = "go"'))
    expect(a.config.specialists.ops.kickoff).toBe('go')
    expect(renameWarnings(a.warnings)).toEqual(['specialists.ops.prompt: rename `prompt` to `kickoff`; `prompt` still loads and will be removed'])
    const b = ok(spec('prompt_file = "k.md"'))
    expect(b.config.specialists.ops.kickoffFile).toBe('/home/op/ops/k.md')
    expect(renameWarnings(b.warnings)).toEqual(['specialists.ops.prompt_file: rename `prompt_file` to `kickoff_file`; `prompt_file` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('prompt = "a"\nkickoff = "a"')).errors).toEqual(['specialists.ops.prompt: is the old name of `kickoff`, which is also set: keep `kickoff` and delete `prompt`'])
    expect(load(spec('prompt_file = "a"\nkickoff_file = "a"')).errors).toEqual(['specialists.ops.prompt_file: is the old name of `kickoff_file`, which is also set: keep `kickoff_file` and delete `prompt_file`'])
  })
  test('kickoff and kickoff_file together are refused in the new names', () => {
    expect(load(spec('kickoff = "a"\nkickoff_file = "b"')).errors).toEqual(['specialists.ops: set kickoff or kickoff_file, not both'])
  })
  test('an invalid value is refused at the key the file has', () => {
    expect(load(spec('prompt = 3')).errors).toEqual(['specialists.ops.prompt: must be a non-empty string'])
    expect(load(spec('kickoff = 3')).errors).toEqual(['specialists.ops.kickoff: must be a non-empty string'])
  })
  test('a default under the old name is read, warned once, and a specialist\'s own kickoff replaces it', () => {
    const r = ok(`${BASE}[defaults.specialist]\nprompt = "d"\n[specialists.a]\nworkdir = "/home/op/a"\nlistens = ["slack:#a"]\n[specialists.b]\nworkdir = "/home/op/b"\nlistens = ["slack:#b"]\nkickoff = "own"\n`)
    expect(r.config.specialists.a.kickoff).toBe('d')
    expect(r.config.specialists.b.kickoff).toBe('own')
    expect(renameWarnings(r.warnings)).toEqual(['defaults.specialist.prompt: rename `prompt` to `kickoff`; `prompt` still loads and will be removed'])
  })
  test('a schedule\'s message is not renamed to kickoff', () => {
    const r = ok(`${spec('')}[schedules.nightly]\ncron = "@daily"\ntarget = "specialist:ops"\nmessage = "go"\n`)
    expect(r.config.schedules.nightly.message).toBe('go')
    expect(renameWarnings(r.warnings)).toEqual([])
  })
})

describe('`max` is now `max_sessions`', () => {
  test('the new name works', () => {
    expect(ok(spec('sessions = "per-conversation"\nmax_sessions = 5\nidle = "1h"')).config.specialists.ops.maxSessions).toBe(5)
    expect(ok(spec('')).config.specialists.ops.maxSessions).toBe(20)
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(spec('sessions = "per-conversation"\nmax = 5\nidle = "1h"'))
    expect(r.config.specialists.ops.maxSessions).toBe(5)
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.max: rename `max` to `max_sessions`; `max` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('max = 5\nmax_sessions = 5')).errors).toEqual(['specialists.ops.max: is the old name of `max_sessions`, which is also set: keep `max_sessions` and delete `max`'])
  })
  test('an invalid value is refused at the key the file has', () => {
    expect(load(spec('max = 0')).errors).toEqual(['specialists.ops.max: must be a whole number above 0'])
    expect(load(spec('max_sessions = 0')).errors).toEqual(['specialists.ops.max_sessions: must be a whole number above 0'])
    expect(load(`${BASE}[defaults.specialist]\nmax = 0\n[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#help"]\n`).errors).toEqual(['defaults.specialist.max: must be a whole number above 0'])
  })
  test('the warning about a per-conversation specialist with no idle names max_sessions', () => {
    expect(ok(spec('sessions = "per-conversation"\nmax_sessions = 5')).warnings).toEqual(['specialists.ops: conversations past max_sessions (5) will wait until a session is ended by hand; set idle'])
  })
})

describe('`was` is now `renamed_from`', () => {
  test('the new name works', () => {
    expect(ok(spec('renamed_from = ["old-ops"]')).config.specialists.ops.renamedFrom).toEqual(['old-ops'])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(spec('was = ["old-ops"]'))
    expect(r.config.specialists.ops.renamedFrom).toEqual(['old-ops'])
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.was: rename `was` to `renamed_from`; `was` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('was = ["a"]\nrenamed_from = ["a"]')).errors).toEqual(['specialists.ops.was: is the old name of `renamed_from`, which is also set: keep `renamed_from` and delete `was`'])
  })
  test('an invalid entry is refused at the key the file has', () => {
    expect(load(spec('was = ["Ops_Old"]')).errors).toEqual(['specialists.ops.was[0]: specialist name must be lowercase letters, digits and dashes'])
    expect(load(spec('renamed_from = ["Ops_Old"]')).errors).toEqual(['specialists.ops.renamed_from[0]: specialist name must be lowercase letters, digits and dashes'])
  })
})

describe('`apps` is now `pinned_to`', () => {
  test('the new name works', () => {
    expect(ok(spec('pinned_to = ["sales"]')).config.specialists.ops.pinnedTo).toEqual(['sales'])
  })
  test('the old name works, and the warning names the new one', () => {
    const r = ok(spec('apps = ["sales"]'))
    expect(r.config.specialists.ops.pinnedTo).toEqual(['sales'])
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.apps: rename `apps` to `pinned_to`; `apps` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('apps = ["sales"]\npinned_to = ["sales"]')).errors).toEqual(['specialists.ops.apps: is the old name of `pinned_to`, which is also set: keep `pinned_to` and delete `apps`'])
  })
  test('an invalid value is refused at the key the file has', () => {
    expect(load(spec('apps = ["nope"]')).errors).toEqual(['specialists.ops.apps[0]: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales'])
    expect(load(spec('pinned_to = ["nope"]')).errors).toEqual(['specialists.ops.pinned_to[0]: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales'])
    expect(load(spec('apps = "sales"')).errors).toEqual(['specialists.ops.apps: must be a list of strings'])
  })
  test('an inherited old name is reported at the key the defaults have', () => {
    expect(load(`${BASE}[defaults.specialist]\napps = ["nope"]\n[specialists.ops]\nworkdir = "/home/op/ops"\nlistens = ["slack:#help"]\n`).errors)
      .toEqual(['specialists.ops.apps (from defaults.specialist)[0]: no app "nope": declare [slack.apps.nope]; hydra.toml declares default, sales'])
  })
  test('the old name is not read on a rule or a place: `app` is not renamed', () => {
    expect(load(`${spec('')}[[rules]]\napps = "sales"\ntarget = "specialist:ops"\n`).errors).toEqual(['rules[0].apps: unknown key "apps"', 'rules[0]: a rule needs `place`, `app` or both; `person` only narrows who it applies to'])
  })
  test('a rule pointing at a pinned specialist names pinned_to in its fix', () => {
    expect(load(`${spec('pinned_to = ["sales"]')}[[rules]]\napp = "default"\ntarget = "specialist:ops"\n`).errors[0]).toContain("add default to ops's `pinned_to`")
  })
})

describe('the loader stays strict', () => {
  test('an unknown key is still refused', () => {
    expect(load(spec('kickof = "x"')).errors).toEqual(['specialists.ops.kickof: unknown key "kickof"'])
  })
})
