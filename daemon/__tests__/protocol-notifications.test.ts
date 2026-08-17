import { describe, test, expect, afterEach } from 'bun:test'
import { TestHarness } from './test-harness.js'
import review from '../../protocols/review.js'
import { protocol } from '../protocol-dsl.js'

let h: TestHarness

afterEach(() => { h?.dispose() })

function createHarness(...args: ConstructorParameters<typeof TestHarness>) {
  h = new TestHarness(...args)
  return h
}

describe('protocol notifications: onExit (cancelled)', () => {
  test('owner receives bridge notification on cancel', async () => {
    h = createHarness(review, { rounds: 3 })
    await h.cancel('critic disconnected')
    const notes = h.actorNotifications('owner')
    expect(notes.some(n => n.includes('cancelled'))).toBe(true)
  })

  test('onExit override receives outcome and reason', async () => {
    const custom = protocol('test-exit', {
      emoji: '🧪',
      display: 'Test',
      roles: { critic: 'Critic', owner: 'Owner' },
      owner: 'owner',
      cancelPhase: 'cancelled',
      phases: {
        critic_turn: { actor: 'critic', on: { posted: 'owner_turn', cancel: 'cancelled' }, advanceEvent: 'posted' },
        owner_turn: { actor: 'owner', on: { posted: 'critic_turn', cancel: 'cancelled' }, advanceEvent: 'posted' },
        cancelled: { actor: 'owner', on: {} },
      },
      windows: { critic_turn: '5m', owner_turn: '5m' },
      notifications: {
        onExit: (run, outcome, reason) => `[custom] ${outcome} at round ${run.currentRound}: ${reason ?? 'n/a'}`,
      },
    })
    h = createHarness(custom, { rounds: 3 })
    await h.cancel('test reason')
    const notes = h.actorNotifications('owner')
    expect(notes.some(n => n.includes('[custom] cancelled at round 1: test reason'))).toBe(true)
  })
})

describe('protocol notifications: onPhaseChange', () => {
  test('idle participant receives phase change notification on transition', async () => {
    h = createHarness(review, { rounds: 3 })
    await h.advance('critic', 'Round 1 critique.')

    await h.advance('owner', 'Round 1 defense.')
    const criticNotes = h.actorNotifications('critic')
    const criticPhaseNote = criticNotes.find(n => n.includes('[Adversarial Review —') && n.includes('owner') && n.includes('is working.'))
    expect(criticPhaseNote).toBeDefined()
  })
})

describe('protocol notifications: onKickoff', () => {
  test('review protocol initial actor is critic, not owner', () => {
    h = createHarness(review, { rounds: 3 })
    expect(review.notifications.onKickoff).toBeDefined()
    expect(review.phases[review.initialPhase].actor).toBe('critic')
    expect(review.ownerRole).toBe('owner')
  })
})

describe('protocol notifications: onDisconnect', () => {
  test('owner receives notification when non-owner disconnects', async () => {
    h = createHarness(review, { rounds: 3 })
    h.disconnect('critic')
    await h.tick(3_500)
    const ownerNotes = h.actorNotifications('owner')
    expect(ownerNotes.some(n => n.includes('disconnected'))).toBe(true)
  })
})
