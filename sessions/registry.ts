import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, STATE_WRITABLE } from '../infra/config.js'
import { emit } from '../infra/event-bus.js'
import { removeLaunchFiles } from '../infra/launch-files.js'
import type { LaunchPolicy } from '../shared/launch-policy.js'
import { atomicWriteFileSync, baseNameFromBranch } from '../infra/util.js'
import { tmuxSessionState, tmuxSync } from '../infra/tmux.js'
import { CAPABILITY_TOOLS, engineOfModel } from '../shared/constants.js'
import { SESSION_CATALOG, SESSION_NAMES } from '../shared/session-catalog.js'
import type { SessionType, Capability, ToolName, SessionLabel } from '../shared/constants.js'
import { classifyPersisted } from '../engines/boot.js'
import type { EngineAdapter, ProviderId } from '../engines/engine-adapter.js'

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
  // The sha256 of the token this launch was given (HYDRA_SESSION_TOKEN): a CLI caller that presents the token is this session (cli-caller.ts).
  // Absent on a session launched before tokens: its CLI calls are a session's that cannot show which.
  sessionTokenHash?: string
  // Set at spawn once bridge clients send HYDRA_SESSION_TOKEN on `register` (#844).
  // Absent on pre-deploy records whose running bridges predate token registration: missing tokens
  // stay accepted for those records until they end, while a wrong token is always refused.
  bridgeToken?: true
  // The sessionId with authority over this one (kill, peek, private send, death notice).
  // null: no parent. undefined: a record from before parentId existed — see isParentOf.
  parentId?: string | null
  sessionMetadata?: SessionMetadata
  respawnCount?: number
  resumeCount?: number
  threadUrl?: string
  lastReplyId?: string
  lastReplyAt?: number
  lastUserMessageAt?: number
  /** The git worktree the session works in: present whole or not at all (see SessionWorktree). */
  worktree?: SessionWorktree
  handoffSelection?: { model: string; engine: ProviderId }  // set by `handoff <model>`, read by the handoff tool; dies with the record
  handoffArtifact?: string  // the letter the latest handoff request asked for; lets the automatic retry see a newer request
  handoffNote?: { text: string; artifact: string }  // set by `handoff: <note>`: the requester's words, for the successor of that request's letter only
  predecessor?: Predecessor  // set on a handoff successor: the session it took over from, still forkable after its kill
  launchCwd?: string          // a fork's launch dir (its source's); a resume must start there to find the transcript
  disallowedTools?: string[]  // Claude built-in tools blocked at spawn (read_only); a resume re-applies them
  deadAt?: number
  contextLinks?: string[]
  artifacts?: string[]   // deliverable URLs (PRs, Arti docs, Claude artifacts) the session emitted in its own replies
  artifactsBackfilled?: boolean  // one-time history scan done (skips the fetch on later restarts)
  ephemeral?: boolean
  idleTtlMs?: number       // see SpawnOpts
  idleDeadline?: number    // epoch ms; idle-limit nudge fires here, reap at +grace (persisted so restarts re-arm with what was left)
  forceWorktreeCleanup?: boolean  // see SpawnOpts
  suppressDeathMessage?: boolean // skip "died" notification to parent on kill
  suppressAutoRecover?: boolean // skip the automatic boot recovery batch (e.g. a dead record whose worktree is gone); a manual `recover` asks again
  budgetDeadline?: number  // epoch ms; phase-budget nudge fires here, reap at +grace (persisted so restarts re-arm)
  spawnAnnounceId?: string // message ID of the spawn announce line — edited on death to show completion
  spawnLogPath?: string    // black-box recorder: tmux pane output captured via `pipe-pane`, read on crash
  exitFilePath?: string    // exit marker file: exit code, wall clock, signal — written by spawn command on exit
  stderrLogPath?: string   // stderr redirect: separate file for spawn's stderr output
  debugLogPath?: string    // CC --debug-file output: internal diagnostics, written throughout session lifetime
  spawnPrompt?: string     // first-turn prompt, kept until the first turn is known to have run (pane-probe resends it after a login-expired first turn)
  channelNote?: string     // LaunchResult.channelNote: appended to the bridgeless warnings (orphan, resume-without-bridge)
  engine: ProviderId  // which backend runs this session
  adapter: EngineAdapter // runtime instance, not persisted — reattached on load
  codexThreadId?: string       // persisted codex thread ID for resume on daemon restart
  codexHomeName?: string       // CODEX_HOME identity; differs from tmuxName after auto-resume
  contextUsage?: { usedTokens: number; contextWindow: number; percent: number; updatedAt: number }
  sessionType: SessionType
  /**
   * What a specialist's session may reach, decided once when it was born (restricted.ts): access and, for `workdir`, the one folder it
   * runs in, its tools and servers, with an id that changes when any of them does. `launch()` builds the folder, argv, env and files
   * from it; birth re-checks the folder; delivery compares it with hydra.toml. Absent: no specialist fills it.
   */
  policy?: LaunchPolicy
  /** The hash of the specialist's kickoff this conversation was born under (specialists.ts `kickoffHash`). Absent: born before it was stored, or not from a kickoff. */
  kickoffHash?: string
  /** A restricted or write-confined session's start was checked against its policy (engines/claude-verify.ts) and passed. Persisted. Without it such a session takes no message (restricted.ts `unverified`). */
  verified?: true
  label?: SessionLabel
  capabilities?: Capability[]
  // Keys are subsystem-owned: protocol owns 'advance'/'extend_phase'.
  // clearProtocolOverrides is the canonical cleanup path.
  toolDescriptions?: Partial<Record<ToolName, string>>
  toolInputSchemas?: Partial<Record<ToolName, object>>
}

/**
 * A session's own git worktree: the repository it was cut from, the folder, and the branch checked out there. The three are
 * known together or not at all: the branch is the one the worktree was created on, never derived from a session's name
 * (a revived session keeps its predecessor's branch under a new name).
 */
export type SessionWorktree = { repo: string; path: string; branch: string }

/** The fields a build before SessionWorktree stored. Written beside `worktree` for one release, so a rollback finds the worktree. */
type LegacyWorktreeFields = { worktreeRepo?: string; worktreePath?: string; worktreeBranch?: string }

/**
 * Load migration: a record a build before SessionWorktree wrote carries three loose fields. A record with repo and path and no
 * branch predates stored branches, when every worktree branch was `wt/<session name>`: that is filled in here, the one place a
 * branch is ever derived. Mutates the raw record; returns it.
 */
export function migrateWorktree<T extends LegacyWorktreeFields & { worktree?: SessionWorktree; tmuxName: string }>(raw: T): T {
  const { worktreeRepo: repo, worktreePath: path, worktreeBranch: branch } = raw
  if (!raw.worktree && repo && path) raw.worktree = { repo, path, branch: branch ?? `wt/${raw.tmuxName}` }
  delete raw.worktreeRepo
  delete raw.worktreePath
  delete raw.worktreeBranch
  return raw
}

/** The record as persisted: SessionWorktree, and the legacy fields beside it so a build from before it still finds the worktree. */
export function withLegacyWorktree<T extends { worktree?: SessionWorktree }>(rec: T): T & LegacyWorktreeFields {
  const w = rec.worktree
  return w ? { ...rec, worktreeRepo: w.repo, worktreePath: w.path, worktreeBranch: w.branch } : rec
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
  /** The engine that ran the session, written at spawn: every reader takes it from here and none infers it. */
  engine: ProviderId
  codexThreadId?: string
  codexHomeName?: string
  model?: string
  label?: SessionLabel
  /** The launch policy the session was born with: the only evidence left once a kill deletes the record (read by resolvePolicy through a revive). */
  policy?: LaunchPolicy
  /** The kickoff the conversation was born under: the evidence left once a kill deletes the record (read by reviveThread). */
  kickoffHash?: string
  /** Its specialist's kill_and_respawn replaced it with a fresh session: written before the kill, so no revive (a refill, `resume`, boot
   *  recovery, one after a daemon restart mid-swap) ever resumes or forks this conversation (read by reviveThread). */
  restartedFresh?: true
  /** The thread of the session that spawned this one (not its session id: a handoff keeps the thread). Lets that thread's sessions destroy this
   *  one's thread after it ends (read by endedDestroyRefusal). Absent on a record from before it was kept, or a spawn nobody made: refused as before. */
  spawnerThreadId?: string
  /** Hydra made the thread for this session, or for the session it continues: a resume, respawn, revive or handoff in the thread, or a
   *  spawn into it by the owner of its lineage. False for any other spawn into a thread that already existed (by main or the operator): the
   *  thread's lineage is not its. Who may destroy reads it (madeFor). Absent on an entry from before it was kept: the thread's own stands in. */
  hydraMade?: boolean
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
  /** Non-operators the operator has acknowledged in this thread: their messages reach the session here and nowhere else. */
  allowedSenders?: string[]
  parentChannelId?: string
  /** Hydra posted the anchor message and made the thread itself, so the anchor is hydra's to delete. Absent for a thread spawned into, or
   *  anchored on, someone's message or thread. Who may destroy reads each entry's own `hydraMade` (madeFor); this stands in for an old entry. */
  hydraMade?: boolean
}

// The session a handoff successor took over from, snapshotted before its kill: the
// engine that ran it, its native fork ids, the directory it worked in, and its model.
export type Predecessor = { engine: ProviderId; fork: NonNullable<SpawnOpts['forkFrom']>; cwd: string; model?: string }

export type SpawnOpts = {
  forkFrom?: { claudeSessionId?: string; parentName: string; codexThreadId?: string; codexHomeName?: string }
  handedOffFrom?: string
  reuseName?: string // recovery: keep the dead session's name if still free
  name?: string      // a caller-chosen session name (and tmux name): spawn fails if it is taken. Ignored by handoff, which keeps its predecessor's name
  handoffFromClaudeSessionId?: string  // predecessor's Claude session id (undefined for Codex), for the arriving template's {{from_session}} and {{from_transcript}}
  predecessor?: Predecessor            // handoff: persisted on the successor's record so it can fork the session it replaced
  artifact?: string
  handoffNote?: string                 // the requester's `handoff: <note>`, for the successor's prompt and {{note}}
  existingThreadId?: string                                    // reuse an existing thread instead of creating a new one
  resumeFrom?: string                                          // claude session ID for --resume (no --fork-session)
  resumeCodex?: { threadId: string; homeName: string }          // Codex thread + original CODEX_HOME identity
  resumeSession?: { fromSessionId: string }                     // omp, agy: the dead hydra session whose conversation continues
  resurrectFrom?: string                                       // tmuxName of predecessor (for lineage in respawn)
  joinThread?: string                                          // join existing thread as member (skip thread creation)
  promptBuilder?: (sessionId: string, tmuxName: string) => string
  beforeInitialTurn?: (sessionId: string) => void                 // register dynamic capabilities before Codex snapshots MCP tools
  quiet?: boolean                                                // suppress spawn announcements (private protocol helpers)
  promptPrefix?: string                                        // prepended to the generated prompt (used by templates)
  topicIsRequest?: boolean                                    // false when promptPrefix carries the <request> instead
  memberLabel?: string   // label for thread member (e.g. 'critic', 'judge')
  initiator?: string
  parentId?: string                    // the spawner's sessionId: authority over the new session (see isParentOf)
  askedBy?: string | null              // the session that asked for this spawn (null: one that could not show which); absent for main, the operator and hydra's own starts. A spawn into an ended thread is refused unless it owns that thread's lineage (lineage.ts)
  label?: SessionLabel  // what the session is for, for cost grouping
  inheritedLabel?: SessionLabel  // bucket handed down by a parent or dead predecessor; loses to `label` and to a flag on the topic
  ephemeral?: boolean    // auto-kill on [done] sentinel, skip death visuals
  idleTtlMs?: number     // ephemeral only: idle limit before the nudge-then-reap (default DEFAULT_IDLE_TTL_MS, 30m)
  forceWorktreeCleanup?: boolean  // remove worktrees on kill even with uncommitted/unpushed work (caller opt-in, e.g. a review-only cron)
  model?: string         // per-spawn model override (falls back to spawnModel() / HYDRA_MODEL)
  phaseBudgetMs?: number // max lifetime: nudge at T (write checkpoint), reap at T+grace
  trigger?: string       // what caused this spawn, for the announce line (e.g. 'spawn:', 'review 2:', 'CLI'); falls back to originType
  engine?: ProviderId  // which backend to use (default: claude)
  disallowedTools?: string[]  // Claude built-in tools to block (e.g. ['Edit', 'Write'])
  launchCwd?: string          // fork: launch from the source's launch dir, where --resume finds its transcript (no worktree)
  cwd?: string                // a fresh launch's working dir (a specialist's workdir) in place of SPAWN_CWD; a fork, resume or worktree wins
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
  sessionType?: SessionType  // declared at spawn — its role in its thread (a restricted specialist is a thread_owner whose policy says `restricted`)
  kickoffHash?: string        // a fresh start's prompt is the specialist's kickoff: the hash stored with the conversation it begins (a resume or fork keeps its own, through carryOver)
  specialist?: string        // the specialist a caller names as the one this session acts for (a fill, a conversation's own session); its launch policy is decided from hydra.toml at birth (restricted.ts)
  worktree?: string           // git repo subdirectory to create a worktree from (structural alternative to topic prefix)
  worktreeBranchSuffix?: string // appended to `wt/<name>` to avoid branch collisions between same-named builders
  preserveWorktree?: boolean  // recovery: reuse the dead session's on-disk worktree instead of destroying+recreating it (keeps unpushed work + lets --resume find the transcript)
  reuseWorktree?: SessionWorktree  // recovery: explicit worktree to adopt in place — survives even after the dead record it came from is deleted (resume-fail fallback tiers)
  carryOver?: { artifacts?: string[]; contextLinks?: string[]; description?: string; predecessor?: Predecessor; launchCwd?: string; disallowedTools?: string[]; parentId?: string | null; initiator?: string; policy?: LaunchPolicy; kickoffHash?: string; sessionName?: string }  // recovery: deliverables/description (and a handoff successor's predecessor, a fork's launch dir and blocked tools) to re-apply — carried explicitly so fallback tiers keep them after the dead record is gone
}

// ---------------------------------------------------------------------------
// Session catalog
// ---------------------------------------------------------------------------

// The catalog is in shared/ so the CLI (hydra migrate) can check names without importing the daemon.
export { SESSION_NAMES }

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

  /** Drop a URL from every session's artifact list (a merged or closed PR is no longer a deliverable); persists only when something changed. */
  dropArtifact(url: string): void {
    let changed = false
    for (const info of this.sessions.values()) {
      if (!info.artifacts?.includes(url)) continue
      info.artifacts = info.artifacts.filter(u => u !== url)
      changed = true
    }
    if (changed) this.persist()
  }

  persist(): void {
    try {
      const data = [...this.sessions.values()].map(({ adapter, ...rest }) => withLegacyWorktree(rest))
      atomicWriteFileSync(this.sessionsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
    }
    this.onPersist?.()
  }

  /** Every name something other than the record `replacing` holds: sessions, tmux, worktree branches, Codex homes, reservations. */
  private usedNames(replacing?: string, keep?: string, replaceable?: (s: SessionInfo) => boolean): Set<string> {
    const others = [...this.sessions.values()].filter(s => s.sessionId !== replacing && !replaceable?.(s))
    const used = new Set(others.map(s => s.tmuxName))
    // Also reserve names still referenced by a record's worktree branch (`wt/<name>`).
    // A recovered session keeps its predecessor's branch (its tmuxName differs), so the
    // old name looks free — but handing it to a new spawn would make createWorktree's
    // stale-cleanup `git branch -D wt/<name>` destroy that preserved branch and any
    // unpushed commits on it.
    for (const s of others) {
      if (s.worktree?.branch.startsWith('wt/')) used.add(baseNameFromBranch(s.worktree.branch))
      // A resumed Codex session keeps its predecessor's CODEX_HOME; a new spawn named
      // after that home would restart the owner's app-server.
      if (s.codexHomeName) used.add(s.codexHomeName)
    }
    // In-flight reservations cover the recovery window between deleting a dead record and
    // persisting its replacement, when the record-based reservation above doesn't yet apply.
    // The reuse name is reserved by recovery for this very spawn.
    for (const n of this.reservedNames) if (n !== keep) used.add(n)
    // During a hold tmux isn't asked and its names are missed: new-session on a taken name then fails cleanly, and the caller sees the error.
    try {
      const tmuxOut = tmuxSync(['ls', '-F', '#{session_name}'])
      for (const line of tmuxOut.split('\n')) {
        if (line.trim()) used.add(line.trim())
      }
    } catch {}
    return used
  }

  /**
   * The catalog name no live session holds that was used least recently: a name never used comes first (catalog order), then the name whose
   * last session ended longest ago (`lastUsed`, from the thread history, which the registry cannot see). `reuse`: a recovered session's old
   * name, kept unless something other than the record it replaces holds it. Only when every catalog name is held is the name `session-<hex>`.
   */
  pickSessionName(reuse?: { name: string; replacing: string }, lastUsed: ReadonlyMap<string, number> = new Map()): string {
    const used = this.usedNames(reuse?.replacing, reuse?.name)
    if (reuse && !used.has(reuse.name)) return reuse.name
    const free = SESSION_NAMES.filter(name => !used.has(name))
    // A stable sort: names with the same last use (or none) stay in catalog order.
    const next = free.sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))[0]
    if (next) return next
    process.stderr.write(`daemon: every session name is held by a live session; naming this one session-<hex>\n`)
    return `session-${randomBytes(3).toString('hex')}`
  }

  /**
   * A caller-chosen name (`SpawnOpts.name`): the name itself or an error, never a substitute. `replacing`: the record
   * this spawn takes over from. `replaceable`: other records of that name that do not count (a crashed predecessor
   * must not block its own successor).
   */
  claimSessionName(name: string, replacing?: string, replaceable?: (s: SessionInfo) => boolean): string {
    const sameName = replaceable && ((s: SessionInfo) => s.tmuxName === name && replaceable(s))
    if (this.usedNames(replacing, undefined, sameName).has(name)) throw new Error(`session name "${name}" is already in use`)
    return name
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
        const raw = info as unknown as Record<string, unknown>
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

        migrateWorktree(info)

        // Backfill explicit engine for pre-adapter sessions
        if (!raw.engine) raw.engine = 'claude'

        // Migrate legacy booleans → new identity fields
        if (raw.allowMainTools && !raw.sessionType) {
          raw.sessionType = 'master_orchestrator'
        }
        if (raw.isJoinMember && !raw.sessionType) {
          raw.sessionType = 'thread_guest'
        }
        // Factory is gone: its builders become plain workers, its bookkeeping fields are dropped.
        if (raw.sessionType === 'factory_builder') raw.sessionType = 'thread_owner'
        delete raw.factoryPmThreadId
        delete raw.factoryTicket
        delete raw.factoryPhase
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
          // Only the state's owner kills: a one-off script importing this module must not touch live sessions.
          if (STATE_WRITABLE) try { tmuxSync(['kill-session', '-t', info.tmuxName]) } catch {}
          pruned++
          continue
        }

        // One name runs one session: a record a later one took the name from is not what runs under it.
        const succeeded = data.some(o => o !== info && o.tmuxName === info.tmuxName && o.createdAt > info.createdAt)
        // A tmux that doesn't answer says nothing about the record: it keeps the state it was saved with.
        const state = succeeded ? 'dead' : tmuxSessionState(info.tmuxName)
        const tmuxAlive = state === 'alive' || (state === 'not responding' && !info.deadAt)

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

// The records an engine's start() receives at boot: those it is the adapter of.
export function engineRecords(adapter: EngineAdapter): SessionInfo[] {
  return [...registry.values()].filter(r => r.adapter === adapter)
}

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

  isSenderAllowed(threadId: string, senderId: string): boolean {
    return this.threads.get(threadId)?.allowedSenders?.includes(senderId) ?? false
  }

  allowSenders(threadId: string, senderIds: string[]): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    thread.allowedSenders = [...new Set([...(thread.allowedSenders ?? []), ...senderIds])]
    this.persist()
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

  /** When each session name was last used: the end of its latest session in the history, or, for an entry with no end recorded, its start. */
  lastUsedByName(): Map<string, number> {
    const last = new Map<string, number>()
    for (const thread of this.threads.values()) for (const h of thread.sessionHistory) last.set(h.tmuxName, Math.max(last.get(h.tmuxName) ?? 0, h.endedAt ?? h.startedAt))
    return last
  }

  recordSpawn(threadId: string, opts: {
    anchorMessageId?: string, anchorChannelId?: string, threadUrl?: string, topic: string,
    respawnCount: number, sessionId: string, tmuxName: string,
    originType: 'spawn' | 'fork' | 'handoff' | 'resurrect', originFrom?: string,
    model?: string, parentChannelId?: string, claudeSessionId?: string, engine: ProviderId, codexThreadId?: string, codexHomeName?: string,
    label: SessionLabel | undefined, policy?: LaunchPolicy, kickoffHash?: string, hydraMade?: boolean, spawnerThreadId?: string,
    /** The start continues the thread's own session (resume, respawn, revive, handoff, or its lineage's owner spawning into it): it keeps that session's `hydraMade`. */
    continuesThread?: boolean,
  }): void {
    const now = Date.now()
    let thread = this.threads.get(threadId)
    // Read before this start's entry is pushed: the entry it continues is the thread's last.
    const madeForThis = !!opts.hydraMade || (!!opts.continuesThread && this.madeFor(threadId))
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
        ...(opts.hydraMade && { hydraMade: true }),
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
      engine: opts.engine,
      ...(opts.codexThreadId && { codexThreadId: opts.codexThreadId }),
      ...(opts.codexHomeName && { codexHomeName: opts.codexHomeName }),
      label: opts.label,
      ...(opts.policy !== undefined && { policy: opts.policy }),
      ...(opts.kickoffHash !== undefined && { kickoffHash: opts.kickoffHash }),
      ...(opts.spawnerThreadId && { spawnerThreadId: opts.spawnerThreadId }),
      hydraMade: madeForThis,
    })
    this.persist()
  }

  /**
   * Whether hydra made `threadId` for `sessionId`'s lineage (its entry), or, with no session named, for its last session's. An entry
   * from before entries kept it, or a session with none (a guest, a record older than the history), reads the thread's own `hydraMade`.
   */
  madeFor(threadId: string, sessionId?: string): boolean {
    const thread = this.threads.get(threadId)
    const entry = sessionId ? thread?.sessionHistory.findLast(h => h.sessionId === sessionId) : thread?.sessionHistory.at(-1)
    return entry?.hydraMade ?? thread?.hydraMade === true
  }

  /** Mark a session's conversation as never to be continued (kill_and_respawn), on disk before anything ends it. False: it has no history entry to mark. */
  markRestartedFresh(threadId: string, sessionId: string): boolean {
    const entry = this.threads.get(threadId)?.sessionHistory.findLast(h => h.sessionId === sessionId)
    if (!entry) return false
    entry.restartedFresh = true
    this.persist()
    return true
  }

  // The durable record a later resume reads; killSession drops the registry entry.
  closeHistoryEntry(threadId: string, info: { sessionId: string; messageCount?: number; claudeSessionId?: string; codexThreadId?: string; codexHomeName?: string; label?: SessionLabel }): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const entry = thread.sessionHistory.find(h => h.sessionId === info.sessionId && !h.endedAt)
    if (entry) {
      entry.endedAt = Date.now()
      entry.messageCount = info.messageCount ?? 0
      if (info.claudeSessionId) entry.claudeSessionId = info.claudeSessionId
      if (info.codexThreadId) entry.codexThreadId = info.codexThreadId
      if (info.codexHomeName) entry.codexHomeName = info.codexHomeName
      if (info.label) entry.label = info.label
    }
    this.persist()
  }

  /** The pair of closeHistoryEntry: its session is alive, so its entry is open again. Not persisted: the caller persists. */
  reopenHistoryEntry(threadId: string, sessionId: string): boolean {
    const entry = this.threads.get(threadId)?.sessionHistory.findLast(h => h.sessionId === sessionId)
    if (!entry || entry.endedAt === undefined) return false
    delete entry.endedAt
    return true
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

    // An entry from before the engine was recorded gets it once, here, and keeps it on disk. In order of evidence: its session's record if one
    // is left, the engine its model belongs to (`gemini-*` is agy, `gpt-*` Codex), the id it ran with (a Codex thread), else Claude, the only
    // engine there was. omp runs Claude's models, so an omp entry with no record is not told from a Claude one.
    const engineOfSession = new Map<string, ProviderId>()
    for (const session of sessionRegistry.values()) engineOfSession.set(session.sessionId, session.engine)
    let engined = 0
    for (const thread of this.threads.values()) {
      for (const entry of thread.sessionHistory) {
        if (entry.engine) continue
        entry.engine = engineOfSession.get(entry.sessionId) ?? (entry.model ? engineOfModel(entry.model) : undefined) ?? (entry.codexThreadId ? 'codex' : 'claude')
        engined++
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
          engine: session.engine,
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

    // The session loader stamps deadAt before this registry exists, so a death across the restart is written
    // here: deadAt and endedAt together, as markDead does at runtime.
    let closed = 0
    let reopened = 0
    for (const session of sessionRegistry.values()) {
      // Found alive: the loader cleared a stale stamp (a tmux that still answers), so its entry is open, as markRevived leaves it.
      if (!session.deadAt) { if (this.reopenHistoryEntry(session.threadId, session.sessionId)) reopened++; continue }
      const entry = this.threads.get(session.threadId)?.sessionHistory.find(h => h.sessionId === session.sessionId && !h.endedAt)
      if (entry) { entry.endedAt = session.deadAt; closed++ }
      // What closeHistoryEntry keeps, so a kill after this boot, which finds no open entry, leaves the entry whole.
      if (entry) {
        entry.engine = session.engine
        if (session.codexThreadId) entry.codexThreadId = session.codexThreadId
        if (session.codexHomeName) entry.codexHomeName = session.codexHomeName
      }
    }

    if (created > 0 || backfilled > 0 || closed > 0 || reopened > 0 || engined > 0) {
      if (created > 0) process.stderr.write(`daemon: created ${created} thread(s) from sessions\n`)
      if (backfilled > 0) process.stderr.write(`daemon: backfilled parentChannelId on ${backfilled} thread(s)\n`)
      if (engined > 0) process.stderr.write(`daemon: recorded the engine on ${engined} history entr${engined === 1 ? 'y' : 'ies'}\n`)
      if (closed > 0) process.stderr.write(`daemon: closed ${closed} history entr${closed === 1 ? 'y' : 'ies'} of sessions dead at boot\n`)
      if (reopened > 0) process.stderr.write(`daemon: reopened ${reopened} history entr${reopened === 1 ? 'y' : 'ies'} of sessions alive at boot\n`)
      this.persist()
    }
  }
}

export const threadRegistry = new ThreadRegistry()

/** The one writer of a death (markRevived is its undoing): `deadAt` on the record and `endedAt` on its history entry, together. Keeps the first stamp. */
export function markDead(info: SessionInfo, at = Date.now()): void {
  const fresh = info.deadAt === undefined
  info.deadAt ??= at
  // What a launch wrote for the session goes with it: a restricted session's generated config (it holds token values) and the
  // prompt file (it holds the operator's text). A resume writes its own config; a Claude resume takes no prompt.
  removeLaunchFiles(info)
  registry.persist()
  threadRegistry.closeHistoryEntry(info.threadId, info)
  if (fresh) emit('session:marked-dead', { sessionId: info.sessionId, tmuxName: info.tmuxName })
}

/** The pair of markDead: the session is alive again, so its record and its history entry say so together. Persists the thread file when it reopens an entry; the caller persists the session record. */
export function markRevived(info: SessionInfo): void {
  delete info.deadAt
  if (threadRegistry.reopenHistoryEntry(info.threadId, info.sessionId)) threadRegistry.persist()
}
