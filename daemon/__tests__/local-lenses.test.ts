import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { LOCAL_LENSES_DIR, listLensNames, listModifierKeys, resolveModifier, resolveModifiers, withDefaultLenses } from '../modifiers.js'

const put = (name: string, body: string) => { mkdirSync(LOCAL_LENSES_DIR, { recursive: true }); writeFileSync(join(LOCAL_LENSES_DIR, name), body) }
afterEach(() => rmSync(LOCAL_LENSES_DIR, { recursive: true, force: true }))

test('a local .md lens resolves by name and alias, joins +name parsing and lens lists, needs no restart', () => {
  expect(resolveModifier('architecture')).toBeUndefined()
  put('architecture.md', '---\naliases: arch, a2\n---\nCheck boundaries and contracts.\n')
  expect(resolveModifier('architecture')).toMatchObject({ type: 'seed', target: 'critic', instructions: 'Check boundaries and contracts.' })
  expect(resolveModifier('arch')?.name).toBe('architecture')
  expect(resolveModifiers(['a2', 'security']).resolved.map(m => m.name)).toEqual(['architecture', 'security'])
  expect(listModifierKeys()).toEqual(expect.arrayContaining(['architecture', 'arch', 'a2']))
  expect(listLensNames()).toContain('architecture')
})

test('built-in names win a clash; an empty body is ignored', () => {
  put('security.md', 'my own security lens')
  put('empty.md', '---\ndefault: true\n---\n\n')
  expect((resolveModifier('security') as any)?.instructions).not.toBe('my own security lens')
  expect(resolveModifier('empty')).toBeUndefined()
})

test('default: true lenses join automatic-lens runs once; +no-lenses and non-auto runs are untouched', () => {
  put('architecture.md', '---\ndefault: true\n---\nArch.\n')
  put('perf.md', 'Perf.\n')
  const names = (p: any) => (p.modifiers ?? []).map((m: any) => m.name)
  expect(names(withDefaultLenses({ autoReviewLenses: true }))).toEqual(['architecture'])
  expect(names(withDefaultLenses({ autoReviewLenses: true, modifiers: [resolveModifier('architecture')] }))).toEqual(['architecture'])
  expect(names(withDefaultLenses({ autoReviewLenses: true, noAutoLenses: true }))).toEqual([])
  expect(names(withDefaultLenses({}))).toEqual([])
})
