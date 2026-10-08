import { describe, test, expect } from 'bun:test'
import { shouldNotifyCiChange, shouldNotifyGreen, type CheckStatusType } from '../daemon/pr-watch.js'

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

describe('shouldNotifyGreen — opt-in edge trigger, once per head commit', () => {
  const ok = (headSha: string) => ({ status: 'success' as CheckStatusType, headSha })
  const cases: Array<[string, { notifyGreen?: boolean; greenAnnouncedSha?: string }, { status: CheckStatusType; headSha: string } | null, boolean]> = [
    ['not opted in: never', {}, ok(SHA_A), false],
    ['opted out explicitly: never', { notifyGreen: false }, ok(SHA_A), false],
    ['first success on a head: announce', { notifyGreen: true }, ok(SHA_A), true],
    ['already green at opt-in (nothing announced yet): announce once', { notifyGreen: true, greenAnnouncedSha: undefined }, ok(SHA_A), true],
    ['same sha already announced: repeat poll is silent', { notifyGreen: true, greenAnnouncedSha: SHA_A }, ok(SHA_A), false],
    ['restart with persisted greenAnnouncedSha: silent', JSON.parse(JSON.stringify({ notifyGreen: true, greenAnnouncedSha: SHA_A })), ok(SHA_A), false],
    ['new push goes green: announce again', { notifyGreen: true, greenAnnouncedSha: SHA_A }, ok(SHA_B), true],
    ['pending: never', { notifyGreen: true }, { status: 'pending', headSha: SHA_A }, false],
    ['failure: never', { notifyGreen: true }, { status: 'failure', headSha: SHA_A }, false],
    ['unknown (no checks): never', { notifyGreen: true }, { status: 'unknown', headSha: SHA_A }, false],
    ['null fetch (API failure/partial): hold', { notifyGreen: true }, null, false],
    ['success with empty sha: never', { notifyGreen: true }, ok(''), false],
  ]
  for (const [label, entry, check, expected] of cases) {
    test(label, () => { expect(shouldNotifyGreen(entry, check)).toBe(expected) })
  }

  test('failure→success on the same head announces (failure never set greenAnnouncedSha)', () => {
    const entry = { notifyGreen: true } as { notifyGreen: boolean; greenAnnouncedSha?: string }
    expect(shouldNotifyGreen(entry, { status: 'failure', headSha: SHA_A })).toBe(false)
    expect(shouldNotifyGreen(entry, ok(SHA_A))).toBe(true)
  })
})
