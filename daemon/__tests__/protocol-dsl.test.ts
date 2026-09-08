import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { protocol } from '../protocol-dsl.js'
import { protocolEvents } from '../protocol-runner.js'
import type { CompletionEvent } from '../protocol-types.js'

let origStderrWrite: typeof process.stderr.write
beforeEach(() => { origStderrWrite = process.stderr.write; process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = origStderrWrite })

// ---------------------------------------------------------------------------
// Load the protocol definitions
// ---------------------------------------------------------------------------

const review = (await import('../../protocols/review.js')).default
const build = (await import('../../protocols/build.js')).default

// ---------------------------------------------------------------------------
// Review protocol — the DSL definition is the source of truth (v1 removed)
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

  test('transition table is internally consistent with declared phase targets', () => {
    for (const [phase, phaseDef] of Object.entries(review.phases)) {
      for (const [event, target] of Object.entries(phaseDef.on)) {
        const result = review.machine.transition(phase, event)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.to).toBe(target)
      }
    }
  })

  test('final_round goes to cleanup (no post_pass)', () => {
    const result = review.machine.transition('owner_turn' as any, 'final_round' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cleanup')
  })

  test('fallback event transitions critic_turn to subagent_review', () => {
    const fromCritic = review.machine.transition('critic_turn' as any, 'fallback' as any)
    expect(fromCritic.ok).toBe(true)
    if (fromCritic.ok) expect(fromCritic.to).toBe('subagent_review')
  })

  test('owner_turn does NOT have on.fallback (fallback is deferred until the owner advances)', () => {
    expect(review.phases.owner_turn.on.fallback).toBeUndefined()
    const fromOwner = review.machine.transition('owner_turn' as any, 'fallback' as any)
    expect(fromOwner.ok).toBe(false)
  })

  test('subagent_review advances to complete on summary_posted', () => {
    const result = review.machine.transition('subagent_review' as any, 'summary_posted' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('complete')
  })

  test('subagent_review times out to cancelled (a timed-out fallback is a failure, not a success)', () => {
    const result = review.machine.transition('subagent_review' as any, 'timeout' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cancelled')
  })

  test('subagent_review is an owner advance phase', () => {
    expect(review.phases.subagent_review.actor).toBe('owner')
    expect(review.phaseInteraction('subagent_review')).toEqual({ verdict: 'none' })
  })

  test('subagent_review is cancellable (owner death mid-fallback transitions cleanly)', () => {
    const result = review.machine.transition('subagent_review' as any, 'cancel' as any)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.to).toBe('cancelled')
  })

  test('onFallback frames lenses as suggestions and uses fresh subagents, not forks', () => {
    const msg = review.notifications.onFallback!(
      { params: { topic: 'auth flow' }, currentRound: 2, rounds: 3 } as any,
      { mode: 'fallback', deadRole: 'critic', deadLabel: 'The Critic', resumeAttempts: 5, completedRounds: 1 },
    )
    expect(msg).toContain('The Critic')
    expect(msg).toContain('5 resume attempts')
    // Gap-filling wording: reference the completed/total rounds and steer subagents
    // toward what the dead critic didn't get to.
    expect(msg).toContain('1 of')
    expect(msg).toContain("didn't")
    expect(msg).toContain('cover')
    // Dan's design: lenses are suggestions the material drives, reviewers are
    // fresh + independent, not forks of the owner's context.
    expect(msg).toContain('suggestions, not a checklist')
    expect(msg.toLowerCase()).toContain('fresh')
    expect(msg).toContain('do not fork')
    expect(msg).toContain('auth flow')
  })

  test('onFallback in direct mode names the choice, not a death, and keeps the task', () => {
    const msg = review.notifications.onFallback!(
      { params: { topic: 'auth flow' }, currentRound: 1, rounds: 3 } as any,
      { mode: 'direct' },
    )
    expect(msg).toContain('+subagent')
    expect(msg).not.toContain('died')
    expect(msg).not.toContain('resume attempt')
    // The task itself is mode-independent — same subagent instructions either way.
    expect(msg).toContain('suggestions, not a checklist')
    expect(msg).toContain('do not fork')
    expect(msg).toContain('auth flow')
  })

  test('onFallback hands critic-targeted lens modifiers to the owner (they have no critic left)', () => {
    const run = {
      params: { modifiers: [{ type: 'seed', name: 'security', target: 'critic', instructions: 'attack surface only' }] },
      currentRound: 1,
      rounds: 3,
    } as any
    for (const ctx of [{ mode: 'direct' as const }, { mode: 'fallback' as const, deadRole: 'critic', deadLabel: 'The Critic', resumeAttempts: 1, completedRounds: 0 }]) {
      const msg = review.notifications.onFallback!(run, ctx)
      expect(msg).toContain('+security')
      expect(msg).toContain('attack surface only')
    }
  })

  test('review opts into fallback via a declared on.fallback transition + onFallback hook', () => {
    expect(review.phases.critic_turn.on.fallback).toBe('subagent_review')
    expect(typeof review.notifications.onFallback).toBe('function')
  })

  test('review declares what its fallback path gives up', () => {
    expect(review.fallbackDegradation).toBe('subagent self-review (no adversarial tension)')
  })

  test('opting into fallback without declaring fallbackDegradation throws at registration', () => {
    const spec = {
      emoji: '🧪',
      display: 'Degradation Test',
      roles: { helper: 'The Helper', owner: 'The Owner' },
      owner: 'owner' as const,
      cancelPhase: 'cancelled' as const,
      phases: {
        helper_turn: { actor: 'helper', on: { posted: 'done', cancel: 'cancelled', fallback: 'owner_solo' } },
        owner_solo: { actor: 'owner', on: { posted: 'done', cancel: 'cancelled' }, advanceEvent: 'posted' },
        done: { actor: 'owner', on: {} },
        cancelled: { actor: 'owner', on: {} },
      },
      windows: {},
      notifications: { onFallback: () => 'take it from here' },
    }

    expect(() => protocol('degradation-missing', spec as any)).toThrow(/fallbackDegradation/)
    expect(() => protocol('degradation-present', { ...spec, fallbackDegradation: 'solo, unchallenged' } as any)).not.toThrow()
  })

  test('an on.fallback transition without an onFallback hook is inert, not a registration error', () => {
    // Both halves are the opt-in. Half of it can't produce a fallback completion,
    // so there is nothing for fallbackDegradation to label.
    expect(() => protocol('half-optin', {
      emoji: '🧪',
      display: 'Half Opt-in',
      roles: { helper: 'The Helper', owner: 'The Owner' },
      owner: 'owner',
      cancelPhase: 'cancelled',
      phases: {
        helper_turn: { actor: 'helper', on: { posted: 'done', cancel: 'cancelled', fallback: 'owner_solo' } },
        owner_solo: { actor: 'owner', on: { posted: 'done', cancel: 'cancelled' }, advanceEvent: 'posted' },
        done: { actor: 'owner', on: {} },
        cancelled: { actor: 'owner', on: {} },
      },
      windows: {},
    } as any)).not.toThrow()
  })

  test('build and spike do NOT opt into fallback (generic gate excludes them)', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    for (const proto of [build, spike]) {
      expect(proto.phases['subagent_review']).toBeUndefined()
      expect(proto.notifications.onFallback).toBeUndefined()
      for (const phaseDef of Object.values(proto.phases)) {
        expect(phaseDef.on.fallback).toBeUndefined()
      }
    }
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
    expect(seed).toContain('advance(')
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
    expect(seed).toContain('verdict: "approve"')
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
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, advanceEvent: 'posted' },
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
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, advanceEvent: 'posted', onEnter: ['backstopTimer'] },
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
        cleanup: { actor: 'a', on: { posted: 'complete', timeout: 'complete' }, advanceEvent: 'posted', onEnter: [] },
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
  test('advance-only phase returns advance mode', () => {
    expect(review.phaseInteraction('critic_turn')).toEqual({ verdict: 'none' })
    expect(review.phaseInteraction('owner_turn')).toEqual({ verdict: 'none' })
  })

  test('decide-only phase returns decide mode', () => {
    expect(build.phaseInteraction('reviewing')).toEqual({ verdict: 'required', options: ['approve', 'request_changes'], descriptions: { approve: 'why it ships', request_changes: 'what to fix' } })
  })

  test('both advance and decide returns both mode', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    expect(spike.phaseInteraction('exploring')).toEqual({ verdict: 'optional', options: ['done'], descriptions: { done: 'your summary' } })
  })

  test('terminal phase returns undefined', () => {
    expect(review.phaseInteraction('complete')).toBeUndefined()
    expect(review.phaseInteraction('cancelled')).toBeUndefined()
  })

  test('phase with no advanceEvent and no decision returns undefined', () => {
    const p = protocol('test-no-ia', {
      emoji: '🧪', display: 'Test',
      roles: { a: 'A' },
      phases: { start: { actor: 'a', on: { done: 'end' } }, end: { actor: 'a', on: {} } },
      windows: {},
    })
    expect(p.phaseInteraction('start')).toBeUndefined()
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
  test('generates advance instructions with verdict for decide phases', () => {
    const seed = build.seed('critic', { name: 'drift', sessionId: 'a', threadId: 't', rounds: 3 })!
    expect(seed).toContain('verdict: "approve"')
    expect(seed).toContain('verdict: "request_changes"')
    expect(seed).toContain('advance')
  })

  test('generates both-mode instructions for advance+decide phases', async () => {
    const spike = (await import('../../protocols/spike.js')).default
    const seed = spike.seed('explorer', { name: 'drift', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain('verdict: "done"')
    expect(seed).toContain('checkpoints')
    expect(seed).toContain('advance(')
  })

  test('auto-injects protocol into SeedContext', () => {
    const seed = review.seed('critic', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain('advance(')
  })

  test('auto-fallback generates seed for role with advanceEvent but no explicit seed', () => {
    const p = protocol('test-fallback', {
      emoji: '🧪', display: 'Test',
      roles: { worker: 'Worker', boss: 'Boss' },
      phases: {
        working: { actor: 'worker', on: { done: 'end' }, advanceEvent: 'done' },
        end: { actor: 'boss', on: {} },
      },
      windows: {},
      roleConfig: { worker: { cadence: 'per-round' } },
    })
    const seed = p.seed('worker', { name: 'x', sessionId: 'a', threadId: 't', rounds: 1 })!
    expect(seed).toContain('advance(')
    expect(seed).toContain('per round')
  })

  test('auto-fallback generates seed for decide-only role', () => {
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
    expect(seed).toContain('verdict: "guilty"')
    expect(seed).toContain('verdict: "innocent"')
  })

  test('passive role with only roleConfig returns undefined seed', () => {
    const p = protocol('test-passive', {
      emoji: '🧪', display: 'Test',
      roles: { observer: 'Observer', worker: 'Worker' },
      phases: {
        working: { actor: 'worker', on: { done: 'end' }, advanceEvent: 'done' },
        end: { actor: 'worker', on: {} },
      },
      windows: {},
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
    expect(spike.phases.reporting.onEnter).toEqual([])
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
