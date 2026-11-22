import { describe, test, expect, beforeEach } from 'bun:test'
import { checkIdempotency, registerIdempotency, updateIdempotency, clearIdempotency, getIdempotencyEntry, listIdempotencyEntries } from '../../infra/idempotency.js'

// Note: these tests operate on the live idempotency registry.
// We use unique keys per test to avoid cross-test interference.

const PREFIX = `test-${Date.now()}-`

describe('idempotency', () => {
  test('checkIdempotency returns not blocked for unknown key', () => {
    const result = checkIdempotency(`${PREFIX}unknown`)
    expect(result.blocked).toBe(false)
  })

  test('registerIdempotency then check returns blocked', () => {
    const key = `${PREFIX}register-then-check`
    registerIdempotency(key, 'session-1')
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.entry.sessionId).toBe('session-1')
      expect(result.entry.status).toBe('spawned')
    }
  })

  test('failed status allows re-spawn', () => {
    const key = `${PREFIX}failed-allows-respawn`
    registerIdempotency(key, 'session-2')
    updateIdempotency(key, { status: 'failed' })
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(false)
  })

  test('completed status blocks re-spawn', () => {
    const key = `${PREFIX}completed-blocks`
    registerIdempotency(key, 'session-3')
    updateIdempotency(key, { status: 'completed' })
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(true)
  })

  test('timed_out status allows re-spawn', () => {
    const key = `${PREFIX}timed-out-allows`
    registerIdempotency(key, 'session-4')
    updateIdempotency(key, { status: 'timed_out' })
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(false)
  })

  test('getIdempotencyEntry returns entry', () => {
    const key = `${PREFIX}get-entry`
    registerIdempotency(key, 'session-5')
    const entry = getIdempotencyEntry(key)
    expect(entry).toBeDefined()
    expect(entry!.key).toBe(key)
    expect(entry!.sessionId).toBe('session-5')
  })

  test('getIdempotencyEntry returns undefined for unknown key', () => {
    const entry = getIdempotencyEntry(`${PREFIX}nonexistent`)
    expect(entry).toBeUndefined()
  })

  test('listIdempotencyEntries includes registered entries', () => {
    const key = `${PREFIX}list-test`
    registerIdempotency(key, 'session-6')
    const entries = listIdempotencyEntries()
    const found = entries.find(e => e.key === key)
    expect(found).toBeDefined()
  })

  test('clearIdempotency removes entry', () => {
    const key = `${PREFIX}clear-test`
    registerIdempotency(key, 'session-8')
    expect(clearIdempotency(key)).toBe(true)
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(false)
  })

  test('clearIdempotency returns false for unknown key', () => {
    expect(clearIdempotency(`${PREFIX}no-such-key`)).toBe(false)
  })

  test('expired entries are pruned on check', async () => {
    const key = `${PREFIX}expired`
    registerIdempotency(key, 'session-7', 1) // 1ms TTL
    await Bun.sleep(5)
    const result = checkIdempotency(key)
    expect(result.blocked).toBe(false)
  })
})
