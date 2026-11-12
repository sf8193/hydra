import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..', '..')
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const manifest = (toml?: string, ...app: string[]) => {
  dir = mkdtempSync(join(tmpdir(), 'slack-manifest-'))
  if (toml !== undefined) writeFileSync(join(dir, 'hydra.toml'), toml)
  const p = Bun.spawnSync(['bun', join(root, 'cli', 'hydra.ts'), '--state-dir', dir, 'slack', 'manifest', ...app], { cwd: root })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString().replaceAll(dir, '$d') }
}
const OP = 'operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n'

describe('hydra slack manifest', () => {
  test('prints the manifest for the name hydra.toml gives, and only the manifest', () => {
    const r = manifest(`${OP}[connectors.slack]\nbot_token_env = "HYDRA_SLACK_BOT_TOKEN"\napp_name = "Krust"\n`)
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(Bun.YAML.parse(r.out)).toMatchObject({ display_information: { name: 'Krust' }, features: { bot_user: { display_name: 'Krust' } } })
  })
  test('without hydra.toml, the defaults (said on stderr); a hydra.toml that does not load, no manifest', () => {
    const none = manifest()
    expect(none.code).toBe(0)
    expect(Bun.YAML.parse(none.out)).toMatchObject({ display_information: { name: 'hydra' } })
    expect(none.err).toContain('$d/hydra.toml: none')
    const broken = manifest(`${OP}[connectors.slack]\nbot_token_env = "HYDRA_SLACK_BOT_TOKEN"\napp_name = "${'k'.repeat(36)}"\n`)
    expect(broken).toMatchObject({ code: 1, out: '' })
    const noSlack = manifest(OP)
    expect(noSlack.code).toBe(0)
    expect(noSlack.err).toContain('declares no Slack app, so the app gets the default name')
    expect(broken.err).toContain('Slack allows at most 35')
  })
  const SEVERAL = `${OP}[slack.apps.default]\nbot_token_env = "A_BOT"\n[slack.apps.sales]\nbot_token_env = "S_BOT"\ndisplay_name = "Sales helper"\n[slack.apps.ops]\nbot_token_env = "O_BOT"\n`
  test('with several apps, a name picks one; none or an unknown one is an error that lists the names', () => {
    const sales = manifest(SEVERAL, 'sales')
    expect(sales.code).toBe(0)
    expect(sales.err).toBe('')
    expect(Bun.YAML.parse(sales.out)).toMatchObject({ display_information: { name: 'Sales helper' } })
    expect(Bun.YAML.parse(manifest(SEVERAL, 'ops').out)).toMatchObject({ display_information: { name: 'ops' } })
    const none = manifest(SEVERAL)
    expect(none).toMatchObject({ code: 1, out: '' })
    expect(none.err).toContain('declares 3 Slack apps; pass one: hydra slack manifest <app> (default, sales, ops)')
    const unknown = manifest(SEVERAL, 'nope')
    expect(unknown).toMatchObject({ code: 1, out: '' })
    expect(unknown.err).toContain('no app named nope; hydra.toml declares: default, sales, ops')
    expect(manifest(OP, 'nope').err).toContain('no app named nope; hydra.toml declares no Slack app')
    expect(manifest(undefined, 'nope')).toMatchObject({ code: 1, out: '' })
  })
  test('with exactly one app, no name prints it, even if it is not `default`', () => {
    const r = manifest(`${OP}[slack.apps.sales]\nbot_token_env = "S_BOT"\n`)
    expect(r.code).toBe(0)
    expect(Bun.YAML.parse(r.out)).toMatchObject({ display_information: { name: 'sales' } })
  })
})
