import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { STATE_DIR } from './config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionCapabilities = {
  role: 'main' | 'worker'
  tools: string[]
  model: string
  cwd: string
  platform: string
}

export type SessionInfo = {
  sessionId: string
  topic: string
  threadId: string
  anchorMessageId?: string
  createdAt: number
  lastActive: number
  tmuxName: string
  listening: boolean
  description?: string
  messageCount?: number
  claudeSessionId?: string
  originType?: 'spawn' | 'fork' | 'handoff'
  originFrom?: string
  capabilities?: SessionCapabilities
  respawnCount?: number
  threadUrl?: string
  worktreeRepo?: string
  worktreePath?: string
  isJoinMember?: boolean
}

export type SpawnResult = { name: string; sessionId: string; threadId: string; url: string }

export type SpawnOpts = {
  forkFrom?: { claudeSessionId: string; parentName: string }
  handedOffFrom?: string
  artifact?: string
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string  // override default prompt
}

// ---------------------------------------------------------------------------
// Session catalog
// ---------------------------------------------------------------------------

const SESSION_CATALOG: Array<{ name: string; emoji: string }> = [
  { name: 'spark', emoji: '⚡' },
  { name: 'pixel', emoji: '🟦' },
  { name: 'nova',  emoji: '💥' },
  { name: 'drift', emoji: '🌊' },
  { name: 'flint', emoji: '🪨' },
  { name: 'ember', emoji: '🔥' },
  { name: 'bloom', emoji: '🌸' },
  { name: 'atlas', emoji: '🗺️' },
  { name: 'qubit', emoji: '⚛️' },
  { name: 'prism', emoji: '🌈' },
  { name: 'orbit', emoji: '🪐' },
  { name: 'comet', emoji: '☄️' },
  { name: 'patch', emoji: '🩹' },
  { name: 'glyph', emoji: '🔣' },
  { name: 'pulse', emoji: '💓' },
  { name: 'scout', emoji: '🔭' },
  { name: 'cedar', emoji: '🪵' },
  { name: 'dusk',  emoji: '🌇' },
  { name: 'fern',  emoji: '🌿' },
  { name: 'haze',  emoji: '🌫️' },
  { name: 'jade',  emoji: '🐉' },
  { name: 'lark',  emoji: '🪶' },
  { name: 'moss',  emoji: '🪴' },
  { name: 'pine',  emoji: '🌲' },
  { name: 'reef',  emoji: '🪸' },
  { name: 'sage',  emoji: '🦉' },
  { name: 'tide',  emoji: '🌙' },
  { name: 'vale',  emoji: '🏞️' },
  { name: 'wren',  emoji: '🐦' },
  { name: 'zinc',  emoji: '🔧' },
  { name: 'bolt',  emoji: '🔩' },
  { name: 'crisp', emoji: '❄️' },
]

const SESSION_NAMES = SESSION_CATALOG.map(s => s.name)

export function sessionEmoji(name: string): string {
  return SESSION_CATALOG.find(s => s.name === name)?.emoji ?? '🔹'
}

// ---------------------------------------------------------------------------
// SessionRegistry — owns sessions + threadToSession Maps
// ---------------------------------------------------------------------------

export class SessionRegistry {
  readonly sessions = new Map<string, SessionInfo>()
  readonly threadToSession = new Map<string, string>()
  private readonly sessionsFile: string

  constructor() {
    this.sessionsFile = join(STATE_DIR, 'sessions.json')
    this.loadPersisted()
  }

  get size(): number { return this.sessions.size }

  get(id: string): SessionInfo | undefined { return this.sessions.get(id) }
  has(id: string): boolean { return this.sessions.has(id) }

  set(id: string, info: SessionInfo): void {
    this.sessions.set(id, info)
  }

  delete(id: string): void {
    this.sessions.delete(id)
  }

  values(): IterableIterator<SessionInfo> { return this.sessions.values() }

  getByThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId)
  }

  setThread(threadId: string, sessionId: string): void {
    this.threadToSession.set(threadId, sessionId)
  }

  deleteThread(threadId: string): void {
    this.threadToSession.delete(threadId)
  }

  persist(): void {
    try {
      const data = [...this.sessions.values()]
      writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
    }
  }

  pickSessionName(): string {
    const used = new Set([...this.sessions.values()].map(s => s.tmuxName))
    try {
      const tmuxOut = execSync('tmux ls -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' })
      for (const line of tmuxOut.split('\n')) {
        if (line.trim()) used.add(line.trim())
      }
    } catch {}
    for (const name of SESSION_NAMES) {
      if (!used.has(name)) return name
    }
    return `session-${randomBytes(3).toString('hex')}`
  }

  resolveThreadSession(channelId: string, existingThreadId?: string, isThread?: boolean): SessionInfo | null {
    if (isThread === false) return null
    const mappedSession = this.threadToSession.get(channelId)
      ?? (existingThreadId ? this.threadToSession.get(existingThreadId) : undefined)
    if (!mappedSession) return null
    return this.sessions.get(mappedSession) ?? null
  }

  private loadPersisted(): void {
    try {
      const raw = readFileSync(this.sessionsFile, 'utf8')
      const data = JSON.parse(raw) as SessionInfo[]
      let restored = 0
      let dead = 0
      for (const info of data) {
        try {
          execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
        } catch {
          dead++
          continue
        }
        // Orphaned join members (review critics/judges) can't be re-associated
        // with their review state after restart — kill them immediately
        if (info.isJoinMember) {
          try { execSync(`tmux kill-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
          dead++
          continue
        }
        this.sessions.set(info.sessionId, info)
        this.threadToSession.set(info.threadId, info.sessionId)
        restored++
      }
      if (restored > 0 || dead > 0) {
        process.stderr.write(`daemon: restored ${restored} session(s), pruned ${dead} dead\n`)
      }
      if (dead > 0) this.persist()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load sessions: ${err}\n`)
      }
    }
  }
}

export const registry = new SessionRegistry()
