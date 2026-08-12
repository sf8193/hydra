import { describe, test, expect } from 'bun:test'
import { mechanicsBlock } from '../prompts/mechanics.js'

const mech = { threadId: 't', sessionId: 's' }

describe('mechanicsBlock — pool roles must supply orient', () => {
  test('per-phase cadence without orient throws', () => {
    expect(() => mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a->b]', cadence: 'per-phase' })).toThrow('requires an orient')
  })
})
