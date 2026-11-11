// One owner per dangerous primitive: CI fails when one appears outside the files allowed to
// use it (Sep 28, 2026: a raw `tmux kill-server` killed every live session). Lexical, not proof.
//   bun scripts/check-owners.ts
// Adding a file to an allowlist claims it owns that primitive — say why in the PR.
// Rule 2 names git's delete verbs only; rmSync of a worktree or `git update-ref -d` are not covered.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

type Rule = {
  name: string
  // Matched against the normalized text (see normalize): quotes/brackets/commas/parens are spaces,
  // `//` comments are gone, and consecutive lines are joined, so wrapped calls still match.
  pattern: RegExp
  allowed: string[]
  skipLine?: (normalizedLine: string) => boolean
  okAt?: (flat: string, index: number) => boolean   // a match that is fine in context
  tests: boolean   // does the rule also apply to test files?
  ts: boolean      // .ts only (true) or every scanned file type (false)
  why: string
}

export const RULES: Rule[] = [
  {
    name: 'tmux kill-server without -S',
    // Fine only if a -S sits between the nearest preceding tmux token (tmux, tmuxBin, …) and
    // kill-server — hydra has no semicolons, so "the same statement" means "this tmux call".
    pattern: /\bkill-server\b/g,
    okAt: (flat, i) => {
      const before = flat.slice(Math.max(0, i - 200), i)
      const calls = [...before.matchAll(/(?:^|\s)tmux\w*(?=\s)/g)]
      const call = calls.length ? before.slice(calls.at(-1)!.index!) : before.slice(-60)
      return /(?:^|\s)-S\s/.test(call)
    },
    allowed: [], tests: true, ts: false,
    why: 'address a server only by exact socket (-S): a missing TMUX_TMPDIR dir silently targets the real server',
  },
  {
    name: 'git branch delete / worktree remove|prune',
    pattern: /\bgit\b[^;]{0,60}?\b(?:branch\b[^;]{0,40}?(?:\s-[dD]|--delete)\b|worktree\s+(?:remove|prune)\b)/g,
    allowed: ['daemon/worktree-manager.ts'], tests: false, ts: false,
    why: 'deleting work goes through workAtRisk in worktree-manager',
  },
  {
    name: 'raw tmux liveness (tmuxHasSession, tmuxSessionState)',
    pattern: /\btmux(?:HasSession|SessionState)\b/g,
    skipLine: l => /^import\b/.test(l) || /\bfunction tmux(?:HasSession|SessionState)\b/.test(l),
    // Existing owners. New code asks occupancy() (session-reachability.ts): for Codex, tmux is only an anchor.
    // bridge-server, cli-handler and sessions ask tmux itself: a death check, `hydra status`'s tmux line, and
    // restoring records at load, before occupancy can be asked.
    allowed: [
      'daemon.ts', 'daemon/tmux.ts', 'daemon/bridge-dispatch.ts', 'daemon/commands/thread.ts',
      'daemon/engines/claude-engine.ts', 'daemon/engines/codex-engine-adapter.ts', 'daemon/recovery.ts',
      'daemon/session-lifecycle.ts', 'daemon/session-reachability.ts', 'daemon/bridge-server.ts', 'daemon/cli-handler.ts',
      'daemon/sessions.ts',
    ],
    tests: false, ts: true,
    why: 'liveness is occupancy() in session-reachability.ts (the adapter decides)',
  },
  {
    name: 'tmux has-session outside daemon/tmux.ts',
    pattern: /\bhas-session\b/g,
    // The daemon asks whether a session exists only through daemon/tmux.ts (tmuxSessionState and its readers),
    // so a slow tmux reads the same everywhere. The CLI files and the recovery script are their own processes.
    allowed: ['daemon/tmux.ts', 'cli/helpers.ts', 'scripts/check-codex-recovery.ts'],
    tests: false, ts: true,
    why: 'ask tmuxSessionState / tmuxHasSession (daemon/tmux.ts) or occupancy, not has-session',
  },
  {
    name: 'raw tmux kill-session|window|pane exec',
    pattern: /\btmux\b[^;]{0,40}?\b(?:kill-session|kill-window|kill-pane)\b/g,
    allowed: ['daemon/tmux.ts', 'cli/helpers.ts', 'cli/peek.ts', 'scripts/check-codex-recovery.ts'],
    tests: false, ts: true,
    why: "kill through tmuxSync or the adapter's stop, not another exec site",
  },
  {
    name: 'raw sync tmux exec',
    pattern: /\b(?:execFileSync|execSync|spawnSync)\s+tmux\b/g,
    // The daemon runs tmux synchronously only through tmuxSync (daemon/tmux.ts): killed at its timeout, so a hung
    // server can't hold the loop. Session creation has its own owner, spawn-env's tmuxNewSession, which bounds
    // itself. The CLI files and the recovery script are their own processes; test-setup kills the suite's server.
    allowed: [
      'daemon/tmux.ts', 'cli/helpers.ts', 'cli/peek.ts', 'cli/lifecycle.ts', 'cli/hydra.ts',
      'scripts/check-codex-recovery.ts', 'test-setup.ts',
    ],
    tests: false, ts: true,
    why: 'run tmux through tmuxSync in daemon/tmux.ts (bounded, SIGKILL), not a raw sync exec',
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
      const hits = [...flat.matchAll(r.pattern)].filter(m => !r.okAt?.(flat, m.index!)).map(m => lineAt(m.index!)).filter(n => !r.skipLine?.(lines[n - 1]))
      for (const n of new Set(hits)) out.push(`${path}:${n}: ${r.name} — ${r.why}\n    ${raw[n - 1]?.trim()}`)
    }
  }
  return out
}

if (import.meta.main) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '*.ts', '*.sh', '*.yml', '*.json'], { cwd, env, encoding: 'utf8' }).split('\n').filter(Boolean)
  const found = violations(paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') })))
  if (found.length) {
    console.error(`check-owners: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
}
