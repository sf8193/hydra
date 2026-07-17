import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { BuildState } from '../build.js'
import { onBuildReply, onBuildDecision, __test } from '../build.js'
import { transport } from '../bridge-transport.js'

let origStderrWrite: typeof process.stderr.write

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})

afterEach(() => {
  process.stderr.write = origStderrWrite
  if (!__test) return
  const { builds, sessionToBuild, ownerToBuild, threadToBuild } = __test
  for (const [, state] of builds) {
    if (state.timeout) clearTimeout(state.timeout)
    if (state._heartbeat) clearInterval(state._heartbeat)
  }
  builds.clear()
  sessionToBuild.clear()
  ownerToBuild.clear()
  threadToBuild.clear()
  transport.messageQueues.clear()
})

if (!__test) throw new Error('build.__test is only available under NODE_ENV=test')
const { builds, sessionToBuild, ownerToBuild, threadToBuild } = __test

function createBuild(overrides: Partial<BuildState> = {}): BuildState {
  const state: BuildState = {
    buildId: 'decide-test-build',
    ownerThreadId: 'decide-test-thread',
    ownerSessionId: 'decide-test-owner',
    task: 'test task',
    rounds: 3,
    currentRound: 1,
    phase: 'reviewing',
    messageIds: [],
    criticSessionId: 'decide-test-critic',
    ...overrides,
  }
  builds.set(state.buildId, state)
  threadToBuild.set(state.ownerThreadId, state.buildId)
  ownerToBuild.set(state.ownerSessionId, state.buildId)
  if (state.criticSessionId) sessionToBuild.set(state.criticSessionId, state.buildId)
  return state
}

describe('decide() tool — build protocol', () => {
  test('approve via decide() transitions to closing', () => {
    const state = createBuild()

    onBuildDecision('decide-test-critic', 'approve', 'Ship it — implementation is correct.')

    expect(state.phase).toBe('closing')
    expect(state._closing).toBeDefined()
    expect(state._closing!.approved).toBe(true)
    expect(state._closing!.lastCriticText).toBe('Ship it — implementation is correct.')
  })

  test('request_changes via decide() with rounds remaining loops back', () => {
    const state = createBuild({ currentRound: 1, rounds: 3 })

    onBuildDecision('decide-test-critic', 'request_changes', 'Fix the edge case on line 42.')

    expect(state.phase).toBe('implementing')
    expect(state.currentRound).toBe(2)
  })

  test('request_changes at max rounds transitions to closing (final)', () => {
    const state = createBuild({ currentRound: 3, rounds: 3 })

    onBuildDecision('decide-test-critic', 'request_changes', 'Still broken after 3 rounds.')

    expect(state.phase).toBe('closing')
    expect(state._closing).toBeDefined()
    expect(state._closing!.approved).toBe(false)
  })

  test('approve records the verdict in _closing before async work starts', () => {
    const state = createBuild()

    onBuildDecision('decide-test-critic', 'approve', 'Clean implementation.')

    expect(state._closing).toBeDefined()
    expect(state._closing!.approved).toBe(true)
    expect(state._closing!.lastCriticText).toBe('Clean implementation.')
  })

  test('unknown value is rejected (no transition)', () => {
    const state = createBuild()

    onBuildDecision('decide-test-critic', 'maybe', 'Not sure.')

    expect(state.phase).toBe('reviewing')
  })

  test('decide() from non-critic is ignored', () => {
    const state = createBuild()

    onBuildDecision('decide-test-owner', 'approve', 'I approve my own code.')

    expect(state.phase).toBe('reviewing')
  })

  test('decide() in wrong phase is ignored', () => {
    const state = createBuild({ phase: 'implementing' })

    onBuildDecision('decide-test-critic', 'approve', 'Approving during implementation.')

    expect(state.phase).toBe('implementing')
  })

  test('legacy string-match path still works alongside decide()', () => {
    const state = createBuild()

    onBuildReply('decide-test-critic', '[critic→builder]\n**LGTM**\nShip it.', 'decide-test-thread', ['msg-1'])

    expect(state.phase).toBe('closing')
    expect(state._closing!.approved).toBe(true)
  })
})
