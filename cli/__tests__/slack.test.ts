import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..', '..')
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const manifest = (toml?: string) => {
  dir = mkdtempSync(join(tmpdir(), 'slack-manifest-'))
  if (toml !== undefined) writeFileSync(join(dir, 'hydra.toml'), toml)
  const p = Bun.spawnSync(['bun', join(root, 'cli', 'hydra.ts'), '--state-dir', dir, 'slack', 'manifest'], { cwd: root })
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
    expect(noSlack.err).toContain('no [connectors.slack], so the app gets the default name')
    expect(broken.err).toContain('Slack allows at most 35')
  })
})
