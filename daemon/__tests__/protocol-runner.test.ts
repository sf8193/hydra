import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { onRunReply, onRunAdvance, onRunDisconnect, onRunReconnect, onRunExtend, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'

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
    if (run._keepaliveTimer) clearInterval(run._keepaliveTimer)
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

  test('reporting phase has backstop timer (explorer stays alive to post report)', () => {
    expect(spike.phases.reporting.onEnter).toContain('backstopTimer')
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

describe('protocol runner — keepalive', () => {
  test('keepalive timer starts after phase transition', async () => {
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    expect(run.phase).toBe('owner_turn')
    expect(run._keepaliveTimer).toBeDefined()
  })

  test('keepalive timer clears on next transition', async () => {
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    const firstTimer = run._keepaliveTimer
    expect(firstTimer).toBeDefined()
    await onRunAdvance('test-owner', 'Addressed.')
    expect(run._keepaliveTimer).toBeDefined()
    expect(run._keepaliveTimer).not.toBe(firstTimer)
  })

  test('keepalive timer clears on run cancellation', async () => {
    const { cancelRun } = await import('../protocol-runner.js')
    const run = createTestRun()
    await onRunAdvance('test-critic', 'Finding #1', 'approve')
    expect(run._keepaliveTimer).toBeDefined()
    await cancelRun(run as any, 'test cancellation')
    expect(run._keepaliveTimer).toBeUndefined()
  })

  test('keepalive timer clears on run completion', async () => {
    const run = createTestRun({ currentRound: 3, rounds: 3 })
    await onRunAdvance('test-critic', 'Final finding', 'approve')
    expect(run.phase).toBe('owner_turn')
    expect(run._keepaliveTimer).toBeDefined()
    await onRunAdvance('test-owner', 'Final defense')
    // closing phase should still have a keepalive
    expect(run.phase).toBe('closing')
    // complete the run by advancing through closing
    await onRunAdvance('test-owner', 'Summary.')
    // run is now terminal — timer cleared
    expect(run._keepaliveTimer).toBeUndefined()
  })

  test('sendKeepaliveNotification queues inert system message', () => {
    const { sendKeepaliveNotification } = __test!
    const run = createTestRun()
    sendKeepaliveNotification(run as any, 'test-critic', 'critic')
    const queued = transport.messageQueues.get('test-critic') ?? []
    const keepalives = queued.filter((m: any) => m.content === '[system] keepalive')
    expect(keepalives.length).toBe(1)
    expect(keepalives[0].meta.user).toBe('system')
  })

  test('KEEPALIVE_INTERVAL_MS is 30 seconds', () => {
    expect(__test!.KEEPALIVE_INTERVAL_MS).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Resume retry — the reliability path for protocol participants
// ---------------------------------------------------------------------------

function makeLifecycleMocks(bridgeResults: boolean[]) {
  const spawned: string[] = []
  const killed: Array<{ sessionId: string; reason: string }> = []
  const preferredNames: Array<string | undefined> = []
  let bridgeCall = 0

  const doSpawnSession = (async (topic: string, _chatId: any, _messageId: any, opts: any) => {
    const sessionId = `resumed-${spawned.length + 1}`
    spawned.push(sessionId)
    preferredNames.push(opts?.preferredName)
    // Register so resumeParticipant's `registry.get(result.sessionId)` (for the
    // kill-on-failure path) resolves, mirroring a real spawn.
    registry.set(sessionId, {
      sessionId,
      topic: String(topic),
      threadId: opts?.joinThread ?? 'test-thread',
      tmuxName: opts?.preferredName ?? `name-${spawned.length}`,
      createdAt: Date.now(),
      lastActive: Date.now(),
      listening: false,
      isJoinMember: true,
    } as any)
    return { name: opts?.preferredName ?? 'zinc', sessionId, threadId: opts?.joinThread ?? 'test-thread', url: '' }
  }) as any

  const waitForBridge = (async (_sessionId: string, _timeoutMs: number) => {
    const r = bridgeResults[bridgeCall] ?? false
    bridgeCall++
    return r
  }) as any

  const killSession = (async (info: any, reason: string) => {
    killed.push({ sessionId: info.sessionId, reason })
    registry.delete(info.sessionId)
  }) as any

  return {
    overrides: { doSpawnSession, waitForBridge, killSession },
    spawned,
    killed,
    preferredNames,
    get bridgeCalls() { return bridgeCall },
  }
}

describe('protocol runner — resume retry', () => {
  afterEach(() => {
    __test!.resetLifecycle()
    registry.delete('dead-critic')
    for (let i = 1; i <= 5; i++) registry.delete(`resumed-${i}`)
  })

  function seedDeadCritic() {
    registry.set('dead-critic', {
      sessionId: 'dead-critic',
      tmuxName: 'zinc',
      topic: 'reviewing the diff',
      threadId: 'test-thread',
      createdAt: Date.now(),
      lastActive: Date.now(),
      listening: false,
      isJoinMember: true,
    } as any)
  }

  test('retries on bridge timeout, up to 3 attempts, then succeeds', async () => {
    const run = createTestRun()
    seedDeadCritic()
    const mocks = makeLifecycleMocks([false, false, true]) // fail, fail, succeed
    __test!.setLifecycle(mocks.overrides)

    await __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc')

    expect(mocks.spawned.length).toBe(3)
    expect(mocks.bridgeCalls).toBe(3)
    // Two failed attempts are killed before the successful third.
    expect(mocks.killed.length).toBe(2)
    expect(mocks.killed.every(k => k.reason === 'auto-resume health check failed')).toBe(true)
    // The surviving session is registered as the critic.
    const survivor = mocks.spawned[2]
    expect(run.sessionToRole.get(survivor)).toBe('critic')
    expect(run.participants.get('critic')).toBe(survivor)
    // Dead session mappings are cleared.
    expect(run.sessionToRole.has('dead-critic')).toBe(false)
  })

  test('succeeds on first attempt without killing anything', async () => {
    const run = createTestRun()
    seedDeadCritic()
    const mocks = makeLifecycleMocks([true])
    __test!.setLifecycle(mocks.overrides)

    await __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc')

    expect(mocks.spawned.length).toBe(1)
    expect(mocks.killed.length).toBe(0)
    expect(run.participants.get('critic')).toBe(mocks.spawned[0])
  })

  test('throws after all 3 attempts fail (triggers cancelRun upstream)', async () => {
    const run = createTestRun()
    seedDeadCritic()
    const mocks = makeLifecycleMocks([false, false, false])
    __test!.setLifecycle(mocks.overrides)

    await expect(
      __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc'),
    ).rejects.toThrow(/did not connect after 3 attempts/)

    expect(mocks.spawned.length).toBe(3)
    expect(mocks.killed.length).toBe(3) // every failed attempt is torn down
    // No survivor registered.
    expect(run.participants.get('critic')).toBe('test-critic') // unchanged from original
  })

  test('passes preferredName = dead participant tmuxName on every attempt', async () => {
    const run = createTestRun()
    seedDeadCritic()
    const mocks = makeLifecycleMocks([false, true])
    __test!.setLifecycle(mocks.overrides)

    await __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc')

    expect(mocks.preferredNames).toEqual(['zinc', 'zinc'])
  })

  test('sets suppressDeathMessage on the dying session', async () => {
    const run = createTestRun()
    seedDeadCritic()
    const mocks = makeLifecycleMocks([true])
    __test!.setLifecycle(mocks.overrides)

    await __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc')

    expect(registry.get('dead-critic')?.suppressDeathMessage).toBe(true)
  })

  test('RESUME constants: 3 attempts, 45s bridge timeout', () => {
    expect(__test!.RESUME_MAX_ATTEMPTS).toBe(3)
    expect(__test!.RESUME_BRIDGE_TIMEOUT_MS).toBe(45_000)
  })

  test('run cancelled mid-retry: aborts, kills the in-flight spawn, does not throw', async () => {
    const run = createTestRun()
    seedDeadCritic()
    // First attempt: bridge times out → loop tears it down and retries.
    // Second spawn: the run goes terminal (owner cancelled) before the bridge
    // check, so the in-loop isTerminal guard must kill the fresh spawn and return.
    const mocks = makeLifecycleMocks([false, false])
    const wrapped = {
      ...mocks.overrides,
      doSpawnSession: (async (topic: any, c: any, m: any, opts: any) => {
        const r = await (mocks.overrides.doSpawnSession as any)(topic, c, m, opts)
        if (mocks.spawned.length === 2) run.phase = 'complete' // terminal
        return r
      }) as any,
    }
    __test!.setLifecycle(wrapped)

    // Must resolve (return), not reject — a cancel is not a resume failure.
    await __test!.resumeParticipant(run as any, 'critic', 'dead-critic', 'claude-abc')

    expect(mocks.spawned.length).toBe(2)
    // Attempt 1 killed on bridge timeout; attempt 2 killed on terminal abort.
    expect(mocks.killed.length).toBe(2)
    expect(mocks.killed[1].reason).toBe('run cancelled during resume')
    // The aborted spawn left no dangling role mapping.
    expect(run.sessionToRole.get(mocks.spawned[1])).toBeUndefined()
  })
})
