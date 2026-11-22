import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ALLOWED, found, violations } from '../../scripts/check-dynamic-imports.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })

describe('check-dynamic-imports', () => {
  test('a new dynamic import in production code is refused, and the message says what to do', () => {
    const v = violations([file('daemon/x.ts', "const { a } = await import('./y.js')")], [])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain("daemon/x.ts -> ./y.js")
    expect(v[0]).toContain('Import it statically')
  })

  test('an allowed one passes, and a second use of the same module in the same file does not', () => {
    const one = file('daemon/x.ts', "const a = await import('./y.js')")
    const two = file('daemon/x.ts', "const a = await import('./y.js')", "const b = await import('./y.js')")
    expect(violations([one], ['daemon/x.ts -> ./y.js'])).toEqual([])
    expect(violations([two], ['daemon/x.ts -> ./y.js'])).toHaveLength(1)
  })

  test('an allowed import that is gone is an error, so the list only shrinks', () => {
    const v = violations([file('daemon/x.ts', 'const a = 1')], ['daemon/x.ts -> ./y.js'])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('no longer in the code')
  })

  test('type queries are not loads', () => {
    const lines = ["let s: import('net').Socket | undefined", "type P = typeof import('./p.js')['default']", "const m = new Map<string, { socket: import('net').Socket }>()"]
    expect(found([file('daemon/x.ts', ...lines)])).toEqual([])
  })

  test('chained, returned and promised loads are loads; a computed specifier is one too', () => {
    expect(found([file('daemon/x.ts', "return import('./a.js')", "const p = import('./b.js').then(m => m)", 'await import(name)')]))
      .toEqual(['daemon/x.ts -> ./a.js', 'daemon/x.ts -> ./b.js', 'daemon/x.ts -> <computed>'])
  })

  test('comments, tests, test-setup.ts and scripts/ are not scanned', () => {
    expect(found([file('daemon/x.ts', "// const a = await import('./y.js')", "/* await import('./z.js') */")])).toEqual([])
    for (const path of ['daemon/__tests__/a.test.ts', 'test-setup.ts', 'scripts/s.ts']) expect(found([file(path, "await import('./y.js')")])).toEqual([])
  })

  test('the repo today matches the allowlist exactly', () => {
    const root = join(import.meta.dir, '..', '..')
    const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(violations(paths.map(path => ({ path, text: readFileSync(join(root, path), 'utf8') })))).toEqual([])
    expect(ALLOWED.length).toBeGreaterThan(0)
  })
})
