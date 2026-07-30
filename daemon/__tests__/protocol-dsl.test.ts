import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { protocolEvents } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'
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

  test('transition table matches reviewMachine (shared transitions)', () => {
    // v2 removed post_pass — final_round goes to cleanup directly.
    // Only check transitions where both machines agree on the target.
    const v2Removed = new Set(['final_round'])
    for (const [phase, phaseDef] of Object.entries(review.phases)) {
      for (const [event, target] of Object.entries(phaseDef.on)) {
        if (v2Removed.has(event)) continue
        const result = reviewMachine.transition(phase as any, event as any)
        if (!result.ok) continue
        expect(result.to).toBe(target)
      }
    }
  })

  test('final_round goes to cleanup (no post_pass)', () => {
    const result = review.machine.transition('owner_turn' as any, 'final_round' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cleanup')
  })

  test('windows match the live timeout constants', () => {
    expect(review.windowMs('critic_turn')).toBe(CRITIC_TIMEOUT_MS)
    expect(review.windowMs('owner_turn')).toBe(OWNER_TIMEOUT_MS)
    expect(review.windowMs('cleanup')).toBe(5 * 60 * 1000)
  })

  test('disconnect grace matches the live constants', () => {
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

  test('sentinels match the live constants', () => {
    expect(review.sentinel('critic_turn')).toBe(CRITIC_SENTINEL)
    expect(review.sentinel('owner_turn')).toBe(OWNER_SENTINEL)
    expect(review.sentinel('cleanup')).toBe(SUMMARY_SENTINEL)
    expect(review.sentinel('complete')).toBeUndefined()
  })

  test('no decisions declared (modifiers replace post-pass decisions)', () => {
    expect(Object.keys(review.decisions)).toHaveLength(0)
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
// Phase interaction classification
// ---------------------------------------------------------------------------

describe('phaseInteraction', () => {
  test('sentinel-only phase returns sentinel mode', () => {
    expect(review.phaseInteraction('critic_turn')).toEqual({ mode: 'sentinel', tag: '[critic→owner]' })
    expect(review.phaseInteraction('owner_turn')).toEqual({ mode: 'sentinel', tag: '[owner→critic]' })
  })

  test('decide-only phase returns decide mode with sentinel tag', () => {
    expect(build.phaseInteraction('reviewing')).toEqual({ mode: 'decide', tag: '[critic→builder]' })
  })

  test('both sentinel and decide returns both mode', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    expect(spike.phaseInteraction('exploring')).toEqual({ mode: 'both', tag: '[checkpoint]' })
  })

  test('terminal phase returns undefined', () => {
    expect(review.phaseInteraction('complete')).toBeUndefined()
    expect(review.phaseInteraction('cancelled')).toBeUndefined()
  })

  test('rejects sentinel without replyEvent or decision (inert sentinel)', () => {
    expect(() => protocol('test-inert', {
      emoji: '🧪', display: 'Test',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: { done: 'end' } }, end: { actor: 'a', on: {} } },
      windows: {},
      sentinels: { start: '[tag]' },
    })).toThrow('sentinel "[tag]" but no replyEvent or decision')
  })
})

describe('roleConfig', () => {
  test('returns declared config', () => {
    expect(review.roleConfig('critic')).toEqual({ cadence: 'per-round', waits: true })
  })

  test('returns defaults for undeclared role', () => {
    expect(review.roleConfig('owner')).toEqual({ cadence: 'per-round', waits: false })
  })

  test('spike explorer has per-phase cadence with orient', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    const cfg = spike.roleConfig('explorer')
    expect(cfg.cadence).toBe('per-phase')
    expect(cfg.orient).toContain('depth-first')
  })

  test('rejects roleConfig for unknown role', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      roleConfig: { nobody: { cadence: 'per-round' } },
    })).toThrow('roleConfig for unknown role "nobody"')
  })

  test('rejects per-phase cadence without orient', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      roleConfig: { a: { cadence: 'per-phase' } },
    })).toThrow('cadence "per-phase" but no orient')
  })

  test('rejects description key not in options', () => {
    expect(() => protocol('bad', {
      emoji: '🧪', display: 'Bad',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: {} } },
      windows: {},
      decisions: { d: { phase: 'start', actor: 'a', options: ['yes', 'no'], descriptions: { yse: 'typo' } } },
    })).toThrow('description key "yse" is not a declared option')
  })
})

describe('protocolSeed', () => {
  test('generates decide instructions from protocol declarations', () => {
    const seed = build.seed('critic', { name: 'drift', sessionId: 'a', threadId: 't', rounds: 3 })!
    expect(seed).toContain("decide('approve'")
    expect(seed).toContain("decide('request_changes'")
    expect(seed).toContain('does NOT advance')
  })

  test('generates dual-mode instructions for both sentinel+decide', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    const seed = spike.seed('explorer', { name: 'drift', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain("decide('done'")
    expect(seed).toContain('[checkpoint]')
    expect(seed).toContain('for progress')
    expect(seed).not.toContain('does NOT advance')
  })

  test('auto-injects protocol into SeedContext', () => {
    const seed = review.seed('critic', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain('[critic→owner]')
  })

  test('auto-fallback generates seed for role with sentinels but no explicit seed', () => {
    const p = protocol('test-fallback', {
      emoji: '🧪', display: 'Test',
      roles: { worker: 'Worker', boss: 'Boss' },
      phases: {
        working: { actor: 'worker', on: { done: 'end' }, replyEvent: 'done' },
        end: { actor: 'boss', on: {} },
      },
      windows: {},
      sentinels: { working: '[done]' },
      roleConfig: { worker: { cadence: 'per-round' } },
    })
    const seed = p.seed('worker', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain('[done]')
    expect(seed).toContain('per round')
  })

  test('auto-fallback generates seed for decide-only role (no sentinels)', () => {
    const p = protocol('test-decide-only', {
      emoji: '🧪', display: 'Test',
      roles: { judge: 'Judge', defendant: 'Defendant' },
      phases: {
        judging: { actor: 'judge', on: { guilty: 'end', innocent: 'end' } },
        end: { actor: 'defendant', on: {} },
      },
      windows: {},
      decisions: { verdict: { phase: 'judging', actor: 'judge', options: ['guilty', 'innocent'] as const, events: { guilty: 'guilty', innocent: 'innocent' } } },
    })
    const seed = p.seed('judge', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain("decide('guilty'")
    expect(seed).toContain("decide('innocent'")
    expect(seed).not.toContain('FIRST LINE')
  })

  test('passive role with only roleConfig returns undefined seed', () => {
    const p = protocol('test-passive', {
      emoji: '🧪', display: 'Test',
      roles: { observer: 'Observer', worker: 'Worker' },
      phases: {
        working: { actor: 'worker', on: { done: 'end' }, replyEvent: 'done' },
        end: { actor: 'worker', on: {} },
      },
      windows: {},
      sentinels: { working: '[done]' },
      roleConfig: { observer: { cadence: 'per-round' } },
    })
    expect(p.seed('observer', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })).toBeUndefined()
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

  test('spike reporting phase keeps explicit override (no killNonOwner, no notifyOwnerSummary)', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    expect(spike.phases.reporting.onEnter).toEqual(['backstopTimer'])
  })
})

// ---------------------------------------------------------------------------
// ProtocolEventBus — emission behavior
// ---------------------------------------------------------------------------

describe('ProtocolEventBus', () => {
  test('emitComplete delivers event to listeners', () => {
    const received: CompletionEvent[] = []
    const listener = (e: CompletionEvent) => received.push(e)
    protocolEvents.onComplete(listener)
    try {
      const event: CompletionEvent = {
        protocol: 'test', threadId: 't1', rounds: { completed: 2, requested: 3 },
        outcome: 'complete', decisions: [], durationMs: 1000,
      }
      protocolEvents.emitComplete(event)
      expect(received).toHaveLength(1)
      expect(received[0].protocol).toBe('test')
      expect(received[0].outcome).toBe('complete')
    } finally {
      protocolEvents.offComplete(listener)
    }
  })

  test('emitComplete isolates per-listener errors — throwing listener does not skip subsequent listeners', () => {
    const received: string[] = []
    const first = () => { received.push('first') }
    const throwing = () => { throw new Error('boom') }
    const third = () => { received.push('third') }
    protocolEvents.onComplete(first)
    protocolEvents.onComplete(throwing)
    protocolEvents.onComplete(third)
    try {
      const event: CompletionEvent = {
        protocol: 'test', threadId: 't1', rounds: { completed: 0, requested: 1 },
        outcome: 'cancelled', reason: 'test', decisions: [], durationMs: 0,
      }
      expect(() => protocolEvents.emitComplete(event)).not.toThrow()
      expect(received).toEqual(['first', 'third'])
    } finally {
      protocolEvents.offComplete(first)
      protocolEvents.offComplete(throwing)
      protocolEvents.offComplete(third)
    }
  })

  test('offComplete removes listener', () => {
    let count = 0
    const listener = () => { count++ }
    protocolEvents.onComplete(listener)
    protocolEvents.emitComplete({ protocol: 'x', threadId: 'x', rounds: { completed: 0, requested: 0 }, outcome: 'complete', decisions: [], durationMs: 0 })
    expect(count).toBe(1)
    protocolEvents.offComplete(listener)
    protocolEvents.emitComplete({ protocol: 'x', threadId: 'x', rounds: { completed: 0, requested: 0 }, outcome: 'complete', decisions: [], durationMs: 0 })
    expect(count).toBe(1)
  })
})
