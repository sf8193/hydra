import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { resolveSocket, sendRequest, shq, tmuxExists, tmuxKill } from './helpers.js'

type SessionEntry = {
  name: string
  description?: string
  status: string
  tmuxTarget?: string
}

const tmux = (cmd: string) => execSync(cmd, { stdio: 'pipe' })
const tmuxRead = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

async function getLiveSessions(socketPath: string): Promise<SessionEntry[]> {
  const response = await sendRequest(socketPath, {
    type: 'cli', command: 'list', id: randomUUID(), params: {},
  })
  if (!response.ok) return []
  const data = response.data as SessionEntry[]
  return data.filter(s => s.status === 'connected' || s.status === 'disconnected')
}

function attachSession(session: SessionEntry): void {
  if (!tmuxExists(session.name)) {
    console.error(`error: tmux session "${session.name}" not found`)
    process.exit(1)
  }
  const target = session.tmuxTarget ?? session.name
  try { tmux(`tmux select-window -t ${shq(target)}`) } catch {}
  console.log(`\x1b[2m(detach: ctrl+b d)\x1b[0m`)
  try {
    execSync(`tmux attach-session -t ${shq(session.name)}`, { stdio: 'inherit' })
  } catch {}
}

function buildPeekSession(sessions: SessionEntry[]): void {
  const peekName = 'hydra-peek'
  const p = shq(peekName)

  // Kill existing peek session
  tmuxKill(peekName)

  const windowName = (s: SessionEntry) => s.description ? `${s.name}: ${s.description}` : s.name

  // Create peek session and set window-size so linked windows expand to peek's terminal size
  tmux(`tmux new-session -d -s ${p}`)
  tmux(`tmux set-option -t ${p} window-size largest`)

  // Link each session's window, tracking which ones succeed and their tmux window index
  const linked: Array<{ session: SessionEntry; windowIndex: string }> = []
  for (const s of sessions) {
    if (!tmuxExists(s.name)) continue
    try {
      tmux(`tmux link-window -s ${shq(s.tmuxTarget ?? `${s.name}:0`)} -t ${p}`)
      const idx = tmuxRead(`tmux list-windows -t ${p} -F '#{window_index}' | tail -1`)
      linked.push({ session: s, windowIndex: idx })
    } catch {}
  }

  // Remove the empty initial window (only if we linked at least one)
  if (linked.length > 0) {
    try { tmux(`tmux kill-window -t ${p}:0`) } catch {}
  }

  if (linked.length === 0) {
    tmuxKill(peekName)
    console.log('no live tmux sessions to peek')
    process.exit(0)
  }

  // Rename windows using the tracked indices (avoids index/name mismatch)
  for (const { session, windowIndex } of linked) {
    try { tmux(`tmux rename-window -t ${p}:${windowIndex} ${shq(windowName(session))}`) } catch {}
  }

  tmux(`tmux set-option -t ${p} allow-rename off`)

  // Set window-size largest on source sessions so shared windows expand
  for (const { session } of linked) {
    try { tmux(`tmux set-option -t ${shq(session.name)} window-size largest`) } catch {}
  }

  // Custom status bar
  tmux(`tmux set-option -t ${p} status-style 'bg=colour235,fg=colour248'`)
  tmux(`tmux set-option -t ${p} status-left '#[fg=colour16,bg=colour214,bold] PEEK #[default] '`)
  tmux(`tmux set-option -t ${p} status-left-length 10`)
  tmux(`tmux set-option -t ${p} status-right ' #[fg=colour248]n/p:switch  w:list  d:exit '`)
  tmux(`tmux set-option -t ${p} status-right-length 30`)
  tmux(`tmux set-option -t ${p} window-status-format ' #[fg=colour248]#W '`)
  tmux(`tmux set-option -t ${p} window-status-current-format ' #[fg=colour214,bold]#W '`)

  // Select first window (most recently active)
  tmux(`tmux select-window -t ${p}:${linked[0].windowIndex}`)

  // Attach and open chooser (filtered to only peek windows)
  // Not using -r (read-only) because it blocks all keybindings including ctrl+b n/p navigation.
  // link-window shares the PTY, but Claude reads from the bridge socket not stdin, so input
  // from the peek client has no effect on agent behavior.
  console.log(`\x1b[2m(${linked.length} sessions · sorted by most recent)\x1b[0m`)
  try {
    execSync(`tmux attach-session -t ${p} \\; choose-tree -wf '#{==:#{session_name},hydra-peek}'`, { stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(`peek: attach failed: ${err instanceof Error ? err.message : String(err)}\n`)
  } finally {
    for (const { session } of linked) {
      try { tmux(`tmux set-option -u -t ${shq(session.name)} window-size`) } catch {}
    }
    tmuxKill(peekName)
  }
}

export async function peek(args: string[], daemonName?: string): Promise<void> {
  const socketPath = resolveSocket(daemonName)
  const sessions = await getLiveSessions(socketPath)

  if (sessions.length === 0) {
    console.log('no live sessions')
    process.exit(0)
  }

  // hydra peek <name> — attach to specific session
  if (args.length > 0) {
    const target = sessions.find(s => s.name === args[0])
    if (!target) {
      console.error(`error: no live session named "${args[0]}"`)
      console.error(`live: ${sessions.map(s => s.name).join(', ')}`)
      process.exit(1)
      return
    }
    attachSession(target)
    return
  }

  // hydra peek (no args) — single session: attach directly, multiple: chooser
  if (sessions.length === 1) {
    attachSession(sessions[0])
    return
  }

  buildPeekSession(sessions)
}
