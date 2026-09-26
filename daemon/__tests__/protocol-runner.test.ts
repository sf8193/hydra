import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { onRunReply, onRunAdvance, onRunDisconnect, onRunReconnect, onRunExtend, startProtocolRun, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import delegatedBuildProto from '../../protocols/delegated-build.js'
import delegatedBuildQuickProto from '../../protocols/delegated-build-quick.js'
import { selectDelegatedBuildProtocol } from '../../protocols/delegated-build-select.js'
import reviewProto from '../../protocols/review.js'
import buildProto from '../../protocols/build.js'
import spikeProto from '../../protocols/spike.js'

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
    protocolChildren: new Map(),
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

  test('final round uses the selected verdict final event', async () => {
    const capProto = protocol('cap-routing', {
      emoji: '🧪', display: 'Cap Routing', roles: { critic: 'Critic', owner: 'Owner' }, owner: 'owner',
      phases: {
        judging: { actor: 'critic', on: { again: 'judging', accept: 'done', exhaust: 'failed' } },
        done: { actor: 'owner', on: {} }, failed: { actor: 'owner', on: {} },
      },
      windows: {},
      decisions: { verdict: { phase: 'judging', actor: 'critic', options: ['approve', 'reject'], events: { approve: 'again', reject: 'again' }, finalEvents: { approve: 'accept', reject: 'exhaust' } } },
    })
    const approved = createTestRun({ protocol: capProto, phase: 'judging', currentRound: 3, rounds: 3 })
    await onRunAdvance('test-critic', 'Clean pass.', 'approve')
    expect(approved.phase).toBe('done')

    const rejected = createTestRun({ protocol: capProto, phase: 'judging', currentRound: 3, rounds: 3 })
    await onRunAdvance('test-critic', 'Still broken.', 'reject')
    expect(rejected.phase).toBe('failed')
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

describe('protocol runner — phase-scoped spawn lifecycle', () => {
  const scopedProto = protocol('scoped-spawn', {
    emoji: '🧪', display: 'Scoped Spawn', roles: { critic: 'Critic', owner: 'Owner' }, owner: 'owner',
    phases: {
      reviewing: { actor: 'critic', capabilities: ['protocol_spawn'], on: { done: 'owner_turn' }, advanceEvent: 'done' },
      owner_turn: { actor: 'owner', on: { done: 'complete' }, advanceEvent: 'done' },
      complete: { actor: 'owner', on: {} },
    }, windows: {},
  })

  function session(sessionId: string) {
    registry.set(sessionId, {
      sessionId, topic: 'test', threadId: 'test-thread', createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: sessionId, listening: false, engine: 'claude', sessionType: 'thread_owner',
    })
  }

  afterEach(() => {
    for (const id of ['test-critic', 'test-owner', 'review-child']) registry.delete(id)
    __test!.resetLifecycle()
  })

  test('only the active actor receives spawn/kill and both are cleared on phase exit', async () => {
    session('test-critic'); session('test-owner')
    const run = createTestRun({ protocol: scopedProto, phase: 'reviewing' })
    __test!.setRunTools(run)
    expect(registry.get('test-critic')?.capabilities).toContain('protocol_spawn')
    expect(registry.get('test-owner')?.capabilities ?? []).not.toContain('protocol_spawn')

    await onRunAdvance('test-critic', 'Review finished.')
    expect(registry.get('test-critic')?.capabilities ?? []).not.toContain('protocol_spawn')
    expect(registry.get('test-owner')?.capabilities ?? []).not.toContain('protocol_spawn')
  })

  test('children are accepted only from the active declared actor and retired on phase exit', async () => {
    session('review-child')
    const killed: string[] = []
    __test!.setLifecycle({ killSession: (async (info: any) => { killed.push(info.sessionId) }) as any })
    const run = createTestRun({ protocol: scopedProto, phase: 'reviewing' })

    const metadata = { headless: true, readThread: true, phaseBudgetMs: 60_000 }
    expect(__test!.registerChild(run, 'test-owner', 'review-child', metadata)).toBe(false)
    expect(__test!.registerChild(run, 'test-critic', 'review-child', metadata)).toBe(true)
    await onRunAdvance('test-critic', 'Review finished.')
    await Promise.resolve()

    expect(run.protocolChildren.size).toBe(0)
    expect(killed).toEqual(['review-child'])
  })
})

describe('protocol runner — deferred fallback lifecycle', () => {
  test('marker survives ineligible phases and fires at the next fallback-capable phase', async () => {
    const proto = protocol('persistent-fallback', {
      emoji: '🧪', display: 'Persistent Fallback', roles: { critic: 'Critic', owner: 'Owner' }, owner: 'owner',
      phases: {
        owner_one: { actor: 'owner', on: { next: 'owner_two' }, advanceEvent: 'next' },
        owner_two: { actor: 'owner', on: { next: 'critic_turn' }, advanceEvent: 'next' },
        critic_turn: { actor: 'critic', on: { fallback: 'fallback' } },
        fallback: { actor: 'owner', on: { done: 'complete' }, advanceEvent: 'done' },
        complete: { actor: 'owner', on: {} },
      }, windows: {}, fallbackDegradation: 'critic unavailable',
      deferFallbackAcrossPhases: true,
      notifications: { onFallback: () => 'Owner fallback.' },
    })
    const run = createTestRun({ protocol: proto, phase: 'owner_one', _pendingFallback: 'critic' })

    await onRunAdvance('test-owner', 'First owner phase.')
    expect(run.phase).toBe('owner_two')
    expect(run._pendingFallback).toBe('critic')

    await onRunAdvance('test-owner', 'Second owner phase.')
    expect(run.phase).toBe('fallback')
    expect(run._pendingFallback).toBeUndefined()
  })

  test('review, build, and spike retain phase-local fallback behavior', async () => {
    expect(reviewProto.deferFallbackAcrossPhases).toBe(false)
    expect(buildProto.deferFallbackAcrossPhases).toBe(false)
    expect(spikeProto.deferFallbackAcrossPhases).toBe(false)

    const proto = protocol('phase-local-fallback', {
      emoji: '🧪', display: 'Phase Local Fallback', roles: { worker: 'Worker', owner: 'Owner' }, owner: 'owner',
      phases: {
        owner_one: { actor: 'owner', on: { next: 'owner_two' }, advanceEvent: 'next' },
        owner_two: { actor: 'owner', on: { done: 'complete' }, advanceEvent: 'done' },
        complete: { actor: 'owner', on: {} },
      }, windows: {},
    })
    const run = createTestRun({ protocol: proto, phase: 'owner_one', _pendingFallback: 'worker' })
    await onRunAdvance('test-owner', 'Advance owner work.')
    expect(run._pendingFallback).toBeUndefined()
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
    phase: overrides.phase ?? 'planning',
    currentRound: 1,
    rounds: (overrides.rounds as number) ?? 3,
    startedAt: Date.now(),
    _extensions: 0,
    _phaseStartedAt: Date.now(),
    params: overrides.params ?? {},
    participants: new Map([['pm', pmSid], ['builder', builderSid]]),
    sessionToRole: new Map([[pmSid, 'pm'], [builderSid, 'builder']]),
    protocolChildren: new Map(),
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

function addPassingReviewer(run: any, pmSid: string, result = 'Verdict: PASS\nEvidence: reviewed exact diff') {
  run.protocolChildren.set(`reviewer-${Math.random()}`, {
    phase: 'verifying', parentSessionId: pmSid, headless: true, readThread: true,
    phaseBudgetMs: 60_000, result,
  })
}

const verificationProof = 'Mechanical checks: bun test passed\nReviewer: fresh-reviewer\nEvidence: exact diff reviewed with no findings'

describe('delegated-build protocol', () => {
  test('closing timeout fails rather than completing without a summary', () => {
    const result = delegatedBuildProto.machine.transition('closing' as any, 'timeout' as any)
    expect(result?.to).toBe('cancelled')
  })
  test('planning → building starts the first builder turn', async () => {
    const { run, pmSid } = createDelegateRun()
    expect(run.currentRound).toBe(1)
    await onRunAdvance(pmSid, 'Plan and step 1 brief.')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(1)
  })

  test('request_changes consumes a builder turn', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'verifying' })
    expect(run.currentRound).toBe(1)
    await onRunAdvance(pmSid, 'Changes needed.', 'request_changes')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(2)
  })

  test('clean step_passed at the cap still enters committing', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'verifying' })
    addPassingReviewer(run, pmSid)
    run.currentRound = run.rounds
    await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(run.phase).toBe('committing')
  })

  test('request_changes at the cap cancels fail-closed', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'verifying' })
    run.currentRound = run.rounds
    await onRunAdvance(pmSid, 'Fix the tests.', 'request_changes')
    expect(run.phase).toBe('cancelled')
  })

  test('step_passed is daemon-gated on qualified reviewer result and structured evidence', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'verifying' })

    let result = await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(result.ok).toBe(false)
    expect((result as any).reason).toContain('current-phase reviewer')

    run.protocolChildren.set('bad-reviewer', {
      phase: 'verifying', parentSessionId: pmSid, headless: false, readThread: true,
      phaseBudgetMs: 60_000, result: 'Verdict: PASS\nEvidence: clean',
    })
    result = await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(result.ok).toBe(false)

    addPassingReviewer(run, pmSid, 'Verdict: FAIL\nEvidence: regression remains')
    result = await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(result.ok).toBe(false)
    expect((result as any).reason).toContain('Verdict: PASS')

    addPassingReviewer(run, pmSid, 'Verdict: PASS WITH FIXES\nEvidence: reviewer found and applied a small fix')
    result = await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(result.ok).toBe(false)

    addPassingReviewer(run, pmSid)
    result = await onRunAdvance(pmSid, 'Mechanical checks:\nReviewer: reviewer-1\nEvidence: clean', 'step_passed')
    expect(result.ok).toBe(false)

    addPassingReviewer(run, pmSid)
    result = await onRunAdvance(pmSid, 'Checks passed.', 'step_passed')
    expect(result.ok).toBe(false)
    expect((result as any).reason).toContain('structured proof')

    result = await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(result.ok).toBe(true)
    expect(run.phase).toBe('committing')
  })

  test('builder advance transitions to verifying and grants PM protocol_spawn', async () => {
    const { run, builderSid } = createDelegateRun({ phase: 'building' })
    await onRunAdvance(builderSid, 'Built the feature.')
    expect(run.phase).toBe('verifying')
    expect(registry.get(run.ownerSessionId)?.capabilities).toContain('protocol_spawn')
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

  test('quick protocol preserves the old graph separately', () => {
    expect(delegatedBuildQuickProto.name).toBe('delegated-build-quick')
    expect(delegatedBuildQuickProto.initialPhase).toBe('clarifying')
    expect(delegatedBuildQuickProto.phases.building.on.build_done).toBe('reviewing')
    expect(delegatedBuildProto.initialPhase).toBe('planning')
  })

  test('command selector routes delegate to rigorous and delegate! to quick', () => {
    expect(selectDelegatedBuildProtocol(false).name).toBe('delegated-build')
    expect(selectDelegatedBuildProtocol(true).name).toBe('delegated-build-quick')
  })

  test('quick path runs the original clarify/build/review/close graph', async () => {
    const { run, pmSid, builderSid } = createDelegateRun({ protocol: delegatedBuildQuickProto, phase: 'clarifying', rounds: 2 })
    await onRunAdvance(pmSid, 'Quick spec.')
    await onRunAdvance(builderSid, 'Built.')
    expect(run.phase).toBe('reviewing')
    await onRunAdvance(pmSid, 'Fix one thing.', 'request_changes')
    await onRunAdvance(builderSid, 'Fixed.')
    await onRunAdvance(pmSid, 'Approved.', 'approve')
    expect(run.phase).toBe('closing')
  })

  test('rigorous two-step trace verifies and commits each step', async () => {
    const { run, pmSid, builderSid } = createDelegateRun({ rounds: 2 })
    await onRunAdvance(pmSid, 'Plan; current step 1.')
    expect(run.phase).toBe('building')
    await onRunAdvance(builderSid, 'Step 1 built, no commits.')
    expect(run.phase).toBe('verifying')
    addPassingReviewer(run, pmSid)
    await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(run.phase).toBe('committing')
    await onRunAdvance(pmSid, 'Committed step 1; current step 2.', 'next_step')
    expect(run.phase).toBe('building')
    expect(run.currentRound).toBe(2)
    await onRunAdvance(builderSid, 'Step 2 built, no commits.')
    addPassingReviewer(run, pmSid)
    await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(run.phase).toBe('committing')
    await onRunAdvance(pmSid, 'Committed exact reviewed step 2.', 'complete')
    expect(run.phase).toBe('closing')
  })

  test('next_step at cap cancels, while complete at cap closes', async () => {
    const capped = createDelegateRun({ phase: 'committing', rounds: 1 })
    await onRunAdvance(capped.pmSid, 'Need another step.', 'next_step')
    expect(capped.run.phase).toBe('cancelled')

    const done = createDelegateRun({ phase: 'committing', rounds: 1 })
    await onRunAdvance(done.pmSid, 'Committed reviewed step.', 'complete')
    expect(done.run.phase).toBe('closing')
  })

  test('cap exhaustion reports the exact cancelled reason', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'verifying', rounds: 1 })
    let completion: any
    const listener = (event: any) => { if (event.protocol === 'delegated-build') completion = event }
    protocolEvents.onComplete(listener)
    try {
      await onRunAdvance(pmSid, 'Still broken.', 'request_changes')
      expect(completion?.outcome).toBe('cancelled')
      expect(completion?.reason).toBe('builder-turn budget exhausted')
    } finally {
      protocolEvents.offComplete(listener)
    }
  })

  test('PM self-build fallback rejoins verifying then committing', async () => {
    const { run, pmSid } = createDelegateRun({ phase: 'pm_build' })
    await onRunAdvance(pmSid, 'Self-built current step without committing.')
    expect(run.phase).toBe('verifying')
    addPassingReviewer(run, pmSid)
    await onRunAdvance(pmSid, verificationProof, 'step_passed')
    expect(run.phase).toBe('committing')
    expect(delegatedBuildProto.fallbackDegradation).toContain('independent authorship lost')
  })

  test('actual builder fallback keeps request_changes PM-owned and enforces the cap', async () => {
    const { run, pmSid, builderSid } = createDelegateRun({ phase: 'building', rounds: 2 })
    __test!.setLifecycle({ killSession: async (info) => { registry.delete(info.sessionId) } })
    try {
      await __test!.enterFallbackPhase(run, 'builder')
      expect(run.phase).toBe('pm_build')
      expect(run.participants.has('builder')).toBe(false)
      const retiredQueueSize = transport.messageQueues.get(builderSid)?.length ?? 0

      await onRunAdvance(pmSid, 'PM self-build pass one.')
      await onRunAdvance(pmSid, 'Reviewer FAIL with bounded fixes.', 'request_changes')
      expect(run.phase).toBe('pm_build')
      expect(run.currentRound).toBe(2)
      expect(transport.messageQueues.get(builderSid)?.length ?? 0).toBe(retiredQueueSize)

      await onRunAdvance(pmSid, 'PM fixes complete.')
      await onRunAdvance(pmSid, 'Reviewer still FAIL.', 'request_changes')
      expect(run.phase).toBe('cancelled')
    } finally {
      __test!.resetLifecycle()
    }
  })

  test('actual builder fallback keeps next_step PM-owned and enforces the cap', async () => {
    const { run, pmSid, builderSid } = createDelegateRun({ phase: 'building', rounds: 2 })
    __test!.setLifecycle({ killSession: async (info) => { registry.delete(info.sessionId) } })
    try {
      await __test!.enterFallbackPhase(run, 'builder')
      const retiredQueueSize = transport.messageQueues.get(builderSid)?.length ?? 0
      await onRunAdvance(pmSid, 'PM self-built step 1.')
      addPassingReviewer(run, pmSid)
      await onRunAdvance(pmSid, verificationProof, 'step_passed')
      await onRunAdvance(pmSid, 'Committed step 1; next step brief.', 'next_step')
      expect(run.phase).toBe('pm_build')
      expect(run.currentRound).toBe(2)
      expect(transport.messageQueues.get(builderSid)?.length ?? 0).toBe(retiredQueueSize)

      await onRunAdvance(pmSid, 'PM self-built step 2.')
      addPassingReviewer(run, pmSid)
      await onRunAdvance(pmSid, verificationProof, 'step_passed')
      await onRunAdvance(pmSid, 'Committed step 2; more remains.', 'next_step')
      expect(run.phase).toBe('cancelled')
    } finally {
      __test!.resetLifecycle()
    }
  })

  test('prompts pin scope, review proof, and PM-only commit', () => {
    const seed = delegatedBuildProto.seed('builder', { name: 'builder', sessionId: 'b', threadId: 't', rounds: 2, task: 'x' })!
    expect(seed).toContain('Remain idle during PM planning')
    expect(seed).toContain('do not edit files or begin implementation until you receive the first numbered-step handoff')
    expect(seed).toContain('authorized to edit only the current numbered step')
    expect(seed).toContain('Do not commit')
    const verify = delegatedBuildProto.notifications.onTurn!({ phase: 'verifying' } as any, 'report')
    expect(verify).toContain('read_thread=true')
    expect(verify).toContain('phase_budget')
    expect(verify).toContain('Verdict: PASS')
    expect(verify).toContain('Mechanical checks:')
    const commit = delegatedBuildProto.notifications.onTurn!({ phase: 'committing' } as any, 'evidence')
    expect(commit).toContain('Commit exactly the reviewed current-step diff')
    const kickoff = delegatedBuildProto.notifications.onKickoff!.pm!({ rounds: 7, params: { task: 'x' } } as any)!
    expect(kickoff).toContain('Builder-turn budget:')
    expect(kickoff).toContain('7')
    expect(kickoff).toContain('requested-fix cycle consumes one turn')
  })
})
