import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'

let origStderrWrite: typeof process.stderr.write
beforeEach(() => { origStderrWrite = process.stderr.write; process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = origStderrWrite })

// ---------------------------------------------------------------------------
// Load the protocol definitions
// ---------------------------------------------------------------------------

const review = (await import('../../protocols/review.js')).default
const build = (await import('../../protocols/build.js')).default

// ---------------------------------------------------------------------------
// Review protocol
// ---------------------------------------------------------------------------

describe('review protocol (TypeScript DSL)', () => {
  test('loads with correct metadata', () => {
    expect(review.name).toBe('review')
    expect(review.emoji).toBe('⚔️')
    expect(review.display).toBe('Adversarial Review')
  })

  test('has two roles', () => {
    expect(Object.keys(review.roles)).toEqual(['critic', 'owner'])
  })

  test('final_round goes to cleanup', () => {
    const result = review.machine.transition('owner_turn' as any, 'final_round' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cleanup')
  })

  test('windows match expected durations', () => {
    expect(review.windowMs('critic_turn')).toBe(10 * 60 * 1000)
    expect(review.windowMs('owner_turn')).toBe(30 * 60 * 1000)
    expect(review.windowMs('cleanup')).toBe(5 * 60 * 1000)
  })

  test('disconnect grace durations', () => {
    expect(review.graceMs('critic')).toBe(30_000)
    expect(review.graceMs('owner')).toBe(120_000)
  })

  test('half is derivable from phase definitions', () => {
    expect(review.phases.critic_turn.half).toBe('top')
    expect(review.phases.owner_turn.half).toBe('bottom')
    expect(review.phases.cleanup.half).toBe('top')
  })

  test('critic seed renders with context', () => {
    const seed = review.seed('critic', {
      name: 'drift',
      sessionId: 'abc-123',
      threadId: 'thread-456',
      rounds: 3,
    })
    expect(seed).toContain('drift')
    expect(seed).toContain('abc-123')
    expect(seed).toContain('thread-456')
    expect(seed).toContain('3-round')
    expect(seed).toContain('[critic→owner]')
  })

  test('critic seed switches mandate for focused topic', () => {
    const general = review.seed('critic', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    const focused = review.seed('critic', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1, topic: 'security' })!
    expect(general).toContain('argue AGAINST')
    expect(general).not.toContain('Your focus:')
    expect(focused).toContain('Your focus:')
    expect(focused).toContain('security')
    expect(focused).not.toContain('argue AGAINST')
  })

  test('sentinels match expected tags', () => {
    expect(review.sentinel('critic_turn')).toBe('[critic→owner]')
    expect(review.sentinel('owner_turn')).toBe('[owner→critic]')
    expect(review.sentinel('cleanup')).toBe('[summary]')
    expect(review.sentinel('complete')).toBeUndefined()
  })

  test('no decisions declared', () => {
    expect(Object.keys(review.decisions)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Build protocol
// ---------------------------------------------------------------------------

describe('build protocol (TypeScript DSL)', () => {
  test('loads with correct metadata', () => {
    expect(build.name).toBe('build')
    expect(build.emoji).toBe('🔨')
  })

  test('windows match expected durations', () => {
    expect(build.windowMs('reviewing')).toBe(20 * 60 * 1000)
    expect(build.windowMs('implementing')).toBe(30 * 60 * 1000)
    expect(build.windowMs('closing')).toBe(5 * 60 * 1000)
  })

  test('disconnect grace durations', () => {
    expect(build.graceMs('critic')).toBe(30_000)
    expect(build.graceMs('builder')).toBe(120_000)
  })

  test('sentinels match expected tags', () => {
    expect(build.sentinel('implementing')).toBe('[builder→critic]')
    expect(build.sentinel('reviewing')).toBe('[critic→builder]')
    expect(build.sentinel('closing')).toBe('[summary]')
    expect(build.sentinel('complete')).toBeUndefined()
  })

  test('critic_verdict decision is declared', () => {
    expect(build.decisions.critic_verdict).toBeDefined()
    expect(build.decisions.critic_verdict.options).toEqual(['approve', 'request_changes'])
  })

  test('critic seed renders with task context', () => {
    const seed = build.seed('critic', {
      name: 'qubit',
      sessionId: 'abc',
      threadId: 'thread-1',
      rounds: 3,
      task: 'Fix the race condition',
    })
    expect(seed).toContain('qubit')
    expect(seed).toContain('Fix the race condition')
    expect(seed).toContain("decide('approve'")
  })
})

// ---------------------------------------------------------------------------
// DSL validation
// ---------------------------------------------------------------------------

describe('protocol DSL validation', () => {
  test('rejects unknown actor', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'b', on: {} } },
      windows: {},
    })).toThrow('actor "b" is not a declared role')
  })

  test('rejects transition to unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: { go: 'nowhere' } } },
      windows: {},
    })).toThrow('targets an unknown phase')
  })

  test('rejects window on unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: { missing: '5m' },
    })).toThrow('unknown phase "missing"')
  })

  test('rejects grace for unknown role', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      grace: { nobody: '30s' },
    })).toThrow('unknown role "nobody"')
  })

  test('rejects decision on unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      decisions: { d: { phase: 'nowhere', actor: 'a', options: ['x'] } },
    })).toThrow('unknown phase "nowhere"')
  })

  test('rejects cleanupPhase on unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      cleanupPhase: 'nonexistent',
    })).toThrow('cleanupPhase "nonexistent" is not a declared phase')
  })

  test('rejects sentinel on unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      sentinels: { missing_phase: '[tag]' },
    })).toThrow('sentinel on unknown phase "missing_phase"')
  })

  test('protocol object is frozen', () => {
    const p = protocol('frozen', {
      emoji: '🧊', display: 'Frozen',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
    })
    expect(Object.isFrozen(p)).toBe(true)
  })

  test('cleanupPhase gets default onEnter when not specified', () => {
    const p = protocol('defaults', {
      emoji: '🧪', display: 'Defaults',
      roles: { a: 'A', b: 'B' },
      phases: {
        working: { actor: 'a', on: { done: 'cleanup', cancel: 'cancelled' } },
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, replyEvent: 'posted' },
        complete: { actor: 'a', on: {} },
        cancelled: { actor: 'a', on: {} },
      },
      windows: { cleanup: '5m' },
      cleanupPhase: 'cleanup',
      cancelPhase: 'cancelled',
    })
    expect(p.phases.cleanup.onEnter).toEqual(['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'])
  })

  test('cleanupPhase with explicit onEnter keeps it (no default injection)', () => {
    const p = protocol('explicit', {
      emoji: '🧪', display: 'Explicit',
      roles: { a: 'A' },
      phases: {
        working: { actor: 'a', on: { done: 'cleanup' } },
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, replyEvent: 'posted', onEnter: ['backstopTimer'] },
        complete: { actor: 'a', on: {} },
      },
      windows: { cleanup: '5m' },
      cleanupPhase: 'cleanup',
    })
    expect(p.phases.cleanup.onEnter).toEqual(['backstopTimer'])
  })

  test('cleanupPhase with empty onEnter suppresses defaults', () => {
    const p = protocol('optout', {
      emoji: '🧪', display: 'OptOut',
      roles: { a: 'A' },
      phases: {
        working: { actor: 'a', on: { done: 'cleanup' } },
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, replyEvent: 'posted', onEnter: [] },
        complete: { actor: 'a', on: {} },
      },
      windows: { cleanup: '5m' },
      cleanupPhase: 'cleanup',
    })
    expect(p.phases.cleanup.onEnter).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Default cleanup behavior on live protocols
// ---------------------------------------------------------------------------

describe('live protocol cleanup defaults', () => {
  test('review cleanup phase has default behaviors', () => {
    expect(review.phases.cleanup.onEnter).toEqual(['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'])
  })

  test('build closing phase has default behaviors', () => {
    expect(build.phases.closing.onEnter).toEqual(['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'])
  })
})
