import { describe, test, expect } from 'bun:test'
import { shouldNotifyCiChange, type CheckStatusType } from '../daemon/pr-watch.js'

const SHA_A = 'aaaa'
const SHA_B = 'bbbb'

describe('shouldNotifyCiChange — same SHA transitions', () => {
  const cases: Array<[CheckStatusType, CheckStatusType, boolean, string]> = [
    ['unknown', 'pending',  false, 'unknown→pending: no notification (still settling)'],
    ['unknown', 'success',  false, 'unknown→success: suppressed (phantom prevention)'],
    ['unknown', 'failure',  true,  'unknown→failure: MUST notify'],
    ['unknown', 'unknown',  false, 'unknown→unknown: no change'],
    ['pending', 'pending',  false, 'pending→pending: no change'],
    ['pending', 'success',  true,  'pending→success: notify (CI passed)'],
    ['pending', 'failure',  true,  'pending→failure: notify (CI failed)'],
    ['pending', 'unknown',  false, 'pending→unknown: no notification'],
    ['success', 'success',  false, 'success→success: no change'],
    ['success', 'failure',  true,  'success→failure: notify (regression)'],
    ['success', 'pending',  false, 'success→pending: no notification (new push settling)'],
    ['success', 'unknown',  false, 'success→unknown: no notification'],
    ['failure', 'failure',  false, 'failure→failure: no change'],
    ['failure', 'success',  true,  'failure→success: notify (fixed)'],
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

  test('new SHA + success from non-unknown: notify', () => {
    expect(shouldNotifyCiChange('failure', SHA_A, 'success', SHA_B)).toBe(true)
    expect(shouldNotifyCiChange('pending', SHA_A, 'success', SHA_B)).toBe(true)
    expect(shouldNotifyCiChange('success', SHA_A, 'success', SHA_B)).toBe(false)
  })

  test('new SHA + success from unknown: suppressed (phantom prevention)', () => {
    expect(shouldNotifyCiChange('unknown', SHA_A, 'success', SHA_B)).toBe(false)
  })

  test('new SHA + pending: no notification', () => {
    for (const last of ['unknown', 'pending', 'success', 'failure'] as CheckStatusType[]) {
      expect(shouldNotifyCiChange(last, SHA_A, 'pending', SHA_B)).toBe(false)
    }
  })
})
