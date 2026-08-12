import { describe, test, expect } from 'bun:test'
import { reviewMachine, getReviewByThread, getActiveReviews } from '../adversarial.js'

process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// State machine transition tests — uses the REAL machines from production
// ---------------------------------------------------------------------------

describe('state machine transitions', () => {
  test('review: critic_turn -> owner_turn -> post_pass -> cleanup -> complete', () => {
    const r1 = reviewMachine.transition('critic_turn', 'critic_posted')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('owner_turn')

    const r2 = reviewMachine.transition('owner_turn', 'final_round')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('post_pass')

    // No passes — timeout to cleanup
    const r2b = reviewMachine.transition('post_pass', 'timeout')
    expect(r2b.ok).toBe(true)
    if (r2b.ok) expect(r2b.to).toBe('cleanup')

    const r3 = reviewMachine.transition('cleanup', 'summary_posted')
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.to).toBe('complete')
  })

  test('review: cancel from any active phase', () => {
    for (const phase of ['critic_turn', 'owner_turn'] as const) {
      const r = reviewMachine.transition(phase, 'cancel')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })




  test('invalid transitions rejected', () => {
    expect(reviewMachine.transition('complete', 'critic_posted').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutual exclusion — uses real getXByThread lookups from production modules
// ---------------------------------------------------------------------------

describe('mutual exclusion (real module lookups)', () => {
  test('no active protocols at baseline', () => {
    expect(getReviewByThread('test-thread-mutex')).toBeUndefined()
  })

  test('getActiveReviews/Builds/Designs return arrays', () => {
    expect(Array.isArray(getActiveReviews())).toBe(true)
  })
})
