import { describe, test, expect } from 'bun:test'
import { reviewSummaryFormat } from '../prompts/review-summary.js'

describe('reviewSummaryFormat', () => {
  test('sections in order: synthesis → round arc → dispositions → meaning', () => {
    const out = reviewSummaryFormat(3).join('\n')
    const positions = ['Synthesis', 'Round 1', 'Round 2', 'Round 3', 'Dispositions', 'Tensions', 'What Emerged', "What's next"].map(s => out.indexOf(s))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  test('disposition checklist intact', () => {
    const out = reviewSummaryFormat(1).join('\n')
    expect(out).toContain('- ✅ issue — fixed/will fix')
    expect(out).toContain('- ⚠️ issue — acknowledged, deferred')
    expect(out).toContain('- ❌ issue — rebutted')
  })

  test('round count pluralizes', () => {
    expect(reviewSummaryFormat(1)[0]).toBe('**⚔️ Review Summary** (1 round)')
    expect(reviewSummaryFormat(3)[0]).toBe('**⚔️ Review Summary** (3 rounds)')
  })

  test('multi-round generates per-round arc lines', () => {
    const out = reviewSummaryFormat(3).join('\n')
    expect(out).toContain('Round 1')
    expect(out).toContain('Round 2')
    expect(out).toContain('Round 3')
  })
})
