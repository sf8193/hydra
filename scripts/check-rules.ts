// One checker, one table of rules. Each rule is a pattern that breaks a named principle, the folders whose job it is to
// match it, today's hits (ALLOWED, a list that only shrinks) and the fix. A new hit fails, and so does an ALLOWED entry
// that no longer matches (delete it). Lexical, not proof: the check is the backstop, the structure is the answer.
//   bun scripts/check-rules.ts            check
//   bun scripts/check-rules.ts --list     print today's hits in ALLOWED's format, per rule
//
// An ALLOWED entry is `<file name>: <the code that matched>`, with no folder, so moving a file keeps its entries; renaming
// it, or editing the matched code, means updating them (--list prints the new form). An entry may repeat, once per hit.
// Scope: production .ts files. Tests, test-setup.ts, scripts/ and the mods are out; so are each rule's owner folders.
// check-owners (one owner file per dangerous primitive) is the other rule table; its rules can become rows here.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'

export type Rule = {
  id: string
  /** The principle the rule enforces, by its one-line name. */
  principle: string
  pattern: RegExp
  /** Folders where matching is the job (the gateway naming its platform), so never a hit. */
  owners: string[]
  allowed: readonly string[]
  fix: string
}

/**
 * A comparison of `<…subject>` (or `(<…subject> ?? 'default')`) with one of `names`, either side, or a `case` label naming one.
 * A case label counts whatever the switch is on: a switch over these names is the branch. Not seen: `.includes(subject)`, a
 * name in a template literal, a variable whose name does not end in the subject.
 */
const nameBranch = (subject: string, names: string[]) => {
  const s = String.raw`(?:\(\s*[\w$.?!]*${subject}\s*\?\?\s*['"]\w+['"]\s*\)|[\w$.?!]*${subject}\b)`
  const n = String.raw`['"](?:${names.join('|')})['"]`
  return new RegExp(String.raw`${s}\s*[!=]==?\s*${n}|${n}\s*[!=]==?\s*${s}|\bcase\s+${n}\s*:`, 'gi')
}

const CAPABILITIES_NOT_NAMES = 'capabilities, not names'

export const RULES: readonly Rule[] = [
  {
    id: 'platform-name-branch',
    principle: CAPABILITIES_NOT_NAMES,
    pattern: nameBranch('platform', ['discord', 'slack']),
    // gateways/ is where a platform's behaviour lives. A place's platform is data, and routing/ and connectors/ match on it to
    // decide where a message goes. config/ parses hydra.toml, whose keys are per platform. cli/ is the operator's own
    // process, which names the daemon it talks to.
    owners: ['gateways/', 'connectors/', 'routing/', 'config/', 'cli/'],
    allowed: [
      "bridge-dispatch.ts: gateway.platform === 'slack'",
      "bridge-server.ts: PLATFORM !== 'slack'",
      "bridge.ts: platform === 'discord'",
      "config.ts: PLATFORM === 'slack'",
      "config.ts: PLATFORM === 'slack'",
      "dashboard.ts: PLATFORM !== 'slack'",
      "link-previews.ts: platform === 'discord'",
      "link-previews.ts: platform === 'slack'",
      "link-previews.ts: platform === 'slack'",
      "link-previews.ts: platform === 'slack'",
      "link-previews.ts: platform === 'slack'",
      "typed-delivery.ts: platform === 'slack'",
      "usage-alerts.ts: io.platform === 'discord'",
    ],
    fix: 'give the gateway a capability (a field or method on ChatGateway, gateways/gateway.ts) and branch on that',
  },
  {
    id: 'engine-name-branch',
    principle: CAPABILITIES_NOT_NAMES,
    pattern: nameBranch('engine', ['claude', 'codex', 'agy', 'omp']),
    // engines/ is where an engine's behaviour lives; config/ and cli/ as for platform-name-branch.
    owners: ['engines/', 'config/', 'cli/'],
    allowed: [
      "auto-handoff.ts: info.engine !== 'claude'",
      "bridge-server.ts: (info.engine ?? 'claude') === 'claude'",
      "bridge-server.ts: info?.engine === 'claude'",
      "reply-guard.ts: (info.engine ?? 'claude') === 'claude'",
      "session-health.ts: info.engine !== 'codex'",
      "session-lifecycle.ts: (info.engine ?? 'claude') === 'claude'",
      "session-lifecycle.ts: carriedPredecessor?.engine === 'claude'",
      "session-lifecycle.ts: engine === 'agy'",
      "session-lifecycle.ts: engine === 'claude'",
      "session-lifecycle.ts: engine === 'codex'",
      "tool-surface.ts: info.engine !== 'claude'",
      "typed-delivery.ts: info.engine === 'claude'",
    ],
    fix: 'give the engine a capability (a field or method on EngineAdapter, engines/engine-adapter.ts) and branch on that',
  },
]

const inScope = (path: string) => path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts')
  && !/(^|\/)(__tests__|node_modules|scripts|mods\.local|mod)\//.test(path) && path !== 'test-setup.ts'

/** Comments blanked to spaces, so offsets (and line numbers) still match the source. */
const uncomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))

export type Hit = { rule: Rule; path: string; line: number; entry: string }

export function hits(files: Array<{ path: string; text: string }>, rules: readonly Rule[] = RULES): Hit[] {
  const out: Hit[] = []
  for (const { path, text } of files) {
    if (!inScope(path)) continue
    const code = uncomment(text)
    for (const rule of rules) {
      if (rule.owners.some(o => path.startsWith(o))) continue
      for (const m of code.matchAll(rule.pattern)) {
        out.push({ rule, path, line: code.slice(0, m.index).split('\n').length, entry: `${basename(path)}: ${m[0].replace(/\s+/g, ' ')}` })
      }
    }
  }
  return out
}

const counts = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())

export function violations(files: Array<{ path: string; text: string }>, rules: readonly Rule[] = RULES): string[] {
  const out: string[] = []
  const found = hits(files, rules)
  for (const rule of rules) {
    const mine = found.filter(h => h.rule === rule)
    const have = counts(mine.map(h => h.entry)), want = counts(rule.allowed)
    for (const [entry, n] of have) {
      const allowed = want.get(entry) ?? 0
      if (n <= allowed) continue
      const at = mine.filter(h => h.entry === entry).map(h => `${h.path}:${h.line}`).join(', ')
      const code = entry.slice(entry.indexOf(': ') + 2)
      out.push(allowed === 0
        ? `${at}: ${rule.id} (${rule.principle}): ${code}. To fix: ${rule.fix}. If it must stay, add ${JSON.stringify(entry)} to its ALLOWED in scripts/check-rules.ts and say why in the PR`
        : `${at}: ${rule.id} (${rule.principle}): ${code} appears ${n} times, ALLOWED has it ${allowed}; one of these is new. To fix: ${rule.fix}`)
    }
    for (const [entry, n] of want) if (n > (have.get(entry) ?? 0)) {
      out.push(`${rule.id}: ${JSON.stringify(entry)} is in ALLOWED ${n} time(s) but matches ${have.get(entry) ?? 0}. Delete the extra entry from scripts/check-rules.ts, or, if the file was renamed or the line edited, replace it with what bun scripts/check-rules.ts --list prints`)
    }
  }
  return out
}

if (import.meta.main) {
  const cwd = join(fileURLToPath(import.meta.url), '..', '..')
  const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') }))
  if (process.argv.includes('--list')) {
    const found = hits(files)
    for (const rule of RULES) {
      const mine = found.filter(h => h.rule === rule).map(h => h.entry).sort()
      console.log(`${rule.id} (${mine.length}):\n${mine.map(e => `      ${JSON.stringify(e)},`).join('\n')}`)
    }
    process.exit(0)
  }
  const v = violations(files)
  if (v.length) { for (const line of v) console.error(line); process.exit(1) }
}
