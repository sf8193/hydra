// Factory resilience — PM death is gentle, the PM thread is the unit of ownership.
//
// The invariant under test: a PM session dying must not destroy work. Builders
// survive, thread membership (not session identity) authorizes decisions, the
// next session in the thread adopts the orphans, and destruction happens only
// when someone explicitly asks for it.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import {
  __test as factoryTest,
  deriveSpecTag,
  formatBuildLine,
  factoryAccept,
  factoryRetry,
  factoryAbandon,
  factoryCascadeKill,
} from '../factory.js'
import { resolveSendTarget } from '../bridge-dispatch.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo, ThreadMetadata } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import { emit, on, getSubscriptions } from '../event-bus.js'

if (!factoryTest) throw new Error('factory.__test only available under NODE_ENV=test')
const factory = factoryTest

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------
//
// STATE_DIR points at the operator's live daemon state, so the persist paths
// these code paths touch are stubbed out for the duration of the file rather
// than allowed to write through to a running daemon's session/queue files.

let origStderrWrite: typeof process.stderr.write
let origGatewaySend: typeof gateway.send
let origGatewayDeleteThread: typeof gateway.deleteThread
let origRegistryPersist: typeof registry.persist
let origThreadPersist: typeof threadRegistry.persist
let origQueuePersist: unknown

let sent: Array<{ channelId: string; text: string }> = []
let killed: string[] = []
const trackedSessions = new Set<string>()
const trackedThreads = new Set<string>()

beforeAll(() => {
  origRegistryPersist = registry.persist
  origThreadPersist = threadRegistry.persist
  origQueuePersist = (transport as any).persistQueues
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  ;(transport as any).persistQueues = () => {}
})

afterAll(() => {
  ;(registry as any).persist = origRegistryPersist
  ;(threadRegistry as any).persist = origThreadPersist
  ;(transport as any).persistQueues = origQueuePersist
})

// factory.ts subscribes to the bus at import time, but other test files call
// event-bus._resetForTesting(), which wipes every listener in the process. These
// cases drive the handlers through emit() — the real path — so the subscriptions
// are restored here whenever they have gone missing.
let restoredSubs: Array<() => void> = []

function ensureFactorySubscriptions(): void {
  const subs = getSubscriptions()
  if (!(subs['session:death'] ?? []).includes('factory:session-death')) {
    restoredSubs.push(on('session:death', factory.factorySessionDeath, 'factory:session-death'))
  }
  if (!(subs['session:bridge-registered'] ?? []).includes('factory:adopt')) {
    restoredSubs.push(on('session:bridge-registered', factory.factoryAdopt, 'factory:adopt'))
  }
}

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any

  ensureFactorySubscriptions()
  sent = []
  killed = []
  origGatewaySend = gateway.send.bind(gateway)
  origGatewayDeleteThread = gateway.deleteThread
  ;(gateway as any).send = async (channelId: string, text: string) => {
    sent.push({ channelId, text })
    return { id: `msg-${sent.length}` }
  }
  ;(gateway as any).deleteThread = async () => {}

  factory.setLifecycle({
    killSession: async (info: SessionInfo) => { killed.push(info.tmuxName) },
  })
})

afterEach(() => {
  for (const unsub of restoredSubs) unsub()
  restoredSubs = []
  factory.reset()
  factory.resetLifecycle()
  for (const sid of trackedSessions) {
    registry.delete(sid)
    transport.messageQueues.delete(sid)
  }
  trackedSessions.clear()
  for (const tid of trackedThreads) {
    registry.deleteThread(tid)
    threadRegistry.threads.delete(tid)
  }
  trackedThreads.clear()
  ;(gateway as any).send = origGatewaySend
  ;(gateway as any).deleteThread = origGatewayDeleteThread
  process.stderr.write = origStderrWrite
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let idSeq = 0

/** Register a session in the real registry, tracked for teardown. */
function mkSession(opts: {
  tmuxName: string
  threadId: string
  sessionId?: string
  sessionType?: SessionInfo['sessionType']
  deadAt?: number
  claimThread?: boolean
}): SessionInfo {
  const sessionId = opts.sessionId ?? `sess-${++idSeq}`
  const info: SessionInfo = {
    sessionId,
    topic: `topic for ${opts.tmuxName}`,
    threadId: opts.threadId,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: opts.tmuxName,
    listening: false,
    sessionType: opts.sessionType ?? 'thread_owner',
    ...(opts.deadAt ? { deadAt: opts.deadAt } : {}),
  }
  registry.set(sessionId, info)
  trackedSessions.add(sessionId)
  // threadToSession names the thread's current occupant — a dead session only
  // holds the mapping in the restart case, never after a kill.
  if (opts.claimThread ?? !opts.deadAt) {
    registry.setThread(opts.threadId, sessionId)
    trackedThreads.add(opts.threadId)
  }
  return info
}

/** A build with a live builder session, seeded straight into the builds map. */
function mkBuild(opts: {
  ticket: string
  pmThreadId: string
  pmSessionId: string
  builderName: string
  phase?: 'building' | 'reviewing' | 'awaiting_pm'
  spec?: string
}) {
  const builderThreadId = `thread-${opts.builderName}`
  const builder = mkSession({
    tmuxName: opts.builderName,
    threadId: builderThreadId,
    sessionType: 'factory_builder',
  })
  return factory.seedBuild({
    ticket: opts.ticket,
    pmThreadId: opts.pmThreadId,
    pmSessionId: opts.pmSessionId,
    spec: opts.spec ?? 'implement the thing',
    phase: opts.phase ?? 'building',
    builderSessionId: builder.sessionId,
    builderThreadId,
  })
}

function textOf(): string {
  return sent.map(s => s.text).join('\n---\n')
}

// ---------------------------------------------------------------------------
// Display grammar
// ---------------------------------------------------------------------------

describe('deriveSpecTag', () => {
  test('leaves a short spec intact', () => {
    expect(deriveSpecTag('dashboard P2+P3')).toBe('dashboard P2+P3')
  })

  test('collapses newlines and runs of whitespace to single spaces', () => {
    expect(deriveSpecTag('  divergences\n\n  #5+#6  ')).toBe('divergences #5+#6')
  })

  test('truncates at a word boundary with an ellipsis', () => {
    const tag = deriveSpecTag('implement gentle factory death so builders survive PM rotation')
    expect(tag).toBe('implement gentle factory death so…')
    expect(tag.length).toBeLessThanOrEqual(41)
  })

  test('falls back to a hard cut when there is no word boundary to cut on', () => {
    const tag = deriveSpecTag('x'.repeat(80))
    expect(tag).toBe('x'.repeat(40) + '…')
  })
})

describe('formatBuildLine', () => {
  test('leads with the builder identity and spec tag, trails the short ticket', () => {
    const state = mkBuild({
      ticket: 'fb-10-381f',
      pmThreadId: 'thread-pm',
      pmSessionId: 'pm-1',
      builderName: 'drift',
      phase: 'reviewing',
      spec: 'divergences #5+#6',
    })
    expect(formatBuildLine(state)).toBe('🌊 drift · divergences #5+#6 · reviewing (fb-10)')
  })

  test('prefers a session-set content emoji over the catalog emoji', () => {
    const state = mkBuild({ ticket: 'fb-11-aa01', pmThreadId: 'thread-pm', pmSessionId: 'pm-1', builderName: 'flint' })
    registry.get(state.builderSessionId!)!.contentEmoji = '🎯'
    expect(formatBuildLine(state)).toStartWith('🎯 flint · ')
  })

  test('degrades to a placeholder when the builder session is gone', () => {
    const state = factory.seedBuild({
      ticket: 'fb-12-bb02', pmThreadId: 'thread-pm', pmSessionId: 'pm-1', spec: 'no builder yet',
    })
    expect(formatBuildLine(state)).toBe('🏗️ unknown · no builder yet · building (fb-12)')
  })

  test('elapsed is opt-in', () => {
    const state = mkBuild({ ticket: 'fb-13-cc03', pmThreadId: 'thread-pm', pmSessionId: 'pm-1', builderName: 'ember' })
    expect(formatBuildLine(state)).not.toContain(' · 0s ')
    expect(formatBuildLine(state, { includeElapsed: true })).toMatch(/ · \d+[smh] \(fb-13\)$/)
  })
})

// ---------------------------------------------------------------------------
// 1. Gentle death
// ---------------------------------------------------------------------------

describe('gentle factorySessionDeath', () => {
  test('leaves in-flight builds running and reports them to the PM thread', () => {
    const pmThreadId = 'thread-pm-gentle'
    mkSession({ tmuxName: 'glyph', threadId: pmThreadId, sessionId: 'pm-gentle' })
    const b1 = mkBuild({ ticket: 'fb-20-1111', pmThreadId, pmSessionId: 'pm-gentle', builderName: 'drift', phase: 'reviewing', spec: 'divergences #5+#6' })
    const b2 = mkBuild({ ticket: 'fb-21-2222', pmThreadId, pmSessionId: 'pm-gentle', builderName: 'flint', phase: 'building', spec: 'dashboard P2+P3' })

    // The registry entry is already gone by the time session:death fires.
    registry.delete('pm-gentle')

    emit('session:death', { sessionId: 'pm-gentle', threadId: pmThreadId, wasOwner: true, tmuxName: 'glyph' })

    // Builds survive, untouched.
    expect(factory.builds.has('fb-20-1111')).toBe(true)
    expect(factory.builds.has('fb-21-2222')).toBe(true)
    expect(b1.phase).toBe('reviewing')
    expect(b2.phase).toBe('building')
    expect(killed).toEqual([])

    // And the thread is told what is still in flight.
    const notice = sent.find(s => s.text.includes('PM session ended'))
    expect(notice).toBeDefined()
    expect(notice!.channelId).toBe(pmThreadId)
    expect(notice!.text).toContain('2 builds in-flight')
    expect(notice!.text).toContain('drift · divergences #5+#6 · reviewing (fb-20)')
    expect(notice!.text).toContain('flint · dashboard P2+P3 · building (fb-21)')
    expect(notice!.text).toContain('respawn')
  })

  test('is a no-op when the PM had no active builds', () => {
    emit('session:death', { sessionId: 'pm-idle', threadId: 'thread-pm-idle', wasOwner: true, tmuxName: 'nova' })
    expect(sent).toEqual([])
  })

  test('ignores builds that already reached a terminal phase', () => {
    const pmThreadId = 'thread-pm-terminal'
    factory.seedBuild({ ticket: 'fb-22-3333', pmThreadId, pmSessionId: 'pm-terminal', phase: 'complete' })
    factory.seedBuild({ ticket: 'fb-23-4444', pmThreadId, pmSessionId: 'pm-terminal', phase: 'failed' })

    emit('session:death', { sessionId: 'pm-terminal', threadId: pmThreadId, wasOwner: true, tmuxName: 'pixel' })
    expect(sent).toEqual([])
  })

  test('builder death still resolves normally — it is a separate concern', () => {
    const pmThreadId = 'thread-pm-builderdeath'
    const state = mkBuild({ ticket: 'fb-24-5555', pmThreadId, pmSessionId: 'pm-bd', builderName: 'cedar', phase: 'building' })

    emit('session:death', { sessionId: state.builderSessionId!, threadId: state.builderThreadId!, wasOwner: true, tmuxName: 'cedar' })

    expect(state.phase).toBe('failed')
    expect(factory.builds.has('fb-24-5555')).toBe(false)
    expect(textOf()).toContain('builder crashed')
  })
})

// ---------------------------------------------------------------------------
// 2. Thread-scoped authorization
// ---------------------------------------------------------------------------

describe('thread-scoped authorization', () => {
  const pmThreadId = 'thread-pm-auth'

  function seedOrphan(ticket: string, builderName: string) {
    const state = mkBuild({ ticket, pmThreadId, pmSessionId: 'pm-dead', builderName, phase: 'awaiting_pm' })
    return state
  }

  test('a successor session in the PM thread can accept a build its predecessor started', () => {
    seedOrphan('fb-30-1111', 'drift')
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    const result = factoryAccept('fb-30-1111', successor.sessionId, true)
    expect(result).toEqual({ ok: true })
    expect(killed).toEqual(['drift'])
    expect(factory.builds.has('fb-30-1111')).toBe(false)
  })

  test('a successor session in the PM thread can retry', () => {
    const state = seedOrphan('fb-31-2222', 'flint')
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    expect(factoryRetry('fb-31-2222', 'try again', successor.sessionId)).toEqual({ ok: true })
    expect(state.phase).toBe('building')
    expect(state.pmSessionId).toBe('pm-dead') // retry authorizes; it does not adopt
  })

  test('a successor session in the PM thread can abandon', () => {
    seedOrphan('fb-32-3333', 'ember')
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    expect(factoryAbandon('fb-32-3333', successor.sessionId, 'not needed')).toEqual({ ok: true })
    expect(killed).toEqual(['ember'])
  })

  test('a session in a different thread is refused on all three verbs', () => {
    seedOrphan('fb-33-4444', 'bloom')
    const outsider = mkSession({ tmuxName: 'atlas', threadId: 'thread-somewhere-else' })

    for (const [verb, call] of [
      ['accept', () => factoryAccept('fb-33-4444', outsider.sessionId, true)],
      ['retry', () => factoryRetry('fb-33-4444', 'x', outsider.sessionId)],
      ['abandon', () => factoryAbandon('fb-33-4444', outsider.sessionId)],
    ] as const) {
      const result = call() as { error?: string }
      expect(result.error).toBe(`Only a session in the PM thread can ${verb} this build.`)
    }
    expect(killed).toEqual([])
    expect(factory.builds.has('fb-33-4444')).toBe(true)
  })

  test('an unknown caller session is refused', () => {
    seedOrphan('fb-34-5555', 'jade')
    const result = factoryAccept('fb-34-5555', 'no-such-session', true) as { error?: string }
    expect(result.error).toContain('Only a session in the PM thread')
  })
})

// ---------------------------------------------------------------------------
// 3. Auto-adopt on bridge registration
// ---------------------------------------------------------------------------

describe('auto-adopt on bridge registration', () => {
  const pmThreadId = 'thread-pm-adopt'

  test('rewires pmSessionId, notifies the builder, and confirms in the PM thread', () => {
    const state = mkBuild({ ticket: 'fb-40-1111', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift', phase: 'reviewing', spec: 'divergences #5+#6' })
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })

    expect(state.pmSessionId).toBe(successor.sessionId)

    const queued = transport.messageQueues.get(state.builderSessionId!) ?? []
    const notice = queued.find(m => String(m.content).includes('PM session replaced'))
    expect(notice).toBeDefined()
    expect(String(notice!.content)).toContain('New PM: glyph')
    expect(String(notice!.content)).toContain('send_to_thread(target="glyph")')
    expect((notice!.meta as Record<string, string>).chat_id).toBe(state.builderThreadId)

    const confirm = sent.find(s => s.text.includes('Adopted'))
    expect(confirm).toBeDefined()
    expect(confirm!.channelId).toBe(pmThreadId)
    expect(confirm!.text).toContain('Adopted 1 build')
    expect(confirm!.text).toContain('drift · divergences #5+#6 · reviewing (fb-40)')
  })

  test('adopts every orphan in the thread at once', () => {
    const a = mkBuild({ ticket: 'fb-41-1111', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift', phase: 'reviewing' })
    const b = mkBuild({ ticket: 'fb-42-2222', pmThreadId, pmSessionId: 'pm-dead', builderName: 'flint', phase: 'building' })
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })

    expect(a.pmSessionId).toBe(successor.sessionId)
    expect(b.pmSessionId).toBe(successor.sessionId)
    expect(textOf()).toContain('Adopted 2 builds')
  })

  test('is idempotent across reconnects — the second registration adopts nothing', () => {
    mkBuild({ ticket: 'fb-43-3333', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift' })
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })
    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })

    expect(sent.filter(s => s.text.includes('Adopted')).length).toBe(1)
  })

  test('leaves builds alone while their PM is still alive', () => {
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    const state = mkBuild({ ticket: 'fb-44-4444', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift' })
    const guest = mkSession({ tmuxName: 'sage', threadId: pmThreadId, claimThread: false })

    emit('session:bridge-registered', { sessionId: guest.sessionId, threadId: pmThreadId })

    expect(state.pmSessionId).toBe(pm.sessionId)
    expect(sent.filter(s => s.text.includes('Adopted'))).toEqual([])
  })

  test('a thread guest passes through without taking the seat', () => {
    const state = mkBuild({ ticket: 'fb-45-5555', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift' })
    const critic = mkSession({ tmuxName: 'sage', threadId: pmThreadId, sessionType: 'thread_guest', claimThread: false })

    emit('session:bridge-registered', { sessionId: critic.sessionId, threadId: pmThreadId })

    expect(state.pmSessionId).toBe('pm-dead')
    expect(sent.filter(s => s.text.includes('Adopted'))).toEqual([])
  })

  test('ignores threads with no orphaned builds', () => {
    const stranger = mkSession({ tmuxName: 'atlas', threadId: 'thread-unrelated' })
    emit('session:bridge-registered', { sessionId: stranger.sessionId, threadId: 'thread-unrelated' })
    expect(sent).toEqual([])
  })

  test('adoption followed by accept works end to end', () => {
    mkBuild({ ticket: 'fb-46-6666', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift', phase: 'awaiting_pm' })
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })

    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })
    expect(factoryAccept('fb-46-6666', successor.sessionId, true)).toEqual({ ok: true })
    expect(killed).toEqual(['drift'])
  })
})

// ---------------------------------------------------------------------------
// 4. kill --cascade
// ---------------------------------------------------------------------------

describe('factoryCascadeKill', () => {
  const pmThreadId = 'thread-pm-cascade'

  test('kills every builder the PM owns and clears the state', () => {
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    mkBuild({ ticket: 'fb-50-1111', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift', phase: 'reviewing' })
    mkBuild({ ticket: 'fb-51-2222', pmThreadId, pmSessionId: pm.sessionId, builderName: 'flint', phase: 'building' })

    expect(factoryCascadeKill(pm.sessionId)).toBe(2)

    expect(killed.sort()).toEqual(['drift', 'flint'])
    expect(factory.builds.size).toBe(0)
    expect(factory.builderSessionToTicket.size).toBe(0)
    expect(factory.builderThreadToTicket.size).toBe(0)
  })

  test('reaches builds still pointing at a dead predecessor in the same thread', () => {
    const successor = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    mkBuild({ ticket: 'fb-52-3333', pmThreadId, pmSessionId: 'pm-dead', builderName: 'drift' })

    expect(factoryCascadeKill(successor.sessionId)).toBe(1)
    expect(killed).toEqual(['drift'])
  })

  test('does not touch builds belonging to another thread', () => {
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    mkBuild({ ticket: 'fb-53-4444', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift' })
    mkBuild({ ticket: 'fb-54-5555', pmThreadId: 'thread-other-pm', pmSessionId: 'pm-other', builderName: 'flint' })

    expect(factoryCascadeKill(pm.sessionId)).toBe(1)
    expect(killed).toEqual(['drift'])
    expect(factory.builds.has('fb-54-5555')).toBe(true)
  })

  test('returns zero for a PM with nothing in flight', () => {
    const pm = mkSession({ tmuxName: 'glyph', threadId: 'thread-pm-empty' })
    expect(factoryCascadeKill(pm.sessionId)).toBe(0)
    expect(killed).toEqual([])
  })

  test('does not report the builder it just retired as a crash', () => {
    // killSession emits session:death synchronously, and the gentle handler runs
    // onBuilderDeath on the way through. If cascade killed before moving the
    // build to a terminal phase, that read a live phase and cried "crashed".
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    const state = mkBuild({ ticket: 'fb-56-7777', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift', phase: 'reviewing' })
    factory.setLifecycle({
      killSession: async (info: SessionInfo) => {
        killed.push(info.tmuxName)
        registry.delete(info.sessionId)
        emit('session:death', { sessionId: info.sessionId, threadId: info.threadId, wasOwner: true, tmuxName: info.tmuxName })
      },
    })

    factoryCascadeKill(pm.sessionId)

    expect(killed).toEqual(['drift'])
    expect(state.phase).toBe('failed')
    expect(textOf()).not.toContain('crashed')
  })

  test('a cascade leaves nothing for the gentle death handler to report', () => {
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    mkBuild({ ticket: 'fb-55-6666', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift' })

    factoryCascadeKill(pm.sessionId)
    sent = []
    registry.delete(pm.sessionId)
    emit('session:death', { sessionId: pm.sessionId, threadId: pmThreadId, wasOwner: true, tmuxName: 'glyph' })

    expect(sent.filter(s => s.text.includes('PM session ended'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. send_to_thread redirect
// ---------------------------------------------------------------------------

// Injected rather than driven through the global registry: the daemon under
// test shares its state file with the operator's live daemon, whose real
// sessions carry the very catalog names these cases need to resolve by.

type FakeSession = { sessionId: string; tmuxName: string; threadId: string; deadAt?: number }

function fakeRegistry(sessions: FakeSession[]) {
  const byId = new Map(sessions.map(s => [s.sessionId, s as unknown as SessionInfo]))
  // Mirrors the real registry: every entry claims its thread as it loads or
  // spawns, so later entries overwrite earlier ones. A restart leaves a dead
  // session still holding the mapping until a successor takes the thread.
  const byThread = new Map(sessions.map(s => [s.threadId, s.sessionId]))
  return {
    values: () => byId.values(),
    get: (id: string) => byId.get(id),
    getByThread: (threadId: string) => byThread.get(threadId),
  }
}

// Entries are `name` or `name@<startedAt>` — the timestamp matters only where a
// test needs to pin which occupancy is the most recent.
function fakeThreads(history: Record<string, string[]>) {
  const threads = new Map<string, ThreadMetadata>(
    Object.entries(history).map(([threadId, names]) => [threadId, {
      threadId,
      topic: 'fake',
      respawnCount: 0,
      createdAt: 0,
      lastActive: 0,
      totalMessages: 0,
      sessionHistory: names.map((entry, i) => {
        const [tmuxName, at] = entry.split('@')
        return {
          sessionId: `h-${threadId}-${i}`, tmuxName, originType: 'spawn' as const,
          startedAt: at ? Number(at) : i, messageCount: 0,
        }
      }),
    }]),
  )
  return { threads }
}

describe('resolveSendTarget', () => {
  test('resolves a live session by name', () => {
    const reg = fakeRegistry([{ sessionId: 's-drift', tmuxName: 'drift', threadId: 'thread-live' }])
    const resolved = resolveSendTarget('drift', reg, fakeThreads({}))
    expect(resolved?.session.sessionId).toBe('s-drift')
    expect(resolved?.replaced).toBeUndefined()
  })

  test('redirects to the live occupant when the named session was killed off the registry', () => {
    // killSession removes the entry outright — the thread's history is the only
    // record that "spark" ever sat in this thread.
    const reg = fakeRegistry([{ sessionId: 's-glyph', tmuxName: 'glyph', threadId: 'thread-rotated' }])
    const resolved = resolveSendTarget('spark', reg, fakeThreads({ 'thread-rotated': ['spark', 'glyph'] }))
    expect(resolved?.session.sessionId).toBe('s-glyph')
    expect(resolved?.replaced).toBe('spark')
  })

  test('redirects when the named session is still registered but flagged dead', () => {
    // The daemon-restart case: tmux was gone at load, so deadAt is set and the
    // entry survives in the registry.
    const reg = fakeRegistry([
      { sessionId: 's-spark', tmuxName: 'spark', threadId: 'thread-restarted', deadAt: 1 },
      { sessionId: 's-glyph', tmuxName: 'glyph', threadId: 'thread-restarted' },
    ])
    const resolved = resolveSendTarget('spark', reg, fakeThreads({}))
    expect(resolved?.session.sessionId).toBe('s-glyph')
    expect(resolved?.replaced).toBe('spark')
  })

  test('prefers the live session of that exact name over any redirect', () => {
    const reg = fakeRegistry([
      { sessionId: 's-glyph', tmuxName: 'glyph', threadId: 'thread-recycled' },
      { sessionId: 's-drift-new', tmuxName: 'drift', threadId: 'thread-drift-new' },
    ])
    const resolved = resolveSendTarget('drift', reg, fakeThreads({ 'thread-recycled': ['drift', 'glyph'] }))
    expect(resolved?.session.sessionId).toBe('s-drift-new')
    expect(resolved?.replaced).toBeUndefined()
  })

  test('returns undefined when the thread has no live occupant', () => {
    const reg = fakeRegistry([])
    expect(resolveSendTarget('spark', reg, fakeThreads({ 'thread-empty': ['spark'] }))).toBeUndefined()
  })

  test('picks the most recent occupancy when a recycled name spans threads', () => {
    // "spark" sat in an old thread and later in a newer one, and both threads
    // still have live occupants. The newer seat is the one the sender means.
    const reg = fakeRegistry([
      { sessionId: 's-old-seat', tmuxName: 'moss', threadId: 'thread-old' },
      { sessionId: 's-new-seat', tmuxName: 'glyph', threadId: 'thread-new' },
    ])
    const threads = fakeThreads({
      'thread-old': ['spark@1000', 'moss@2000'],
      'thread-new': ['spark@8000', 'glyph@9000'],
    })
    expect(resolveSendTarget('spark', reg, threads)?.session.sessionId).toBe('s-new-seat')

    // ...and the same holds when map insertion order puts the newer one first,
    // so the result comes from the ranking rather than iteration order.
    const reversed = fakeThreads({
      'thread-new': ['spark@8000', 'glyph@9000'],
      'thread-old': ['spark@1000', 'moss@2000'],
    })
    expect(resolveSendTarget('spark', reg, reversed)?.session.sessionId).toBe('s-new-seat')
  })

  test('falls through to an older thread when the newest has no live occupant', () => {
    const reg = fakeRegistry([{ sessionId: 's-old-seat', tmuxName: 'moss', threadId: 'thread-old' }])
    const threads = fakeThreads({
      'thread-old': ['spark@1000', 'moss@2000'],
      'thread-new': ['spark@8000'],
    })
    expect(resolveSendTarget('spark', reg, threads)?.session.sessionId).toBe('s-old-seat')
  })

  test('does not redirect to the corpse still holding its own thread mapping', () => {
    const reg = fakeRegistry([{ sessionId: 's-spark', tmuxName: 'spark', threadId: 'thread-vacant', deadAt: 1 }])
    expect(resolveSendTarget('spark', reg, fakeThreads({ 'thread-vacant': ['spark'] }))).toBeUndefined()
  })

  test('never reports a redirect when the successor carries the same name', () => {
    // A dead entry and its live replacement share a name after tmux recycling.
    const reg = fakeRegistry([
      { sessionId: 's-old', tmuxName: 'spark', threadId: 'thread-same', deadAt: 1 },
      { sessionId: 's-new', tmuxName: 'spark', threadId: 'thread-same' },
    ])
    const resolved = resolveSendTarget('spark', reg, fakeThreads({}))
    expect(resolved?.session.sessionId).toBe('s-new')
    expect(resolved?.replaced).toBeUndefined()
  })

  test('returns undefined for a name nobody ever had', () => {
    expect(resolveSendTarget('never-existed-xyz', fakeRegistry([]), fakeThreads({}))).toBeUndefined()
  })
})
