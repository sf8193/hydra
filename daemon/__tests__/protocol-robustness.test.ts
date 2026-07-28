import { describe, test, expect } from 'bun:test'
import { reviewMachine, getReviewByThread, getActiveReviews } from '../adversarial.js'
import { buildMachine, getBuildByThread, getActiveBuilds } from '../build.js'
import { designMachine, getDesignByThread, getActiveDesigns } from '../design.js'

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

  test('build: implementing -> reviewing -> closing -> complete', () => {
    const r1 = buildMachine.transition('implementing', 'owner_impl')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('reviewing')

    const r2 = buildMachine.transition('reviewing', 'critic_lgtm')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('closing')

    const r3 = buildMachine.transition('closing', 'summary_posted')
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.to).toBe('complete')
  })

  test('build: feedback loops back', () => {
    const r = buildMachine.transition('reviewing', 'critic_feedback')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('implementing')
  })

  test('design: full autonomous flow', () => {
    const r1 = designMachine.transition('spawning', 'all_spawned')
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.to).toBe('questioning')

    const r2 = designMachine.transition('questioning', 'all_questions')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.to).toBe('answering')

    const r3 = designMachine.transition('answering', 'answers_provided')
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.to).toBe('independent')

    const r4 = designMachine.transition('independent', 'all_proposed')
    expect(r4.ok).toBe(true)
    if (r4.ok) expect(r4.to).toBe('synthesis')

    const r5 = designMachine.transition('synthesis', 'synthesized')
    expect(r5.ok).toBe(true)
    if (r5.ok) expect(r5.to).toBe('refinement')

    const r6 = designMachine.transition('refinement', 'refined')
    expect(r6.ok).toBe(true)
    if (r6.ok) expect(r6.to).toBe('synthesis')
  })

  test('invalid transitions rejected', () => {
    expect(reviewMachine.transition('complete', 'critic_posted').ok).toBe(false)
    expect(buildMachine.transition('complete', 'owner_impl').ok).toBe(false)
    expect(designMachine.transition('complete', 'all_spawned').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutual exclusion — uses real getXByThread lookups from production modules
// ---------------------------------------------------------------------------

describe('mutual exclusion (real module lookups)', () => {
  test('no active protocols at baseline', () => {
    expect(getReviewByThread('test-thread-mutex')).toBeUndefined()
    expect(getBuildByThread('test-thread-mutex')).toBeUndefined()
    expect(getDesignByThread('test-thread-mutex')).toBeUndefined()
  })

  test('getActiveReviews/Builds/Designs return arrays', () => {
    expect(Array.isArray(getActiveReviews())).toBe(true)
    expect(Array.isArray(getActiveBuilds())).toBe(true)
    expect(Array.isArray(getActiveDesigns())).toBe(true)
  })
})
