// No new `await import(...)` in production code: a static import of a missing name fails at startup, a dynamic one only when its code path first runs (the
// access.json migration left `gateways/slack.ts` calling a removed store through one, and nothing flagged it). Each allowed import below breaks an import
// cycle, defers a heavy load, or probes a module on purpose; the list only shrinks. An entry that no longer matches is an error too: delete it.
//   bun scripts/check-dynamic-imports.ts
// Type queries (`typeof import('x')`, `x: import('net').Socket`) are types, not loads, and are not counted. Tests, test-setup.ts and scripts/ are out of scope.
// It reads tracked files, so a new file is checked once it is `git add`ed (CI always sees committed files). A string that contains `import(` still counts: rare, and the list absorbs it.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

/** `file -> specifier`, one entry per allowed dynamic import (a file that loads the same module twice lists it twice). */
export const ALLOWED: readonly string[] = [
  'daemon/boot-probe.ts -> ../infra/config.js',
  'daemon/boot-probe.ts -> ./sessions.js',
  'daemon/boot-probe.ts -> ./bridge-transport.js',
  'daemon/boot-probe.ts -> ./bridge-dispatch.js',
  'daemon/boot-probe.ts -> ./bridge-server.js',
  'daemon/boot-probe.ts -> ./session-lifecycle.js',
  'daemon/boot-probe.ts -> ./router.js',
  'gateways/slack.ts -> ../daemon/access.js',
  'gateways/slack.ts -> ../daemon/access.js',
  'gateways/slack.ts -> ../daemon/access.js',
  'gateways/slack.ts -> ../daemon/access.js',
  'infra/config.ts -> ../daemon/access.js',
  'infra/config.ts -> ../daemon/access.js',
  'infra/config.ts -> ../gateways/slack.js',
  'infra/config.ts -> ../gateways/discord.js',
]

// Bun's transpiler drops types and comments and keeps every runtime `import()`, so a type query is never mistaken for a load and a load is never missed by its spelling.
const transpiler = new Bun.Transpiler({ loader: 'ts' })

const skip = (path: string) => !path.endsWith('.ts') || path.endsWith('.d.ts') || path.endsWith('.test.ts') || /(^|\/)(__tests__|node_modules|docs)\//.test(path) || path === 'test-setup.ts' || path.startsWith('scripts/')

/** The dynamic imports that load something at run time, as `file -> specifier` (a computed specifier is `file -> <computed>`). */
export function found(files: Array<{ path: string; text: string }>): string[] {
  const out: string[] = []
  for (const { path, text } of files) {
    if (skip(path)) continue
    const code = transpiler.transformSync(text)
    for (const m of code.matchAll(/(?<![\w.$])import\(\s*([^)]*?)\s*\)/g)) {
      const lit = /^(['"`])([^'"`]*)\1$/.exec(m[1])
      out.push(`${path} -> ${lit ? lit[2] : '<computed>'}`)
    }
  }
  return out
}

const counts = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())

export function violations(files: Array<{ path: string; text: string }>, allowed: readonly string[] = ALLOWED): string[] {
  const have = counts(found(files))
  const want = counts(allowed)
  const out: string[] = []
  for (const [f, n] of have) if (n > (want.get(f) ?? 0)) out.push(`${f}: ${n - (want.get(f) ?? 0)} new dynamic import(s). Import it statically; if that makes an import cycle, break the cycle (or add it to ALLOWED in scripts/check-dynamic-imports.ts and say in the PR which cycle it breaks)`)
  for (const [f, n] of want) if (n > (have.get(f) ?? 0)) out.push(`${f}: ${n - (have.get(f) ?? 0)} allowed import(s) no longer in the code. Delete them from ALLOWED in scripts/check-dynamic-imports.ts`)
  return out
}

if (import.meta.main) {
  const cwd = join(fileURLToPath(import.meta.url), '..', '..')
  const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  const v = violations(paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') })))
  if (v.length) {
    for (const line of v) console.error(line)
    process.exit(1)
  }
}
