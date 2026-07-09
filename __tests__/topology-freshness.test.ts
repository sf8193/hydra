import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

describe('topology freshness', () => {
  test('gen-topology.ts produces zero diff against committed files', () => {
    const before = readFileSync(join(ROOT, 'docs/topology.mmd'), 'utf8')
    execSync('bun scripts/gen-topology.ts', { cwd: ROOT, stdio: 'pipe' })
    const after = readFileSync(join(ROOT, 'docs/topology.mmd'), 'utf8')
    expect(after).toBe(before)
  })
})
