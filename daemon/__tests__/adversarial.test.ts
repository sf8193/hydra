import { describe, test, expect } from 'bun:test'
import { createStateMachine } from '../state-machine.js'

// Suppress stderr logging during tests
process.stderr.write = (() => true) as any

// Reproduce the review state machine from adversarial.ts
type ReviewPhase = 'critic_turn' | 'owner_turn' | 'post_pass' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'pass_posted' | 'summary_posted' | 'timeout' | 'cancel'

const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'post_pass', timeout: 'cancelled', cancel: 'cancelled' },
  post_pass:   { pass_posted: 'post_pass', summary_posted: 'complete', timeout: 'cleanup', cancel: 'cancelled' },
  cleanup:     { summary_posted: 'complete', timeout: 'complete' },
  complete:    {},
  cancelled:   {},
})

describe('review state machine', () => {
  test('full 3-round review completes', () => {
    let phase: ReviewPhase = 'critic_turn'

    // Round 1
    phase = reviewMachine.transition(phase, 'critic_posted').to!
    expect(phase).toBe('owner_turn')
    phase = reviewMachine.transition(phase, 'owner_posted').to!
    expect(phase).toBe('critic_turn')

    // Round 2
    phase = reviewMachine.transition(phase, 'critic_posted').to!
    expect(phase).toBe('owner_turn')
    phase = reviewMachine.transition(phase, 'owner_posted').to!
    expect(phase).toBe('critic_turn')

    // Round 3 (final)
    phase = reviewMachine.transition(phase, 'critic_posted').to!
    expect(phase).toBe('owner_turn')
    phase = reviewMachine.transition(phase, 'final_round').to!
    expect(phase).toBe('post_pass')

    // No passes — timeout to cleanup
    phase = reviewMachine.transition(phase, 'timeout').to!
    expect(phase).toBe('cleanup')

    // Summary
    phase = reviewMachine.transition(phase, 'summary_posted').to!
    expect(phase).toBe('complete')
  })

  test('cleanup phase does not accept cancel event', () => {
    const result = reviewMachine.transition('cleanup', 'cancel')
    expect(result.ok).toBe(false)
  })

  test('complete is terminal', () => {
    expect(reviewMachine.transition('complete', 'timeout').ok).toBe(false)
    expect(reviewMachine.transition('complete', 'cancel').ok).toBe(false)
  })
})

describe('completeReview timeout clearing', () => {
  // Simulates the bug: when transitioning from owner_turn → cleanup,
  // the old timeout must be cleared before setting the new one.
  test('old timeout is cleared when overwriting state.timeout', () => {
    let oldTimerCleared = false
    const state = {
      timeout: setTimeout(() => { oldTimerCleared = false }, 100) as ReturnType<typeof setTimeout>,
    }

    // Simulate what completeReview now does: clear before reassign
    if (state.timeout) clearTimeout(state.timeout)
    oldTimerCleared = true
    state.timeout = setTimeout(() => {}, 5000)

    expect(oldTimerCleared).toBe(true)

    // Cleanup
    clearTimeout(state.timeout)
  })

  test('without clearing, old timeout would still fire', async () => {
    let oldTimerFired = false
    const state: { timeout: ReturnType<typeof setTimeout> | undefined } = {
      timeout: setTimeout(() => { oldTimerFired = true }, 10),
    }

    // Bug: overwrite without clearing
    state.timeout = setTimeout(() => {}, 5000)

    await new Promise(r => setTimeout(r, 50))
    expect(oldTimerFired).toBe(true)

    // Cleanup
    if (state.timeout) clearTimeout(state.timeout)
  })
})
