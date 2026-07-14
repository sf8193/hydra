import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { reviewMachine, CRITIC_SENTINEL, OWNER_SENTINEL, SUMMARY_SENTINEL, CRITIC_TIMEOUT_MS, OWNER_TIMEOUT_MS } from '../adversarial.js'
import { buildMachine, BUILDER_SENTINEL, CRITIC_SENTINEL as BUILD_CRITIC_SENTINEL, SUMMARY_SENTINEL as BUILD_SUMMARY_SENTINEL, CRITIC_TIMEOUT_MS as BUILD_CRITIC_TIMEOUT_MS, OWNER_TIMEOUT_MS as BUILD_OWNER_TIMEOUT_MS } from '../build.js'

let origStderrWrite: typeof process.stderr.write
beforeEach(() => { origStderrWrite = process.stderr.write; process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = origStderrWrite })

// ---------------------------------------------------------------------------
// Load the protocol definitions
// ---------------------------------------------------------------------------

const review = (await import('../../protocols/review.js')).default
const build = (await import('../../protocols/build.js')).default

// ---------------------------------------------------------------------------
// Review protocol — parity with adversarial.ts
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

  test('transition table matches reviewMachine', () => {
    for (const [phase, phaseDef] of Object.entries(review.phases)) {
      for (const [event, target] of Object.entries(phaseDef.on)) {
        const result = reviewMachine.transition(phase as any, event as any)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.to).toBe(target)
      }
    }
  })

  test('windows match the live timeout constants', () => {
    expect(review.windowMs('critic_turn')).toBe(CRITIC_TIMEOUT_MS)
    expect(review.windowMs('owner_turn')).toBe(OWNER_TIMEOUT_MS)
    expect(review.windowMs('cleanup')).toBe(5 * 60 * 1000)
    expect(review.windowMs('post_pass')).toBe(CRITIC_TIMEOUT_MS)
  })

  test('disconnect grace matches the live constants', () => {
    expect(review.graceMs('critic')).toBe(30_000)
    expect(review.graceMs('owner')).toBe(120_000)
  })

  test('half is derivable from phase definitions', () => {
    expect(review.phases.critic_turn.half).toBe('top')
    expect(review.phases.owner_turn.half).toBe('bottom')
    expect(review.phases.cleanup.half).toBe('top')
    expect(review.phases.post_pass.half).toBe('bottom')
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

  test('sentinels match the live constants', () => {
    expect(review.sentinel('critic_turn')).toBe(CRITIC_SENTINEL)
    expect(review.sentinel('owner_turn')).toBe(OWNER_SENTINEL)
    expect(review.sentinel('post_pass')).toBe(CRITIC_SENTINEL)
    expect(review.sentinel('cleanup')).toBe(SUMMARY_SENTINEL)
    expect(review.sentinel('complete')).toBeUndefined()
  })

  test('pass_verdict decision is declared', () => {
    expect(review.decisions.pass_verdict).toBeDefined()
    expect(review.decisions.pass_verdict.phase).toBe('post_pass')
    expect(review.decisions.pass_verdict.actor).toBe('critic')
    expect(review.decisions.pass_verdict.options).toEqual(['clean', 'findings'])
  })
})

// ---------------------------------------------------------------------------
// Build protocol — parity with build.ts
// ---------------------------------------------------------------------------

describe('build protocol (TypeScript DSL)', () => {
  test('loads with correct metadata', () => {
    expect(build.name).toBe('build')
    expect(build.emoji).toBe('🔨')
  })

  test('transition table matches buildMachine', () => {
    for (const [phase, phaseDef] of Object.entries(build.phases)) {
      for (const [event, target] of Object.entries(phaseDef.on)) {
        const result = buildMachine.transition(phase as any, event as any)
        if (Object.keys(phaseDef.on).length === 0) continue
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.to).toBe(target)
      }
    }
  })

  test('windows match the live timeout constants', () => {
    expect(build.windowMs('reviewing')).toBe(BUILD_CRITIC_TIMEOUT_MS)
    expect(build.windowMs('implementing')).toBe(BUILD_OWNER_TIMEOUT_MS)
    expect(build.windowMs('closing')).toBe(5 * 60 * 1000)
  })

  test('disconnect grace matches the live constants', () => {
    expect(build.graceMs('critic')).toBe(30_000)
    expect(build.graceMs('builder')).toBe(120_000)
  })

  test('sentinels match the live constants', () => {
    expect(build.sentinel('implementing')).toBe(BUILDER_SENTINEL)
    expect(build.sentinel('reviewing')).toBe(BUILD_CRITIC_SENTINEL)
    expect(build.sentinel('closing')).toBe(BUILD_SUMMARY_SENTINEL)
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

  test('rejects closingPhase on unknown phase', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      closingPhase: 'nonexistent',
    })).toThrow('closingPhase "nonexistent" is not a declared phase')
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
})
