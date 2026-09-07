import { describe, test, expect } from 'bun:test'
import { getRunByThread, getActiveRuns } from '../protocol-runner.js'

process.stderr.write = (() => true) as any

const review = (await import('../../protocols/review.js')).default

// ---------------------------------------------------------------------------
// State machine transition tests — uses the REAL v2 review protocol machine.
// V1's adversarial.ts is gone; the DSL protocol is now the source of truth.
// (review.machine is typed <string, string> by the DSL, so no casts are needed
// and none add type safety — the transitions below are guarded at runtime.)
// ---------------------------------------------------------------------------

describe('review state machine transitions (v2 DSL)', () => {
  test('review: critic_turn -> owner_turn -> cleanup -> complete', () => {
    const r1 = review.machine.transition('critic_turn', 'critic_posted')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('owner_turn')

    // v2 removed post_pass — final_round goes straight to cleanup.
    const r2 = review.machine.transition('owner_turn', 'final_round')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('cleanup')

    const r3 = review.machine.transition('cleanup', 'summary_posted')
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.to).toBe('complete')
  })

  test('review: cancel from any active phase', () => {
    for (const phase of ['critic_turn', 'owner_turn'] as const) {
      const r = review.machine.transition(phase, 'cancel')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })

  test('invalid transitions rejected', () => {
    expect(review.machine.transition('complete', 'critic_posted').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutual exclusion — uses real getRunByThread/getActiveRuns from production
// ---------------------------------------------------------------------------

describe('mutual exclusion (real module lookups)', () => {
  test('no active protocol run at baseline', () => {
    expect(getRunByThread('test-thread-mutex')).toBeUndefined()
  })

  test('getActiveRuns returns an array', () => {
    expect(Array.isArray(getActiveRuns())).toBe(true)
  })
})
