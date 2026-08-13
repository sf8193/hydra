import { describe, test, expect } from 'bun:test'

// Suppress stderr noise from imports
process.stderr.write = (() => true) as any

import { clampSummary } from '../factory.js'

describe('clampSummary', () => {
  test('returns text unchanged when within the limit', () => {
    expect(clampSummary('short summary', 300)).toBe('short summary')
  })

  test('boundary: text exactly at the limit is unchanged', () => {
    const exact = 'y'.repeat(200)
    expect(clampSummary(exact, 200)).toBe(exact)
  })

  test('truncates and appends an ellipsis when over the limit', () => {
    const long = 'x'.repeat(400)
    const out = clampSummary(long, 300)
    expect(out).toBe('x'.repeat(300) + '…')
    expect(out.startsWith('x'.repeat(300))).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  test('accept (300) and abandon (200) budgets clamp independently', () => {
    const summary = 'z'.repeat(500)
    expect(clampSummary(summary, 300).length).toBe(301) // 300 chars + ellipsis
    expect(clampSummary(summary, 200).length).toBe(201) // 200 chars + ellipsis
  })
})
