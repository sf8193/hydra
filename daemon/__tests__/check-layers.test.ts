import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { edges, tierOf, violations } from '../../scripts/check-layers.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })

describe('check-layers', () => {
  test('files get the tier of their folder', () => {
    expect(tierOf('shared/constants.ts')).toBe(0)
    expect(tierOf('engines/agy-engine.ts')).toBe(1)
    expect(tierOf('gateways/slack.ts')).toBe(1)
    expect(tierOf('sessions/registry.ts')).toBe(2)
    expect(tierOf('sessions/specialists.ts')).toBe(2)
    expect(tierOf('app/targets.ts')).toBe(4)
    expect(tierOf('connectors/github/pr-watch.ts')).toBe(3)
    expect(tierOf('app/router.ts')).toBe(4)   // an app file is app
    expect(tierOf('daemon.ts')).toBe(5)
    expect(tierOf('boot-probe.ts')).toBe(5)
    expect(tierOf('somewhere/else.ts')).toBeUndefined()
  })

  test('an import from a lower tier to a higher one is refused, and the message names both tiers', () => {
    const v = violations([file('shared/a.ts', "import { x } from '../app/router.js'"), file('app/router.ts', 'export const x = 1')], [])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('shared/a.ts -> app/router.ts')
    expect(v[0]).toContain('core (T0)')
    expect(v[0]).toContain('app (T4)')
  })

  test('imports that point down or sideways are fine', () => {
    const files = [file('app/router.ts', "import { a } from '../shared/a.js'", "import { b } from './sessions.js'"), file('shared/a.ts', 'export const a = 1'), file('sessions/registry.ts', "import { a } from '../shared/a.js'\nexport const b = 1")]
    expect(violations(files, [])).toEqual([])
  })

  test('type-only imports are not counted, and dynamic imports are', () => {
    const lower = file('shared/a.ts', "import type { X } from '../app/router.js'", "export type { Y } from '../app/router.js'")
    expect(violations([lower, file('app/router.ts', 'export type X = 1')], [])).toEqual([])
    const dyn = file('shared/a.ts', "export const f = async () => (await import('../app/router.js')).x")
    expect(violations([dyn, file('app/router.ts', 'export const x = 1')], [])).toHaveLength(1)
  })

  test('a side-effect import, a .ts specifier and a directory import are edges too', () => {
    const lower = (line: string) => [file('shared/a.ts', line), file('app/router.ts', 'export const x = 1'), file('daemon/index.ts', 'export const y = 1')]
    expect(edges(lower("import '../app/router.js'"))).toEqual(['shared/a.ts -> app/router.ts'])
    expect(edges(lower("import { x } from '../app/router.ts'"))).toEqual(['shared/a.ts -> app/router.ts'])
    expect(edges(lower("import { y } from '../daemon'"))).toEqual(['shared/a.ts -> daemon/index.ts'])
  })

  test('an allowed upward import passes, and an entry that no longer matches is an error so the list only shrinks', () => {
    const files = [file('shared/a.ts', "import { x } from '../app/router.js'"), file('app/router.ts', 'export const x = 1')]
    expect(violations(files, ['shared/a.ts -> app/router.ts'])).toEqual([])
    const gone = violations([file('shared/a.ts', 'export const a = 1'), files[1]], ['shared/a.ts -> app/router.ts'])
    expect(gone).toHaveLength(1)
    expect(gone[0]).toContain('no longer an upward import')
  })

  test('a production file with no tier is refused; tests and scripts are not scanned', () => {
    expect(violations([file('somewhere/else.ts', 'export const a = 1')], [])[0]).toContain('has no tier')
    expect(violations([file('scripts/x.ts', 'export const a = 1'), file('daemon/__tests__/x.test.ts', "import '../../app/router.js'")], [])).toEqual([])
  })

  test('edges reads the import path relative to the importing file', () => {
    const files = [file('daemon/engines/x.ts', "import { a } from '../../sessions/registry.js'"), file('sessions/registry.ts', 'export const a = 1')]
    expect(edges(files)).toEqual(['daemon/engines/x.ts -> sessions/registry.ts'])
  })

  test('the repo today matches the allowlist exactly', () => {
    const root = join(import.meta.dir, '..', '..')
    const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(violations(paths.map(path => ({ path, text: readFileSync(join(root, path), 'utf8') })))).toEqual([])
  })
})
