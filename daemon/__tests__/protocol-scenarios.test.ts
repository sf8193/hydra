import { describe, test, expect, afterEach } from 'bun:test'
import { createHarness, TestHarness, TOTAL_PHASE_CAP_FACTOR } from './test-harness.js'

// Real protocol definitions — the harness exercises them as-is
import review from '../../protocols/review.js'
import build from '../../protocols/build.js'

let h: TestHarness

afterEach(() => {
  h?.dispose()
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
    await h.reply('critic', '[critic→owner]\nYour code has a potential null dereference on line 42.')
    expect(h.phase).toBe('owner_turn')

    await h.reply('owner', '[owner→critic]\nAdded a null check. See commit abc123.')
    expect(h.phase).toBe('critic_turn')
    expect(h.round).toBe(2)

    // Round 2
    await h.reply('critic', '[critic→owner]\nThe null check is good, but the error message is unclear.')
    expect(h.phase).toBe('owner_turn')

    await h.reply('owner', '[owner→critic]\nImproved the error message with context.')
    expect(h.phase).toBe('critic_turn')
    expect(h.round).toBe(3)

    // Round 3 (final)
    await h.reply('critic', '[critic→owner]\nAll issues addressed. Clean code.')
    expect(h.phase).toBe('owner_turn')

    await h.reply('owner', '[owner→critic]\nFinal defense — all findings resolved.')
    expect(h.phase).toBe('cleanup')
    expect(h.round).toBe(3)

    // Owner posts summary to complete the run
    await h.reply('owner', '[summary]\n**Review Summary** — all 3 rounds clean.')
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

    // Deferred — still in critic_turn
    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    // Go idle. Deferral armed a NEW timeout at currentTime + windowMs.
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
    expect(notes.some(n => n.includes('[critic→owner]'))).toBe(true)

    // Thread also gets a warning status line
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

    // Extend twice in round 1
    expect(h.extend('critic', 'first', 5).ok).toBe(true)
    expect(h.extend('critic', 'second', 5).ok).toBe(true)

    // Complete round 1 → round 2
    await h.reply('critic', '[critic→owner]\nRound 1 critique.')
    await h.reply('owner', '[owner→critic]\nRound 1 defense.')
    expect(h.round).toBe(2)

    // Can extend twice again
    expect(h.extend('critic', 'third', 5).ok).toBe(true)
    expect(h.extend('critic', 'fourth', 5).ok).toBe(true)
  })
})

describe('review: total backstop', () => {
  test('fires unconditionally at 3x window regardless of activity', async () => {
    h = createHarness(review, { rounds: 3 })

    const windowMs = h.run.protocol.windowMs('critic_turn')!
    h.setTurnState('critic', 'working')

    // Total backstop at TOTAL_PHASE_CAP_FACTOR × window
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

    // 3s death-detect + grace period. Advance past both.
    const graceMs = h.run.protocol.graceMs('critic')!
    await h.tick(3_000 + graceMs + 1_000)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
  })

  test('critic reconnect within grace saves the run', async () => {
    h = createHarness(review, { rounds: 3 })

    h.disconnect('critic')
    await h.tick(5_000) // within grace
    h.reconnect('critic')

    expect(h.phase).toBe('critic_turn')
    expect(h.isTerminated).toBe(false)

    // Can still operate
    await h.reply('critic', '[critic→owner]\nBack online with critique.')
    expect(h.phase).toBe('owner_turn')
  })
})

describe('review: wrong role rejection', () => {
  test('owner decision in critic phase is rejected', async () => {
    h = createHarness(review, { rounds: 3 })

    // Review protocol has no decisions, but test that reply from wrong role is ignored
    await h.reply('owner', '[owner→critic]\nI should not post now.')
    expect(h.phase).toBe('critic_turn')
  })
})

describe('review: closing backstop completes (not cancels)', () => {
  test('closing timeout transitions to complete', async () => {
    h = createHarness(review, { rounds: 1 })

    // Play through to closing
    await h.reply('critic', '[critic→owner]\nLooks good.')
    expect(h.phase).toBe('owner_turn')

    await h.reply('owner', '[owner→critic]\nThanks.')
    expect(h.phase).toBe('cleanup')

    // Don't post summary — let backstop fire
    const closingMs = h.run.protocol.windowMs('cleanup')!
    await h.tick(closingMs)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents).toHaveLength(1)
    expect(h.completionEvents[0].outcome).toBe('complete')
  })
})

// ---------------------------------------------------------------------------
// Build protocol scenarios
// ---------------------------------------------------------------------------

describe('build: approve → closing → complete', () => {
  test('builder implements, critic approves, summary completes', async () => {
    h = createHarness(build, { rounds: 3, topic: 'add retry logic' })
    expect(h.phase).toBe('implementing')

    // Builder posts implementation
    await h.reply('builder', '[builder→critic]\nAdded retry with exponential backoff.')
    expect(h.phase).toBe('reviewing')

    // Critic approves
    const decided = await h.decide('critic', 'approve', 'Clean implementation, ships.')
    expect(decided).toBe(true)
    expect(h.phase).toBe('closing')
    expect(h.decisions.some(d => d.value === 'approve')).toBe(true)

    // Builder posts summary
    await h.reply('builder', '[summary]\n**Build Summary** — retry logic added.')
    expect(h.isTerminated).toBe(true)

    const event = h.completionEvents[0]
    expect(event.outcome).toBe('complete')
    expect(event.protocol).toBe('build')
  })
})

describe('build: request_changes loop', () => {
  test('critic requests changes, builder fixes, cycle repeats', async () => {
    h = createHarness(build, { rounds: 3 })

    // Round 1: implement → review → request_changes → back to implementing
    await h.reply('builder', '[builder→critic]\nFirst implementation.')
    expect(h.phase).toBe('reviewing')

    await h.decide('critic', 'request_changes', 'Missing error handling.')
    expect(h.phase).toBe('implementing')
    expect(h.round).toBe(2)

    // Round 2: implement again → review → request_changes
    await h.reply('builder', '[builder→critic]\nAdded error handling.')
    expect(h.phase).toBe('reviewing')

    await h.decide('critic', 'request_changes', 'Edge case in retry path.')
    expect(h.phase).toBe('implementing')
    expect(h.round).toBe(3)

    // Round 3 (final): implement → review → final round forces closing
    await h.reply('builder', '[builder→critic]\nFixed edge case.')
    expect(h.phase).toBe('reviewing')

    await h.decide('critic', 'request_changes', 'Approve reluctantly.')
    expect(h.phase).toBe('closing')
  })
})

describe('build: decision from wrong role rejected', () => {
  test('builder cannot decide during review phase', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.reply('builder', '[builder→critic]\nImplementation.')
    expect(h.phase).toBe('reviewing')

    const decided = await h.decide('builder', 'approve', 'I approve myself.')
    expect(decided).toBe(false)
    expect(h.phase).toBe('reviewing')
  })
})

describe('build: review timeout cancels', () => {
  test('critic silence during review cancels the build', async () => {
    h = createHarness(build, { rounds: 3 })

    // Builder implements
    await h.reply('builder', '[builder→critic]\nDone.')
    expect(h.phase).toBe('reviewing')

    // Advance past the review window
    await h.tick(h.run.protocol.windowMs('reviewing')!)

    expect(h.isTerminated).toBe(true)
    expect(h.completionEvents[0].outcome).toBe('cancelled')
  })
})

describe('build: reply alone in reviewing phase does not advance', () => {
  test('reviewing phase requires decide(), reply is ignored', async () => {
    h = createHarness(build, { rounds: 3 })

    await h.reply('builder', '[builder→critic]\nDone.')
    expect(h.phase).toBe('reviewing')

    // Critic posts a reply instead of calling decide — ignored
    await h.reply('critic', '[critic→builder]\nLooks ok I guess.')
    expect(h.phase).toBe('reviewing')
  })
})

// ---------------------------------------------------------------------------
// Guard rails and concurrency
// ---------------------------------------------------------------------------

describe('reentrancy guard (transitioningRuns)', () => {
  test('concurrent replies — second is dropped', async () => {
    h = createHarness(review, { rounds: 3 })

    // Fire two replies without awaiting the first. The first enters the
    // transitioningRuns guard before its first yield; the second hits the
    // guard and returns immediately.
    const p1 = h.reply('critic', '[critic→owner]\nFirst critique.')
    const p2 = h.reply('critic', '[critic→owner]\nSecond critique (dropped).')
    await Promise.all([p1, p2])

    // Only one transition: critic_turn → owner_turn
    expect(h.phase).toBe('owner_turn')
    expect(h.round).toBe(1)
  })
})

describe('double-cancel guard (cancellingRuns)', () => {
  test('simultaneous cancel paths produce only one completion event', async () => {
    h = createHarness(review, { rounds: 3 })

    // Trigger cancel from two sources simultaneously
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

    await h.reply('critic', '[critic→owner]\nCritique.')
    await h.reply('owner', '[owner→critic]\nDefense.')
    expect(h.phase).toBe('cleanup')

    // notifyOwnerSummary queues a notification to the owner
    const notes = h.actorNotifications('owner')
    expect(notes.some(n => n.includes('Post a closing summary'))).toBe(true)
    expect(notes.some(n => n.includes('[summary]'))).toBe(true)

    // Thread gets a "concluded" status line
    expect(h.threadMessages.some(m => m.text.includes('concluded'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Extension semantics
// ---------------------------------------------------------------------------

describe('review: extension is a full window reset (minutes arg is advisory)', () => {
  test('timeout fires at original window duration, not window + requested minutes', async () => {
    h = createHarness(review, { rounds: 3 })

    // onRunExtend records minutes in the decision context ("+5m") for observability,
    // but calls resetTimeout(run) which always uses protocol.windowMs(phase).
    h.extend('critic', 'reading codebase', 5)

    // Full window fires — not window + 5m
    await h.tick(h.run.protocol.windowMs('critic_turn')!)

    expect(h.phase).toBe('cancelled')
    expect(h.isTerminated).toBe(true)
  })
})
