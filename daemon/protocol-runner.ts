import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, type ProtocolName } from './protocol-registry.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { safeSend, type StatusLineState } from './util.js'
import { dumpTranscript } from './transcript-dump.js'
import type { Protocol } from './protocol-dsl.js'
import type { LensDef } from './lens-loader.js'

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
  ext: Record<string, unknown>
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
  params: { rounds?: number; topic?: string; model?: string; lenses?: LensDef[]; strike?: boolean; [key: string]: unknown } = {},
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
    ext: {
      lenses: params.lenses,
      currentLensIdx: undefined as number | undefined,
      strike: params.strike ?? false,
    },
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

  // Sentinel check: if the phase declares a sentinel, the message must start with it
  const sentinel = run.protocol.sentinel(run.phase)
  if (sentinel && !firstLine.startsWith(sentinel)) return

  const bodyText = text.slice(text.indexOf('\n') + 1).trim()

  // Determine which event to fire — declarative, not heuristic
  const event = resolveEvent(run)
  if (!event) return

  const result = run.protocol.machine.transition(run.phase as any, event as any)
  if (!result.ok) return

  run.messageIds.push(...sentMessageIds)

  if (run.timeout) clearTimeout(run.timeout)

  const prevPhase = run.phase
  run.phase = result.to

  afterTransition(run, prevPhase, bodyText)
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
  const prevPhase = run.phase
  run.phase = result.to

  afterTransition(run, prevPhase, because)
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

function findOwnerRole(proto: Protocol): string {
  return proto.ownerRole
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

// ---------------------------------------------------------------------------
// Phase behavior registry — declared on phases, executed by the runner
// ---------------------------------------------------------------------------

type BehaviorHandler = (run: ProtocolRun, prevPhase: string, content: string) => boolean

const BEHAVIORS: Record<string, BehaviorHandler> = {
  advanceRound: (run, prevPhase) => {
    if (prevPhase !== run.phase) run.currentRound++
    return false
  },

  lensIteration: (run, prevPhase, content) => {
    const lenses = run.ext.lenses as LensDef[] | undefined

    // Entering the lens phase for the first time
    if (prevPhase !== run.phase) {
      if (lenses && lenses.length > 0) {
        run.ext.currentLensIdx = 0
        sendLensInstruction(run)
        postStatusLine(run)
        resetTimeout(run)
        return true
      }
      // No lenses — skip via timeout
      const skip = run.protocol.machine.transition(run.phase as any, 'timeout' as any)
      if (skip.ok) {
        run.phase = skip.to
        afterTransition(run, prevPhase, content)
        return true
      }
    }

    // Looping within the lens phase — advance to next lens
    if (prevPhase === run.phase && lenses) {
      const idx = ((run.ext.currentLensIdx as number) ?? 0) + 1
      if (idx < lenses.length) {
        run.ext.currentLensIdx = idx
        sendLensInstruction(run)
        postStatusLine(run)
        resetTimeout(run)
        return true
      }
      // All lenses done
      const tr = run.protocol.machine.transition(run.phase as any, 'timeout' as any)
      if (tr.ok) {
        run.phase = tr.to
        afterTransition(run, prevPhase, content)
        return true
      }
    }

    return false
  },

  closing: (run, prevPhase, content) => {
    if (prevPhase === run.phase) return false
    void enterClosing(run, content)
    return true
  },
}

function afterTransition(run: ProtocolRun, prevPhase: string, content: string): void {
  if (isTerminal(run)) {
    completeRun(run)
    return
  }

  const phase = run.protocol.phases[run.phase]
  for (const behavior of phase?.onEnter ?? []) {
    const handler = BEHAVIORS[behavior]
    if (handler && handler(run, prevPhase, content)) return
  }

  notifyNextActor(run, content)
  postStatusLine(run)
  resetTimeout(run)
}

function sendLensInstruction(run: ProtocolRun): void {
  const lenses = run.ext.lenses as LensDef[] | undefined
  const idx = run.ext.currentLensIdx as number | undefined
  if (!lenses || idx === undefined) return
  const lens = lenses[idx]
  const actor = run.protocol.phases[run.phase]?.actor
  if (!actor) return
  const actorSid = run.participants.get(actor)
  if (!actorSid) return

  const passLabel = `+${lens.lens} (${idx + 1}/${lenses.length})`
  const roleLabel = run.protocol.roles[actor] ?? actor
  const statusText = formatStateLine(run.protocol.emoji, run.protocol.name, passLabel, `${roleLabel} reviewing ${lens.lens}`)
  if (!run.statusHistory) run.statusHistory = []
  run.statusHistory.push(statusText)
  void safeSend(run.threadId, statusText).then(ids => run.messageIds.push(...ids))

  transport.sendOrQueue(actorSid, {
    type: 'notification',
    content: [
      `[system] Correctness debate complete. Now do a **${lens.lens}** pass.`,
      ``,
      lens.instructions,
      ``,
      `Post your feedback. Use decide('clean', why) if everything is fine, or decide('findings', what_to_fix) if not.`,
    ].join('\n'),
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

async function enterClosing(run: ProtocolRun, _lastContent: string): Promise<void> {
  const phase = run.phase
  // Kill non-owner participants
  for (const [role, sid] of run.participants) {
    if (sid === run.ownerSessionId) continue
    sessionToRun.delete(sid)
    const info = registry.get(sid)
    if (info && !killsInProgress.has(sid)) {
      try { await killSession(info, 'protocol closing') } catch {}
    }
  }

  void safeSend(run.threadId, formatStateLine(run.protocol.emoji, run.protocol.name, '⚒︎', 'has concluded. Processing summary…'))

  clearTimers(run)

  // Backstop timeout for the closing phase
  const closingMs = run.protocol.windowMs(phase) ?? 5 * 60 * 1000
  run.timeout = setTimeout(() => {
    if (run.phase !== phase) return
    const tr = run.protocol.machine.transition(run.phase as any, 'timeout' as any)
    if (tr.ok) run.phase = tr.to
    completeRun(run)
  }, closingMs)

  // Notify owner to post summary
  const sentinel = run.protocol.sentinel(phase) ?? '[summary]'
  transport.sendOrQueue(run.ownerSessionId, {
    type: 'notification',
    content: [
      `[system] ${run.protocol.display} complete (${run.currentRound} round${run.currentRound > 1 ? 's' : ''}).`,
      `Post a closing summary to your thread.`,
      ``,
      `**Message routing:** Your first line MUST be \`${sentinel}\`. Messages without this tag won't complete the protocol.`,
    ].join('\n'),
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

function resolveEvent(run: ProtocolRun): string | null {
  const phase = run.protocol.phases[run.phase]
  if (!phase) return null

  if (phase.finalRoundEvent && run.currentRound >= run.rounds) return phase.finalRoundEvent
  return phase.replyEvent ?? null
}

function resolveDecisionEvent(run: ProtocolRun, value: string): string | null {
  const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase)
  if (!decision) return null

  // Use the declared event mapping
  if (decision.events?.[value]) {
    // Check for final round override
    if (decision.finalEvent && run.currentRound >= run.rounds) return decision.finalEvent
    return decision.events[value]
  }

  // Fallback: direct match in the transition table
  const phase = run.protocol.phases[run.phase]
  return phase ? Object.keys(phase.on).find(e => e === value) ?? null : null
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

  void dumpTranscript(run.threadId, run.protocol.name, run.messageIds, {
    rounds: `${run.currentRound}/${run.rounds}`,
    outcome: run.phase,
    ...(run.params.topic ? { topic: String(run.params.topic) } : {}),
  }, run.statusHistory).then(async (dumpPath) => {
    if (!dumpPath) {
      process.stderr.write(`daemon: ${run.protocol.name}: transcript dump failed — leaving messages in place\n`)
      return
    }
    if (run.ext.strike && run.messageIds.length > 0) {
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

  const onComplete = run.ext.onComplete as ((r: ProtocolRun) => void | Promise<void>) | undefined
  if (onComplete) {
    void Promise.resolve(onComplete(run)).catch(err => {
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

// ---------------------------------------------------------------------------
// Protocol registry integration — register v2 protocols
// ---------------------------------------------------------------------------

function runnerHooks(name: ProtocolName) {
  registerProtocol(name, {
    getByThread: (threadId) => {
      const run = getRunByThread(threadId)
      return !!run && run.protocol.name === name.replace('_v2', '')
    },
    isParticipant: isRunParticipant,
    onReply: onRunReply,
    onDisconnect: onRunDisconnect,
    onReconnect: onRunReconnect,
    onDecision: (sessionId, value, because) => {
      onRunDecision(sessionId, value, because)
      return true
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

runnerHooks('review_v2')
runnerHooks('build_v2')
runnerHooks('spike_v2')
