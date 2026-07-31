import { jest } from 'bun:test'
import { onRunReply, onRunAdvance, onRunDisconnect, onRunReconnect, onRunExtend, protocolEvents, cancelRun, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import type { Protocol } from '../protocol-dsl.js'
import type { ProtocolRun } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'
import type { SessionInfo } from '../sessions.js'

if (!__test) throw new Error('TestHarness requires NODE_ENV=test')
const { runs, threadToRun, sessionToRun, resetTimeout: armTimeout, WARNING_BEFORE_TIMEOUT_MS, TOTAL_PHASE_CAP_FACTOR: _CAP, setLifecycle, resetLifecycle } = __test
export const TOTAL_PHASE_CAP_FACTOR = _CAP
export { WARNING_BEFORE_TIMEOUT_MS }

type HarnessOpts = {
  rounds?: number
  topic?: string
  strike?: boolean
  params?: Record<string, unknown>
}

export class TestHarness {
  readonly run: ProtocolRun
  private readonly sessionIds: Map<string, string>
  private lastTimeoutArmedAt: number
  private readonly origGatewaySend: typeof gateway.send
  private readonly origGatewayDelete: typeof gateway.delete
  private readonly origGatewayReact: typeof gateway.react
  private readonly origGatewayFetch: typeof gateway.fetchMessages
  private readonly origStderrWrite: typeof process.stderr.write
  private readonly completionListener: (e: CompletionEvent) => void
  private msgCounter = 0

  readonly threadMessages: Array<{ text: string; opts?: Record<string, unknown> }> = []
  readonly completionEvents: CompletionEvent[] = []
  readonly killedSessions: string[] = []
  private lifecycleOverridden = false

  constructor(proto: Protocol, opts: HarnessOpts = {}) {
    this.origStderrWrite = process.stderr.write
    process.stderr.write = (() => true) as any

    this.origGatewaySend = gateway.send.bind(gateway)
    this.origGatewayDelete = gateway.delete.bind(gateway)
    this.origGatewayReact = gateway.react.bind(gateway)
    this.origGatewayFetch = gateway.fetchMessages.bind(gateway)

    const harness = this
    ;(gateway as any).send = async (_channelId: string, text: string, sendOpts?: Record<string, unknown>) => {
      harness.threadMessages.push({ text, opts: sendOpts })
      return { id: `msg-${++harness.msgCounter}` }
    }
    ;(gateway as any).delete = async () => {}
    ;(gateway as any).react = async () => {}
    ;(gateway as any).fetchMessages = async () => []

    jest.useFakeTimers()

    const rounds = opts.rounds ?? 3
    const threadId = `test-thread-${crypto.randomUUID().slice(0, 8)}`
    const ownerRole = proto.ownerRole
    const roles = Object.keys(proto.roles)

    this.sessionIds = new Map()
    const participants = new Map<string, string>()
    const sessionToRole = new Map<string, string>()

    for (const role of roles) {
      const sid = `test-${role}-${crypto.randomUUID().slice(0, 8)}`
      this.sessionIds.set(role, sid)
      participants.set(role, sid)
      sessionToRole.set(sid, role)

      const info: SessionInfo = {
        sessionId: sid,
        topic: `${proto.display} ${proto.roles[role]}`,
        threadId,
        createdAt: Date.now(),
        lastActive: Date.now(),
        tmuxName: role,
        listening: false,
        turnState: 'idle',
      }
      registry.set(sid, info)
    }

    const ownerSessionId = this.sessionIds.get(ownerRole)!

    const run: ProtocolRun = {
      id: `run-${crypto.randomUUID().slice(0, 8)}`,
      protocol: proto,
      threadId,
      ownerSessionId,
      phase: proto.initialPhase,
      currentRound: 1,
      rounds,
      startedAt: Date.now(),
      _extensions: 0,
      _phaseStartedAt: Date.now(),
      params: { rounds, topic: opts.topic, strike: opts.strike, ...opts.params },
      participants,
      sessionToRole,
      timeout: undefined,
      _warningTimeout: undefined,
      _totalTimeout: undefined,
      disconnectTimers: new Map(),
      decisions: [],
      messageIds: [],
      statusHistory: [],
      strike: opts.strike ?? false,
      ext: proto.initState({ rounds, topic: opts.topic, ...opts.params }),
    }

    runs.set(run.id, run)
    threadToRun.set(run.threadId, run.id)
    for (const sid of sessionToRole.keys()) {
      sessionToRun.set(sid, run.id)
    }

    this.run = run

    this.completionListener = (e) => this.completionEvents.push(e)
    protocolEvents.onComplete(this.completionListener)

    this.lastTimeoutArmedAt = Date.now()
    armTimeout(run)
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  get phase(): string { return this.run.phase }
  get round(): number { return this.run.currentRound }
  get decisions(): typeof this.run.decisions { return this.run.decisions }

  get isTerminated(): boolean { return !runs.has(this.run.id) }

  sessionId(role: string): string {
    const sid = this.sessionIds.get(role)
    if (!sid) throw new Error(`unknown role: ${role}`)
    return sid
  }

  // ---------------------------------------------------------------------------
  // Actor simulation
  // ---------------------------------------------------------------------------

  async advance(role: string, content: string, verdict?: string): Promise<{ ok: boolean; reason?: string }> {
    const sid = this.sessionId(role)
    const result = await onRunAdvance(sid, content, verdict)
    await this.flush()
    if (!result.ok) return { ok: false, reason: result.reason }
    return { ok: true }
  }

  async reply(role: string, text: string): Promise<void> {
    const sid = this.sessionId(role)
    const msgIds = [`msg-${++this.msgCounter}`]
    await onRunReply(sid, text, this.run.threadId, msgIds)
    await this.flush()
  }

  disconnect(role: string): void {
    onRunDisconnect(this.sessionId(role))
  }

  reconnect(role: string): void {
    onRunReconnect(this.sessionId(role))
  }

  extend(role: string, reason: string, minutes: number): { ok: boolean; reason?: string } {
    const result = onRunExtend(this.sessionId(role), reason, minutes)
    if (result.ok) this.lastTimeoutArmedAt = Date.now()
    return result
  }

  async cancel(reason: string): Promise<void> {
    await cancelRun(this.run, reason)
    await this.flush()
  }

  // ---------------------------------------------------------------------------
  // Registry control
  // ---------------------------------------------------------------------------

  setTurnState(role: string, state: 'working' | 'idle' | 'waiting'): void {
    const info = registry.get(this.sessionId(role))
    if (info) info.turnState = state
  }

  setSessionDead(role: string, claudeSessionId?: string): void {
    const info = registry.get(this.sessionId(role))
    if (info) {
      info.deadAt = Date.now()
      if (claudeSessionId) (info as any).claudeSessionId = claudeSessionId
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle mocking — overrides doSpawnSession/waitForBridge/killSession
  // ---------------------------------------------------------------------------

  mockResume(opts: { spawnMs?: number; waitMs?: number } = {}): void {
    const harness = this
    const spawnMs = opts.spawnMs ?? 0
    const waitMs = opts.waitMs ?? 0
    harness.lifecycleOverridden = true

    setLifecycle({
      doSpawnSession: async (topic: string, _a: any, _b: any, spawnOpts: any) => {
        if (spawnMs > 0) await new Promise<void>(r => setTimeout(r, spawnMs))
        const sid = `test-resumed-${crypto.randomUUID().slice(0, 8)}`
        const info: SessionInfo = {
          sessionId: sid,
          topic,
          threadId: spawnOpts?.joinThread ?? harness.run.threadId,
          createdAt: Date.now(),
          lastActive: Date.now(),
          tmuxName: `resumed-${sid.slice(14)}`,
          listening: false,
          turnState: 'idle',
        }
        registry.set(sid, info)
        return { sessionId: sid }
      },
      waitForBridge: async (_sid: string, _timeoutMs: number) => {
        if (waitMs > 0) await new Promise<void>(r => setTimeout(r, waitMs))
        return true
      },
      killSession: async (info: any, _reason: string) => {
        harness.killedSessions.push(info.sessionId)
        registry.delete(info.sessionId)
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Time control
  // ---------------------------------------------------------------------------

  async tick(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms)
    await this.flush()
  }

  async tickToWarning(): Promise<void> {
    const windowMs = this.run.protocol.windowMs(this.run.phase)
    if (!windowMs || windowMs <= WARNING_BEFORE_TIMEOUT_MS) return
    const elapsed = Date.now() - this.lastTimeoutArmedAt
    const remaining = (windowMs - WARNING_BEFORE_TIMEOUT_MS) - elapsed
    if (remaining > 0) await this.tick(remaining)
  }

  async tickToTimeout(): Promise<void> {
    const windowMs = this.run.protocol.windowMs(this.run.phase)
    if (!windowMs) return
    const elapsed = Date.now() - this.lastTimeoutArmedAt
    const remaining = windowMs - elapsed
    if (remaining > 0) await this.tick(remaining)
  }

  // ---------------------------------------------------------------------------
  // Observables
  // ---------------------------------------------------------------------------

  actorMessages(role: string): Array<Record<string, unknown>> {
    const sid = this.sessionId(role)
    return transport.messageQueues.get(sid) ?? []
  }

  actorNotifications(role: string): string[] {
    return this.actorMessages(role)
      .filter(m => m.type === 'notification')
      .map(m => m.content as string)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async flush(): Promise<void> {
    const MAX_SETTLE_ITERATIONS = 50
    let prevPhase = this.run.phase
    let prevEvents = this.completionEvents.length
    let prevMessages = this.threadMessages.length
    let stableCount = 0

    for (let i = 0; i < MAX_SETTLE_ITERATIONS; i++) {
      await new Promise<void>(resolve => process.nextTick(resolve))

      const settled =
        this.run.phase === prevPhase &&
        this.completionEvents.length === prevEvents &&
        this.threadMessages.length === prevMessages

      if (settled) {
        if (++stableCount >= 3) return
      } else {
        stableCount = 0
        prevPhase = this.run.phase
        prevEvents = this.completionEvents.length
        prevMessages = this.threadMessages.length
      }
    }

    throw new Error(
      `flush() did not converge after ${MAX_SETTLE_ITERATIONS} iterations ` +
      `(phase=${this.run.phase}, events=${this.completionEvents.length}, msgs=${this.threadMessages.length})`
    )
  }

  dispose(): void {
    clearTimeout(this.run.timeout)
    clearTimeout(this.run._warningTimeout)
    clearTimeout(this.run._totalTimeout)
    for (const t of this.run.disconnectTimers.values()) clearTimeout(t)

    jest.clearAllTimers()
    jest.useRealTimers()

    protocolEvents.offComplete(this.completionListener)

    for (const sid of this.sessionIds.values()) {
      sessionToRun.delete(sid)
      registry.delete(sid)
      transport.messageQueues.delete(sid)
    }
    threadToRun.delete(this.run.threadId)
    runs.delete(this.run.id)

    if (this.lifecycleOverridden) resetLifecycle()

    ;(gateway as any).send = this.origGatewaySend
    ;(gateway as any).delete = this.origGatewayDelete
    ;(gateway as any).react = this.origGatewayReact
    ;(gateway as any).fetchMessages = this.origGatewayFetch
    process.stderr.write = this.origStderrWrite
  }
}

export function createHarness(proto: Protocol, opts?: HarnessOpts): TestHarness {
  return new TestHarness(proto, opts)
}
