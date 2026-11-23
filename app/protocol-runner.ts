import { registry } from '../sessions/registry.js'
import { safeSend } from '../infra/util.js'
import { formatRoundBadge, refreshSessionVisual } from '../sessions/anchor-state.js'
import { registerProtocol } from '../sessions/protocol-registry.js'
import type { Protocol } from '../protocols/dsl.js'
import { withDefaultLenses, type Modifier } from '../protocols/modifiers.js'
import {
  formatAdvanceUsagePattern, getActiveRuns, getProtocolContext,
  getRunAndRole, getRunByThread, halfForPhase, HEALTH_CHECK_INTERVAL_MS, IDLE_ESCALATE_MS,
  IDLE_NUDGE_MS, isTerminal, MAX_EXTENSIONS_PER_PHASE, pendingPrivateProtocolChildren,
  privateProtocolChildren, protocolEvents, resetRunnerLifecycle, resolveAdvanceEvent, runs,
  sessionToRun, setRunnerLifecycle, threadToRun, TOTAL_PHASE_CAP_FACTOR, transitioningRuns,
  WARNING_BEFORE_TIMEOUT_MS, type ProtocolRun,
} from './protocol/state.js'
import {
  advancePhase, finishPrivateChildLaunch, markPrivateChildLaunching, registerChild,
  registerChildResult, registerParticipant, releasePrivateChildWhenGone, retireProtocolChildren,
  setProtocolTools, setRunTools, validateDelegatedBuildVerification, validateRequestedReviewLenses,
} from './protocol/tools.js'
import {
  notifyActorOfTimeout, notifyKickoff, notifyNextActor, notifyParticipant, postStatusLine,
} from './protocol/notify.js'
import {
  afterTransition, cancelRun, enterDirectSubagentPhase, enterFallbackPhase, onRunDisconnect,
  resetTimeout, runHealthCheck, spawnRole, startHealthMonitor,
} from './protocol/transitions.js'

export type { ProtocolRun } from './protocol/state.js'
export { formatAdvanceUsagePattern, getActiveRuns, getProtocolContext, getRunByThread, protocolEvents } from './protocol/state.js'
export { cancelRun, onRunDisconnect } from './protocol/transitions.js'

export async function startProtocolRun(
  proto: Protocol,
  threadId: string,
  ownerSessionId: string,
  params: { rounds?: number; topic?: string; model?: string; [key: string]: unknown } = {},
): Promise<ProtocolRun> {
  if (threadToRun.has(threadId)) throw new Error(`A ${proto.display} is already running in this thread`)
  params = withDefaultLenses(params)

  const id = crypto.randomUUID()
  const rounds = (params.rounds as number) ?? 3

  const run: ProtocolRun = {
    id,
    protocol: proto,
    threadId,
    ownerSessionId,
    phase: params.skipClarify && proto.roundPhase !== proto.initialPhase ? proto.roundPhase : proto.initialPhase,
    currentRound: 1,
    rounds,
    startedAt: Date.now(),
    params,
    participants: new Map(),
    sessionToRole: new Map(),
    protocolChildren: new Map(),
    timeout: undefined,
    _extensions: 0,
    _phaseStartedAt: Date.now(),
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
    statusHistory: [],
    strike: !!(params.strike ?? false),
  }

  runs.set(id, run)
  threadToRun.set(threadId, id)
  sessionToRun.set(ownerSessionId, id)

  const ownerRole = proto.ownerRole
  if (ownerRole) {
    registerParticipant(run, ownerRole, ownerSessionId)
  }

  refreshSessionVisual(threadId, { badge: formatRoundBadge(proto.emoji, halfForPhase(run), run.currentRound, run.rounds) })

  const mods = params.modifiers as Modifier[] | undefined
  const modSuffix = mods?.length ? ` ${mods.map(m => `+${m.name}`).join(' ')}` : ''
  const topicLine = params.topic ? `\nFocus: **${params.topic}**${modSuffix}` : modSuffix ? `\nFocus:${modSuffix}` : ''
  // A direct start skips straight to the owner-run phase, so there is no
  // exchange to count — announcing "3 rounds" directly above a message saying
  // nobody was spawned leaves the reader to reconcile the two.
  const displayName = params.directSubagent ? 'Subagent Review' : proto.display
  const scale = params.directSubagent ? `owner-run, no rounds` : `up to ${rounds} round${rounds > 1 ? 's' : ''}`
  const annIds = await safeSend(threadId, `**${displayName}** — ${scale}${topicLine}`)
  run.messageIds.push(...annIds)

  // `+subagent`: the caller asked for the owner-run fallback phase up front, so
  // there is no participant to spawn and no kickoff to send — the kickoff's job
  // is to tell the owner that a critic is orienting. It reaches that phase
  // through the protocol's own `fallback` transition rather than by staging a
  // death, so a protocol that declares no fallback path simply cannot be asked
  // for one.
  // Same shape as the spawn loop below: a start that cannot finish must not
  // leave a half-live run holding the thread. Cancel, then let the caller report.
  if (params.directSubagent) {
    try {
      if (!(await enterDirectSubagentPhase(run))) {
        throw new Error(`${proto.display} does not support +subagent`)
      }
    } catch (err) {
      process.stderr.write(`daemon: ${proto.name} run: direct subagent start failed: ${err}\n`)
      await cancelRun(run, 'direct subagent start failed')
      throw err
    }
    return run
  }

  try {
    for (const [role] of Object.entries(proto.roles)) {
      if (role === ownerRole) continue
      await spawnRole(run, role, params)
    }
  } catch (err) {
    process.stderr.write(`daemon: ${proto.name} run: spawn failed: ${err}\n`)
    await cancelRun(run, 'spawn failed')
    throw err
  }

  await postStatusLine(run)
  resetTimeout(run)
  notifyKickoff(run)

  return run
}

// ---------------------------------------------------------------------------
// Reply handler — conversational only, never advances the protocol
// ProtocolHooks.onReply is a required interface — this stub satisfies it.
// v2 reply is purely conversational; advancement happens via advance().

export async function onRunReply(_sessionId: string, _text: string, _chatId: string, _sentMessageIds: string[]): Promise<void> {}

// ---------------------------------------------------------------------------
// Advance handler — the single protocol interaction tool
// ---------------------------------------------------------------------------

export async function onRunAdvance(sessionId: string, content: string, verdict?: string): Promise<{ ok: true; sentIds: string[] } | { ok: false; reason: string }> {
  const lookup = getRunAndRole(sessionId)
  if (!lookup) return { ok: false, reason: 'no active protocol run' }
  const { run, role } = lookup

  const phaseDef = run.protocol.phases[run.phase]
  if (!phaseDef) return { ok: false, reason: `unknown phase "${run.phase}"` }

  if (phaseDef.actor !== role) {
    return { ok: false, reason: `not your turn (current actor: ${phaseDef.actor}, caller: ${role})` }
  }

  if (run.protocol.name === 'delegated-build' && run.phase === 'verifying' && verdict === 'step_passed') {
    const proofError = validateDelegatedBuildVerification(run, content)
    if (proofError) return { ok: false, reason: proofError }
  }

  if (run.protocol.name === 'review' && (run.phase === 'critic_turn' || run.phase === 'subagent_review')) {
    const lensError = validateRequestedReviewLenses(run, content, verdict)
    if (lensError) return { ok: false, reason: lensError }
  }

  const ia = run.protocol.phaseInteraction(run.phase)
  if (!ia) return { ok: false, reason: `phase "${run.phase}" does not accept advance()` }

  // Validate verdict against phase constraint
  if (verdict) {
    if (ia.verdict === 'none') {
      return { ok: false, reason: `phase "${run.phase}" does not accept a verdict — call advance without verdict` }
    }
    if (!ia.options?.includes(verdict)) {
      return { ok: false, reason: `invalid verdict "${verdict}" (expected: ${ia.options?.join(' | ') ?? 'unknown'})` }
    }
  } else if (ia.verdict === 'required') {
    return { ok: false, reason: `phase "${run.phase}" requires a verdict (options: ${ia.options?.join(' | ') ?? 'unknown'})` }
  }

  // Resolve the event to fire
  const event = resolveAdvanceEvent(run, verdict)
  if (!event) return { ok: false, reason: 'could not resolve transition event' }

  if (transitioningRuns.has(run.id)) return { ok: false, reason: 'transition in progress' }
  transitioningRuns.add(run.id)

  try {
    const advancePhaseFrom = run.phase
    const result = run.protocol.machine.transition(advancePhaseFrom, event)
    if (!result.ok) return { ok: false, reason: `transition failed from "${advancePhaseFrom}" on "${event}"` }

    // Advance state before posting — if safeSend fails, the agent retries
    // without double-posting content that was already delivered.
    if (run.timeout) clearTimeout(run.timeout)
    if (!advancePhase(run, result.to, advancePhaseFrom)) {
      return { ok: false, reason: 'phase advance failed (concurrent transition)' }
    }

    if (verdict) {
      run.decisions.push({ phase: advancePhaseFrom, role, value: verdict, because: content })
    }

    if (result.to === run.protocol.roundPhase && advancePhaseFrom !== run.protocol.roundPhase && advancePhaseFrom !== run.protocol.initialPhase) {
      run.currentRound++
    }

    // Post content to thread — after state advance so a safeSend failure
    // doesn't leave the agent thinking advance failed when state moved.
    const sentIds = await safeSend(run.threadId, content)
    // Capture the closing summary whenever the owner advances INTO terminal
    // completion, not only from the cleanup phase — the subagent_review phase
    // also ends at `complete` and its summary must reach CompletionEvent.summary
    // (CompletionEvent.summary). A non-terminal advance is a
    // mid-run post and joins messageIds.
    if (isTerminal(run) && result.to !== run.protocol.cancelPhase) {
      run.summary = content
    } else {
      run.messageIds.push(...sentIds)
    }

    // A terminal review result needs no deferred critic fallback. Clear the
    // marker before completion, just as the non-terminal cleanup path does.
    if (isTerminal(run)) run._pendingFallback = undefined
    await afterTransition(run, advancePhaseFrom, content)

    // Deferred fallback: a non-owner died during a phase without on.fallback
    // (e.g. owner_turn). Now that the owner has advanced to a new phase, check
    // if that phase has on.fallback and fire it.
    if (run._pendingFallback && !isTerminal(run)) {
      const pending = run._pendingFallback
      if (run.protocol.phases[run.phase]?.on?.fallback) {
        run._pendingFallback = undefined
        // enterFallbackPhase commits the phase transition in its synchronous
        // prefix (before its only await, the kill) — see the "no await before the
        // transition" invariant in that function. All four call sites, including
        // this one, `void` it and rely on that: the subagent_review transition is
        // in effect the moment control returns here. Do not add an early await to
        // enterFallbackPhase without revisiting these call sites.
        void enterFallbackPhase(run, pending)
      } else if (run.phase === run.protocol.cleanupPhase) {
        // Cleanup is the normal successful off-ramp. There is no future actor
        // phase where a deferred fallback should fire.
        run._pendingFallback = undefined
      } else if (!run.protocol.deferFallbackAcrossPhases) {
        // Most protocols retain the historical phase-local behavior. Only a
        // protocol that explicitly needs a later fallback opportunity may
        // carry the marker through an intervening owner phase.
        run._pendingFallback = undefined
      }
      // Opted-in protocols retain the marker until a fallback-capable phase
      // or terminal cleanup.
    }

    return { ok: true, sentIds }
  } finally {
    transitioningRuns.delete(run.id)
  }
}

export function onRunExtend(sessionId: string, reason: string, minutes: number): { ok: boolean; reason?: string } {
  const lookup = getRunAndRole(sessionId)
  if (!lookup) return { ok: false, reason: 'no active protocol run' }
  const { run, role } = lookup

  const phaseDef = run.protocol.phases[run.phase]
  if (phaseDef?.actor !== role) {
    return { ok: false, reason: `only the active actor can extend (current: ${phaseDef?.actor}, caller: ${role})` }
  }

  if (run._extensions >= MAX_EXTENSIONS_PER_PHASE) {
    return { ok: false, reason: `max extensions reached (${MAX_EXTENSIONS_PER_PHASE} per phase)` }
  }

  run._extensions++
  run.decisions.push({ phase: run.phase, role, value: 'extend', because: reason, context: `+${minutes}m` })
  resetTimeout(run)
  setProtocolTools(run, sessionId)

  const info = registry.get(sessionId)
  const name = info?.tmuxName ?? sessionId.slice(0, 8)
  void safeSend(run.threadId, `_⏳ ${name} requested +${minutes}m: ${reason} (${run._extensions}/${MAX_EXTENSIONS_PER_PHASE})_`)
  process.stderr.write(`daemon: ${run.protocol.name} run: ${name} extended phase "${run.phase}" +${minutes}m (${run._extensions}/${MAX_EXTENSIONS_PER_PHASE}): ${reason}\n`)

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Disconnect / reconnect
// ---------------------------------------------------------------------------

export function onRunReconnect(sessionId: string): void {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return
  const run = runs.get(runId)
  if (!run) return

  const timer = run.disconnectTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    run.disconnectTimers.delete(sessionId)
    resetTimeout(run)
    process.stderr.write(`daemon: ${run.protocol.name} run: ${sessionId} reconnected\n`)
  }

  // A deferred fallback may have been armed for this role while its session was
  // gone (grace expired in a phase without on.fallback, e.g. owner_turn). The
  // deferral does NOT retire the participant, so a late reconnect brings the same
  // session back alive — clear the pending flag, or the next owner advance() would
  // fire enterFallbackPhase and kill a healthy critic. Only the pending role clears.
  const role = run.sessionToRole.get(sessionId)
  if (role && run._pendingFallback === role) {
    run._pendingFallback = undefined
    process.stderr.write(`daemon: ${run.protocol.name} run: ${role} reconnected — deferred fallback cancelled\n`)
  }
}


// ---------------------------------------------------------------------------
// Protocol registry integration — register protocols
// ---------------------------------------------------------------------------

function runnerHooks(name: string, protoName: string | readonly string[]) {
  const matches = (candidate: string) => typeof protoName === 'string' ? candidate === protoName : protoName.includes(candidate)
  registerProtocol(name, {
    getByThread: (threadId) => {
      const run = getRunByThread(threadId)
      return !!run && matches(run.protocol.name)
    },
    isParticipant: (sessionId) => {
      const runId = sessionToRun.get(sessionId)
      const run = runId ? runs.get(runId) : undefined
      return !!run && matches(run.protocol.name)
    },
    onReply: onRunReply,
    onDisconnect: onRunDisconnect,
    onReconnect: onRunReconnect,
    onAdvance: onRunAdvance,
    onChildSpawn: (parentSessionId, childSessionId, metadata) => {
      const runId = sessionToRun.get(parentSessionId)
      const run = runId ? runs.get(runId) : undefined
      return !!run && matches(run.protocol.name) && registerChild(run, parentSessionId, childSessionId, metadata)
    },
    childSpawnRequiresPrivate: (parentSessionId) => {
      const runId = sessionToRun.get(parentSessionId)
      const run = runId ? runs.get(runId) : undefined
      if (!run || !matches(run.protocol.name)) return false
      const role = run.sessionToRole.get(parentSessionId)
      const phase = run.protocol.phases[run.phase]
      return role === phase?.actor && !!phase.privateChildren
    },
    onPrivateChildLaunchStart: markPrivateChildLaunching,
    onPrivateChildLaunchFinish: finishPrivateChildLaunch,
    childRequiresPrivate: (childSessionId) => {
      return privateProtocolChildren.has(childSessionId) || pendingPrivateProtocolChildren.has(childSessionId)
    },
    onChildResult: (childSessionId, targetSessionId, text) => {
      for (const run of runs.values()) {
        if (matches(run.protocol.name) && registerChildResult(run, childSessionId, targetSessionId, text)) return true
      }
      return false
    },
  })
}

// Registry names match what isThreadOccupied() surfaces to users ("A build is already in progress").
function registerRunnerHooks() {
  runnerHooks('review', 'review')
  runnerHooks('build', 'build')
  runnerHooks('spike', 'spike')
  runnerHooks('delegated_build', ['delegated-build', 'delegated-build-quick'])
}
registerRunnerHooks()


// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __test = process.env.NODE_ENV === 'test'
  ? {
      runs, threadToRun, sessionToRun, resetTimeout, WARNING_BEFORE_TIMEOUT_MS, TOTAL_PHASE_CAP_FACTOR, HEALTH_CHECK_INTERVAL_MS, IDLE_NUDGE_MS, IDLE_ESCALATE_MS, startHealthMonitor, runHealthCheck,
      privateProtocolChildren, pendingPrivateProtocolChildren, markPrivateChildLaunching, finishPrivateChildLaunch, releasePrivateChildWhenGone, registerRunnerHooks, setRunTools, registerChild, retireProtocolChildren, enterFallbackPhase,
      notifyNextActor, notifyActorOfTimeout, notifyParticipant,
      setLifecycle: setRunnerLifecycle,
      resetLifecycle: resetRunnerLifecycle,
    } as const
  : undefined
