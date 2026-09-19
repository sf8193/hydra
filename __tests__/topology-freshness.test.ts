import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

describe('topology freshness', () => {
  test('committed docs/topology.* match a fresh generation', () => {
    // Generate into a temp dir so the test never mutates the tree it audits.
    // (Regenerating in-place self-heals: a stale file is overwritten on the
    //  failing run, then compares clean forever after.)
    const tmp = mkdtempSync(join(tmpdir(), 'topo-'))
    const gen = Bun.spawnSync(['bun', 'scripts/gen-topology.ts', '--out', tmp], { cwd: ROOT })
    if (gen.exitCode !== 0) throw new Error(`gen-topology failed: ${new TextDecoder().decode(gen.stderr)}`)
    for (const name of ['topology.mmd', 'topology-data.json', 'topology.html']) {
      const fresh = readFileSync(join(tmp, name), 'utf8')
      const committed = readFileSync(join(ROOT, 'docs', name), 'utf8')
      expect(fresh, `docs/${name} is stale — run 'bun scripts/gen-topology.ts' and commit docs/`).toBe(committed)
    }
  })
})
