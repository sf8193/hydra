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
  originType?: 'spawn' | 'fork' | 'handoff' | 'resurrect'
  originFrom?: string
  capabilities?: SessionCapabilities
  respawnCount?: number
  threadUrl?: string
  worktreeRepo?: string
  worktreePath?: string
  isJoinMember?: boolean
}

export type ThreadMember = {
  sessionId: string
  role: 'owner' | 'member'
  label?: string        // feature-defined: 'critic', 'judge', etc.
  joinedAt: number
  leftAt?: number
}

export type SpawnResult = { name: string; sessionId: string; threadId: string; url: string }

// ---------------------------------------------------------------------------
// Thread types — thread-primary foundation
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
  createdAt: number
  lastActive: number
  totalMessages: number
  sessionHistory: ThreadSessionEntry[]
  listRecordId?: string
}

export type SpawnOpts = {
  forkFrom?: { claudeSessionId: string; parentName: string }
  handedOffFrom?: string
  artifact?: string
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string  // override default prompt
  memberLabel?: string   // label for thread member (e.g. 'critic', 'judge')
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
// SessionRegistry — owns live sessions
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
    const sessionId = threadRegistry.getBoundSession(channelId)
      ?? (existingThreadId ? threadRegistry.getBoundSession(existingThreadId) : undefined)
    if (!sessionId) return null
    return this.sessions.get(sessionId) ?? null
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

// ---------------------------------------------------------------------------
// ThreadRegistry — thread-primary foundation
// ---------------------------------------------------------------------------

export class ThreadRegistry {
  readonly threads = new Map<string, ThreadInfo>()
  private readonly _bindings = new Map<string, string>()
  private readonly threadsFile: string
  private readonly bindingsFile: string

  constructor() {
    this.threadsFile = join(STATE_DIR, 'threads.json')
    this.bindingsFile = join(STATE_DIR, 'bindings.json')
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

  get size(): number { return this.threads.size }

  // -- Bindings: the sole source of truth for thread→session routing ----------

  bind(threadId: string, sessionId: string): void {
    this._bindings.set(threadId, sessionId)
  }

  unbind(threadId: string): void {
    this._bindings.delete(threadId)
  }

  getBoundSession(threadId: string): string | undefined {
    return this._bindings.get(threadId)
  }

  isBound(threadId: string): boolean {
    return this._bindings.has(threadId)
  }

  /** Crashed threads eligible for recovery — unbound with crashed anchor */
  detachedThreads(): ThreadInfo[] {
    return [...this.threads.values()].filter(t => !this._bindings.has(t.threadId) && t.anchorState === 'crashed')
  }

  /** Threads with a live binding */
  activeThreads(): ThreadInfo[] {
    return [...this.threads.values()].filter(t => this._bindings.has(t.threadId))
  }

  persist(): void {
    try {
      const data = [...this.threads.values()]
      atomicWriteFileSync(this.threadsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist threads: ${err}\n`)
    }
    try {
      const bindings = Object.fromEntries(this._bindings)
      atomicWriteFileSync(this.bindingsFile, JSON.stringify(bindings, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist bindings: ${err}\n`)
    }
  }

  private loadPersisted(): void {
    try {
      const raw = readFileSync(this.threadsFile, 'utf8')
      const data = JSON.parse(raw) as (ThreadInfo & { currentSessionId?: string | null })[]
      for (const info of data) {
        // Migrate: if old-format ThreadInfo has currentSessionId, extract to bindings
        if (info.currentSessionId) {
          this._bindings.set(info.threadId, info.currentSessionId)
        }
        delete info.currentSessionId
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
    // Load bindings (overwrites any migrated from old-format threads above)
    try {
      const raw = readFileSync(this.bindingsFile, 'utf8')
      const data = JSON.parse(raw) as Record<string, string>
      for (const [threadId, sessionId] of Object.entries(data)) {
        this._bindings.set(threadId, sessionId)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load bindings: ${err}\n`)
      }
    }
  }

  private migrateFromSessions(sessionRegistry: SessionRegistry): void {
    const sorted = [...sessionRegistry.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const session of sorted) {
      if (session.isJoinMember) continue
      const existing = this.threads.get(session.threadId)
      if (existing) {
        existing.sessionHistory.push({
          sessionId: session.sessionId,
          tmuxName: session.tmuxName,
          originType: session.originType ?? 'spawn',
          originFrom: session.originFrom,
          startedAt: session.createdAt,
          messageCount: session.messageCount ?? 0,
          claudeSessionId: session.claudeSessionId,
        })
        this._bindings.set(session.threadId, session.sessionId)
        existing.totalMessages += (session.messageCount ?? 0)
        if (session.lastActive > existing.lastActive) {
          existing.lastActive = session.lastActive
        }
        continue
      }

      const thread: ThreadInfo = {
        threadId: session.threadId,
        anchorMessageId: session.anchorMessageId,
        threadUrl: session.threadUrl,
        topic: session.topic ?? '',
        description: session.description,
        anchorState: 'live',
        respawnCount: session.respawnCount ?? 0,
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
      }
      this.threads.set(session.threadId, thread)
      this._bindings.set(session.threadId, session.sessionId)
    }

    if (this.threads.size > 0) {
      this.persist()
      process.stderr.write(`daemon: migrated ${this.threads.size} thread(s) from sessions\n`)
    }
  }

  /** Boot: load persisted threads + bindings, migrate from sessions if first run, reconcile */
  boot(sessionRegistry: SessionRegistry): void {
    this.loadPersisted()
    if (this.threads.size === 0 && sessionRegistry.size > 0) {
      this.migrateFromSessions(sessionRegistry)
    }

    // Reconcile: create ThreadInfo for sessions missing from threads
    let orphans = 0
    for (const session of sessionRegistry.values()) {
      if (session.isJoinMember) continue
      if (this.threads.has(session.threadId)) continue
      this.threads.set(session.threadId, {
        threadId: session.threadId,
        anchorMessageId: session.anchorMessageId,
        threadUrl: session.threadUrl,
        topic: session.topic ?? '',
        description: session.description,
        anchorState: 'live',
        respawnCount: session.respawnCount ?? 0,
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
      this._bindings.set(session.threadId, session.sessionId)
      orphans++
    }

    // Detach bindings referencing sessions that no longer exist
    let detached = 0
    for (const [threadId, sessionId] of this._bindings) {
      if (!sessionRegistry.has(sessionId)) {
        this._bindings.delete(threadId)
        const thread = this.threads.get(threadId)
        if (thread) thread.anchorState = 'crashed'
        detached++
      }
    }

    if (orphans > 0 || detached > 0) {
      process.stderr.write(`daemon: thread reconcile: ${orphans} orphan(s), ${detached} detached\n`)
      this.persist()
    }
  }
}

export const threadRegistry = new ThreadRegistry()
