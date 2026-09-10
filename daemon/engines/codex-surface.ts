import type { SessionInfo } from '../sessions.js'
import { homedir } from 'os'
import { join } from 'path'
import { codexSocketPath } from '../codex-engine.js'
const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

type CodexSurfaceIo = {
  isConnected: (sessionId: string) => boolean
  hasSession: (name: string) => boolean
  tmux: (args: string[]) => string
}

/** Keep the daemon-owned Codex engine and its replaceable tmux UI separate. */
export function ensureCodexInteractiveSurface(info: SessionInfo, io: CodexSurfaceIo): boolean {
  if (!info.codexThreadId) return false
  try {
    // A remote Codex TUI can take its tmux session down when the attached turn
    // finishes even though the daemon-owned app-server and socket remain live.
    // Recreate a durable container around that live engine instead of treating
    // the missing presentation layer as a dead agent.
    if (!io.hasSession(info.tmuxName)) {
      if (!io.isConnected(info.sessionId)) return false
      try {
        io.tmux([
          'new-session', '-d', '-s', info.tmuxName, '-n', 'hydra-anchor',
          'while :; do sleep 3600; done',
        ])
        process.stderr.write(`daemon: codex provider recreated tmux container for ${info.tmuxName}\n`)
      } catch (err) {
        // Another concurrent health/key path may have won the repair race.
        if (!io.hasSession(info.tmuxName)) throw err
      }
    }
    const windows = io.tmux(['list-windows', '-t', info.tmuxName, '-F', '#{window_name}'])
    if (windows.split('\n').includes('hydra-chat')) return true
    const homeName = info.codexHomeName ?? info.tmuxName
    const codexHome = join(homedir(), '.codex', `hydra-${homeName}`)
    const socket = codexSocketPath(homeName)
    const command = `export CODEX_HOME=${shq(codexHome)} && codex resume ${shq(info.codexThreadId)} --remote ${shq(`unix://${socket}`)}`
    io.tmux(['new-window', '-d', '-n', 'hydra-chat', '-t', info.tmuxName, command])
    process.stderr.write(`daemon: codex provider recreated TUI for ${info.tmuxName}\n`)
    return true
  } catch (err) {
    process.stderr.write(`daemon: codex provider could not ensure TUI for ${info.tmuxName}: ${err}\n`)
    return false
  }
}

