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
