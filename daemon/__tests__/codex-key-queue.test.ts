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
    const errors: string[] = []
    for (let i = 0; i < 25; i++) {
      queueCodexKeys(sessionId, { target: 'flint:hydra-chat', mode: 'literal', text: String(i) }, err => {
        if (err) errors.push(err.message)
      })
    }
    expect(queuedCodexKeyCount(sessionId)).toBe(20)
    expect(errors).toHaveLength(5)
    expect(errors.every(message => message === 'key action evicted because the queue is full')).toBe(true)
    clearCodexKeys(sessionId)
  })

  test('settles pending actions when the session disconnects', () => {
    const sessionId = 'key-queue-clear'
    const errors: string[] = []
    queueCodexKeys(sessionId, { target: 'flint:hydra-chat', mode: 'raw', keys: ['Enter'] }, err => {
      if (err) errors.push(err.message)
    })
    clearCodexKeys(sessionId)
    expect(queuedCodexKeyCount(sessionId)).toBe(0)
    expect(errors).toEqual(['key action cancelled because the session disconnected'])
  })
})
