import { jest } from 'bun:test'
import { onRunReply, onRunDecision, onRunDisconnect, onRunReconnect, onRunExtend, protocolEvents, cancelRun, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import type { Protocol } from '../protocol-dsl.js'
import type { ProtocolRun } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'
import type { SessionInfo } from '../sessions.js'

if (!__test) throw new Error('TestHarness requires NODE_ENV=test')
const { runs, threadToRun, sessionToRun, resetTimeout: armTimeout, WARNING_BEFORE_TIMEOUT_MS } = __test

type HarnessOpts = {
  rounds?: number
  topic?: string
  strike?: boolean
  params?: Record<string, unknown>
}

export class TestHarness {
  readonly run: ProtocolRun
  private readonly sessionIds: Map<string, string>
  private readonly origGatewaySend: typeof gateway.send
  private readonly origGatewayDelete: typeof gateway.delete
  private readonly origGatewayReact: typeof gateway.react
  private readonly origGatewayFetch: typeof gateway.fetchMessages
  private readonly origStderrWrite: typeof process.stderr.write
  private readonly completionListener: (e: CompletionEvent) => void
  private msgCounter = 0

  readonly threadMessages: Array<{ text: string; opts?: Record<string, unknown> }> = []
  readonly completionEvents: CompletionEvent[] = []

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

      registry.set(sid, {
        sessionId: sid,
        topic: `${proto.display} ${proto.roles[role]}`,
        threadId,
        createdAt: Date.now(),
        lastActive: Date.now(),
        tmuxName: role,
        listening: false,
        turnState: 'idle',
      } as SessionInfo)
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

  async reply(role: string, text: string): Promise<void> {
    const sid = this.sessionId(role)
    const msgIds = [`msg-${++this.msgCounter}`]
    await onRunReply(sid, text, this.run.threadId, msgIds)
    await this.flush()
  }

  async decide(role: string, value: string, because: string): Promise<boolean> {
    const sid = this.sessionId(role)
    const result = await onRunDecision(sid, value, because)
    await this.flush()
    return result
  }

  disconnect(role: string): void {
    onRunDisconnect(this.sessionId(role))
  }

  reconnect(role: string): void {
    onRunReconnect(this.sessionId(role))
  }

  extend(role: string, reason: string, minutes: number): { ok: boolean; reason?: string } {
    return onRunExtend(this.sessionId(role), reason, minutes)
  }

  async cancel(reason: string): Promise<void> {
    await cancelRun(this.run, reason)
    await this.flush()
  }

  // ---------------------------------------------------------------------------
  // Registry control
  // ---------------------------------------------------------------------------

  setTurnState(role: string, state: 'working' | 'idle' | 'waiting'): void {
    const sid = this.sessionId(role)
    const info = registry.get(sid)
    if (info) (info as any).turnState = state
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
    const elapsed = Date.now() - this.run._phaseStartedAt
    const remaining = (windowMs - WARNING_BEFORE_TIMEOUT_MS) - elapsed
    if (remaining > 0) await this.tick(remaining)
  }

  async tickToTimeout(): Promise<void> {
    const windowMs = this.run.protocol.windowMs(this.run.phase)
    if (!windowMs) return
    const elapsed = Date.now() - this.run._phaseStartedAt
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

  // Gateway stubs resolve synchronously, so the real async depth through
  // afterTransition → safeSend/notifyNextActor → resetTimeout is bounded
  // at ~4 levels. 20 iterations provides headroom without a formal analysis.
  private async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(resolve => process.nextTick(resolve))
    }
  }

  dispose(): void {
    if (runs.has(this.run.id)) {
      if (this.run.timeout) clearTimeout(this.run.timeout)
      if (this.run._warningTimeout) clearTimeout(this.run._warningTimeout)
      if (this.run._totalTimeout) clearTimeout(this.run._totalTimeout)
      for (const t of this.run.disconnectTimers.values()) clearTimeout(t)
    }

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
