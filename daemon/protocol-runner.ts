import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress, waitForBridge } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { decideResume } from './auto-resume.js'
import { isAlive, safeSend, getContextPercent, type StatusLineState } from './util.js'
import { recordSessionDeath } from './observability.js'
import { registerProtocol } from './protocol-registry.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { dumpTranscript } from './transcript-dump.js'
import type { Protocol } from './protocol-dsl.js'
import type { RunState, BehaviorContext, CompletionEvent } from './protocol-types.js'
import { EventEmitter } from 'events'
import type { Modifier, SeedModifier } from './modifiers.js'

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type ProtocolRun<Ext extends Record<string, unknown> = Record<string, unknown>> = StatusLineState & {
  id: string
  protocol: Protocol
  threadId: string
  ownerSessionId: string
  phase: string
  currentRound: number
  rounds: number
  startedAt: number
  params: Record<string, unknown>
  participants: Map<string, string>
  sessionToRole: Map<string, string>
  timeout?: ReturnType<typeof setTimeout>
  _warningTimeout?: ReturnType<typeof setTimeout>
  _totalTimeout?: ReturnType<typeof setTimeout>
  _extensions: number
  _phaseStartedAt: number
  _resumeAttempts?: number
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>
  decisions: Array<{ phase: string; role: string; value: string; because: string; context?: string }>
  strike: boolean
  statusHistory: string[]
  ext: Ext
}

const MAX_EXTENSIONS_PER_PHASE = 2
const WARNING_BEFORE_TIMEOUT_MS = 2 * 60 * 1000
const TOTAL_PHASE_CAP_FACTOR = 3

const runs = new Map<string, ProtocolRun>()
const threadToRun = new Map<string, string>()
const sessionToRun = new Map<string, string>()
const transitioningRuns = new Set<string>()
const cancellingRuns = new Set<string>()

// ---------------------------------------------------------------------------
// Completion event bus
// ---------------------------------------------------------------------------

class ProtocolEventBus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(20) }
  emitComplete(event: CompletionEvent): void {
    for (const fn of this.listeners('complete')) {
      try { (fn as (e: CompletionEvent) => void)(event) }
      catch (err) { process.stderr.write(`daemon: completion event listener error: ${err}\n`) }
    }
  }
  /** Listeners must be synchronous — async rejections are unhandled. */
  onComplete(fn: (event: CompletionEvent) => void): void { this.on('complete', fn) }
  offComplete(fn: (event: CompletionEvent) => void): void { this.off('complete', fn) }
}

export const protocolEvents = new ProtocolEventBus()

// ---------------------------------------------------------------------------
// Start a protocol run
// ---------------------------------------------------------------------------

export async function startProtocolRun(
  proto: Protocol,
  threadId: string,
  ownerSessionId: string,
  params: { rounds?: number; topic?: string; model?: string; [key: string]: unknown } = {},
): Promise<ProtocolRun> {
  if (threadToRun.has(threadId)) throw new Error(`A ${proto.display} is already running in this thread`)

  const id = crypto.randomUUID()
  const rounds = (params.rounds as number) ?? 3

  const run: ProtocolRun = {
    id,
    protocol: proto,
    threadId,
    ownerSessionId,
    phase: proto.initialPhase,
    currentRound: 1,
    rounds,
    startedAt: Date.now(),
    params,
    participants: new Map(),
    sessionToRole: new Map(),
    timeout: undefined,
    _extensions: 0,
    _phaseStartedAt: Date.now(),
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
    statusHistory: [],
    strike: !!(params.strike ?? false),
    ext: proto.initState(params),
  }

  runs.set(id, run)
  threadToRun.set(threadId, id)
  sessionToRun.set(ownerSessionId, id)

  const ownerRole = proto.ownerRole
  if (ownerRole) {
    run.participants.set(ownerRole, ownerSessionId)
    run.sessionToRole.set(ownerSessionId, ownerRole)
  }

  refreshSessionVisual(threadId, { badge: formatRoundBadge(proto.emoji, halfForPhase(run), run.currentRound, run.rounds) })

  const mods = params.modifiers as Modifier[] | undefined
  const modSuffix = mods?.length ? ` ${mods.map(m => `+${m.name}`).join(' ')}` : ''
  const topicLine = params.topic ? `\nFocus: **${params.topic}**${modSuffix}` : modSuffix ? `\nFocus:${modSuffix}` : ''
  const annIds = await safeSend(threadId, `**${proto.display}** — ${rounds} round${rounds > 1 ? 's' : ''}${topicLine}`)
  run.messageIds.push(...annIds)

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

  // Notify the initial phase's actor if the protocol declares an owner kickoff
  if (proto.ownerKickoff) {
    const initialActor = proto.phases[proto.initialPhase]?.actor
    if (initialActor && run.participants.get(initialActor) === ownerSessionId) {
      transport.sendOrQueue(ownerSessionId, {
        type: 'notification',
        content: proto.ownerKickoff(params),
        meta: { chat_id: threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  }

  return run
}

// ---------------------------------------------------------------------------
// Shared lookup
// ---------------------------------------------------------------------------

function getRunAndRole(sessionId: string): { run: ProtocolRun; role: string } | null {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return null
  const run = runs.get(runId)
  if (!run) return null
  const role = run.sessionToRole.get(sessionId)
  if (!role) return null
  return { run, role }
}

// ---------------------------------------------------------------------------
// Reply handler
// ---------------------------------------------------------------------------

export async function onRunReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): Promise<void> {
  const lookup = getRunAndRole(sessionId)
  if (!lookup) return
  const { run, role } = lookup
  if (chatId !== run.threadId) return

  const firstLine = text.split('\n')[0].trim()
  const phaseDef = run.protocol.phases[run.phase]
  if (!phaseDef) return

  // Check if this role is the phase's actor
  if (phaseDef.actor !== role) return

  // Sentinel check: if the phase declares a sentinel, the message must start with it
  const sentinel = run.protocol.sentinel(run.phase)
  if (sentinel && !firstLine.startsWith(sentinel)) return

  const nlIdx = text.indexOf('\n')
  const bodyText = nlIdx >= 0 ? text.slice(nlIdx + 1).trim() : firstLine.slice(sentinel?.length ?? 0).trim()

  // Determine which event to fire — declarative, not heuristic
  const event = resolveEvent(run)
  if (!event) return

  if (transitioningRuns.has(run.id)) return
  transitioningRuns.add(run.id)

  try {
    const replyPhase = run.phase
    const result = run.protocol.machine.transition(replyPhase as any, event as any)
    if (!result.ok) return

    // Don't track closing-phase posts (summary is work product, not scaffolding)
    if (replyPhase !== run.protocol.cleanupPhase) {
      run.messageIds.push(...sentMessageIds)
    }

    if (run.timeout) clearTimeout(run.timeout)
    if (!advancePhase(run, result.to, replyPhase)) return

    const prevPhaseDef = run.protocol.phases[replyPhase]
    if (prevPhaseDef?.finalRoundEvent && event !== prevPhaseDef.finalRoundEvent) {
      run.currentRound++
    }

    await afterTransition(run, replyPhase, bodyText)
  } finally {
    transitioningRuns.delete(run.id)
  }
}

// ---------------------------------------------------------------------------
// Decision handler
// ---------------------------------------------------------------------------

export async function onRunDecision(sessionId: string, value: string, because: string): Promise<boolean> {
  const lookup = getRunAndRole(sessionId)
  if (!lookup) return false
  const { run, role } = lookup

  // Find the decision declared for the current phase
  const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase && d.actor === role)
  if (!decision) {
    process.stderr.write(`daemon: ${run.protocol.name} run: no decision declared for phase "${run.phase}" actor "${role}"\n`)
    return false
  }

  if (!decision.options.includes(value)) {
    process.stderr.write(`daemon: ${run.protocol.name} run: invalid decision value "${value}" (expected: ${decision.options.join(' | ')})\n`)
    return false
  }

  if (transitioningRuns.has(run.id)) return false
  transitioningRuns.add(run.id)

  try {
    const decisionPhase = run.phase
    const eventMap = resolveDecisionEvent(run, value)
    if (!eventMap) return false

    const result = run.protocol.machine.transition(decisionPhase as any, eventMap as any)
    if (!result.ok) return false

    if (run.timeout) clearTimeout(run.timeout)

    if (!advancePhase(run, result.to, decisionPhase)) return false

    const context = run.protocol.decisionContext?.(run)
    run.decisions.push({ phase: decisionPhase, role, value, because, context })

    const narrationIds = await safeSend(run.threadId, `**${run.protocol.roles[role]}** decided: **${value}**\n${because}`)
    run.messageIds.push(...narrationIds)

    if (result.to === run.protocol.initialPhase && eventMap !== decision.finalEvent) {
      run.currentRound++
    }

    await afterTransition(run, decisionPhase, because)
    return true
  } finally {
    transitioningRuns.delete(run.id)
  }
}

// ---------------------------------------------------------------------------
// Phase extension
// ---------------------------------------------------------------------------

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

  const info = registry.get(sessionId)
  const name = info?.tmuxName ?? sessionId.slice(0, 8)
  void safeSend(run.threadId, `_⏳ ${name} requested +${minutes}m: ${reason} (${run._extensions}/${MAX_EXTENSIONS_PER_PHASE})_`)
  process.stderr.write(`daemon: ${run.protocol.name} run: ${name} extended phase "${run.phase}" +${minutes}m (${run._extensions}/${MAX_EXTENSIONS_PER_PHASE}): ${reason}\n`)

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Disconnect / reconnect
// ---------------------------------------------------------------------------

export function onRunDisconnect(sessionId: string): void {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return
  const run = runs.get(runId)
  if (!run || isTerminal(run)) return
  if (transport.has(sessionId)) return

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
        transport.has(sessionId),
        currentInfo ? !isAlive(currentInfo) : true,
        !!claudeSessionId,
        attempts,
      )
      if (decision === 'reconnected') { run.disconnectTimers.delete(sessionId); return }
      if (decision === 'resume') {
        run._resumeAttempts = attempts + 1
        void resumeParticipant(run, role, sessionId, claudeSessionId!).catch(err => {
          process.stderr.write(`daemon: ${run.protocol.name} run: ${role} auto-resume failed: ${err}\n`)
          void cancelRun(run, `${role} auto-resume failed`)
        })
      } else {
        startGraceTimer(run, role, sessionId)
      }
    }, 3_000))
    return
  }

  startGraceTimer(run, role, sessionId)
}

function startGraceTimer(run: ProtocolRun, role: string, sessionId: string): void {
  const graceMs = run.protocol.graceMs(role)
  if (!graceMs) {
    void cancelRun(run, `${role} disconnected (no grace period)`)
    return
  }
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  process.stderr.write(`daemon: ${run.protocol.name} run: ${role} — ${graceMs / 1000}s grace\n`)
  run.disconnectTimers.set(sessionId, setTimeout(() => {
    void cancelRun(run, `${role} did not reconnect`)
  }, graceMs))
}

async function resumeParticipant(run: ProtocolRun, role: string, deadSessionId: string, claudeSessionId: string): Promise<void> {
  const info = registry.get(deadSessionId)
  if (info) recordSessionDeath(info, `${role} exited (auto-resuming)`)

  const result = await doSpawnSession(
    info?.topic ?? `${run.protocol.display} ${run.protocol.roles[role]}`,
    undefined, undefined, {
      joinThread: run.threadId,
      resumeFrom: claudeSessionId,
      model: run.params.model as string | undefined,
    },
  )
  const ok = await waitForBridge(result.sessionId, 30_000)
  if (!ok) {
    const newInfo = registry.get(result.sessionId)
    if (newInfo) await killSession(newInfo, 'auto-resume health check failed').catch(() => {})
    throw new Error('resumed session did not connect')
  }

  if (info) info.deadAt = Date.now()
  sessionToRun.delete(deadSessionId)
  run.participants.set(role, result.sessionId)
  run.sessionToRole.delete(deadSessionId)
  run.sessionToRole.set(result.sessionId, role)
  sessionToRun.set(result.sessionId, run.id)
  run.disconnectTimers.delete(deadSessionId)

  transport.sendOrQueue(result.sessionId, {
    type: 'notification',
    content: `[system] Your session was resumed. Check your thread for any messages you may have missed, and continue where you left off.`,
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(run)
  process.stderr.write(`daemon: ${run.protocol.name} run: ${role} auto-resumed: ${deadSessionId} → ${result.sessionId}\n`)
}

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
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelRun(run: ProtocolRun, reason: string): Promise<void> {
  if (cancellingRuns.has(run.id)) return
  cancellingRuns.add(run.id)

  if (!isTerminal(run)) {
    if (run.protocol.phases[run.phase]?.on?.cancel) {
      const result = run.protocol.machine.transition(run.phase as any, 'cancel' as any)
      if (result.ok) advancePhase(run, result.to, run.phase)
    } else {
      process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" has no cancel transition — abandoning run\n`)
    }
  }

  clearTimers(run)

  try {
    for (const [role, sid] of run.participants) {
      if (sid === run.ownerSessionId) continue
      const info = registry.get(sid)
      if (info && !killsInProgress.has(sid)) {
        try { await killSession(info, reason) } catch (err) { process.stderr.write(`daemon: kill on cancel failed: ${err}\n`) }
      }
    }

    const cancelIds = await safeSend(run.threadId, `${run.protocol.display} cancelled: ${reason}`)
    run.messageIds.push(...cancelIds)
  } finally {
    const completionEvent: CompletionEvent = {
      protocol: run.protocol.name,
      threadId: run.threadId,
      topic: run.params.topic as string | undefined,
      rounds: { completed: Math.max(0, run.currentRound - 1), requested: run.rounds },
      outcome: 'cancelled',
      reason,
      decisions: run.decisions.map(d => ({ phase: d.phase, role: d.role, value: d.value, because: d.because })),
      durationMs: Date.now() - run.startedAt,
    }
    protocolEvents.emitComplete(completionEvent)
    cancellingRuns.delete(run.id)
    cleanupRun(run)
    refreshSessionVisual(run.threadId)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------


function halfForPhase(run: ProtocolRun): 'top' | 'bottom' {
  return run.protocol.phases[run.phase]?.half ?? 'top'
}

function advancePhase(run: ProtocolRun, to: string, from: string): boolean {
  if (run.phase !== from) return false
  run.phase = to
  run._extensions = 0
  run._phaseStartedAt = Date.now()
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }
  if (run._totalTimeout) { clearTimeout(run._totalTimeout); run._totalTimeout = undefined }
  return true
}

function isTerminal(run: ProtocolRun): boolean {
  const phase = run.protocol.phases[run.phase]
  return !phase || Object.keys(phase.on).length === 0
}

function clearTimers(run: ProtocolRun): void {
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }
  if (run._totalTimeout) { clearTimeout(run._totalTimeout); run._totalTimeout = undefined }
  for (const timer of run.disconnectTimers.values()) clearTimeout(timer)
  run.disconnectTimers.clear()
}

function cleanupRun(run: ProtocolRun): void {
  for (const sid of run.sessionToRole.keys()) sessionToRun.delete(sid)
  threadToRun.delete(run.threadId)
  runs.delete(run.id)
}

// ---------------------------------------------------------------------------
// Phase behavior registry — declared on phases, executed by the runner
// ---------------------------------------------------------------------------

type BehaviorHandler = (run: ProtocolRun, prevPhase: string, content: string, ctx: BehaviorContext) => boolean | Promise<boolean>

const BEHAVIORS: Record<string, BehaviorHandler> = {
  killNonOwner: (run, prevPhase) => {
    if (prevPhase === run.phase) return false
    for (const [role, sid] of run.participants) {
      if (sid === run.ownerSessionId) continue
      sessionToRun.delete(sid)
      const info = registry.get(sid)
      if (info && !killsInProgress.has(sid)) {
        void killSession(info, 'protocol closing').catch(() => {})
      }
    }
    return false
  },

  backstopTimer: (run, prevPhase) => {
    if (prevPhase === run.phase) return false
    clearTimers(run)
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
    const sentinel = run.protocol.sentinel(run.phase)
    const concludedIds = await safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎',
      `concluded — ${run.currentRound} round${run.currentRound > 1 ? 's' : ''}`))
    run.messageIds.push(...concludedIds)
    const formatLines = run.protocol.summaryFormat(run)
    const routingNote = sentinel
      ? `\n\n**Message routing:** Your first line MUST be \`${sentinel}\`. Messages without this tag won't complete the protocol.`
      : ''
    transport.sendOrQueue(run.ownerSessionId, {
      type: 'notification',
      content: [
        `[system] ${run.protocol.display} complete (${run.currentRound} round${run.currentRound > 1 ? 's' : ''}).`,
        `Post a closing summary to your thread using this format:`,
        ``,
        ...formatLines,
        routingNote,
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

async function afterTransition(run: ProtocolRun, prevPhase: string, content: string): Promise<void> {
  if (isTerminal(run)) {
    await completeRun(run)
    return
  }

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
    await postStatusLine(run)
    resetTimeout(run)
  }
}

function resolveEvent(run: ProtocolRun): string | null {
  const phase = run.protocol.phases[run.phase]
  if (!phase) return null

  // Suppress reply-based advancement when a decision's events overlap with replyEvent
  // (prevents double-advance). If events are disjoint, both paths coexist safely
  // (e.g. spike: checkpoint via reply + decide('done') via decision).
  if (phase.replyEvent) {
    const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase)
    if (decision?.events) {
      const decisionEvents = new Set(Object.values(decision.events))
      if (decision.finalEvent) decisionEvents.add(decision.finalEvent)
      if (decisionEvents.has(phase.replyEvent)) return null
    }
  }

  if (phase.finalRoundEvent && run.currentRound >= run.rounds) return phase.finalRoundEvent
  return phase.replyEvent ?? null
}

function resolveDecisionEvent(run: ProtocolRun, value: string): string | null {
  const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase)
  if (!decision) return null

  if (decision.finalEvent && run.currentRound >= run.rounds) return decision.finalEvent

  // If no events map declared, use the value directly as the event name
  if (!decision.events) return value

  if (!decision.events[value]) return null
  return decision.events[value]
}

async function spawnRole(run: ProtocolRun, role: string, params: Record<string, unknown>): Promise<void> {
  const ctx = {
    name: '', // filled after spawn
    sessionId: '',
    threadId: run.threadId,
    rounds: run.rounds,
    ...params,
  }

  const model = (params.model as string) ?? undefined
  const result = await doSpawnSession(`${run.protocol.display} ${run.protocol.roles[role]} (${run.rounds} rounds)`, undefined, undefined, {
    trigger: run.protocol.name as any,
    joinThread: run.threadId,
    model,
    promptBuilder: (sessionId, tmuxName) => {
      let seed = run.protocol.seed(role, { ...ctx, name: tmuxName, sessionId }) ?? `You are ${tmuxName}, the ${role}.`
      const seedMods = ((run.params.modifiers as Modifier[] | undefined) ?? [])
        .filter((m): m is SeedModifier => m.type === 'seed' && m.target === role)
      for (const mod of seedMods) {
        seed += `\n\n---\n**+${mod.name}:**\n${mod.instructions}`
      }
      return seed
    },
  })

  run.participants.set(role, result.sessionId)
  run.sessionToRole.set(result.sessionId, role)
  sessionToRun.set(result.sessionId, run.id)
}

async function postStatusLine(run: ProtocolRun): Promise<void> {
  const half = halfForPhase(run)
  const actor = run.protocol.phases[run.phase]?.actor
  const actorSid = actor ? run.participants.get(actor) : undefined
  const name = actorSid ? registry.get(actorSid)?.tmuxName : undefined
  const roleLabel = actor ? run.protocol.roles[actor] : 'unknown'

  const action = name
    ? `${sessionEmoji(name)} ${name} (${roleLabel}) is working...`
    : `${roleLabel} is working...`

  const text = formatStateLine(run.protocol.emoji, run.protocol.name, formatRoundBadge('', half, run.currentRound, run.rounds), action)
  run.statusHistory.push(text)
  const ids = await safeSend(run.threadId, text)
  run.messageIds.push(...ids)
}

function notifyNextActor(run: ProtocolRun, prevContent: string): void {
  const actor = run.protocol.phases[run.phase]?.actor
  if (!actor) return
  const sid = run.participants.get(actor)
  if (!sid) return

  const notification = run.protocol.turnNotification
    ? run.protocol.turnNotification(run, prevContent)
    : `[${run.protocol.display} — Round ${run.currentRound}/${run.rounds}]\n\n${prevContent}\n\n---\nYour turn. Respond according to your instructions.`
  transport.sendOrQueue(sid, {
    type: 'notification',
    content: notification,
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

async function fireTransition(run: ProtocolRun, event: string, content: string, reason: string): Promise<void> {
  const result = run.protocol.machine.transition(run.phase as any, event as any)
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

function resetTimeout(run: ProtocolRun): void {
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }

  const ms = run.protocol.windowMs(run.phase)
  if (!ms) return

  const phase = run.phase
  const actorRole = run.protocol.phases[phase]?.actor
  const actorSessionId = actorRole ? run.participants.get(actorRole) : undefined

  if (ms > WARNING_BEFORE_TIMEOUT_MS) {
    run._warningTimeout = setTimeout(() => {
      if (run.phase !== phase || !actorSessionId) return
      const info = registry.get(actorSessionId)
      if (info?.turnState === 'working') {
        process.stderr.write(`daemon: ${run.protocol.name} run: warning skipped — ${info.tmuxName} is actively working\n`)
        return
      }
      const ctx = info ? getContextPercent(info.tmuxName) : '?'
      const sentinel = run.protocol.sentinel(phase)
      const hasDecision = Object.values(run.protocol.decisions).some(d => d.phase === phase)
      const sentinelHint = hasDecision
        ? `Use the \`decide\` tool to advance`
        : sentinel ? `Post your \`${sentinel}\`` : 'Post your response'
      const elapsed = Math.round((Date.now() - run._phaseStartedAt) / 60_000)
      const totalMs = ms * TOTAL_PHASE_CAP_FACTOR
      const totalRemaining = Math.max(0, Math.round((run._phaseStartedAt + totalMs - Date.now()) / 60_000))
      // Escalation: urgency text appears only after a deferral (elapsed > window), not on first warning
      const urgency = elapsed > ms / 60_000 ? ` Phase has been running ${elapsed}m — ${totalRemaining}m until hard limit.` : ''
      transport.sendOrQueue(actorSessionId, {
        type: 'notification',
        content: `[system] ⏰ Phase timeout in 2 minutes. ${sentinelHint} or call extend_phase(reason: "...", minutes: N) if you need more time.${urgency} (context: ${ctx})`,
        meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
      void safeSend(run.threadId, `_⏰ ${info?.tmuxName ?? 'actor'} warned: 2m remaining (${ctx} context)_`)
      process.stderr.write(`daemon: ${run.protocol.name} run: warning sent to ${info?.tmuxName ?? actorSessionId} (${ctx} context, ${elapsed}m elapsed)\n`)
    }, ms - WARNING_BEFORE_TIMEOUT_MS)
  }

  run.timeout = setTimeout(async () => {
    if (run.phase !== phase) return
    const info = actorSessionId ? registry.get(actorSessionId) : undefined
    if (info?.turnState === 'working') {
      process.stderr.write(`daemon: ${run.protocol.name} run: timeout deferred — ${info.tmuxName} is actively working\n`)
      resetTimeout(run)
      return
    }
    process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" timed out\n`)
    await fireTransition(run, 'timeout', '', 'timed out')
  }, ms)

  // Invariant: on deferral (recursive resetTimeout), _totalTimeout and
  // _phaseStartedAt survive — they anchor to phase entry, not to the
  // last reset. _extensions also survives (counts across the phase entry).
  // Total backstop — unconditional, never resets, no turnState check.
  // Prevents unbounded deferral from activity-based resets.
  if (!run._totalTimeout) {
    const totalMs = ms * TOTAL_PHASE_CAP_FACTOR
    run._totalTimeout = setTimeout(async () => {
      if (isTerminal(run)) return
      process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" hit total backstop (${Math.round(totalMs / 60_000)}m)\n`)
      await fireTransition(run, 'timeout', '', 'total time exceeded')
    }, totalMs)
  }
}

async function completeRun(run: ProtocolRun): Promise<void> {
  process.stderr.write(`daemon: ${run.protocol.name} run: complete (phase=${run.phase}, rounds=${run.currentRound}/${run.rounds})\n`)

  clearTimers(run)

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
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\` · ${struck}/${run.messageIds.length} messages struck${failNote}_`).catch(() => {})
    } else {
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\`_`).catch(() => {})
    }
  } catch (err) {
    process.stderr.write(`daemon: ${run.protocol.name} transcript dump failed: ${err}\n`)
  }

  const completionEvent: CompletionEvent = {
    protocol: run.protocol.name,
    threadId: run.threadId,
    topic: run.params.topic as string | undefined,
    rounds: { completed: run.currentRound, requested: run.rounds },
    outcome: 'complete',
    decisions: run.decisions.map(d => ({ phase: d.phase, role: d.role, value: d.value, because: d.because })),
    durationMs: Date.now() - run.startedAt,
    transcriptPath,
  }

  protocolEvents.emitComplete(completionEvent)

  for (const [, sid] of run.participants) {
    if (sid === run.ownerSessionId) continue
    sessionToRun.delete(sid)
    const info = registry.get(sid)
    if (info && !killsInProgress.has(sid)) {
      void killSession(info, 'protocol complete').catch(err => process.stderr.write(`daemon: kill on complete failed: ${err}\n`))
    }
  }
  cleanupRun(run)
  refreshSessionVisual(run.threadId)
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __test = process.env.NODE_ENV === 'test'
  ? { runs, threadToRun, sessionToRun, resetTimeout } as const
  : undefined

// ---------------------------------------------------------------------------
// Lookups (for protocol registry integration)
// ---------------------------------------------------------------------------

export function getRunByThread(threadId: string): ProtocolRun | undefined {
  const id = threadToRun.get(threadId)
  return id ? runs.get(id) : undefined
}

// ---------------------------------------------------------------------------
// Protocol registry integration — register v2 protocols
// ---------------------------------------------------------------------------

function runnerHooks(name: string, protoName: string) {
  registerProtocol(name, {
    getByThread: (threadId) => {
      const run = getRunByThread(threadId)
      return !!run && run.protocol.name === protoName
    },
    isParticipant: (sessionId) => {
      const runId = sessionToRun.get(sessionId)
      return !!runId && runs.get(runId)?.protocol.name === protoName
    },
    onReply: onRunReply,
    onDisconnect: onRunDisconnect,
    onReconnect: onRunReconnect,
    onDecision: (sessionId, value, because) => {
      return onRunDecision(sessionId, value, because)
    },
    expectedTag: (sessionId, chatId) => {
      const runId = sessionToRun.get(sessionId)
      const run = runId ? runs.get(runId) : undefined
      if (!run || chatId !== run.threadId) return null
      const role = run.sessionToRole.get(sessionId)
      if (!role) return null
      const phase = run.protocol.phases[run.phase]
      if (phase?.actor !== role) return null
      const hasDecisionOnly = Object.values(run.protocol.decisions).some(d => d.phase === run.phase) && !phase?.replyEvent
      if (hasDecisionOnly) return null
      return run.protocol.sentinel(run.phase) ?? null
    },
  })
}

runnerHooks('review_v2', 'review')
runnerHooks('build_v2', 'build')
runnerHooks('spike_v2', 'spike')
