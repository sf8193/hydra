import { describe, test, expect } from 'bun:test'
import { shouldNotifyCiChange, shouldPiggyback, type CheckStatusType } from '../daemon/pr-watch.js'

const SHA_A = 'aaaa'
const SHA_B = 'bbbb'

describe('shouldNotifyCiChange — same SHA transitions', () => {
  const cases: Array<[CheckStatusType, CheckStatusType, boolean, string]> = [
    ['unknown', 'pending',  false, 'unknown→pending: no notification (still settling)'],
    ['unknown', 'success',  false, 'unknown→success: no notification (not a failure)'],
    ['unknown', 'failure',  true,  'unknown→failure: MUST notify'],
    ['unknown', 'unknown',  false, 'unknown→unknown: no change'],
    ['pending', 'pending',  false, 'pending→pending: no change'],
    ['pending', 'success',  false, 'pending→success: no notification (not a failure)'],
    ['pending', 'failure',  true,  'pending→failure: notify (CI failed)'],
    ['pending', 'unknown',  false, 'pending→unknown: no notification'],
    ['success', 'success',  false, 'success→success: no change'],
    ['success', 'failure',  true,  'success→failure: notify (regression)'],
    ['success', 'pending',  false, 'success→pending: no notification (new push settling)'],
    ['success', 'unknown',  false, 'success→unknown: no notification'],
    ['failure', 'failure',  false, 'failure→failure: no change'],
    ['failure', 'success',  false, 'failure→success: no notification (not a failure)'],
    ['failure', 'pending',  false, 'failure→pending: no notification (retrying)'],
    ['failure', 'unknown',  false, 'failure→unknown: no notification'],
  ]

  for (const [last, next, expected, label] of cases) {
    test(label, () => {
      expect(shouldNotifyCiChange(last, SHA_A, next, SHA_A)).toBe(expected)
    })
  }
})

describe('shouldNotifyCiChange — new SHA (force push / new commit)', () => {
  test('new SHA + failure: always notify (even from unknown)', () => {
    for (const last of ['unknown', 'pending', 'success', 'failure'] as CheckStatusType[]) {
      expect(shouldNotifyCiChange(last, SHA_A, 'failure', SHA_B)).toBe(true)
    }
  })

  test('new SHA + success: never notify (not a failure)', () => {
    for (const last of ['unknown', 'pending', 'success', 'failure'] as CheckStatusType[]) {
      expect(shouldNotifyCiChange(last, SHA_A, 'success', SHA_B)).toBe(false)
    }
  })

  test('new SHA + pending: no notification', () => {
    for (const last of ['unknown', 'pending', 'success', 'failure'] as CheckStatusType[]) {
      expect(shouldNotifyCiChange(last, SHA_A, 'pending', SHA_B)).toBe(false)
    }
  })
})

describe('shouldPiggyback', () => {
  const codexAdapter = { deliveryIsFree: false }
  const claudeAdapter = { deliveryIsFree: true }

  test('codex session with a turn in flight: piggyback', () => {
    expect(shouldPiggyback({ adapter: codexAdapter as any, turnState: 'working' })).toBe(true)
  })

  test('codex session idle, even if lastActive was seconds ago: never piggyback', () => {
    // Regression: a session that just finished a turn must not be treated as
    // "still active" — there's no other turn coming to ride along with.
    expect(shouldPiggyback({ adapter: codexAdapter as any, turnState: 'idle' })).toBe(false)
    expect(shouldPiggyback({ adapter: codexAdapter as any, turnState: 'waiting' })).toBe(false)
    expect(shouldPiggyback({ adapter: codexAdapter as any, turnState: undefined })).toBe(false)
  })

  test('claude session: never piggyback, even mid-turn (delivery is already free)', () => {
    expect(shouldPiggyback({ adapter: claudeAdapter as any, turnState: 'working' })).toBe(false)
  })

  test('no session / no adapter: never piggyback', () => {
    expect(shouldPiggyback(undefined)).toBe(false)
    expect(shouldPiggyback({ adapter: undefined, turnState: 'working' })).toBe(false)
  })
})
