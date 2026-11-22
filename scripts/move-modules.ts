// Move production modules and keep every import pointing at them: `git mv` each file, then rewrite the relative specifier in every .ts file (production, tests, scripts)
// that resolves to a moved file, and every relative specifier INSIDE a moved file (its own directory changed). Then it lists what a rewrite cannot see: path
// strings built with import.meta.dir, and prose that names a moved file (docs, CLAUDE.md, plists), for a person to read. tsc and the tests are the proof.
//   bun scripts/move-modules.ts <old> <new> [<old> <new> ...]      e.g. daemon/tmux.ts infra/tmux.ts
//   bun scripts/move-modules.ts --dry <old> <new> ...               show what would change, touch nothing
//   bun scripts/move-modules.ts --map moves.txt                      one `old new` pair per line (# comments)

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

/** The specifier from `fromFile` to `toFile`, relative, with `.js` (the repo's import style), as TypeScript wants it. */
export function specifier(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile.replace(/\.ts$/, '.js'))
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
}

const SPEC = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bmock\.module\(\s*|\brequire\(\s*)(["']))(\.{1,2}\/[^"']*?)\2/g

/**
 * Rewrite the relative specifiers in one file's text. `oldPath` is where the file was, `newPath` where it is now; `moved` maps old path -> new path for every moved file.
 * A specifier is resolved against the file's OLD directory, mapped through `moved`, and written relative to its NEW directory.
 */
export function rewrite(text: string, oldPath: string, newPath: string, moved: ReadonlyMap<string, string>, exists: (p: string) => boolean): { text: string; changed: number } {
  let changed = 0
  const out = text.replace(SPEC, (whole, head: string, quote: string, spec: string) => {
    const base = join(dirname(oldPath), spec.replace(/\.js$/, ''))
    const target = [base + '.ts', join(base, 'index.ts')].find(p => moved.has(p) || exists(p))
    if (!target) return whole
    const next = specifier(newPath, moved.get(target) ?? target)
    const keepIndex = target.endsWith('/index.ts') && !spec.endsWith('index.js')
    const written = keepIndex ? next.replace(/\/index\.js$/, '') : next
    if (written === spec) return whole
    changed++
    return `${head}${written}${quote}`
  })
  return { text: out, changed }
}

if (import.meta.main) {
  const root = resolve(join(fileURLToPath(import.meta.url), '..', '..'))
  let args = process.argv.slice(2)
  const dry = args.includes('--dry')
  args = args.filter(a => a !== '--dry')
  let pairs: string[] = []
  const mapAt = args.indexOf('--map')
  if (mapAt >= 0) pairs = readFileSync(args[mapAt + 1], 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).flatMap(l => l.split(/\s+/))
  else pairs = args
  if (pairs.length === 0 || pairs.length % 2) { console.error('usage: bun scripts/move-modules.ts [--dry] <old> <new> [<old> <new> ...]'); process.exit(2) }
  const moved = new Map<string, string>()
  for (let i = 0; i < pairs.length; i += 2) {
    if (!existsSync(join(root, pairs[i]))) { console.error(`${pairs[i]}: no such file`); process.exit(2) }
    if (existsSync(join(root, pairs[i + 1]))) { console.error(`${pairs[i + 1]}: already exists`); process.exit(2) }
    moved.set(pairs[i], pairs[i + 1])
  }
  const tracked = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const known = new Set(tracked)
  const exists = (p: string) => known.has(p)
  let edits = 0, files = 0
  const writes: Array<[string, string]> = []
  for (const oldPath of tracked) {
    const newPath = moved.get(oldPath) ?? oldPath
    const text = readFileSync(join(root, oldPath), 'utf8')
    const r = rewrite(text, oldPath, newPath, moved, exists)
    if (r.changed) { edits += r.changed; files++; writes.push([newPath, r.text]) }
    else if (newPath !== oldPath) writes.push([newPath, text])
  }
  console.log(`${moved.size} files move; ${edits} specifiers change in ${files} files`)
  if (dry) process.exit(0)
  for (const [from, to] of moved) {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    execFileSync('git', ['mv', from, to], { cwd: root })
  }
  for (const [path, text] of writes) writeFileSync(join(root, path), text)
  // A moved file's repo path written out in full (the owner allowlists, the topology map, the ratchet lists, docs and comments) follows it. Exact paths only.
  const textFiles = execFileSync('git', ['ls-files', '*.ts', '*.md', '*.mmd', '*.json', '*.yml', '*.html'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  let pathEdits = 0
  for (const f of textFiles) {
    const file = join(root, f)
    if (!existsSync(file)) continue
    let text = readFileSync(file, 'utf8'), next = text
    for (const [from, to] of moved) next = next.replace(new RegExp(`(?<![\\w/.-])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), () => { pathEdits++; return to })
    if (next !== text) writeFileSync(file, next)
  }
  console.log(`${pathEdits} full-path mentions updated (allowlists, topology map, docs)`)
  // The topology docs are generated from the import graph (a test compares them with a fresh generation).
  execFileSync('bun', ['scripts/gen-topology.ts'], { cwd: root, stdio: 'ignore' })
  console.log('topology docs regenerated')
  // What a rewrite cannot see.
  const names = [...moved.keys()].map(p => p.split('/').pop()!.replace(/\.ts$/, ''))
  const hits = execFileSync('git', ['grep', '-nE', `import\\.meta\\.dir|__dirname|(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\.(ts|js)`, '--', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(l => l && !/^[^:]+\.ts:\d+:\s*(import |export .* from |\} from )/.test(l))
  console.log(`\nfor a person to read (path strings and prose a rewrite cannot see): ${hits.length} lines`)
  for (const l of hits.slice(0, 200)) console.log('  ' + l.slice(0, 180))
}
