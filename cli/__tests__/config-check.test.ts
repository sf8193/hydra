import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
    expect(check('operator = "op"\n[people.op]\nids = ["discord:100000000000000001"]\n')).toEqual({ code: 0, out: '$d/hydra.toml: loads clean\n' })
    const broken = check('operator = "ghost"\n')
    expect(broken.code).toBe(1)
    expect(broken.out).toContain('"ghost" is not a person')
    expect(check('operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n').out)
      .toBe('$d/hydra.toml: loads, with 1 warning\nhydra.toml operator: op has no discord: address, so on discord nobody passes admin checks or reaches main by DM\n')
    expect(check(undefined).out).toBe('$d/hydra.toml: none (the old files still apply)\n')
  })
})
