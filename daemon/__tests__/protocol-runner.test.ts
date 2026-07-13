import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { onRunReply, onRunDecision, onRunDisconnect, onRunReconnect, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'

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
  roles: { critic: 'The Critic', owner: 'The Owner' },
  phases: {
    critic_turn: { actor: 'critic', half: 'top', on: { posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' } },
    owner_turn:  { actor: 'owner', half: 'bottom', on: { posted: 'critic_turn', final: 'closing', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:     { actor: 'owner', half: 'top', on: { summary: 'complete', timeout: 'complete' } },
    complete:    { actor: 'owner', half: 'top', on: {} },
    cancelled:   { actor: 'owner', half: 'top', on: {} },
  },
  windows: { critic_turn: '10m', owner_turn: '30m', closing: '5m' },
  grace: { critic: '30s', owner: '2m' },
  decisions: {
    verdict: { phase: 'critic_turn', actor: 'critic', options: ['approve', 'reject'] },
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
    params: {},
    participants: new Map([['critic', 'test-critic'], ['owner', 'test-owner']]),
    sessionToRole: new Map([['test-critic', 'critic'], ['test-owner', 'owner']]),
    timeout: undefined,
    disconnectTimers: new Map(),
    decisions: [],
    messageIds: [],
    ...overrides,
  } as any
  runs.set(run.id, run)
  threadToRun.set(run.threadId, run.id)
  sessionToRun.set('test-critic', run.id)
  sessionToRun.set('test-owner', run.id)
  return run
}

describe('protocol runner — reply routing', () => {
  test('critic reply in critic_turn transitions to owner_turn', () => {
    const run = createTestRun()

    onRunReply('test-critic', '[critic→owner]\nYour code is bad.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('owner_turn')
  })

  test('owner reply in owner_turn transitions to critic_turn', () => {
    const run = createTestRun({ phase: 'owner_turn' })

    onRunReply('test-owner', '[owner→critic]\nNo it is not.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
    expect(run.currentRound).toBe(2)
  })

  test('final round triggers final event instead of posted', () => {
    const run = createTestRun({ phase: 'owner_turn', currentRound: 3, rounds: 3 })

    onRunReply('test-owner', '[owner→critic]\nFinal defense.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('closing')
  })

  test('wrong role reply is ignored', () => {
    const run = createTestRun({ phase: 'critic_turn' })

    onRunReply('test-owner', 'I should not be posting now.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
  })

  test('reply to wrong thread is ignored', () => {
    const run = createTestRun()

    onRunReply('test-critic', 'Wrong thread.', 'other-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
  })

  test('message IDs are tracked', () => {
    const run = createTestRun()

    onRunReply('test-critic', '[critic→owner]\nCritique.', 'test-thread', ['msg-1', 'msg-2'])

    expect(run.messageIds).toContain('msg-1')
    expect(run.messageIds).toContain('msg-2')
  })
})

describe('protocol runner — decisions', () => {
  test('valid decision transitions state', () => {
    const run = createTestRun()

    onRunDecision('test-critic', 'approve', 'Ship it.')

    expect(run.decisions).toHaveLength(1)
    expect(run.decisions[0].value).toBe('approve')
    expect(run.decisions[0].because).toBe('Ship it.')
  })

  test('invalid decision value is rejected', () => {
    const run = createTestRun()

    onRunDecision('test-critic', 'maybe', 'Not sure.')

    expect(run.decisions).toHaveLength(0)
    expect(run.phase).toBe('critic_turn')
  })

  test('decision from wrong role is rejected', () => {
    const run = createTestRun()

    onRunDecision('test-owner', 'approve', 'I approve myself.')

    expect(run.decisions).toHaveLength(0)
  })

  test('decision in wrong phase is rejected', () => {
    const run = createTestRun({ phase: 'owner_turn' })

    onRunDecision('test-critic', 'approve', 'Wrong phase.')

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
  test('transition to complete cleans up the run', () => {
    const run = createTestRun({ phase: 'closing' })

    onRunReply('test-owner', '[summary]\nAll done.', 'test-thread', ['msg-1'])

    expect(runs.has('test-run')).toBe(false)
    expect(threadToRun.has('test-thread')).toBe(false)
  })
})

describe('protocol runner — seed rendering', () => {
  test('seed renders with context', () => {
    const seed = testProto.seed('critic', { name: 'drift', sessionId: 'abc', threadId: 'thread-1' })
    expect(seed).toBe('You are drift, the test critic.')
  })

  test('unknown role returns undefined', () => {
    const seed = testProto.seed('judge', { name: 'x', sessionId: 'y', threadId: 'z' })
    expect(seed).toBeUndefined()
  })
})
