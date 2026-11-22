import { describe, test, expect } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { basename, join } from 'path'

// The README's "Core abstractions" section and every diagrams/*.mmd name files and symbols.
// Names that no longer exist, or a picture that drifted from the README's copy, fail here.
// A diagram's names are checked by name only, so a move that keeps the name never fails it.
const ROOT = join(import.meta.dir, '..')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const core = readFileSync(join(ROOT, 'diagrams/core.mmd'), 'utf8')
const section = readme.match(/^## Core abstractions\n([\s\S]*?)^## /m)?.[1] ?? ''

const isPath = (t: string) => /^[\w.-]+(\/[\w.-]+)*\/?$/.test(t) && (t.includes('/') || /\.(ts|mmd|png)$/.test(t))
const isSymbol = (t: string) => /^([a-z]+[A-Z]\w*|[A-Z]\w*)$/.test(t)

// Tracked files only, so a local untracked file can't keep a name alive that CI would not see.
const sources = (dir: string): string[] =>
  execFileSync('git', ['ls-files', '*.ts'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).map(p => join(dir, p))
const isTest = (p: string) => /\/__tests__\//.test(p) || p.endsWith('.test.ts')
let all: string[] | undefined
const files = () => (all ??= sources(ROOT))
let exported: string | undefined
const isExported = (name: string) => {
  exported ??= files().map(p => readFileSync(p, 'utf8')).join('\n')
  return new RegExp(`export (async )?(type|interface|function|const|class) ${name}\\b`).test(exported)
}
// Every identifier in production code, comments left out: a name kept alive only by a test or a comment is gone.
let words: Set<string> | undefined
const inCode = (name: string) => (words ??= new Set(files().filter(p => !isTest(p))
  .flatMap(p => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1').match(/\b\w+\b/g) ?? []))).has(name)
let names: Set<string> | undefined
const isFile = (name: string) => (names ??= new Set(files().map(p => basename(p)))).has(basename(name))

const MERMAID = new Set(['sequenceDiagram', 'stateDiagram', 'classDiagram', 'erDiagram', 'classDef', 'linkStyle'])

/**
 * The `.ts` files and camelCase names a diagram shows that no longer exist. Node ids are the author's, not names, and are skipped.
 * Not checked: PascalCase names (types), and a name written straight before `[` or `{`, which reads as a node id.
 */
function missingNames(mmd: string, has = { file: isFile, symbol: inCode }): string[] {
  const text = mmd
    .replace(/%%\{[\s\S]*?\}%%/g, '')                             // the init directive's theme keys
    .replace(/^\s*(classDef|class|style|linkStyle)\b.*$/gm, '')   // styling
    .replace(/-<br\/>/g, '-').replace(/(\b[a-z]+[A-Z]\w*)<br\/>([A-Z])/g, '$1$2') // a name wrapped across lines
  const ids = new Set([
    ...[...text.matchAll(/\b(?:participant|actor|subgraph)\s+(\w+)/g)].map(m => m[1]),
    ...[...text.matchAll(/\b(\w+)\s*(?:\[|\{|\(+\s*")/g)].map(m => m[1]),
  ])
  const missing = new Set<string>()
  for (const f of text.match(/[\w./-]*[\w-]+\.ts\b/g) ?? []) if (!has.file(f)) missing.add(f)
  for (const s of text.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []) if (!ids.has(s) && !MERMAID.has(s) && !has.symbol(s)) missing.add(s)
  return [...missing]
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
    expect(names.length, 'glossary table not found').toBeGreaterThan(0)
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

describe('diagram names', () => {
  const diagrams = readdirSync(join(ROOT, 'diagrams')).filter(f => f.endsWith('.mmd'))

  test('every .ts file and camelCase name a diagram shows still exists in the code', () => {
    expect(diagrams.length).toBeGreaterThan(0)
    const stale = diagrams.flatMap(d => {
      const missing = missingNames(readFileSync(join(ROOT, 'diagrams', d), 'utf8'))
      return missing.length ? [`diagrams/${d}: ${missing.join(', ')}`] : []
    })
    expect(stale, `diagrams name things that no longer exist. Redraw the part from the code, or delete it if it only draws removed code:\n${stale.join('\n')}`).toEqual([])
  })

  const has = { file: (f: string) => basename(f) === 'kept.ts', symbol: (s: string) => s === 'keptName' || s === 'keptLongName' }
  test('a removed file or symbol is named', () => {
    expect(missingNames('participant a as gone.ts\na->>b: removedName(x)', has)).toEqual(['gone.ts', 'removedName'])
  })

  test('a move that keeps the name passes, and so do a wrapped name, node ids and mermaid keywords', () => {
    expect(missingNames('sequenceDiagram\nparticipant someId as old/dir/kept.ts\nsomeId->>b: keptLong<br/>Name()', has)).toEqual([])
    expect(missingNames('flowchart TD\n  nodeId["kept.ts"] --> otherId{"keptName"}\n  classDef fooBar fill:#fff', has)).toEqual([])
  })
})
