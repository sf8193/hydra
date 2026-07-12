import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { BuildState } from '../build.js'
import { onBuildReply, __test } from '../build.js'
import { transport } from '../bridge-transport.js'

if (!__test) throw new Error('build.__test is only available under NODE_ENV=test')
const { builds, sessionToBuild, ownerToBuild, threadToBuild } = __test

let origStderrWrite: typeof process.stderr.write

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})

afterEach(() => {
  process.stderr.write = origStderrWrite
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

type CompletionMsg = { content: string } & Record<string, unknown>

function findCompletionMsg(sessionId: string): CompletionMsg | undefined {
  const queued = transport.messageQueues.get(sessionId) ?? []
  return queued.find((m): m is CompletionMsg =>
    typeof m.content === 'string' && m.content.includes('Build complete'))
}

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
    const state = createBuild({ criticSessionId: 'race-test-critic' })

    onBuildReply('race-test-critic', '[critic→builder]\nStill broken.\nFix the edge case.', 'race-test-thread', ['msg-c'])
    expect(state.phase).toBe('closing')

    onBuildReply('race-test-owner', '[summary]\nBuilt the thing.', 'race-test-thread', ['msg-o'])

    expect(state.phase).toBe('complete')

    const msg = findCompletionMsg('race-test-owner')
    expect(msg).toBeDefined()
    expect(msg!.content).toContain('Max rounds reached')
    expect(msg!.content).not.toContain('Critic approved')
  })

  test('LGTM verdict preserved through the race window', () => {
    const state = createBuild({ criticSessionId: 'race-test-critic', currentRound: 1, rounds: 3 })

    onBuildReply('race-test-critic', '[critic→builder]\n**LGTM**\nShip it.', 'race-test-thread', ['msg-c'])
    expect(state.phase).toBe('closing')

    onBuildReply('race-test-owner', '[summary]\nShipped.', 'race-test-thread', ['msg-o'])
    expect(state.phase).toBe('complete')

    const msg = findCompletionMsg('race-test-owner')
    expect(msg).toBeDefined()
    expect(msg!.content).toContain('Critic approved')
  })
})
