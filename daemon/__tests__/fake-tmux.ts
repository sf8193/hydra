// PATH-shim fake tmux + temp CLAUDE_CONFIG_DIR, so tests drive the REAL
// discoverClaudeSessionId / tmuxHasSession / killSession without mock.module
// and without touching the developer's tmux server or ~/.claude.
//
// The shim's state lives in files in its directory:
//   alive-<name>  → `has-session -t <name>` succeeds
//   pid-<name>    → `list-panes -t <name>` prints this pane pid
//   pane-<name>   → `capture-pane -t <name>` prints this text
//   activity-<name> → `display -t <name>` prints this (window_activity); absent → exit 1
//   calls         → one line per tmux invocation (its argv)
// pgrep always finds nothing, so discovery's child-env fallback stays inert.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { projectDirName } from '../usage.js'

const TMUX = `#!/bin/sh
D=$(dirname "$0")
echo "$*" >> "$D/calls"
case "$1" in
  list-panes) cat "$D/pid-$3" 2>/dev/null ;;
  has-session) [ -f "$D/alive-$3" ] ;;
  capture-pane) cat "$D/pane-$3" 2>/dev/null ;;
  display|display-message) cat "$D/activity-$3" 2>/dev/null ;;
  *) : ;;
esac
`

export type FakeTmux = {
  dir: string
  claudeDir: string
  alive(name: string): void
  pid(name: string, pid: string): void
  pane(name: string, text: string): void
  activity(name: string, epochSec: number): void
  calls(): string[]
  /** Claude's sessions/<pid>.json plus the project .jsonl that discovery requires. */
  seedClaudeSession(pid: string, sessionId: string, cwd?: string): void
  restore(): void
}

export function withFakeTmux(): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-faketmux-'))
  const claudeDir = join(dir, 'claude-config')
  writeFileSync(join(dir, 'tmux'), TMUX); chmodSync(join(dir, 'tmux'), 0o755)
  writeFileSync(join(dir, 'pgrep'), '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, 'pgrep'), 0o755)

  const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TMUX: process.env.TMUX }
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  delete process.env.TMUX

  return {
    dir,
    claudeDir,
    alive: name => writeFileSync(join(dir, `alive-${name}`), ''),
    pid: (name, pid) => writeFileSync(join(dir, `pid-${name}`), pid + '\n'),
    pane: (name, text) => writeFileSync(join(dir, `pane-${name}`), text),
    activity: (name, epochSec) => writeFileSync(join(dir, `activity-${name}`), `${epochSec}\n`),
    calls: () => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : [],
    seedClaudeSession(pid, sessionId, cwd = '/tmp/hydra-t3-project') {
      mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
      writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ sessionId, cwd }))
      const projectDir = join(claudeDir, 'projects', projectDirName(cwd))
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), '')
    },
    restore() {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
