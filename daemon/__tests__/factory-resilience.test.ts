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
  factoryStatus,
  onBuilderDeath,
} from '../factory.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
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
    // A death delivered INSIDE the cascade frame — stricter than production,
    // where killSession awaits a gateway.send before emitting. Pins the
    // phase-before-kill ordering: move the transition after killBuilder and the
    // handler sees a live phase and cries "crashed".
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

  test('drops the reverse lookup before the kill can report back', () => {
    // The actual mechanism. cleanupState must have removed builderSessionToTicket
    // by the time the cascade frame closes, because that is what a later
    // session:death fails to resolve. Observed mid-kill so a cleanupState moved
    // after the emit would be caught.
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    const state = mkBuild({ ticket: 'fb-58-9999', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift' })
    const builderSessionId = state.builderSessionId!

    factoryCascadeKill(pm.sessionId)

    expect(factory.builderSessionToTicket.has(builderSessionId)).toBe(false)
    expect(factory.builderThreadToTicket.has(state.builderThreadId!)).toBe(false)
    expect(factory.builds.has(state.ticket)).toBe(false)
  })

  test('a crash in an unrelated build is still reported during a cascade', () => {
    // No "a cascade is running" suppression may leak across tickets: a genuine
    // builder crash elsewhere has to keep reporting while this one tears down.
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    mkBuild({ ticket: 'fb-71-cccc', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift' })
    const bystander = mkBuild({ ticket: 'fb-72-dddd', pmThreadId: 'thread-other-pm', pmSessionId: 'pm-other', builderName: 'flint', phase: 'building' })

    factoryCascadeKill(pm.sessionId)
    sent = []
    onBuilderDeath(bystander.builderSessionId!)

    expect(bystander.phase).toBe('failed')
    expect(textOf()).toContain('crashed')
    expect(factory.builds.has(bystander.ticket)).toBe(false)
  })

  test('a death event that arrives after the cascade loop is still not a crash', () => {
    // Production's actual shape: the real killSession awaits before emitting, so
    // the death lands after the cascade frame closed. cleanupState has already
    // cleared builderSessionToTicket, so the handler cannot resolve a ticket —
    // the assertion below records that this is what makes it safe.
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    const state = mkBuild({ ticket: 'fb-59-aaaa', pmThreadId, pmSessionId: pm.sessionId, builderName: 'drift', phase: 'building' })
    const builderSessionId = state.builderSessionId!
    let fireDeath: (() => void) | undefined
    factory.setLifecycle({
      killSession: async (info: SessionInfo) => {
        killed.push(info.tmuxName)
        registry.delete(info.sessionId)
        fireDeath = () => emit('session:death', { sessionId: info.sessionId, threadId: info.threadId, wasOwner: true, tmuxName: info.tmuxName })
      },
    })

    factoryCascadeKill(pm.sessionId)
    sent = []
    fireDeath!()

    expect(killed).toEqual(['drift'])
    expect(textOf()).not.toContain('crashed')
    expect(factory.builderSessionToTicket.has(builderSessionId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. awaiting_pm TTL
// ---------------------------------------------------------------------------
//
// awaiting_pm is the phase with no clock of its own: the builder is idle and
// the entry lives until a PM decides. A PM that never returns used to leak it
// for the life of the daemon.

describe('awaiting_pm TTL', () => {
  const pmThreadId = 'thread-pm-ttl'

  function awaiting(ticket: string, builderName = 'drift') {
    const pm = mkSession({ tmuxName: 'glyph', threadId: pmThreadId })
    const state = mkBuild({ ticket, pmThreadId, pmSessionId: pm.sessionId, builderName, phase: 'building' })
    factory.transitionFactoryPhase(state, 'awaiting_pm')
    state.reviewed = true
    return { pm, state }
  }

  test('the window is 24 hours', () => {
    expect(factory.AWAITING_PM_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })

  // The three cases below drive the REAL setTimeout through a shrunken window.
  // Asserting on state._awaitingPmTimer alone was not enough: a hardcoded wrong
  // delay, a dead callback, and a clearAwaitingPmTtl that never called
  // clearTimeout each left the whole suite green.
  const TICK = 12

  test('the armed timer actually fires and expires the build', async () => {
    factory.setAwaitingPmTtl(TICK)
    const { state } = awaiting('fb-80-1111')
    expect(factory.builds.has('fb-80-1111')).toBe(true)
    sent = []

    await new Promise(r => setTimeout(r, TICK * 6))

    expect(textOf()).toContain('`fb-80-1111` expired — no PM action after 24h')
    expect(state.phase).toBe('failed')
    expect(factory.builds.has('fb-80-1111')).toBe(false)
  })

  test('the configured window is the delay actually passed to setTimeout', async () => {
    // A hardcoded delay ignores the override: either it fires early with the
    // real 24h constant replaced, or not at all. Pin that the override governs.
    factory.setAwaitingPmTtl(60_000)
    const { state } = awaiting('fb-81-2222')
    sent = []

    await new Promise(r => setTimeout(r, TICK * 6))

    expect(state.phase).toBe('awaiting_pm')
    expect(textOf()).not.toContain('expired')
    expect(factory.builds.has('fb-81-2222')).toBe(true)
  })

  test('accept genuinely cancels the timer — no expiry post lands later', async () => {
    // Catches a disarm that nulls the field without calling clearTimeout: the
    // handle stays live and posts "expired" on a build the PM already accepted.
    factory.setAwaitingPmTtl(TICK)
    const { pm, state } = awaiting('fb-82-3333')
    expect(factoryAccept(state.ticket, pm.sessionId)).toEqual({ ok: true })
    sent = []

    await new Promise(r => setTimeout(r, TICK * 6))

    expect(textOf()).not.toContain('expired')
    expect(state.phase).toBe('complete')
  })

  test('adoption inherits the clock and tells the successor what is left', () => {
    // The window measures how long work may sit undecided, not how long any one
    // PM has looked at it — so adopting must NOT restart it (a thread rotating
    // PMs faster than the window would keep a build alive forever). The
    // successor is told the inherited deadline instead of silently getting it.
    const { state } = awaiting('fb-86-7777')
    const armedAt = state._awaitingPmSince
    const timer = state._awaitingPmTimer
    registry.delete(state.pmSessionId)   // PM gone, build orphaned
    sent = []

    const successor = mkSession({ tmuxName: 'flint', threadId: pmThreadId })
    emit('session:bridge-registered', { sessionId: successor.sessionId, threadId: pmThreadId })

    expect(state.pmSessionId).toBe(successor.sessionId)
    expect(state._awaitingPmSince).toBe(armedAt)     // clock not restarted
    expect(state._awaitingPmTimer).toBe(timer)       // same handle, not re-armed
    expect(textOf()).toContain('Adopted 1 build')
    expect(textOf()).toMatch(/decide within \d+[dhms]/)
  })

  test('disarming calls clearTimeout, not just a field reset', () => {
    // The field going undefined proves nothing about the handle. A disarm that
    // only nulls the field leaves a live ref'd timer for up to 24h — invisible,
    // because expireAwaitingPm's precondition then refuses to act on it. Assert
    // the handle itself is cancelled.
    const { pm, state } = awaiting('fb-84-5555')
    const handle = state._awaitingPmTimer as unknown as { hasRef(): boolean; _destroyed: boolean }
    expect(handle.hasRef()).toBe(true)

    factoryAccept(state.ticket, pm.sessionId)

    expect(state._awaitingPmTimer).toBeUndefined()
    expect(handle._destroyed).toBe(true)
    expect(handle.hasRef()).toBe(false)
  })

  test('expiry cancels its own handle rather than dropping the reference', () => {
    // expireAwaitingPm is reachable directly via the __test seam, so the handle
    // it was armed with has to be cancelled, not merely forgotten.
    const { state } = awaiting('fb-85-6666')
    const handle = state._awaitingPmTimer as unknown as { hasRef(): boolean; _destroyed: boolean }

    factory.expireAwaitingPm(state)

    expect(handle._destroyed).toBe(true)
    expect(handle.hasRef()).toBe(false)
  })

  test('a stale timer that survives cancellation cannot fail an accepted build', () => {
    // The precondition guard, direct. Even given a leaked handle, the body must
    // refuse to act on a build that is no longer awaiting a PM decision.
    const { pm, state } = awaiting('fb-83-4444')
    factoryAccept(state.ticket, pm.sessionId)
    sent = []

    factory.expireAwaitingPm(state)

    expect(textOf()).not.toContain('expired')
    expect(state.phase).toBe('complete')
  })

  test('entering the phase arms a timer', () => {
    const { state } = awaiting('fb-60-1111')
    expect(state._awaitingPmTimer).toBeDefined()
  })

  test('accept disarms it', () => {
    const { pm, state } = awaiting('fb-61-2222')
    expect(factoryAccept(state.ticket, pm.sessionId)).toEqual({ ok: true })
    expect(state._awaitingPmTimer).toBeUndefined()
  })

  test('retry disarms it', () => {
    const { pm, state } = awaiting('fb-62-3333')
    expect(factoryRetry(state.ticket, 'try again', pm.sessionId)).toEqual({ ok: true })
    expect(state.phase).toBe('building')
    expect(state._awaitingPmTimer).toBeUndefined()
  })

  test('abandon disarms it', () => {
    const { pm, state } = awaiting('fb-63-4444')
    expect(factoryAbandon(state.ticket, pm.sessionId)).toEqual({ ok: true })
    expect(state._awaitingPmTimer).toBeUndefined()
  })

  test('a retry that completes again restarts the clock rather than reusing it', () => {
    const { state } = awaiting('fb-64-5555')
    const first = state._awaitingPmTimer
    factory.transitionFactoryPhase(state, 'building')
    factory.transitionFactoryPhase(state, 'awaiting_pm')
    expect(state._awaitingPmTimer).toBeDefined()
    expect(state._awaitingPmTimer).not.toBe(first)
  })

  test('expiry reports to the PM thread, fails the build, and clears the state', () => {
    const { state } = awaiting('fb-65-6666')
    sent = []

    factory.expireAwaitingPm(state)

    expect(textOf()).toContain('`fb-65-6666` expired — no PM action after 24h')
    expect(state.phase).toBe('failed')
    expect(state._awaitingPmTimer).toBeUndefined()
    expect(factory.builds.has('fb-65-6666')).toBe(false)
    expect(factory.builderSessionToTicket.size).toBe(0)
    expect(sent.every(s => s.channelId === pmThreadId)).toBe(true)
  })

  test('expiry leaves the builder session alive — the work is not the PM decision', () => {
    const { state } = awaiting('fb-66-7777')
    const builderSessionId = state.builderSessionId!

    factory.expireAwaitingPm(state)

    expect(killed).toEqual([])
    expect(registry.get(builderSessionId)).toBeDefined()
    // Factory identity released: a plain thread_owner the operator can peek at.
    expect(registry.get(builderSessionId)!.sessionType).toBe('thread_owner')
    expect(registry.get(builderSessionId)!.factoryTicket).toBeUndefined()
  })

  test('an expired build no longer answers to accept', () => {
    const { pm, state } = awaiting('fb-67-8888')
    factory.expireAwaitingPm(state)
    expect(factoryAccept('fb-67-8888', pm.sessionId)).toEqual({ error: 'Unknown ticket: fb-67-8888' })
  })

  // The leak was only invisible because nothing listed it. factoryStatus filters
  // by PM thread and nothing else, so an orphan awaiting a decision still shows.
  test('factoryStatus surfaces an awaiting_pm build whose PM session is gone', () => {
    const { pm, state } = awaiting('fb-68-9999')
    registry.delete(pm.sessionId)

    const rows = factoryStatus(pmThreadId).builds
    expect(rows.map(b => b.ticket)).toContain('fb-68-9999')
    expect(rows.find(b => b.ticket === 'fb-68-9999')!.phase).toBe('awaiting_pm')
    expect(state.phase).toBe('awaiting_pm')
  })
})
