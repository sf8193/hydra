import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, type ProtocolName } from './protocol-registry.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { safeSend, type StatusLineState } from './util.js'
import { dumpTranscript } from './transcript-dump.js'
import type { Protocol } from './protocol-dsl.js'

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type ProtocolRun = StatusLineState & {
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
  decisions: Array<{ phase: string; role: string; value: string; because: string }>
  onComplete?: (run: ProtocolRun) => void | Promise<void>
  _closing?: { approved: boolean; lastCriticText: string }
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
  }

  runs.set(id, run)
  threadToRun.set(threadId, id)
  sessionToRun.set(ownerSessionId, id)

  const ownerRole = findOwnerRole(proto)
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
  return run
}

// ---------------------------------------------------------------------------
// Reply handler
// ---------------------------------------------------------------------------

export function onRunReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
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

  const bodyText = text.slice(text.indexOf('\n') + 1).trim()

  // Find the first matching event for this phase
  const events = Object.keys(phaseDef.on)
  if (events.length === 0) return

  // Determine which event to fire based on protocol logic
  const event = resolveEvent(run, role, bodyText, events)
  if (!event) return

  const result = run.protocol.machine.transition(run.phase as any, event as any)
  if (!result.ok) return

  run.messageIds.push(...sentMessageIds)

  if (run.timeout) clearTimeout(run.timeout)

  const prevPhase = run.phase
  run.phase = result.to

  if (isTerminal(run)) {
    completeRun(run)
    return
  }

  // If we looped back (e.g., critic_turn → owner_turn → critic_turn), advance round
  if (run.phase === run.protocol.initialPhase && prevPhase !== run.phase) {
    run.currentRound++
  }

  // Notify the next actor
  notifyNextActor(run, bodyText)
  postStatusLine(run)
  resetTimeout(run)
}

// ---------------------------------------------------------------------------
// Decision handler
// ---------------------------------------------------------------------------

export function onRunDecision(sessionId: string, value: string, because: string): void {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return
  const run = runs.get(runId)
  if (!run) return

  const role = run.sessionToRole.get(sessionId)
  if (!role) return

  // Find the decision declared for the current phase
  const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase && d.actor === role)
  if (!decision) {
    process.stderr.write(`daemon: ${run.protocol.name} run: no decision declared for phase "${run.phase}" actor "${role}"\n`)
    return
  }

  if (!decision.options.includes(value)) {
    process.stderr.write(`daemon: ${run.protocol.name} run: invalid decision value "${value}" (expected: ${decision.options.join(' | ')})\n`)
    return
  }

  run.decisions.push({ phase: run.phase, role, value, because })

  // Post narration to the thread
  void safeSend(run.threadId, `**${run.protocol.roles[role]}** decided: **${value}**\n${because}`).then(ids => {
    run.messageIds.push(...ids)
  })

  // Determine the event from the value
  const eventMap = resolveDecisionEvent(run, value)
  if (!eventMap) return

  const result = run.protocol.machine.transition(run.phase as any, eventMap as any)
  if (!result.ok) return

  if (run.timeout) clearTimeout(run.timeout)
  run.phase = result.to

  if (isTerminal(run)) {
    completeRun(run)
    return
  }

  notifyNextActor(run, because)
  postStatusLine(run)
  resetTimeout(run)
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
    run.phase = 'cancelled'
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

function findOwnerRole(proto: Protocol): string | undefined {
  const roles = Object.keys(proto.roles)
  return roles.find(r => r === 'owner' || r === 'builder' || r === 'guide') ?? roles[roles.length - 1]
}

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

function resolveEvent(run: ProtocolRun, role: string, bodyText: string, events: string[]): string | null {
  const nonControl = events.filter(e => e !== 'timeout' && e !== 'cancel')

  // Check for round-boundary events (any event containing "final")
  if (run.currentRound >= run.rounds) {
    const finalEvent = nonControl.find(e => e.includes('final'))
    if (finalEvent) return finalEvent
  }

  // Default: the first non-timeout, non-cancel, non-final event
  return nonControl.find(e => !e.includes('final')) ?? nonControl[0] ?? null
}

function resolveDecisionEvent(run: ProtocolRun, value: string): string | null {
  const phase = run.protocol.phases[run.phase]
  if (!phase) return null

  // Map decision values to events. Convention: the event name contains the value
  // or there's a direct match in the transition table.
  const events = Object.keys(phase.on)

  // Direct match: event name equals or contains the value
  const direct = events.find(e => e === value || e.includes(value))
  if (direct) return direct

  // For approve/request_changes in build: map to critic_lgtm/critic_feedback
  if (value === 'approve') return events.find(e => e.includes('lgtm') || e.includes('approve')) ?? null
  if (value === 'request_changes') {
    if (run.currentRound >= run.rounds) return events.find(e => e.includes('final')) ?? null
    return events.find(e => e.includes('feedback') || e.includes('changes')) ?? null
  }

  return null
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
  const seed = run.protocol.seed(role, { ...ctx, name: role, sessionId: 'pending' })

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

function postStatusLine(run: ProtocolRun): void {
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
  void safeSend(run.threadId, text).then(ids => run.messageIds.push(...ids))
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

function resetTimeout(run: ProtocolRun): void {
  if (run.timeout) clearTimeout(run.timeout)

  const ms = run.protocol.windowMs(run.phase)
  if (!ms) return

  run.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: ${run.protocol.name} run: phase "${run.phase}" timed out\n`)
    const result = run.protocol.machine.transition(run.phase as any, 'timeout' as any)
    if (result.ok) {
      run.phase = result.to
      if (isTerminal(run)) {
        completeRun(run)
      } else {
        postStatusLine(run)
        resetTimeout(run)
      }
    } else {
      await cancelRun(run, 'timed out')
    }
  }, ms)
}

function completeRun(run: ProtocolRun): void {
  process.stderr.write(`daemon: ${run.protocol.name} run: complete (phase=${run.phase}, rounds=${run.currentRound}/${run.rounds})\n`)

  clearTimers(run)

  void safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎',
    `concluded — ${run.currentRound} round${run.currentRound > 1 ? 's' : ''}`))

  const owner = registry.get(run.ownerSessionId)?.tmuxName ?? run.ownerSessionId
  void dumpTranscript(run.threadId, run.protocol.name, run.messageIds, {
    rounds: `${run.currentRound}/${run.rounds}`,
    outcome: run.phase,
    ...(run.params.topic ? { topic: String(run.params.topic) } : {}),
  }, run.statusHistory).catch(err => {
    process.stderr.write(`daemon: ${run.protocol.name} transcript dump failed: ${err}\n`)
  })

  if (run.onComplete) {
    void Promise.resolve(run.onComplete(run)).catch(err => {
      process.stderr.write(`daemon: ${run.protocol.name} onComplete failed: ${err}\n`)
    })
  }

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
