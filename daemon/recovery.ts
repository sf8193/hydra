// Post-reboot / crash recovery engine — extracted from commands/global.ts so the commands
// layer stays a thin orchestration shell and the worktree-manager/pr-watch imports live at the
// lifecycle layer (alongside session-lifecycle) rather than crossing into commands.
//
// Manual `recover [name]` (handleRecoverIntercept, router-dispatched) and automatic post-reboot
// recovery (autoRecoverAfterBoot, boot-wired in daemon.ts) share the recoverOne cascade,
// work-key dedup, and the single-flight guard here.
import { existsSync } from 'fs'
import { gateway } from './config.js'
import { markDead, registry, repointChildren, sessionEmoji, threadRegistry } from './sessions.js'
import type { ThreadMetadata, ThreadSessionEntry, SessionInfo, SpawnOpts, SpawnResult } from './sessions.js'
import { carryOver, doSpawnSession, killSession, tryResume, tryRespawn, RECOVERY_REVERIFY_GUARD } from './session-lifecycle.js'
import { baseNameFromBranch } from './util.js'
import { tmuxSessionState, TMUX_HOLD_MS } from './tmux.js'
import { occupancy, occupied } from './session-reachability.js'
import { parsePrUrl, retargetWatches, unwatchBySession } from '../connectors/github/pr-watch.js'
import { checkUnpushedCommits, reattachWorktree } from './worktree-manager.js'
import { notifyOperator } from './access.js'
import { deadSessionLabel, recoveryEntry, recoveryModel } from './recovery-selection.js'
import { recoveryEngine } from './engines/history.js'
import { resolveEngine } from './engines/instances.js'
import type { ProviderId } from './engines/engine-adapter.js'
import { activeBackoff, clearBackoff, recordFailure, type Backoff } from './recovery-backoff.js'
import { targetKeyForThread, withThreadLock } from '../specialists/specialists.js'
import { PolicyRefusal } from './scope.js'
import type { InboundMessage } from '../gateway.js'

// ---------------------------------------------------------------------------
// reviveThread — the one cascade: resume → fork → respawn
// ---------------------------------------------------------------------------

// Recovery executors, swappable in tests (same pattern as reply-guard's deps). `later`: auto-recovery's one retry.
type RecoveryDeps = { tryResume: typeof tryResume; doSpawnSession: typeof doSpawnSession; tryRespawn: typeof tryRespawn; later: (fn: () => Promise<void>, ms: number) => void }
const defaultRecoveryDeps: RecoveryDeps = { tryResume, doSpawnSession, tryRespawn, later: (fn, ms) => { setTimeout(() => void fn(), ms).unref() } }
let recoveryDeps: RecoveryDeps = defaultRecoveryDeps
export function _setRecoveryDeps(custom: Partial<RecoveryDeps>): void { recoveryDeps = { ...defaultRecoveryDeps, ...custom } }
export function _resetRecoveryDeps(): void { recoveryDeps = defaultRecoveryDeps }
/** The executors in effect, for a fork (its own kind of spawn) that shares the test seam. */
export function currentRecoveryDeps(): RecoveryDeps { return recoveryDeps }

export type ReviveRequest = {
  thread: ThreadMetadata
  /** The history entry to continue. Default: the latest one that is not a foreign placeholder. */
  entry?: ThreadSessionEntry
  /** The dead record, when the caller already holds it. Default: the entry's record, else the thread's. */
  dead?: SessionInfo
  /** A running but unreachable session to tear down first (its worktree and PR watches kept). Its record and children
   *  are taken before the kill deletes them, so the revive carries them as it would a dead one's. */
  orphan?: { info: SessionInfo; reason: string }
  /** Skip resume and fork: a fresh session that reads the thread (the `respawn` command). */
  respawnOnly?: boolean
  /** The thread is gone: open a new one in this channel. Respawn tier only; the history is not there to read. */
  newThreadIn?: string
  /** The respawn tier's prompt, read only if that tier runs (a broken kickoff must not stop a resume). Default: the thread's topic. */
  respawnTopic?: string | (() => string)
  /** A specialist's name, claimed on every tier. */
  name?: string
  model?: string
  engine?: ProviderId
  /** Layered onto the respawn tier only (a template's tools and session type). */
  respawnOpts?: Partial<SpawnOpts>
  /** Where a fresh session starts (a specialist's workdir): the respawn tier and a new thread. Resume and fork start
   *  where their transcript was made, and a kept worktree wins. */
  cwd?: string
  promptPrefix?: string
  /** On the resume tier, keep the dead session's name (boot recovery). */
  reuseName?: boolean
  initiator?: string
  trigger?: string
  /** The specialist the revived session acts for (its id): its scope decides whether the old conversation may be resumed. Absent: the dead session's, else the one whose thread this is. */
  specialist?: string
  /** Back-off key (a specialist name, or the thread id): refuse while it backs off, and count a failure toward it. */
  backoffKey?: string
  /** An operator asking by hand: not held back by the back-off (a failure still counts). */
  ignoreBackoff?: boolean
}

export type ReviveMethod = 'resumed' | 'forked' | 'respawned'
export type ReviveOutcome =
  | { ok: true; result: SpawnResult & { bridgeOrphan?: boolean }; method: ReviveMethod; lastTmuxName: string }
  /** `busy`: another resume holds this conversation; `backoff`: refused, or this failure started/extended one. */
  | { ok: false; reason: string; lastTmuxName: string; busy?: true; backoff?: Backoff }

/**
 * Put a session back in a thread whose session is gone: resume its conversation, else fork it, else
 * respawn a fresh one that reads the thread. Every caller (resume, respawn, recover, boot recovery,
 * a specialist's refill) runs this one copy, so each carries the same deliverables, keeps the worktree,
 * restores PR watches and hands the dead session's children to its successor.
 *
 * The caller holds the thread's target lock and has checked occupancy: this never looks for a live session.
 */
export async function reviveThread(req: ReviveRequest): Promise<ReviveOutcome> {
  const { thread } = req
  const given = req.orphan?.info ?? req.dead
  const entry = req.entry
    ?? (given && thread.sessionHistory.findLast(h => h.sessionId === given.sessionId))
    ?? recoveryEntry(thread.sessionHistory)
  const dead = given ?? registry.get(entry?.sessionId ?? '') ?? registry.get(registry.getByThread(thread.threadId) ?? '')
  const lastTmuxName = entry?.tmuxName ?? dead?.tmuxName ?? thread.threadId.slice(0, 8)

  if (req.backoffKey && !req.ignoreBackoff) {
    const refusal = backoffRefusal(req.backoffKey)
    if (refusal) return { ok: false, lastTmuxName, ...refusal }
  }

  if (req.orphan) {
    process.stderr.write(`daemon: revive: tearing down orphaned ${req.orphan.info.tmuxName} first\n`)
    await killSession(req.orphan.info, req.orphan.reason, { skipWorktreeDestroy: true, keepWatches: true })
    markDead(req.orphan.info)
  }

  const engine = req.engine ?? recoveryEngine(entry, dead)
  const model = req.model ?? recoveryModel(entry?.model ?? dead?.sessionMetadata?.model)
  const label = deadSessionLabel(entry, dead)
  const claudeSessionId = entry?.claudeSessionId ?? dead?.claudeSessionId
  // The `respawn` command is a fresh start: it carries no restrictions, parent or launch dir from the dead session.
  const carried = dead && !req.respawnOnly ? carryOver(dead) : undefined
  // What the launch policy is read from when no record is left (a kill deleted it): the history entry's. Carried even by `respawn`,
  // which carries no restrictions: a confined thread whose specialist can no longer be resolved refuses, whichever way it is revived.
  const carriedPolicy = dead?.policy ?? entry?.policy
  const carriedOut = carried || carriedPolicy ? { ...carried, ...(carriedPolicy && { policy: carriedPolicy }), sessionName: lastTmuxName } : undefined
  // A worktree still on disk is kept on every tier and into a new thread; boot recovery reattaches a missing one first.
  const worktree = dead?.worktreeRepo && dead.worktreePath && existsSync(dead.worktreePath)
    ? { repo: dead.worktreeRepo, path: dead.worktreePath, branch: dead.worktreeBranch ?? `wt/${dead.tmuxName}` }
    : undefined
  const keep = worktree ? { preserveWorktree: true, reuseWorktree: worktree } : {}
  const named = req.name ? { name: req.name } : {}
  // Whom the revived session acts for is passed through (a fill names it); its launch policy is decided, and a conversation born under
  // another policy refused, in one place: doSpawnSession. A resume or fork that policy refuses fails there, and the cascade moves on
  // to the respawn tier, which is a new birth.
  const acting = req.specialist !== undefined ? { specialist: req.specialist } : {}
  const origin = { ...(req.initiator && { initiator: req.initiator }), ...(req.trigger && { trigger: req.trigger }) }

  // Hold the worktree branch's base name for the whole cascade, so a concurrent spawn can't pick it (freed when
  // the dead record is replaced) and `branch -D` the branch this revive preserves. The branch's BASE name is the
  // token pickSessionName derives and createWorktree's stale cleanup targets; after an earlier recovery it is not
  // the tmuxName. A name this revive claims (a specialist's) needs no reservation and must not get one, or the claim
  // would refuse it: only the specialist claims it, under its own lock, and the catalog never hands it out.
  const reserve = (n: string): boolean => n !== req.name && (registry.reservedNames.add(n), true)
  const reservedName = worktree ? (worktree.branch.startsWith('wt/') ? baseNameFromBranch(worktree.branch) : dead!.tmuxName) : undefined
  const reservedBranch = reservedName !== undefined && reserve(reservedName)
  let busy = false
  let lastError: string | undefined
  let lastRefused = false   // the last tier failed with a refusal hydra.toml caused (a policy that cannot be read or satisfied), not a fault
  let revived: Extract<ReviveOutcome, { ok: true }> | undefined
  try {
    revived = req.newThreadIn ? await respawnInNewThread(req.newThreadIn) : await cascade()
  } finally {
    if (reservedBranch) registry.reservedNames.delete(reservedName!)
  }

  if (revived) {
    if (dead) repointChildren(dead, revived.result.sessionId)
    if (req.backoffKey) clearBackoff(req.backoffKey)
    return revived
  }
  if (busy) return { ok: false, busy: true, lastTmuxName, reason: 'a resume of this session is already in progress' }

  // Total failure: the spawn deleted the dead record before it threw. Put it back so a later revive can still find
  // it, unless a fallback tier already claimed the thread. (Its PR watches deliver to the thread, and stayed.)
  if (dead && !req.newThreadIn && registry.getByThread(thread.threadId) === undefined) {
    dead.deadAt ??= Date.now()
    registry.set(dead.sessionId, dead)
    registry.setThread(dead.threadId, dead.sessionId)
    registry.persist()
    process.stderr.write(`daemon: revive ${lastTmuxName}: all tiers failed — restored the dead record\n`)
  }
  // A refusal hydra.toml caused is not a failure to back off from: once the operator fixes the config, the next revive must run.
  const backoff = req.backoffKey && !lastRefused ? recordFailure(req.backoffKey, lastError ?? 'all recovery methods failed') : undefined
  return { ok: false, lastTmuxName, reason: lastError ? `start failed: ${lastError}` : 'all recovery methods failed', ...(backoff && { backoff }) }

  function ok(result: SpawnResult & { bridgeOrphan?: boolean }, method: ReviveMethod): Extract<ReviveOutcome, { ok: true }> {
    return { ok: true, result, method, lastTmuxName }
  }

  async function cascade(): Promise<Extract<ReviveOutcome, { ok: true }> | undefined> {
    const plan = resolveEngine(engine).recoveryPlan({
      tmuxName: lastTmuxName, claudeSessionId,
      codexThreadId: entry?.codexThreadId ?? dead?.codexThreadId,
      codexHomeName: entry?.codexHomeName ?? dead?.codexHomeName,
      sessionId: entry?.sessionId,
    })
    const prefix = req.promptPrefix ?? RECOVERY_REVERIFY_GUARD
    // The `respawn` command hands the dead session's bucket down (a template or a flag on the topic wins); a revive keeps it.
    const shared = { engine, ...(req.respawnOnly ? { inheritedLabel: label } : { label }), ...(carriedOut && { carryOver: carriedOut }), ...keep, ...named, ...acting, ...origin }
    const common = { model, ...shared }

    // The gate reads both ids (PINNED R9: a mixed-ID record logs both tier failures, then respawns).
    if (!req.respawnOnly && (claudeSessionId || entry?.codexThreadId || dead?.codexThreadId || plan.resume)) {
      let result: (SpawnResult & { bridgeOrphan?: boolean }) | null = null
      const r = plan.resume
      if (r?.kind === 'await-bridge') {
        result = await recoveryDeps.tryResume({
          topic: thread.topic, threadId: thread.threadId, claudeSessionId: r.resumeFrom, threadUrl: thread.threadUrl, model, label,
          ...(req.reuseName && { reuseName: lastTmuxName }), ...named, ...acting,
          ...(worktree && { worktree, preserveWorktree: true }), ...(carriedOut && { carryOver: carriedOut }),
        })
      } else if (r && 'resumeOmp' in r) {
        // The reservation is the lock: two resumes of one dead session would each copy its file into a live session.
        const from = r.resumeOmp.fromSessionId
        if (registry.reservedNames.has(from)) { busy = true; return undefined }
        const held = reserve(from)
        try {
          result = await recoveryDeps.doSpawnSession(thread.topic, undefined, undefined, {
            ...common, existingThreadId: thread.threadId, resumeOmp: r.resumeOmp, preserveWorktree: true, promptPrefix: prefix,
          })
        } catch (err) {
          process.stderr.write(`daemon: omp resume of session ${from} failed: ${err}\n`)
          lastError = errorText(err); lastRefused = err instanceof PolicyRefusal
        } finally {
          if (held) registry.reservedNames.delete(from)
        }
      } else if (r && 'resumeCodex' in r) {
        // A held home means another resume (or spawn) is mid-launch on it; a second would double-launch the same
        // CODEX_HOME. Hold the home's name across the kill → launch → persist window.
        const home = r.resumeCodex.homeName
        if (registry.reservedNames.has(home)) { busy = true; return undefined }
        const held = reserve(home)
        try {
          result = await recoveryDeps.doSpawnSession(thread.topic, undefined, undefined, {
            ...common, existingThreadId: thread.threadId, resumeCodex: r.resumeCodex, promptPrefix: prefix,
          })
        } catch (err) {
          process.stderr.write(`daemon: codex resume of ${r.resumeCodex.threadId} in home ${home} failed: ${err}\n`)
          lastError = errorText(err); lastRefused = err instanceof PolicyRefusal
        } finally {
          if (held) registry.reservedNames.delete(home)
        }
      }
      if (result) return ok(result, 'resumed')
      process.stderr.write(`daemon: resume tier 1 (--resume) failed for ${lastTmuxName}, trying fork-from-dead\n`)

      try {
        if (!plan.fork) throw new Error('cannot fork this session')
        return ok(await recoveryDeps.doSpawnSession(thread.topic, undefined, undefined, {
          ...common, existingThreadId: thread.threadId, forkFrom: plan.fork, ...(req.promptPrefix && { promptPrefix: req.promptPrefix }),
        }), 'forked')
      } catch (err) {
        lastError = errorText(err); lastRefused = err instanceof PolicyRefusal
        process.stderr.write(`daemon: resume tier 2 (fork-from-dead) failed for ${lastTmuxName}, falling back to respawn\n`)
      }
    }

    try {
      const result = await recoveryDeps.tryRespawn(thread.threadId, respawnTopic(), entry?.tmuxName ?? dead?.tmuxName, model, {
        ...shared, ...req.respawnOpts, ...(req.promptPrefix && { promptPrefix: req.promptPrefix }), ...(req.cwd && { cwd: req.cwd }),
      })
      if (result) return ok(result, 'respawned')
    } catch (err) {
      lastError = errorText(err); lastRefused = err instanceof PolicyRefusal
      process.stderr.write(`daemon: revive tier 3 (respawn) failed for ${lastTmuxName}: ${lastError}\n`)
    }
    return undefined
  }

  async function respawnInNewThread(channel: string): Promise<Extract<ReviveOutcome, { ok: true }> | undefined> {
    try {
      const prompt = thread.threadId
        ? `[system] Your previous thread (${thread.threadId}) is gone, so this is a new one; its history cannot be read here.\n\n${respawnTopic()}`
        : respawnTopic()
      return ok(await recoveryDeps.doSpawnSession(prompt, channel, undefined, {
        model, engine, label, carryOver: carriedOut, ...keep, ...named, ...acting, ...origin, ...(req.cwd && { cwd: req.cwd }),
      }), 'respawned')
    } catch (err) {
      lastError = errorText(err); lastRefused = err instanceof PolicyRefusal
      process.stderr.write(`daemon: revive ${lastTmuxName}: a new thread in ${channel} failed: ${lastError}\n`)
      return undefined
    }
  }

  function respawnTopic(): string {
    return typeof req.respawnTopic === 'function' ? req.respawnTopic() : req.respawnTopic ?? thread.topic
  }
}

/** The refusal a target backing off gets, or undefined. Checked before anything reaches the platform. */
export function backoffRefusal(key: string): { reason: string; backoff: Backoff } | undefined {
  const b = activeBackoff(key)
  if (!b) return undefined
  return { backoff: b, reason: `not retrying until ${new Date(b.nextAt).toTimeString().slice(0, 8)} (${b.failures} failure${b.failures === 1 ? '' : 's'}); last: ${b.lastError}` }
}

/** Test seam: the platform's answer to "is this thread still there?" (`threadExists` reports gone only on a definitive code). */
export const reviveDeps = {
  threadExists: (threadId: string) => gateway.threadExists(threadId),
}

export type ThreadReviveResult =
  | { ok: true; revived: boolean }
  | { ok: false; exitCode: 3 | 4 | 5 | 6; reason: string }

/**
 * `deliver --thread <id> --revive` for a thread no specialist owns: an unnamed thread heals only when asked. Under
 * the thread's lock: an orphan is reported (exit 4), never revived over; someone home is left alone; a thread backing
 * off is refused before the platform is asked; otherwise, while the platform still has the thread, a session is
 * revived there with the plain resume prompt, even when hydra has no record of the thread. A deleted thread is exit 3.
 */
export function reviveThreadForDelivery(threadId: string, initiator?: string, wanted?: () => boolean): Promise<ThreadReviveResult> {
  return withThreadLock(threadId, async () => {
    const home = registry.get(registry.getByThread(threadId) ?? '')
    const occ = occupancy(home)
    if (occ === 'orphaned') return { ok: false, exitCode: 4, reason: `${home!.tmuxName} is running but not connected; resume it in the thread, or kill it to restart` }
    if (occupied(occ)) return { ok: true, revived: false }
    const refusal = backoffRefusal(threadId)
    if (refusal) return { ok: false, exitCode: 6, reason: refusal.reason }
    if (!(await reviveDeps.threadExists(threadId))) return { ok: false, exitCode: 3, reason: `thread ${threadId} is gone` }
    if (wanted && !wanted()) return { ok: false, exitCode: 3, reason: 'withdrawn by its sender' }
    const thread = threadRegistry.get(threadId) ?? threadStub(threadId, 'Continue the work in this thread.')
    const outcome = await reviveThread({ thread, backoffKey: threadId, ...(initiator && { initiator }), trigger: 'deliver --revive' })
    if (!outcome.ok) return { ok: false, exitCode: outcome.busy ? 5 : 6, reason: outcome.reason }
    return { ok: true, revived: true }
  })
}

/** A thread the daemon has no metadata for (the platform still has it, or it has none yet): enough for a respawn. */
export function threadStub(threadId: string, topic: string): ThreadMetadata {
  return { threadId, topic, sessionHistory: [], respawnCount: 0 } as unknown as ThreadMetadata
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Recover — crash recovery via resume or resurrect
// ---------------------------------------------------------------------------

let recoveryInProgress = false
const MAX_CONCURRENT = 2
const STAGGER_MS = 5_000

// Dead, recoverable sessions for the manual `recover` command. Broader than the
// auto-recover filter (which is thread_owner-only + excludes parked/ephemeral):
// a user may deliberately recover any non-guest session whose occupancy is dead and that the
// recoverOne cascade may act on (recoveryPlan().generic: not Codex, which it would relaunch as Claude).
// An orphan (running, stamped dead or not) is never a candidate: a revive would race it. resume and
// respawn tear it down first.
function findDeadSessions(): SessionInfo[] {
  return [...registry.values()].filter(info =>
    info.sessionType !== 'thread_guest'
    && info.adapter.recoveryPlan(info).generic
    // suppressAutoRecover intentionally NOT checked — it gates only AUTOMATIC boot recovery
    // (parked awaiting_pm / branch-gone); an explicit manual `recover` overrides it.
    && !occupied(occupancy(info))
    && threadRegistry.has(info.threadId),
  )
}

// Map a dead SessionInfo to recoverOne's input (thread metadata resolved from the
// registry; guaranteed present since callers filter on threadRegistry.has).
function toRecoverInput(info: SessionInfo, promptPrefix?: string) {
  return {
    sessionId: info.sessionId,
    thread: threadRegistry.get(info.threadId)!,
    claudeSessionId: info.claudeSessionId,
    lastTmuxName: info.tmuxName,
    model: info.sessionMetadata?.model,
    promptPrefix,
    description: info.description,
  }
}

type RecoverResult = { name: string; method: 'resumed' | 'forked' | 'resurrected'; newName: string; threadUrl?: string; displayName?: string } | { name: string; method: 'failed'; reason: string; threadUrl?: string; displayName?: string }

async function recoverOne(dead: { sessionId?: string; thread: ThreadMetadata; claudeSessionId?: string; lastTmuxName: string; model?: string; promptPrefix?: string; description?: string }): Promise<RecoverResult> {
  const { thread, lastTmuxName, model } = dead
  const displayName = dead.description || thread.description || thread.topic

  // Capture everything off the dead record up front: tier 1's kill deletes it, so the
  // fallback tiers (and post-cascade watch restore) can't read it later. Resolve by the
  // caller's exact sessionId when known (avoids a second, possibly-stale threadId→session
  // map lookup); fall back to getByThread only for callers that don't pass it.
  const deadInfo = (dead.sessionId ? registry.get(dead.sessionId) : undefined)
    ?? registry.get(registry.getByThread(thread.threadId) ?? '')
  const worktree = deadInfo?.worktreeRepo && deadInfo.worktreePath
    ? { repo: deadInfo.worktreeRepo, path: deadInfo.worktreePath, branch: deadInfo.worktreeBranch ?? `wt/${deadInfo.tmuxName}` }
    : undefined
  // Resolve worktree availability BEFORE the cascade so a recovered agent is NEVER spawned
  // into the shared main checkout (spawnCwd). If the dir is gone: reattach it; if that's
  // transiently impossible, defer to next boot; if the branch is truly gone, skip and mark
  // so we don't retry every boot. Only proceed to the cascade once the worktree dir exists
  // (or the session never had a worktree).
  if (worktree && !existsSync(worktree.path)) {
    const st = await reattachWorktree(worktree.repo, worktree.path, worktree.branch)
    if (st === 'failed') {
      // Transient (stale registration, lock, FS/repo hiccup) — branch preserved. Leave the
      // dead record untouched (no kill, no spawn) so the next boot retries the reattach.
      process.stderr.write(`daemon: recover ${lastTmuxName}: worktree ${worktree.path} reattach failed transiently — deferring to next boot\n`)
      return { name: lastTmuxName, method: 'failed', reason: `worktree temporarily unavailable (${worktree.branch}) — deferred to next boot`, threadUrl: thread.threadUrl, displayName }
    }
    if (st === 'branch-gone' && deadInfo) {
      // Worktree dir AND branch both gone (typically merged + pruned). Don't revive into
      // the main checkout; mark suppressAutoRecover so it isn't retried every boot, and
      // surface it so the operator can manually recover the thread if still needed.
      deadInfo.suppressAutoRecover = true
      // Terminal (branch gone ⇒ never revived): drop its PR watches. They'd otherwise linger
      // frozen forever — pollPr skips dead-owner watches, so they can never self-unwatch on
      // merge. The branch is gone (PR merged/pruned), so the watch is dead weight anyway.
      unwatchBySession(deadInfo)
      registry.persist()
      process.stderr.write(`daemon: recover ${lastTmuxName}: worktree + branch ${worktree.branch} gone — skipping auto-recovery (manual recover still available)\n`)
      return { name: lastTmuxName, method: 'failed', reason: `worktree + branch gone (${worktree.branch}, likely merged/pruned) — not auto-revived`, threadUrl: thread.threadUrl, displayName }
    }
    // 'attached' → dir now exists; fall through to the cascade.
  }

  const outcome = await reviveThread({
    thread, dead: deadInfo, model, promptPrefix: dead.promptPrefix ?? RECOVERY_REVERIFY_GUARD, reuseName: true,
    backoffKey: targetKeyForThread(thread.threadId), ignoreBackoff: true,
  })
  if (!outcome.ok) return { name: lastTmuxName, method: 'failed', reason: outcome.reason, threadUrl: thread.threadUrl, displayName }
  const method = outcome.method === 'respawned' ? 'resurrected' : outcome.method
  return { name: lastTmuxName, method, newName: outcome.result.name, threadUrl: thread.threadUrl, displayName }
}

// Under the thread's target lock, and only while nobody is home: a resume or a specialist's revive may have
// filled the thread since the candidates were listed.
function recoverLocked(info: SessionInfo, input: Parameters<typeof recoverOne>[0]): Promise<RecoverResult> {
  return withThreadLock(info.threadId, async () => {
    const home = registry.get(registry.getByThread(info.threadId) ?? '')
    if (home && occupied(occupancy(home))) {
      return { name: info.tmuxName, method: 'failed', reason: `already live as ${home.tmuxName}`, threadUrl: input.thread.threadUrl }
    }
    return recoverOne(input)
  })
}

export async function handleRecoverIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  if (recoveryInProgress) {
    try { await gateway.send(msg.channelId, 'Recovery already in progress.', { replyTo: msg.id }) } catch {}
    return
  }

  const deadSessions = findDeadSessions()
  if (deadSessions.length === 0) {
    try { await gateway.send(msg.channelId, 'No dead sessions found.', { replyTo: msg.id }) } catch {}
    return
  }

  const single = !!targetName && targetName !== 'all'
  let candidates = deadSessions
  if (single) {
    candidates = candidates.filter(d => d.tmuxName === targetName)
    if (candidates.length === 0) {
      try { await gateway.send(msg.channelId, `"${targetName}" not found in dead sessions.`, { replyTo: msg.id }) } catch {}
      return
    }
  }

  recoveryInProgress = true
  const results: Awaited<ReturnType<typeof recoverOne>>[] = []
  let skipped: Array<{ info: SessionInfo; reason: string }> = []
  try {
    // A single explicit `recover <name>` is user-targeted — no dedup. `recover all` (or
    // bare) dedups by work-key so it can't put two sessions on one PR (same guard the
    // auto path uses). dedupForRecovery does git I/O — safe, single-flight is already set.
    let unique: SessionInfo[]
    if (single) {
      unique = candidates
    } else {
      ({ unique, skipped } = await dedupForRecovery(candidates))
    }
    // Most-recently-active first (dedupForRecovery already sorts; sort the single/no-dedup case too).
    unique.sort((a, b) => b.lastActive - a.lastActive)

    try {
      const skipNote = skipped.length > 0 ? ` (${skipped.length} deduped)` : ''
      await gateway.send(msg.channelId, `Recovering ${unique.length} session(s)${skipNote}...`, { replyTo: msg.id })
    } catch {}

    for (let i = 0; i < unique.length; i += MAX_CONCURRENT) {
      const wave = unique.slice(i, i + MAX_CONCURRENT)
      const wavePromises = wave.map(async (info, j) => {
        if (j > 0) await new Promise(r => setTimeout(r, STAGGER_MS * j))
        try {
          const r = await recoverLocked(info, toRecoverInput(info))
          if (r.method !== 'failed') {
            const e = sessionEmoji(r.newName)
            void gateway.send(info.threadId, `${e} \`${r.newName}\` recovered (${r.method})`).catch(() => {})
          }
          return r
        } catch (err) {
          return { name: info.tmuxName, method: 'failed' as const, reason: String(err) }
        }
      })
      const settled = await Promise.allSettled(wavePromises)
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
      }
    }
  } finally {
    recoveryInProgress = false
  }

  const resumed = results.filter(r => r.method === 'resumed')
  const forked = results.filter(r => r.method === 'forked')
  const resurrected = results.filter(r => r.method === 'resurrected')
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string }>

  const fmtName = (r: { name: string; threadUrl?: string }) =>
    r.threadUrl ? `[\`${r.name}\`](${r.threadUrl})` : `\`${r.name}\``

  const lines = [`**Recovery complete** — ${results.length} session(s)`]
  if (resumed.length > 0) lines.push(`• ${resumed.length} resumed (full context): ${resumed.map(fmtName).join(', ')}`)
  if (forked.length > 0) lines.push(`• ${forked.length} forked (transcript preserved): ${forked.map(fmtName).join(', ')}`)
  if (resurrected.length > 0) lines.push(`• ${resurrected.length} resurrected (thread re-read): ${resurrected.map(fmtName).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `${fmtName(r)} (${r.reason})`).join(', ')}`)
  if (skipped.length > 0) lines.push(`• ${skipped.length} skipped (duplicate work): ${skipped.map(s => `\`${s.info.tmuxName}\` — ${s.reason}`).join(', ')}`)

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Auto-recovery — revive dead worker sessions on daemon boot (post-reboot)
// ---------------------------------------------------------------------------

// A PR URL the session posted into its own thread. extractArtifactLinks matches ANY github
// pull URL in a reply (authored or merely referenced), so this is a shared-PR signal, not
// proof of authorship — see workKey's coarseness note.
function prKeyFromArtifacts(info: Partial<Pick<SessionInfo, 'artifacts'>>): string | null {
  for (const url of info.artifacts ?? []) {
    const pr = parsePrUrl(url)
    if (pr) return `pr:${pr.owner}/${pr.repo}#${pr.prNumber}`
  }
  return null
}

// Ticket key only when the token LEADS the topic/description — the house convention
// ("BANK-1750 fix …"). Anchoring to the start (vs a loose \b…\b anywhere) stops the
// common case: a standards token buried mid-text ("fix the UTF-8 bug") no longer keys.
// It does NOT catch a topic that *leads* with such a token ("SHA-256 checksum work" →
// ticket:SHA-256) — that remains the accepted ticket-dedup coarseness documented on
// workKey (bounded, surfaced in the recovery summary, manually recoverable).
// Tradeoff (accepted): the leading anchor also FALSE-NEGATIVES a mid-text ticket
// ("Fix login — BANK-1750" → no key), so it won't dedup against a sibling that DOES lead
// with it — both survive. That's the safe direction (fail toward keeping both sessions,
// which are lossless anyway) vs. the false-positive collapse a loose match would cause.
function ticketKey(info: Partial<Pick<SessionInfo, 'topic' | 'description'>>): string | null {
  for (const field of [info.topic, info.description]) {
    const m = field?.trim().match(/^[A-Z]{2,}-\d+\b/)
    if (m) return `ticket:${m[0]}`
  }
  return null
}

// Dedup dead sessions by shared work, not per-thread: two dead threads can point at the same
// PR/ticket, and a naive per-thread respawn puts two live sessions on one PR (has bitten
// before). Key precedence: a PR URL the session posted → its leading ticket; null = unique.
// Both keys are coarse heuristics, NOT ownership proofs — a posted PR URL may be one the
// session only referenced (a reviewer posting the author's PR), and a ticket token can be
// shared by stacked PRs — so two distinct sessions can collapse and one won't auto-revive.
// Acceptable because the collapse is LOSSLESS: the loser is never killed — its record,
// worktree/branch, and watches are preserved and surfaced in the summary for manual recovery.
// PR WATCHES are excluded as a key for the same reason writ larger (an even broader,
// non-owning signal: a session watches PRs it never touched). Exported for unit testing.
export function workKey(info: Partial<Pick<SessionInfo, 'artifacts' | 'topic' | 'description'>>): string | null {
  return prKeyFromArtifacts(info) ?? ticketKey(info)
}

// A deduped-away session is never revived and never killed — its worktree/branch just
// lingers. If it holds unpushed commits, fold the count into the skip reason so the
// operator doesn't `kill` it and discard unmerged work unaware.
async function skipReason(info: SessionInfo, base: string): Promise<string> {
  if (info.worktreeRepo && info.worktreePath) {
    const branch = info.worktreeBranch ?? `wt/${info.tmuxName}`
    try {
      const n = await checkUnpushedCommits(info.worktreeRepo, branch)
      if (n > 0) return `${base} — ⚠️ ${n} unpushed commit(s) on ${branch}, inspect before kill`
      if (n < 0) return `${base} — ⚠️ couldn't verify unpushed commits on ${branch} (transient git error), inspect before kill`
    } catch (err) {
      // checkUnpushedCommits already maps expected git failures to -1 (handled above), so a throw
      // here is truly unexpected (OOM, TypeError, …) — log it rather than swallow, but keep the
      // fall-through to the base reason (an unpushed-commit annotation is best-effort).
      process.stderr.write(`daemon: recover: skipReason unpushed-commit check errored for ${branch}: ${err instanceof Error ? err.message : err}\n`)
    }
  }
  return base
}

// Shared dedup for BOTH auto-recovery and manual `recover all`: collapse candidates to
// one session per real work-key (PR/ticket), so a batch never puts two sessions on one
// PR. Reserves keys owned by ALREADY-LIVE sessions (tmux-alive). Watches
// of a skipped session are retargeted to the surviving owner's thread, live or not, so PR
// feedback never revives a thread whose work another session does. Null work-key → always
// unique (no shared identity to collapse).
export async function dedupForRecovery(candidates: SessionInfo[]): Promise<{
  unique: SessionInfo[]
  skipped: Array<{ info: SessionInfo; reason: string }>
}> {
  // Reserve keys owned by occupied sessions that are NOT themselves being recovered,
  // or a candidate would reserve its own key and skip itself ("already live as <its own name>").
  const candidateIds = new Set(candidates.map(c => c.sessionId))
  const liveKeys = new Map<string, SessionInfo>()  // workKey → live owner (a real competitor, not a candidate)
  for (const info of registry.values()) {
    if (info.sessionType === 'thread_guest' || !occupied(occupancy(info))) continue
    if (candidateIds.has(info.sessionId)) continue
    const key = workKey(info)
    if (key && !liveKeys.has(key)) liveKeys.set(key, info)
  }

  // No permanent "duplicate" marking needed: work-keys (posted PR / leading ticket) are
  // stable per record, so a loser skipped this boot re-collapses against the same winner
  // next boot (byKey if the winner is also dead, liveKeys if it's alive), and correctly
  // becomes recoverable once no competitor remains.
  const byKey = new Map<string, SessionInfo>()
  const unique: SessionInfo[] = []
  const skipped: Array<{ info: SessionInfo; reason: string }> = []
  for (const info of [...candidates].sort((a, b) => b.lastActive - a.lastActive)) {
    const key = workKey(info)
    if (!key) { unique.push(info); continue }
    const liveOwner = liveKeys.get(key)
    if (liveOwner) {
      retargetWatches(info, liveOwner)
      skipped.push({ info, reason: await skipReason(info, `already live as ${liveOwner.tmuxName} (${key})`) })
      continue
    }
    const winner = byKey.get(key)
    if (winner) {
      retargetWatches(info, winner)
      skipped.push({ info, reason: await skipReason(info, `same work as ${winner.tmuxName} (${key})`) })
      continue
    }
    byKey.set(key, info)
    unique.push(info)
  }
  return { unique, skipped }
}

function formatGap(ms: number): string {
  const hrs = Math.floor(ms / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
}

async function postAutoRecoverySummary(
  results: Awaited<ReturnType<typeof recoverOne>>[],
  gapMs?: number,
): Promise<void> {
  const recovered = results.filter(r => r.method !== 'failed') as Array<{ name: string; method: string; newName: string; displayName?: string; threadUrl?: string }>
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string; displayName?: string; threadUrl?: string }>

  const gapStr = gapMs ? ` — ${formatGap(gapMs)} gap` : ''
  const lines = [`🔮 **Fleet recovered**${gapStr}`]
  lines.push('')
  for (const r of recovered) {
    const nameStr = r.threadUrl ? `[${r.newName}](${r.threadUrl})` : `\`${r.newName}\``
    const desc = r.displayName ? ` — ${r.displayName}` : ''
    const emoji = r.method === 'resumed' ? '✅' : '🔁'
    lines.push(`${emoji} ${nameStr}${desc} (${r.method})`)
  }
  for (const r of failed) {
    const nameStr = r.threadUrl ? `[${r.name}](${r.threadUrl})` : `\`${r.name}\``
    const desc = r.displayName ? ` — ${r.displayName}` : ''
    lines.push(`❌ ${nameStr}${desc} (${r.reason})`)
  }
  if (recovered.length > 0) {
    lines.push('')
    lines.push('_Recovered sessions re-reading thread context._')
  }

  await notifyOperator(lines.join('\n'))
}

// Opt-in via HYDRA_AUTO_RECOVER=1. Runs once at daemon startup: reads persisted
// dead workers (loadPersisted keeps them with deadAt set) and revives each via
// the resume→fork→respawn cascade. Idempotent — a session whose tmux is already
// live is skipped. A record tmux doesn't answer for waits for one more pass, after the hold, over
// just those records (`only`), read again from the registry so a kill in between still counts.
export async function autoRecoverAfterBoot(gapMs?: number, only?: ReadonlySet<string>): Promise<void> {
  if ((process.env.HYDRA_AUTO_RECOVER || '') !== '1') return
  if (recoveryInProgress) {
    if (only) process.stderr.write('daemon: auto-recover: deferred pass skipped, a recovery is in progress; its records wait for `recover` or the next boot\n')
    return
  }

  // Precondition: a systemic boot glitch (e.g. SPAWN_CWD unset) would fail every tier
  // for every session, and each doSpawnSession deletes the dead record before it fails.
  // Bail before touching anything so a broken boot can't erase the whole dead fleet.
  if (!process.env.SPAWN_CWD) {
    process.stderr.write('daemon: auto-recover: SPAWN_CWD unset — skipping to avoid destroying dead records on a broken boot\n')
    // Alert the operator: a silent stderr-only skip could go unnoticed for hours while dead
    // workers sit unrecovered. Every other outcome posts a summary; the broken-boot skip should too.
    await notifyOperator('⚠️ **Auto-recovery skipped** — `SPAWN_CWD` is unset, so the daemon booted without a sessions working dir. Dead worker sessions were left untouched (not lost). Set `SPAWN_CWD` and restart to recover them.')
    return
  }

  const candidates = [...registry.values()].filter(info =>
    // deadAt reliably catches hard-reboot survivors: loadPersisted (sessions.ts, in the registry
    // constructor — runs before this) stamps deadAt on EVERY tmux-gone non-guest session at boot,
    // so a session that was alive at crash time (never gracefully stamped) is already deadAt here.
    !!info.deadAt
    && info.sessionType === 'thread_owner'  // only plain workers — excludes thread_guest and master_orchestrator
    && !info.suppressAutoRecover
    && !info.ephemeral
    && info.adapter.recoveryPlan(info).generic  // Codex: no — its runtime's start() reconnects it at boot; recoverOne would relaunch it as Claude
    && threadRegistry.has(info.threadId)
    && (!only || only.has(info.sessionId)),
  )
  const state = new Map(candidates.map(info => [info, tmuxSessionState(info.tmuxName)]))
  const deferred = candidates.filter(info => state.get(info) === 'not responding')
  try {
    await revive(candidates.filter(info => state.get(info) === 'dead'), gapMs)
  } finally {
    if (deferred.length > 0 && only) {
      process.stderr.write(`daemon: auto-recover: tmux still not responding; ${deferred.length} dead record(s) left dead; \`recover\` or the next boot retries them\n`)
    } else if (deferred.length > 0) {
      process.stderr.write(`daemon: auto-recover: tmux not responding; ${deferred.length} dead record(s) deferred to one more pass in ${TMUX_HOLD_MS / 1000}s\n`)
      const ids = new Set(deferred.map(info => info.sessionId))
      recoveryDeps.later(() => autoRecoverAfterBoot(gapMs, ids).catch(err => {
        process.stderr.write(`daemon: auto-recovery failed: ${err instanceof Error ? err.message : err}\n`)
      }), TMUX_HOLD_MS)
    }
  }
}

async function revive(deadInfos: SessionInfo[], gapMs: number | undefined): Promise<void> {
  if (deadInfos.length === 0) return

  const gapLabel = gapMs ? ` (${formatGap(gapMs)} gap)` : ''
  const promptPrefix = `You were recovered automatically after a system restart${gapLabel}. ${RECOVERY_REVERIFY_GUARD}`

  recoveryInProgress = true
  const results: Awaited<ReturnType<typeof recoverOne>>[] = []
  try {
    process.stderr.write(`daemon: auto-recover: ${deadInfos.length} dead session(s) to revive\n`)

    for (let i = 0; i < deadInfos.length; i += MAX_CONCURRENT) {
      const wave = deadInfos.slice(i, i + MAX_CONCURRENT)
      const settled = await Promise.allSettled(wave.map(async (info, j) => {
        if (j > 0) await new Promise(r => setTimeout(r, STAGGER_MS * j))
        return recoverLocked(info, toRecoverInput(info, promptPrefix))
      }))
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
        else results.push({ name: '(unknown)', method: 'failed', reason: String(s.reason) })
      }
    }
    await postAutoRecoverySummary(results, gapMs)
  } finally {
    recoveryInProgress = false
  }
}
