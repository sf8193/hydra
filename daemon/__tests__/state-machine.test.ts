import { describe, test, expect } from 'bun:test'
import { createStateMachine } from '../state-machine.js'

// Suppress stderr logging during tests
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// Generic state machine tests
// ---------------------------------------------------------------------------

type TestPhase = 'a' | 'b' | 'c' | 'done'
type TestEvent = 'go' | 'back' | 'finish'

describe('createStateMachine (generic)', () => {
  const sm = createStateMachine<TestPhase, TestEvent>('test', {
    a:    { go: 'b' },
    b:    { go: 'c', back: 'a' },
    c:    { finish: 'done' },
    done: {},
  })

  test('valid transition returns ok', () => {
    const r = sm.transition('a', 'go')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.from).toBe('a')
      expect(r.to).toBe('b')
    }
  })

  test('invalid event returns not ok', () => {
    const r = sm.transition('a', 'finish')
    expect(r.ok).toBe(false)
  })

  test('terminal state rejects all events', () => {
    expect(sm.transition('done', 'go').ok).toBe(false)
    expect(sm.transition('done', 'back').ok).toBe(false)
    expect(sm.transition('done', 'finish').ok).toBe(false)
  })

  test('canTransition mirrors transition', () => {
    expect(sm.canTransition('a', 'go')).toBe(true)
    expect(sm.canTransition('a', 'finish')).toBe(false)
    expect(sm.canTransition('b', 'back')).toBe(true)
    expect(sm.canTransition('done', 'go')).toBe(false)
  })

  test('validEvents lists all events for a phase', () => {
    expect(sm.validEvents('b').sort()).toEqual(['back', 'go'])
    expect(sm.validEvents('done')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Build-specific transition table tests
// ---------------------------------------------------------------------------

type BuildPhase = 'implementing' | 'reviewing' | 'complete' | 'cancelled'
type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_feedback' | 'timeout' | 'cancel'

const buildTransitions = {
  implementing: { owner_impl: 'reviewing' as BuildPhase, timeout: 'cancelled' as BuildPhase, cancel: 'cancelled' as BuildPhase },
  reviewing:    { critic_lgtm: 'complete' as BuildPhase, critic_feedback: 'implementing' as BuildPhase, timeout: 'cancelled' as BuildPhase, cancel: 'cancelled' as BuildPhase },
  complete:     {} as Partial<Record<BuildEvent, BuildPhase>>,
  cancelled:    {} as Partial<Record<BuildEvent, BuildPhase>>,
}

describe('build transition table', () => {
  const sm = createStateMachine<BuildPhase, BuildEvent>('build', buildTransitions)

  test('full lifecycle: implement → feedback → implement → lgtm', () => {
    let phase: BuildPhase = 'implementing'

    // Owner posts implementation
    let r = sm.transition(phase, 'owner_impl')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('reviewing')

    // Critic gives feedback
    r = sm.transition(phase, 'critic_feedback')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('implementing')

    // Owner posts revised implementation
    r = sm.transition(phase, 'owner_impl')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('reviewing')

    // Critic approves
    r = sm.transition(phase, 'critic_lgtm')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('complete')
  })

  test('owner cannot post during reviewing', () => {
    expect(sm.transition('reviewing', 'owner_impl').ok).toBe(false)
  })

  test('critic cannot review during implementing', () => {
    expect(sm.transition('implementing', 'critic_lgtm').ok).toBe(false)
    expect(sm.transition('implementing', 'critic_feedback').ok).toBe(false)
  })

  test('timeout cancels from any active phase', () => {
    for (const phase of ['implementing', 'reviewing'] as BuildPhase[]) {
      const r = sm.transition(phase, 'timeout')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })

  test('cancel from any active phase', () => {
    for (const phase of ['implementing', 'reviewing'] as BuildPhase[]) {
      const r = sm.transition(phase, 'cancel')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })

  test('complete and cancelled are terminal', () => {
    for (const phase of ['complete', 'cancelled'] as BuildPhase[]) {
      for (const event of ['owner_impl', 'critic_lgtm', 'critic_feedback', 'timeout', 'cancel'] as BuildEvent[]) {
        expect(sm.transition(phase, event).ok).toBe(false)
      }
    }
  })

  test('direct lgtm on first round', () => {
    let phase: BuildPhase = 'implementing'
    let r = sm.transition(phase, 'owner_impl')
    if (r.ok) phase = r.to
    r = sm.transition(phase, 'critic_lgtm')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('complete')
  })

  test('transition result includes from phase', () => {
    const r = sm.transition('implementing', 'owner_impl')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.from).toBe('implementing')
      expect(r.to).toBe('reviewing')
    }
  })

  test('failed transition result includes from phase and reason', () => {
    const r = sm.transition('implementing', 'critic_lgtm')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.from).toBe('implementing')
      expect(r.reason).toContain('critic_lgtm')
      expect(r.reason).toContain('implementing')
    }
  })

  test('5-round build: feedback loop then timeout', () => {
    let phase: BuildPhase = 'implementing'
    for (let i = 0; i < 4; i++) {
      let r = sm.transition(phase, 'owner_impl')
      expect(r.ok).toBe(true)
      if (r.ok) phase = r.to

      r = sm.transition(phase, 'critic_feedback')
      expect(r.ok).toBe(true)
      if (r.ok) phase = r.to
      expect(phase).toBe('implementing')
    }
    // 5th round: owner implements, then times out during review
    let r = sm.transition(phase, 'owner_impl')
    if (r.ok) phase = r.to
    r = sm.transition(phase, 'timeout')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// Review-specific transition table tests
// ---------------------------------------------------------------------------

type ReviewPhase = 'critic_turn' | 'owner_turn' | 'post_pass' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'pass_posted' | 'summary_posted' | 'timeout' | 'cancel'

const reviewTransitions = {
  critic_turn: { critic_posted: 'owner_turn' as ReviewPhase, timeout: 'cancelled' as ReviewPhase, cancel: 'cancelled' as ReviewPhase },
  owner_turn:  { owner_posted: 'critic_turn' as ReviewPhase, final_round: 'post_pass' as ReviewPhase, timeout: 'cancelled' as ReviewPhase, cancel: 'cancelled' as ReviewPhase },
  post_pass:   { pass_posted: 'post_pass' as ReviewPhase, summary_posted: 'complete' as ReviewPhase, timeout: 'cleanup' as ReviewPhase, cancel: 'cancelled' as ReviewPhase },
  cleanup:     { summary_posted: 'complete' as ReviewPhase, timeout: 'complete' as ReviewPhase },
  complete:    {} as Partial<Record<ReviewEvent, ReviewPhase>>,
  cancelled:   {} as Partial<Record<ReviewEvent, ReviewPhase>>,
}

describe('review transition table', () => {
  const sm = createStateMachine<ReviewPhase, ReviewEvent>('review', reviewTransitions)

  test('full 3-round review lifecycle', () => {
    let phase: ReviewPhase = 'critic_turn'

    // Round 1: critic posts, owner defends
    let r = sm.transition(phase, 'critic_posted')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('owner_turn')

    r = sm.transition(phase, 'owner_posted')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('critic_turn')

    // Round 2: critic posts, owner defends
    r = sm.transition(phase, 'critic_posted')
    if (r.ok) phase = r.to
    r = sm.transition(phase, 'owner_posted')
    if (r.ok) phase = r.to
    expect(phase).toBe('critic_turn')

    // Round 3: critic posts, owner defends (final round)
    r = sm.transition(phase, 'critic_posted')
    if (r.ok) phase = r.to
    r = sm.transition(phase, 'final_round')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('post_pass')

    // Post-pass timeout falls through to cleanup, then summary completes
    r = sm.transition(phase, 'timeout')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('cleanup')

    // Summary posted
    r = sm.transition(phase, 'summary_posted')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('complete')
  })

  test('final_round only valid during owner_turn', () => {
    expect(sm.transition('critic_turn', 'final_round').ok).toBe(false)
    expect(sm.transition('cleanup', 'final_round').ok).toBe(false)
    expect(sm.transition('owner_turn', 'final_round').ok).toBe(true)
  })

  test('summary_posted valid during cleanup and post_pass', () => {
    expect(sm.transition('critic_turn', 'summary_posted').ok).toBe(false)
    expect(sm.transition('owner_turn', 'summary_posted').ok).toBe(false)
    expect(sm.transition('cleanup', 'summary_posted').ok).toBe(true)
    expect(sm.transition('post_pass', 'summary_posted').ok).toBe(true)
  })

  test('cleanup timeout goes to complete (not cancelled)', () => {
    const r = sm.transition('cleanup', 'timeout')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('complete')
  })

  test('owner cannot post during critic turn', () => {
    expect(sm.transition('critic_turn', 'owner_posted').ok).toBe(false)
    expect(sm.transition('critic_turn', 'final_round').ok).toBe(false)
  })

  test('critic cannot post during owner turn', () => {
    expect(sm.transition('owner_turn', 'critic_posted').ok).toBe(false)
  })

  test('timeout cancels from active debate phases', () => {
    for (const phase of ['critic_turn', 'owner_turn'] as ReviewPhase[]) {
      const r = sm.transition(phase, 'timeout')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.to).toBe('cancelled')
    }
  })

  test('complete and cancelled are terminal', () => {
    for (const phase of ['complete', 'cancelled'] as ReviewPhase[]) {
      for (const event of ['critic_posted', 'owner_posted', 'final_round', 'pass_posted', 'summary_posted', 'timeout', 'cancel'] as ReviewEvent[]) {
        expect(sm.transition(phase, event).ok).toBe(false)
      }
    }
  })

  test('1-round review: critic posts, owner defends (final), post_pass, complete', () => {
    let phase: ReviewPhase = 'critic_turn'
    let r = sm.transition(phase, 'critic_posted')
    if (r.ok) phase = r.to
    // Only 1 round — this is the final round
    r = sm.transition(phase, 'final_round')
    expect(r.ok).toBe(true)
    if (r.ok) phase = r.to
    expect(phase).toBe('post_pass')
    // No passes configured — timeout to cleanup
    r = sm.transition(phase, 'timeout')
    if (r.ok) phase = r.to
    expect(phase).toBe('cleanup')
    r = sm.transition(phase, 'summary_posted')
    if (r.ok) phase = r.to
    expect(phase).toBe('complete')
  })

  test('post_pass: pass_posted stays in post_pass (for multiple passes)', () => {
    let phase: ReviewPhase = 'post_pass'
    const r = sm.transition(phase, 'pass_posted')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.to).toBe('post_pass')
  })
})

// ---------------------------------------------------------------------------
// Sentinel detection tests
// ---------------------------------------------------------------------------

describe('sentinel detection', () => {
  const BUILDER_SENTINEL = '[builder→critic]'
  const CRITIC_SENTINEL = '[critic→builder]'

  test('builder sentinel detected on first line', () => {
    const text = '[builder→critic]\n**Implementation summary**\nDetails...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith(BUILDER_SENTINEL)).toBe(true)
  })

  test('builder sentinel not detected in conversational message', () => {
    const text = 'Hey, I have a question about the design...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith(BUILDER_SENTINEL)).toBe(false)
  })

  test('critic sentinel with LGTM', () => {
    const text = '[critic→builder]\n**LGTM**\nAll good.'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith(CRITIC_SENTINEL)).toBe(true)
    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
    const secondLine = bodyText.split('\n')[0].trim()
    expect(secondLine).toBe('**LGTM**')
  })

  test('critic sentinel with findings', () => {
    const text = '[critic→builder]\n**Should-fix (2 findings)**\nS1: ...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith(CRITIC_SENTINEL)).toBe(true)
    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
    const secondLine = bodyText.split('\n')[0].trim()
    expect(secondLine).not.toBe('**LGTM**')
  })

  test('critic conversational message ignored', () => {
    const text = 'I need more context on the design decision...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith(CRITIC_SENTINEL)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Design-specific transition table tests (imports production machine)
// ---------------------------------------------------------------------------

