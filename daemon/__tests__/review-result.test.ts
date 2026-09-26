import { describe, expect, test } from 'bun:test'
import { reviewResult } from '../review-result.js'
import type { CompletionEvent } from '../protocol-types.js'

function event(terminalPhase: string, verdicts: string[], via: CompletionEvent['via'] = 'normal'): CompletionEvent {
  return {
    protocol: 'review', threadId: 't', rounds: { completed: verdicts.length, requested: 10 },
    outcome: 'complete', terminalPhase, via, durationMs: 1,
    decisions: verdicts.map(value => ({ phase: 'critic_turn', role: 'critic', value, because: value })),
  }
}

describe('review result', () => {
  test('only a final critic approval is approved', () => {
    expect(reviewResult(event('complete', ['approve']))).toBe('approved')
    expect(reviewResult(event('complete', ['request_changes', 'approve_with_changes', 'approve']))).toBe('approved_after_changes')
    expect(reviewResult(event('complete', ['request_changes']))).toBe('unknown')
  })

  test('terminal unresolved overrides conditional verdict and owner unable', () => {
    expect(reviewResult(event('unresolved', ['approve_with_changes']))).toBe('unresolved')
    expect(reviewResult(event('unresolved', ['request_changes']))).toBe('unresolved')
  })

  test('owner-run fallback never claims independent approval', () => {
    expect(reviewResult(event('complete', [], 'fallback'))).toBe('owner_run')
    expect(reviewResult(event('complete', [], 'direct'))).toBe('owner_run')
    expect(reviewResult(event('complete', ['approve_with_changes'], 'fallback'))).toBe('unresolved')
    expect(reviewResult(event('complete', ['request_changes'], 'fallback'))).toBe('unresolved')
  })

  test('malformed completion cannot impersonate approval', () => {
    expect(reviewResult({ ...event('complete', ['approve']), via: undefined })).toBe('unknown')
    expect(reviewResult({ ...event('complete', ['approve']), terminalPhase: undefined })).toBe('unknown')
    expect(reviewResult({ ...event('complete', ['approve']), terminalPhase: 'cancelled' })).toBe('unknown')
  })
})
