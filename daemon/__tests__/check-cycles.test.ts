import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ALLOWED, cycles, violations } from '../../scripts/check-cycles.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })
const a = file('shared/a.ts', "import { b } from './b.js'", 'export const a = b')
const b = file('shared/b.ts', "import { c } from './c.js'", 'export const b = c')
const c = file('shared/c.ts', "import { a } from './a.js'", 'export const c = a')

describe('check-cycles', () => {
  test('a new cycle of three is refused, and the message names its files', () => {
    const v = violations([a, b, c], [])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('shared/a.ts shared/b.ts shared/c.ts')
  })

  test('a chain is not a cycle, a type-only import does not close one', () => {
    const typed = file('shared/c.ts', "import type { a } from './a.js'", 'export const c = 1')
    expect(cycles([a, b, typed])).toEqual([])
  })

  test('an allowed cycle passes, and an entry that is no longer a cycle is an error', () => {
    expect(violations([a, b, c], ['shared/a.ts shared/b.ts shared/c.ts'])).toEqual([])
    const v = violations([a, b], ['shared/a.ts shared/b.ts shared/c.ts'])
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('no longer a cycle')
  })

  test('the real repo has exactly the allowed cycles', () => {
    const cwd = join(import.meta.dir, '..', '..')
    const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(violations(paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') })), ALLOWED)).toEqual([])
  })
})
