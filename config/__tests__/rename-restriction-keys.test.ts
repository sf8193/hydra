// A specialist's `allow`, `mcp` and `talks_to`, and `[defaults] private_roots`, are now `reachable_by`, `mcp_servers`, `sends_to` and
// `[restricted] off_limits`. The old names still load, as the new ones, with a warning that names the new key; both names is an error;
// unknown keys are still refused; an invalid value is reported at the key the file has.
import { isValueWarning } from './value-kinds.js'
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({
  home: '/home/op', stateDir: '/home/op/.claude/channels/discord', claudeConfigDir: '/home/op/.claude',
  isDir: p => p.startsWith('/home/op'),
  isCommand: c => c === '/usr/local/bin/datadog-mcp' || c === '/usr/bin/sandbox-exec',
  envFileHas: () => true,
})
const text = (f: string) => readFileSync(join(import.meta.dir, 'fixtures', f), 'utf8')
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const load = (toml: string) => {
  const r = loadHydraConfig(toml, env)
  return r.ok ? { ok: true as const, config: r.config, warnings: r.warnings.map(line), errors: [] as string[] } : { ok: false as const, errors: r.errors.map(line), warnings: r.warnings.map(line) }
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
[people.op]
addresses = ["slack:U0OP"]
[people.alice]
addresses = ["slack:U0ALICE"]
roles = ["staff"]
[mcp.datadog]
command = "/usr/local/bin/datadog-mcp"
token_env = ["DD_API_KEY"]
tools = ["search_logs"]
`
const spec = (body: string, id = 'ops') => `${BASE}[specialists.${id}]\nworkdir = "/home/op/${id}"\n${body}\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:${id}"\n`
const withDeep = (body: string) => `${spec(body)}[specialists.deep]\nworkdir = "/home/op/deep"\nrestricted = true\n`

describe('a full config in the old names', () => {
  const old = text('old-restriction-names.toml')
  const now = old
    .replace(/^allow = /gm, 'reachable_by = ').replace(/^mcp = /gm, 'mcp_servers = ').replace(/^talks_to = /gm, 'sends_to = ')
    .replace('[defaults]\nprivate_roots = ', '[restricted]\noff_limits = ')

  test('loads, and every old key warns once, naming its new key', () => {
    const r = ok(old)
    expect(renameWarnings(r.warnings)).toEqual([
      'defaults.private_roots: rename `private_roots` in [defaults] to `off_limits` in [restricted]; `private_roots` still loads and will be removed',
      'defaults.specialist.allow: rename `allow` to `reachable_by`; `allow` still loads and will be removed',
      'specialists.helpdesk.mcp: rename `mcp` to `mcp_servers`; `mcp` still loads and will be removed',
      'specialists.helpdesk.talks_to: rename `talks_to` to `sends_to`; `talks_to` still loads and will be removed',
      'specialists.triage.allow: rename `allow` to `reachable_by`; `allow` still loads and will be removed',
      'specialists.triage.talks_to: rename `talks_to` to `sends_to`; `talks_to` still loads and will be removed',
      'specialists.plain.allow: rename `allow` to `reachable_by`; `allow` still loads and will be removed',
    ])
  })

  test('the same file in the new names loads to the identical config, with no rename warning and the same other warnings', () => {
    const [a, b] = [ok(old), ok(now)]
    expect(b.config).toEqual(a.config)
    expect(renameWarnings(b.warnings)).toEqual([])
    expect(b.warnings.filter(w => !isValueWarning(w))).toEqual(a.warnings.filter(w => !renameWarnings([w]).length && !isValueWarning(w)))
  })

  test('the loaded config holds the values the old names gave', () => {
    const { config } = ok(old)
    expect(config.specialists.helpdesk).toMatchObject({ mcpServers: ['datadog'], sendsTo: ['triage'], reachableBy: ['staff'] })
    expect(config.specialists.triage).toMatchObject({ reachableBy: [], sendsTo: ['helpdesk'] })
    expect(config.specialists.plain.reachableBy).toEqual(['staff', 'anyone'])
    expect(config.offLimits).toEqual(['/home/op/notes', '/home/op/Workstreams'])
  })
})

describe('`allow` is now `reachable_by`', () => {
  test('the new name works, and says roles', () => {
    expect(ok(spec('reachable_by = ["role:staff"]')).config.specialists.ops.reachableBy).toEqual(['staff'])
    expect(renameWarnings(ok(spec('reachable_by = ["role:staff"]')).warnings)).toEqual([])
    expect(load(spec('reachable_by = ["alice"]')).errors).toEqual(['specialists.ops.reachable_by[0]: "alice" is a person, and reachable_by lists roles: give them a role in [people.alice] and list role:<name>'])
    expect(load(spec('reachable_by = ["role:ghost"]')).errors).toEqual(['specialists.ops.reachable_by[0]: no one holds the role "ghost": reachable_by lists roles, so give a person that role in [people.<id>] roles'])
  })
  test('the old name works and warns', () => {
    const r = ok(spec('allow = ["staff"]'))
    expect(r.config.specialists.ops.reachableBy).toEqual(['staff'])
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.allow: rename `allow` to `reachable_by`; `allow` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('allow = ["staff"]\nreachable_by = ["role:staff"]')).errors).toEqual(['specialists.ops.allow: is the old name of `reachable_by`, which is also set: keep `reachable_by` and delete `allow`'])
  })
  test('an invalid value is refused at the key the file has', () => {
    expect(load(spec('allow = ["ghost"]')).errors[0]).toStartWith('specialists.ops.allow[0]: no one holds the role "ghost"')
    expect(load(spec('allow = "staff"')).errors).toEqual(['specialists.ops.allow: must be a list of strings'])
  })
  test('a default under the old name is read, warned once, and refused at the key the file has', () => {
    const r = ok(`${BASE}[defaults.specialist]\nallow = ["staff"]\n[specialists.ops]\nworkdir = "/home/op/ops"\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops"\n`)
    expect(r.config.specialists.ops.reachableBy).toEqual(['staff'])
    expect(renameWarnings(r.warnings)).toEqual(['defaults.specialist.allow: rename `allow` to `reachable_by`; `allow` still loads and will be removed'])
    expect(load(`${BASE}[defaults.specialist]\nallow = ["ghost"]\n`).errors).toEqual(['defaults.specialist.allow[0]: no one holds the role "ghost": reachable_by lists roles, so give a person that role in [people.<id>] roles'])
  })
})

describe('`mcp` is now `mcp_servers`', () => {
  test('the new name works', () => {
    expect(ok(spec('restricted = true\nmcp_servers = ["datadog"]')).config.specialists.ops.mcpServers).toEqual(['datadog'])
  })
  test('the old name works and warns', () => {
    const r = ok(spec('restricted = true\nmcp = ["datadog"]'))
    expect(r.config.specialists.ops.mcpServers).toEqual(['datadog'])
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.mcp: rename `mcp` to `mcp_servers`; `mcp` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec('restricted = true\nmcp = ["datadog"]\nmcp_servers = ["datadog"]')).errors).toEqual(['specialists.ops.mcp: is the old name of `mcp_servers`, which is also set: keep `mcp_servers` and delete `mcp`'])
  })
  test('an invalid entry is refused at the key the file has', () => {
    expect(load(spec('restricted = true\nmcp = ["nope"]')).errors).toEqual(['specialists.ops.mcp[0]: no [mcp.nope]: declare the server in hydra.toml first'])
    expect(load(spec('restricted = true\nmcp_servers = ["nope"]')).errors).toEqual(['specialists.ops.mcp_servers[0]: no [mcp.nope]: declare the server in hydra.toml first'])
  })
  test('the old name is still not a default, and the error says the new name', () => {
    expect(load(`${BASE}[defaults.specialist]\nmcp = ["datadog"]\n`).errors).toEqual(["defaults.specialist.mcp: can't be a default: mcp_servers says what one specialist's session may reach. Set it under [specialists.<id>] by editing hydra.toml"])
  })
  test('the top-level [mcp.<name>] table keeps its name', () => {
    expect(ok(BASE).config.mcpServers?.datadog).toBeDefined()
  })
})

describe('`talks_to` is now `sends_to`', () => {
  test('the new name works', () => {
    expect(ok(withDeep('restricted = true\nsends_to = ["deep"]')).config.specialists.ops.sendsTo).toEqual(['deep'])
  })
  test('the old name works and warns', () => {
    const r = ok(withDeep('restricted = true\ntalks_to = ["deep"]'))
    expect(r.config.specialists.ops.sendsTo).toEqual(['deep'])
    expect(renameWarnings(r.warnings)).toEqual(['specialists.ops.talks_to: rename `talks_to` to `sends_to`; `talks_to` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(withDeep('restricted = true\ntalks_to = ["deep"]\nsends_to = ["deep"]')).errors).toEqual(['specialists.ops.talks_to: is the old name of `sends_to`, which is also set: keep `sends_to` and delete `talks_to`'])
  })
  test('a refusal at the old key says the new key, and a warning about it names the key in the file', () => {
    expect(load(withDeep('restricted = true\ntalks_to = ["ghost"]')).errors).toEqual(['specialists.ops.talks_to[0]: no [specialists.ghost]: sends_to names a specialist declared in hydra.toml'])
    expect(load(withDeep('talks_to = ["deep"]')).errors).toEqual(['specialists.ops.talks_to: has no effect while restricted = false: it already has every tool and server the operator does, and send_to_thread to any session; set restricted = true to choose them'])
  })
  test('the warning that a target runs under the operator is at the key the file has', () => {
    const r = ok(`${BASE}[specialists.ops]\nworkdir = "/home/op/ops"\nrestricted = true\ntalks_to = ["deep"]\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops"\n[specialists.deep]\nworkdir = "/home/op/deep"\n`)
    expect(r.warnings.filter(w => w.includes('runs under the operator'))[0]).toStartWith('specialists.ops.talks_to[0]: deep runs under')
  })
  test('a specialist only a sends_to reaches is reachable: no "nobody can reach it" warning, and the warning names sends_to', () => {
    expect(ok(withDeep('restricted = true\nsends_to = ["deep"]')).warnings.some(w => w.includes('specialists.deep: nobody can reach it'))).toBe(false)
    expect(ok(`${BASE}[specialists.lone]\nworkdir = "/home/op/lone"\n`).warnings).toContain('specialists.lone: nobody can reach it: no rule, schedule or `sends_to` names it')
  })
})

describe('`[defaults] private_roots` is now `[restricted] off_limits`', () => {
  const spec2 = (extra: string) => `${spec('restricted = true')}${extra}`
  test('the new name works', () => {
    const r = ok(spec2('[restricted]\noff_limits = ["~/notes"]\n'))
    expect(r.config.offLimits).toEqual(['/home/op/notes'])
    expect(renameWarnings(r.warnings)).toEqual([])
  })
  test('the old name works and warns', () => {
    const r = ok(spec2('[defaults]\nprivate_roots = ["~/notes"]\n'))
    expect(r.config.offLimits).toEqual(['/home/op/notes'])
    expect(renameWarnings(r.warnings)).toEqual(['defaults.private_roots: rename `private_roots` in [defaults] to `off_limits` in [restricted]; `private_roots` still loads and will be removed'])
  })
  test('both names is an error', () => {
    expect(load(spec2('[defaults]\nprivate_roots = ["~/a"]\n[restricted]\noff_limits = ["~/a"]\n')).errors).toEqual(['defaults.private_roots: is the old name of `[restricted] off_limits`, which is also set: keep `[restricted] off_limits` and delete `[defaults] private_roots`'])
  })
  test('an invalid entry is refused at the key the file has', () => {
    expect(load(spec2('[defaults]\nprivate_roots = ["notes"]\n')).errors).toEqual(['defaults.private_roots[0]: "notes" must be an absolute path or start with ~'])
    expect(load(spec2('[restricted]\noff_limits = ["notes"]\n')).errors).toEqual(['restricted.off_limits[0]: "notes" must be an absolute path or start with ~'])
    expect(load(spec2('[restricted]\noff_limits = "x"\n')).errors).toEqual(['restricted.off_limits: must be a list of strings'])
  })
  test('the new table is strict: an unknown key is refused', () => {
    expect(load(spec2('[restricted]\nroots = ["~/a"]\n')).errors).toEqual(['restricted.roots: unknown key "roots"'])
  })
  test('a restricted specialist inside an off-limits folder is refused, through either name', () => {
    const inside = spec('restricted = true').replace('workdir = "/home/op/ops"', 'workdir = "/home/op/notes/ops"')
    const why = (table: string) => load(`${inside}${table}`).errors
    const viaNew = why('[restricted]\noff_limits = ["~/notes"]\n')
    const viaOld = why('[defaults]\nprivate_roots = ["~/notes"]\n')
    expect(viaNew).toHaveLength(1)
    expect(viaNew[0]).toStartWith('specialists.ops.workdir: ')
    expect(viaOld).toEqual(viaNew)
    expect(load(inside).errors).toEqual([])
  })
})

describe('the loader stays strict', () => {
  test('an unknown key is still refused', () => {
    expect(load(spec('reachable = ["staff"]')).errors).toEqual(['specialists.ops.reachable: unknown key "reachable"'])
  })
})
