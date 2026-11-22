// The docs stay short: the code and tests are the spec, and prose is for setup, complex workflows and philosophy. A file over its cap
// is an error; trim it, or move the detail into a test, a comment in hydra.example.toml, or a message the code prints.
//   bun scripts/check-docs-size.ts

import { execFileSync } from 'child_process'
import { statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

/** Bytes. The README is the one-page overview; a guide under docs/ is a page or two. */
export const README_CAP = 8_000
export const DOC_CAP = 18_000

export const capOf = (path: string): number | undefined =>
  path === 'README.md' ? README_CAP : path === 'ACCESS.md' || /^docs\/[^/]+\.md$/.test(path) ? DOC_CAP : undefined

/** One line per file over its cap. */
export function oversize(files: ReadonlyArray<{ path: string; bytes: number }>): string[] {
  return files.flatMap(f => {
    const cap = capOf(f.path)
    return cap !== undefined && f.bytes > cap ? [`${f.path} is ${f.bytes} bytes, over its ${cap}: cut it (the code and tests are the spec)`] : []
  })
}

if (import.meta.main) {
  const cwd = join(fileURLToPath(import.meta.url), '..', '..')
  const paths = execFileSync('git', ['ls-files', '*.md'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  const v = oversize(paths.map(path => ({ path, bytes: statSync(join(cwd, path)).size })))
  if (v.length) { for (const line of v) console.error(line); process.exit(1) }
}
