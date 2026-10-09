import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync, baseNameFromBranch } from './util.js'
import { CAPABILITY_TOOLS } from '../shared/constants.js'
import type { SessionType, Capability, ToolName, SessionLabel } from '../shared/constants.js'
import { recordPendingRetirement } from './retirement-journal.js'
import { classifyPersisted } from './engines/boot.js'
import type { EngineAdapter, ProviderId } from './engines/engine-adapter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionMetadata = {
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
  // The sessionId with authority over this one (kill, peek, private send, death notice).
  // null: no parent. undefined: a record from before parentId existed — see isParentOf.
  parentId?: string | null
  sessionMetadata?: SessionMetadata
  respawnCount?: number
  resumeCount?: number
  threadUrl?: string
  lastReplyId?: string
  worktreeRepo?: string
  worktreePath?: string
  worktreeBranch?: string
  handoffSelection?: { model: string; engine: ProviderId }  // set by `handoff <model>`, read by the handoff tool; dies with the record
  handoffNote?: string  // set by `handoff - <note>`: the requester's words, passed to the successor verbatim
  predecessor?: Predecessor  // set on a handoff successor: the session it took over from, still forkable after its kill
  launchCwd?: string          // a fork's launch dir (its source's); a resume must start there to find the transcript
  disallowedTools?: string[]  // Claude built-in tools blocked at spawn (read_only, factory PM); a resume re-applies them
  deadAt?: number
  contextLinks?: string[]
  artifacts?: string[]   // deliverable URLs (PRs, Arti docs, Claude artifacts) the session emitted in its own replies
  artifactsBackfilled?: boolean  // one-time history scan done (skips the fetch on later restarts)
  ephemeral?: boolean
  forceWorktreeCleanup?: boolean  // see SpawnOpts
  headless?: boolean       // no Discord thread — worker communicates via send_to_thread
  answerOnce?: boolean     // a headless fork: ended once its first result is delivered
  suppressDeathMessage?: boolean // skip "died" notification to parent on kill
  factoryPmThreadId?: string   // PM's thread ID — for startup sweep notifications
  factoryTicket?: string       // factory ticket ID — for restart recovery info
  factoryPhase?: string        // last known factory phase — for restart recovery info
  suppressAutoRecover?: boolean // skip the automatic boot recovery batch (e.g. awaiting_pm factory builder preserved for PM peek/kill); manual `recover` still works
  budgetDeadline?: number  // epoch ms; phase-budget nudge fires here, reap at +grace (persisted so restarts re-arm)
  spawnAnnounceId?: string // message ID of the spawn announce line — edited on death to show completion
  spawnLogPath?: string    // black-box recorder: tmux pane output captured via `pipe-pane`, read on crash
  exitFilePath?: string    // exit marker file: exit code, wall clock, signal — written by spawn command on exit
  stderrLogPath?: string   // stderr redirect: separate file for spawn's stderr output
  debugLogPath?: string    // CC --debug-file output: internal diagnostics, written throughout session lifetime
  engine: ProviderId  // which backend runs this session
  adapter: EngineAdapter // runtime instance, not persisted — reattached on load
  codexThreadId?: string       // persisted codex thread ID for resume on daemon restart
  codexHomeName?: string       // CODEX_HOME identity; differs from tmuxName after auto-resume
  ownershipGeneration?: string // immutable lifecycle owner; prevents stale cleanup from targeting successors
  contextUsage?: { usedTokens: number; contextWindow: number; percent: number; updatedAt: number }
  sessionType: SessionType
  label?: SessionLabel
  capabilities?: Capability[]
  // Keys are subsystem-owned: factory owns 'factory_done', protocol owns 'advance'/'extend_phase'.
  // clearFactoryIdentity and clearProtocolOverrides are the canonical cleanup paths.
  toolDescriptions?: Partial<Record<ToolName, string>>
  toolInputSchemas?: Partial<Record<ToolName, object>>
}

export function addCapability(info: SessionInfo, cap: Capability): void {
  const caps = new Set(info.capabilities ?? [])
  caps.add(cap)
  info.capabilities = [...caps]
}

export function removeCapability(info: SessionInfo, cap: Capability): void {
  const caps = new Set(info.capabilities ?? [])
  caps.delete(cap)
  info.capabilities = caps.size > 0 ? [...caps] : undefined
}

export function setToolDescription(info: SessionInfo, name: ToolName, description: string): void {
  info.toolDescriptions = { ...(info.toolDescriptions ?? {}), [name]: description }
}

export function removeToolDescriptions(info: SessionInfo, ...names: ToolName[]): void {
  if (!info.toolDescriptions) return
  for (const name of names) delete info.toolDescriptions[name]
  if (Object.keys(info.toolDescriptions).length === 0) delete info.toolDescriptions
}

export function setToolInputSchema(info: SessionInfo, name: ToolName, schema: object): void {
  info.toolInputSchemas = { ...(info.toolInputSchemas ?? {}), [name]: schema }
}

export function removeToolInputSchemas(info: SessionInfo, ...names: ToolName[]): void {
  if (!info.toolInputSchemas) return
  for (const name of names) delete info.toolInputSchemas[name]
  if (Object.keys(info.toolInputSchemas).length === 0) delete info.toolInputSchemas
}

/**
 * Authority (kill, peek, private send, death notice) belongs to the spawner, held by
 * sessionId so a recycled name can't inherit it. It passes along a handoff or a recovery,
 * since those are the same session continuing (see repointChildren); lineage alone
 * (originFrom) never confers it, except a human `fork`, which answers to its source.
 */
export function isParentOf(parent: Pick<SessionInfo, 'sessionId' | 'tmuxName' | 'createdAt'>, child: Pick<SessionInfo, 'parentId' | 'initiator' | 'originType' | 'originFrom' | 'createdAt'>): boolean {
  if (child.parentId !== undefined) return child.parentId !== null && child.parentId === parent.sessionId
  // Legacy record (no parentId): match by name, guarded against a recycled name.
  const name = child.initiator ?? (child.originType === 'fork' ? child.originFrom : undefined)
  return !!name && parent.tmuxName === name && parent.createdAt <= child.createdAt
}

/** The record holding authority over info, if any (for the death notice). */
export function parentSessionOf(info: SessionInfo): SessionInfo | undefined {
  if (info.parentId) return registry.get(info.parentId)
  if (info.parentId === null) return undefined
  return [...registry.values()].find(s => s.sessionId !== info.sessionId && isParentOf(s, info))
}

/** The parentId a successor of info inherits: its own, or a legacy record's name-matched parent; null if none. */
export function authorityId(info: SessionInfo): string | null {
  if (info.parentId !== undefined) return info.parentId
  return parentSessionOf(info)?.sessionId ?? null
}

/**
 * A handoff or recovery replaced oldId with newId: the same session, continuing. Its
 * children answer to the new record. Legacy children matched by name are upgraded.
 */
export function repointChildren(old: Pick<SessionInfo, 'sessionId' | 'tmuxName' | 'createdAt'>, newId: string): number {
  let n = 0
  for (const s of registry.values()) {
    if (s.sessionId === newId || s.sessionId === old.sessionId) continue
    if (s.parentId === old.sessionId || (s.parentId === undefined && isParentOf(old, s))) {
      s.parentId = newId
      n++
    }
  }
  if (n > 0) registry.persist()
  return n
}

export function ensureSessionType(info: SessionInfo): void {
  if (!info.sessionType) {
    info.sessionType = 'thread_owner'
  }
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
  engine?: ProviderId
  codexThreadId?: string
  codexHomeName?: string
  model?: string
  label?: SessionLabel
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

// The session a handoff successor took over from, snapshotted before its kill: the
// engine that ran it, its native fork ids, the directory it worked in, and its model.
export type Predecessor = { engine: ProviderId; fork: NonNullable<SpawnOpts['forkFrom']>; cwd: string; model?: string }

export type SpawnOpts = {
  forkFrom?: { claudeSessionId?: string; parentName: string; codexThreadId?: string; codexHomeName?: string }
  handedOffFrom?: string
  handoffFromClaudeSessionId?: string  // predecessor's Claude session id (undefined for Codex), for the arriving template's {{from_session}} and {{from_transcript}}
  predecessor?: Predecessor            // handoff: persisted on the successor's record so it can fork the session it replaced
  artifact?: string
  handoffNote?: string                 // the requester's `handoff - <note>`, for the successor's prompt and {{note}}
  existingThreadId?: string                                    // reuse an existing thread instead of creating a new one
  resumeFrom?: string                                          // claude session ID for --resume (no --fork-session)
  resumeCodex?: { threadId: string; homeName: string }          // Codex thread + original CODEX_HOME identity
  resurrectFrom?: string                                       // tmuxName of predecessor (for lineage in respawn)
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string
  beforeInitialTurn?: (sessionId: string) => void                 // register dynamic capabilities before Codex snapshots MCP tools
  quiet?: boolean                                                // suppress spawn announcements (private protocol helpers)
  promptPrefix?: string                                        // prepended to the generated prompt (used by templates)
  memberLabel?: string   // label for thread member (e.g. 'critic', 'judge')
  initiator?: string
  parentId?: string                    // the spawner's sessionId: authority over the new session (see isParentOf)
  label?: SessionLabel  // what the session is for, for cost grouping
  inheritedLabel?: SessionLabel  // bucket handed down by a parent or dead predecessor; loses to `label` and to a flag on the topic
  ephemeral?: boolean    // auto-kill on [done] sentinel, skip death visuals
  forceWorktreeCleanup?: boolean  // remove worktrees on kill even with uncommitted/unpushed work (caller opt-in, e.g. a review-only cron)
  model?: string         // per-spawn model override (falls back to spawnModel() / HYDRA_MODEL)
  phaseBudgetMs?: number // max lifetime: nudge at T (write checkpoint), reap at T+grace
  trigger?: string       // what caused this spawn, for the announce line (e.g. 'spawn:', 'review 2:', 'CLI'); falls back to originType
  engine?: ProviderId  // which backend to use (default: claude)
  headless?: boolean     // skip Discord thread creation — worker communicates via send_to_thread
  answerOnce?: boolean   // end the session once its first result is delivered (headless forks)
  disallowedTools?: string[]  // Claude built-in tools to block (e.g. ['Edit', 'Write'] for factory PM)
  launchCwd?: string          // fork: launch from the source's launch dir, where --resume finds its transcript (no worktree)
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
  sessionType?: SessionType  // declared at spawn — determines base tool set
  worktree?: string           // git repo subdirectory to create a worktree from (structural alternative to topic prefix)
  worktreeBranchSuffix?: string // appended to `wt/<name>` to avoid branch collisions between same-named builders
  preserveWorktree?: boolean  // recovery: reuse the dead session's on-disk worktree instead of destroying+recreating it (keeps unpushed work + lets --resume find the transcript)
  reuseWorktree?: { repo: string; path: string; branch: string }  // recovery: explicit worktree to adopt in place — survives even after the dead record it came from is deleted (resume-fail fallback tiers)
  carryOver?: { artifacts?: string[]; contextLinks?: string[]; description?: string; predecessor?: Predecessor; launchCwd?: string; disallowedTools?: string[]; parentId?: string | null; initiator?: string }  // recovery: deliverables/description (and a handoff successor's predecessor, a fork's launch dir and blocked tools) to re-apply — carried explicitly so fallback tiers keep them after the dead record is gone
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

export const SESSION_NAMES = SESSION_CATALOG.map(s => s.name)

export function sessionEmoji(name: string): string {
  return SESSION_CATALOG.find(s => s.name === name)?.emoji ?? '🔹'
}

// ---------------------------------------------------------------------------
// SessionRegistry — owns sessions + threadToSession Maps
// ---------------------------------------------------------------------------

export class SessionRegistry {
  readonly sessions = new Map<string, SessionInfo>()
  readonly threadToSession = new Map<string, string>()
  readonly reservedNames = new Set<string>() // in-flight session names pickSessionName must avoid (recovery kill→persist window); in-memory only
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
      const data = [...this.sessions.values()].map(({ adapter, ...rest }) => rest)
      atomicWriteFileSync(this.sessionsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
    }
    this.onPersist?.()
  }

  pickSessionName(): string {
    const used = new Set([...this.sessions.values()].map(s => s.tmuxName))
    // Also reserve names still referenced by a record's worktree branch (`wt/<name>`).
    // A recovered session keeps its predecessor's branch (its tmuxName differs), so the
    // old name looks free — but handing it to a new spawn would make createWorktree's
    // stale-cleanup `git branch -D wt/<name>` destroy that preserved branch and any
    // unpushed commits on it.
    for (const s of this.sessions.values()) {
      if (s.worktreeBranch?.startsWith('wt/')) used.add(baseNameFromBranch(s.worktreeBranch))
      // A resumed Codex session keeps its predecessor's CODEX_HOME; a new spawn named
      // after that home would restart the owner's app-server.
      if (s.codexHomeName) used.add(s.codexHomeName)
    }
    // In-flight reservations cover the recovery window between deleting a dead record and
    // persisting its replacement, when the record-based reservation above doesn't yet apply.
    for (const n of this.reservedNames) used.add(n)
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
        // Migrate renamed fields from pre-rename persisted sessions
        const raw = info as any
        if (raw.capabilities && !Array.isArray(raw.capabilities) && !raw.sessionMetadata) {
          raw.sessionMetadata = raw.capabilities
          delete raw.capabilities
        }
        if (raw.sessionMeta && !raw.sessionMetadata) {
          raw.sessionMetadata = raw.sessionMeta
          delete raw.sessionMeta
        }
        if (raw.activeCapabilities && !raw.capabilities) {
          raw.capabilities = raw.activeCapabilities
          delete raw.activeCapabilities
        }
        if (raw.toolDescriptionOverrides && !raw.toolDescriptions) {
          raw.toolDescriptions = raw.toolDescriptionOverrides
          delete raw.toolDescriptionOverrides
        }

        // Backfill explicit engine for pre-adapter sessions
        if (!raw.engine) raw.engine = 'claude'

        // Migrate legacy booleans → new identity fields
        if (raw.allowMainTools && !raw.sessionType) {
          raw.sessionType = 'master_orchestrator'
        }
        if (raw.isJoinMember && !raw.sessionType) {
          raw.sessionType = 'thread_guest'
        }
        if ((raw.factorySupervised || raw.supervised || raw.isFactoryBuilder) && !raw.sessionType) {
          raw.sessionType = 'factory_builder'
        }
        delete raw.allowMainTools
        delete raw.isJoinMember
        delete raw.isFactoryBuilder
        delete raw.factorySupervised
        delete raw.supervised
        delete raw.turnState // retired: derived live from the provider now (session-activity.ts)

        // Strip invalid capabilities from intermediate persisted states
        if (info.capabilities) {
          const valid = new Set<string>(Object.keys(CAPABILITY_TOOLS))
          info.capabilities = info.capabilities.filter(c => valid.has(c)) as Capability[]
          if (info.capabilities.length === 0) delete info.capabilities
        }

        // Derive sessionType early — needed for the guest check below
        ensureSessionType(info)

        // Orphaned guests can't be re-associated with their review state
        // after restart — kill them and discard
        if (info.sessionType === 'thread_guest') {
          try { execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) } catch {}
          pruned++
          continue
        }

        let tmuxAlive = false
        try {
          execFileSync('tmux', ['has-session', '-t', info.tmuxName], { stdio: 'pipe' })
          tmuxAlive = true
        } catch {}

        if (classifyPersisted(info, tmuxAlive) === 'live') {
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

/**
 * Reattach engine adapter instances to all loaded sessions.
 * Call once after both registry and engine singletons are initialized.
 */
export function reattachAdapters(resolve: (provider: ProviderId) => EngineAdapter): void {
  let count = 0
  for (const info of registry.values()) {
    info.adapter = resolve(info.engine ?? 'claude')
    count++
  }
  if (count > 0) process.stderr.write(`daemon: reattached adapters on ${count} session(s)\n`)
}

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
    label: SessionLabel | undefined,
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
      label: opts.label,
    })
    this.persist()
  }

  // The durable record a later resume reads; killSession drops the registry entry.
  closeHistoryEntry(threadId: string, info: { sessionId: string; messageCount?: number; claudeSessionId?: string; engine?: string; codexThreadId?: string; codexHomeName?: string; label?: SessionLabel }): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const entry = thread.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
    if (entry) {
      entry.endedAt = Date.now()
      entry.messageCount = info.messageCount ?? 0
      if (info.claudeSessionId) entry.claudeSessionId = info.claudeSessionId
      if (info.engine) entry.engine = info.engine as any
      if (info.codexThreadId) entry.codexThreadId = info.codexThreadId
      if (info.codexHomeName) entry.codexHomeName = info.codexHomeName
      if (info.label) entry.label = info.label
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
      if (session.sessionType === 'thread_guest') continue
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

// ---------------------------------------------------------------------------
// send_to_thread target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a session name to the session that should receive the message.
 *
 * A session name identifies a seat in a thread, not an immortal process. When
 * the named session is gone but its thread has a new occupant, that occupant is
 * who the sender meant — so deliver there and say so, rather than failing with
 * "no session named" and leaving the sender to rediscover names by hand.
 *
 * A killed session is removed from the registry outright, so its thread comes
 * from threadRegistry's session history; the registry's own `deadAt` entries
 * (sessions whose tmux vanished across a daemon restart) are checked first.
 *
 * Lives here rather than in the tools layer because it is registry traversal —
 * the same walk over sessions and thread history the registries themselves do.
 * Both registries are injectable so callers can test the walk without state.
 */
export function resolveSendTarget(
  targetName: string,
  reg: Pick<SessionRegistry, 'values' | 'get' | 'getByThread'> = registry,
  threads: Pick<ThreadRegistry, 'threads'> = threadRegistry,
): { session: SessionInfo; replaced?: string } | undefined {
  const live = [...reg.values()].find(s => s.tmuxName === targetName && !s.deadAt)
  if (live) return { session: live }

  // Session names are recycled, so one name can appear in several threads'
  // history. Rank candidate threads by when the name last sat there and take
  // the most recent — that occupancy is the one the sender is thinking of.
  const lastSeen = new Map<string, number>()
  const note = (threadId: string, at: number) => {
    lastSeen.set(threadId, Math.max(lastSeen.get(threadId) ?? 0, at))
  }
  for (const s of reg.values()) {
    if (s.tmuxName === targetName && s.deadAt) note(s.threadId, s.deadAt)
  }
  for (const thread of threads.threads.values()) {
    for (const h of thread.sessionHistory) {
      if (h.tmuxName === targetName) note(thread.threadId, h.endedAt ?? h.startedAt)
    }
  }

  const ranked = [...lastSeen.entries()].sort((a, b) => b[1] - a[1])
  for (const [threadId] of ranked) {
    const successorId = reg.getByThread(threadId)
    const successor = successorId ? reg.get(successorId) : undefined
    if (successor && !successor.deadAt && successor.tmuxName !== targetName) {
      return { session: successor, replaced: targetName }
    }
  }
  return undefined
}
