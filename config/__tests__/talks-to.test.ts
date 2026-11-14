// `talks_to`: every refusal and warning at load, one test per row; and a workdir inside a workstream, through the real loader on a real disk.
import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHydraConfig, systemEnv } from '../load.js'
import { addFragment } from '../add.js'
import type { HydraConfig } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', sessionNames: ['spark'] })
const BASE = `
operator = "op"
[people.op]
ids = ["slack:U0OP"]
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
`
const ops = (body = 'talks_to = ["deep"]') => `[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:C0OPS"]\nallow = ["staff"]\naccess = "workdir"\n${body}\n`
const deep = (body = '') => `[specialists.deep]\nworkdir = "~/agents/deep"\nallow = []\naccess = "workdir"\n${body}\n`
const people = `[people.alice]\nids = ["slack:U0A"]\nroles = ["staff"]\n`
const text = (...parts: string[]) => [BASE, people, ...parts].join('\n')

const errorsOf = (t: string): string[] => {
  const r = loadHydraConfig(t, env)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(i => `${i.path}: ${i.message}`)
}
const ok = (t: string, e = env) => {
  const r = loadHydraConfig(t, e)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.map(i => `${i.path}: ${i.message}`).join('\n')}`)
  return { config: r.config as HydraConfig, warnings: r.warnings.map(i => `${i.path}: ${i.message}`) }
}

describe('talks_to', () => {
  test('a confined specialist lists the specialists it may send to; none by default; repeats are one', () => {
    expect(ok(text(ops(), deep())).config.specialists.ops.talksTo).toEqual(['deep'])
    expect(ok(text(ops('talks_to = ["deep", "deep"]'), deep())).config.specialists.ops.talksTo).toEqual(['deep'])
    expect(ok(text(ops(''), deep())).config.specialists.ops.talksTo).toBeUndefined()
  })
  test('it may name a specialist declared further down the file', () => {
    expect(ok(text(deep(), ops())).config.specialists.ops.talksTo).toEqual(['deep'])
    expect(ok(text(ops(), deep())).warnings).toEqual([])
  })
  test('on an access = "operator" specialist it is refused: that session already has send_to_thread to any session', () => {
    const t = text(`[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["slack:C0OPS"]\nallow = ["staff"]\ntalks_to = ["deep"]\n`, deep())
    expect(errorsOf(t)).toEqual(['specialists.ops.talks_to: has no effect while access = "operator": it already has every tool and server the operator does, and send_to_thread to any session; set access = "workdir" to choose them'])
  })
  test('it is refused in [defaults.specialist]: a default would reach every specialist', () => {
    expect(errorsOf(text('[defaults.specialist]\ntalks_to = ["deep"]\nworkdir = "~/agents/{id}"\n', deep())).some(e => e.startsWith("defaults.specialist.talks_to: can't be a default"))).toBe(true)
  })
  test('it is refused in a hydra config add fragment, and nothing is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talks-add-'))
    try {
      const live = `operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n`
      writeFileSync(join(dir, 'hydra.toml'), live)
      const r = addFragment(dir, testLoadEnv({ home: '/h' }), `[specialists.x]\nworkdir = "~/x"\ntalks_to = ["y"]\n`, '/repo/frag.toml')
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain('[specialists.x] talks_to')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('an unknown target, a specialist\'s own name and main are refused, each with the key and the fix', () => {
    expect(errorsOf(text(ops('talks_to = ["ghost"]'), deep()))).toEqual(['specialists.ops.talks_to[0]: no [specialists.ghost]: talks_to names a specialist declared in hydra.toml'])
    expect(errorsOf(text(ops('talks_to = ["ops"]'), deep()))).toEqual(['specialists.ops.talks_to[0]: ops cannot talk to itself'])
    expect(errorsOf(text(ops('talks_to = ["main"]'), deep()))).toEqual(["specialists.ops.talks_to[0]: main is the operator's own session: talks_to names specialists only"])
  })
  test('an old id (`was`) is not a target: it names no specialist', () => {
    expect(errorsOf(text(ops('talks_to = ["old"]'), deep('was = ["old"]')))).toEqual(['specialists.ops.talks_to[0]: no [specialists.old]: talks_to names a specialist declared in hydra.toml'])
  })
  test('a per-conversation target is refused: a hand-off needs one session to land in', () => {
    expect(errorsOf(text(ops(), deep('sessions = "per-conversation"')))).toEqual(['specialists.ops.talks_to[0]: deep has sessions = "per-conversation": a hand-off needs one session to land in; talk to a shared specialist'])
  })
  test('a non-list is a type error, not a silent empty list', () => {
    expect(errorsOf(text(ops('talks_to = "deep"'), deep())).length).toBeGreaterThan(0)
  })
  test('a target that runs under the operator\'s account loads, with a warning that names who is reached and how', () => {
    const t = text(ops(), `[specialists.deep]\nworkdir = "~/agents/deep"\nlistens = ["slack:C0DEEP"]\nallow = []\n`)
    const { config, warnings } = ok(t)
    expect(config.specialists.ops.talksTo).toEqual(['deep'])
    expect(warnings).toEqual(["specialists.ops.talks_to[0]: deep runs under the operator's account (access = \"operator\"): whatever ops is talked into sending reaches that account, quoted and labelled but read by a session that can act as the operator; give deep access = \"workdir\" with the broader folder it needs"])
  })
  test('a specialist only a talks_to reaches is reachable: no "nobody can reach it" warning', () => {
    expect(ok(text(ops(), deep())).warnings).toEqual([])
    expect(ok(text(ops(''), deep())).warnings.some(w => w.includes('nobody can reach it'))).toBe(true)
  })
  test('a confined specialist with no home loads clean: there is no escalation to post to, so no warning about one', () => {
    expect(ok(text(ops(''))).warnings).toEqual([])
    expect(ok(text(ops('home = "slack:C0HOME"'))).config.specialists.ops.home).toBe('slack:C0HOME')   // `home` is still where its threads open
  })
})

describe('a workdir inside a workstream loads, through the real loader on a real disk', () => {
  // Generic names only: <home>/Workstreams/ops/runbooks, as a real operator might lay a workstream out.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'talks-home-')))
  const stateDir = join(home, 'state')
  const runbooks = join(home, 'Workstreams', 'ops', 'runbooks')
  mkdirSync(runbooks, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(runbooks, 'restart.md'), 'restart the widget')
  const disk = { ...systemEnv(['spark'], stateDir, join(home, '.claude')), home }
  const t = (privateRoots = '') => text(
    privateRoots,
    `[specialists.ops]\nworkdir = "~/specialists/ops"\nlistens = ["slack:C0OPS"]\nallow = ["staff"]\naccess = "workdir"\ntalks_to = ["ops-deep"]\n`,
    `[specialists.ops-deep]\nworkdir = "~/Workstreams/ops/runbooks"\nallow = []\naccess = "workdir"\n`,
  )
  mkdirSync(join(home, 'specialists', 'ops'), { recursive: true })

  test('the broader specialist\'s folder, a workstream\'s runbooks, is accepted with no error and no warning', () => {
    const { config, warnings } = ok(t(), disk)
    expect(config.specialists['ops-deep'].workdir).toBe(runbooks)
    expect(warnings).toEqual([])
  })
  test('~/Workstreams is refused only when the operator lists it in private_roots', () => {
    const r = loadHydraConfig(t(`[defaults]\nprivate_roots = ["~/Workstreams"]\n`), disk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map(e => e.message).join('\n')).toContain('a private root in [defaults]')
  })
  test('the same folder is refused when it is a git work tree, holds a nested repository, or sits under a .mcp.json', () => {
    mkdirSync(join(runbooks, 'vendored', '.git'), { recursive: true })
    expect(loadHydraConfig(t(), disk).ok).toBe(false)           // a nested repository
    rmSync(join(runbooks, 'vendored'), { recursive: true, force: true })
    writeFileSync(join(home, 'Workstreams', '.mcp.json'), '{}')
    expect(loadHydraConfig(t(), disk).ok).toBe(false)           // under a .mcp.json
    rmSync(join(home, 'Workstreams', '.mcp.json'))
    expect(loadHydraConfig(t(), disk).ok).toBe(true)
    mkdirSync(join(home, 'Workstreams', '.git'), { recursive: true })
    expect(loadHydraConfig(t(), disk).ok).toBe(false)           // the workstream is itself a work tree
    rmSync(home, { recursive: true, force: true })
  })
})
