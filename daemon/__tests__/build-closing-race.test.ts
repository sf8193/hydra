import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { BuildState } from '../build.js'
import { onBuildReply, __test } from '../build.js'
import { transport } from '../bridge-transport.js'

process.stderr.write = (() => true) as any

const { builds, sessionToBuild, ownerToBuild, threadToBuild } = __test

function createBuild(overrides: Partial<BuildState> = {}): BuildState {
  const state: BuildState = {
    buildId: 'race-test-build',
    ownerThreadId: 'race-test-thread',
    ownerSessionId: 'race-test-owner',
    task: 'test task',
    rounds: 3,
    currentRound: 3,
    phase: 'reviewing',
    messageIds: [],
    ...overrides,
  }
  builds.set(state.buildId, state)
  threadToBuild.set(state.ownerThreadId, state.buildId)
  ownerToBuild.set(state.ownerSessionId, state.buildId)
  if (state.criticSessionId) sessionToBuild.set(state.criticSessionId, state.buildId)
  return state
}

afterEach(() => {
  for (const [id, state] of builds) {
    if (state.timeout) clearTimeout(state.timeout)
    if (state._heartbeat) clearInterval(state._heartbeat)
  }
  builds.clear()
  sessionToBuild.clear()
  ownerToBuild.clear()
  threadToBuild.clear()
  transport.messageQueues.delete('race-test-owner')
})

describe('build closing race — _closing set before async gap', () => {
  test('_closing is set synchronously when critic posts LGTM', () => {
    const state = createBuild({ criticSessionId: 'race-test-critic' })

    onBuildReply('race-test-critic', '[critic→builder]\n**LGTM**\nGreat work.', 'race-test-thread', ['msg-c'])

    expect(state.phase).toBe('closing')
    expect(state._closing).toBeDefined()
    expect(state._closing!.approved).toBe(true)
    expect(state._closing!.lastCriticText).toBe('**LGTM**\nGreat work.')
  })

  test('_closing is set synchronously on max-rounds final (not LGTM)', () => {
    const state = createBuild({ criticSessionId: 'race-test-critic' })

    onBuildReply('race-test-critic', '[critic→builder]\nNeeds more work.\nStill has issues.', 'race-test-thread', ['msg-c'])

    expect(state.phase).toBe('closing')
    expect(state._closing).toBeDefined()
    expect(state._closing!.approved).toBe(false)
    expect(state._closing!.lastCriticText).toBe('Needs more work.\nStill has issues.')
  })

  test('owner [summary] during killSession await preserves verdict (not defaulted to true)', () => {
    // The race: critic hits max rounds (NOT lgtm) → closing.
    // requestBuildSummary awaits killSession (async gap).
    // Owner posts [summary] before killSession completes.
    // Bug (pre-fix): _closing was undefined → ?? true → silently approved.
    // Fix: _closing is set synchronously → correct verdict preserved.
    const state = createBuild({ criticSessionId: 'race-test-critic' })

    // Critic's final feedback at max rounds → phase = closing
    onBuildReply('race-test-critic', '[critic→builder]\nStill broken.\nFix the edge case.', 'race-test-thread', ['msg-c'])
    expect(state.phase).toBe('closing')

    // Owner posts [summary] while requestBuildSummary is still running
    onBuildReply('race-test-owner', '[summary]\nBuilt the thing.', 'race-test-thread', ['msg-o'])

    // Build should be complete with approved=false (NOT defaulted to true)
    expect(state.phase).toBe('complete')

    // Verify the queued completion message says "Max rounds", not "Critic approved"
    const queued = transport.messageQueues.get('race-test-owner') ?? []
    const completionMsg = queued.find((m: any) =>
      typeof m.content === 'string' && m.content.includes('Build complete'))
    expect(completionMsg).toBeDefined()
    expect((completionMsg as any).content).toContain('Max rounds reached')
    expect((completionMsg as any).content).not.toContain('Critic approved')
  })

  test('LGTM verdict preserved through the race window', () => {
    const state = createBuild({ criticSessionId: 'race-test-critic', currentRound: 1, rounds: 3 })

    // Critic LGTM → closing
    onBuildReply('race-test-critic', '[critic→builder]\n**LGTM**\nShip it.', 'race-test-thread', ['msg-c'])
    expect(state.phase).toBe('closing')

    // Owner posts [summary] while requestBuildSummary is still running
    onBuildReply('race-test-owner', '[summary]\nShipped.', 'race-test-thread', ['msg-o'])
    expect(state.phase).toBe('complete')

    const queued = transport.messageQueues.get('race-test-owner') ?? []
    const completionMsg = queued.find((m: any) =>
      typeof m.content === 'string' && m.content.includes('Build complete'))
    expect(completionMsg).toBeDefined()
    expect((completionMsg as any).content).toContain('Critic approved')
  })
})
