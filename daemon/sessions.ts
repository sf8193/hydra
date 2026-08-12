import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'

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
  anchorChannelId?: string
  createdAt: number
  lastActive: number
  tmuxName: string
  listening: boolean
  paused?: boolean
  description?: string
  contentEmoji?: string
  messageCount?: number
  claudeSessionId?: string
  originType?: 'spawn' | 'fork' | 'handoff' | 'resurrect'
  originFrom?: string
  initiator?: string
  capabilities?: SessionCapabilities
  respawnCount?: number
  resumeCount?: number
  threadUrl?: string
  lastReplyId?: string
  worktreeRepo?: string
  worktreePath?: string
  worktreeBranch?: string
  isJoinMember?: boolean
  deadAt?: number
  contextLinks?: string[]
  artifacts?: string[]   // deliverable URLs (PRs, Arti docs, Claude artifacts) the session emitted in its own replies
  artifactsBackfilled?: boolean  // one-time history scan done (skips the fetch on later restarts)
  ephemeral?: boolean
  headless?: boolean       // no Discord thread — worker communicates via send_to_thread
  allowMainTools?: boolean // template granted access to spawn_session/kill_session
  isFactoryBuilder?: boolean    // session is a factory builder — persisted for startup sweep
  suppressDeathMessage?: boolean // skip "died" notification to parent on kill
  factoryPmThreadId?: string   // PM's thread ID — for startup sweep notifications
  factoryTicket?: string       // factory ticket ID — for restart recovery info
  factoryPhase?: string        // last known factory phase — for restart recovery info
  budgetDeadline?: number  // epoch ms; phase-budget nudge fires here, reap at +grace (persisted so restarts re-arm)
  spawnAnnounceId?: string // message ID of the spawn announce line — edited on death to show completion
  spawnLogPath?: string    // black-box recorder: tmux pane output captured via `pipe-pane`, read on crash
  exitFilePath?: string    // exit marker file: exit code, wall clock, signal — written by spawn command on exit
  stderrLogPath?: string   // stderr redirect: separate file for spawn's stderr output
  debugLogPath?: string    // CC --debug-file output: internal diagnostics, written throughout session lifetime
  engine?: 'claude' | 'codex'  // which backend runs this session (default: claude)
  codexThreadId?: string       // persisted codex thread ID for resume on daemon restart
  turnState?: 'working' | 'idle' | 'waiting' // tmux-driven: working=activity, idle=silence, waiting=idle+last action was outbound reply
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
// Thread metadata — observational, not load-bearing for message routing
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
  model?: string
}

export type ThreadMetadata = {
  threadId: string
  anchorMessageId?: string
  anchorChannelId?: string
  threadUrl?: string
  topic: string
  description?: string
  respawnCount: number
  createdAt: number
  lastActive: number
  totalMessages: number
  sessionHistory: ThreadSessionEntry[]
  listenOverride?: boolean
  parentChannelId?: string
}

export type SpawnOpts = {
  forkFrom?: { claudeSessionId: string; parentName: string; codexThreadId?: string }
  handedOffFrom?: string
  artifact?: string
  existingThreadId?: string                                    // reuse an existing thread instead of creating a new one
  resumeFrom?: string                                          // claude session ID for --resume (no --fork-session)
  resurrectFrom?: string                                       // tmuxName of predecessor (for lineage in respawn)
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string
  promptPrefix?: string                                        // prepended to the generated prompt (used by templates)
  memberLabel?: string   // label for thread member (e.g. 'critic', 'judge')
  initiator?: string
  ephemeral?: boolean    // auto-kill on [done] sentinel, skip death visuals
  model?: string         // per-spawn model override (falls back to spawnModel() / HYDRA_MODEL)
  phaseBudgetMs?: number // max lifetime: nudge at T (write checkpoint), reap at T+grace
  trigger?: string       // what caused this spawn, for the announce line (e.g. 'spawn:', 'review 2:', 'CLI'); falls back to originType
  engine?: 'claude' | 'codex'  // which backend to use (default: claude)
  headless?: boolean     // skip Discord thread creation — worker communicates via send_to_thread
  disallowedTools?: string[]  // Claude built-in tools to block (e.g. ['Edit', 'Write'] for factory PM)
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
  allowMainTools?: boolean    // grant access to spawn_session/kill_session (from template)
  worktree?: string           // git repo subdirectory to create a worktree from (structural alternative to topic prefix)
  worktreeBranchSuffix?: string // appended to `wt/<name>` to avoid branch collisions between same-named builders
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

  getByThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId)
  }

  findByName(tmuxName: string): SessionInfo | undefined {
    for (const s of this.sessions.values()) {
      if (s.tmuxName === tmuxName) return s
    }
    return undefined
  }

  setThread(threadId: string, sessionId: string): void {
    this.threadToSession.set(threadId, sessionId)
  }

  deleteThread(threadId: string): void {
    this.threadToSession.delete(threadId)
  }

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

  onPersist: (() => void) | null = null
  private _debouncedTimer: ReturnType<typeof setTimeout> | null = null

  debouncedPersist(ms = 2000): void {
    if (this._debouncedTimer) return
    this._debouncedTimer = setTimeout(() => {
      this._debouncedTimer = null
      this.persist()
    }, ms)
  }

  persist(): void {
    try {
      const data = [...this.sessions.values()]
      atomicWriteFileSync(this.sessionsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
    }
    this.onPersist?.()
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

  resolveThreadId(msg: { channelId: string; effectiveThreadId: string | null }): string {
    return msg.effectiveThreadId ?? msg.channelId
  }

  resolveThreadSessionFromMsg(msg: { channelId: string; effectiveThreadId: string | null; isThread: boolean }): SessionInfo | null {
    if (!msg.isThread) return null
    const threadId = this.resolveThreadId(msg)
    const mappedSession = this.threadToSession.get(threadId)
    if (!mappedSession) return null
    return this.sessions.get(mappedSession) ?? null
  }

  /** @deprecated Use resolveThreadSessionFromMsg instead */
  resolveThreadSession(channelId: string, existingThreadId?: string | null, isThread?: boolean): SessionInfo | null {
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
      let pruned = 0
      for (const info of data) {
        // Orphaned join members can't be re-associated with their review state
        // after restart — kill them and discard
        if (info.isJoinMember) {
          try { execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) } catch {}
          pruned++
          continue
        }

        let tmuxAlive = false
        try {
          execFileSync('tmux', ['has-session', '-t', info.tmuxName], { stdio: 'pipe' })
          tmuxAlive = true
        } catch {}

        if (tmuxAlive) {
          delete info.deadAt
          restored++
        } else {
          info.deadAt = info.deadAt ?? Date.now()
          dead++
        }
        this.sessions.set(info.sessionId, info)
        this.threadToSession.set(info.threadId, info.sessionId)
      }
      if (restored > 0 || dead > 0 || pruned > 0) {
        process.stderr.write(`daemon: restored ${restored} session(s), marked ${dead} dead, pruned ${pruned}\n`)
      }
      this.persist()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`daemon: failed to load sessions: ${err}\n`)
      }
    }
  }
}

export const registry = new SessionRegistry()

// ---------------------------------------------------------------------------
// ThreadRegistry — lightweight thread metadata (not load-bearing for message routing)
// ---------------------------------------------------------------------------

export class ThreadRegistry {
  readonly threads = new Map<string, ThreadMetadata>()
  private readonly threadsFile: string

  constructor() {
    this.threadsFile = join(STATE_DIR, 'threads.json')
  }

  get(threadId: string): ThreadMetadata | undefined {
    return this.threads.get(threadId)
  }

  has(threadId: string): boolean {
    return this.threads.has(threadId)
  }

  set(threadId: string, info: ThreadMetadata): void {
    this.threads.set(threadId, info)
    this.persist()
  }

  delete(threadId: string): void {
    this.threads.delete(threadId)
    this.persist()
  }

  values(): IterableIterator<ThreadMetadata> {
    return this.threads.values()
  }

  get size(): number { return this.threads.size }

  recordSpawn(threadId: string, opts: {
    anchorMessageId?: string, anchorChannelId?: string, threadUrl?: string, topic: string,
    respawnCount: number, sessionId: string, tmuxName: string,
    originType: 'spawn' | 'fork' | 'handoff' | 'resurrect', originFrom?: string,
    model?: string, parentChannelId?: string, claudeSessionId?: string,
  }): void {
    const now = Date.now()
    let thread = this.threads.get(threadId)
    if (!thread) {
      thread = {
        threadId,
        anchorMessageId: opts.anchorMessageId,
        anchorChannelId: opts.anchorChannelId,
        threadUrl: opts.threadUrl,
        topic: opts.topic,
        respawnCount: opts.respawnCount,
        createdAt: now,
        lastActive: now,
        totalMessages: 0,
        sessionHistory: [],
        parentChannelId: opts.parentChannelId,
      }
      this.threads.set(threadId, thread)
    } else {
      thread.lastActive = now
      thread.threadUrl = opts.threadUrl || thread.threadUrl
      if (opts.anchorChannelId) thread.anchorChannelId = opts.anchorChannelId
      if (opts.respawnCount > 0) thread.respawnCount = opts.respawnCount
    }
    thread.sessionHistory.push({
      sessionId: opts.sessionId,
      tmuxName: opts.tmuxName,
      originType: opts.originType,
      originFrom: opts.originFrom,
      startedAt: now,
      messageCount: 0,
      model: opts.model,
      claudeSessionId: opts.claudeSessionId,
    })
    this.persist()
  }

  recordKill(threadId: string, sessionId: string, messageCount: number, claudeSessionId?: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const entry = thread.sessionHistory.find(h => h.sessionId === sessionId && !h.endedAt)
    if (entry) {
      entry.endedAt = Date.now()
      entry.messageCount = messageCount
      entry.claudeSessionId = claudeSessionId
    }
    this.persist()
  }

  persist(): void {
    try {
      const data = [...this.threads.values()]
      atomicWriteFileSync(this.threadsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist threads: ${err}\n`)
    }
  }

  boot(sessionRegistry: SessionRegistry): void {
    try {
      const raw = readFileSync(this.threadsFile, 'utf8')
      const data = JSON.parse(raw) as ThreadMetadata[]
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

    let created = 0
    for (const session of sessionRegistry.values()) {
      if (session.isJoinMember) continue
      if (this.threads.has(session.threadId)) continue
      this.threads.set(session.threadId, {
        threadId: session.threadId,
        anchorMessageId: session.anchorMessageId,
        anchorChannelId: session.anchorChannelId,
        parentChannelId: session.anchorChannelId,
        threadUrl: session.threadUrl,
        topic: session.topic ?? '',
        description: session.description,
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
      created++
    }

    // Backfill parentChannelId from anchorChannelId for threads missing it
    let backfilled = 0
    for (const thread of this.threads.values()) {
      if (!thread.parentChannelId && thread.anchorChannelId) {
        thread.parentChannelId = thread.anchorChannelId
        backfilled++
      }
    }

    if (created > 0 || backfilled > 0) {
      if (created > 0) process.stderr.write(`daemon: created ${created} thread(s) from sessions\n`)
      if (backfilled > 0) process.stderr.write(`daemon: backfilled parentChannelId on ${backfilled} thread(s)\n`)
      this.persist()
    }
  }
}

export const threadRegistry = new ThreadRegistry()
