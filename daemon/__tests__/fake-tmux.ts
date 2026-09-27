// PATH-shim fake tmux + temp CLAUDE_CONFIG_DIR, so tests drive the REAL
// discoverClaudeSessionId / tmuxHasSession / killSession without mock.module
// and without touching the developer's tmux server or ~/.claude.
//
// The shim's state lives in files in its directory:
//   alive-<name>  → `has-session -t <name>` succeeds
//   pid-<name>    → `list-panes -t <name>` prints this pane pid
//   pane-<name>   → `capture-pane -t <name>` prints this text
//   calls         → one line per tmux invocation (its argv)
// pgrep always finds nothing, so discovery's child-env fallback stays inert.

import * as childProcess from 'child_process'
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
  *) : ;;
esac
`

// cli/__tests__/peek.test.ts mock.module()s child_process for the whole
// process with an execFileSync that returns ''. When that leak is present,
// route it through the shim for the duration of the test, then put peek's
// default back.
const leaked = (childProcess.execFileSync as any).mock ? childProcess.execFileSync as any : null

export type FakeTmux = {
  dir: string
  claudeDir: string
  alive(name: string): void
  pid(name: string, pid: string): void
  pane(name: string, text: string): void
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

  if (leaked) {
    leaked.mockImplementation((cmd: string, args: string[] = []) => {
      const bin = Bun.which(cmd, { PATH: process.env.PATH }) ?? cmd
      const r = Bun.spawnSync([bin, ...args], { env: process.env as Record<string, string> })
      if (r.exitCode !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.exitCode}`)
      return r.stdout.toString()
    })
  }

  return {
    dir,
    claudeDir,
    alive: name => writeFileSync(join(dir, `alive-${name}`), ''),
    pid: (name, pid) => writeFileSync(join(dir, `pid-${name}`), pid + '\n'),
    pane: (name, text) => writeFileSync(join(dir, `pane-${name}`), text),
    calls: () => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : [],
    seedClaudeSession(pid, sessionId, cwd = '/tmp/hydra-t3-project') {
      mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
      writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ sessionId, cwd }))
      const projectDir = join(claudeDir, 'projects', projectDirName(cwd))
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), '')
    },
    restore() {
      if (leaked) leaked.mockImplementation(() => '')
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
