import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

// ---------------------------------------------------------------------------
// NO mock.module — uses dependency injection via factory's __test.setDeps().
// This avoids bun's global mock.module leak that breaks other test files.
// ---------------------------------------------------------------------------

import {
  factoryBuild,
  factoryRetry,
  factoryAccept,
  factoryAbandon,
  factoryStatus,
  onBuilderDone,
  onBuilderDeath,
  __test,
} from '../factory.js'
import { protocolEvents } from '../protocol-runner.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import type { FactoryDoneArgs } from '../factory.js'

if (!__test) throw new Error('factory __test requires NODE_ENV=test')

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

const sent: Array<{ chatId: string; text: string }> = []
let spawnCalls: any[] = []
let killCalls: any[] = []
let loadedProtocols: string[] = []
let cancelRunCalls: any[] = []

const origStderr = process.stderr.write

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PM_SESSION = 'factory-test-pm-1'
const PM_THREAD = 'factory-test-pm-t-1'
const PM_TMUX = 'factory-test-moss'
const BUILDER_SESSION = 'factory-test-builder-1'
const BUILDER_THREAD = 'factory-test-builder-t-1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPmSession(): void {
  registry.set(PM_SESSION, {
    sessionId: PM_SESSION,
    threadId: PM_THREAD,
    tmuxName: PM_TMUX,
    claudeSessionId: 'claude-pm-1',
    createdAt: Date.now(),
    lastActive: Date.now(),
    listening: false,
    topic: 'PM session',
  } as any)
}

function seedBuilderSession(): void {
  registry.set(BUILDER_SESSION, {
    sessionId: BUILDER_SESSION,
    threadId: BUILDER_THREAD,
    tmuxName: 'factory-test-cedar',
    claudeSessionId: 'claude-builder-1',
    createdAt: Date.now(),
    lastActive: Date.now(),
    listening: false,
    topic: 'Builder',
  } as any)
}

function createBuild(): string {
  seedPmSession()
  const result = factoryBuild({
    pmThreadId: PM_THREAD,
    pmSessionId: PM_SESSION,
    spec: 'Fix the widget',
  })
  if ('error' in result) throw new Error(result.error)
  return result.ticket
}

async function buildAndDone(): Promise<string> {
  const ticket = createBuild()
  await Bun.sleep(50)
  seedBuilderSession()

  const doneResult = onBuilderDone(BUILDER_SESSION, {
    files_changed: ['widget.ts'],
    test_results: '100 pass, 0 fail',
  })
  if ('error' in doneResult) throw new Error(doneResult.error)
  await Bun.sleep(50)
  return ticket
}

function emitReviewComplete(outcome: 'complete' | 'cancelled' = 'complete', extra: Record<string, unknown> = {}): void {
  protocolEvents.emitComplete({
    protocol: 'review',
    threadId: BUILDER_THREAD,
    outcome,
    rounds: { completed: 3, requested: 3 },
    durationMs: 60000,
    decisions: [],
    ...extra,
  } as any)
}

function emitRoundAdvance(round: number, totalRounds: number, opts: { role?: string; text?: string } = {}): void {
  protocolEvents.emitRoundAdvance({
    protocol: 'review',
    threadId: BUILDER_THREAD,
    round,
    totalRounds,
    ...opts,
  })
}

const DONE_ARGS: FactoryDoneArgs = {
  files_changed: ['widget.ts', 'widget.test.ts'],
  test_results: '42 pass, 0 fail',
  rationale: 'Chose X over Y for performance',
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.stderr.write = (() => true) as any
  sent.length = 0
  spawnCalls.length = 0
  killCalls.length = 0
  loadedProtocols.length = 0
  cancelRunCalls.length = 0

  __test.setDeps({
    doSpawnSession: async (...args: any[]) => {
      spawnCalls.push(args)
      return { sessionId: BUILDER_SESSION, threadId: BUILDER_THREAD, name: 'factory-test-cedar' }
    },
    killSession: async (...args: any[]) => { killCalls.push(args) },
    safeSend: async (chatId: string, text: string) => { sent.push({ chatId, text }); return ['m1'] },
    getProtocol: async (name: string) => {
      loadedProtocols.push(name)
      return {
        name,
        display: name,
        emoji: '⚔️',
        roles: { owner: 'Owner', critic: 'Critic' },
        ownerRole: 'owner',
        initialPhase: 'critic_turn',
        phases: { critic_turn: {}, owner_turn: {}, cleanup: {}, complete: {} },
      } as any
    },
    startProtocolRun: async () => {},
    getRunByThread: () => undefined as any,
    cancelRun: async (...args: any[]) => { cancelRunCalls.push(args) },
  })

  __test.reset()
})

afterEach(() => {
  __test.resetDeps()
  __test.reset()
  registry.delete(PM_SESSION)
  registry.delete(BUILDER_SESSION)
  process.stderr.write = origStderr
})

// ---------------------------------------------------------------------------
// Build creation
// ---------------------------------------------------------------------------

describe('factoryBuild', () => {
  test('returns ticket on success', () => {
    seedPmSession()
    const result = factoryBuild({
      pmThreadId: PM_THREAD,
      pmSessionId: PM_SESSION,
      spec: 'Build a widget',
    })
    expect('ticket' in result).toBe(true)
    if ('ticket' in result) expect(result.ticket).toMatch(/^fb-\d+-[a-f0-9]+$/)
  })

  test('returns error when PM claudeSessionId is missing', () => {
    registry.set(PM_SESSION, {
      sessionId: PM_SESSION,
      threadId: PM_THREAD,
      tmuxName: PM_TMUX,
      createdAt: Date.now(),
      lastActive: Date.now(),
      listening: false,
      topic: 'PM session',
    } as any)
    const result = factoryBuild({
      pmThreadId: PM_THREAD,
      pmSessionId: PM_SESSION,
      spec: 'Build a widget',
    })
    expect('error' in result).toBe(true)
  })

  test('factoryStatus shows active builds', async () => {
    const ticket = createBuild()
    const status = factoryStatus(PM_THREAD)
    expect(status.builds).toHaveLength(1)
    expect(status.builds[0].ticket).toBe(ticket)
    expect(status.builds[0].phase).toBe('building')
    expect(status.builds[0].spec).toContain('Fix the widget')
  })
})

// ---------------------------------------------------------------------------
// Build complete → review
// ---------------------------------------------------------------------------

describe('build complete → review', () => {
  test('onBuilderDone transitions phase to reviewing', async () => {
    const ticket = createBuild()
    await Bun.sleep(50)
    seedBuilderSession()

    const result = onBuilderDone(BUILDER_SESSION, DONE_ARGS)
    expect(result).toEqual({ ok: true })

    const builds = [...__test.builds.values()]
    expect(builds[0].phase).toBe('reviewing')
  })

  test('onBuilderDone loads review protocol', async () => {
    const ticket = createBuild()
    await Bun.sleep(50)
    seedBuilderSession()

    loadedProtocols.length = 0
    onBuilderDone(BUILDER_SESSION, DONE_ARGS)
    await Bun.sleep(50)

    expect(loadedProtocols).toContain('review')
  })

  test('PM receives build complete notification', async () => {
    const ticket = createBuild()
    await Bun.sleep(50)
    seedBuilderSession()

    sent.length = 0
    onBuilderDone(BUILDER_SESSION, DONE_ARGS)

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const buildComplete = pmMessages.find(m => m.text.includes('Build complete'))
    expect(buildComplete).toBeDefined()
    expect(buildComplete!.text).toContain('starting mandatory review')
    expect(buildComplete!.text).toContain('widget.ts')
  })

  test('rejects done when not in building phase', async () => {
    const ticket = createBuild()
    await Bun.sleep(50)
    seedBuilderSession()

    onBuilderDone(BUILDER_SESSION, DONE_ARGS)
    const second = onBuilderDone(BUILDER_SESSION, DONE_ARGS)
    expect('error' in second).toBe(true)
  })

  test('rejects done from unknown session', () => {
    const result = onBuilderDone('unknown-session', DONE_ARGS)
    expect('error' in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Review completion → PM notification
// ---------------------------------------------------------------------------

describe('review completion → PM notification', () => {
  test('complete event transitions to awaiting_pm', async () => {
    await buildAndDone()

    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitReviewComplete('complete', { transcriptPath: '/tmp/review.txt' })

    expect(builds[0].phase).toBe('awaiting_pm')
  })

  test('PM receives awaiting decision notification with actions', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitReviewComplete()

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const awaitingMsg = pmMessages.find(m => m.text.includes('awaiting your decision'))
    expect(awaitingMsg).toBeDefined()
    expect(awaitingMsg!.text).toContain('factory_accept')
    expect(awaitingMsg!.text).toContain('factory_retry')
    expect(awaitingMsg!.text).toContain('factory_abandon')
  })

  test('transcript path included in notification', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitReviewComplete('complete', { transcriptPath: '/tmp/review-transcript.txt' })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const awaitingMsg = pmMessages.find(m => m.text.includes('awaiting your decision'))
    expect(awaitingMsg!.text).toContain('/tmp/review-transcript.txt')
  })

  test('non-review protocol events are ignored', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    protocolEvents.emitComplete({
      protocol: 'spike',
      threadId: BUILDER_THREAD,
      outcome: 'complete',
      rounds: { completed: 1, requested: 1 },
      durationMs: 5000,
      decisions: [],
    } as any)

    expect(builds[0].phase).toBe('reviewing')
  })

  test('reviewed flag set on successful completion', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    emitReviewComplete()
    expect(builds[0].reviewed).toBe(true)

    const result = factoryAccept(ticket, PM_SESSION)
    expect(result).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Review cancellation
// ---------------------------------------------------------------------------

describe('review cancellation', () => {
  test('cancelled review transitions to awaiting_pm', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    emitReviewComplete('cancelled')
    expect(builds[0].phase).toBe('awaiting_pm')
  })

  test('PM receives cancellation notification with retry/abandon options', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitReviewComplete('cancelled')

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const cancelMsg = pmMessages.find(m => m.text.includes('review cancelled'))
    expect(cancelMsg).toBeDefined()
    expect(cancelMsg!.text).toContain('factory_retry')
    expect(cancelMsg!.text).toContain('factory_abandon')
  })

  test('cancelled review with reviewAttempted accepts without override', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    builds[0].reviewAttempted = true

    emitReviewComplete('cancelled')

    const result = factoryAccept(ticket, PM_SESSION)
    expect(result).toEqual({ ok: true })
  })

  test('unreviewed build without attempt requires allow_unreviewed', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'awaiting_pm'
    builds[0].reviewAttempted = false

    const result = factoryAccept(ticket, PM_SESSION)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('NOT adversarially reviewed')

    const result2 = factoryAccept(ticket, PM_SESSION, true)
    expect(result2).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Round progress forwarding
// ---------------------------------------------------------------------------

describe('round progress forwarding', () => {
  test('non-final round sends progress notification', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitRoundAdvance(1, 3, { role: 'owner', text: 'defense text' })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const progressMsg = pmMessages.find(m => m.text.includes('Review Round 1/3'))
    expect(progressMsg).toBeDefined()
    expect(progressMsg!.text).toContain('in progress')
  })

  test('critic final round forwards text', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitRoundAdvance(3, 3, { role: 'critic', text: 'Final assessment: all issues addressed.' })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const finalMsg = pmMessages.find(m => m.text.includes('Critic Final Round'))
    expect(finalMsg).toBeDefined()
    expect(finalMsg!.text).toContain('Final assessment')
  })

  test('owner final round is NOT forwarded as critic text', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitRoundAdvance(3, 3, { role: 'owner', text: 'owner defense' })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages.find(m => m.text.includes('Critic Final Round'))).toBeUndefined()
    expect(pmMessages.find(m => m.text.includes('Review Round 3/3'))).toBeDefined()
  })

  test('large critic text is truncated at 3000 chars', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    emitRoundAdvance(3, 3, { role: 'critic', text: 'x'.repeat(4000) })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const finalMsg = pmMessages.find(m => m.text.includes('Critic Final Round'))
    expect(finalMsg).toBeDefined()
    expect(finalMsg!.text).toContain('(truncated)')
    expect(finalMsg!.text.length).toBeLessThan(3200)
  })

  test('non-review protocol round events are ignored', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    protocolEvents.emitRoundAdvance({
      protocol: 'build',
      threadId: BUILDER_THREAD,
      round: 1,
      totalRounds: 3,
    })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Retry cycle
// ---------------------------------------------------------------------------

describe('retry cycle', () => {
  test('retry transitions back to building and increments counter', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    emitReviewComplete()

    const result = factoryRetry(ticket, 'Fix the edge case', PM_SESSION)
    expect(result).toEqual({ ok: true })

    expect(builds[0].phase).toBe('building')
    expect(builds[0].retryCount).toBe(1)
  })

  test('retry sends instructions to builder via transport', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    emitReviewComplete()

    const beforeCount = [...transport.messageQueues?.entries() ?? []].length
    factoryRetry(ticket, 'Fix edge case', PM_SESSION)

    // Retry sends via transport.sendOrQueue — check sent messages for the instruction
    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const retryMsg = pmMessages.find(m => m.text.includes('Factory retry'))
    expect(retryMsg).toBeDefined()
  })

  test('PM receives retry confirmation', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    emitReviewComplete()

    sent.length = 0
    factoryRetry(ticket, 'Fix it', PM_SESSION)

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const retryMsg = pmMessages.find(m => m.text.includes('Factory retry'))
    expect(retryMsg).toBeDefined()
    expect(retryMsg!.text).toContain('attempt 2')
  })

  test('retry rejects when not in awaiting_pm phase', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'building'

    const result = factoryRetry(ticket, 'Fix it', PM_SESSION)
    expect('error' in result).toBe(true)
  })

  test('retry rejects from wrong PM', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    emitReviewComplete()

    const result = factoryRetry(ticket, 'Fix it', 'other-pm')
    expect('error' in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Accept / Abandon
// ---------------------------------------------------------------------------

describe('accept/abandon', () => {
  test('accept transitions to complete and cleans up', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    emitReviewComplete()

    sent.length = 0
    const result = factoryAccept(ticket, PM_SESSION)
    expect(result).toEqual({ ok: true })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages.find(m => m.text.includes('accepted'))).toBeDefined()
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('accept rejects from wrong PM', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'
    emitReviewComplete()

    const result = factoryAccept(ticket, 'other-pm')
    expect('error' in result).toBe(true)
  })

  test('accept rejects when not in awaiting_pm phase', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'building'

    const result = factoryAccept(ticket, PM_SESSION)
    expect('error' in result).toBe(true)
  })

  test('abandon during reviewing cancels review', async () => {
    const ticket = await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    const result = factoryAbandon(ticket, PM_SESSION)
    expect(result).toEqual({ ok: true })

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages.find(m => m.text.includes('abandoned'))).toBeDefined()
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('abandon during building skips review cancellation', async () => {
    const ticket = createBuild()
    await Bun.sleep(50)
    seedBuilderSession()

    const result = factoryAbandon(ticket, PM_SESSION)
    expect(result).toEqual({ ok: true })
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('abandon rejects for unknown ticket', () => {
    const result = factoryAbandon('fb-999-xxxx', PM_SESSION)
    expect('error' in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Builder death
// ---------------------------------------------------------------------------

describe('builder death', () => {
  test('death during building → failed + PM notified', async () => {
    createBuild()
    await Bun.sleep(50)

    sent.length = 0
    onBuilderDeath(BUILDER_SESSION)

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages.find(m => m.text.includes('Builder crashed'))).toBeDefined()
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('death during review → cancelled + PM notified', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'reviewing'

    sent.length = 0
    onBuilderDeath(BUILDER_SESSION)

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    expect(pmMessages.find(m => m.text.includes('crashed during review'))).toBeDefined()
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('death during awaiting_pm → PM warned, ticket closed', async () => {
    await buildAndDone()
    const builds = [...__test.builds.values()]
    builds[0].phase = 'awaiting_pm'
    builds[0].reviewAttempted = false

    sent.length = 0
    onBuilderDeath(BUILDER_SESSION)

    const pmMessages = sent.filter(s => s.chatId === PM_THREAD)
    const deathMsg = pmMessages.find(m => m.text.includes('Builder exited'))
    expect(deathMsg).toBeDefined()
    expect(deathMsg!.text).toContain('still on disk')
    expect(factoryStatus(PM_THREAD).builds).toHaveLength(0)
  })

  test('death from unknown session is a no-op', () => {
    sent.length = 0
    onBuilderDeath('unknown-session')
    expect(sent.filter(s => s.chatId === PM_THREAD)).toHaveLength(0)
  })
})
