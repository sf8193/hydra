import { describe, test, expect } from 'bun:test'
import { mechanicsBlock } from '../prompts/mechanics.js'

const mech = { threadId: 't', sessionId: 's' }

describe('mechanicsBlock — pool roles must supply orient', () => {
  test('per-phase cadence without orient throws', () => {
    expect(() => mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a->b]', cadence: 'per-phase' })).toThrow('requires an orient')
  })
})

test('between-round instructions end the model turn but preserve the session', () => {
  const text = mechanicsBlock({ ...mech, role: 'critic', protocol: 'review', cadence: 'once', waits: true })
  expect(text).toContain('finish that model turn and return to idle')
  expect(text).toContain('keep the session running')
  expect(text).toContain('Do not poll the thread, hold the current turn open with idle tool calls, or exit the session')
})
