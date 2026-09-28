// daemon/engines/claude-status.ts
//
// Claude Code writes <config>/sessions/<pid>.json per running process: live `status`
// (busy / idle / waiting), sessionId, and its tmux pane. Hydra's pane_pid is a wrapper
// shell, so match the file's `tmux` field ("<name>:@<window>.%<pane>"), and require the pid
// alive (kill -9 leaves the file). More than one live match is ambiguous: unknown.

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { claudeConfigDir } from '../../shared/constants.js'
import type { LiveState } from './engine-adapter.js'

// Claude's status vocabulary (busy = thinking, shell = a Bash tool is running); anything else is
// unknown, not a guess, and falls back to tmux.
export function liveStateOf(status: string): LiveState | null {
  return status === 'busy' || status === 'shell' ? 'working' : status === 'idle' ? 'idle' : status === 'waiting' ? 'blocked' : null
}

export type ClaudeLiveStatus = { sessionId: string; status: string }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

export function readClaudeStatus(tmuxName: string, dir: string = join(claudeConfigDir(), 'sessions')): ClaudeLiveStatus | null {
  const live: ClaudeLiveStatus[] = []
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let d: any
    try { d = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    if (typeof d?.tmux !== 'string' || d.tmux.split(':')[0] !== tmuxName) continue
    if (typeof d.sessionId !== 'string' || typeof d.status !== 'string') continue
    if (!Number.isInteger(d.pid) || !pidAlive(d.pid)) continue
    live.push({ sessionId: d.sessionId, status: d.status })
  }
  // Two live claudes under one tmux name (split pane, manual claude): can't tell which is ours.
  return live.length === 1 ? live[0] : null
}
