import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve as resolvePath } from 'path'
import { oneLine } from '../../shared/untrusted-text.js'
import { DEFAULT_SESSION_CHANNEL, ENV_FILE, gateway, PLATFORM } from '../../infra/config.js'
import { formatSpawnLine, safeSend } from '../../infra/util.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { occupied } from '../../sessions/occupancy.js'
import { browserProfileProblem, managedMcpNameClashes, unreadableWorkdir } from '../../config/write-confinement.js'
import { confinementRefusal, describePolicy, endVerifying, macosRefusal, missingTokenRefusal, resolvePolicy, verifyBackoff, verifyRefusal } from '../restricted.js'
import { PolicyRefusal, remedy, type LaunchPolicy } from '../../shared/launch-policy.js'
import { refusalNoticeKey, threadNotices } from '../../shared/notice-limit.js'
import { currentHydraConfig, hydraLoadEnv } from '../../infra/hydra-config.js'
import { workdirRestrictionIssues } from '../../config/restricted-workdir.js'
import { capturedSpawnVars } from '../../shared/spawn-env.js'
import { authorityId, registry, threadRegistry } from '../../sessions/registry.js'
import type { Predecessor, SessionInfo, SessionWorktree, SpawnOpts } from '../../sessions/registry.js'
import { ownsLineage, spawnIntoRefusal } from '../../sessions/lineage.js'
import { notePendingReply } from '../reply-guard.js'
import { transport } from '../../sessions/bridge-transport.js'
import { canAskPredecessor, pushToolSurface } from '../../sessions/tool-surface.js'
import { startPhaseBudget } from '../../sessions/phase-budget.js'
import { resumeIdleLimit } from '../../sessions/idle-limit.js'
import type { SessionLabel } from '../../shared/constants.js'
import { isRestricted, isRestrictedPolicy } from '../../shared/policy-record.js'
import { engineLimitsAccess, engineProfile } from '../../shared/engines/index.js'
import type { EngineAdapter, LaunchResult, ProviderId } from '../../engines/engine-adapter.js'
import { resumeHomeOwner } from '../../engines/codex-engine-adapter.js'
import { buildForkPrompt, buildHandoffPrompt, buildResurrectPrompt, buildSpawnPrompt } from '../../shared/prompts/session.js'
import { hydraPrompt } from '../../shared/prompts/request.js'
import { emojiOf, emojiOfName, refreshSessionVisual } from '../../sessions/anchor-state.js'
import { createWorktree } from '../../infra/worktree-manager.js'
import { buildWorktreePromptAppend, carryOver, claudeLaunchCwd, handoffArrival, nextResumeCount, preApproveClaudeTrust, resolveForkSpawnCwd, resolveSpawnChannel } from './channel.js'
import { killSession, restoreIfNotStarted } from './kill.js'

/** Tells a thread why a start was refused, at most once a minute per cause (threadNotices): a revive tries three tiers, each refused for the same cause. */
export async function tellThread(threadId: string, why: string): Promise<void> {
  if (!threadNotices.allow(refusalNoticeKey(threadId, why))) return
  await safeSend(threadId, `⚠️ ${why}`)
}

/** A start that must not happen: the thread is told why (once a minute per cause) and the start throws a PolicyRefusal, which no revive counts as a failure. */
async function refuseStart(threadId: string | undefined, why: string): Promise<never> {
  if (threadId) await tellThread(threadId, why)
  throw new PolicyRefusal(why)
}

/** When a start of each specialist was last stopped by verification, and why: it is not started again at once (see VERIFY_BACKOFF_MS). */
const verifyRefused = new Map<string, { at: number; why: string }>()
/** The back-off is per thread (one refused conversation does not block the specialist's others). */
const verifyKey = (specialist: string, threadId: string | undefined, sessionName: string): string => `${specialist}\n${threadId ?? sessionName}`
/** A verified start clears the specialist's refusals in every thread: health reports a refusal per specialist. */
function clearRefusals(specialist: string): void { for (const k of [...verifyRefused.keys()]) if (k.startsWith(`${specialist}\n`)) verifyRefused.delete(k) }
/** How long a refused launch stays on record for `hydra health`. Older ones go when the next is kept, so the map holds at most a day's refusals. */
const REFUSAL_KEEP_MS = 24 * 3_600_000
function keepRefusal(key: string, at: number, why: string): void {
  for (const [k, r] of verifyRefused) if (at - r.at > REFUSAL_KEEP_MS) verifyRefused.delete(k)
  verifyRefused.set(key, { at, why })
}

/** For `hydra health`: each restricted specialist whose last launch verification refused, the newest refusal of each, newest first. Never throws. */
export function refusedLaunches(now = verifyBackoff.now()): { specialist: string; why: string; ageMin: number }[] {
  const last = new Map<string, { at: number; why: string }>()
  for (const [k, r] of verifyRefused) {
    const specialist = k.split('\n')[0]
    if (now - r.at > REFUSAL_KEEP_MS) continue
    if (!last.has(specialist) || last.get(specialist)!.at < r.at) last.set(specialist, r)
  }
  return [...last].map(([specialist, r]) => ({ specialist, why: oneLine(r.why, 200), ageMin: Math.max(0, Math.round((now - r.at) / 60_000)) })).sort((a, b) => a.ageMin - b.ageMin)
}

/** Test seam: forget the verification refusals. */
export function _resetVerifyBackoff(): void { verifyRefused.clear() }
/** Test seam: how many refusals are kept. */
export const _refusalsKept = (): number => verifyRefused.size

/** Test seam: forget which refusals a thread was told. */
export function _resetRefusalNotices(): void { threadNotices.clear() }

const notAThreadId = (id: string): string =>
  `"${id}" is not a ${gateway.platform} thread id, so no session can sit in it (a session id or a name was passed where a thread id belongs)`

/** A thread the gateway made and then cannot address is no thread: what was made is removed, best effort, and the start fails. */
async function refuseMadeThread(id: string, anchor?: { channelId: string; messageId: string }): Promise<void> {
  if (gateway.isThreadId(id)) return
  try { await gateway.deleteThread?.(id) } catch {}
  if (anchor) try { await gateway.delete(anchor.channelId, anchor.messageId) } catch {}
  throw new Error(notAThreadId(id))
}

/**
 * A spawn into a thread that already exists, by its id or by the message it hangs on: when a session asked (`askedBy`) and the thread's
 * session has ended, only that thread's lineage may start a new one there (spawnIntoRefusal). Throws before anything is replaced.
 * True when the asker owns the thread's lineage: its new session continues that lineage, and keeps what the thread was made for.
 */
function refuseSpawnInto(threadId: string, opts: SpawnOpts | undefined): boolean {
  if (opts?.askedBy === undefined) return false
  const inThread = registry.get(registry.getByThread(threadId) ?? '')
  const refusal = spawnIntoRefusal(opts.askedBy, threadId, !!inThread && occupied(occupancy(inThread)))
  if (refusal) throw new Error(refusal)
  return ownsLineage(opts.askedBy, threadId)
}

export type SpawnCarry = {
  artifacts?: string[]
  contextLinks?: string[]
  description?: string
  predecessor?: Predecessor
  launchCwd?: string
  disallowedTools?: string[]
  parentId?: string | null
  initiator?: string
  replacedName?: string
  reuseWorktree?: SessionWorktree
  actingRecords: Array<Pick<SessionInfo, 'policy' | 'kickoffHash'> | undefined>
}

export type ResolvedThread = {
  threadId: string
  anchorMessageId?: string
  anchorChannelId?: string
  parentChannelId?: string
  hydraMadeThread: boolean
  ownerSpawnsInto: boolean
  rehomedFrom?: string
  respawnCount: number
  resumeCount: number
  chatId?: string
}

export type SpawnOriginType = 'spawn' | 'fork' | 'handoff' | 'resurrect'

/** Stage 1 of doSpawnSession: resolve/create the target thread, check Codex home ownership, clean up any dead occupant, and snapshot carry-over state. */
export async function resolveOrCreateThread(
  params: {
    chatId?: string
    messageId?: string
    tmuxName: string
    threadName: string
    originType: SpawnOriginType
    originFrom?: string
    worktreeTarget?: string
    isJoin: boolean
    isResume: boolean
  },
  carry: SpawnCarry,
  opts: SpawnOpts | undefined,
): Promise<ResolvedThread> {
  let { chatId } = params
  const { messageId, tmuxName, threadName, originType, originFrom, worktreeTarget, isJoin, isResume } = params
  let threadId: string | undefined
  let anchorMessageId: string | undefined
  let anchorChannelId: string | undefined
  let hydraMadeThread = false
  // The asker of a spawn into an ended thread owns that thread's lineage (refuseSpawnInto): its session continues the lineage.
  let ownerSpawnsInto = false

  // A thread to sit in again (resume, respawn, handoff, revive). A record that stored an id the gateway cannot address (a session id where a
  // thread id belongs) has no thread to go back to: its replacement gets a fresh one, under its parent's channel. Never a refusal: by now the
  // predecessor may already be killed, and a refusal would lose the session.
  let rehomedFrom: string | undefined
  if (opts?.existingThreadId) {
    if (gateway.isThreadId(opts.existingThreadId)) threadId = opts.existingThreadId
    else rehomedFrom = opts.existingThreadId
  }

  let respawnCount = 0
  const resumeCount = isResume ? nextResumeCount(registry.values(), opts!.resumeFrom!) : 0
  if (isJoin) {
    // Nothing is made yet, and nothing can be: a guest cannot join a thread the gateway cannot address.
    if (!gateway.isThreadId(opts!.joinThread!)) throw new Error(notAThreadId(opts!.joinThread!))
    threadId = opts!.joinThread!
  }

  if (rehomedFrom) {
    process.stderr.write(`daemon: spawn ${tmuxName}: "${rehomedFrom}" is not a ${gateway.platform} thread id; a fresh thread replaces it\n`)
    // Under the channel its parent's thread is in, else the default one (resolveSpawnChannel).
    chatId ??= (carry.parentId ? registry.get(carry.parentId)?.anchorChannelId : undefined)
  }

  // Determine where to create the thread
  let targetChannelId = chatId
  let parentChannelId: string | undefined
  if (!threadId) {
    const resolved = await resolveSpawnChannel(
      chatId, DEFAULT_SESSION_CHANNEL,
      id => gateway.fetchChannel(id),
      !!gateway.canThreadInDM,
    )
    targetChannelId = resolved.targetChannelId
    parentChannelId = resolved.parentChannelId ?? resolved.targetChannelId
    if (resolved.threadId) threadId = resolved.threadId
    if (threadId && !gateway.isThreadId(threadId)) throw new Error(notAThreadId(threadId))
    if (resolved.warning) process.stderr.write(`daemon: WARNING: ${resolved.warning}\n`)
    if (threadId) ownerSpawnsInto = refuseSpawnInto(threadId, opts)

    // Clean up dead session in this thread before spawning
    if (threadId) {
      const existingId = registry.getByThread(threadId)
      if (existingId) {
        const existing = registry.get(existingId)
        if (existing && !occupied(occupancy(existing))) {
          respawnCount = (existing.respawnCount ?? 0) + 1
          // Lossless respawn (mirror the existingThreadId branch): carry the dead
          // record's deliverables/description to the replacement. Worktree destruction
          // stays — a fresh non-recovery spawn onto a dead thread is a real replacement.
          carry.artifacts ??= existing.artifacts
          carry.contextLinks ??= existing.contextLinks
          carry.description ??= existing.description
          await killSession(existing, 'replaced by new spawn', { ended: 'killed by hydra', keepScratch: isResume || !!opts?.forkFrom, keepWatches: true })
        }
      }
    }

    // Create thread if we don't have one yet
    if (!threadId) {
      if (messageId && targetChannelId === chatId) {
        try {
          const thread = await gateway.createThread(targetChannelId!, threadName, {
            messageId,
            archiveDuration: 1440,
          })
          threadId = thread.id
          anchorMessageId = messageId
          anchorChannelId = targetChannelId!
        } catch (err: unknown) {
          // If thread already exists on this message, join it.
          // Discord thread IDs equal the parent message ID when created via startThread on a message.
          if ((err as { code?: unknown } | null)?.code === 'MessageExistingThread') {
            threadId = messageId
            anchorMessageId = messageId
            anchorChannelId = targetChannelId!
            process.stderr.write(`daemon: joined existing thread ${threadId} on message ${messageId}\n`)
          } else {
            process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
          }
        }
        if (threadId) await refuseMadeThread(threadId)
        // A thread on that message may already be one an ended session left (Discord says so by refusing to make another; Slack names the
        // same id it would make): checked here, once the id is known, before anything replaces its dead record.
        if (threadId) ownerSpawnsInto ||= refuseSpawnInto(threadId, opts)
      }

      if (!threadId) {
        const anchorText = originFrom
          ? `${threadName} — ${originType} from **${originFrom}**`
          : threadName
        const anchor = await gateway.send(targetChannelId!, anchorText)
        hydraMadeThread = true
        anchorMessageId = anchor.id
        anchorChannelId = targetChannelId!
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId: anchor.id,
          archiveDuration: 1440,
        })
        threadId = thread.id
        await refuseMadeThread(thread.id, { channelId: targetChannelId!, messageId: anchor.id })
      }
    }
  }

  // Codex resume adopts the original CODEX_HOME. Refuse if anything other than the
  // record being replaced owns that home —
  // launching would restart another owner's app-server. Throws before any mutation.
  if (opts?.resumeCodex) {
    const replacing = threadId ? registry.getByThread(threadId) : undefined
    const owner = resumeHomeOwner(registry.values(), opts.resumeCodex, replacing)
    if (owner) {
      throw new Error(`codex home ${opts.resumeCodex.homeName} is owned by ${owner.tmuxName} — cannot resume into it`)
    }
  }

  // Clean up dead session in this thread before spawning
  // Runs for all paths: existingThreadId, channel lookup, or spawn-in-dead-thread
  // A rehomed start (rehomedFrom) replaces the record that stored the unaddressable id, in the thread it now makes.
  if ((rehomedFrom ?? threadId) && !isJoin) {
    const existingId = registry.getByThread((rehomedFrom ?? threadId)!)
    if (existingId) {
      const existing = registry.get(existingId)
      if (existing) {
        if (occupied(occupancy(existing))) {
          throw new Error(`thread has a live session (${existing.tmuxName}) — kill it first or spawn in a new thread`)
        }
        respawnCount = (existing.respawnCount ?? 0) + 1
        if (!anchorMessageId && existing.anchorMessageId) {
          anchorMessageId = existing.anchorMessageId
          anchorChannelId = existing.anchorChannelId
        }
        // Carry the dead record's deliverables/description to the replacement — killSession
        // deletes the record, so snapshot before it runs (fixes lost PR/artifact links).
        // Explicit opts.carryOver (fallback tiers, where the record is already gone) wins.
        carry.artifacts ??= existing.artifacts
        carry.contextLinks ??= existing.contextLinks
        carry.description ??= existing.description
        carry.actingRecords.push(existing)
        carry.replacedName ??= existing.tmuxName
        // A resume continues the dead session itself. Other tiers (fork, respawn) name it
        // via carryOver; any other replacement has a different predecessor.
        if (opts?.resumeFrom || opts?.resumeCodex || opts?.resumeSession) {
          carry.predecessor ??= existing.predecessor
          carry.launchCwd ??= existing.launchCwd
          carry.disallowedTools ??= existing.disallowedTools
          if (carry.parentId === undefined) carry.parentId = authorityId(existing)
          carry.initiator ??= existing.initiator
        }
        // Recovery reuses the existing worktree in place; skip destruction so unpushed
        // work survives and --resume can find the transcript under the same CWD.
        // An explicit opts.reuseWorktree (fallback tiers) already covers this — only
        // derive from the record when one wasn't passed.
        if (!carry.reuseWorktree && opts?.preserveWorktree && existing.worktree && !worktreeTarget) carry.reuseWorktree = existing.worktree
        await killSession(existing, 'replaced by new spawn', { skipWorktreeDestroy: !!opts?.preserveWorktree, keepScratch: isResume || !!opts?.forkFrom, keepWatches: true })
      }
    }
    if (!anchorMessageId && threadId) {
      const thread = threadRegistry.get(threadId)
      if (thread?.anchorMessageId) {
        anchorMessageId = thread.anchorMessageId
        anchorChannelId = thread.anchorChannelId
      }
    }
    // Backfill anchorChannelId if still missing (e.g. spawning into a thread
    // via existingThreadId/joinThread whose prior occupant lacked it).
    if (!anchorChannelId && threadId) {
      try {
        const ch = await gateway.fetchChannel(threadId)
        if (ch.isThread && ch.parentId) {
          anchorChannelId = ch.parentId
          process.stderr.write(`daemon: backfilled anchorChannelId=${ch.parentId} from thread ${threadId}\n`)
        }
      } catch (err) {
        process.stderr.write(`daemon: WARNING: backfill anchorChannelId failed for thread ${threadId}: ${err}\n`)
      }
    }
  }

  return {
    threadId: threadId!, anchorMessageId, anchorChannelId, parentChannelId,
    hydraMadeThread, ownerSpawnsInto, rehomedFrom, respawnCount, resumeCount, chatId,
  }
}

export type RestrictedPolicy = Extract<LaunchPolicy, { restricted: true }>
export type WriteConfinedPolicy = LaunchPolicy & { canOnlyWriteTo: NonNullable<LaunchPolicy['canOnlyWriteTo']> }

export type ResolvedSpawnPolicy = {
  policy?: LaunchPolicy
  restrictedPolicy?: RestrictedPolicy
  writeConfinedPolicy?: WriteConfinedPolicy
  kickoffHash?: string
  sessionName: string
}

/** Stage 2 of doSpawnSession: resolve and validate LaunchPolicy (drift, engine capability, macOS sandbox gate) and derive kickoffHash. */
export async function resolveSpawnPolicy(params: {
  threadId: string
  tmuxName: string
  engine: ProviderId
  isJoin: boolean
  isHandoff: boolean
  continuing: boolean
  carry: SpawnCarry
  opts: SpawnOpts | undefined
}): Promise<ResolvedSpawnPolicy> {
  const { threadId, tmuxName, engine, isJoin, isHandoff, continuing, carry, opts } = params
  // The launch policy: decided once, at birth, from hydra.toml; a continuation (resume, fork) keeps the one its conversation was born with.
  // A start that cannot read or satisfy it refuses, in the thread, naming the cause and the fix: never the operator's account or spawn dir.
  let policy: LaunchPolicy | undefined
  const sessionName = carry.replacedName ?? tmuxName
  try {
    const r = resolvePolicy({ named: opts?.specialist, records: carry.actingRecords, sessionName, ...(!isJoin && { sits: { threadId, tmuxName } }) })
    if (continuing && r.drift.length) {
      // Not posted: the revive that asked moves on to the respawn tier, which is a new birth under hydra.toml as it is now.
      throw new Error(`specialist ${r.specialistId}: this conversation was born with ${describePolicy(r.stored)} and hydra.toml now says ${describePolicy(r.current)} (changed: ${r.drift.join('; ')}), so it is not resumed or forked. ${remedy(sessionName)}`)
    }
    policy = continuing ? (r.stored ?? r.current) : r.current
    // The engine comes from the thread's history, and `handoff <model>` can change it: only an engine that limits access can run a restricted or write-confined session.
    if (isRestrictedPolicy(policy) && !engineLimitsAccess(engine)) {
      throw new PolicyRefusal(`specialist ${policy.specialist} has restricted = true, which the ${engine} engine cannot give: set engine = "claude", or set restricted = false. ${remedy(sessionName)}`)
    }
    // The sandbox its servers run under is proven only on some macOS versions: refused here, where every start passes, never run on a guess.
    const unproven = macosRefusal(policy, sessionName)
    if (unproven) throw new PolicyRefusal(unproven)
    if (policy?.canOnlyWriteTo && !engineLimitsAccess(engine)) {
      throw new PolicyRefusal(`specialist ${policy.specialist} has can_only_write_to = "workdir", which the ${engine} engine cannot give (only Claude Code's own sandbox confines writes): set engine = "claude", or remove can_only_write_to. ${remedy(sessionName)}`)
    }
  } catch (err) {
    if (err instanceof PolicyRefusal && threadId) await tellThread(threadId, err.message)
    throw err
  }
  const restrictedPolicy = isRestrictedPolicy(policy) ? policy : undefined
  // `can_only_write_to`: the operator's account with writes confined to the workdir. Not a restricted session, but it starts in its folder, is checked, and takes no message until it passes.
  const writeConfinedPolicy: WriteConfinedPolicy | undefined = !restrictedPolicy && policy?.canOnlyWriteTo ? { ...policy, canOnlyWriteTo: policy.canOnlyWriteTo } : undefined
  // The kickoff the conversation was born under: a fresh start names its own; a resume or fork keeps the one it continues, and a
  // handoff successor keeps its predecessor's (it learns its role from the predecessor's letter, which is the old definition).
  const kickoffHash = continuing || isHandoff ? carry.actingRecords.find(r => r?.kickoffHash !== undefined)?.kickoffHash : opts?.kickoffHash
  return { policy, restrictedPolicy, writeConfinedPolicy, kickoffHash, sessionName }
}

/** Stage 3 of doSpawnSession: enforce restricted/write-confined workdir checks and resolve effectiveCwd, launchCwd, and git worktree. */
export async function prepareSpawnWorkspace(params: {
  threadId: string
  tmuxName: string
  sessionName: string
  continuing: boolean
  worktreeTarget?: string
  reuseWorktree?: SessionWorktree
  initialLaunchCwd?: string
  restrictedPolicy?: RestrictedPolicy
  writeConfinedPolicy?: WriteConfinedPolicy
  opts: SpawnOpts | undefined
}): Promise<{ spawnCwd: string; effectiveCwd: string; launchCwd?: string; worktree?: SessionWorktree }> {
  const { threadId, tmuxName, sessionName, continuing, worktreeTarget, reuseWorktree, restrictedPolicy, writeConfinedPolicy, opts } = params
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required -- set it to the working directory for spawned sessions')

  let worktree: SessionWorktree | undefined
  let effectiveCwd = spawnCwd
  // Only a fork or a resume continues a transcript filed under launchCwd. A fresh launch
  // (respawn) starts as usual — the dir may be a worktree that died with its session.
  let launchCwd = continuing ? params.initialLaunchCwd : undefined

  // A restricted session runs in its policy's workdir and nowhere else, whatever the caller passed or left out: its file tools reach
  // exactly the folder it starts in, so any other start (the operator's spawn dir, a worktree) would widen them. launch() holds
  // the same line; this keeps the record and the metadata telling the truth.
  if (restrictedPolicy) {
    const refuse = (why: string): Promise<never> => refuseStart(threadId, why)
    // A start whose verification stopped it a minute ago is not repeated per message: each would launch a session and wait to verify it.
    const lastStop = verifyRefused.get(verifyKey(restrictedPolicy.specialist, threadId, sessionName))
    if (lastStop && verifyBackoff.now() - lastStop.at < verifyBackoff.ms) await refuse(`specialist ${restrictedPolicy.specialist}: its last start was stopped ${Math.round((verifyBackoff.now() - lastStop.at) / 1000)}s ago and hydra waits ${verifyBackoff.ms / 1000}s before starting it again, so one message does not relaunch it each time (${lastStop.why}). Send another message after that. If this repeats, the cause is in Claude Code's setup or its debug file, not in hydra.toml.`)
    if (worktreeTarget || reuseWorktree) await refuse(`specialist ${restrictedPolicy.specialist} runs only in its workdir ${restrictedPolicy.workdir}: a restricted session never gets a git worktree: start it without one`)
    if (!existsSync(restrictedPolicy.workdir)) await refuse(`specialist ${restrictedPolicy.specialist}: its workdir ${restrictedPolicy.workdir} does not exist, so no restricted session starts: create it (or change workdir in hydra.toml). ${remedy(sessionName)}`)
    // The folder can change after hydra.toml loaded (a repository cloned into it, a symlink added): the load's checks run again.
    const why = workdirRestrictionIssues(hydraLoadEnv(), restrictedPolicy.workdir, currentHydraConfig().offLimits ?? [])
    if (why.length) await refuse(`specialist ${restrictedPolicy.specialist}: its workdir no longer passes the checks hydra.toml was loaded with, so no restricted session starts: ${why.join('; ')}. ${remedy(sessionName)}`)
    // A listed server's token variable must be set: checked here, with the other refusals, so the thread hears it.
    const noToken = missingTokenRefusal(restrictedPolicy, ENV_FILE, sessionName, process.env, capturedSpawnVars())
    if (noToken) await refuse(noToken)
    launchCwd = restrictedPolicy.workdir
    // The operator declared this folder in hydra.toml; without this a first launch there waits on Claude's trust dialog (as for any specialist workdir).
    preApproveClaudeTrust([restrictedPolicy.workdir], `workdir ${restrictedPolicy.workdir}`)
  }
  if (writeConfinedPolicy) {
    const w = writeConfinedPolicy.canOnlyWriteTo
    const refuse = (why: string): Promise<never> => refuseStart(threadId, why)
    const lastStop = verifyRefused.get(verifyKey(writeConfinedPolicy.specialist, threadId, sessionName))
    if (lastStop && verifyBackoff.now() - lastStop.at < verifyBackoff.ms) await refuse(`specialist ${writeConfinedPolicy.specialist}: its last start was stopped ${Math.round((verifyBackoff.now() - lastStop.at) / 1000)}s ago and hydra waits ${verifyBackoff.ms / 1000}s before starting it again (${lastStop.why}). Send another message after that.`)
    // Its writes are confined to the folder it starts in: a worktree, or any other start, would be a different folder (launch() holds the same line).
    if (worktreeTarget || reuseWorktree) await refuse(`specialist ${writeConfinedPolicy.specialist} can only write in its workdir ${w.workdir}: it never gets a git worktree: start it without one`)
    if (!existsSync(w.workdir)) await refuse(`specialist ${writeConfinedPolicy.specialist}: its workdir ${w.workdir} does not exist, so no session starts: create it (or change workdir in hydra.toml). ${remedy(sessionName)}`)
    // The folder can change after hydra.toml loaded (a link added into a place the layer denies): the load's check runs again, on resolved paths.
    const inside = unreadableWorkdir(w.workdir, w.cannotRead, hydraLoadEnv().realpath)
    if (inside) await refuse(`specialist ${writeConfinedPolicy.specialist}: its workdir ${w.workdir} is, or now holds, ${inside}, which the layer denies reading, so it could not read its own folder and no session starts. ${remedy(sessionName)}`)
    // A managed MCP config (managed-mcp.json) is admitted without being listed and takes exclusive control, so a server of a listed name there would run in the listed one's place, and the start check sees names only. Checked again here because the file can change after the load. (The operator's own config is not admitted: its server has another command.)
    const probe = managedMcpNameClashes(hydraLoadEnv(), w.servers.map(x => x.name))
    if (probe.clashes.length) await refuse(`specialist ${writeConfinedPolicy.specialist}: ${probe.clashes.map(c => `${c.file} already declares an MCP server named ${c.name}`).join('; ')}; Claude Code's own text says a managed MCP config's servers are admitted without listing them (not shown live), so that one could run in place of the server hydra starts, and no session starts: rename it in hydra.toml. ${remedy(sessionName)}`)
    // A file that cannot be read is not "no clash": the start fails closed.
    if (probe.unreadable.length) await refuse(`specialist ${writeConfinedPolicy.specialist}: ${probe.unreadable.map(u => u.why).join('; ')}, so hydra cannot tell whether it declares an MCP server named like a listed one (Claude Code's own text says a managed MCP config's servers are admitted without listing them (not shown live)), and no session starts: fix or remove the file. ${remedy(sessionName)}`)
    // A named browser profile must still resolve inside the workdir (a link added after the load could lead out of it).
    const profileWhy = w.browserProfile === undefined ? undefined : browserProfileProblem(w.workdir, w.browserProfile, hydraLoadEnv().realpath, w.cannotRead)
    if (profileWhy) await refuse(`specialist ${writeConfinedPolicy.specialist}: ${profileWhy}, so no session starts. ${remedy(sessionName)}`)
    // A listed server's token variable must be set: checked here, with the other refusals, so the thread hears it.
    const noToken = missingTokenRefusal({ specialist: writeConfinedPolicy.specialist, servers: w.servers }, ENV_FILE, sessionName, process.env, capturedSpawnVars())
    if (noToken) await refuse(noToken)
    launchCwd = w.workdir
    preApproveClaudeTrust([w.workdir], `workdir ${w.workdir}`)
  }
  if (launchCwd) {
    // A fork (and its resume) must start where its source started, or --resume can't find the transcript.
    if (!existsSync(launchCwd)) throw new Error(`cannot fork: the source's launch directory ${launchCwd} no longer exists`)
    effectiveCwd = launchCwd
  } else if (reuseWorktree) {
    // Recovery adopts the dead session's worktree in place. reviveThread (resolveWorktree) has
    // already resolved availability (reattached the dir, or refused) BEFORE this cascade — so the
    // dir is expected to exist here. If it doesn't (sub-second race: removed between that
    // check and now), throw rather than fall back to spawnCwd: a recovered autonomous agent
    // must never run in the shared main checkout, and a live record whose worktree isn't
    // there would let a later non-recovery kill `branch -D` the branch. The throw fails this
    // tier; restoreIfNotStarted puts the dead record back, for a later revive to retry.
    if (!existsSync(reuseWorktree.path)) {
      throw new Error(`worktree ${reuseWorktree.path} unavailable at spawn (branch ${reuseWorktree.branch} preserved) — deferring recovery`)
    }
    worktree = reuseWorktree
    effectiveCwd = reuseWorktree.path
    process.stderr.write(`daemon: spawn ${tmuxName}: reusing worktree ${worktree.path} (branch ${worktree.branch})\n`)
  } else if (worktreeTarget) {
    const wt = await createWorktree({
      repoName: worktreeTarget,
      spawnCwd,
      branchName: opts?.worktreeBranchSuffix ? `wt/${tmuxName}-${opts.worktreeBranchSuffix}` : `wt/${tmuxName}`,
      dirSuffix: `${worktreeTarget}-${tmuxName}`,
    })

    worktree = { repo: wt.repoDir, path: wt.worktreePath, branch: wt.branch }
    effectiveCwd = wt.worktreePath

    // Pre-approve Claude trust for the worktree paths (Claude-specific, not git)
    preApproveClaudeTrust([wt.worktreePath, wt.repoDir], 'worktree paths')
  } else if (opts?.cwd) {
    // A specialist's workdir (checked at the top too: the folder can go away after hydra.toml loaded). It is also
    // the launch dir, recorded on the session, so a resume or fork of it starts here, where its transcript is filed.
    effectiveCwd = opts.cwd
    launchCwd = opts.cwd
    // The operator chose this folder in hydra.toml; without this a first launch there waits on Claude's trust dialog.
    // Never a whole home folder or the disk: trusting those would cover everything (the loader warns about them).
    const broad = [homedir(), '/'].map(p => resolvePath(p)).includes(resolvePath(opts.cwd))
    if (!broad) preApproveClaudeTrust([opts.cwd], `workdir ${opts.cwd}`)
  }

  return { spawnCwd, effectiveCwd, launchCwd, worktree }
}

/** Stage 4 of doSpawnSession: build the initial prompt (handoff, fork, resurrect, custom, or fresh spawn) and determine armFirstReply. */
export function buildInitialPrompt(params: {
  sessionId: string
  tmuxName: string
  threadId: string
  topic: string
  engine: ProviderId
  effectiveCwd: string
  worktree?: SessionWorktree
  originFrom?: string
  carriedPredecessor?: Predecessor
  isHandoff: boolean
  isFork: boolean
  isResurrect: boolean
  isResume: boolean
  opts: SpawnOpts | undefined
}): { prompt: string; armFirstReply: boolean } {
  const { sessionId, tmuxName, threadId, topic, engine, effectiveCwd, worktree, originFrom, carriedPredecessor, isHandoff, isFork, isResurrect, isResume, opts } = params
  const promptParams = { sessionId, tmuxName, threadId, topic, topicIsRequest: opts?.topicIsRequest }
  let prompt: string
  let armFirstReply = false
  if (opts?.promptBuilder) {
    prompt = opts.promptBuilder(sessionId, tmuxName)
  } else if (isHandoff) {
    const hasPredecessor = !!carriedPredecessor && engineProfile(carriedPredecessor.engine).forkable
    const arrival = handoffArrival(opts ?? {}, { from: originFrom!, session: tmuxName, cwd: effectiveCwd, worktree: worktree?.path ?? '', branch: worktree?.branch ?? '' })
    prompt = buildHandoffPrompt({ ...promptParams, originFrom: originFrom!, artifact: opts?.artifact, note: opts?.handoffNote, arrival, hasPredecessor, canAsk: canAskPredecessor({ engine, predecessor: carriedPredecessor }) })
  } else if (isFork) {
    prompt = buildForkPrompt({ ...promptParams, originFrom: originFrom! })
  } else if (isResurrect) {
    prompt = buildResurrectPrompt({ ...promptParams, topicIsKickoff: opts?.kickoffHash !== undefined })
  } else {
    prompt = buildSpawnPrompt(promptParams)
    // Only a new thread's spawn is a user request; recovery and respawn reuse a thread (and a stale anchor).
    armFirstReply = !isResume && !opts?.resumeCodex && !opts?.existingThreadId
  }

  if (opts?.promptPrefix) {
    prompt = `${opts.promptPrefix}\n\n${prompt}`
  }
  return { prompt: hydraPrompt(prompt), armFirstReply }
}

/** Stage 5 of doSpawnSession: verify a restricted or write-confined launch from its debug log before routing messages to it. */
export async function verifyPolicyLaunch(params: {
  mode: 'restricted' | 'write-confined'
  specialist: string
  sessionId: string
  tmuxName: string
  threadId: string
  sessionName: string
  debugLogPath?: string
  runCheck: () => Promise<{ ok: true } | { ok: false; why: string }>
}): Promise<void> {
  const { mode, specialist, sessionId, tmuxName, threadId, sessionName, debugLogPath, runCheck } = params
  const words = mode === 'restricted'
    ? {
        checkLabel: 'launch verification',
        verb: 'loaded',
        killReason: 'stopped: it did not load what its launch policy allows',
        killOpts: { ended: 'killed by hydra' as const, keepWatches: true },
        sessionAdj: 'unverified',
        refusal: (why: string) => verifyRefusal(specialist, sessionName, why),
        successLine: `daemon: spawn ${tmuxName}: launch verified against its policy from ${debugLogPath}\n`,
      }
    : {
        checkLabel: 'confinement check',
        verb: 'applied',
        killReason: 'stopped: it did not apply the write confinement its launch policy gives',
        killOpts: { keepWatches: true },
        sessionAdj: 'unchecked',
        refusal: (why: string) => confinementRefusal(specialist, sessionName, why),
        successLine: `daemon: spawn ${tmuxName}: write confinement applied, from ${debugLogPath}\n`,
      }
  let verdict: { ok: true } | { ok: false; why: string }
  try {
    verdict = await runCheck()
  } catch (err) {
    // A check that cannot run is a check that did not pass: the session is stopped like any other refused start.
    process.stderr.write(`daemon: spawn ${tmuxName}: ${words.checkLabel} threw: ${err}\n`)
    verdict = { ok: false, why: `the check itself failed to run, so what it ${words.verb} is unknown` }
  } finally { endVerifying(sessionId) }
  if (!verdict.ok) {
    keepRefusal(verifyKey(specialist, threadId, sessionName), verifyBackoff.now(), verdict.why)
    process.stderr.write(`daemon: spawn ${tmuxName}: ${words.checkLabel} refused: ${verdict.why}\n`)
    const created = registry.get(sessionId)
    if (created && created.sessionId === sessionId) {
      await killSession(created, words.killReason, words.killOpts).catch((err: unknown) =>
        process.stderr.write(`daemon: spawn ${tmuxName}: could not stop the ${words.sessionAdj} session ${sessionId}: ${err}\n`),
      )
    }
    await refuseStart(threadId, words.refusal(verdict.why))
  }
  // The marker the delivery gate reads: persisted, so a restart keeps a verified session reachable and leaves an unfinished one not.
  const created = registry.get(sessionId)
  if (created && created.sessionId === sessionId) { created.verified = true; registry.persist() }
  clearRefusals(specialist) // it starts now: health no longer reports a refusal for it
  process.stderr.write(words.successLine)
}

/** Stage 6 of doSpawnSession: start timers, claim thread ownership, apply lossless carry-over, record thread history, and post announcements. */
export function recordAndAnnounceSpawn(params: {
  sessionId: string
  tmuxName: string
  topic: string
  engine: ProviderId
  adapter: EngineAdapter
  launched: Awaited<ReturnType<EngineAdapter['launch']>>
  url: string
  sessionLabel?: SessionLabel
  phaseBudgetMs?: number
  originType: SpawnOriginType
  originFrom?: string
  isJoin: boolean
  armFirstReply: boolean
  thread: ResolvedThread
  carry: SpawnCarry
  policy?: LaunchPolicy
  kickoffHash?: string
  opts: SpawnOpts | undefined
}): void {
  const { sessionId, tmuxName, topic, engine, adapter, launched, url, sessionLabel, phaseBudgetMs, originType, originFrom, isJoin, armFirstReply, thread, carry, policy, kickoffHash, opts } = params
  const { threadId, anchorMessageId, anchorChannelId, parentChannelId, hydraMadeThread, ownerSpawnsInto, rehomedFrom, respawnCount, chatId } = thread

  if (phaseBudgetMs) startPhaseBudget(sessionId)
  if (opts?.ephemeral) resumeIdleLimit(sessionId)
  // A bridge that registered before the record existed was given the tools of a session without a predecessor.
  if (carry.predecessor && adapter.channel === 'bridge') pushToolSurface(sessionId)
  // Thread ownership: setThread claims the thread for message routing. Only the
  // thread OWNER calls setThread — join members (protocol critics, guest agents)
  // use addMember and must never touch the mapping, or they'd hijack routing.
  if (!isJoin) {
    registry.setThread(threadId, sessionId)
    // The spawn prompt is a request like any user message: a text-only first answer must still reach the thread.
    if (armFirstReply && anchorMessageId) notePendingReply(sessionId, { chat_id: threadId, message_id: anchorMessageId, user: opts?.initiator ?? '' })
  } else {
    registry.addMember(threadId, sessionId, opts?.memberLabel)
  }

  // Lossless respawn: re-apply the replaced record's deliverables/description so
  // the dashboard row keeps its PR/artifact links across respawns. Reset
  // artifactsBackfilled so a later boot's history-rescan re-derives links.
  if (carry.artifacts?.length || carry.contextLinks?.length || carry.description) {
    const created = registry.get(sessionId)
    if (created) {
      if (carry.artifacts?.length) created.artifacts = carry.artifacts
      if (carry.contextLinks?.length) created.contextLinks = carry.contextLinks
      if (carry.description && !created.description) created.description = carry.description
      delete created.artifactsBackfilled
    }
  }

  registry.persist()

  if (!isJoin) {
    // Who spawned it, by thread: the spawner's session may be gone by the time anyone asks, and a handoff successor shares its thread.
    // A start that continues the thread's session (handoff, resurrect) whose spawner's record is gone keeps what the thread already says.
    const continues = originType === 'handoff' || originType === 'resurrect'
    // A guest in a thread has no thread of its own to answer from (its record's threadId is its host's): its children name none.
    const spawner = carry.parentId ? registry.get(carry.parentId) : undefined
    const spawnerThread = (spawner && spawner.sessionType !== 'thread_guest' ? spawner.threadId : undefined)
      ?? (continues ? threadRegistry.get(threadId)?.sessionHistory.findLast(h => h.spawnerThreadId)?.spawnerThreadId : undefined)
    threadRegistry.recordSpawn(threadId, {
      anchorMessageId, anchorChannelId, threadUrl: url || undefined, topic, respawnCount,
      sessionId, tmuxName, originType, originFrom, model: launched.model, parentChannelId,
      label: sessionLabel,
      claudeSessionId: launched.identity.claudeSessionId,
      codexThreadId: launched.identity.codexThreadId,
      codexHomeName: launched.identity.codexHomeName,
      engine,
      ...(policy && { policy }),
      ...(kickoffHash !== undefined && { kickoffHash }),
      ...(hydraMadeThread && { hydraMade: true }),
      ...(spawnerThread && { spawnerThreadId: spawnerThread }),
      // Sitting in the thread again (resume, respawn, revive, handoff) continues its session, as does a spawn into it by the owner of
      // its lineage (who could destroy it anyway); a spawn into it by anyone else (main, the operator) does not.
      continuesThread: (!!opts?.existingThreadId && !rehomedFrom) || ownerSpawnsInto,
    })
  }

  const spawnLine = formatSpawnLine({
    roleLabel: opts?.memberLabel,
    emoji: emojiOfName(tmuxName),
    name: tmuxName,
    model: launched.model,
    trigger: opts?.trigger ?? originType,
    initiator: opts?.initiator,
  })

  refreshSessionVisual(threadId, { state: respawnCount > 0 ? 'respawned_session' : 'live' })

  const guestNote = isJoin ? '\n_↳ guest agent in thread_' : ''
  void safeSend(threadId, spawnLine + guestNote).then(ids => {
    if (ids.length > 0) {
      const info = registry.get(sessionId)
      if (info) info.spawnAnnounceId = ids[0]
    }
  })
  // Echo to the causing thread — but only when it IS a thread we track
  // (a session or protocol thread). A plain channel already shows the new
  // thread's anchor; echoing there would double-announce.
  if (chatId && chatId !== threadId && (registry.getByThread(chatId) || threadRegistry.get(chatId))) {
    void safeSend(chatId, spawnLine)
  }
}

