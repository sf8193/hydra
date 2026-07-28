import { describe, test, expect } from 'bun:test'

import { mechanicsBlock } from '../prompts/mechanics.js'

const mech = { sessionId: 'sid-1', tmuxName: 'hydra-x', threadId: 't1' }

describe('mechanicsBlock — cadence rendering', () => {
  test('cadence renders per option', () => {
    const one = mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'one-message' })
    const round = mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'per-round' })
    const phase = mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'per-phase', orient: 'Read X first.' })
    expect(one).toContain('Post exactly ONE protocol message.')
    expect(round).toContain('One protocol message per round.')
    expect(phase).toContain('Exactly ONE protocol message per phase.')
  })
})

describe('mechanicsBlock — pool roles must supply orient', () => {
  test('per-phase cadence without orient throws', () => {
    expect(() => mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a→b]', cadence: 'per-phase' })).toThrow('requires an orient')
  })
})
