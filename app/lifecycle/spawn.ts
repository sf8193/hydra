import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { gateway, PLATFORM } from '../../infra/config.js'
import { parseSpawnTopic, resolveSpawnLabel } from '../../infra/util.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { RESTRICTED_PREAMBLE, startVerifying } from '../restricted.js'
import { PolicyRefusal } from '../../shared/launch-policy.js'
import { markDead, registry, threadRegistry } from '../../sessions/registry.js'
import { notifyParentOfEnd } from '../parent-notice.js'
import type { SessionMetadata, SpawnOpts, SpawnResult } from '../../sessions/registry.js'
import { clearPendingSessionToken, issueSessionToken, notePendingSessionToken } from '../../sessions/cli-caller.js'
import { clearPhaseBudget } from '../../sessions/phase-budget.js'
import { clearIdleLimit } from '../../sessions/idle-limit.js'
import { resolveLaunchSelection, spawnModel, withContextSuffix } from '../../shared/constants.js'
import type { SessionType } from '../../shared/constants.js'
import { resolveEngine } from '../../sessions/engine-instances.js'
import { engineProfile } from '../../shared/engines/index.js'
import { launchContinuationFrom, type EngineAdapter } from '../../engines/engine-adapter.js'
import { emojiOf } from '../../sessions/anchor-state.js'
import { resolveListenState, spawnToolNames } from './channel.js'
import {
  buildInitialPrompt, prepareSpawnWorkspace, recordAndAnnounceSpawn,
  resolveOrCreateThread, resolveSpawnPolicy, tellThread, verifyPolicyLaunch,
  type SpawnCarry, type SpawnOriginType,
} from './spawn-stages.js'

/** Unified session creation -- spawn, fork, and handoff all flow through here via SpawnOpts. */
export async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  // Before a thread is opened: a working dir that has gone away fails the spawn without leaving an empty thread.
  if (opts?.cwd && !existsSync(opts.cwd)) throw new Error(`working directory ${opts.cwd} does not exist`)
  // Validate continuation options up front before opening a thread or replacing a dead occupant.
  const continuation = launchContinuationFrom(opts)
  // One place decides the engine and the model it runs: a caller's explicit engine, else the one its model alias names (a specialist's
  // `model`, `hydra spawn --model`, a recipe), else claude. Alias or full id: an explicit engine reads the alias in its own table.
  const selected = opts?.model ? resolveLaunchSelection(opts.model, opts.engine) : undefined
  const engine = opts?.engine ?? selected?.engine ?? 'claude'

  // Lossless respawn: deliverables/description re-applied after the new record is
  // created (killSession discards the dead record). Seeded from an explicit
  // opts.carryOver (fallback tiers, where the record is gone), else snapshotted off
  // the replaced record in resolveOrCreateThread.
  const carry: SpawnCarry = {
    artifacts: opts?.carryOver?.artifacts,
    contextLinks: opts?.carryOver?.contextLinks,
    description: opts?.carryOver?.description,
    // A handoff names it; a recovered successor keeps the one its dead record had.
    predecessor: opts?.predecessor ?? opts?.carryOver?.predecessor,
    // Launch options a resumed or recovered session must keep: where it starts, what it may not edit.
    launchCwd: opts?.launchCwd ?? opts?.carryOver?.launchCwd,
    disallowedTools: opts?.disallowedTools ?? opts?.carryOver?.disallowedTools,
    // Authority: the spawner, or (resume/recovery/handoff) the dead record's parent, carried.
    parentId: opts?.parentId ?? opts?.carryOver?.parentId,
    initiator: opts?.initiator ?? opts?.carryOver?.initiator,
    // The record's own session name, for the remedy a refusal ends with.
    replacedName: opts?.carryOver?.sessionName,
    // Recovery: reuse the dead session's on-disk worktree rather than recreate one.
    // An explicit descriptor (opts.reuseWorktree) wins so fallback tiers can adopt it
    // even after the record it came from was deleted.
    reuseWorktree: opts?.reuseWorktree,
    // The launch policy of the conversation this start continues or replaces (resume, fork): see restricted.ts.
    // The records it continues or replaces, for resolvePolicy: what a recovery carries, then the record in the thread.
    actingRecords: [opts?.carryOver],
  }
  // The recovery orchestrator (recoverOne) reserves the predecessor's name in
  // registry.reservedNames across the whole cascade — protecting the preserved worktree
  // branch from a concurrent spawn's `branch -D` during the kill→persist window — so
  // doSpawnSession doesn't manage the reservation itself.

  // Flags come off before the topic becomes a thread name; opts beat the flag.
  const rawTopic = topic || 'session'
  const parsed = parseSpawnTopic(rawTopic)
  topic = parsed.topic || 'session'
  const worktreeTarget: string | undefined = opts?.worktree ?? parsed.worktree
  // rawTopic, not topic — the flag has been stripped out of the latter by here.
  const labelFields = resolveSpawnLabel(rawTopic, opts?.label, opts?.inheritedLabel)
  const sessionLabel = labelFields.label
  const phaseBudgetMs = opts?.phaseBudgetMs ?? parsed.budgetMs

  const sessionId = randomUUID()
  // A handoff is the same session continuing: its killed predecessor's name is free, so the successor keeps it.
  const replacing = opts?.existingThreadId ? registry.getByThread(opts.existingThreadId) : undefined
  const tmuxName = opts?.handedOffFrom ?? (opts?.name
    ? registry.claimSessionName(opts.name, replacing, s => occupancy(s) === 'dead')
    : registry.pickSessionName(opts?.reuseName && replacing ? { name: opts.reuseName, replacing } : undefined, threadRegistry.lastUsedByName()))
  // NOTE: the freshly-picked name is intentionally NOT held in registry.reservedNames.
  // The pick→registry.set window is short (recoverOne resolves slow worktree ops up front,
  // so nothing lengthy runs here) and shorter than the recovery wave's STAGGER, so same-wave
  // recoveries don't collide; and a genuine collision is self-healing — `tmux new-session`
  // fails cleanly on a duplicate name, the tier returns null, and recovery retries. Reserving
  // it here would instead leak the name on any throw before registry.set (no try/finally on
  // this large function), which is worse than the self-healing collision it would prevent.
  const cleanTopic = topic.replace(/\*\*/g, '').replace(/\*/g, '').replace(/[\[\]<>]/g, '').replace(/\s+/g, ' ').trim()
  const threadName = `${emojiOf({ tmuxName }, opts?.specialist)} ${cleanTopic || tmuxName} · ${tmuxName}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const isResume = !!opts?.resumeFrom
  const isResurrect = !!opts?.resurrectFrom
  const isJoin = !!opts?.joinThread
  const originType: SpawnOriginType = isFork ? 'fork' : isHandoff ? 'handoff' : isResurrect ? 'resurrect' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom ?? opts?.resurrectFrom
  const continuing = !!continuation

  // Stage 1: resolve/create thread and clean up any dead occupant.
  const thread = await resolveOrCreateThread(
    { chatId, messageId, tmuxName, threadName, originType, originFrom, worktreeTarget, isJoin, isResume },
    carry,
    opts,
  )

  // Stage 2: resolve launch policy and enforce engine/macOS sandbox gates.
  const { policy, restrictedPolicy, writeConfinedPolicy, kickoffHash, sessionName } = await resolveSpawnPolicy({
    threadId: thread.threadId, tmuxName, engine, isJoin, isHandoff, continuing, carry, opts,
  })

  // Stage 3: validate policy workdirs and prepare effectiveCwd / git worktree.
  const { spawnCwd, effectiveCwd, launchCwd, worktree } = await prepareSpawnWorkspace({
    threadId: thread.threadId, tmuxName, sessionName, continuing, worktreeTarget,
    reuseWorktree: carry.reuseWorktree, initialLaunchCwd: carry.launchCwd,
    restrictedPolicy, writeConfinedPolicy, opts,
  })

  // Stage 4: build initial prompt and resolve model.
  const { prompt, armFirstReply } = buildInitialPrompt({
    sessionId, tmuxName, threadId: thread.threadId, topic, engine, effectiveCwd, worktree,
    originFrom, carriedPredecessor: carry.predecessor, isHandoff, isFork, isResurrect, isResume, opts,
  })
  // Central model resolution (see `selected` above): callers can pass raw aliases (e.g. "sonnet", "astra") or full IDs.
  // Codex with no model picks its own default (it asks its app-server); the spawn default is a Claude id, which Codex cannot run. agy is given its
  // flash model (the one agy itself starts on, and every plan has it): it needs a model named, and the Claude spawn default is not one it should run.
  const { defaultModel, aliases } = engineProfile(engine)
  const model = selected?.model ?? (defaultModel === 'own' ? undefined : defaultModel === 'spawn' ? withContextSuffix(spawnModel()) : aliases[defaultModel.alias])

  // --- Launch via engine adapter ---
  // Private protocol children use this hook to install their fail-closed policy
  // before the process receives its prompt or can connect to bridge tools.
  opts?.beforeInitialTurn?.(sessionId)
  // The records a claimed name replaces are dead: stamp them, and stop their clocks, before the name runs again, or its
  // new execution reads as theirs and a reaper of theirs ends it.
  if (opts?.name && !opts.handedOffFrom) {
    for (const s of registry.values()) {
      if (s.tmuxName !== tmuxName || occupancy(s) !== 'dead') continue
      if (markDead(s)) notifyParentOfEnd(s, 'died from crash', 'process exited')
      clearIdleLimit(s.sessionId)
      clearPhaseBudget(s.sessionId)
    }
  }
  const adapter = resolveEngine(engine)
  const spawnType: SessionType = restrictedPolicy ? 'thread_owner' : opts?.sessionType ?? (isJoin ? 'thread_guest' : 'thread_owner')
  // Its token for the hydra CLI and bridge registration (cli-caller.ts): the session gets the token, its record only the hash.
  const issued = issueSessionToken()
  // Note the hash before launch so a bridge connecting before registry.set() is authenticated against it.
  notePendingSessionToken(sessionId, issued.hash)
  let launched: Awaited<ReturnType<EngineAdapter['launch']>>
  let now: number
  let url: string
  let sessionMetadata: SessionMetadata
  try {
    launched = await adapter.launch({
      sessionId, tmuxName, cwd: effectiveCwd, originalCwd: spawnCwd, model,
      // A restricted kickoff starts with hydra's fixed preamble: a prompt, not a control. Operator and non-specialist kickoffs are untouched.
      prompt: restrictedPolicy ? `${RESTRICTED_PREAMBLE} ${prompt}` : prompt, sessionToken: issued.token,
      worktreePath: worktree?.path, forkFromOriginalCwd: !!worktreeTarget,
      tools: opts?.tools, disallowedTools: carry.disallowedTools,
      ...(continuation && { continuation }),
      threadId: thread.threadId, sessionType: spawnType, ...(policy && { policy }),
    }).catch(async (err: unknown) => {
      // A refusal the launch itself makes (an old Claude Code, a folder it cannot make) is told to the thread, as the checks above are.
      if (writeConfinedPolicy && err instanceof PolicyRefusal && thread.threadId) await tellThread(thread.threadId, err.message)
      throw err
    })

    now = Date.now()
    sessionMetadata = {
      role: 'worker' as const,
      tools: spawnToolNames(adapter, restrictedPolicy ? 'restricted' : spawnType),
      model: launched.model,
      cwd: effectiveCwd,
      platform: PLATFORM,
    }
    url = await gateway.getThreadUrl(thread.threadId)

    if (restrictedPolicy || writeConfinedPolicy) startVerifying(sessionId)   // the record below is refused every message until its start passes (restricted.ts `unverified`)
    registry.set(sessionId, {
      sessionId, topic, threadId: thread.threadId, anchorMessageId: thread.anchorMessageId, anchorChannelId: thread.anchorChannelId,
      createdAt: now, lastActive: now,
      tmuxName, listening: resolveListenState(thread.threadId, thread.chatId), originType, originFrom, sessionMetadata,
      sessionType: spawnType,
      ...(policy && { policy }),
      ...(kickoffHash !== undefined && { kickoffHash }),
      ...labelFields,
      threadUrl: url || undefined,
      engine,
      ...launched.identity,
      ...(thread.respawnCount > 0 ? { respawnCount: thread.respawnCount } : {}),
      ...(thread.resumeCount > 0 ? { resumeCount: thread.resumeCount } : {}),
      ...(worktree && { worktree }),
      ...(launched.spawnLogPath ? { spawnLogPath: launched.spawnLogPath } : {}),
      ...(launched.exitFilePath ? { exitFilePath: launched.exitFilePath } : {}),
      ...(launched.stderrLogPath ? { stderrLogPath: launched.stderrLogPath } : {}),
      ...(launched.debugLogPath ? { debugLogPath: launched.debugLogPath } : {}),
      ...(launched.channelNote ? { channelNote: launched.channelNote } : {}),
      ...(engineProfile(engine).losesFirstTurnToExpiredLogin ? { spawnPrompt: prompt } : {}),
      initiator: carry.initiator,
      sessionTokenHash: issued.hash,
      bridgeToken: true,
      parentId: carry.parentId ?? null,
      ephemeral: opts?.ephemeral,
      ...(opts?.ephemeral && opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}),
      forceWorktreeCleanup: opts?.forceWorktreeCleanup,
      ...(phaseBudgetMs ? { budgetDeadline: now + phaseBudgetMs } : {}),
      ...(carry.predecessor ? { predecessor: carry.predecessor } : {}),
      ...(launchCwd ? { launchCwd } : {}),
      ...(carry.disallowedTools?.length ? { disallowedTools: carry.disallowedTools } : {}),
      adapter,
    })
  } finally {
    clearPendingSessionToken(sessionId)
  }
  // A claimed name took over from dead records of that name in other threads (a specialist that moved): retire them,
  // so a lookup by name finds this session, and boot recovery does not revive them into threads left behind.
  if (opts?.name) {
    for (const s of [...registry.values()]) {
      if (s.sessionId === sessionId || s.tmuxName !== tmuxName || occupancy(s) !== 'dead') continue
      registry.delete(s.sessionId)
      if (registry.getByThread(s.threadId) === s.sessionId) registry.deleteThread(s.threadId)
    }
    registry.persist()
  }

  // Stage 5: verify restricted or write-confined launch before routing messages to the thread.
  // A restricted session is checked against its policy from its own debug file, before its thread is handed to it (below: setThread):
  // no message reaches it through the thread until what it loaded is known to be what hydra.toml gives it. One that loaded anything
  // else, or whose file cannot be read, is stopped here (this launch's own session, by its id) and the start refuses.
  if (restrictedPolicy) {
    // The adapter says what its engine loaded; an engine that cannot say cannot run a restricted session (it is refused at the engine check above).
    await verifyPolicyLaunch({
      mode: 'restricted', specialist: restrictedPolicy.specialist,
      sessionId, tmuxName, threadId: thread.threadId, sessionName, debugLogPath: launched.debugLogPath,
      runCheck: () => adapter.verifyLaunch
        ? adapter.verifyLaunch(restrictedPolicy, launched)
        : Promise.resolve({ ok: false as const, why: `the ${engine} engine cannot check what it loaded` }),
    })
  }
  // A write-confined session is checked too, on what its settings should have applied (claude-verify.ts `verifyConfinement`): no message reaches it until
  // Claude Code's own record shows the rules, and one that does not show them is stopped and the start refuses with the cause.
  if (writeConfinedPolicy) {
    await verifyPolicyLaunch({
      mode: 'write-confined', specialist: writeConfinedPolicy.specialist,
      sessionId, tmuxName, threadId: thread.threadId, sessionName, debugLogPath: launched.debugLogPath,
      runCheck: () => adapter.verifyConfinement
        ? adapter.verifyConfinement(writeConfinedPolicy, launched)
        : Promise.resolve({ ok: false as const, why: `the ${engine} engine cannot check what it applied` }),
    })
  }

  // Stage 6: start timers, claim thread, apply carry-over, record history, and announce.
  recordAndAnnounceSpawn({
    sessionId, tmuxName, topic, engine, adapter, launched, url, sessionLabel, phaseBudgetMs,
    originType, originFrom, isJoin, armFirstReply, thread, carry, policy, kickoffHash, opts,
  })

  return { name: tmuxName, sessionId, threadId: thread.threadId, url }
}
