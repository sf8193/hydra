import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// The README's "Core abstractions" section and diagrams/core.mmd name files and exported symbols.
// Names that no longer exist, or a picture that drifted from the README's copy, fail here.
const ROOT = join(import.meta.dir, '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const core = readFileSync(join(ROOT, 'diagrams/core.mmd'), 'utf8')
const section = readme.match(/^## Core abstractions\n([\s\S]*?)^## /m)?.[1] ?? ''

const isPath = (t: string) => /^[\w.-]+(\/[\w.-]+)*\/?$/.test(t) && (t.includes('/') || /\.(ts|mmd|png)$/.test(t))
const isSymbol = (t: string) => /^([a-z]+[A-Z]\w*|[A-Z]\w*)$/.test(t)

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    if (f === 'node_modules' || f.startsWith('.')) return []
    return statSync(p).isDirectory() ? sources(p) : f.endsWith('.ts') ? [p] : []
  })
let exported: string | undefined
const isExported = (name: string) => {
  exported ??= sources(ROOT).map(p => readFileSync(p, 'utf8')).join('\n')
  return new RegExp(`export (async )?(type|interface|function|const|class) ${name}\\b`).test(exported)
}

describe('core abstractions', () => {
  test('the README section exists', () => {
    expect(section, 'README.md has no "## Core abstractions" section').not.toBe('')
  })

  test('the section avoids retired names', () => {
    expect(section).not.toMatch(/listener|scoped specialist/i)
  })

  test('every path and exported symbol the section names exists', () => {
    const missing: string[] = []
    for (const [, t] of section.matchAll(/`([^`\n]+)`/g)) {
      if (isPath(t) && !existsSync(join(ROOT, t))) missing.push(`path ${t}`)
      else if (isSymbol(t) && !isExported(t)) missing.push(`symbol ${t}`)
    }
    expect(missing, `README "Core abstractions" names things that do not exist: ${missing.join(', ')}`).toEqual([])
  })

  test('every path named in diagrams/core.mmd exists', () => {
    const missing = (core.match(/[\w-]+(?:\/[\w.-]+)+/g) ?? []).filter(p => !existsSync(join(ROOT, p)))
    expect(missing, `diagrams/core.mmd names paths that do not exist: ${missing.join(', ')}`).toEqual([])
  })

  test('every bold box title in the picture is a glossary name', () => {
    const names = [...section.matchAll(/^\| ([^|]+?) \|/gm)].map(m => m[1]).filter(n => n !== 'Name' && !n.startsWith('--'))
    expect(names.length, 'glossary table not found').toBe(12)
    const bold = [...core.matchAll(/<b>([^<]+)<\/b>/g)].map(m => m[1])
    expect(bold.length).toBeGreaterThan(0)
    const stray = bold.filter(b => !names.includes(b))
    expect(stray, `bold titles in diagrams/core.mmd that are not glossary names: ${stray.join(', ')}`).toEqual([])
  })

  test("the README's picture is diagrams/core.mmd", () => {
    const block = section.match(/```mermaid\n([\s\S]*?)```/)?.[1]
    expect(block, 'README "Core abstractions" has no mermaid block').toBe(core)
  })
})
