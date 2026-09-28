// One owner per dangerous question. CI fails when one of these primitives appears
// outside the files allowed to use it, so a new call site gets a reviewer's eyes
// instead of drifting in silently. Evidence (Sep 28, 2026): a 7th raw-tmux liveness
// gate slipped past three design rounds, and a new `tmux kill-server` addressed by
// TMUX_TMPDIR fell back to the real server and killed every live session.
//
// To add a file to an allowlist, you are claiming it owns that question — say why in
// the PR. Tests are exempt (they isolate via test-setup.ts).
//   bun scripts/check-owners.ts

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

type Rule = { name: string; match: (line: string) => boolean; allowed: string[]; why: string }

export const RULES: Rule[] = [
  {
    name: 'tmux kill-server without -S',
    match: l => l.includes('kill-server') && !l.includes("'-S'"),
    allowed: [],
    why: 'without -S, a missing TMUX_TMPDIR dir silently targets the real default server',
  },
  {
    name: 'git branch -D / worktree remove',
    match: l => /'branch',\s*'-D'/.test(l) || /'worktree',\s*'remove'/.test(l),
    allowed: ['daemon/worktree-manager.ts'],
    why: 'deleting work goes through workAtRisk in worktree-manager',
  },
  {
    name: 'raw tmuxHasSession( liveness',
    match: l => l.includes('tmuxHasSession(') && !l.includes('function tmuxHasSession'),
    // Existing owners. New code asks util.executionAlive / isAlive: for Codex, tmux is only an anchor.
    allowed: [
      'daemon.ts', 'daemon/util.ts', 'daemon/bridge-dispatch.ts', 'daemon/commands/thread.ts',
      'daemon/engines/claude-engine.ts', 'daemon/engines/codex-engine-adapter.ts', 'daemon/recovery.ts',
      'daemon/session-health.ts', 'daemon/session-lifecycle.ts',
    ],
    why: 'liveness is util.executionAlive / util.isAlive (the adapter decides)',
  },
  {
    name: "raw tmux 'has-session' / 'kill-session' exec",
    match: l => /['"]tmux['"]/.test(l) && /'(has-session|kill-session)'/.test(l),
    allowed: [
      'daemon/util.ts', 'cli/helpers.ts', 'daemon/bridge-server.ts', 'daemon/cli-handler.ts',
      'daemon/engines/claude-engine.ts', 'daemon/engines/codex-engine-adapter.ts', 'daemon/session-lifecycle.ts',
      'daemon/sessions.ts', 'scripts/check-codex-recovery.ts',
    ],
    why: 'use util.tmuxHasSession / the adapter\'s stop, not a new exec site',
  },
]

const exempt = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.ts$/.test(path) || path === 'test-setup.ts' || path === 'scripts/check-owners.ts'

export function violations(files: Array<{ path: string; text: string }>, rules = RULES): string[] {
  const out: string[] = []
  for (const { path, text } of files) {
    if (exempt(path)) continue
    text.split('\n').forEach((line, i) => {
      for (const r of rules) {
        if (r.match(line) && !r.allowed.includes(path)) out.push(`${path}:${i + 1}: ${r.name} — ${r.why}\n    ${line.trim()}`)
      }
    })
  }
  return out
}

if (import.meta.main) {
  const paths = execFileSync('git', ['ls-files', '*.ts'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const found = violations(paths.map(path => ({ path, text: readFileSync(path, 'utf8') })))
  if (found.length) {
    console.error(`check-owners: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
  console.log(`check-owners: ok (${paths.length} files, ${RULES.length} rules)`)
}
