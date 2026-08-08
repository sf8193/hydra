import { describe, test, expect, beforeEach, mock } from 'bun:test'

// Suppress stderr
process.stderr.write = (() => true) as any

// Mock heavy deps
mock.module('../session-lifecycle.js', () => ({
  doSpawnSession: async () => ({
    name: 'mock-builder', sessionId: 'builder-session-1',
    threadId: 'builder-thread-1', url: '',
  }),
  killSession: async () => {},
}))

let mockStartReviewCalled = false
mock.module('../adversarial.js', () => ({
  startReview: async () => { mockStartReviewCalled = true; return {} },
  cancelReview: async () => {},
  getReviewByThread: () => ({ reviewId: 'review-1' }),
}))

let mockIsAlive = true
mock.module('../util.js', () => ({
  safeSend: async () => [],
  isAlive: () => mockIsAlive,
  formatSpawnLine: () => '',
  fallbackDescription: () => '',
  tmuxHasSession: () => true,
  chunk: (s: string) => [s],
  assertSendable: () => {},
  extractPhaseBudget: (t: string) => ({ topic: t }),
  formatDuration: () => '',
  getContextPercent: () => 0,
  parseDuration: () => null,
  transformProtocolTag: (t: string) => t,
}))

mock.module('../phase-budget.js', () => ({
  clearPhaseBudget: () => {},
  startPhaseBudget: () => {},
}))

const mockSessions = new Map<string, any>()
mock.module('../sessions.js', () => ({
  registry: {
    get: (id: string) => mockSessions.get(id),
    set: (id: string, info: any) => mockSessions.set(id, info),
    delete: (id: string) => mockSessions.delete(id),
    values: () => mockSessions.values(),
    persist: () => {},
    pickSessionName: () => 'mock-builder',
    getByThread: () => null,
    setThread: () => {},
    deleteThread: () => {},
    addMember: () => {},
    removeMember: () => {},
    findByName: () => null,
  },
  sessionEmoji: () => '🔧',
  threadRegistry: { get: () => null, recordSpawn: () => {}, recordKill: () => {} },
}))

mock.module('../config.js', () => ({
  gateway: { send: async () => ({ id: 'msg-1' }), createThread: async () => ({ id: 'thread-1' }), getThreadUrl: async () => '', fetchChannel: async () => ({}) },
  PLATFORM: 'test', DEFAULT_SESSION_CHANNEL: 'test-channel', CLAUDE_CONFIG: '/tmp/claude-test',
  SOCK_PATH: '/tmp/test.sock', STATE_DIR: '/tmp/test-state', INBOX_DIR: '/tmp/test-inbox',
}))

mock.module('../bridge-transport.js', () => ({
  transport: { has: () => false, disconnect: () => {}, sendOrQueue: () => {} },
}))

mock.module('../bridge-tools.js', () => ({
  computeToolsForSession: () => [], BRIDGE_TOOLS: [], MAIN_ONLY_TOOLS: new Set(),
}))

mock.module('../anchor-state.js', () => ({ refreshSessionVisual: () => {} }))
mock.module('../pr-watch.js', () => ({ unwatchBySession: () => 0 }))

import { factoryBuild, factoryRetryReview, onBuilderDeath, _getStateForTesting, _resetForTesting } from '../factory.js'

// Direct state manipulation — bypasses async spawn to test state machine logic
function createBuildState(ticket: string, opts: {
  pmThreadId?: string, pmSessionId?: string, phase?: string,
  builderSessionId?: string, builderThreadId?: string, builderModel?: string,
} = {}) {
  const { pending, pmTickets, builderSessionToTicket, builderThreadToTicket } = _getStateForTesting()
  const pmThreadId = opts.pmThreadId ?? 'pm-thread-1'
  const state = {
    ticket,
    pmThreadId,
    pmSessionId: opts.pmSessionId ?? 'pm-session-1',
    spec: 'test spec',
    builderModel: opts.builderModel,
    builderSessionId: opts.builderSessionId,
    builderThreadId: opts.builderThreadId,
    reviewRounds: 3,
    phase: opts.phase ?? 'building',
  }
  pending.set(ticket, state as any)

  let set = pmTickets.get(pmThreadId)
  if (!set) { set = new Set(); pmTickets.set(pmThreadId, set) }
  set.add(ticket)

  if (opts.builderSessionId) builderSessionToTicket.set(opts.builderSessionId, ticket)
  if (opts.builderThreadId) builderThreadToTicket.set(opts.builderThreadId, ticket)

  return state
}

describe('factoryBuild', () => {
  beforeEach(() => {
    _resetForTesting()
    mockSessions.clear()
    mockIsAlive = true
    delete process.env.SPAWN_CWD
  })

  test('returns ticket on success', () => {
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'claude-1', tmuxName: 'pm', threadId: 'pt-1' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec', 'claude-opus-4-6', 'claude-fable-5')
    expect('ticket' in result).toBe(true)
    if ('ticket' in result) expect(result.ticket).toMatch(/^fb-/)
  })

  test('rejects same builder and reviewer model', () => {
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec', 'claude-opus-4-6', 'claude-opus-4-6')
    expect('error' in result).toBe(true)
  })

  test('rejects when PM session not found', () => {
    const result = factoryBuild('pt-1', 'nonexistent', 'spec')
    expect('error' in result).toBe(true)
  })

  test('blocks concurrent builds in same thread', () => {
    createBuildState('fb-existing', { pmThreadId: 'pt-1', phase: 'building' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('already active')
  })

  test('blocks when existing ticket is reviewing', () => {
    createBuildState('fb-existing', { pmThreadId: 'pt-1', phase: 'reviewing' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5')
    expect('error' in result).toBe(true)
  })

  test('allows build when existing ticket is complete', () => {
    createBuildState('fb-existing', { pmThreadId: 'pt-1', phase: 'complete' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5')
    expect('ticket' in result).toBe(true)
  })

  test('allows build when existing ticket is review_failed — kills old builder', () => {
    createBuildState('fb-existing', { pmThreadId: 'pt-1', phase: 'review_failed', builderSessionId: 'old-b-1' })
    mockSessions.set('old-b-1', { sessionId: 'old-b-1', tmuxName: 'old-builder' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5')
    expect('ticket' in result).toBe(true)
    // Old review_failed ticket should be cleaned up
    const { pending } = _getStateForTesting()
    expect(pending.has('fb-existing')).toBe(false)
  })

  test('worktree builds bypass concurrency gate', () => {
    createBuildState('fb-existing', { pmThreadId: 'pt-1', phase: 'building' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5', 3, 'venture')
    expect('ticket' in result).toBe(true)
  })

  test('multiple worktree builds can run in parallel', () => {
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const r1 = factoryBuild('pt-1', 'pm-1', 'spec 1', 'claude-opus-4-6', 'claude-fable-5', 3, 'venture')
    const r2 = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5', 3, 'treasury')
    expect('ticket' in r1).toBe(true)
    expect('ticket' in r2).toBe(true)
  })

  test('worktree builds do not kill review_failed builders', () => {
    createBuildState('fb-stale', { pmThreadId: 'pt-1', phase: 'review_failed', builderSessionId: 'old-b' })
    mockSessions.set('old-b', { sessionId: 'old-b', tmuxName: 'old-builder' })
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec 2', 'claude-opus-4-6', 'claude-fable-5', 3, 'venture')
    expect('ticket' in result).toBe(true)
    // Old review_failed ticket should NOT be killed (worktree build is isolated)
    expect(_getStateForTesting().pending.has('fb-stale')).toBe(true)
  })

  test('worktree field stored in state', () => {
    mockSessions.set('pm-1', { sessionId: 'pm-1', claudeSessionId: 'c-1', tmuxName: 'pm' })
    const result = factoryBuild('pt-1', 'pm-1', 'spec', 'claude-opus-4-6', 'claude-fable-5', 3, 'venture')
    expect('ticket' in result).toBe(true)
    const ticket = (result as { ticket: string }).ticket
    const state = _getStateForTesting().pending.get(ticket)
    expect(state?.worktree).toBe('venture')
  })
})

describe('factoryRetryReview', () => {
  beforeEach(() => {
    _resetForTesting()
    mockSessions.clear()
    mockIsAlive = true
    mockStartReviewCalled = false
  })

  test('succeeds on review_failed ticket with live builder', () => {
    createBuildState('fb-1', {
      phase: 'review_failed', builderSessionId: 'b-1', builderThreadId: 'bt-1',
      builderModel: 'claude-opus-4-6',
    })
    mockSessions.set('b-1', { sessionId: 'b-1', tmuxName: 'builder', threadId: 'bt-1' })

    const result = factoryRetryReview('fb-1', 'pm-session-1', 'claude-fable-5')
    expect('ok' in result).toBe(true)
    expect(_getStateForTesting().pending.get('fb-1')!.phase).toBe('reviewing')
  })

  test('rejects wrong PM session', () => {
    createBuildState('fb-1', { phase: 'review_failed' })
    const result = factoryRetryReview('fb-1', 'wrong-pm')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('different PM session')
  })

  test('rejects wrong phase (building)', () => {
    createBuildState('fb-1', { phase: 'building' })
    const result = factoryRetryReview('fb-1', 'pm-session-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('retry_review only works on review_failed')
  })

  test('rejects dead builder', () => {
    createBuildState('fb-1', { phase: 'review_failed', builderSessionId: 'b-1', builderThreadId: 'bt-1' })
    mockSessions.set('b-1', { sessionId: 'b-1', tmuxName: 'builder' })
    mockIsAlive = false
    const result = factoryRetryReview('fb-1', 'pm-session-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('dead')
  })

  test('rejects same-model reviewer', () => {
    createBuildState('fb-1', { phase: 'review_failed', builderSessionId: 'b-1', builderThreadId: 'bt-1', builderModel: 'claude-opus-4-6' })
    mockSessions.set('b-1', { sessionId: 'b-1', tmuxName: 'builder' })
    const result = factoryRetryReview('fb-1', 'pm-session-1', 'claude-opus-4-6')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('same model')
  })

  test('rejects nonexistent ticket', () => {
    const result = factoryRetryReview('fb-999', 'pm-session-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('not found')
  })

  test('rejects missing builder session', () => {
    createBuildState('fb-1', { phase: 'review_failed' })
    const result = factoryRetryReview('fb-1', 'pm-session-1')
    expect('error' in result).toBe(true)
  })
})

describe('onBuilderDeath', () => {
  beforeEach(() => { _resetForTesting(); mockSessions.clear(); mockIsAlive = true })

  test('cleans up building phase', () => {
    createBuildState('fb-1', { builderSessionId: 'b-1', builderThreadId: 'bt-1' })
    onBuilderDeath('b-1')
    const { pending, builderSessionToTicket } = _getStateForTesting()
    expect(pending.has('fb-1')).toBe(false)
    expect(builderSessionToTicket.has('b-1')).toBe(false)
  })

  test('cleans up review_failed phase', () => {
    createBuildState('fb-1', { phase: 'review_failed', builderSessionId: 'b-1' })
    onBuilderDeath('b-1')
    expect(_getStateForTesting().pending.has('fb-1')).toBe(false)
  })

  test('cleans up reviewing phase and cancels review', () => {
    createBuildState('fb-1', { phase: 'reviewing', builderSessionId: 'b-1', builderThreadId: 'bt-1' })
    onBuilderDeath('b-1')
    const { pending, builderSessionToTicket, builderThreadToTicket } = _getStateForTesting()
    expect(pending.has('fb-1')).toBe(false)
    expect(builderSessionToTicket.has('b-1')).toBe(false)
    expect(builderThreadToTicket.has('bt-1')).toBe(false)
  })

  test('no-ops for unknown session', () => {
    onBuilderDeath('unknown')
  })
})

describe('state cleanup', () => {
  beforeEach(() => { _resetForTesting(); mockSessions.clear() })

  test('clears pmTickets index', () => {
    createBuildState('fb-1', { builderSessionId: 'b-1' })
    expect(_getStateForTesting().pmTickets.get('pm-thread-1')?.has('fb-1')).toBe(true)
    onBuilderDeath('b-1')
    expect(_getStateForTesting().pmTickets.has('pm-thread-1')).toBe(false)
  })

  test('clears reviewFailedTimers', () => {
    createBuildState('fb-1', { phase: 'review_failed', builderSessionId: 'b-1' })
    const { reviewFailedTimers } = _getStateForTesting()
    reviewFailedTimers.set('fb-1', setTimeout(() => {}, 999999))
    expect(reviewFailedTimers.has('fb-1')).toBe(true)
    onBuilderDeath('b-1')
    expect(reviewFailedTimers.has('fb-1')).toBe(false)
  })
})
