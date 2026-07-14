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
    critic_turn: { actor: 'critic', half: 'top', on: { posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'posted' },
    owner_turn:  { actor: 'owner', half: 'bottom', on: { posted: 'critic_turn', final: 'closing', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'posted', finalRoundEvent: 'final' },
    closing:     { actor: 'owner', half: 'top', on: { summary: 'complete', timeout: 'complete' }, replyEvent: 'summary', onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] },
    complete:    { actor: 'owner', half: 'top', on: {} },
    cancelled:   { actor: 'owner', half: 'top', on: {} },
  },
  sentinels: {
    critic_turn: '[critic→owner]',
    owner_turn: '[owner→critic]',
    closing: '[summary]',
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
    ext: {},
    ...overrides,
  } as any
  runs.set(run.id, run)
  threadToRun.set(run.threadId, run.id)
  sessionToRun.set('test-critic', run.id)
  sessionToRun.set('test-owner', run.id)
  return run
}

describe('protocol runner — reply routing', () => {
  test('critic reply in critic_turn with decision declared does not advance via reply', () => {
    const run = createTestRun()

    onRunReply('test-critic', '[critic→owner]\nYour code is bad.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
  })

  test('owner reply in owner_turn transitions to critic_turn', () => {
    const run = createTestRun({ phase: 'owner_turn' })

    onRunReply('test-owner', '[owner→critic]\nNo it is not.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
    expect(run.currentRound).toBe(2)
  })

  test('final round triggers final event without incrementing currentRound', () => {
    const run = createTestRun({ phase: 'owner_turn', currentRound: 3, rounds: 3 })

    onRunReply('test-owner', '[owner→critic]\nFinal defense.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('closing')
    expect(run.currentRound).toBe(3)
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

  test('message IDs are tracked on reply-advanced phases', () => {
    const run = createTestRun({ phase: 'owner_turn' })

    onRunReply('test-owner', '[owner→critic]\nDefense.', 'test-thread', ['msg-1', 'msg-2'])

    expect(run.messageIds).toContain('msg-1')
    expect(run.messageIds).toContain('msg-2')
  })

  test('message without sentinel is ignored', () => {
    const run = createTestRun()

    onRunReply('test-critic', 'Hey, quick question about the codebase.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
    expect(run.messageIds).not.toContain('msg-1')
  })

  test('message with wrong sentinel is ignored', () => {
    const run = createTestRun()

    onRunReply('test-critic', '[owner→critic]\nWrong tag.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
  })

  test('phase with declared decision requires decide(), reply alone does not advance', () => {
    const run = createTestRun()

    onRunReply('test-critic', '[critic→owner]\nHere is my critique.', 'test-thread', ['msg-1'])

    expect(run.phase).toBe('critic_turn')
    expect(run.messageIds).not.toContain('msg-1')
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

describe('protocol runner — inline behaviors', () => {
  test('inline function behavior fires on phase entry', () => {
    let fired = false
    const protoWithInline = protocol('inline-test', {
      emoji: '🧪', display: 'Inline Test',
      roles: { a: 'A', b: 'B' }, owner: 'b',
      phases: {
        phase1: { actor: 'a', on: { go: 'phase2' }, replyEvent: 'go' },
        phase2: { actor: 'b', on: { finish: 'done' }, onEnter: [() => { fired = true; return false }] },
        done:   { actor: 'b', on: {} },
      },
      sentinels: { phase1: '[go]' },
      windows: { phase1: '10m' },
    })

    const run = {
      id: 'inline-run', protocol: protoWithInline, threadId: 'inline-thread',
      ownerSessionId: 'b-sid', phase: 'phase1', currentRound: 1, rounds: 1,
      params: {}, participants: new Map([['a', 'a-sid'], ['b', 'b-sid']]),
      sessionToRole: new Map([['a-sid', 'a'], ['b-sid', 'b']]),
      timeout: undefined, disconnectTimers: new Map(), decisions: [], messageIds: [], ext: {},
    } as any
    runs.set(run.id, run)
    threadToRun.set(run.threadId, run.id)
    sessionToRun.set('a-sid', run.id)
    sessionToRun.set('b-sid', run.id)

    onRunReply('a-sid', '[go]\nDone.', 'inline-thread', ['msg-1'])

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

  test('sentinel matches checkpoint/report pattern', () => {
    expect(spike.sentinel('exploring')).toBe('[checkpoint]')
    expect(spike.sentinel('reporting')).toBe('[report]')
  })

  test('seed renders with topic', () => {
    const seed = spike.seed('explorer', { name: 'cedar', sessionId: 'abc', threadId: 't-1', rounds: 1, topic: 'Why does qubit keep crashing?' })
    expect(seed).toContain('cedar')
    expect(seed).toContain('Why does qubit keep crashing?')
    expect(seed).toContain('[checkpoint]')
    expect(seed).toContain('[report]')
  })

  test('exploring phase has no onEnter behaviors (rounds advance on reply)', () => {
    expect(spike.phases.exploring.onEnter).toBeUndefined()
  })

  test('reporting phase has backstop timer (no kill — explorer is the actor)', () => {
    expect(spike.phases.reporting.onEnter).toContain('backstopTimer')
    expect(spike.phases.reporting.onEnter).not.toContain('killNonOwner')
  })
})
