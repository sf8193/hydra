import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'
import type { AnchorState } from './anchor-state.js'

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
  threadId: string
  createdAt: number
  lastActive: number
  tmuxName: string
  listening: boolean
  description?: string
  messageCount?: number
  claudeSessionId?: string
  originType?: 'spawn' | 'fork' | 'handoff' | 'resurrect'
  originFrom?: string
  capabilities?: SessionCapabilities
  worktreeRepo?: string
  worktreePath?: string
  isJoinMember?: boolean
  // Legacy fields — present on persisted data from pre-B3, ignored after migration.
  topic?: string
  anchorMessageId?: string
  respawnCount?: number
  threadUrl?: string
  status?: 'live' | 'dead' | 'killed'
}

export type ThreadMember = {
  sessionId: string
  role: 'owner' | 'member'
  label?: string        // feature-defined: 'critic', 'judge', etc.
  joinedAt: number
  leftAt?: number
}

export type SpawnResult = { name: string; sessionId: string; threadId: string; url: string }

export type SpawnOpts = {
  forkFrom?: { claudeSessionId: string; parentName: string }
  handedOffFrom?: string
  artifact?: string
  existingThreadId?: string
  resurrectFrom?: string
  resumeFrom?: string
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string  // override default prompt
  memberLabel?: string   // label for thread member (e.g. 'critic', 'judge')
}

// RecoveryManifest dissolved in B3 — threadRegistry.detachedThreads() IS the recovery manifest.

// ---------------------------------------------------------------------------
// Thread types — thread-primary foundation (B2)
// ---------------------------------------------------------------------------

export type ThreadSessionEntry = {
  sessionId: string
  tmuxName: string
  originType: 'spawn' | 'fork' | 'handoff' | 'resurrect'
  originFrom?: string
  startedAt: number
  endedAt?: number
  messageCount: number
  claudeSessionId?: string
}

export type ThreadInfo = {
  threadId: string
  anchorMessageId?: string
  threadUrl?: string
  topic: string
  description?: string
  anchorState: AnchorState | null
  respawnCount: number
  currentSessionId: string | null
  createdAt: number
  lastActive: number
  totalMessages: number
  sessionHistory: ThreadSessionEntry[]
  listenOverride?: boolean
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
// SessionRegistry — owns live sessions (thread lookup via threadRegistry)
// ---------------------------------------------------------------------------

export class SessionRegistry {
  readonly sessions = new Map<string, SessionInfo>()
  private readonly threadMembers = new Map<string, ThreadMember[]>() // in-memory only — not persisted across daemon restarts
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

  addMember(threadId: string, sessionId: string, label?: string): ThreadMember {
    const members = this.threadMembers.get(threadId) ?? []
    const member: ThreadMember = { sessionId, role: 'member', label, joinedAt: Date.now() }
    members.push(member)
    this.threadMembers.set(threadId, members)
    return member
  }

  removeMember(threadId: string, sessionId: string): void {
    const members = this.threadMembers.get(threadId)
    if (!members) return
    const member = members.find(m => m.sessionId === sessionId && !m.leftAt)
    if (member) member.leftAt = Date.now()
  }

  getMembers(threadId: string): ThreadMember[] {
    return (this.threadMembers.get(threadId) ?? []).filter(m => !m.leftAt)
  }

  getAllMembers(threadId: string): ThreadMember[] {
    return this.threadMembers.get(threadId) ?? []
  }

  isMember(sessionId: string): boolean {
    for (const members of this.threadMembers.values()) {
      if (members.some(m => m.sessionId === sessionId && !m.leftAt)) return true
    }
    return false
  }

  persist(): void {
    try {
      const data = [...this.sessions.values()]
      atomicWriteFileSync(this.sessionsFile, JSON.stringify(data, null, 2) + '\n')
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
    const thread = threadRegistry.get(channelId)
      ?? (existingThreadId ? threadRegistry.get(existingThreadId) : undefined)
    if (!thread?.currentSessionId) return null
    return this.sessions.get(thread.currentSessionId) ?? null
  }

  /** All sessions in the registry — after B3, these are all live by definition. */
  liveSessions(): SessionInfo[] {
    return [...this.sessions.values()]
  }

  private loadPersisted(): void {
    try {
      const raw = readFileSync(this.sessionsFile, 'utf8')
      const data = JSON.parse(raw) as SessionInfo[]
      let live = 0, skipped = 0
      for (const info of data) {
        if (info.status === 'killed' || info.status === 'dead') {
          skipped++
          continue
        }
        // Orphaned join members (review critics/judges) can't be re-associated
        // with their review state after restart — kill them immediately
        if (info.isJoinMember) {
          try { execSync(`tmux kill-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
          skipped++
          continue
        }
        let tmuxAlive = false
        try { execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}
        if (tmuxAlive) {
          this.sessions.set(info.sessionId, info)
          live++
        } else {
          skipped++
        }
      }
      if (live > 0 || skipped > 0) {
        process.stderr.write(`daemon: restored ${live} live session(s), skipped ${skipped} dead/stale\n`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load sessions: ${err}\n`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ThreadRegistry — thread-primary foundation (B2)
// ---------------------------------------------------------------------------

export class ThreadRegistry {
  readonly threads = new Map<string, ThreadInfo>()
  private readonly threadsFile: string

  constructor() {
    this.threadsFile = join(STATE_DIR, 'threads.json')
  }

  get(threadId: string): ThreadInfo | undefined {
    return this.threads.get(threadId)
  }

  has(threadId: string): boolean {
    return this.threads.has(threadId)
  }

  set(threadId: string, info: ThreadInfo): void {
    this.threads.set(threadId, info)
  }

  delete(threadId: string): void {
    this.threads.delete(threadId)
  }

  values(): IterableIterator<ThreadInfo> {
    return this.threads.values()
  }

  /** Crashed threads eligible for recovery (not intentionally killed) */
  detachedThreads(): ThreadInfo[] {
    return [...this.threads.values()].filter(t => t.currentSessionId === null && t.anchorState === 'crashed')
  }

  /** All threads with no current session (killed + crashed) */
  allDetachedThreads(): ThreadInfo[] {
    return [...this.threads.values()].filter(t => t.currentSessionId === null)
  }

  /** Threads with a live session */
  activeThreads(): ThreadInfo[] {
    return [...this.threads.values()].filter(t => t.currentSessionId !== null)
  }

  persist(): void {
    try {
      const data = [...this.threads.values()]
      atomicWriteFileSync(this.threadsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist threads: ${err}\n`)
    }
  }

  loadPersisted(): void {
    try {
      const raw = readFileSync(this.threadsFile, 'utf8')
      const data = JSON.parse(raw) as ThreadInfo[]
      for (const info of data) {
        this.threads.set(info.threadId, info)
      }
      if (data.length > 0) {
        process.stderr.write(`daemon: restored ${data.length} thread(s)\n`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load threads: ${err}\n`)
      }
    }
  }

  /** Boot: load persisted threads, migrate from sessions if first run, reconcile orphans */
  boot(sessionRegistry: SessionRegistry): void {
    this.loadPersisted()
    if (this.threads.size === 0 && sessionRegistry.size > 0) {
      this.migrateFromSessions(sessionRegistry)
    }

    // Reconcile: create ThreadInfo for sessions that aren't in any thread
    // (e.g. spawned between a persist and a crash)
    let orphans = 0
    for (const session of sessionRegistry.values()) {
      if (session.isJoinMember) continue
      if (this.threads.has(session.threadId)) continue
      this.threads.set(session.threadId, {
        threadId: session.threadId,
        anchorMessageId: session.anchorMessageId,
        threadUrl: session.threadUrl,
        topic: session.topic,
        description: session.description,
        anchorState: 'live',
        respawnCount: session.respawnCount ?? 0,
        currentSessionId: session.sessionId,
        createdAt: session.createdAt,
        lastActive: session.lastActive,
        totalMessages: session.messageCount ?? 0,
        sessionHistory: [{
          sessionId: session.sessionId,
          tmuxName: session.tmuxName,
          originType: session.originType ?? 'spawn',
          originFrom: session.originFrom,
          startedAt: session.createdAt,
          messageCount: session.messageCount ?? 0,
          claudeSessionId: session.claudeSessionId,
        }],
      })
      orphans++
    }
    if (orphans > 0) {
      process.stderr.write(`daemon: reconciled ${orphans} orphaned session(s) into threads\n`)
      this.persist()
    }
  }

  private migrateFromSessions(sessionRegistry: SessionRegistry): void {
    const sorted = [...sessionRegistry.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const session of sorted) {
      const existing = this.threads.get(session.threadId)
      if (existing) {
        existing.sessionHistory.push({
          sessionId: session.sessionId,
          tmuxName: session.tmuxName,
          originType: session.originType ?? 'spawn',
          originFrom: session.originFrom,
          startedAt: session.createdAt,
          endedAt: session.status === 'dead' || session.status === 'killed' ? session.lastActive : undefined,
          messageCount: session.messageCount ?? 0,
          claudeSessionId: session.claudeSessionId,
        })
        if (session.status !== 'dead' && session.status !== 'killed') {
          existing.currentSessionId = session.sessionId
        }
        existing.totalMessages += (session.messageCount ?? 0)
        if (session.lastActive > existing.lastActive) {
          existing.lastActive = session.lastActive
        }
        continue
      }

      const isLive = session.status !== 'dead' && session.status !== 'killed'
      const thread: ThreadInfo = {
        threadId: session.threadId,
        anchorMessageId: session.anchorMessageId,
        threadUrl: session.threadUrl,
        topic: session.topic,
        description: session.description,
        anchorState: isLive ? 'live' : session.status === 'dead' ? 'crashed' : 'killed',
        respawnCount: session.respawnCount ?? 0,
        currentSessionId: isLive ? session.sessionId : null,
        createdAt: session.createdAt,
        lastActive: session.lastActive,
        totalMessages: session.messageCount ?? 0,
        sessionHistory: [{
          sessionId: session.sessionId,
          tmuxName: session.tmuxName,
          originType: session.originType ?? 'spawn',
          originFrom: session.originFrom,
          startedAt: session.createdAt,
          endedAt: isLive ? undefined : session.lastActive,
          messageCount: session.messageCount ?? 0,
          claudeSessionId: session.claudeSessionId,
        }],
      }
      this.threads.set(session.threadId, thread)
    }

    if (this.threads.size > 0) {
      this.persist()
      process.stderr.write(`daemon: migrated ${this.threads.size} thread(s) from sessions\n`)
    }
  }
}

export const registry = new SessionRegistry()
export const threadRegistry = new ThreadRegistry()
