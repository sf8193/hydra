// Production file-size ratchet (#893): no production .ts file may exceed MAX_LINES.
// Today's oversized files are pinned in ALLOWED to their current line count and the list only shrinks:
// - growing past the cap (or past MAX_LINES for an unlisted file) fails CI,
// - dropping to <= MAX_LINES fails until the entry is deleted from ALLOWED,
// - shrinking by >= TIGHTEN_STEP lines below the cap fails until the cap is lowered.
//   bun scripts/check-file-size.ts
//   bun scripts/check-file-size.ts --list

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

export const MAX_LINES = 800
export const TIGHTEN_STEP = 50

/** Existing oversized production files and their line-count ceilings (sorted descending). Only shrinks. */
export const ALLOWED: Readonly<Record<string, number>> = {
  'connectors/slack/watch.ts': 1993,
  'config/load.ts': 1293,
  'app/router.ts': 1188,
  'connectors/slack/listener.ts': 1064,
  'gateways/slack.ts': 1034,
  'connectors/slack/runtime.ts': 1007,
  'app/bridge-dispatch.ts': 982,
  'engines/codex-engine.ts': 980,
  'connectors/github/pr-watch.ts': 960,
  'app/pane-probe.ts': 939,
  'sessions/registry.ts': 936,
  'connectors/clock/jobs-clock.ts': 923,
  'gateways/discord.ts': 870,
  'cli/lifecycle.ts': 869,
}

const skip = (p: string) =>
  !p.endsWith('.ts')
  || p.endsWith('.d.ts')
  || p.endsWith('.test.ts')
  || /(^|\/)(__tests__|node_modules|docs|scripts|mods\.local|mod)\//.test(p)
  || p === 'test-setup.ts'

export function lineCount(text: string): number {
  if (!text) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export function violations(
  files: Array<{ path: string; text: string }>,
  allowed: Readonly<Record<string, number>> = ALLOWED,
  maxLines = MAX_LINES,
  tightenStep = TIGHTEN_STEP,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const { path, text } of files) {
    if (skip(path)) continue
    seen.add(path)
    const count = lineCount(text)
    const cap = allowed[path]
    if (cap !== undefined) {
      if (count > cap) {
        out.push(`${path}: ${count} lines (cap ${cap}) — split by verb instead of growing an oversized file (#893)`)
      } else if (count <= maxLines) {
        out.push(`${path}: ${count} lines (<= ${maxLines}) — delete this entry from ALLOWED in scripts/check-file-size.ts`)
      } else if (cap - count >= tightenStep) {
        out.push(`${path}: ${count} lines (cap is ${cap}) — lower the cap in scripts/check-file-size.ts to ${count}`)
      }
      continue
    }
    if (count > maxLines) {
      out.push(`${path}: ${count} lines (max ${maxLines}) — split into smaller cohesive modules (#893)`)
    }
  }
  for (const path of Object.keys(allowed)) {
    if (!seen.has(path)) {
      out.push(`${path}: file no longer exists — delete this entry from ALLOWED in scripts/check-file-size.ts`)
    }
  }
  return out
}

if (import.meta.main) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, env, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') }))
  if (process.argv.includes('--list')) {
    const oversized = files
      .filter(f => !skip(f.path))
      .map(f => ({ path: f.path, n: lineCount(f.text) }))
      .filter(f => f.n > MAX_LINES)
      .sort((a, b) => b.n - a.n)
    for (const { path, n } of oversized) console.log(`  '${path}': ${n},`)
    process.exit(0)
  }
  const found = violations(files)
  if (found.length) {
    console.error(`check-file-size: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
}
