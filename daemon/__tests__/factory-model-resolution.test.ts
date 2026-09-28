import { describe, test, expect, beforeEach } from 'bun:test'
import { resolveModels } from '../factory.js'

// Suppress stderr noise from imports
process.stderr.write = (() => true) as any

describe('resolveModels', () => {
  describe('happy path — no overrides', () => {
    test('easy: returns ladder defaults, no warning', () => {
      const { builder, reviewer, warning } = resolveModels('easy')
      expect(builder).toBe('claude-opus-4-6[1m]')
      expect(reviewer).toBe('claude-opus-4-8[1m]')
      expect(warning).toBeUndefined()
    })

    test('medium: returns ladder defaults', () => {
      const { builder, reviewer, warning } = resolveModels('medium')
      expect(builder).toBe('claude-opus-4-8[1m]')
      expect(reviewer).toBe('claude-opus-4-6[1m]')
      expect(warning).toBeUndefined()
    })

    test('hard: returns ladder defaults', () => {
      const { builder, reviewer, warning } = resolveModels('hard')
      expect(builder).toBe('claude-opus-5[1m]')
      expect(reviewer).toBe('claude-fable-5-1[1m]')
      expect(warning).toBeUndefined()
    })
  })

  describe('explicit overrides', () => {
    test('builder override only: uses override + ladder reviewer', () => {
      const { builder, reviewer, warning } = resolveModels('easy', 'fable')
      expect(builder).toBe('claude-fable-5-1[1m]')
      expect(reviewer).toBe('claude-opus-4-8[1m]')  // easy ladder reviewer
      expect(warning).toBeUndefined()
    })

    test('reviewer override only: uses ladder builder + override', () => {
      const { builder, reviewer, warning } = resolveModels('easy', undefined, 'opus-5')
      expect(builder).toBe('claude-opus-4-6[1m]')  // easy ladder builder
      expect(reviewer).toBe('claude-opus-5[1m]')
      expect(warning).toBeUndefined()
    })

    test('both overrides: uses both', () => {
      const { builder, reviewer, warning } = resolveModels('easy', 'fable', 'opus-5')
      expect(builder).toBe('claude-fable-5-1[1m]')
      expect(reviewer).toBe('claude-opus-5[1m]')
      expect(warning).toBeUndefined()
    })

    test('alias resolved to full model ID', () => {
      const { builder } = resolveModels('easy', 'opus-4-8')
      expect(builder).toBe('claude-opus-4-8[1m]')
    })

    test('alias "opus" resolves to opus-5-5', () => {
      const { builder } = resolveModels('easy', 'opus')
      expect(builder).toBe('claude-opus-5-5[1m]')
    })
  })

  describe('unknown model fallback', () => {
    test('unknown builder model: falls back to ladder builder with warning', () => {
      const { builder, warning } = resolveModels('easy', 'gpt-9000')
      expect(builder).toBe('claude-opus-4-6[1m]')  // easy ladder builder
      expect(warning).toBeTruthy()
      expect(warning).toContain('Unknown builder model')
      expect(warning).toContain('gpt-9000')
    })

    test('unknown reviewer model: falls back to ladder reviewer with warning', () => {
      const { reviewer, warning } = resolveModels('easy', undefined, 'gpt-9000')
      expect(reviewer).toBe('claude-opus-4-8[1m]')  // easy ladder reviewer
      expect(warning).toBeTruthy()
      expect(warning).toContain('Unknown reviewer model')
    })

    test('both unknown: both fall back to ladder defaults', () => {
      const { builder, reviewer, warning } = resolveModels('easy', 'fake-builder', 'fake-reviewer')
      expect(builder).toBe('claude-opus-4-6[1m]')
      expect(reviewer).toBe('claude-opus-4-8[1m]')
      expect(warning).toContain('Unknown builder model')
      expect(warning).toContain('Unknown reviewer model')
    })
  })

  describe('collision resolution', () => {
    test('collision where ladder reviewer differs: uses ladder reviewer', () => {
      // Force builder and reviewer to same known model (different from ladder.reviewer)
      // easy ladder reviewer is opus-4-8, so force builder=fable, reviewer=fable
      // ladder.reviewer for easy is opus-4-8 which differs → uses ladder reviewer
      const { builder, reviewer, warning } = resolveModels('easy', 'fable', 'fable')
      expect(builder).toBe('claude-fable-5-1[1m]')
      expect(reviewer).toBe('claude-opus-4-8[1m]')  // easy ladder reviewer
      expect(warning).toBeTruthy()
      expect(warning).toContain('Builder and reviewer both resolved to claude-fable-5-1')
    })

    test('collision where ladder reviewer also same: uses FALLBACK_REVIEWERS', () => {
      // easy ladder: builder=opus-4-6, reviewer=opus-4-8
      // Force both to opus-4-8 → collision → ladder.reviewer is also opus-4-8 → FALLBACK_REVIEWERS
      // FALLBACK_REVIEWERS['claude-opus-4-8'] = 'claude-opus-4-6[1m]'
      const { builder, reviewer, warning } = resolveModels('easy', 'opus-4-8', 'opus-4-8')
      expect(builder).toBe('claude-opus-4-8[1m]')
      expect(reviewer).toBe('claude-opus-4-6[1m]')
      expect(warning).toBeTruthy()
      expect(warning).toContain('claude-opus-4-8')
    })

    test('collision with fable on hard: FALLBACK_REVIEWERS gives opus-5', () => {
      // hard ladder: builder=opus-5, reviewer=fable-5
      // Force builder=fable, reviewer=fable → collision → ladder.reviewer(fable-5) also same → FALLBACK_REVIEWERS
      const { builder, reviewer, warning } = resolveModels('hard', 'fable', 'fable')
      expect(builder).toBe('claude-fable-5-1[1m]')
      // FALLBACK_REVIEWERS['claude-fable-5-1'] = 'claude-opus-5[1m]'
      expect(reviewer).toBe('claude-opus-5[1m]')
      expect(warning).toBeTruthy()
    })
  })

  describe('no collision when different versions of same family', () => {
    test('opus-5-5 builder vs opus-4-8 reviewer: no collision (different IDs)', () => {
      const { builder, reviewer, warning } = resolveModels('easy', 'opus', 'opus-4-8')
      expect(builder).toBe('claude-opus-5-5[1m]')
      expect(reviewer).toBe('claude-opus-4-8[1m]')
      expect(warning).toBeUndefined()
    })
  })
})
