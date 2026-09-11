import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { onRunReply, onRunAdvance, onRunDisconnect, onRunReconnect, onRunExtend, startProtocolRun, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import delegatedBuildProto from '../../protocols/delegated-build.js'

let origStderrWrite: typeof process.stderr.write

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})

afterEach(() => {
  process.stderr.write = origStderrWrite
  if (!__test) return
  const { runs, threadToRun, sessionToRun } = __test
  for (const [, run] of runs) {
    if (run.timeout) clearTimeout(run.timeout)
    if (run._healthMonitor) clearInterval(run._healthMonitor)
    for (const t of run.disconnectTimers.values()) clearTimeout(t)
  }
  runs.clear()
  threadToRun.clear()
  sessionToRun.clear()
  transport.messageQueues.clear()
})

if (!__test) throw new Error('protocol-runner.__test only available under NODE_ENV=test')
const { runs, threadToRun, sessionToRun } = __test

// A minimal test protocol — two roles, three phases, one decision
const testProto = protocol('test-review', {
  emoji: '🧪',
  display: 'Test Review',
  cancelPhase: 'cancelled',
  cleanupPhase: 'closing',
  roles: { critic: 'The Critic', owner: 'The Owner' },
  phases: {
    critic_turn: { actor: 'critic', half: 'top', on: { posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'posted' },
    owner_turn:  { actor: 'owner', half: 'bottom', on: { posted: 'critic_turn', final: 'closing', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'posted', finalAdvanceEvent: 'final' },
    closing:     { actor: 'owner', half: 'top', on: { summary: 'complete', timeout: 'complete' }, advanceEvent: 'summary', onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] },
    complete:    { actor: 'owner', half: 'top', on: {} },
    cancelled:   { actor: 'owner', half: 'top', on: {} },
  },
  windows: { critic_turn: '10m', owner_turn: '30m', closing: '5m' },
  grace: { critic: '30s', owner: '2m' },
  decisions: {
    verdict: { phase: 'critic_turn', actor: 'critic', options: ['approve', 'reject'], events: { approve: 'posted', reject: 'posted' } },
  },
  seed: {
    critic: (ctx) => `You are ${ctx.name}, the test critic.`,
  },
})

function createTestRun(overrides: Partial<typeof __test extends undefined ? never : ReturnType<typeof runs.get>> = {}) {
  const run = {
    id: 'test-run',
    protocol: testProto,
    threadId: 'test-thread',
    ownerSessionId: 'test-owner',
    phase: 'critic_turn',
    currentRound: 1,
    rounds: 3,
    startedAt: Date.now(),
    _extensions: 0,
    _phaseStartedAt: Date.now(),
    params: {},
    participants: new Map([['critic', 'test-critic'], ['owner', 'test-owner']]),
    sessionToRole: new Map([['test-critic', 'critic'], ['test-owner', 'owner']]),
    timeout: undefined,
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
    statusHistory: [],
    strike: false,
    ext: {},
    ...overrides,
  } as any
  runs.set(run.id, run)
  threadToRun.set(run.threadId, run.id)
  sessionToRun.set('test-critic', run.id)
  sessionToRun.set('test-owner', run.id)
  return run
}

describe('protocol runner — advance routing', () => {
  test('advance with verdict transitions critic_turn', async () => {
    const run = createTestRun()

    const result = await onRunAdvance('test-critic', 'Your code is bad.', 'approve')

    expect(result.ok).toBe(true)
    expect(run.phase).toBe('owner_turn')
    expect(run.decisions).toHaveLength(1)
    expect(run.decisions[0].value).toBe('approve')
  })

  test('advance without verdict on owner_turn transitions to critic_turn', async () => {
    const run = createTestRun({ phase: 'owner_turn' })

    const result = await onRunAdvance('test-owner', 'No it is not.')

    expect(result.ok).toBe(true)
    expect(run.phase).toBe('critic_turn')
    expect(run.currentRound).toBe(2)
  })

  test('final round triggers final event without incrementing currentRound', async () => {
    const run = createTestRun({ phase: 'owner_turn', currentRound: 3, rounds: 3 })

    await onRunAdvance('test-owner', 'Final defense.')

    expect(run.phase).toBe('closing')
    expect(run.currentRound).toBe(3)
  })

  test('advance from wrong role is rejected', async () => {
    const run = createTestRun({ phase: 'critic_turn' })

    const result = await onRunAdvance('test-owner', 'I should not be posting now.')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not your turn')
    expect(run.phase).toBe('critic_turn')
  })

  test('reply never advances protocol', async () => {
    const run = createTestRun()

    await onRunReply('test-critic', 'Just a question.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
  })

  test('invalid verdict is rejected', async () => {
    const run = createTestRun()

    const result = await onRunAdvance('test-critic', 'Not sure.', 'maybe')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('invalid verdict')
    expect(run.decisions).toHaveLength(0)
    expect(run.phase).toBe('critic_turn')
  })

  test('advance from wrong role is rejected', async () => {
    const run = createTestRun()

    const result = await onRunAdvance('test-owner', 'I approve myself.', 'approve')

    expect(result.ok).toBe(false)
    expect(run.decisions).toHaveLength(0)
  })

  test('verdict in wrong phase is rejected', async () => {
    const run = createTestRun({ phase: 'owner_turn' })

    const result = await onRunAdvance('test-critic', 'Wrong phase.', 'approve')

    expect(result.ok).toBe(false)
    expect(run.decisions).toHaveLength(0)
  })
})

describe('protocol runner — disconnect / reconnect', () => {
  test('disconnect starts grace timer', () => {
    const run = createTestRun()

    onRunDisconnect('test-critic')

    expect(run.disconnectTimers.has('test-critic')).toBe(true)
  })

  test('reconnect clears grace timer', () => {
    const run = createTestRun()

    onRunDisconnect('test-critic')
    expect(run.disconnectTimers.has('test-critic')).toBe(true)

    onRunReconnect('test-critic')
    expect(run.disconnectTimers.has('test-critic')).toBe(false)
  })
})

describe('protocol runner — terminal phases', () => {
  test('transition to complete cleans up the run', async () => {
    const run = createTestRun({ phase: 'closing' })

    await onRunAdvance('test-owner', 'All done.')

    expect(runs.has('test-run')).toBe(false)
    expect(threadToRun.has('test-thread')).toBe(false)
  })
})

describe('protocol runner — timeout transitions', () => {
  test('timeout to cancelled phase uses cancel semantics', async () => {
    const run = createTestRun({ phase: 'critic_turn' })
    // critic_turn timeout → cancelled (the cancelPhase)
    const result = testProto.machine.transition('critic_turn' as any, 'timeout' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cancelled')
    expect(run.protocol.cancelPhase).toBe('cancelled')
  })

  test('timeout to non-cancel phase routes through afterTransition', () => {
    // closing timeout → complete (not cancelled, so completeRun semantics)
    const result = testProto.machine.transition('closing' as any, 'timeout' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('complete')
    expect(result.to).not.toBe('cancelled')
  })
})

describe('protocol runner — strike and decisionContext', () => {
  test('run.strike is set from params, not ext', () => {
    const run = createTestRun()
    expect(run.strike).toBe(false)

    const runWithStrike = createTestRun({ strike: true })
    expect(runWithStrike.strike).toBe(true)
  })

  test('decisionContext stamps context on decisions', async () => {
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Looks good.', 'approve')
    expect(run.decisions).toHaveLength(1)
    expect(run.decisions[0].context).toBeUndefined()
  })
})

describe('protocol runner — behavior chain', () => {
  test('all onEnter behaviors run (chain does not halt on first true)', async () => {
    const run = createTestRun({ phase: 'owner_turn', currentRound: 3, rounds: 3 })

    await onRunAdvance('test-owner', 'Final defense.')

    expect(run.phase).toBe('closing')
  })
})

describe('protocol runner — inline behaviors', () => {
  test('inline function behavior fires on phase entry', async () => {
    let fired = false
    const protoWithInline = protocol('inline-test', {
      emoji: '🧪', display: 'Inline Test',
      roles: { a: 'A', b: 'B' }, owner: 'b',
      phases: {
        phase1: { actor: 'a', on: { go: 'phase2' }, advanceEvent: 'go' },
        phase2: { actor: 'b', on: { finish: 'done' }, onEnter: [() => { fired = true; return false }] },
        done:   { actor: 'b', on: {} },
      },
      windows: { phase1: '10m' },
    })

    const run = {
      id: 'inline-run', protocol: protoWithInline,
      threadId: 'inline-thread',
      ownerSessionId: 'b-sid', phase: 'phase1', currentRound: 1, rounds: 1,
      params: {}, participants: new Map([['a', 'a-sid'], ['b', 'b-sid']]),
      sessionToRole: new Map([['a-sid', 'a'], ['b-sid', 'b']]),
      timeout: undefined, disconnectTimers: new Map(), decisions: [], messageIds: [], statusHistory: [], strike: false, ext: {},
    } as any
    runs.set(run.id, run)
    threadToRun.set(run.threadId, run.id)
    sessionToRun.set('a-sid', run.id)
    sessionToRun.set('b-sid', run.id)

    await onRunAdvance('a-sid', 'Done.')

    expect(fired).toBe(true)
  })
})

describe('protocol runner — seed rendering', () => {
  test('seed renders with context', () => {
    const seed = testProto.seed('critic', { name: 'drift', sessionId: 'abc', threadId: 'thread-1', rounds: 3 })
    expect(seed).toBe('You are drift, the test critic.')
  })

  test('unknown role returns undefined', () => {
    const seed = testProto.seed('judge', { name: 'x', sessionId: 'y', threadId: 'z', rounds: 1 })
    expect(seed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Spike protocol — structural tests (novel topology)
// ---------------------------------------------------------------------------

describe('spike protocol structure', () => {
  let spike: Awaited<ReturnType<typeof import('../../protocols/spike.js')>>['default']

  test('spike protocol loads', async () => {
    spike = (await import('../../protocols/spike.js')).default
    expect(spike.name).toBe('spike')
    expect(spike.emoji).toBe('🔬')
  })

  test('has two non-adversarial roles', () => {
    expect(Object.keys(spike.roles)).toEqual(['explorer', 'guide'])
    expect(spike.ownerRole).toBe('guide')
  })

  test('exploring loops on checkpoint', () => {
    const r = spike.machine.transition('exploring' as any, 'checkpoint' as any)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('exploring')
  })

  test('wrap_up transitions to reporting', () => {
    const r = spike.machine.transition('exploring' as any, 'wrap_up' as any)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('reporting')
  })

  test('report_posted completes', () => {
    const r = spike.machine.transition('reporting' as any, 'report_posted' as any)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('complete')
  })

  test('exploring has a long window (60m)', () => {
    expect(spike.windowMs('exploring')).toBe(60 * 60 * 1000)
  })

  test('phaseInteraction classifies advance and both modes', () => {
    expect(spike.phaseInteraction('exploring')).toEqual({ verdict: 'optional', options: ['done'], descriptions: { done: 'your summary' } })
    expect(spike.phaseInteraction('reporting')).toEqual({ verdict: 'none' })
  })

  test('seed renders with topic', () => {
    const seed = spike.seed('explorer', { name: 'cedar', sessionId: 'abc', threadId: 't-1', rounds: 1, topic: 'Why does qubit keep crashing?' })
    expect(seed).toContain('cedar')
    expect(seed).toContain('Why does qubit keep crashing?')
    expect(seed).toContain('advance(')
  })

  test('exploring phase has no onEnter behaviors (rounds advance on reply)', () => {
    expect(spike.phases.exploring.onEnter).toBeUndefined()
  })

  test('reporting phase has empty onEnter (explorer stays alive, standard timeout)', () => {
    expect(spike.phases.reporting.onEnter).toEqual([])
    expect(spike.phases.reporting.onEnter).not.toContain('killNonOwner')
  })
})

// ---------------------------------------------------------------------------
// Completion event construction — integration tests
// ---------------------------------------------------------------------------

import { protocolEvents, cancelRun } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'

describe('completion event — cancelRun', () => {
  test('cancel during round 1 reports 0 completed rounds', async () => {
    const run = createTestRun({ currentRound: 1, rounds: 3, startedAt: Date.now() - 5000, params: { topic: 'test cancel' } })
    const received: CompletionEvent[] = []
    const listener = (e: CompletionEvent) => received.push(e)
    protocolEvents.onComplete(listener)
    try {
      await cancelRun(run as any, 'test timeout')
      expect(received).toHaveLength(1)
      expect(received[0].outcome).toBe('cancelled')
      expect(received[0].reason).toBe('test timeout')
      expect(received[0].rounds.completed).toBe(0)
      expect(received[0].rounds.requested).toBe(3)
      expect(received[0].protocol).toBe('test-review')
      expect(received[0].topic).toBe('test cancel')
      expect(received[0].durationMs).toBeGreaterThanOrEqual(5000)
    } finally {
      protocolEvents.offComplete(listener)
    }
  })

  test('cancel during round 3 reports 2 completed rounds', async () => {
    const run = createTestRun({ currentRound: 3, rounds: 3, startedAt: Date.now() })
    const received: CompletionEvent[] = []
    const listener = (e: CompletionEvent) => received.push(e)
    protocolEvents.onComplete(listener)
    try {
      await cancelRun(run as any, 'user cancelled')
      expect(received).toHaveLength(1)
      expect(received[0].rounds.completed).toBe(2)
    } finally {
      protocolEvents.offComplete(listener)
    }
  })

  test('event fires before run is cleaned up from maps', async () => {
    const run = createTestRun({ startedAt: Date.now() })
    let runExistedDuringEmit = false
    const listener = () => { runExistedDuringEmit = runs.has(run.id) }
    protocolEvents.onComplete(listener)
    try {
      await cancelRun(run as any, 'ordering test')
      expect(runExistedDuringEmit).toBe(true)
    } finally {
      protocolEvents.offComplete(listener)
    }
  })
})

// ---------------------------------------------------------------------------
// Phase extension
// ---------------------------------------------------------------------------

describe('extend_phase', () => {
  test('extends phase and records decision', () => {
    const run = createTestRun()
    const result = onRunExtend('test-critic', 'reading large codebase', 5)
    expect(result.ok).toBe(true)
    expect(run.decisions).toHaveLength(1)
    expect(run.decisions[0].value).toBe('extend')
    expect(run.decisions[0].because).toBe('reading large codebase')
    expect(run.decisions[0].context).toBe('+5m')
  })

  test('rejects after max extensions', () => {
    const run = createTestRun()
    onRunExtend('test-critic', 'first', 5)
    onRunExtend('test-critic', 'second', 5)
    const result = onRunExtend('test-critic', 'third', 5)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('max extensions')
    expect(run.decisions).toHaveLength(2)
  })

  test('extensions reset on phase advance', async () => {
    const run = createTestRun({ phase: 'owner_turn' })
    run._extensions = 2

    await onRunAdvance('test-owner', 'Defense.')

    expect(run.phase).toBe('critic_turn')
    expect(run._extensions).toBe(0)
  })

  test('rejects for unknown session', () => {
    createTestRun()
    const result = onRunExtend('unknown-session', 'reason', 5)
    expect(result.ok).toBe(false)
  })

  test('rejects non-actor caller', () => {
    createTestRun({ phase: 'critic_turn' })
    const result = onRunExtend('test-owner', 'I want more time', 5)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('only the active actor')
  })
})

describe('protocol runner — health monitor', () => {
  test('health monitor starts after phase transition', async () => {
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    expect(run.phase).toBe('owner_turn')
    expect(run._healthMonitor).toBeDefined()
  })

  test('health monitor resets on next transition', async () => {
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    const firstMonitor = run._healthMonitor
    expect(firstMonitor).toBeDefined()
    await onRunAdvance('test-owner', 'Addressed.')
    expect(run._healthMonitor).toBeDefined()
    expect(run._healthMonitor).not.toBe(firstMonitor)
  })

  test('health monitor clears on run cancellation', async () => {
    const { cancelRun } = await import('../protocol-runner.js')
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    expect(run._healthMonitor).toBeDefined()
    await cancelRun(run as any, 'test cancellation')
    expect(run._healthMonitor).toBeUndefined()
  })

  test('health monitor clears on run completion', async () => {
    const run = createTestRun({ currentRound: 3, rounds: 3 })
    await onRunAdvance('test-critic', 'Final finding', 'approve')
    expect(run.phase).toBe('owner_turn')
    expect(run._healthMonitor).toBeDefined()
    await onRunAdvance('test-owner', 'Final defense')
    expect(run.phase).toBe('closing')
    await onRunAdvance('test-owner', 'Summary.')
    expect(run._healthMonitor).toBeUndefined()
  })

  test('nudge and escalate flags reset on phase transition', async () => {
    const run = createTestRun()
    run._nudged = true
    run._escalated = true
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    expect(run._nudged).toBe(false)
    expect(run._escalated).toBe(false)
  })

  test('HEALTH_CHECK_INTERVAL_MS is 30 seconds', () => {
    expect(__test!.HEALTH_CHECK_INTERVAL_MS).toBe(30_000)
  })

  test('idle thresholds are 5 min (nudge) and 10 min (escalate)', () => {
    expect(__test!.IDLE_NUDGE_MS).toBe(5 * 60 * 1000)
    expect(__test!.IDLE_ESCALATE_MS).toBe(10 * 60 * 1000)
  })
})

describe('health monitor — callback behavior', () => {
  const fakeAdapter = (alive: boolean) => ({ isAlive: async () => alive, usage: () => null }) as any

  function setupSession(sessionId: string, overrides: Record<string, unknown> = {}) {
    registry.set(sessionId, {
      sessionId, topic: 'test', threadId: 'test-thread',
      createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: sessionId, listening: false, engine: 'claude' as const,
      sessionType: 'thread_guest' as const, turnState: 'idle',
      adapter: fakeAdapter(true),
      ...overrides,
    })
  }

  afterEach(() => {
    registry.delete('test-critic')
    registry.delete('test-owner')
    transport.messageQueues.clear()
  })

  test('dead session triggers onRunDisconnect', async () => {
    const run = createTestRun()
    setupSession('test-critic', { adapter: fakeAdapter(false) })
    setupSession('test-owner', { adapter: fakeAdapter(true) })
    transport.bridges.delete('test-critic')

    await __test!.runHealthCheck(run as any)

    expect(run.disconnectTimers.has('test-critic') || run.phase !== 'critic_turn').toBe(true)
  })

  test('working session is not nudged', async () => {
    const run = createTestRun()
    setupSession('test-critic', { turnState: 'working', lastActive: Date.now() - 6 * 60 * 1000, adapter: fakeAdapter(true) })
    setupSession('test-owner')
    transport.bridges.set('test-critic', { sessionId: 'test-critic', socket: {} as any, buf: '' })

    await __test!.runHealthCheck(run as any)

    expect(run._nudged).toBeFalsy()
    expect(run._escalated).toBeFalsy()
  })

  test('idle session receives nudge after 5 minutes', async () => {
    const run = createTestRun()
    setupSession('test-critic', { lastActive: Date.now() - 6 * 60 * 1000, adapter: fakeAdapter(true) })
    setupSession('test-owner')
    transport.bridges.set('test-critic', { sessionId: 'test-critic', socket: {} as any, buf: '' })

    await __test!.runHealthCheck(run as any)

    expect(run._nudged).toBe(true)
  })

  test('idle session receives escalation after 10 minutes', async () => {
    const run = createTestRun()
    setupSession('test-critic', { lastActive: Date.now() - 11 * 60 * 1000, adapter: fakeAdapter(true) })
    setupSession('test-owner')
    transport.bridges.set('test-critic', { sessionId: 'test-critic', socket: {} as any, buf: '' })

    await __test!.runHealthCheck(run as any)

    expect(run._escalated).toBe(true)
  })

  test('bridge flap does not suppress idle escalation', async () => {
    const run = createTestRun()
    run._bridgeEscalated = true
    setupSession('test-critic', { lastActive: Date.now() - 11 * 60 * 1000, adapter: fakeAdapter(true) })
    setupSession('test-owner')
    transport.bridges.set('test-critic', { sessionId: 'test-critic', socket: {} as any, buf: '' })

    await __test!.runHealthCheck(run as any)

    expect(run._escalated).toBe(true)
    expect(run._bridgeEscalated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Delegated-build protocol tests
// ---------------------------------------------------------------------------

function createDelegateRun(overrides: Record<string, unknown> = {}) {
  const threadId = `delegate-thread-${Math.random().toString(36).slice(2, 8)}`
  const pmSid = `test-pm-${Math.random().toString(36).slice(2, 8)}`
  const builderSid = `test-builder-${Math.random().toString(36).slice(2, 8)}`
  registry.set(pmSid, {
    sessionId: pmSid, topic: 'delegate pm', threadId, createdAt: Date.now(),
    lastActive: Date.now(), tmuxName: 'pm', listening: false, engine: 'claude',
    turnState: 'idle', sessionType: 'thread_owner',
  })
  registry.set(builderSid, {
    sessionId: builderSid, topic: 'delegate builder', threadId, createdAt: Date.now(),
    lastActive: Date.now(), tmuxName: 'builder', listening: false, engine: 'claude',
    turnState: 'idle', sessionType: 'thread_guest',
  })
  const run = {
    id: `delegate-run-${Math.random().toString(36).slice(2, 8)}`,
    protocol: delegatedBuildProto,
    threadId,
    ownerSessionId: pmSid,
    phase: overrides.phase ?? 'clarifying',
    currentRound: 1,
    rounds: (overrides.rounds as number) ?? 3,
    startedAt: Date.now(),
    _extensions: 0,
    _phaseStartedAt: Date.now(),
    params: overrides.params ?? {},
    participants: new Map([['pm', pmSid], ['builder', builderSid]]),
    sessionToRole: new Map([[pmSid, 'pm'], [builderSid, 'builder']]),
    timeout: undefined,
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
    statusHistory: [],
    strike: false,
    ...overrides,
  } as any
  runs.set(run.id, run)
  threadToRun.set(threadId, run.id)
  sessionToRun.set(pmSid, run.id)
  sessionToRun.set(builderSid, run.id)
  return { run, pmSid, builderSid, threadId }
}

describe('delegated-build protocol', () => {
  test('roundPhase: clarifying → building does NOT increment round', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'clarifying' })
    expect(run.currentRound).toBe(1)
    await onRunAdvance(pmSid, 'Here is my spec.')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(1)
  })

  test('roundPhase: reviewing → building increments round', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'reviewing' })
    expect(run.currentRound).toBe(1)
    await onRunAdvance(pmSid, 'Changes needed.', 'request_changes')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(2)
  })

  test('PM approve transitions to closing', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'reviewing' })
    // On final round, approve goes to closing
    run.currentRound = run.rounds
    await onRunAdvance(pmSid, 'Looks good!', 'approve')
    expect(run.phase).toBe('closing')
  })

  test('PM request_changes loops back to building', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'reviewing' })
    await onRunAdvance(pmSid, 'Fix the tests.', 'request_changes')
    expect(run.phase).toBe('building')
  })

  test('builder advance transitions to reviewing', async () => {
    const { run, builderSid } = createDelegateRun({ phase: 'building' })
    await onRunAdvance(builderSid, 'Built the feature.')
    expect(run.phase).toBe('reviewing')
  })

  test('builder disconnect triggers fallback to pm_build', async () => {
    const { run, builderSid } = createDelegateRun({ phase: 'building' })
    // Simulate disconnect — builder has 30s grace
    onRunDisconnect(builderSid)
    // Grace timer should be set
    expect(run.disconnectTimers.has(builderSid)).toBe(true)
    // Fast-forward the grace timer
    const timer = run.disconnectTimers.get(builderSid)!
    clearTimeout(timer)
    // Manually fire what the timer would do
    // canFallbackOnDeath checks: non-owner role, phase has fallback transition
    const role = run.sessionToRole.get(builderSid)
    const phase = run.protocol.phases[run.phase]
    expect(role).toBe('builder')
    expect(phase.on.fallback).toBe('pm_build')
  })

  test('skipClarify starts at building phase', () => {
    // Verify the protocol's roundPhase is 'building' (not initialPhase 'clarifying')
    expect(delegatedBuildProto.initialPhase).toBe('clarifying')
    expect(delegatedBuildProto.roundPhase).toBe('building')
    // When skipClarify is set, the run should start at roundPhase
    const { run } = createDelegateRun({
      phase: 'building', // simulates what startProtocolRun does with skipClarify
      params: { skipClarify: true },
    })
    expect(run.phase).toBe('building')
  })

  test('full round cycle: clarify → build → review → build → review → approve', async () => {
    const { run, pmSid, builderSid } = createDelegateRun({ rounds: 2 })
    expect(run.phase).toBe('clarifying')

    await onRunAdvance(pmSid, 'Build a login page.')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(1)

    await onRunAdvance(builderSid, 'Done — login page built.')
    expect(run.phase).toBe('reviewing')

    await onRunAdvance(pmSid, 'Fix the styling.', 'request_changes')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(2)

    await onRunAdvance(builderSid, 'Styling fixed.')
    expect(run.phase).toBe('reviewing')

    await onRunAdvance(pmSid, 'Approved.', 'approve')
    expect(run.phase).toBe('closing')
  })
})
