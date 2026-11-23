import { describe, expect, test } from 'bun:test'
import { lineCount, violations } from '../../scripts/check-file-size.js'

const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `export const x${i} = ${i}`).join('\n') + '\n'

describe('scripts/check-file-size.ts', () => {
  test('lineCount handles empty, trailing newline, and non-trailing newline consistently with wc -l', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\nb')).toBe(2)
  })

  test('passes files at or under maxLines and skips tests/scripts/mod', () => {
    const res = violations([
      { path: 'app/small.ts', text: makeLines(800) },
      { path: 'app/__tests__/huge.test.ts', text: makeLines(2000) },
      { path: 'scripts/big.ts', text: makeLines(2000) },
      { path: 'mod/hooks/big.ts', text: makeLines(2000) },
    ], {}, 800, 50)
    expect(res).toEqual([])
  })

  test('fails an unlisted production file exceeding maxLines', () => {
    const res = violations([{ path: 'app/too-big.ts', text: makeLines(801) }], {}, 800, 50)
    expect(res).toHaveLength(1)
    expect(res[0]).toContain('app/too-big.ts: 801 lines (max 800)')
  })

  test('enforces cap, auto-removes entries <= maxLines, tightens caps on >= 50-line shrinks, and flags deleted files', () => {
    const allowed = {
      'app/ok.ts': 1000,
      'app/grew.ts': 1000,
      'app/fixed.ts': 1000,
      'app/shrank.ts': 1000,
      'app/gone.ts': 900,
    }
    const res = violations([
      { path: 'app/ok.ts', text: makeLines(970) },       // within tolerance (30 < 50)
      { path: 'app/grew.ts', text: makeLines(1001) },    // grew past cap
      { path: 'app/fixed.ts', text: makeLines(800) },    // <= maxLines: must remove from ALLOWED
      { path: 'app/shrank.ts', text: makeLines(950) },   // shrank by 50: must lower cap
    ], allowed, 800, 50)

    expect(res).toHaveLength(4)
    expect(res.some(v => v.includes('app/grew.ts: 1001 lines (cap 1000)'))).toBe(true)
    expect(res.some(v => v.includes('app/fixed.ts: 800 lines (<= 800) — delete this entry'))).toBe(true)
    expect(res.some(v => v.includes('app/shrank.ts: 950 lines (cap is 1000) — lower the cap'))).toBe(true)
    expect(res.some(v => v.includes('app/gone.ts: file no longer exists'))).toBe(true)
  })
})
