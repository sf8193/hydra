import { describe, test, expect } from 'bun:test'
import { reviewSummaryFormat } from '../prompts/review-summary.js'

describe('reviewSummaryFormat', () => {
  test('keeps the disposition checklist intact', () => {
    const out = reviewSummaryFormat(3).join('\n')
    expect(out).toContain('- ✅ issue — fixed/will fix')
    expect(out).toContain('- ⚠️ issue — acknowledged, deferred')
    expect(out).toContain('- ❌ issue — rebutted')
  })

  test('includes all five sections in order', () => {
    const out = reviewSummaryFormat(1).join('\n')
    const positions = ['rebutted', 'Tensions', 'Emergences', 'Synthesis', "What's next"].map(s => out.indexOf(s))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  test('round count pluralizes', () => {
    expect(reviewSummaryFormat(1)[0]).toBe('**⚔️ Review Summary** (1 round)')
    expect(reviewSummaryFormat(3)[0]).toBe('**⚔️ Review Summary** (3 rounds)')
  })

  test('no configuration surface: format is a pure function of rounds', () => {
    expect(reviewSummaryFormat(2)).toEqual(reviewSummaryFormat(2))
  })
})
