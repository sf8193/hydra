import { describe, expect, test } from 'bun:test'
import { canNativeFork } from '../fork-strategy.js'

describe('canNativeFork', () => {
  test('allows same-engine forks with matching native history', () => {
    expect(canNativeFork('codex', 'codex', { codexThreadId: 'thr_parent' })).toBe(true)
    expect(canNativeFork('claude', 'claude', { claudeSessionId: 'claude-parent' })).toBe(true)
  })

  test('routes cross-engine requests through thread-context continuation', () => {
    expect(canNativeFork('claude', 'codex', { claudeSessionId: 'claude-parent' })).toBe(false)
    expect(canNativeFork('codex', 'claude', { codexThreadId: 'thr_parent' })).toBe(false)
  })
})
