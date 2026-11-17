import { describe, test, expect, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..', '..')
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const check = (toml?: string, platform = 'discord') => {
  dir = mkdtempSync(join(tmpdir(), 'config-check-'))
  if (toml !== undefined) writeFileSync(join(dir, 'hydra.toml'), toml)
  const p = Bun.spawnSync(['bun', join(root, 'cli', 'hydra.ts'), '--state-dir', dir, 'config', 'check', platform], { cwd: root })
  return { code: p.exitCode, out: p.stdout.toString().replaceAll(dir, '$d') }
}

describe('hydra config check', () => {
  test('clean, broken, and an operator with no address on the platform', () => {
    expect(check('operator = "op"\n[people.op]\naddresses = ["discord:100000000000000001"]\n')).toEqual({ code: 0, out: '$d/hydra.toml: loads clean\n' })
    const broken = check('operator = "ghost"\n')
    expect(broken.code).toBe(1)
    expect(broken.out).toContain('"ghost" is not a person')
    expect(check('operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n').out)
      .toBe('$d/hydra.toml: loads, with 1 warning\nhydra.toml operator: op has no discord: address, so on discord nobody passes admin checks or reaches main by DM\n')
    expect(check(undefined).out).toBe('$d/hydra.toml: none (the old files still apply)\n')
  })
  test('prints where each specialist is heard, read off the rules; an old `listens` is warned and read as rules', () => {
    const base = 'operator = "op"\n[people.op]\naddresses = ["discord:100000000000000001"]\n[specialists.ops]\nworkdir = "/tmp"\n[specialists.crm]\nworkdir = "/tmp"\nlistens = ["discord:100000000000000002"]\n[[rules]]\nplace = "discord:100000000000000003"\ntarget = "specialist:ops"\n'
    const r = check(`${base}[gateways.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)
    expect(r.code).toBe(0)
    expect(r.out).toContain('hydra.toml specialists.crm.listens: `listens` is now `[[rules]]`: add a `[[rules]]` table for each place, with `place = "x"` and `target = "specialist:crm"` on separate lines (places: discord:100000000000000002)')
    expect(r.out).toContain('ops answers: discord:100000000000000003\ncrm answers: discord:100000000000000002\n')
  })
  test('shows the model main starts with when [main] model sets it', () => {
    const base = 'operator = "op"\n[people.op]\naddresses = ["discord:100000000000000001"]\n'
    expect(check(`${base}[main]\nmodel = "opus"\n`)).toEqual({
      code: 0,
      out: '$d/hydra.toml: loads clean\nmain model: claude-opus-5-5[1m] ([main] model = "opus"), applies at main\'s next start\n',
    })
    expect(check(`${base}[main]\nmodel = "claude-opsu"\n`).out).toContain('main model: claude-opsu ([main] model = "claude-opsu"), applies at main\'s next start; not a model hydra knows')
  })
  test('the old [connectors.discord] key loads, and the warning shows', () => {
    const base = 'operator = "op"\n[people.op]\naddresses = ["discord:100000000000000001"]\n'
    expect(check(`${base}[connectors.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)).toEqual({
      code: 0,
      out: '$d/hydra.toml: loads, with 1 warning\nhydra.toml connectors.discord: moved to [gateways.discord]; [connectors.discord] still loads and will be removed\n',
    })
    expect(check(`${base}[gateways.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n`)).toEqual({ code: 0, out: '$d/hydra.toml: loads clean\n' })
  })
  test('agrees with the daemon: on slack a connector app naming the gateway\'s tokens does not load, on discord it does', () => {
    const toml = 'operator = "op"\n[people.op]\naddresses = ["slack:U0OP", "discord:100000000000000001"]\n[slack.apps.default]\nbot_token_env = "SLACK_BOT_TOKEN"\nsocket_token_env = "SLACK_APP_TOKEN"\n'
    const onSlack = check(toml, 'slack')
    expect(onSlack.code).toBe(1)
    expect(onSlack.out).toContain('slack.apps.default.bot_token_env: "SLACK_BOT_TOKEN" is already the token variable of the Slack gateway (CHAT_PLATFORM=slack)')
    expect(check(toml, 'discord')).toEqual({ code: 0, out: '$d/hydra.toml: loads clean\n' })
  })
})

describe('hydra config add', () => {
  // A state dir is named for its platform, which is how the CLI knows it without the daemon's CHAT_PLATFORM.
  const add = (platform: string) => {
    dir = mkdtempSync(join(tmpdir(), 'config-add-'))
    const state = join(dir, platform)
    mkdirSync(state)
    writeFileSync(join(state, 'hydra.toml'), 'operator = "op"\n[people.op]\naddresses = ["slack:U0OP", "discord:100000000000000001"]\n[slack.apps.default]\nbot_token_env = "SLACK_BOT_TOKEN"\nsocket_token_env = "SLACK_APP_TOKEN"\n')
    const frag = join(dir, 'frag.toml')
    writeFileSync(frag, `[specialists.books]\nworkdir = "${dir}"\nkickoff = "Keep the books."\n`)
    const p = Bun.spawnSync(['bun', join(root, 'cli', 'hydra.ts'), '--state-dir', state, 'config', 'add', frag, '--dry-run'], { cwd: root, env: { ...process.env, CHAT_PLATFORM: '' } })
    return { code: p.exitCode, err: p.stderr.toString(), out: p.stdout.toString() }
  }
  test('on a slack state dir, in a shell with no CHAT_PLATFORM, a hydra.toml whose connector app names the gateway\'s tokens is refused; on discord it is accepted', () => {
    const slack = add('slack')
    expect(slack.code).toBe(1)
    expect(slack.err).toContain('"SLACK_BOT_TOKEN" is already the token variable of the Slack gateway (CHAT_PLATFORM=slack)')
    expect(add('discord').code).toBe(0)
  })
})
