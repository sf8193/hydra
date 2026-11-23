// Guard: every Bun TypeScript file in the repo (excluding `mod/` and `mods.local/`,
// which run under Claude Code's plugin runtime per bunfig.toml) must be covered by
// tsconfig.json so `bunx tsc --noEmit` never silently skips a directory.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../..')

describe('tsconfig.json coverage', () => {
  test('includes every tracked .ts file outside mod/ and mods.local/', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as {
      include?: string[]
      exclude?: string[]
    }
    const includes = (tsconfig.include ?? []).map(p => new Bun.Glob(p))
    const excludedPrefixes = (tsconfig.exclude ?? []).map(p => `${p.replace(/\/+$/, '')}/`)

    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)

    const uncovered = tracked.filter(file => {
      if (excludedPrefixes.some(prefix => file.startsWith(prefix))) return false
      return !includes.some(glob => glob.match(file))
    })

    expect(uncovered).toEqual([])
  })
})
