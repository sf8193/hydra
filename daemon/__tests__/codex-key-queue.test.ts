import { describe, expect, test } from 'bun:test'
import { clearCodexKeys, queueCodexKeys, queuedCodexKeyCount } from '../codex-key-queue.js'

describe('codex key queue', () => {
  test('queues actions in order and reports their positions', () => {
    const sessionId = 'key-queue-order'
    clearCodexKeys(sessionId)
    expect(queueCodexKeys(sessionId, { target: 'flint:hydra-chat', mode: 'raw', keys: ['End'] })).toBe(1)
    expect(queueCodexKeys(sessionId, { target: 'flint:hydra-chat', mode: 'literal', text: '/permissions' })).toBe(2)
    expect(queuedCodexKeyCount(sessionId)).toBe(2)
    clearCodexKeys(sessionId)
  })

  test('caps the queue by dropping the oldest action', () => {
    const sessionId = 'key-queue-cap'
    clearCodexKeys(sessionId)
    for (let i = 0; i < 25; i++) {
      queueCodexKeys(sessionId, { target: 'flint:hydra-chat', mode: 'literal', text: String(i) })
    }
    expect(queuedCodexKeyCount(sessionId)).toBe(20)
    clearCodexKeys(sessionId)
  })
})
