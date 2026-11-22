// In-memory fake tmux (via infra/tmux.ts _setTmuxForTesting) + temp CLAUDE_CONFIG_DIR,
// so tests drive the REAL discoverClaudeSessionId / tmuxHasSession / killSession without
// mock.module, without touching the developer's tmux server or ~/.claude, and without
// forking a `/bin/sh` shim on every tmux call.
//
// Pass `{ subprocess: true }` when a test spawns a child process that invokes `tmux` on PATH
// (e.g. `cli-attach.test.ts` spawning `cli/hydra.ts`); that mode writes the PATH shim too.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { projectDirName } from '../../infra/usage.js'
import { _setTmuxForTesting } from '../../infra/tmux.js'

const TMUX = `#!/bin/sh
D=$(dirname "$0")
echo "$*" >> "$D/calls"
if [ -f "$D/fail-$1" ]; then cat "$D/fail-$1" >&2; exit 1; fi
case "$1" in
  list-panes) cat "$D/pid-$3" 2>/dev/null ;;
  has-session) [ -f "$D/alive-\${3#=}" ] ;;
  capture-pane) cat "$D/pane-$3" 2>/dev/null ;;
  display|display-message) cat "$D/activity-$3" 2>/dev/null ;;
  *) : ;;
esac
`

export type FakeTmux = {
  dir: string
  claudeDir: string
  alive(name: string): void
  dead(name: string): void
  pid(name: string, pid: string): void
  pane(name: string, text: string): void
  activity(name: string, epochSec: number): void
  fail(subcommand: string, stderr?: string): void
  calls(): string[]
  /** Claude's sessions/<pid>.json plus the project .jsonl that discovery requires. */
  seedClaudeSession(pid: string, sessionId: string, cwd?: string): void
  restore(): void
}

export function withFakeTmux(opts?: { subprocess?: boolean }): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-faketmux-'))
  const claudeDir = join(dir, 'claude-config')
  const subprocess = opts?.subprocess ?? false
  if (subprocess) {
    writeFileSync(join(dir, 'tmux'), TMUX); chmodSync(join(dir, 'tmux'), 0o755)
  }

  const saved = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TMUX: process.env.TMUX }
  if (subprocess) process.env.PATH = `${dir}:${saved.PATH}`
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  delete process.env.TMUX

  const aliveSet = new Set<string>()
  const pids = new Map<string, string>()
  const panes = new Map<string, string>()
  const activities = new Map<string, number>()
  const failures = new Map<string, string>()
  const recorded: string[] = []

  const reject = (msg: string, stderr = ''): never => {
    throw Object.assign(new Error(msg), { status: 1, stderr })
  }

  _setTmuxForTesting({
    exec: ((_cmd: string, args: string[]) => {
      recorded.push(args.join(' '))
      const sub = args[0] ?? ''
      const target = args[2] ?? ''
      if (failures.has(sub)) {
        const stderr = failures.get(sub)!
        reject(stderr || `tmux ${sub} failed`, stderr)
      }
      switch (sub) {
        case 'list-panes': {
          const v = pids.get(target)
          if (v === undefined) reject('no pid')
          return v + '\n'
        }
        case 'has-session': {
          const name = target.replace(/^=/, '')
          if (!aliveSet.has(name)) reject("can't find session")
          return ''
        }
        case 'capture-pane': {
          const v = panes.get(target)
          if (v === undefined) reject('no pane')
          return v
        }
        case 'display':
        case 'display-message': {
          const v = activities.get(target)
          if (v === undefined) reject('no activity')
          return `${v}\n`
        }
        default:
          return ''
      }
    }) as any,
  })

  return {
    dir,
    claudeDir,
    alive: name => {
      aliveSet.add(name)
      if (subprocess) writeFileSync(join(dir, `alive-${name}`), '')
    },
    dead: name => {
      aliveSet.delete(name)
      if (subprocess) rmSync(join(dir, `alive-${name}`), { force: true })
    },
    pid: (name, pid) => {
      pids.set(name, pid)
      if (subprocess) writeFileSync(join(dir, `pid-${name}`), pid + '\n')
    },
    pane: (name, text) => {
      panes.set(name, text)
      if (subprocess) writeFileSync(join(dir, `pane-${name}`), text)
    },
    activity: (name, epochSec) => {
      activities.set(name, epochSec)
      if (subprocess) writeFileSync(join(dir, `activity-${name}`), `${epochSec}\n`)
    },
    fail: (subcommand, stderr = '') => {
      failures.set(subcommand, stderr)
      if (subprocess) writeFileSync(join(dir, `fail-${subcommand}`), stderr ? stderr + '\n' : '')
    },
    calls: () => {
      if (!subprocess) return [...recorded]
      // In subprocess mode, in-process calls precede subprocess calls (no caller interleaves ordering across processes).
      const fileCalls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []
      return [...recorded, ...fileCalls]
    },
    seedClaudeSession(pid, sessionId, cwd = '/tmp/hydra-t3-project') {
      mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
      writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ sessionId, cwd }))
      const projectDir = join(claudeDir, 'projects', projectDirName(cwd))
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), '')
    },
    restore() {
      _setTmuxForTesting()
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
