import { describe, test, expect } from 'bun:test'
import { mechanicsBlock } from '../prompts/mechanics.js'

const mech = { threadId: 't', sessionId: 's', tmuxName: 'm' }

describe('mechanicsBlock — pool roles must supply orient', () => {
  test('per-phase cadence without orient throws', () => {
    expect(() => mechanicsBlock({ ...mech, role: 'r', protocol: 'p', tag: '[a->b]', cadence: 'per-phase' })).toThrow('requires an orient')
  })

  test('waiting participants distinguish ending a Codex turn from exiting the session', () => {
    const prompt = mechanicsBlock({ ...mech, role: 'critic', protocol: 'review', cadence: 'per-round', waits: true })
    expect(prompt).toContain('after handing off with advance() (or a tagged protocol reply), end your turn immediately')
    expect(prompt).toContain('notification only says another actor is working')
    expect(prompt).toContain('Never use sleep, polling, or a wait loop')
    expect(prompt).toContain('**Between rounds (Claude only):**')
    expect(prompt).not.toContain('**Between rounds:**')
  })

  test('Codex lifecycle instructions also cover roles without between-round waits', () => {
    const prompt = mechanicsBlock({ ...mech, role: 'owner', protocol: 'review', cadence: 'per-round' })
    expect(prompt).toContain('**Codex turn lifecycle:**')
    expect(prompt).not.toContain('stay idle and wait')
  })
})
