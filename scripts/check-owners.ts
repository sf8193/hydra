// One owner per dangerous primitive: CI fails when one appears outside the files allowed to
// use it (Sep 28, 2026: a raw `tmux kill-server` killed every live session). Lexical, not proof.
//   bun scripts/check-owners.ts
// Adding a file to an allowlist claims it owns that primitive — say why in the PR.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

type Rule = {
  name: string
  // Matched against the normalized text (see normalize): quotes/brackets/commas/parens are spaces,
  // `//` comments are gone, and consecutive lines are joined, so wrapped calls still match.
  pattern: RegExp
  allowed: string[]
  skipLine?: (normalizedLine: string) => boolean
  tests: boolean   // does the rule also apply to test files?
  ts: boolean      // .ts only (true) or every scanned file type (false)
  why: string
}

export const RULES: Rule[] = [
  {
    name: 'tmux kill-server without -S',
    // kill-server with no `-S` earlier in the same statement.
    pattern: /(?<!-S [^;]{0,60})\bkill-server\b/g,
    allowed: [], tests: true, ts: false,
    why: 'address a server only by exact socket (-S): a missing TMUX_TMPDIR dir silently targets the real server',
  },
  {
    name: 'git branch delete / worktree remove|prune',
    pattern: /\bbranch\b[^;]{0,40}?(?:\s-[dD]|--delete)\b|\bworktree\s+(?:remove|prune)\b/g,
    allowed: ['daemon/worktree-manager.ts'], tests: false, ts: false,
    why: 'deleting work goes through workAtRisk in worktree-manager',
  },
  {
    name: 'raw tmuxHasSession liveness',
    pattern: /\btmuxHasSession\b/g,
    skipLine: l => /^import\b/.test(l) || /\bfunction tmuxHasSession\b/.test(l),
    // Existing owners. New code asks util.executionAlive / isAlive: for Codex, tmux is only an anchor.
    allowed: [
      'daemon.ts', 'daemon/util.ts', 'daemon/bridge-dispatch.ts', 'daemon/commands/thread.ts',
      'daemon/engines/claude-engine.ts', 'daemon/engines/codex-engine-adapter.ts', 'daemon/recovery.ts',
      'daemon/session-health.ts', 'daemon/session-lifecycle.ts',
    ],
    tests: false, ts: true,
    why: 'liveness is util.executionAlive / util.isAlive (the adapter decides)',
  },
  {
    name: 'raw tmux has-session / kill-session|window|pane exec',
    pattern: /\btmux\b[^;]{0,40}?\b(?:has-session|kill-session|kill-window|kill-pane)\b/g,
    allowed: [
      'daemon/util.ts', 'cli/helpers.ts', 'cli/peek.ts', 'daemon/bridge-server.ts', 'daemon/cli-handler.ts',
      'daemon/engines/claude-engine.ts', 'daemon/engines/codex-engine-adapter.ts', 'daemon/session-lifecycle.ts',
      'daemon/sessions.ts', 'scripts/check-codex-recovery.ts',
    ],
    tests: false, ts: true,
    why: "use util.tmuxHasSession / the adapter's stop, not a new exec site",
  },
]

const isTest = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.ts$/.test(path)

// One line per source line (so offsets map back), each with tokens separated by single spaces.
export function normalize(text: string): { flat: string; lines: string[]; lineAt: (offset: number) => number } {
  const lines = text.split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/['"`,()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim())
  const starts: number[] = []
  let flat = ''
  for (const l of lines) { starts.push(flat.length); flat += l + ' ' }
  return { flat, lines, lineAt: off => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= off) i++; return i + 1 } }
}

export function violations(files: Array<{ path: string; text: string }>): string[] {
  const out: string[] = []
  for (const { path, text } of files) {
    if (path === 'scripts/check-owners.ts' || path === 'daemon/__tests__/check-owners.test.ts') continue // its own fixtures
    const { flat, lines, lineAt } = normalize(text)
    const raw = text.split('\n')
    for (const r of RULES) {
      if (r.allowed.includes(path) || (!r.tests && isTest(path)) || (r.ts && !path.endsWith('.ts'))) continue
      const hits = [...flat.matchAll(r.pattern)].map(m => lineAt(m.index!)).filter(n => !r.skipLine?.(lines[n - 1]))
      for (const n of new Set(hits)) out.push(`${path}:${n}: ${r.name} — ${r.why}\n    ${raw[n - 1]?.trim()}`)
    }
  }
  return out
}

if (import.meta.main) {
  const paths = execFileSync('git', ['ls-files', '*.ts', '*.sh', '*.yml', '*.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const found = violations(paths.map(path => ({ path, text: readFileSync(path, 'utf8') })))
  if (found.length) {
    console.error(`check-owners: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
}
