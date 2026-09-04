import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

describe('topology freshness', () => {
  test('committed docs/topology.mmd matches a fresh generation', () => {
    // Generate into a temp dir so the test never mutates the tree it audits.
    // (Regenerating in-place self-heals: a stale file is overwritten on the
    //  failing run, then compares clean forever after.)
    const tmp = mkdtempSync(join(tmpdir(), 'topo-'))
    execSync(`bun scripts/gen-topology.ts --out ${tmp}`, { cwd: ROOT, stdio: 'pipe' })
    const fresh = readFileSync(join(tmp, 'topology.mmd'), 'utf8')
    const committed = readFileSync(join(ROOT, 'docs/topology.mmd'), 'utf8')
    if (fresh !== committed) {
      throw new Error("topology is stale — run 'bun scripts/gen-topology.ts' and commit docs/")
    }
    expect(fresh).toBe(committed)
  })
})
