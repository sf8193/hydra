import { describe, expect, test } from 'bun:test'
import { planReactionReconciliation } from '../reaction-reconcile.js'

describe('planReactionReconciliation', () => {
  test('does nothing when the desired bot reaction is already present', () => {
    expect(planReactionReconciliation([{ emoji: '🪨', mine: true }], ['🪨'])).toEqual({ remove: [], add: [] })
  })

  test('replaces only stale bot reactions', () => {
    expect(planReactionReconciliation([
      { emoji: '💥', mine: true },
      { emoji: '🙂', mine: false },
    ], ['🪨'])).toEqual({ remove: ['💥'], add: ['🪨'] })
  })

  test('reconciles the optional respawn counter independently', () => {
    expect(planReactionReconciliation([
      { emoji: '🪨', mine: true },
      { emoji: '1️⃣', mine: true },
    ], ['🪨', '2️⃣'])).toEqual({ remove: ['1️⃣'], add: ['2️⃣'] })
  })
})
