import { describe, expect, test } from 'bun:test'
import { rewrite, specifier } from '../../scripts/move-modules.js'

const exists = (known: string[]) => (p: string) => known.includes(p)

describe('move-modules', () => {
  test('a specifier is relative to the importing file and ends in .js', () => {
    expect(specifier('daemon/a.ts', 'daemon/b.ts')).toBe('./b.js')
    expect(specifier('daemon/a.ts', 'infra/b.ts')).toBe('../infra/b.js')
    expect(specifier('infra/a.ts', 'infra/sub/b.ts')).toBe('./sub/b.js')
  })

  test('an importer of a moved file points at the new place, in every import form', () => {
    const moved = new Map([['daemon/tmux.ts', 'infra/tmux.ts']])
    const text = [
      "import { a } from './tmux.js'", "export { b } from './tmux.js'", "import './tmux.js'", "const m = await import('./tmux.js')", "mock.module('./tmux.js', () => ({}))",
      "import type { T } from './tmux.js'", "import { z } from './other.js'",
    ].join('\n')
    const r = rewrite(text, 'daemon/a.ts', 'daemon/a.ts', moved, exists(['daemon/a.ts', 'daemon/other.ts']))
    expect(r.changed).toBe(6)
    expect(r.text).toContain("from '../infra/tmux.js'")
    expect(r.text.match(/\.\.\/infra\/tmux\.js/g)).toHaveLength(6)
    expect(r.text).toContain("from './other.js'")
  })

  test('a moved file keeps pointing at what it imported, from its new directory', () => {
    const moved = new Map([['daemon/engines/x.ts', 'engines/x.ts']])
    const r = rewrite("import { a } from '../sessions.js'\nimport { b } from './y.js'", 'daemon/engines/x.ts', 'engines/x.ts', moved, exists(['daemon/sessions.ts', 'daemon/engines/y.ts']))
    expect(r.text).toBe("import { a } from '../daemon/sessions.js'\nimport { b } from '../daemon/engines/y.js'")
  })

  test('two files that move together keep their relative import', () => {
    const moved = new Map([['daemon/a.ts', 'infra/a.ts'], ['daemon/b.ts', 'infra/b.ts']])
    expect(rewrite("import { b } from './b.js'", 'daemon/a.ts', 'infra/a.ts', moved, exists([])).changed).toBe(0)
  })

  test('a directory import keeps its no-index form, and packages are left alone', () => {
    const moved = new Map([['shared/engines/index.ts', 'core/engines/index.ts']])
    const r = rewrite("import { e } from './engines'\nimport x from 'fs'\nimport y from 'bun:test'", 'shared/a.ts', 'shared/a.ts', moved, exists(['shared/a.ts']))
    expect(r.text).toBe("import { e } from '../core/engines'\nimport x from 'fs'\nimport y from 'bun:test'")
  })
})
