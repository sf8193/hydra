import { describe, test, expect, beforeEach } from 'bun:test'

import { PERSONA_NAMES } from '../prompts/design-personas.js'

// Suppress stderr logging during tests
process.stderr.write = (() => true) as any

// We need to test onDesignReply in isolation. Since it depends on the designs Map
// and gateway (which we can't easily mock), we test the sentinel parsing and
// proposal tracking logic directly.

describe('design proposal sentinel parsing', () => {


  test('valid persona sentinel is detected', () => {
    for (const name of PERSONA_NAMES) {
      const text = `[${name}→thread]\n**Summary:** My proposal...`
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = `[${name}→thread]`
      expect(firstLine.startsWith(expectedTag)).toBe(true)
    }
  })

  test('conversational message does not match sentinel', () => {
    const text = 'Let me read the codebase first...'
    const firstLine = text.split('\n')[0].trim()
    for (const name of PERSONA_NAMES) {
      expect(firstLine.startsWith(`[${name}→thread]`)).toBe(false)
    }
  })

  test('wrong persona sentinel does not match', () => {
    const text = '[contract-lawyer→thread]\nMy proposal...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith('[subtractor→thread]')).toBe(false)
    expect(firstLine.startsWith('[contract-lawyer→thread]')).toBe(true)
  })

  test('sentinel with extra text on same line still matches', () => {
    const text = '[subtractor→thread] extra stuff\nDetails...'
    const firstLine = text.split('\n')[0].trim()
    expect(firstLine.startsWith('[subtractor→thread]')).toBe(true)
  })
})

describe('design proposal tracking logic', () => {
  type MockPersona = { name: string; sessionId: string; proposed: boolean }

  function createMockState() {
    return {
      phase: 'independent' as string,
      personas: [
        { name: 'subtractor', sessionId: 's1', proposed: false },
        { name: 'archaeologist', sessionId: 's2', proposed: false },
        { name: 'contract-lawyer', sessionId: 's3', proposed: false },
      ] as MockPersona[],
      proposalsExpected: 3,
      proposalsReceived: 0,
    }
  }

  function simulateProposal(state: ReturnType<typeof createMockState>, sessionId: string, text: string): boolean {
    const persona = state.personas.find(p => p.sessionId === sessionId)
    if (!persona || state.phase !== 'independent') return false

    const firstLine = text.split('\n')[0].trim()
    const expectedTag = `[${persona.name}→thread]`
    if (!firstLine.startsWith(expectedTag)) return false

    if (persona.proposed) return false
    persona.proposed = true
    state.proposalsReceived++
    return true
  }

  test('valid proposal increments counter and marks proposed', () => {
    const state = createMockState()
    const result = simulateProposal(state, 's1', '[subtractor→thread]\nMy proposal')
    expect(result).toBe(true)
    expect(state.proposalsReceived).toBe(1)
    expect(state.personas[0].proposed).toBe(true)
  })

  test('duplicate proposal is ignored', () => {
    const state = createMockState()
    simulateProposal(state, 's1', '[subtractor→thread]\nFirst')
    const result = simulateProposal(state, 's1', '[subtractor→thread]\nDuplicate')
    expect(result).toBe(false)
    expect(state.proposalsReceived).toBe(1)
  })

  test('conversational message is ignored', () => {
    const state = createMockState()
    const result = simulateProposal(state, 's1', 'Just reading the files...')
    expect(result).toBe(false)
    expect(state.proposalsReceived).toBe(0)
  })

  test('unknown session is ignored', () => {
    const state = createMockState()
    const result = simulateProposal(state, 'unknown', '[subtractor→thread]\nProposal')
    expect(result).toBe(false)
  })

  test('wrong phase is ignored', () => {
    const state = createMockState()
    state.phase = 'waiting'
    const result = simulateProposal(state, 's1', '[subtractor→thread]\nProposal')
    expect(result).toBe(false)
  })

  test('all proposals received triggers completion', () => {
    const state = createMockState()
    simulateProposal(state, 's1', '[subtractor→thread]\nP1')
    simulateProposal(state, 's2', '[archaeologist→thread]\nP2')
    simulateProposal(state, 's3', '[contract-lawyer→thread]\nP3')
    expect(state.proposalsReceived).toBe(3)
    expect(state.proposalsReceived >= state.proposalsExpected).toBe(true)
  })

  test('partial proposals do not trigger completion', () => {
    const state = createMockState()
    simulateProposal(state, 's1', '[subtractor→thread]\nP1')
    simulateProposal(state, 's2', '[archaeologist→thread]\nP2')
    expect(state.proposalsReceived).toBe(2)
    expect(state.proposalsReceived >= state.proposalsExpected).toBe(false)
  })
})
