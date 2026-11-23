import { EventEmitter } from 'events'
import type { StatusLineState } from '../../infra/util.js'
import type { ProtocolChildSpawnMetadata } from '../../sessions/protocol-registry.js'
import type { Protocol } from '../../protocols/dsl.js'
import type { CompletionEvent, PhaseChangeEvent } from '../../shared/protocol-types.js'
import { doSpawnSession as _doSpawnSession, killSession as _killSession, waitForBridge as _waitForBridge } from '../session-lifecycle.js'

export const runnerLifecycle = {
  doSpawnSession: _doSpawnSession,
  waitForBridge: _waitForBridge,
  killSession: _killSession,
}

export function setRunnerLifecycle(overrides: { doSpawnSession?: typeof _doSpawnSession; waitForBridge?: typeof _waitForBridge; killSession?: typeof _killSession }): void {
  if (overrides.doSpawnSession) runnerLifecycle.doSpawnSession = overrides.doSpawnSession
  if (overrides.waitForBridge) runnerLifecycle.waitForBridge = overrides.waitForBridge
  if (overrides.killSession) runnerLifecycle.killSession = overrides.killSession
}

export function resetRunnerLifecycle(): void {
  runnerLifecycle.doSpawnSession = _doSpawnSession
  runnerLifecycle.waitForBridge = _waitForBridge
  runnerLifecycle.killSession = _killSession
}

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
  startedAt: number
  params: Record<string, unknown>
  participants: Map<string, string>
  sessionToRole: Map<string, string>
  protocolChildren: Map<string, ProtocolChildRecord>
  timeout?: ReturnType<typeof setTimeout>
  _warningTimeout?: ReturnType<typeof setTimeout>
  _totalTimeout?: ReturnType<typeof setTimeout>
  _extensions: number
  _phaseStartedAt: number
  _resumeAttempts?: number
  _pendingFallback?: string
  // Set the moment the run leaves the normal path for the protocol's fallback
  // phase, by either door (participant death or a direct request). Read once, at
  // completion, to label the CompletionEvent — the phase itself can't say it,
  // since a completed run has already moved on to a terminal phase.
  _enteredFallback?: boolean
  _healthMonitor?: ReturnType<typeof setInterval>
  _nudged?: boolean
  _escalated?: boolean
  _bridgeEscalated?: boolean
  // One entry per disconnect episode of a participant: set when the episode starts,
  // removed only on reconnect, replacement, retirement or run cleanup (an expired
  // grace timer's entry stays, so repeat reports of the same death are ignored).
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>
  decisions: Array<{ phase: string; role: string; value: string; because: string; context?: string }>
  strike: boolean
  statusHistory: string[]
  summary?: string
}

export type ProtocolChildRecord = ProtocolChildSpawnMetadata & {
  phase: string
  parentSessionId: string
  result?: string
}

export const MAX_EXTENSIONS_PER_PHASE = 2
// Privacy outlives the phase record: child termination is asynchronous, so a
// retiring helper remains restricted until killSession has actually settled.
export const privateProtocolChildren = new Set<string>()
// Covers the interval between pre-launch protocol registration and the child
// appearing in the session registry. Phase cleanup must not open a write window.
export const pendingPrivateProtocolChildren = new Set<string>()
export const WARNING_BEFORE_TIMEOUT_MS = 2 * 60 * 1000
export const TOTAL_PHASE_CAP_FACTOR = 3
export const HEALTH_CHECK_INTERVAL_MS = 30_000
export const IDLE_NUDGE_MS = 5 * 60 * 1000
export const IDLE_ESCALATE_MS = 10 * 60 * 1000

export const runs = new Map<string, ProtocolRun>()
export const threadToRun = new Map<string, string>()
export const sessionToRun = new Map<string, string>()
export const transitioningRuns = new Set<string>()
export const cancellingRuns = new Set<string>()

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
  emitPhaseChange(event: PhaseChangeEvent): void {
    for (const fn of this.listeners('phase-change')) {
      try { (fn as (e: PhaseChangeEvent) => void)(event) }
      catch (err) { process.stderr.write(`daemon: phase-change event listener error: ${err}\n`) }
    }
  }
  /** Listeners must be synchronous — async rejections are unhandled. */
  onPhaseChange(fn: (event: PhaseChangeEvent) => void): void { this.on('phase-change', fn) }
  offPhaseChange(fn: (event: PhaseChangeEvent) => void): void { this.off('phase-change', fn) }
  /** Listeners must be synchronous — async rejections are unhandled. */
  onComplete(fn: (event: CompletionEvent) => void): void { this.on('complete', fn) }
  offComplete(fn: (event: CompletionEvent) => void): void { this.off('complete', fn) }
  onceComplete(threadId: string, fn: (event: CompletionEvent) => void): () => void {
    const wrapper = (event: CompletionEvent) => {
      if (event.threadId !== threadId) return
      this.offComplete(wrapper)
      fn(event)
    }
    this.onComplete(wrapper)
    return () => this.offComplete(wrapper)
  }}

export const protocolEvents = new ProtocolEventBus()


export function getRunAndRole(sessionId: string): { run: ProtocolRun; role: string } | null {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return null
  const run = runs.get(runId)
  if (!run) return null
  const role = run.sessionToRole.get(sessionId)
  if (!role) return null
  return { run, role }
}


export function halfForPhase(run: ProtocolRun): 'top' | 'bottom' {
  return run.protocol.phases[run.phase]?.half ?? 'top'
}

export function completedRoundsOf(run: ProtocolRun): number {
  return Math.max(0, run.currentRound - 1)
}

export function isTerminal(run: ProtocolRun): boolean {
  const phase = run.protocol.phases[run.phase]
  return !phase || Object.keys(phase.on).length === 0
}

export function clearPhaseTimers(run: ProtocolRun): void {
  if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined }
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }
  if (run._totalTimeout) { clearTimeout(run._totalTimeout); run._totalTimeout = undefined }
  if (run._healthMonitor) { clearInterval(run._healthMonitor); run._healthMonitor = undefined }
}


export function clearTimers(run: ProtocolRun): void {
  clearPhaseTimers(run)
  for (const timer of run.disconnectTimers.values()) clearTimeout(timer)
  run.disconnectTimers.clear()
}

export function formatAdvanceUsagePattern(proto: Protocol, phase: string): string {
  const ia = proto.phaseInteraction(phase)
  if (!ia || ia.verdict === 'none') return `advance({ content: "..." })`

  const example = ia.options?.[0] ?? '...'
  const alts = ia.options && ia.options.length > 1 ? ` (or: ${ia.options.slice(1).join(', ')})` : ''
  const verdictCall = `advance({ content: "...", verdict: "${example}" })${alts}`

  if (ia.verdict === 'optional') {
    return `advance({ content: "..." }) for progress, or ${verdictCall} to finish`
  }
  return verdictCall
}

export function resolveAdvanceEvent(run: ProtocolRun, verdict?: string): string | null {
  const phase = run.protocol.phases[run.phase]
  if (!phase) return null

  if (verdict) {
    const decision = Object.values(run.protocol.decisions).find(d => d.phase === run.phase)
    if (!decision) return null
    if (run.currentRound >= run.rounds) {
      const finalEvent = decision.finalEvents?.[verdict] ?? decision.finalEvent
      if (finalEvent) return finalEvent
    }
    if (!decision.events) return verdict
    return decision.events[verdict] ?? null
  }

  if (phase.finalAdvanceEvent && run.currentRound >= run.rounds) return phase.finalAdvanceEvent
  return phase.advanceEvent ?? null
}


// Which door the run came through, for the CompletionEvent. `directSubagent`
// wins over `_enteredFallback` because the direct path sets both — it is the
// more specific truth: the caller chose this, nothing died.
export function completionVia(run: ProtocolRun): 'normal' | 'fallback' | 'direct' {
  if (run.params.directSubagent) return 'direct'
  if (run._enteredFallback) return 'fallback'
  return 'normal'
}

export function getRunByThread(threadId: string): ProtocolRun | undefined {
  const id = threadToRun.get(threadId)
  return id ? runs.get(id) : undefined
}

export function getActiveRuns(): ProtocolRun[] {
  return [...runs.values()].filter(r => !isTerminal(r))
}

// Protocol context for autopsy — joins session to protocol state
export function getProtocolContext(sessionId: string): { protocol: string; phase: string; round: string; advanceCalled: boolean; role: string } | null {
  const runId = sessionToRun.get(sessionId)
  if (!runId) return null
  const run = runs.get(runId)
  if (!run) return null
  const role = run.sessionToRole.get(sessionId)
  if (!role) return null
  const advanceCalled = run.decisions.some(d => d.role === role)
  return {
    protocol: run.protocol.name,
    phase: run.phase,
    round: `${run.currentRound}/${run.rounds}`,
    advanceCalled,
    role,
  }
}
