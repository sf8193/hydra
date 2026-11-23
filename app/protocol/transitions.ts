import { gateway } from '../../infra/config.js'
import { markDead, registry } from '../../sessions/registry.js'
import { killsInProgress } from '../session-lifecycle.js'
import { transport } from '../../sessions/bridge-transport.js'
import { decideResume } from '../auto-resume.js'
import { safeSend } from '../../infra/util.js'
import { occupancy } from '../../sessions/session-reachability.js'
import { occupied } from '../../sessions/occupancy.js'
import { isSessionWorking, isSessionWorkingAsync } from '../../sessions/session-activity.js'
import { recordSessionDeath } from '../../sessions/observability.js'
import { refreshSessionVisual, formatStateLine } from '../../sessions/anchor-state.js'
import { dumpTranscript } from '../../infra/transcript-dump.js'
import type { FallbackCause } from '../../protocols/dsl.js'
import type { BehaviorContext, CompletionEvent } from '../../shared/protocol-types.js'
import { formatContextPercent, type ProviderId } from '../../engines/engine-adapter.js'
import type { Modifier, SeedModifier } from '../../protocols/modifiers.js'
import { timed } from '../../shared/loop-watch.js'
import {
  cancellingRuns, clearPhaseTimers, clearTimers, completedRoundsOf, completionVia,
  formatAdvanceUsagePattern, getProtocolContext, HEALTH_CHECK_INTERVAL_MS, IDLE_ESCALATE_MS,
  IDLE_NUDGE_MS, isTerminal, protocolEvents, runnerLifecycle, runs, sessionToRun,
  TOTAL_PHASE_CAP_FACTOR, WARNING_BEFORE_TIMEOUT_MS, type ProtocolRun,
} from './state.js'
import {
  advancePhase, cleanupRun, clearProtocolTools, registerParticipant,
  setRunTools,
} from './tools.js'
import {
  notifyActorOfTimeout, notifyDisconnect, notifyExit, notifyNextActor, notifyParticipant,
  notifyPhaseChange, postStatusLine,
} from './notify.js'

export function onRunDisconnect(sessionId: string): void {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return
  const run = runs.get(runId)
  if (!run || isTerminal(run)) return
  if (run.disconnectTimers.has(sessionId)) return // this episode is already being handled
  // Connected and not given up on: a Codex runtime's deadAt is its verdict even while its socket lingers (C1).
  const connected = () => transport.has(sessionId) && !registry.get(sessionId)?.deadAt
  if (connected()) return

  const role = run.sessionToRole.get(sessionId)
  if (!role) return

  if (role !== run.protocol.ownerRole) {
    const info = registry.get(sessionId)
    const claudeSessionId = info?.claudeSessionId
    run.disconnectTimers.set(sessionId, setTimeout(async () => {
      if (isTerminal(run)) return
      const currentInfo = registry.get(sessionId)
      const attempts = run._resumeAttempts ?? 0
      const decision = decideResume(
        connected(),
        currentInfo ? !occupied(occupancy(currentInfo)) : true,
        !!claudeSessionId,
        attempts,
      )
      if (decision === 'reconnected') { run.disconnectTimers.delete(sessionId); return }
      if (decision === 'resume') {
        run._resumeAttempts = attempts + 1
        void resumeParticipant(run, role, sessionId, claudeSessionId!).catch(err => {
          process.stderr.write(`daemon: ${run.protocol.name} run: ${role} auto-resume failed: ${err}\n`)
          notifyDisconnect(run, role, 'auto-resume failed')
          if (canFallbackOnDeath(run, role)) void enterFallbackPhase(run, role)
          else if (canDeferFallback(run, role)) armDeferredFallback(run, role)
          else void cancelRun(run, `${role} auto-resume failed`)
        })
      } else {
        notifyDisconnect(run, role, 'session disconnected')
        startGraceTimer(run, role, sessionId)
      }
    }, 3_000))
    return
  }

  startGraceTimer(run, role, sessionId)
}

export function startGraceTimer(run: ProtocolRun, role: string, sessionId: string): void {
  const graceMs = run.protocol.graceMs(role)
  if (!graceMs) {
    if (canFallbackOnDeath(run, role)) void enterFallbackPhase(run, role)
    else if (canDeferFallback(run, role)) armDeferredFallback(run, role)
    else void cancelRun(run, `${role} disconnected (no grace period)`)
    return
  }
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  process.stderr.write(`daemon: ${run.protocol.name} run: ${role} — ${graceMs / 1000}s grace\n`)
  run.disconnectTimers.set(sessionId, setTimeout(() => {
    if (canFallbackOnDeath(run, role)) void enterFallbackPhase(run, role)
    else if (canDeferFallback(run, role)) armDeferredFallback(run, role)
    else void cancelRun(run, `${role} did not reconnect`)
  }, graceMs))
}

// ---------------------------------------------------------------------------
// Participant-death fallback — when a non-owner dies and auto-resume is
// exhausted, a protocol can hand the work to the owner instead of cancelling.
// Fully DSL-driven: a protocol opts in by declaring an `on.fallback` transition
// out of the actor phases plus a `notifications.onFallback` hook for the owner
// instructions. The engine names no protocol (review is currently the only one
// that opts in). Never fires for a dead owner — the fallback asks the owner to
// work, which is meaningless when the owner is the one who vanished, and never
// when the caller passed `noFallback` (`+no-fallback`), which says an
// adversarial review or nothing.
//
// The same phase is also reachable without a death, via enterDirectSubagentPhase
// (`+subagent`) — see startProtocolRun.
// ---------------------------------------------------------------------------

export function canFallbackOnDeath(run: ProtocolRun, deadRole: string): boolean {
  return !run.params.noFallback
    && deadRole !== run.protocol.ownerRole
    && !isTerminal(run)
    && !!run.protocol.phases[run.phase]?.on?.fallback
    && !!run.protocol.notifications.onFallback
}

// Deferred fallback: the current phase has no on.fallback (e.g. owner_turn, where
// firing fallback mid-composition would let the owner's pending advance() land on
// subagent_review and turn the defense into the review summary), but the protocol
// does support fallback from some other phase. Rather than cancel, remember the
// dead role and re-check once the owner advances into a fallback-eligible phase
// (see the _pendingFallback handling in onRunAdvance).
export function canDeferFallback(run: ProtocolRun, deadRole: string): boolean {
  if (run.params.noFallback) return false
  if (deadRole === run.protocol.ownerRole) return false
  if (isTerminal(run)) return false
  if (!run.protocol.notifications.onFallback) return false
  // The current phase doesn't have on.fallback, but some phase does
  return Object.values(run.protocol.phases).some(p => !!p.on?.fallback)
}

// Arm a deferred fallback. A fallback hands the ENTIRE review to the owner
// regardless of which role died, so a single marker covers every dead non-owner
// role: first write wins, and a second non-owner death in the same fallback-less
// phase is subsumed by the same deferred fallback rather than clobbering the
// first (which would drop a dead participant silently). Whichever role armed it
// gets named in the notification; the rest are retired at completion like any
// non-owner participant. Only relevant to a future multi-non-owner protocol —
// review has a single critic — but the engine is generic, so guard it here.
export function armDeferredFallback(run: ProtocolRun, deadRole: string): void {
  if (!run._pendingFallback) run._pendingFallback = deadRole
}

export async function enterFallbackPhase(run: ProtocolRun, deadRole: string, cause: FallbackCause = 'death'): Promise<void> {
  if (isTerminal(run)) return

  // Everything from here to the kill is synchronous — no await before the
  // transition — so a concurrent owner advance() cannot interleave and strand
  // us mid-fallback. If the phase has already moved past a fallback-eligible
  // turn (the owner finished the round, or we already entered fallback),
  // `on.fallback` is absent: yield rather than cancel, and let normal flow end.
  const from = run.phase
  if (!run.protocol.phases[from]?.on?.fallback) return

  // Retire the dead participant from the run maps BEFORE transitioning, so the
  // transition's setRunTools doesn't touch the doomed session and any late
  // disconnect it fires can't re-enter the disconnect path. Capture its id to
  // kill after the phase has committed (the kill is the only await).
  const deadSessionId = run.participants.get(deadRole)
  if (deadSessionId) {
    const timer = run.disconnectTimers.get(deadSessionId)
    if (timer) { clearTimeout(timer); run.disconnectTimers.delete(deadSessionId) }
    run.participants.delete(deadRole)
    run.sessionToRole.delete(deadSessionId)
    sessionToRun.delete(deadSessionId)
  }

  const result = run.protocol.machine.transition(from, 'fallback')
  if (!result.ok || !advancePhase(run, result.to, from)) return
  run._enteredFallback = true

  if (deadSessionId) {
    const info = registry.get(deadSessionId)
    if (info && !killsInProgress.has(deadSessionId)) {
      await runnerLifecycle.killSession(info, `fallback after ${deadRole} died`, { ended: 'killed by hydra' }).catch(() => {})
    }
  }

  if (isTerminal(run)) return // defensive: a cancel/complete slipped in during the kill

  const attempts = run._resumeAttempts ?? 0
  const deadLabel = run.protocol.roles[deadRole] ?? deadRole
  const completedRounds = completedRoundsOf(run)
  const instructions = run.protocol.notifications.onFallback?.(run, cause === 'death'
    ? { mode: 'fallback', cause, deadRole, deadLabel, resumeAttempts: attempts, completedRounds }
    : { mode: 'fallback', cause, deadRole, deadLabel, completedRounds },
  ) ?? `[system] ${deadLabel} is gone. Post your closing summary via advance({ content: "..." }).`

  // Log the entry breadcrumb here — the transition has committed and run.phase is
  // reliably the fallback phase — rather than after the awaits below, where the
  // deferred-path terminal guard could skip it (and where run.phase may already
  // have moved to `complete`, making the message wrong).
  const why = cause === 'death' ? `${deadRole} died (${attempts} resume attempts)` : `${deadRole} went silent`
  process.stderr.write(`daemon: ${run.protocol.name} run: entered ${run.phase} after ${why}\n`)

  await announceFallbackPhase(run, instructions)
}

// Enter the fallback phase with no death behind it: the caller asked for the
// owner-run review up front. Everything enterFallbackPhase does about a corpse —
// retire the participant, kill the session, count resume attempts — has no
// subject here, so all that remains is the transition and the hand-off.
// Returns false when the protocol declares no fallback path to enter.
export async function enterDirectSubagentPhase(run: ProtocolRun): Promise<boolean> {
  const onFallback = run.protocol.notifications.onFallback
  const from = run.phase
  if (!onFallback || !run.protocol.phases[from]?.on?.fallback) return false

  const result = run.protocol.machine.transition(from, 'fallback')
  if (!result.ok || !advancePhase(run, result.to, from)) return false
  run._enteredFallback = true

  process.stderr.write(`daemon: ${run.protocol.name} run: entered ${run.phase} directly (+subagent) — no participants spawned\n`)

  await announceFallbackPhase(run, onFallback(run, { mode: 'direct' }))
  return true
}

// Hand the fallback phase to the owner. Manual, rather than afterTransition():
// the owner needs the protocol's custom onFallback instructions, not the generic
// "your turn" hand-off. The fallback phase declares no onEnter behaviors, and the
// owner is the run's only participant by the time we get here — so
// afterTransition's notifyPhaseChange (which targets non-active participants)
// would be a no-op. The calls below cover every responsibility that applies.
export async function announceFallbackPhase(run: ProtocolRun, instructions: string): Promise<void> {
  protocolEvents.emitPhaseChange({ protocol: run.protocol.name, threadId: run.threadId, phase: run.phase })

  // Thread post is the human-visible record; the direct notification is what
  // actually wakes the idle owner session to start working (a safeSend to the
  // thread does not — every actor hand-off in this runner pushes via transport).
  const ids = await safeSend(run.threadId, instructions)
  run.messageIds.push(...ids)
  notifyParticipant(run, run.ownerSessionId, instructions)
  await postStatusLine(run)
  // Deferred path only: this runs inside the owner's own advance() rather than
  // from an idle timer, so the owner can post its fallback summary and complete
  // the run during the awaits above. Arming timers on a terminal/cleaned-up run
  // would leak setTimeout/setInterval handles past cleanupRun — bail instead.
  if (isTerminal(run)) return
  resetTimeout(run) // give the owner the full fallback window to work
  startHealthMonitor(run)
}

export async function resumeParticipant(run: ProtocolRun, role: string, deadSessionId: string, claudeSessionId: string): Promise<void> {
  const info = registry.get(deadSessionId)
  if (info) recordSessionDeath(info, `${role} exited (auto-resuming)`, getProtocolContext(deadSessionId))

  const result = await runnerLifecycle.doSpawnSession(
    info?.topic ?? `${run.protocol.display} ${run.protocol.roles[role]}`,
    undefined, undefined, {
      joinThread: run.threadId,
      sessionType: 'thread_guest',
      resumeFrom: claudeSessionId,
      model: run.params.model as string | undefined,
      // killSession deletes the dead record before this fires, and a guest has
      // no history entry to fall back on — but the owner handed it out at spawn.
      inheritedLabel: registry.get(run.ownerSessionId)?.label ?? info?.label,
    },
  )
  if (isTerminal(run)) {
    const spawnedInfo = registry.get(result.sessionId)
    if (spawnedInfo) await runnerLifecycle.killSession(spawnedInfo, 'run cancelled during resume', { ended: 'killed by hydra' }).catch(() => {})
    return
  }

  // Pre-register before waitForBridge so the session's capabilities are set
  // when the bridge pushes tools on connect.
  run.sessionToRole.set(result.sessionId, role)
  sessionToRun.set(result.sessionId, run.id)
  const phaseDef = run.protocol.phases[run.phase]
  const isMyTurn = phaseDef?.actor === role
  const roleLabel = run.protocol.roles[role] ?? role
  const advancePattern = isMyTurn ? formatAdvanceUsagePattern(run.protocol, run.phase) : null

  const resumeLines: string[] = [
    `[system] Your session was resumed. You are **${roleLabel}** in a **${run.protocol.display}** (round ${run.currentRound}/${run.rounds}).`,
  ]
  if (isMyTurn && advancePattern) {
    resumeLines.push(`It is your turn. Use \`${advancePattern}\` to post your response. Use \`reply()\` for conversation only.`)
  } else {
    const activeActor = phaseDef?.actor
    const activeLabel = activeActor ? run.protocol.roles[activeActor] : undefined
    resumeLines.push(`${activeLabel ?? 'The other participant'} is currently working. Wait for a [system] notification with their response.`)
  }
  resumeLines.push(`Check the thread for any messages you may have missed.`)

  transport.sendOrQueue(result.sessionId, {
    type: 'notification',
    content: resumeLines.join('\n'),
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  const ok = await runnerLifecycle.waitForBridge(result.sessionId, 30_000)
  if (!ok) {
    const t = run.disconnectTimers.get(result.sessionId)
    if (t) { clearTimeout(t); run.disconnectTimers.delete(result.sessionId) }
    sessionToRun.delete(result.sessionId)
    run.sessionToRole.delete(result.sessionId)
    const newInfo = registry.get(result.sessionId)
    if (newInfo) await runnerLifecycle.killSession(newInfo, 'auto-resume health check failed', { ended: 'killed by hydra' }).catch(() => {})
    throw new Error('resumed session did not connect')
  }
  if (isTerminal(run)) {
    const t = run.disconnectTimers.get(result.sessionId)
    if (t) { clearTimeout(t); run.disconnectTimers.delete(result.sessionId) }
    sessionToRun.delete(result.sessionId)
    run.sessionToRole.delete(result.sessionId)
    const spawnedInfo = registry.get(result.sessionId)
    if (spawnedInfo) await runnerLifecycle.killSession(spawnedInfo, 'run cancelled during resume', { ended: 'killed by hydra' }).catch(() => {})
    return
  }

  if (info) markDead(info)
  sessionToRun.delete(deadSessionId)
  run.sessionToRole.delete(deadSessionId)
  run.disconnectTimers.delete(deadSessionId)
  registerParticipant(run, role, result.sessionId)

  resetTimeout(run)
  startHealthMonitor(run)
  process.stderr.write(`daemon: ${run.protocol.name} run: ${role} auto-resumed: ${deadSessionId} → ${result.sessionId}\n`)
}

export async function cancelRun(run: ProtocolRun, reason: string): Promise<void> {
  if (cancellingRuns.has(run.id)) return
  cancellingRuns.add(run.id)

  if (!isTerminal(run)) {
    if (run.protocol.phases[run.phase]?.on?.cancel) {
      const result = run.protocol.machine.transition(run.phase, 'cancel')
      if (result.ok) advancePhase(run, result.to, run.phase)
    } else {
      process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" has no cancel transition — abandoning run\n`)
    }
  }

  clearTimers(run)
  clearProtocolTools(run)
  run._pendingFallback = undefined

  try {
    notifyExit(run, 'cancelled', reason)

    for (const [role, sid] of run.participants) {
      if (sid === run.ownerSessionId) continue
      const info = registry.get(sid)
      if (info && !killsInProgress.has(sid)) {
        try { await runnerLifecycle.killSession(info, reason, { ended: 'killed by hydra' }) } catch (err) { process.stderr.write(`daemon: kill on cancel failed: ${err}\n`) }
      }
    }

    const cancelIds = await safeSend(run.threadId, `${run.protocol.display} cancelled: ${reason}`)
    run.messageIds.push(...cancelIds)
  } finally {
    const completionEvent: CompletionEvent = {
      protocol: run.protocol.name,
      threadId: run.threadId,
      topic: run.params.topic as string | undefined,
      rounds: { completed: completedRoundsOf(run), requested: run.rounds },
      outcome: 'cancelled',
      terminalPhase: run.phase,
      reason,
      decisions: run.decisions.map(d => ({ phase: d.phase, role: d.role, value: d.value, because: d.because })),
      durationMs: Date.now() - run.startedAt,
      // No `via`/`degradation`: those describe how a run reached its summary,
      // and a cancelled run never reached one. `reason` is what a consumer wants
      // here, and it already says what went wrong.
    }
    protocolEvents.emitComplete(completionEvent)
    cancellingRuns.delete(run.id)
    cleanupRun(run)
    refreshSessionVisual(run.threadId)
  }
}


export async function runHealthCheck(run: ProtocolRun): Promise<void> {
    if (isTerminal(run)) { clearInterval(run._healthMonitor!); run._healthMonitor = undefined; return }

    const actorRole = run.protocol.phases[run.phase]?.actor
    if (!actorRole) return
    const actorSid = run.participants.get(actorRole)
    if (!actorSid) return
    const info = registry.get(actorSid)
    if (!info) return

    const occ = occupancy(info)
    const alive = occupied(occ)
    const connected = occ === 'connected'

    // Hard cap check first — unconditional, never skipped for a working session
    const phaseElapsed = Date.now() - run._phaseStartedAt
    const hardCapMs = (run.protocol.windowMs(run.phase) ?? 30 * 60 * 1000) * TOTAL_PHASE_CAP_FACTOR
    if (phaseElapsed > hardCapMs) {
      process.stderr.write(`daemon: health: ${info.tmuxName} hit hard cap (${Math.round(phaseElapsed / 60_000)}m)\n`)
      clearInterval(run._healthMonitor!)
      run._healthMonitor = undefined
      notifyActorOfTimeout(run, actorSid, run.phase)
      if (actorRole && canFallbackOnDeath(run, actorRole)) {
        void enterFallbackPhase(run, actorRole, 'silence')
      } else {
        void fireTransition(run, 'timeout', '', 'health monitor hard cap')
      }
      return
    }

    // Dead or half-dead: recover immediately regardless of activity
    if (!alive) {
      process.stderr.write(`daemon: health: ${info.tmuxName} is dead (connected=${connected}), triggering recovery\n`)
      onRunDisconnect(actorSid)
      return
    }
    if (!connected) {
      // Process alive but bridge down — can't deliver notifications.
      // Only nudge the thread (not the session) and let disconnect handler sort it out.
      if (!run._bridgeEscalated) {
        run._bridgeEscalated = true
        void safeSend(run.threadId, `_⚠️ ${info.tmuxName} is running but disconnected — bridge may be recovering_`)
        process.stderr.write(`daemon: health: ${info.tmuxName} alive but disconnected\n`)
      }
      return
    }

    if (await isSessionWorkingAsync(info)) return

    const idleMs = Date.now() - info.lastActive

    if (idleMs > IDLE_ESCALATE_MS && !run._escalated) {
      run._escalated = true
      const ctx = info.adapter ? formatContextPercent(info.adapter, info) : '?'
      void safeSend(run.threadId, `_⚠️ ${info.tmuxName} idle for ${Math.round(idleMs / 60_000)}m (${ctx} context)_`)
      notifyParticipant(run, actorSid, `[system] ⚠️ You've been idle for ${Math.round(idleMs / 60_000)} minutes. Use advance() to post your response, or the protocol will time out.`)
      process.stderr.write(`daemon: health: ${info.tmuxName} escalated — idle ${Math.round(idleMs / 60_000)}m\n`)
    } else if (idleMs > IDLE_NUDGE_MS && !run._nudged) {
      run._nudged = true
      notifyParticipant(run, actorSid, `[system] Checking in — are you still working? Use advance() when ready.`)
      process.stderr.write(`daemon: health: ${info.tmuxName} nudged — idle ${Math.round(idleMs / 60_000)}m\n`)
    }
}

export function startHealthMonitor(run: ProtocolRun): void {
  if (run._healthMonitor) { clearInterval(run._healthMonitor); run._healthMonitor = undefined }
  run._nudged = false
  run._escalated = false
  run._bridgeEscalated = false
  run._healthMonitor = setInterval(() => timed('protocol-health', () => { void runHealthCheck(run) }), HEALTH_CHECK_INTERVAL_MS)
}

type BehaviorHandler = (run: ProtocolRun, prevPhase: string, content: string, ctx: BehaviorContext) => boolean | Promise<boolean>

const BEHAVIORS: Record<string, BehaviorHandler> = {
  killNonOwner: (run, prevPhase) => {
    if (prevPhase === run.phase) return false
    for (const [role, sid] of run.participants) {
      if (sid === run.ownerSessionId) continue
      sessionToRun.delete(sid)
      const info = registry.get(sid)
      if (info && !killsInProgress.has(sid)) {
        void runnerLifecycle.killSession(info, 'protocol closing', { ended: 'killed by hydra' }).catch(() => {})
      }
    }
    return false
  },

  backstopTimer: (run, prevPhase) => {
    if (prevPhase === run.phase) return false
    clearPhaseTimers(run)
    const phase = run.phase
    const ms = run.protocol.windowMs(phase) ?? 5 * 60 * 1000
    run.timeout = setTimeout(async () => {
      if (run.phase !== phase) return
      process.stderr.write(`daemon: ${run.protocol.name} run: backstop timeout in "${phase}"\n`)
      await fireTransition(run, 'timeout', '', 'backstop timed out')
    }, ms)
    return true
  },

  notifyOwnerSummary: async (run, prevPhase) => {
    if (prevPhase === run.phase) return false
    const concludedIds = await safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎',
      `concluded — ${run.currentRound} round${run.currentRound > 1 ? 's' : ''}`))
    run.messageIds.push(...concludedIds)
    const formatLines = run.protocol.summaryFormat(run)
    const closingActor = run.protocol.phases[run.phase]?.actor
    const closingSid = closingActor ? run.participants.get(closingActor) : run.ownerSessionId
    const closingInfo = registry.get(closingSid ?? run.ownerSessionId)
    const closingName = closingInfo?.tmuxName
    const namePrefix = closingName ? `**${closingName}**, post` : `Post`
    transport.sendOrQueue(closingSid ?? run.ownerSessionId, {
      type: 'notification',
      content: [
        `[system] ${run.protocol.display} complete (${run.currentRound} round${run.currentRound > 1 ? 's' : ''}).`,
        `${namePrefix} a closing summary using \`advance({ content: "..." })\`:`,
        ``,
        ...formatLines,
      ].join('\n'),
      meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    return true
  },
}

function makeBehaviorCtx(run: ProtocolRun): BehaviorContext {
  return {
    postStatusLine: (r) => postStatusLine(r as ProtocolRun),
    resetTimeout: (r) => resetTimeout(r as ProtocolRun),
    afterTransition: (r, prev, c) => afterTransition(r as ProtocolRun, prev, c),
    safeSend,
    sendToActor: (r, content) => {
      const actor = (r as ProtocolRun).protocol.phases[r.phase]?.actor
      if (!actor) return
      const actorSid = r.participants.get(actor)
      if (!actorSid) return
      transport.sendOrQueue(actorSid, {
        type: 'notification',
        content,
        meta: { chat_id: r.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    },
    fireTransition: (r, event, content, reason) => fireTransition(r as ProtocolRun, event, content, reason),
  }
}

export async function afterTransition(run: ProtocolRun, prevPhase: string, content: string): Promise<void> {
  if (isTerminal(run)) {
    await completeRun(run)
    return
  }

  // Announce the move before running onEnter behaviors. The round counter has
  // already advanced by this point, so an observer that repaints on this event
  // and reads the round off the run sees the new one.
  protocolEvents.emitPhaseChange({
    protocol: run.protocol.name,
    threadId: run.threadId,
    phase: run.phase,
  })

  const ctx = makeBehaviorCtx(run)
  const phase = run.protocol.phases[run.phase]
  let handled = false
  try {
    for (const behavior of phase?.onEnter ?? []) {
      const handler = typeof behavior === 'function'
        ? (r: ProtocolRun, p: string, c: string, cx: BehaviorContext) => behavior(r, p, c, cx)
        : BEHAVIORS[behavior]
      if (handler && await handler(run, prevPhase, content, ctx)) handled = true
    }
  } catch (err) {
    process.stderr.write(`daemon: ${run.protocol.name} run: behavior threw in phase "${run.phase}": ${err}\n`)
    await cancelRun(run, 'behavior error')
    return
  }

  if (!handled) {
    notifyNextActor(run, content)
    notifyPhaseChange(run, prevPhase, run.phase)
    await postStatusLine(run)
    resetTimeout(run)
  }

  startHealthMonitor(run)
}


export async function spawnRole(run: ProtocolRun, role: string, params: Record<string, unknown>): Promise<void> {
  const ctx = {
    name: '', // filled after spawn
    sessionId: '',
    threadId: run.threadId,
    rounds: run.rounds,
    ...params,
  }

  const model = (params.model as string) ?? undefined
  const engine = (params.engine as ProviderId | undefined) ?? undefined
  const result = await runnerLifecycle.doSpawnSession(`${run.protocol.display} ${run.protocol.roles[role]} (${run.rounds} rounds)`, undefined, undefined, {
    trigger: run.protocol.name,
    joinThread: run.threadId,
    sessionType: 'thread_guest',
    model,
    inheritedLabel: registry.get(run.ownerSessionId)?.label,
    ...(engine && { engine }),
    promptBuilder: (sessionId, tmuxName) => {
      let seed = run.protocol.seed(role, { ...ctx, name: tmuxName, sessionId, protocol: run.protocol }) ?? `You are ${tmuxName}, the ${role}.`
      const seedMods = ((run.params.modifiers as Modifier[] | undefined) ?? [])
        .filter((m): m is SeedModifier => m.type === 'seed' && m.target === role)
      for (const mod of seedMods) {
        seed += `\n\n---\n**+${mod.name}:**\n${mod.instructions}`
      }
      return seed
    },
  })

  registerParticipant(run, role, result.sessionId)
}

export async function fireTransition(run: ProtocolRun, event: string, content: string, reason: string): Promise<void> {
  const result = run.protocol.machine.transition(run.phase, event)
  if (!result.ok) {
    await cancelRun(run, reason)
    return
  }
  if (run.timeout) clearTimeout(run.timeout)
  const prevPhase = run.phase
  if (!advancePhase(run, result.to, prevPhase)) return
  if (isTerminal(run)) {
    if (result.to === run.protocol.cancelPhase) {
      await cancelRun(run, reason)
    } else {
      await completeRun(run)
    }
  } else {
    await afterTransition(run, prevPhase, content)
  }
}

export function resetTimeout(run: ProtocolRun): void {
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }

  const ms = run.protocol.windowMs(run.phase)
  if (!ms) return
  const windowMs: number = ms // hoisted sendWarning() below doesn't see the narrowing on `ms`

  const phase = run.phase
  const actorRole = run.protocol.phases[phase]?.actor
  const actorSessionId = actorRole ? run.participants.get(actorRole) : undefined

  if (ms > WARNING_BEFORE_TIMEOUT_MS) {
    run._warningTimeout = setTimeout(() => {
      if (run.phase !== phase || !actorSessionId) return
      const info = registry.get(actorSessionId)
      if (info && isSessionWorking(info)) {
        process.stderr.write(`daemon: ${run.protocol.name} run: warning skipped — ${info.tmuxName} is actively working\n`)
        return
      }
      sendWarning()
      function sendWarning() {
        if (run.phase !== phase) return
        const ctx = info ? formatContextPercent(info.adapter, info) : '?'
        const advanceCall = `Call \`${formatAdvanceUsagePattern(run.protocol, phase)}\``
        const elapsed = Math.round((Date.now() - run._phaseStartedAt) / 60_000)
        const totalMs = windowMs * TOTAL_PHASE_CAP_FACTOR
        const totalRemaining = Math.max(0, Math.round((run._phaseStartedAt + totalMs - Date.now()) / 60_000))
        const urgency = elapsed > windowMs / 60_000 ? ` Phase has been running ${elapsed}m — ${totalRemaining}m until hard limit.` : ''
        transport.sendOrQueue(actorSessionId!, {
          type: 'notification',
          content: `[system] ⏰ Phase timeout in 2 minutes. ${advanceCall} or call extend_phase(reason: "...", minutes: N) if you need more time.${urgency} (context: ${ctx})`,
          meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
        })
        void safeSend(run.threadId, `_⏰ ${info?.tmuxName ?? 'actor'} warned: 2m remaining (${ctx} context)_`)
        process.stderr.write(`daemon: ${run.protocol.name} run: warning sent to ${info?.tmuxName ?? actorSessionId} (${ctx} context, ${elapsed}m elapsed)\n`)
      }
    }, ms - WARNING_BEFORE_TIMEOUT_MS)
  }

  run.timeout = setTimeout(() => {
    if (run.phase !== phase) return
    const info = actorSessionId ? registry.get(actorSessionId) : undefined
    if (info && isSessionWorking(info)) {
      process.stderr.write(`daemon: ${run.protocol.name} run: timeout deferred — ${info.tmuxName} is actively working\n`)
      resetTimeout(run)
      return
    }
    fireTimeout()
    function fireTimeout() {
      if (run.phase !== phase) return
      process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" timed out\n`)
      notifyActorOfTimeout(run, actorSessionId, phase)
      if (actorRole && canFallbackOnDeath(run, actorRole)) {
      process.stderr.write(`daemon: ${run.protocol.name} run: ${actorRole} timed out — falling back instead of cancelling\n`)
        void enterFallbackPhase(run, actorRole, 'silence')
        return
      }
      void fireTransition(run, 'timeout', '', run.protocol.phases[phase]?.timeoutReason ?? 'timed out')
    }
  }, ms)

  // Invariant: on deferral (recursive resetTimeout), _totalTimeout and
  // _phaseStartedAt survive — they anchor to phase entry, not to the
  // last reset. _extensions also survives (counts across the phase entry).
  // Total backstop — unconditional, never resets, no activity check.
  // Prevents unbounded deferral from activity-based resets.
  if (!run._totalTimeout) {
    const totalMs = ms * TOTAL_PHASE_CAP_FACTOR
    run._totalTimeout = setTimeout(async () => {
      if (isTerminal(run)) return
      process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" hit total backstop (${Math.round(totalMs / 60_000)}m)\n`)
      // Same reasoning as the idle timeout above — a non-owner that burned the
      // hard cap without advancing is wedged, and a wedged participant is one
      // the protocol's fallback exists for. Read the actor off the current
      // phase: this timer never resets, so the phase may have moved since.
      const cappedActor = run.protocol.phases[run.phase]?.actor
      const cappedSid = cappedActor ? run.participants.get(cappedActor) : undefined
      notifyActorOfTimeout(run, cappedSid, run.phase)
      if (cappedActor && canFallbackOnDeath(run, cappedActor)) {
        void enterFallbackPhase(run, cappedActor, 'silence')
        return
      }
      await fireTransition(run, 'timeout', '', run.protocol.phases[run.phase]?.timeoutReason ?? 'total time exceeded')
    }, totalMs)
  }
}

export async function completeRun(run: ProtocolRun): Promise<void> {
  process.stderr.write(`daemon: ${run.protocol.name} run: complete (phase=${run.phase}, rounds=${run.currentRound}/${run.rounds})\n`)

  clearTimers(run)
  clearProtocolTools(run)
  notifyExit(run, 'complete')

  let transcriptPath: string | undefined
  try {
    const dumpPath = await dumpTranscript(run.threadId, run.protocol.name, run.messageIds, {
      rounds: `${run.currentRound}/${run.rounds}`,
      outcome: run.phase,
      ...(run.params.topic ? { topic: String(run.params.topic) } : {}),
    }, run.statusHistory)
    transcriptPath = dumpPath ?? undefined

    if (!dumpPath) {
      process.stderr.write(`daemon: ${run.protocol.name}: transcript dump failed — leaving messages in place\n`)
    } else if (run.strike && run.messageIds.length > 0) {
      let failures = 0
      for (let i = 0; i < run.messageIds.length; i++) {
        try { await gateway.delete(run.threadId, run.messageIds[i]) } catch { failures++ }
        if (i < run.messageIds.length - 1) await new Promise(r => setTimeout(r, 1000))
      }
      const struck = run.messageIds.length - failures
      const failNote = failures > 0 ? ` · ⚠️ ${failures} delete${failures > 1 ? 's' : ''} failed` : ''
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\` · ${struck}/${run.messageIds.length} messages struck${failNote}_`)
    } else {
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\`_`)
    }
  } catch (err) {
    process.stderr.write(`daemon: ${run.protocol.name} transcript dump failed: ${err}\n`)
  }

  const via = completionVia(run)
  const completionEvent: CompletionEvent = {
    protocol: run.protocol.name,
    threadId: run.threadId,
    topic: run.params.topic as string | undefined,
    // A degraded completion never finished the round it was in: the critic died
    // or fell silent partway through, or (direct) no round ever started. Only the
    // normal path reaches its closing phase with the counted round genuinely done.
    rounds: { completed: via === 'normal' ? run.currentRound : completedRoundsOf(run), requested: run.rounds },
    outcome: 'complete',
    terminalPhase: run.phase,
    decisions: run.decisions.map(d => ({ phase: d.phase, role: d.role, value: d.value, because: d.because })),
    durationMs: Date.now() - run.startedAt,
    transcriptPath,
    summary: run.summary,
    via,
    // Only a degraded path has something to name, and only the protocol can name
    // it. The protocol() assertion makes this present for any protocol that opts
    // into fallback, so in practice `via !== 'normal'` implies a label.
    ...(via !== 'normal' && run.protocol.fallbackDegradation
      ? { degradation: run.protocol.fallbackDegradation }
      : {}),
  }

  protocolEvents.emitComplete(completionEvent)

  for (const [, sid] of run.participants) {
    if (sid === run.ownerSessionId) continue
    sessionToRun.delete(sid)
    const info = registry.get(sid)
    if (info && !killsInProgress.has(sid)) {
      void runnerLifecycle.killSession(info, 'protocol complete', { ended: 'killed by hydra' }).catch(err => process.stderr.write(`daemon: kill on complete failed: ${err}\n`))
    }
  }
  cleanupRun(run)
  refreshSessionVisual(run.threadId)
}
