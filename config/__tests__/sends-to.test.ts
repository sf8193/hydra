// `sends_to`: every refusal and warning at load, one test per row; and a workdir inside a workstream, through the real loader on a real disk.
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
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
`
const ops = (body = 'sends_to = ["deep"]') => `[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = ["role:staff"]\nrestricted = true\n${body}\n[[rules]]\nplace = "slack:C0OPS"\ntarget = "specialist:ops"\n`
const deep = (body = '') => `[specialists.deep]\nworkdir = "~/agents/deep"\nreachable_by = []\nrestricted = true\n${body}\n`
const people = `[people.alice]\naddresses = ["slack:U0A"]\nroles = ["staff"]\n`
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

describe('sends_to', () => {
  test('a confined specialist lists the specialists it may send to; none by default; repeats are one', () => {
    expect(ok(text(ops(), deep())).config.specialists.ops.sendsTo).toEqual(['deep'])
    expect(ok(text(ops('sends_to = ["deep", "deep"]'), deep())).config.specialists.ops.sendsTo).toEqual(['deep'])
    expect(ok(text(ops(''), deep())).config.specialists.ops.sendsTo).toBeUndefined()
  })
  test('it may name a specialist declared further down the file', () => {
    expect(ok(text(deep(), ops())).config.specialists.ops.sendsTo).toEqual(['deep'])
    expect(ok(text(ops(), deep())).warnings).toEqual([])
  })
  test('on a restricted = false specialist it is refused: that session already has send_to_thread to any session', () => {
    const t = text(`[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = ["role:staff"]\nsends_to = ["deep"]\n[[rules]]\nplace = "slack:C0OPS"\ntarget = "specialist:ops"\n`, deep())
    expect(errorsOf(t)).toEqual(['specialists.ops.sends_to: has no effect while restricted = false: it already has every tool and server the operator does, and send_to_thread to any session; set restricted = true to choose them'])
  })
  test('it is refused in [defaults.specialist]: a default would reach every specialist', () => {
    expect(errorsOf(text('[defaults.specialist]\nsends_to = ["deep"]\nworkdir = "~/agents/{id}"\n', deep())).some(e => e.startsWith("defaults.specialist.sends_to: can't be a default"))).toBe(true)
  })
  test('it is refused in a hydra config add fragment, and nothing is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sends-add-'))
    try {
      const live = `operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n`
      writeFileSync(join(dir, 'hydra.toml'), live)
      const r = addFragment(dir, testLoadEnv({ home: '/h' }), `[specialists.x]\nworkdir = "~/x"\nsends_to = ["y"]\n`, '/repo/frag.toml')
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain('[specialists.x] sends_to')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('an unknown target, a specialist\'s own name and main are refused, each with the key and the fix', () => {
    expect(errorsOf(text(ops('sends_to = ["ghost"]'), deep()))).toEqual(['specialists.ops.sends_to[0]: no [specialists.ghost]: sends_to names a specialist declared in hydra.toml'])
    expect(errorsOf(text(ops('sends_to = ["ops"]'), deep()))).toEqual(['specialists.ops.sends_to[0]: ops cannot send to itself'])
    expect(errorsOf(text(ops('sends_to = ["main"]'), deep()))).toEqual(["specialists.ops.sends_to[0]: main is the operator's own session: sends_to names specialists only"])
  })
  test('an old id (`renamed_from`) is not a target: it names no specialist', () => {
    expect(errorsOf(text(ops('sends_to = ["old"]'), deep('renamed_from = ["old"]')))).toEqual(['specialists.ops.sends_to[0]: no [specialists.old]: sends_to names a specialist declared in hydra.toml'])
  })
  test('a per-conversation target is refused: a hand-off needs one session to land in', () => {
    expect(errorsOf(text(ops(), deep('sessions = "per-conversation"')))).toEqual(['specialists.ops.sends_to[0]: deep has sessions = "per-conversation": a hand-off needs one session to land in; send to a shared specialist'])
  })
  test('a non-list is a type error, not a silent empty list', () => {
    expect(errorsOf(text(ops('sends_to = "deep"'), deep())).length).toBeGreaterThan(0)
  })
  test('a target that runs under the operator\'s account loads, with a warning that names who is reached and how', () => {
    const t = text(ops(), `[specialists.deep]\nworkdir = "~/agents/deep"\nreachable_by = []\n[[rules]]\nplace = "slack:C0DEEP"\ntarget = "specialist:deep"\n`)
    const { config, warnings } = ok(t)
    expect(config.specialists.ops.sendsTo).toEqual(['deep'])
    expect(warnings).toEqual(["specialists.ops.sends_to[0]: deep runs under the operator's account (restricted = false): whatever ops is talked into sending reaches that account, quoted and labelled but read by a session that can act as the operator; make deep restricted = true, with the broader folder it needs"])
  })
  test('a specialist only a sends_to reaches is reachable: no "nobody can reach it" warning', () => {
    expect(ok(text(ops(), deep())).warnings).toEqual([])
    expect(ok(text(ops(''), deep())).warnings.some(w => w.includes('nobody can reach it'))).toBe(true)
  })
  test('a confined specialist with no home_place loads clean: home_place is only where it posts first, so no warning', () => {
    expect(ok(text(ops(''))).warnings).toEqual([])
    expect(ok(text(ops('home_place = "slack:C0HOME"'))).config.specialists.ops.homePlace).toBe('slack:C0HOME')   // `home_place` is still where it posts first
  })
})

describe('a workdir inside a workstream loads, through the real loader on a real disk', () => {
  // Generic names only: <home>/Workstreams/ops/runbooks, as a real operator might lay a workstream out.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sends-home-')))
  const stateDir = join(home, 'state')
  const runbooks = join(home, 'Workstreams', 'ops', 'runbooks')
  mkdirSync(runbooks, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(runbooks, 'restart.md'), 'restart the widget')
  const disk = { ...systemEnv(['spark'], stateDir, 'discord', join(home, '.claude')), home }
  const t = (offLimits = '') => text(
    offLimits,
    `[specialists.ops]\nworkdir = "~/specialists/ops"\nreachable_by = ["role:staff"]\nrestricted = true\nsends_to = ["ops-deep"]\n[[rules]]\nplace = "slack:C0OPS"\ntarget = "specialist:ops"\n`,
    `[specialists.ops-deep]\nworkdir = "~/Workstreams/ops/runbooks"\nreachable_by = []\nrestricted = true\n`,
  )
  mkdirSync(join(home, 'specialists', 'ops'), { recursive: true })

  test('the broader specialist\'s folder, a workstream\'s runbooks, is accepted with no error and no warning', () => {
    const { config, warnings } = ok(t(), disk)
    expect(config.specialists['ops-deep'].workdir).toBe(runbooks)
    expect(warnings).toEqual([])
  })
  test('~/Workstreams is refused only when the operator lists it in off_limits', () => {
    const r = loadHydraConfig(t(`[restricted]\noff_limits = ["~/Workstreams"]\n`), disk)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map(e => e.message).join('\n')).toContain('listed in [restricted] off_limits')
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
