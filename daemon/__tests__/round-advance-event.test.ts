import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { protocolEvents } from '../protocol-runner.js'
import type { RoundAdvanceEvent } from '../protocol-types.js'

describe('RoundAdvanceEvent', () => {
  let seen: RoundAdvanceEvent[]
  let handler: (e: RoundAdvanceEvent) => void

  beforeEach(() => {
    seen = []
    handler = (e) => seen.push(e)
    protocolEvents.onRoundAdvance(handler)
  })

  afterEach(() => {
    protocolEvents.offRoundAdvance(handler)
  })

  test('carries text so subscribers do not race the thread post', () => {
    protocolEvents.emitRoundAdvance({
      protocol: 'review', threadId: 't1', round: 2, totalRounds: 3, text: 'critique body',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].text).toBe('critique body')
  })

  test('text is optional — subscribers must tolerate its absence', () => {
    protocolEvents.emitRoundAdvance({
      protocol: 'review', threadId: 't1', round: 1, totalRounds: 3,
    })
    expect(seen[0].text).toBeUndefined()
  })

  test('carries the advancing role so subscribers do not assume the critic', () => {
    protocolEvents.emitRoundAdvance({
      protocol: 'review', threadId: 't1', round: 3, totalRounds: 3,
      text: 'owner defense', role: 'owner',
    })
    expect(seen[0].role).toBe('owner')
  })
})

// The factory PM relay forwards inline text only for a critic's final round.
// Encoded here because the naive predicate (round >= totalRounds) is true for
// the owner's advance in `review`, which would mislabel the owner's defense.
describe('factory PM relay predicate', () => {
  const isCriticFinal = (e: { role?: string; round: number; totalRounds: number; text?: string }) =>
    e.role === 'critic' && e.round >= e.totalRounds && !!e.text

  test('owner final-round advance is NOT forwarded as critic text', () => {
    expect(isCriticFinal({ role: 'owner', round: 3, totalRounds: 3, text: 'defense' })).toBe(false)
  })

  test('critic final-round advance with text IS forwarded', () => {
    expect(isCriticFinal({ role: 'critic', round: 3, totalRounds: 3, text: 'critique' })).toBe(true)
  })

  test('critic mid-round is not forwarded', () => {
    expect(isCriticFinal({ role: 'critic', round: 2, totalRounds: 3, text: 'critique' })).toBe(false)
  })

  test('missing text is not forwarded', () => {
    expect(isCriticFinal({ role: 'critic', round: 3, totalRounds: 3 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Which advance actually fires the event, per the review protocol's shape.
//
// review.ts phases:
//   critic_turn: on { critic_posted -> owner_turn }              (no finalAdvanceEvent)
//   owner_turn:  on { owner_posted -> critic_turn,
//                     final_round  -> cleanup }                  finalAdvanceEvent: final_round
//
// protocol-runner increments the round only when the phase we advanced FROM
// declares a finalAdvanceEvent and the event is not it. Only owner_turn
// declares one — so the counter (and this event) advances on the OWNER's
// advance, and `content` is therefore the owner's text, not the critic's.
// ---------------------------------------------------------------------------

describe('round increment predicate (mirrors protocol-runner.ts:302)', () => {
  const reviewPhases: Record<string, { finalAdvanceEvent?: string }> = {
    critic_turn: {},
    owner_turn: { finalAdvanceEvent: 'final_round' },
    cleanup: {},
  }

  const advances = (fromPhase: string, event: string) => {
    const def = reviewPhases[fromPhase]
    return !!(def?.finalAdvanceEvent && event !== def.finalAdvanceEvent)
  }

  test('critic advancing does NOT increment the round', () => {
    expect(advances('critic_turn', 'critic_posted')).toBe(false)
  })

  test('owner defending DOES increment the round', () => {
    expect(advances('owner_turn', 'owner_posted')).toBe(true)
  })

  test('owner closing out does NOT increment', () => {
    expect(advances('owner_turn', 'final_round')).toBe(false)
  })
})
