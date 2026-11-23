import { test, expect } from 'bun:test'
import { deliverVia, outcomeOf } from '../../app/targets.js'
import { clearIdempotency } from '../../infra/idempotency.js'
import { deliverWord } from '../../shared/exit-codes.js'

test('a rejection the engine marks retryable lands as deferred (exit 5), so a caller retries it (#782)', () => {
  const l = outcomeOf({ status: 'rejected', retryable: true, reason: 'turn is busy' }, false)
  expect(l).toMatchObject({ ok: false, exit: 5 })
  expect((l as { reason: string }).reason).toContain('turn is busy')
  expect(deliverWord(5, (l as { reason: string }).reason)).toBe('deferred')
})

test('a rejection that cannot clear is exit 3', () => {
  const l = outcomeOf({ status: 'rejected', retryable: false, reason: 'session is retiring' }, false)
  expect(l).toEqual({ ok: false, exit: 3, reason: 'delivery rejected: session is retiring' })
})

test('a permanent non-retryable rejection carries its permanent kind so connectors never resend it', () => {
  const l = outcomeOf({ status: 'rejected', retryable: false, permanent: 'unconfirmed', reason: 'already pasted' }, false)
  expect(l).toEqual({ ok: false, exit: 3, reason: 'delivery rejected: already pasted', permanent: 'unconfirmed' })
})

test('unknown still exits 6', () => {
  expect(outcomeOf({ status: 'unknown', reason: 'timeout' }, false)).toMatchObject({ ok: false, exit: 6 })
})

test('deliverVia retains the idempotency key on an unconfirmed refusal so a retry never pastes twice', async () => {
  const key = `test-unconfirmed-${Date.now()}`
  let calls = 0
  try {
    const first = await deliverVia(async () => {
      calls++
      return { ok: false, exit: 3, reason: 'already pasted', permanent: 'unconfirmed' }
    }, 'hi', { initiator: 'test', idempotencyKey: key })
    expect(first).toMatchObject({ ok: false, exit: 3, permanent: 'unconfirmed' })
    const second = await deliverVia(async () => {
      calls++
      return { ok: true, status: 'delivered', revived: false, sessionId: 's', sessionName: 's', threadId: '' }
    }, 'hi', { initiator: 'test', idempotencyKey: key })
    expect(calls).toBe(1)
    expect(second).toMatchObject({ ok: false, exit: 3, permanent: 'unconfirmed' })
  } finally {
    clearIdempotency(key)
  }
})
