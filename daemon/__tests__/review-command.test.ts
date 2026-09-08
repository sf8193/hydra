// `review` command → protocol run, end to end through the real handler.
//
// The unit tests either side of this one cover the halves: modifiers.test.ts
// proves partitionFlagModifiers splits flags from lenses, protocol-scenarios
// proves the runner does the right thing GIVEN directSubagent in params. What
// only this file can show is the join — that typing `review 3 +subagent topic`
// actually lands those params on the run, with the flag stripped from the
// modifier list rather than riding along as a lens.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { handleReviewIntercept } from '../commands/review.js'
import { __test as runnerTest, getRunByThread, cancelRun } from '../protocol-runner.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import type { InboundMessage } from '../../gateway.js'

if (!runnerTest) throw new Error('protocol-runner.__test only available under NODE_ENV=test')
const runner = runnerTest

let origStderrWrite: typeof process.stderr.write
let origRegistryPersist: typeof registry.persist
const origGateway: Record<string, unknown> = {}

let sent: Array<{ channelId: string; text: string }> = []
const trackedSessions = new Set<string>()
const trackedThreads = new Set<string>()

beforeAll(() => {
  origRegistryPersist = registry.persist
  ;(registry as any).persist = () => {}
})

afterAll(() => {
  ;(registry as any).persist = origRegistryPersist
})

function stub(name: string, impl: unknown): void {
  origGateway[name] = (gateway as any)[name]
  ;(gateway as any)[name] = impl
}

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
  sent = []

  stub('send', async (channelId: string, text: string) => {
    sent.push({ channelId, text })
    return { id: `msg-${sent.length}`, channelId }
  })
  stub('react', async () => {})
  stub('updateSessionVisual', async () => {})

  // The owner is the only session that exists for real; spawns are stubbed, so
  // a run that tries to spawn a critic gets a registry entry and nothing else.
  runner.setLifecycle({
    doSpawnSession: async (topic: string, _a: any, _b: any, opts: any) => {
      const sessionId = `rc-spawned-${trackedSessions.size + 1}`
      registry.set(sessionId, {
        sessionId,
        topic,
        threadId: opts?.joinThread ?? '',
        createdAt: Date.now(),
        lastActive: Date.now(),
        tmuxName: `spawned-${sessionId}`,
        listening: false,
        turnState: 'idle',
      } as SessionInfo)
      trackedSessions.add(sessionId)
      return { name: registry.get(sessionId)!.tmuxName, sessionId, threadId: opts?.joinThread ?? '', url: '' }
    },
    waitForBridge: async () => true,
    killSession: async (info: SessionInfo) => { registry.delete(info.sessionId) },
  })
})

afterEach(async () => {
  for (const threadId of trackedThreads) {
    const run = getRunByThread(threadId)
    // cancelRun clears the run's real timers — dropping the map entries alone
    // would leave a 10-minute setTimeout holding the suite open.
    if (run) await cancelRun(run, 'test cleanup')
    registry.deleteThread(threadId)
  }
  trackedThreads.clear()
  for (const sid of trackedSessions) {
    registry.delete(sid)
    transport.messageQueues.delete(sid)
  }
  trackedSessions.clear()
  runner.resetLifecycle()
  for (const [name, impl] of Object.entries(origGateway)) (gateway as any)[name] = impl
  process.stderr.write = origStderrWrite
})

let threadSeq = 0

/** An owner session that owns its own thread — what `review` requires. */
function mkOwner(): { sessionId: string; threadId: string; msg: InboundMessage } {
  const threadId = `rc-thread-${++threadSeq}`
  const sessionId = `rc-owner-${threadSeq}`
  registry.set(sessionId, {
    sessionId,
    topic: 'the work under review',
    threadId,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'drift',
    listening: false,
    turnState: 'idle',
    sessionType: 'thread_owner',
  } as SessionInfo)
  registry.setThread(threadId, sessionId)
  trackedSessions.add(sessionId)
  trackedThreads.add(threadId)

  const msg = {
    channelId: threadId,
    id: `rc-msg-${threadSeq}`,
    effectiveThreadId: threadId,
    isThread: true,
    content: '',
  } as unknown as InboundMessage

  return { sessionId, threadId, msg }
}

describe('review command → run params', () => {
  test('+subagent becomes directSubagent and starts the run in subagent_review', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, 'auth flow', undefined, ['subagent'])

    const run = getRunByThread(threadId)
    expect(run).toBeDefined()
    expect(run!.params.directSubagent).toBe(true)
    expect(run!.phase).toBe('subagent_review')
    // The flag steered the run; it must not survive as a lens on it.
    expect(run!.params.modifiers).toBeUndefined()
    expect(run!.participants.has('critic')).toBe(false)
  })

  test('the +sa alias is the same flag, not an unknown modifier', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, 'auth flow', undefined, ['sa'])

    expect(sent.some(s => s.text.includes('Unknown modifier'))).toBe(false)
    expect(getRunByThread(threadId)!.params.directSubagent).toBe(true)
  })

  test('+no-fallback becomes noFallback and leaves the critic spawn alone', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, undefined, undefined, ['no-fallback'])

    const run = getRunByThread(threadId)!
    expect(run.params.noFallback).toBe(true)
    expect(run.params.directSubagent).toBeUndefined()
    // Not a direct start — the normal adversarial run still happens.
    expect(run.phase).toBe('critic_turn')
    expect(run.participants.has('critic')).toBe(true)
  })

  test('a lens modifier still rides along as a modifier, not a param', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, 'auth flow', undefined, ['security'])

    const run = getRunByThread(threadId)!
    expect(run.params.directSubagent).toBeUndefined()
    expect(run.params.noFallback).toBeUndefined()
    expect((run.params.modifiers as Array<{ name: string }>).map(m => m.name)).toEqual(['security'])
  })

  test('+subagent +security splits: the flag steers, the lens rides', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, 'auth flow', undefined, ['subagent', 'security'])

    const run = getRunByThread(threadId)!
    expect(run.params.directSubagent).toBe(true)
    expect(run.phase).toBe('subagent_review')
    expect((run.params.modifiers as Array<{ name: string }>).map(m => m.name)).toEqual(['security'])
    // …and the lens reaches the owner, who has no critic to carry it.
    const ownerQueue = transport.messageQueues.get(registry.getByThread(threadId)!) ?? []
    const notes = ownerQueue.filter(m => (m as any).type === 'notification').map(m => (m as any).content as string)
    expect(notes.some(n => n.includes('+security') && n.includes('attack surface'))).toBe(true)
  })

  test('an unknown modifier is refused before any run starts', async () => {
    const { threadId, msg } = mkOwner()

    await handleReviewIntercept(msg, 3, 'auth flow', undefined, ['subagent', 'nonsense'])

    expect(sent.some(s => s.text.includes('Unknown modifier'))).toBe(true)
    expect(getRunByThread(threadId)).toBeUndefined()
  })
})
