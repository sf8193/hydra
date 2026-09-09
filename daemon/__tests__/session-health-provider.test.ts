import { describe, expect, test } from 'bun:test'
import { maintainInteractiveSurface } from '../session-health.js'

describe('provider-aware session health', () => {
  test('asks the provider to repair even when tmux is absent', () => {
    let calls = 0
    const repaired = maintainInteractiveSurface({
      sessionId: 'sid', tmuxName: 'drift', engine: 'codex', codexThreadId: 'thread-1',
    } as any, () => { calls++; return true })

    expect(repaired).toBe(true)
    expect(calls).toBe(1)
  })

  test('does not repair records already classified dead', () => {
    let calls = 0
    const repaired = maintainInteractiveSurface({ deadAt: 1 } as any, () => { calls++; return true })
    expect(repaired).toBe(false)
    expect(calls).toBe(0)
  })
})
