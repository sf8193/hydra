import { describe, test, expect, afterEach } from 'bun:test'
import { createHarness, TestHarness, TOTAL_PHASE_CAP_FACTOR, WARNING_BEFORE_TIMEOUT_MS } from './test-harness.js'
import { computeToolsForSession, PROTOCOL_ACTOR_TOOLS } from '../bridge-tools.js'
import { protocol } from '../protocol-dsl.js'

// Real protocol definitions — the harness exercises them as-is
import review from '../../protocols/review.js'
import build from '../../protocols/build.js'
import spike from '../../protocols/spike.js'

let h: TestHarness

afterEach(() => {
  h?.dispose()
  h = undefined as any
})

// ---------------------------------------------------------------------------
// Review protocol scenarios
// ---------------------------------------------------------------------------

describe('review: cooperative 3-round completion', () => {
  test('full exchange through all rounds produces complete event', async () => {
    h = createHarness(review, { rounds: 3, topic: 'test review' })
    expect(h.phase).toBe('critic_turn')
    expect(h.round).toBe(1)

    // Round 1
    await h.advance('critic', 'Your code has a potential null dereference on line 42.')
    expect(h.phase).toBe('owner_turn')

    await h.advance('owner', 'Added a null check. See commit abc123.')
    expect(h.phase).toBe('critic_turn')
    expect(h.round).toBe(2)

    // Round 2
    await h.advance('critic', 'The null check is good, but the error message is unclear.')
    expect(h.phase).toBe('owner_turn')

    await h.advance('owner', 'Improved the error message with context.')
    expect(h.phase).toBe('critic_turn')
    expect(h.round).toBe(3)

    // Round 3 (final)
    await h.advance('critic', 'All issues addressed. Clean code.')
    expect(h.phase).toBe('owner_turn')

    await h.advance('owner', 'Final defense — all findings resolved.')
    expect(h.phase).toBe('cleanup')
    expect(h.round).toBe(3)

    // Owner posts summary to complete the run
    await h.advance('owner', '**Review Summary** — all 3 rounds clean.')
    expect(h.isTerminated).toBe(true)

    expect(h.completionEvents).toHaveLength(1)
    const event = h.completionEvents[0]
    expect(event.outcome).toBe('complete')
    expect(event.protocol).toBe('review')
    expect(event.topic).toBe('test review')
    expect(event.rounds.completed).toBe(3)
    expect(event.rounds.requested).toBe(3)
  })
})

describe('review: timeout cancellation', () => {
  test('critic silence past window cancels the run', async () => {
    h = createHarness(review, { rounds: 3 })
    expect(h.phase).toBe('critic_turn')

    await h.tickToTimeout()

    expect(h.phase).toBe('cancelled')
    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
    expect(h.completionEvents[0].reason).toBe('timed out')
    expect(h.completionEvents[0].rounds.completed).toBe(0)
  })
})

describe('review: timeout deferred by activity', () => {
  test('working session gets deferred, idle session gets cancelled', async () => {
    h = createHarness(review, { rounds: 3 })

    const windowMs = h.run.protocol.windowMs('critic_turn')!

    h.setTurnState('critic', 'working')
    await h.tick(windowMs)

    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    h.setTurnState('critic', 'idle')
    await h.tick(windowMs)

    expect(h.phase).toBe('cancelled')
    expect(h.isTerminated).toBe(true)
  })
})

describe('review: warning notification at T-2m', () => {
  test('idle actor receives warning 2 minutes before timeout', async () => {
    h = createHarness(review, { rounds: 3 })

    await h.tickToWarning()

    const notes = h.actorNotifications('critic')
    expect(notes.some(n => n.includes('Phase timeout in 2 minutes'))).toBe(true)
    expect(notes.some(n => n.includes('advance('))).toBe(true)

    expect(h.threadMessages.some(m => m.text.includes('warned'))).toBe(true)
  })

  test('working actor does not receive warning', async () => {
    h = createHarness(review, { rounds: 3 })

    h.setTurnState('critic', 'working')
    await h.tickToWarning()

    const notes = h.actorNotifications('critic')
    expect(notes.some(n => n.includes('Phase timeout'))).toBe(false)
  })
})

describe('review: extension chain', () => {
  test('two extensions succeed, third rejected', () => {
    h = createHarness(review, { rounds: 3 })

    const r1 = h.extend('critic', 'reading large codebase', 5)
    expect(r1.ok).toBe(true)

    const r2 = h.extend('critic', 'found something deep', 5)
    expect(r2.ok).toBe(true)

    const r3 = h.extend('critic', 'just one more thing', 5)
    expect(r3.ok).toBe(false)
    expect(r3.reason).toContain('max extensions')

    expect(h.decisions).toHaveLength(2)
    expect(h.decisions[0].value).toBe('extend')
    expect(h.decisions[0].context).toBe('+5m')
  })

  test('extensions reset each round', async () => {
    h = createHarness(review, { rounds: 3 })

    expect(h.extend('critic', 'first', 5).ok).toBe(true)
    expect(h.extend('critic', 'second', 5).ok).toBe(true)

    await h.advance('critic', 'Round 1 critique.')
    await h.advance('owner', 'Round 1 defense.')
    expect(h.round).toBe(2)

    expect(h.extend('critic', 'third', 5).ok).toBe(true)
    expect(h.extend('critic', 'fourth', 5).ok).toBe(true)
  })
})

describe('review: total backstop', () => {
  test('fires unconditionally at 3x window regardless of activity', async () => {
    h = createHarness(review, { rounds: 3 })

    const windowMs = h.run.protocol.windowMs('critic_turn')!
    h.setTurnState('critic', 'working')

    await h.tick(windowMs * TOTAL_PHASE_CAP_FACTOR)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
    expect(h.completionEvents[0].reason).toBe('total time exceeded')
  })
})

describe('review: disconnect and grace', () => {
  test('critic disconnect past grace cancels the run', async () => {
    h = createHarness(review, { rounds: 3 })

    h.disconnect('critic')

    const graceMs = h.run.protocol.graceMs('critic')!
    await h.tick(3_000 + graceMs + 1_000)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
  })

  test('critic reconnect within grace saves the run', async () => {
    h = createHarness(review, { rounds: 3 })

    h.disconnect('critic')
    await h.tick(5_000)
    h.reconnect('critic')

    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    await h.advance('critic', 'Back online with critique.')
    expect(h.phase).toBe('owner_turn')
  })
})

describe('review: wrong role rejection', () => {
  test('advance from wrong role is rejected', async () => {
    h = createHarness(review, { rounds: 3 })

    const result = await h.advance('owner', 'I should not post now.')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not your turn')
    expect(h.phase).toBe('critic_turn')
  })
})

describe('review: closing backstop completes (not cancels)', () => {
  test('closing timeout transitions to complete', async () => {
    h = createHarness(review, { rounds: 1 })

    await h.advance('critic', 'Looks good.')
    expect(h.phase).toBe('owner_turn')

    await h.advance('owner', 'Thanks.')
    expect(h.phase).toBe('cleanup')

    const closingMs = h.run.protocol.windowMs('cleanup')!
    await h.tick(closingMs)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('complete')
  })
})

describe('review: reply never advances', () => {
  test('conversational reply does not fire a transition', async () => {
    h = createHarness(review, { rounds: 3 })

    await h.reply('critic', 'Just a status update, not a deliverable.')
    expect(h.phase).toBe('critic_turn')

    await h.advance('critic', 'This is the actual critique.')
    expect(h.phase).toBe('owner_turn')
  })
})

// ---------------------------------------------------------------------------
// Build protocol scenarios
// ---------------------------------------------------------------------------

describe('build: approve → closing → complete', () => {
  test('builder implements, critic approves, summary completes', async () => {
    h = createHarness(build, { rounds: 3, topic: 'add retry logic' })
    expect(h.phase).toBe('implementing')

    await h.advance('builder', 'Added retry with exponential backoff.')
    expect(h.phase).toBe('reviewing')

    const result = await h.advance('critic', 'Clean implementation, ships.', 'approve')
    expect(result.ok).toBe(true)
    expect(h.phase).toBe('closing')
    expect(h.decisions.some(d => d.value === 'approve')).toBe(true)

    await h.advance('builder', '**Build Summary** — retry logic added.')
    expect(h.isTerminated).toBe(true)

    const event = h.completionEvents[0]
    expect(event.outcome).toBe('complete')
    expect(event.protocol).toBe('build')
  })
})

describe('build: request_changes loop', () => {
  test('critic requests changes, builder fixes, cycle repeats', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.advance('builder', 'First implementation.')
    expect(h.phase).toBe('reviewing')

    await h.advance('critic', 'Missing error handling.', 'request_changes')
    expect(h.phase).toBe('implementing')
    expect(h.round).toBe(2)

    await h.advance('builder', 'Added error handling.')
    expect(h.phase).toBe('reviewing')

    await h.advance('critic', 'Edge case in retry path.', 'request_changes')
    expect(h.phase).toBe('implementing')
    expect(h.round).toBe(3)

    await h.advance('builder', 'Fixed edge case.')
    expect(h.phase).toBe('reviewing')

    await h.advance('critic', 'Approve reluctantly.', 'request_changes')
    expect(h.phase).toBe('closing')
  })
})

describe('build: advance without verdict in decide-only phase is rejected', () => {
  test('reviewing phase requires a verdict', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.advance('builder', 'Done.')
    expect(h.phase).toBe('reviewing')

    const result = await h.advance('critic', 'Looks ok I guess.')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('requires a verdict')
    expect(h.phase).toBe('reviewing')
  })
})

describe('build: advance from wrong role rejected', () => {
  test('builder cannot advance during review phase', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.advance('builder', 'Implementation.')
    expect(h.phase).toBe('reviewing')

    const result = await h.advance('builder', 'I approve myself.', 'approve')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not your turn')
    expect(h.phase).toBe('reviewing')
  })
})

describe('build: review timeout cancels', () => {
  test('critic silence during review cancels the build', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.advance('builder', 'Done.')
    expect(h.phase).toBe('reviewing')

    await h.tick(h.run.protocol.windowMs('reviewing')!)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
  })
})

describe('build: invalid verdict rejected', () => {
  test('advance with unknown verdict value is rejected', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.advance('builder', 'Done.')
    expect(h.phase).toBe('reviewing')

    const result = await h.advance('critic', 'Not sure.', 'maybe')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('invalid verdict')
    expect(h.phase).toBe('reviewing')
  })
})

// ---------------------------------------------------------------------------
// Spike protocol scenarios
// ---------------------------------------------------------------------------

describe('spike: checkpoint self-loop + done verdict', () => {
  test('explorer checkpoints then decides done', async () => {
    h = createHarness(spike, { rounds: 1, topic: 'investigate caching' })
    expect(h.phase).toBe('exploring')

    // Checkpoint — self-loop via advanceEvent
    await h.advance('explorer', 'Found the cache layer in src/cache.ts.')
    expect(h.phase).toBe('exploring')

    // Done — verdict routes to reporting
    await h.advance('explorer', 'Investigation complete.', 'done')
    expect(h.phase).toBe('reporting')

    // Post report
    await h.advance('explorer', '**Report:** caching is handled by src/cache.ts with LRU eviction.')
    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('complete')
  })
})

describe('spike: advance-only phase does not accept verdict', () => {
  test('verdict in reporting phase is rejected', async () => {
    h = createHarness(spike, { rounds: 1 })

    await h.advance('explorer', 'Done.', 'done')
    expect(h.phase).toBe('reporting')

    const result = await h.advance('explorer', 'Report.', 'done')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('does not accept a verdict')
    expect(h.phase).toBe('reporting')
  })
})

// ---------------------------------------------------------------------------
// Guard rails and concurrency
// ---------------------------------------------------------------------------

describe('reentrancy guard (transitioningRuns)', () => {
  test('concurrent advances — second is dropped', async () => {
    h = createHarness(review, { rounds: 3 })

    const p1 = h.advance('critic', 'First critique.')
    const p2 = h.advance('critic', 'Second critique (dropped).')
    await Promise.all([p1, p2])

    expect(h.phase).toBe('owner_turn')
    expect(h.round).toBe(1)
  })
})

describe('double-cancel guard (cancellingRuns)', () => {
  test('simultaneous cancel paths produce only one completion event', async () => {
    h = createHarness(review, { rounds: 3 })

    const p1 = h.cancel('timeout')
    const p2 = h.cancel('disconnect')
    await Promise.all([p1, p2])

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Behavior verification
// ---------------------------------------------------------------------------

describe('review: notifyOwnerSummary fires on cleanup entry', () => {
  test('owner receives summary format notification when cleanup begins', async () => {
    h = createHarness(review, { rounds: 1 })

    await h.advance('critic', 'Critique.')
    await h.advance('owner', 'Defense.')
    expect(h.phase).toBe('cleanup')

    const notes = h.actorNotifications('owner')
    expect(notes.some(n => n.includes('Post a closing summary'))).toBe(true)
    expect(notes.some(n => n.includes('advance('))).toBe(true)

    expect(h.threadMessages.some(m => m.text.includes('concluded'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Extension semantics
// ---------------------------------------------------------------------------

describe('review: extension is a full window reset (minutes arg is advisory)', () => {
  test('extend after partial window grants a fresh full window, not +Nm', async () => {
    h = createHarness(review, { rounds: 3 })
    const windowMs = h.run.protocol.windowMs('critic_turn')!

    // Burn half the window, then extend with 5m
    await h.tick(windowMs / 2)
    expect(h.phase).toBe('critic_turn')
    h.extend('critic', 'reading codebase', 5)

    // If minutes arg were literal, timeout would be at half + 5m.
    // Tick past that point — still alive (proves 5m wasn't used).
    await h.tick(5 * 60_000 + 1_000)
    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    // Tick the remaining window from the extension point
    await h.tickToTimeout()
    expect(h.phase).toBe('cancelled')
    expect(h.isTerminated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Content is posted to thread by advance()
// ---------------------------------------------------------------------------

describe('advance posts content to thread', () => {
  test('advance content appears in threadMessages', async () => {
    h = createHarness(review, { rounds: 3 })

    const msgsBefore = h.threadMessages.length
    await h.advance('critic', 'Here is my detailed critique of the implementation.')

    const newMsgs = h.threadMessages.slice(msgsBefore)
    expect(newMsgs.some(m => m.text === 'Here is my detailed critique of the implementation.')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Timer behavior tests — exercises timer *firing*, not just timer existence.
// Covers the behavioral dead zone identified in adversarial review:
//   - disconnect timer fires + decideResume integration
//   - backstopTimer clears phase timers only (not disconnect timers)
//   - warning + deferral + backstop lifecycle
// ---------------------------------------------------------------------------

describe('review: disconnect timer fires and triggers grace', () => {
  test('disconnect timer fires after 3s when bridge is gone', async () => {
    h = createHarness(review, { rounds: 3 })
    expect(h.phase).toBe('critic_turn')

    h.disconnect('critic')
    expect(h.run.disconnectTimers.size).toBe(1)

    // Grace timer hasn't started yet — still in 3s disconnect window
    await h.tick(2_000)
    expect(h.isTerminated).toBe(false)

    // 3s disconnect timer fires → decideResume → grace (no claudeSessionId)
    await h.tick(1_500)

    // Grace timer should now be set (decideResume returns 'grace' since
    // tmux is alive, transport not connected, no claudeSessionId for resume)
    const graceMs = h.run.protocol.graceMs('critic')!
    expect(graceMs).toBeGreaterThan(0)

    // Grace expires → cancel
    await h.tick(graceMs + 500)
    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
  })
})

describe('review: reconnect clears disconnect timer', () => {
  test('reconnect within 3s prevents grace timer', async () => {
    h = createHarness(review, { rounds: 3 })

    h.disconnect('critic')
    expect(h.run.disconnectTimers.size).toBe(1)

    await h.tick(1_000)
    h.reconnect('critic')
    expect(h.run.disconnectTimers.size).toBe(0)

    // Tick past the original 3s + grace — should survive
    const graceMs = h.run.protocol.graceMs('critic')!
    await h.tick(3_000 + graceMs + 1_000)
    expect(h.isTerminated).toBe(false)
    expect(h.phase).toBe('critic_turn')
  })
})

describe('spike: backstopTimer preserves disconnect timers', () => {
  test('phase transition with backstopTimer does not clear disconnect timers', async () => {
    h = createHarness(spike, { rounds: 1, topic: 'test' })
    expect(h.phase).toBe('exploring')

    // Simulate a disconnect timer for the explorer (non-owner in spike is explorer)
    h.disconnect('explorer')
    expect(h.run.disconnectTimers.size).toBe(1)

    // Transition to reporting — has backstopTimer in onEnter
    await h.advance('explorer', 'Done investigating.', 'done')
    expect(h.phase).toBe('reporting')

    // Disconnect timer should survive the backstopTimer behavior
    expect(h.run.disconnectTimers.size).toBe(1)
  })
})

describe('review: backstopTimer clears only phase timers in cleanup', () => {
  test('cleanup phase clears timeout + warning + total but not disconnect timers', async () => {
    h = createHarness(review, { rounds: 1 })

    // Complete the exchange to reach cleanup
    await h.advance('critic', 'Looks good.')
    await h.advance('owner', 'Thanks.')
    expect(h.phase).toBe('cleanup')

    // Verify phase timers: backstopTimer sets run.timeout, clears warning/total
    expect(h.run.timeout).toBeDefined()
    expect(h.run._warningTimeout).toBeUndefined()
    expect(h.run._totalTimeout).toBeUndefined()
  })
})

describe('review: warning + deferral + backstop lifecycle', () => {
  test('warning fires, deferral resets, backstop catches runaway', async () => {
    h = createHarness(review, { rounds: 3 })
    const windowMs = h.run.protocol.windowMs('critic_turn')!

    // Phase 1: warning fires at T - 2m
    await h.tickToWarning()
    const warningNotes = h.actorNotifications('critic')
    expect(warningNotes.some(n => n.includes('Phase timeout in 2 minutes'))).toBe(true)

    // Phase 2: actor starts working before timeout → deferral
    h.setTurnState('critic', 'working')
    await h.tick(WARNING_BEFORE_TIMEOUT_MS) // tick past the original timeout point

    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    // Phase 3: actor keeps "working" → deferred timeouts repeat, but
    // total backstop fires unconditionally at 3x window
    const totalMs = windowMs * TOTAL_PHASE_CAP_FACTOR
    const elapsed = windowMs // already elapsed from tickToWarning + tick
    const remaining = totalMs - elapsed
    if (remaining > 0) await h.tick(remaining)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
    expect(h.completionEvents[0].reason).toBe('total time exceeded')
  })
})

describe('build: closing backstop fires completion, not cancel', () => {
  test('closing phase backstop transitions to complete', async () => {
    h = createHarness(build, { rounds: 1, topic: 'test' })

    await h.advance('builder', 'Implementation done.')
    expect(h.phase).toBe('reviewing')

    await h.advance('critic', 'Ships.', 'approve')
    expect(h.phase).toBe('closing')

    // Verify backstopTimer set up the timeout
    expect(h.run.timeout).toBeDefined()

    // Let backstop fire
    const closingMs = h.run.protocol.windowMs('closing')!
    await h.tick(closingMs)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('complete')
  })
})

// ---------------------------------------------------------------------------
// Resume cancellation guard — exercises isTerminal(run) post-await guards
// ---------------------------------------------------------------------------

describe('review: cancel during auto-resume kills spawned session', () => {
  test('cancellation during waitForBridge hits second guard', async () => {
    h = createHarness(review, { rounds: 3 })
    h.mockResume({ waitMs: 5_000 })

    h.setSessionDead('critic', 'claude-abc')
    h.disconnect('critic')

    // 3s disconnect timer fires → decideResume → resume path starts
    await h.tick(3_500)

    // Cancel mid-resume (doSpawnSession resolved instantly, waitForBridge pending)
    await h.cancel('human cancelled')

    // Let waitForBridge timer resolve
    await h.tick(5_500)

    expect(h.isTerminated).toBe(true)
    expect(h.killedSessions.length).toBeGreaterThan(0)
  })

  test('cancellation during doSpawnSession hits first guard', async () => {
    h = createHarness(review, { rounds: 3 })
    h.mockResume({ spawnMs: 5_000, waitMs: 0 })

    h.setSessionDead('critic', 'claude-abc')
    h.disconnect('critic')

    // 3s disconnect timer fires → decideResume → doSpawnSession starts (5s delay)
    await h.tick(3_500)

    // Cancel while doSpawnSession is still pending
    await h.cancel('human cancelled')

    // Let doSpawnSession resolve — first isTerminal guard catches it
    await h.tick(5_500)

    expect(h.isTerminated).toBe(true)
    expect(h.killedSessions.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// PhaseInteraction enrichment — options carried on the classification
// ---------------------------------------------------------------------------

describe('PhaseInteraction.options', () => {
  test('build reviewing carries verdict options from decision', () => {
    const ia = build.phaseInteraction('reviewing')
    expect(ia?.verdict).toBe('required')
    expect(ia?.options).toEqual(['approve', 'request_changes'])
  })

  test('spike exploring carries verdict options from decision', () => {
    const ia = spike.phaseInteraction('exploring')
    expect(ia?.verdict).toBe('optional')
    expect(ia?.options).toEqual(['done'])
  })

  test('review critic_turn has no options (verdict: none)', () => {
    const ia = review.phaseInteraction('critic_turn')
    expect(ia?.verdict).toBe('none')
    expect(ia?.options).toBeUndefined()
  })

  test('build implementing has no options (verdict: none)', () => {
    const ia = build.phaseInteraction('implementing')
    expect(ia?.verdict).toBe('none')
    expect(ia?.options).toBeUndefined()
  })

  test('review owner_turn has no options (verdict: none)', () => {
    const ia = review.phaseInteraction('owner_turn')
    expect(ia?.verdict).toBe('none')
    expect(ia?.options).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Decision actor build-time validation
// ---------------------------------------------------------------------------

describe('decision actor build-time validation', () => {
  test('throws when decision actor differs from phase actor', () => {
    expect(() => protocol('bad', {
      emoji: '⚠️',
      display: 'Bad',
      roles: { a: 'Role A', b: 'Role B' },
      phases: {
        step: { actor: 'a', on: { next: 'done' }, advanceEvent: 'next' },
        done: { actor: 'a', on: {} },
      },
      windows: { step: '5m' },
      decisions: {
        bad_decision: { phase: 'step', actor: 'b', options: ['x'] },
      },
    })).toThrow(/decision "bad_decision" actor "b" does not match phase "step" actor "a"/)
  })

  test('matching actor does not throw', () => {
    expect(() => protocol('good', {
      emoji: '✅',
      display: 'Good',
      roles: { a: 'Role A', b: 'Role B' },
      phases: {
        step: { actor: 'a', on: { next: 'done' } },
        done: { actor: 'a', on: {} },
      },
      windows: { step: '5m' },
      decisions: {
        good_decision: { phase: 'step', actor: 'a', options: ['x'], events: { x: 'next' } },
      },
    })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Dynamic tool scoping — computeToolsForSession
// ---------------------------------------------------------------------------

describe('dynamic tool scoping', () => {
  test('worker without advanceHint excludes advance and extend_phase', () => {
    const tools = computeToolsForSession('some-worker')
    const names = tools.map(t => t.name)
    expect(names).not.toContain('advance')
    expect(names).not.toContain('extend_phase')
  })

  test('worker with advanceHint includes advance with custom description', () => {
    const hint = 'advance({ content: "...", verdict: "approve" }) (or: request_changes)'
    const tools = computeToolsForSession('worker', { advanceHint: hint })
    const advance = tools.find(t => t.name === 'advance')
    expect(advance).toBeDefined()
    expect(advance!.description).toBe(hint)
  })

  test('worker with advanceHint includes extend_phase', () => {
    const tools = computeToolsForSession('worker', { advanceHint: 'advance(...)' })
    const names = tools.map(t => t.name)
    expect(names).toContain('extend_phase')
  })

  test('main session always includes advance and extend_phase', () => {
    const tools = computeToolsForSession('main')
    const names = tools.map(t => t.name)
    expect(names).toContain('advance')
    expect(names).toContain('extend_phase')
  })
})

// ---------------------------------------------------------------------------
// tools_update emitted on phase transitions
// ---------------------------------------------------------------------------

describe('tools_update on phase transition', () => {
  test('new active actor receives tools_update with advance', async () => {
    h = createHarness(review, { rounds: 3 })
    await h.advance('critic', 'Critique.')
    expect(h.phase).toBe('owner_turn')

    const ownerMsgs = h.actorMessages('owner')
    const toolsUpdate = ownerMsgs.find(m => m.type === 'tools_update')
    expect(toolsUpdate).toBeDefined()
    const tools = toolsUpdate!.tools as Array<{ name: string }>
    expect(tools.some(t => t.name === 'advance')).toBe(true)
  })

  test('previous actor receives tools_update without advance', async () => {
    h = createHarness(review, { rounds: 3 })
    await h.advance('critic', 'Critique.')

    const criticMsgs = h.actorMessages('critic')
    const toolsUpdate = criticMsgs.find(m => m.type === 'tools_update')
    expect(toolsUpdate).toBeDefined()
    const tools = toolsUpdate!.tools as Array<{ name: string }>
    expect(tools.some(t => t.name === 'advance')).toBe(false)
  })

  test('advance description contains verdict options for build reviewing', async () => {
    h = createHarness(build, { rounds: 3 })
    await h.advance('builder', 'Implementation.')
    expect(h.phase).toBe('reviewing')

    const criticMsgs = h.actorMessages('critic')
    const toolsUpdate = criticMsgs.find(m => m.type === 'tools_update')
    expect(toolsUpdate).toBeDefined()
    const tools = toolsUpdate!.tools as Array<{ name: string; description: string }>
    const advance = tools.find(t => t.name === 'advance')!
    expect(advance.description).toContain('approve')
    expect(advance.description).toContain('request_changes')
  })

  test('advance description for verdict:none is simple', async () => {
    h = createHarness(review, { rounds: 3 })
    await h.advance('critic', 'Critique.')
    expect(h.phase).toBe('owner_turn')

    const ownerMsgs = h.actorMessages('owner')
    const toolsUpdate = ownerMsgs.find(m => m.type === 'tools_update')!
    const tools = toolsUpdate.tools as Array<{ name: string; description: string }>
    const advance = tools.find(t => t.name === 'advance')!
    expect(advance.description).toBe('advance({ content: "..." })')
  })

  test('same-actor phase transition updates tool description', async () => {
    h = createHarness(spike, { rounds: 1 })
    expect(h.phase).toBe('exploring')

    // Checkpoint — self-loop, same actor
    await h.advance('explorer', 'Found the cache layer.')
    expect(h.phase).toBe('exploring')

    // Done — transitions to reporting, same actor
    await h.advance('explorer', 'Investigation complete.', 'done')
    expect(h.phase).toBe('reporting')

    const msgs = h.actorMessages('explorer')
    const toolsUpdates = msgs.filter(m => m.type === 'tools_update')
    const lastUpdate = toolsUpdates[toolsUpdates.length - 1]
    const tools = lastUpdate.tools as Array<{ name: string; description: string }>
    const advance = tools.find(t => t.name === 'advance')!
    // reporting phase is verdict:none
    expect(advance.description).toBe('advance({ content: "..." })')
  })
})
