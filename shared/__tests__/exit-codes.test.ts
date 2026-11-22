import { describe, test, expect } from 'bun:test'
import { DELIVER_WORD, EX_TEMPFAIL, STUCK_PREFIX, deliverWord } from '../exit-codes.js'

describe('the deliver exit-to-word table', () => {
  test('it names a word for every code 0-8, and no other', () => {
    expect(Object.keys(DELIVER_WORD).map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    for (let code = 0; code <= 8; code++) expect(['done', 'failed', 'deferred']).toContain(deliverWord(code))
  })

  test('0 and 2 are done (2: the key had already landed); 5 and 7 are deferred; everything else failed', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(c => deliverWord(c))).toEqual(['done', 'failed', 'done', 'failed', 'failed', 'deferred', 'failed', 'deferred', 'failed'])
  })

  test('a session stuck on a dialog is exit 5 and failed: waiting does not clear it', () => {
    expect(deliverWord(5, `${STUCK_PREFIX} unknown_dialog`)).toBe('failed')
    expect(deliverWord(5, 'x is still booting')).toBe('deferred')
    expect(deliverWord(7, `${STUCK_PREFIX} x`)).toBe('deferred')   // only exit 5 reads the prefix
  })

  test('a code outside 0-8 is failed, and 75 is the scripts\' deferred, not a deliver code', () => {
    expect(deliverWord(9)).toBe('failed')
    expect(deliverWord(EX_TEMPFAIL)).toBe('failed')
    expect(EX_TEMPFAIL).toBe(75)
  })
})
