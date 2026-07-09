import { describe, test, expect } from 'bun:test'
import { formatStateLine, formatRoundBadge } from '../anchor-state.js'

describe('formatStateLine', () => {
  test('▼ with defending (owner turn = bottom of inning)', () => {
    expect(formatStateLine('⚔️', 'review', formatRoundBadge('', 'bottom', 1, 3), '🟦 pixel (The Owner) is defending...'))
      .toBe('> **⚔️ REVIEW ¹▼₃** — 🟦 pixel (The Owner) is defending...')
  })

  test('▲ with attacking (critic turn = top of inning)', () => {
    expect(formatStateLine('⚔️', 'review', formatRoundBadge('', 'top', 2, 3), '🔥 ember (The Critic) is attacking...'))
      .toBe('> **⚔️ REVIEW ²▲₃** — 🔥 ember (The Critic) is attacking...')
  })

  test('no position renders without gap', () => {
    expect(formatStateLine('🔨', 'build', '', 'critic is reviewing...'))
      .toBe('> **🔨 BUILD** — critic is reviewing...')
  })
})
