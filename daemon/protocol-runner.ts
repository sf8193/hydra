import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, type ProtocolName } from './protocol-registry.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { safeSend, type StatusLineState } from './util.js'
import { dumpTranscript } from './transcript-dump.js'
import type { Protocol } from './protocol-dsl.js'
import type { RunState, BehaviorContext } from './protocol-types.js'

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
  params: Record<string, unknown>
  participants: Map<string, string>
  sessionToRole: Map<string, string>
  timeout?: ReturnType<typeof setTimeout>
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>
  decisions: Array<{ phase: string; role: string; value: string; because: string; context?: string }>
  strike: boolean
  ext: Ext
}

const runs = new Map<string, ProtocolRun>()
const threadToRun = new Map<string, string>()
const sessionToRun = new Map<string, string>()

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

  const id = Math.random().toString(36).slice(2, 10)
  const rounds = (params.rounds as number) ?? 3

  const run: ProtocolRun = {
    id,
    protocol: proto,
    threadId,
    ownerSessionId,
    phase: proto.initialPhase,
    currentRound: 1,
    rounds,
    params,
    participants: new Map(),
    sessionToRole: new Map(),
    timeout: undefined,
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
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

  const topicLine = params.topic ? `\nFocus: **${params.topic}**` : ''
  const annIds = await safeSend(threadId, `**${proto.display}** — ${rounds} round${rounds > 1 ? 's' : ''}${topicLine}`)
  run.messageIds.push(...annIds)

  for (const [role] of Object.entries(proto.roles)) {
    if (role === ownerRole) continue
    await spawnRole(run, role, params)
  }

  postStatusLine(run)
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
// Reply handler
// ---------------------------------------------------------------------------

export async function onRunReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): Promise<void> {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return
  const run = runs.get(runId)
  if (!run || chatId !== run.threadId) return

  const role = run.sessionToRole.get(sessionId)
  if (!role) return

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

  const result = run.protocol.machine.transition(run.phase as any, event as any)
  if (!result.ok) return

  // Don't track closing-phase posts (summary is work product, not scaffolding)
  const closingPhase = run.protocol.closingPhase
  if (run.phase !== closingPhase) {
    run.messageIds.push(...sentMessageIds)
  }

  if (run.timeout) clearTimeout(run.timeout)

  const prevPhase = run.phase
  run.phase = result.to

  const prevPhaseDef = run.protocol.phases[prevPhase]
  if (prevPhaseDef?.finalRoundEvent && event !== prevPhaseDef.finalRoundEvent) {
    run.currentRound++
  }

  await afterTransition(run, prevPhase, bodyText)
}

// ---------------------------------------------------------------------------
// Decision handler
// ---------------------------------------------------------------------------

export async function onRunDecision(sessionId: string, value: string, because: string): Promise<boolean> {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return false
  const run = runs.get(runId)
  if (!run) return false

  const role = run.sessionToRole.get(sessionId)
  if (!role) return false

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

  const context = run.protocol.decisionContext?.(run)
  run.decisions.push({ phase: run.phase, role, value, because, context })

  // Post narration — await IDs before transitioning so they're tracked for strike
  const narrationIds = await safeSend(run.threadId, `**${run.protocol.roles[role]}** decided: **${value}**\n${because}`)
  run.messageIds.push(...narrationIds)

  // Determine the event from the value
  const eventMap = resolveDecisionEvent(run, value)
  if (!eventMap) return false

  const result = run.protocol.machine.transition(run.phase as any, eventMap as any)
  if (!result.ok) return false

  if (run.timeout) clearTimeout(run.timeout)
  const prevPhase = run.phase
  run.phase = result.to

  if (result.to === run.protocol.initialPhase && eventMap !== decision.finalEvent) {
    run.currentRound++
  }

  await afterTransition(run, prevPhase, because)
  return true
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

  const graceMs = run.protocol.graceMs(role)
  if (!graceMs) {
    void cancelRun(run, `${role} disconnected (no grace period)`)
    return
  }

  process.stderr.write(`daemon: ${run.protocol.name} run: ${role} disconnected — ${graceMs / 1000}s grace\n`)
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }

  run.disconnectTimers.set(sessionId, setTimeout(() => {
    process.stderr.write(`daemon: ${run.protocol.name} run: ${role} did not reconnect\n`)
    void cancelRun(run, `${role} did not reconnect`)
  }, graceMs))
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
  const cancelEvent = Object.entries(run.protocol.phases[run.phase]?.on ?? {}).find(([e]) => e === 'cancel')
  if (cancelEvent) {
    const result = run.protocol.machine.transition(run.phase as any, 'cancel' as any)
    if (result.ok) run.phase = result.to
  } else {
    process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" has no cancel transition — forcing terminal\n`)
  }

  clearTimers(run)

  for (const [role, sid] of run.participants) {
    if (sid === run.ownerSessionId) continue
    const info = registry.get(sid)
    if (info && !killsInProgress.has(sid)) {
      try { await killSession(info, reason) } catch {}
    }
  }

  cleanupRun(run)
  refreshSessionVisual(run.threadId)
  await safeSend(run.threadId, `${run.protocol.display} cancelled: ${reason}`)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------


function halfForPhase(run: ProtocolRun): 'top' | 'bottom' {
  return run.protocol.phases[run.phase]?.half ?? 'top'
}

function isTerminal(run: ProtocolRun): boolean {
  const phase = run.protocol.phases[run.phase]
  return !phase || Object.keys(phase.on).length === 0
}

function clearTimers(run: ProtocolRun): void {
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
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
    const sentinel = run.protocol.sentinel(run.phase) ?? '[summary]'
    const concludedIds = await safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎', 'has concluded. Processing summary…'))
    run.messageIds.push(...concludedIds)
    const formatLines = run.protocol.summaryFormat(run)
    transport.sendOrQueue(run.ownerSessionId, {
      type: 'notification',
      content: [
        `[system] ${run.protocol.display} complete (${run.currentRound} round${run.currentRound > 1 ? 's' : ''}).`,
        `Post a closing summary to your thread using this format:`,
        ``,
        ...formatLines,
        ``,
        `**Message routing:** Your first line MUST be \`${sentinel}\`. Messages without this tag won't complete the protocol.`,
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
    completeRun(run)
    return
  }

  const ctx = makeBehaviorCtx(run)
  const phase = run.protocol.phases[run.phase]
  let handled = false
  for (const behavior of phase?.onEnter ?? []) {
    const handler = typeof behavior === 'function'
      ? (r: ProtocolRun, p: string, c: string, cx: BehaviorContext) => behavior(r, p, c, cx)
      : BEHAVIORS[behavior]
    if (handler && await handler(run, prevPhase, content, ctx)) handled = true
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

  // Suppress reply-based advancement when a decision is declared for this phase
  const hasDecision = Object.values(run.protocol.decisions).some(d => d.phase === run.phase)
  if (hasDecision) return null

  if (phase.finalRoundEvent && run.currentRound >= run.rounds) return phase.finalRoundEvent
  return phase.replyEvent ?? null
}

function resolveDecisionEvent(run: ProtocolRun, value: string): string | null {
  const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase)
  if (!decision) return null

  // Use the declared event mapping — no fallback to raw transition names
  if (!decision.events?.[value]) return null

  if (decision.finalEvent && run.currentRound >= run.rounds) return decision.finalEvent
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
      return run.protocol.seed(role, { ...ctx, name: tmuxName, sessionId }) ?? `You are ${tmuxName}, the ${role}.`
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
  if (!run.statusHistory) run.statusHistory = []
  run.statusHistory.push(text)
  const ids = await safeSend(run.threadId, text)
  run.messageIds.push(...ids)
}

function notifyNextActor(run: ProtocolRun, prevContent: string): void {
  const actor = run.protocol.phases[run.phase]?.actor
  if (!actor) return
  const sid = run.participants.get(actor)
  if (!sid) return

  transport.sendOrQueue(sid, {
    type: 'notification',
    content: `[${run.protocol.display} — Round ${run.currentRound}/${run.rounds}]\n\n${prevContent}\n\n---\nYour turn. Respond according to your instructions.`,
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
  run.phase = result.to
  if (isTerminal(run)) {
    if (result.to === run.protocol.cancelPhase) {
      run.phase = prevPhase
      await cancelRun(run, reason)
    } else {
      completeRun(run)
    }
  } else {
    await afterTransition(run, prevPhase, content)
  }
}

function resetTimeout(run: ProtocolRun): void {
  if (run.timeout) clearTimeout(run.timeout)

  const ms = run.protocol.windowMs(run.phase)
  if (!ms) return

  const phase = run.phase
  run.timeout = setTimeout(async () => {
    if (run.phase !== phase) return
    process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" timed out\n`)
    await fireTransition(run, 'timeout', '', 'timed out')
  }, ms)
}

function completeRun(run: ProtocolRun): void {
  process.stderr.write(`daemon: ${run.protocol.name} run: complete (phase=${run.phase}, rounds=${run.currentRound}/${run.rounds})\n`)

  clearTimers(run)

  void safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎',
    `concluded — ${run.currentRound} round${run.currentRound > 1 ? 's' : ''}`))

  void dumpTranscript(run.threadId, run.protocol.name, run.messageIds, {
    rounds: `${run.currentRound}/${run.rounds}`,
    outcome: run.phase,
    ...(run.params.topic ? { topic: String(run.params.topic) } : {}),
  }, run.statusHistory).then(async (dumpPath) => {
    if (!dumpPath) {
      process.stderr.write(`daemon: ${run.protocol.name}: transcript dump failed — leaving messages in place\n`)
      return
    }
    if (run.strike && run.messageIds.length > 0) {
      let failures = 0
      for (let i = 0; i < run.messageIds.length; i++) {
        try { await gateway.delete(run.threadId, run.messageIds[i]) } catch { failures++ }
        if (i < run.messageIds.length - 1) await new Promise(r => setTimeout(r, 1000))
      }
      const struck = run.messageIds.length - failures
      const failNote = failures > 0 ? ` · ⚠️ ${failures} delete${failures > 1 ? 's' : ''} failed` : ''
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\` · ${struck}/${run.messageIds.length} messages struck${failNote}_`)
    } else if (dumpPath) {
      void safeSend(run.threadId, `_📼 transcript saved: \`${dumpPath}\`_`)
    }
  }).catch(err => {
    process.stderr.write(`daemon: ${run.protocol.name} transcript dump failed: ${err}\n`)
  })

  cleanupRun(run)
  refreshSessionVisual(run.threadId)
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __test = process.env.NODE_ENV === 'test'
  ? { runs, threadToRun, sessionToRun } as const
  : undefined

// ---------------------------------------------------------------------------
// Lookups (for protocol registry integration)
// ---------------------------------------------------------------------------

export function getRunByThread(threadId: string): ProtocolRun | undefined {
  const id = threadToRun.get(threadId)
  return id ? runs.get(id) : undefined
}

export function isRunParticipant(sessionId: string): boolean {
  return sessionToRun.has(sessionId)
}

// ---------------------------------------------------------------------------
// Protocol registry integration — register v2 protocols
// ---------------------------------------------------------------------------

function runnerHooks(name: ProtocolName, protoName: string) {
  registerProtocol(name, {
    getByThread: (threadId) => {
      const run = getRunByThread(threadId)
      return !!run && run.protocol.name === protoName
    },
    isParticipant: isRunParticipant,
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
      return run.protocol.sentinel(run.phase) ?? null
    },
  })
}

runnerHooks('review_v2', 'review')
runnerHooks('build_v2', 'build')
runnerHooks('spike_v2', 'spike')
