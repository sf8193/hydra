// Factory QoL — what the PM thread looks like while builds run and after they end.
//
// The invariant under test: a PM thread accumulates one status board, not one
// message per builder per tick, and a finished build leaves behind exactly one
// record of itself — no duplicated summary, no orphaned thread, no orphaned
// spawn announcement.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { __test as factoryTest, formatBuildLine, factoryAccept } from '../factory.js'
import { __test as runnerTest, protocolEvents } from '../protocol-runner.js'
import type { ProtocolRun } from '../protocol-runner.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'

if (!factoryTest) throw new Error('factory.__test only available under NODE_ENV=test')
if (!runnerTest) throw new Error('protocol-runner.__test only available under NODE_ENV=test')
const factory = factoryTest
const runner = runnerTest

// ---------------------------------------------------------------------------
// Isolation — same shape as factory-resilience.test.ts
// ---------------------------------------------------------------------------

let origStderrWrite: typeof process.stderr.write
let origRegistryPersist: typeof registry.persist
let origThreadPersist: typeof threadRegistry.persist
let origQueuePersist: unknown
const origGateway: Record<string, unknown> = {}

type Sent = { channelId: string; text: string }
type Edit = { channelId: string; messageId: string; text: string }

let sent: Sent[] = []
let edits: Edit[] = []
let deletedMessages: Array<{ channelId: string; messageId: string }> = []
let deletedThreads: string[] = []
let editShouldFail = false

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

function stub(name: string, impl: unknown): void {
  origGateway[name] = (gateway as any)[name]
  ;(gateway as any)[name] = impl
}

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any

  sent = []
  edits = []
  deletedMessages = []
  deletedThreads = []
  editShouldFail = false

  stub('send', async (channelId: string, text: string) => {
    sent.push({ channelId, text })
    return { id: `msg-${sent.length}`, channelId }
  })
  stub('edit', async (channelId: string, messageId: string, text: string) => {
    if (editShouldFail) throw new Error('Unknown Message')
    edits.push({ channelId, messageId, text })
    return messageId
  })
  stub('delete', async (channelId: string, messageId: string) => {
    deletedMessages.push({ channelId, messageId })
  })
  stub('deleteThread', async (threadId: string) => { deletedThreads.push(threadId) })
  stub('getMessageUrl', (threadId: string, messageId: string) => `https://chat.test/${threadId}/${messageId}`)
  stub('fetchChannel', async () => { throw new Error('not stubbed for this case') })
  stub('getThreadStarterInfo', async () => null)

  factory.setLifecycle({
    killSession: async (_info: SessionInfo) => {},
  })
})

afterEach(async () => {
  // killBuilder chains thread + anchor deletion off the kill promise.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

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
  for (const runId of [...runner.runs.keys()]) runner.runs.delete(runId)
  for (const threadId of [...runner.threadToRun.keys()]) runner.threadToRun.delete(threadId)
  for (const [name, impl] of Object.entries(origGateway)) (gateway as any)[name] = impl
  process.stderr.write = origStderrWrite
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let idSeq = 0

function mkSession(opts: { tmuxName: string; threadId: string; sessionId?: string }): SessionInfo {
  const sessionId = opts.sessionId ?? `qol-sess-${++idSeq}`
  const info: SessionInfo = {
    sessionId,
    topic: `topic for ${opts.tmuxName}`,
    threadId: opts.threadId,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: opts.tmuxName,
    listening: false,
    sessionType: 'thread_owner',
  }
  registry.set(sessionId, info)
  trackedSessions.add(sessionId)
  registry.setThread(opts.threadId, sessionId)
  trackedThreads.add(opts.threadId)
  return info
}

function mkBuild(opts: {
  ticket: string
  pmThreadId: string
  builderName: string
  phase?: 'building' | 'reviewing' | 'awaiting_pm'
  spec?: string
  reviewed?: boolean
  reviewSummary?: string
  reviewMessageId?: string
}) {
  const builderThreadId = `qol-thread-${opts.builderName}`
  const builder = mkSession({ tmuxName: opts.builderName, threadId: builderThreadId })
  builder.sessionType = 'factory_builder'
  return factory.seedBuild({
    ticket: opts.ticket,
    pmThreadId: opts.pmThreadId,
    pmSessionId: `qol-pm-${opts.pmThreadId}`,
    spec: opts.spec ?? 'implement the thing',
    phase: opts.phase ?? 'building',
    builderSessionId: builder.sessionId,
    builderThreadId,
    ...(opts.reviewed !== undefined ? { reviewed: opts.reviewed } : {}),
    ...(opts.reviewSummary ? { reviewSummary: opts.reviewSummary } : {}),
    ...(opts.reviewMessageId ? { reviewMessageId: opts.reviewMessageId } : {}),
  })
}

/** A PM session occupying the PM thread, so thread-scoped auth admits it. */
function mkPm(pmThreadId: string, name = 'glyph'): SessionInfo {
  const pm = mkSession({ tmuxName: name, threadId: pmThreadId })
  return pm
}

/** Seed a live review run so the round pull has something to read. */
function mkReviewRun(threadId: string, currentRound: number, rounds: number, protocol = 'review'): void {
  const id = `run-${threadId}`
  runner.runs.set(id, {
    id,
    protocol: { name: protocol },
    threadId,
    phase: 'owner_turn',
    currentRound,
    rounds,
  } as unknown as ProtocolRun)
  runner.threadToRun.set(threadId, id)
}

/**
 * Let every fire-and-forget board write land.
 *
 * Board writes are serialized per PM thread, so a burst drains over as many
 * turns as there are writes — flushing a fixed number of microtasks would
 * race the tail of the chain.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 4; j++) await Promise.resolve()
    const pending = [...factory.boards.values()].map(b => b.writeTail).filter(Boolean)
    if (pending.length === 0) return
    await Promise.all(pending)
  }
  throw new Error('board writes did not drain')
}

/** The message ID of a PM thread's board, if one has been posted. */
function boardId(pmThreadId: string): string | undefined {
  return factory.boards.get(pmThreadId)?.messageId
}

function boardWrites(): string[] {
  return [...sent.filter(s => s.text.startsWith('🏭 Factory')).map(s => s.text), ...edits.map(e => e.text)]
}

// ---------------------------------------------------------------------------
// 1. Edit-in-place progress board
// ---------------------------------------------------------------------------

describe('progress board', () => {
  test('the first tick posts one message and every later tick edits it', async () => {
    const pmThreadId = 'qol-pm-thread-1'
    mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-40-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6' })

    factory.tickProgress(pmThreadId)
    await settle()

    expect(sent).toHaveLength(1)
    expect(sent[0].channelId).toBe(pmThreadId)
    expect(sent[0].text).toStartWith('🏭 Factory · 1 active')
    expect(boardId(pmThreadId)).toBe('msg-1')

    // A tick that would render the same text does not spend an edit on it.
    factory.tickProgress(pmThreadId)
    await settle()
    expect(edits).toHaveLength(0)

    // Once something moves, the same message is edited — never a second one.
    mkBuild({ ticket: 'fb-40-2222', pmThreadId, builderName: 'flint', spec: 'dashboard P2+P3' })
    factory.tickProgress(pmThreadId)
    await settle()

    expect(sent).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(edits[0].messageId).toBe('msg-1')
    expect(edits[0].channelId).toBe(pmThreadId)
    expect(edits[0].text).toStartWith('🏭 Factory · 2 active')
  })

  test('builds sharing a PM thread share one board with a line each', async () => {
    const pmThreadId = 'qol-pm-thread-2'
    mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-41-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6' })
    mkBuild({ ticket: 'fb-42-2222', pmThreadId, builderName: 'flint', spec: 'dashboard P2+P3' })

    factory.tickProgress(pmThreadId)
    await settle()

    expect(sent).toHaveLength(1)
    const lines = sent[0].text.split('\n')
    expect(lines[0]).toBe('🏭 Factory · 2 active')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('drift · divergences #5+#6')
    expect(lines[2]).toContain('flint · dashboard P2+P3')
  })

  test('builds in different PM threads get their own board', async () => {
    mkPm('qol-pm-thread-3a', 'glyph')
    mkPm('qol-pm-thread-3b', 'cedar')
    mkBuild({ ticket: 'fb-43-1111', pmThreadId: 'qol-pm-thread-3a', builderName: 'drift' })
    mkBuild({ ticket: 'fb-44-2222', pmThreadId: 'qol-pm-thread-3b', builderName: 'flint' })

    factory.tickProgress('qol-pm-thread-3a')
    factory.tickProgress('qol-pm-thread-3b')
    await settle()

    expect(sent.map(s => s.channelId)).toEqual(['qol-pm-thread-3a', 'qol-pm-thread-3b'])
    expect(boardId('qol-pm-thread-3a')).toBe('msg-1')
    expect(boardId('qol-pm-thread-3b')).toBe('msg-2')
  })

  test('a board the PM deleted is re-posted on the next tick', async () => {
    const pmThreadId = 'qol-pm-thread-4'
    mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-45-1111', pmThreadId, builderName: 'drift' })

    factory.tickProgress(pmThreadId)
    await settle()
    expect(boardId(pmThreadId)).toBe('msg-1')

    editShouldFail = true
    mkBuild({ ticket: 'fb-45-9999', pmThreadId, builderName: 'flint' })
    factory.tickProgress(pmThreadId)
    await settle()

    expect(edits).toHaveLength(0)
    expect(sent).toHaveLength(2)
    expect(boardId(pmThreadId)).toBe('msg-2')
  })

  test('a transient edit failure keeps the board instead of duplicating it', async () => {
    const pmThreadId = 'qol-pm-thread-4b'
    mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-45-2222', pmThreadId, builderName: 'drift' })

    factory.tickProgress(pmThreadId)
    await settle()
    expect(sent).toHaveLength(1)

    // A rate-limit or a 403 is not a deleted message.
    ;(gateway as any).edit = async () => { throw Object.assign(new Error('rate limited'), { code: 429 }) }
    mkBuild({ ticket: 'fb-45-8888', pmThreadId, builderName: 'flint' })
    factory.tickProgress(pmThreadId)
    await settle()

    expect(sent).toHaveLength(1)
    expect(boardId(pmThreadId)).toBe('msg-1')
  })

  test('writes land in the order they were dispatched', async () => {
    const pmThreadId = 'qol-pm-thread-4c'
    mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-45-3333', pmThreadId, builderName: 'drift' })

    factory.tickProgress(pmThreadId)
    await settle()

    // Make the first edit resolve slowly so an unordered implementation would
    // let the second overtake it.
    let call = 0
    ;(gateway as any).edit = async (channelId: string, messageId: string, text: string) => {
      const delay = ++call === 1 ? 20 : 0
      await new Promise(r => setTimeout(r, delay))
      edits.push({ channelId, messageId, text })
      return messageId
    }

    factory.transitionFactoryPhase(state, 'reviewing')
    factory.transitionFactoryPhase(state, 'awaiting_pm')
    await settle()

    expect(edits).toHaveLength(2)
    expect(edits[0].text).toContain('reviewing')
    expect(edits[1].text).toContain('awaiting_pm')
  })

  test('a phase change repaints an existing board but never conjures one', async () => {
    const pmThreadId = 'qol-pm-thread-5'
    mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-46-1111', pmThreadId, builderName: 'drift' })

    // No board yet — a build that starts and finishes between ticks stays quiet.
    factory.transitionFactoryPhase(state, 'reviewing')
    await settle()
    expect(sent).toHaveLength(0)

    factory.tickProgress(pmThreadId)
    await settle()
    expect(sent).toHaveLength(1)

    factory.transitionFactoryPhase(state, 'awaiting_pm')
    await settle()
    expect(edits).toHaveLength(1)
    expect(edits[0].text).toContain('awaiting_pm')
  })

  test('a review round advancing repaints the board without waiting for a tick', async () => {
    const pmThreadId = 'qol-pm-thread-6'
    mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-47-1111', pmThreadId, builderName: 'drift', phase: 'reviewing' })
    mkReviewRun(state.builderThreadId!, 1, 3)

    factory.tickProgress(pmThreadId)
    await settle()
    expect(sent[0].text).toContain('round 1/3')

    mkReviewRun(state.builderThreadId!, 2, 3)
    protocolEvents.emitPhaseChange({
      protocol: 'review', threadId: state.builderThreadId!, phase: 'owner_turn',
    })
    await settle()

    expect(edits).toHaveLength(1)
    expect(edits[0].text).toContain('round 2/3')
  })

  test('a phase change in an unrelated thread leaves the board alone', async () => {
    const pmThreadId = 'qol-pm-thread-7'
    mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-48-1111', pmThreadId, builderName: 'drift' })

    factory.tickProgress(pmThreadId)
    await settle()

    protocolEvents.emitPhaseChange({
      protocol: 'review', threadId: 'some-other-thread', phase: 'critic_turn',
    })
    await settle()

    expect(edits).toHaveLength(0)
  })

  test('a build finishing mid-post still reaches the completion summary', async () => {
    const pmThreadId = 'qol-pm-thread-26'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-54-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6' })

    // Hold the board's first post open so the accept lands inside the window.
    let release: () => void = () => {}
    const held = new Promise<void>(r => { release = r })
    ;(gateway as any).send = async (channelId: string, text: string) => {
      await held
      sent.push({ channelId, text })
      return { id: `msg-${sent.length}`, channelId }
    }

    factory.tickProgress(pmThreadId)
    await Promise.resolve()

    factory.transitionFactoryPhase(state, 'awaiting_pm')
    state.reviewed = true
    expect(factoryAccept('fb-54-1111', pm.sessionId)).toEqual({ ok: true })

    release()
    await settle()

    // The closing board must name what finished, not be an empty header.
    const board = edits.at(-1)!
    expect(board.text).toStartWith('🏭 Factory · complete')
    expect(board.text).toContain('✅ 🌊 drift · divergences #5+#6')
  })

  test('a board stays inside one message however many builds it has outlived', async () => {
    const pmThreadId = 'qol-pm-thread-8b'
    const pm = mkPm(pmThreadId)
    // A long-running build holds the thread open so the board never finalizes.
    mkBuild({ ticket: 'fb-keep-0000', pmThreadId, builderName: 'keeper', spec: 'long runner' })
    factory.tickProgress(pmThreadId)
    await settle()

    for (let i = 1; i <= 40; i++) {
      mkBuild({
        ticket: `fb-9${String(i).padStart(2, '0')}-1111`, pmThreadId, builderName: `hand${i}`,
        phase: 'awaiting_pm', reviewed: true, spec: `batch job number ${i} of the run`,
      })
      expect(factoryAccept(`fb-9${String(i).padStart(2, '0')}-1111`, pm.sessionId)).toEqual({ ok: true })
    }
    await settle()

    // History is bounded rather than growing one line per build forever.
    expect(factory.boards.get(pmThreadId)!.finished.length).toBeLessThanOrEqual(factory.BOARD_HISTORY_CAP)

    const keeper = factory.builds.get('fb-keep-0000')!
    factory.transitionFactoryPhase(keeper, 'awaiting_pm')
    keeper.reviewed = true
    expect(factoryAccept('fb-keep-0000', pm.sessionId)).toEqual({ ok: true })
    await settle()

    // An over-length edit throws and reads as a deleted message, which would
    // re-post the board on every tick — the wall of messages this replaces.
    const board = edits.filter(e => e.messageId === 'msg-1').at(-1)!
    expect(board.text.length).toBeLessThanOrEqual(gateway.maxMessageLength)
    expect(board.text).toStartWith('🏭 Factory · complete')
    // Most recent survive, oldest are dropped.
    expect(board.text).toContain('hand40')
    expect(board.text).not.toContain('hand1 ·')
  })

  test('a board too long to fit drops lines and says how many', async () => {
    const pmThreadId = 'qol-pm-thread-8c'
    const pm = mkPm(pmThreadId)
    const longSpec = 'refactor the entire ingestion pipeline end to end again'
    mkBuild({ ticket: 'fb-keep-0001', pmThreadId, builderName: 'keeper', spec: longSpec })
    factory.tickProgress(pmThreadId)
    await settle()

    // Worst-case lines: a full-width spec tag on every entry, at the cap.
    for (let i = 1; i <= 25; i++) {
      mkBuild({
        ticket: `fb-8${String(i).padStart(2, '0')}-1111`, pmThreadId,
        builderName: `verylongbuildername${i}`, phase: 'awaiting_pm', reviewed: true, spec: longSpec,
      })
      expect(factoryAccept(`fb-8${String(i).padStart(2, '0')}-1111`, pm.sessionId)).toEqual({ ok: true })
    }
    const keeper = factory.builds.get('fb-keep-0001')!
    factory.transitionFactoryPhase(keeper, 'awaiting_pm')
    keeper.reviewed = true
    expect(factoryAccept('fb-keep-0001', pm.sessionId)).toEqual({ ok: true })
    await settle()

    const board = edits.filter(e => e.messageId === 'msg-1').at(-1)!
    expect(board.text.length).toBeLessThanOrEqual(gateway.maxMessageLength)
    // The note leads, because the lines kept are the most recent ones.
    expect(board.text).toMatch(/^🏭 Factory · complete\n {2}…and \d+ earlier\n/)
  })

  test('a line that has stopped updating carries no numbers that would rot', async () => {
    const pmThreadId = 'qol-pm-thread-27'
    mkPm(pmThreadId)
    const waiting = mkBuild({
      ticket: 'fb-55-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6',
    })
    mkBuild({ ticket: 'fb-55-2222', pmThreadId, builderName: 'flint', spec: 'dashboard P2+P3' })

    factory.startProgressUpdates(pmThreadId)
    factory.tickProgress(pmThreadId)
    await settle()
    expect(sent[0].text).toMatch(/drift · divergences #5\+#6 · building · \d+[smh]/)

    factory.transitionFactoryPhase(waiting, 'awaiting_pm')
    await settle()

    const board = edits.at(-1)!.text.split('\n')
    const driftLine = board.find(l => l.includes('drift'))!
    const flintLine = board.find(l => l.includes('flint'))!
    // Minute- and percent-granular values are dropped: on a line that is no
    // longer being repainted they would read as current.
    expect(driftLine).not.toMatch(/ · \d+[smh] /)
    expect(driftLine).not.toContain('ctx ')
    // The decision deadline stays — coarse enough not to mislead, and its own
    // countdown is what keeps the ticker alive to refresh it. Trails the ticket,
    // matching how adoption notices render the same deadline.
    expect(driftLine).toMatch(/^ {2}🌊 drift · divergences #5\+#6 · awaiting_pm \(fb-55\) · decide within \d+[hd]$/)
    // The build still working keeps its clock and context.
    expect(flintLine).toMatch(/flint · dashboard P2\+P3 · building · \d+[smh]/)
  })

  test('the ticker follows lines that move on their own, and only those', async () => {
    const pmThreadId = 'qol-pm-thread-22'
    mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-51-1111', pmThreadId, builderName: 'drift' })

    // spawnBuilder arms the ticker; seedBuild bypasses spawn.
    factory.startProgressUpdates(pmThreadId)
    factory.tickProgress(pmThreadId)
    await settle()
    expect(factory.boards.get(pmThreadId)!.timer).toBeDefined()

    // awaiting_pm is finished work waiting on a human, but it now carries a
    // decision deadline that counts down — so the line still moves.
    factory.transitionFactoryPhase(state, 'awaiting_pm')
    await settle()
    factory.tickProgress(pmThreadId)
    expect(factory.boards.get(pmThreadId)!.timer).toBeDefined()
    expect(edits.at(-1)!.text).toContain('decide within')

    // A retry puts work back in flight, so the ticker stays with it.
    factory.transitionFactoryPhase(state, 'building')
    await settle()
    expect(factory.boards.get(pmThreadId)!.timer).toBeDefined()
  })

  test('the ticker stops when no line can move on its own', async () => {
    const pmThreadId = 'qol-pm-thread-22b'
    mkPm(pmThreadId)
    // Seeded straight into awaiting_pm, so no decision deadline was ever armed
    // — the shape a build restored from a restart lands in.
    mkBuild({ ticket: 'fb-51-2222', pmThreadId, builderName: 'drift', phase: 'awaiting_pm' })

    factory.startProgressUpdates(pmThreadId)
    factory.tickProgress(pmThreadId)
    await settle()

    expect(factory.boards.get(pmThreadId)!.timer).toBeUndefined()
    // Nothing was posted either: only a tick may create a board, and this tick
    // had nothing to keep refreshing.
    expect(boardWrites()).toHaveLength(0)
  })

  test('the board is not left behind once its thread is done with it', async () => {
    const pmThreadId = 'qol-pm-thread-23'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-52-1111', pmThreadId, builderName: 'drift' })

    factory.tickProgress(pmThreadId)
    await settle()
    expect(factory.boards.has(pmThreadId)).toBe(true)

    factory.transitionFactoryPhase(state, 'awaiting_pm')
    state.reviewed = true
    expect(factoryAccept('fb-52-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    // Message, ticker, history and write chain all retire together — the
    // closing write must not resurrect an entry to queue itself on.
    expect(factory.boards.has(pmThreadId)).toBe(false)
  })

  test('a non-review protocol in the builder thread leaves the board alone', async () => {
    const pmThreadId = 'qol-pm-thread-25'
    mkPm(pmThreadId)
    const state = mkBuild({ ticket: 'fb-53-1111', pmThreadId, builderName: 'drift', phase: 'reviewing' })

    factory.startProgressUpdates(pmThreadId)
    factory.tickProgress(pmThreadId)
    await settle()

    protocolEvents.emitPhaseChange({
      protocol: 'build', threadId: state.builderThreadId!, phase: 'implement',
    })
    await settle()

    expect(edits).toHaveLength(0)
  })

  test('the board closes out as a completion summary once nothing is in flight', async () => {
    const pmThreadId = 'qol-pm-thread-8'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-49-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6',
    })

    factory.tickProgress(pmThreadId)
    await settle()
    expect(sent).toHaveLength(1)

    factory.transitionFactoryPhase(state, 'awaiting_pm')
    state.reviewed = true
    await settle()

    expect(factoryAccept('fb-49-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    const board = edits.filter(e => e.messageId === 'msg-1').at(-1)!
    expect(board.text).toStartWith('🏭 Factory · complete')
    // The ✅ carries the outcome, so the line does not also spell out the phase.
    expect(board.text).toMatch(/ {2}✅ 🌊 drift · divergences #5\+#6 · \d+[smh] \(fb-49\)/)
    expect(board.text).not.toContain('· complete (fb-49)')
    // The board is retired with the last build, not left ticking.
    // The board is retired wholesale — message, ticker and history together.
    expect(factory.boards.has(pmThreadId)).toBe(false)
  })

  test('no board was posted means no completion summary is posted either', async () => {
    const pmThreadId = 'qol-pm-thread-9'
    const pm = mkPm(pmThreadId)
    mkBuild({ ticket: 'fb-50-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: true })

    expect(factoryAccept('fb-50-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(boardWrites()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Round-level visibility
// ---------------------------------------------------------------------------

describe('review round in the status line', () => {
  test('a build under review reports the live round from its protocol run', () => {
    const state = mkBuild({
      ticket: 'fb-60-1111', pmThreadId: 'qol-pm-thread-10', builderName: 'drift',
      phase: 'reviewing', spec: 'divergences #5+#6',
    })
    mkReviewRun(state.builderThreadId!, 2, 3)

    expect(formatBuildLine(state, { includeRound: true }))
      .toBe('🌊 drift · divergences #5+#6 · reviewing · round 2/3 (fb-60)')
  })

  test('omitPhase drops the phase segment and nothing else', () => {
    const state = mkBuild({
      ticket: 'fb-64-1111', pmThreadId: 'qol-pm-thread-13b', builderName: 'drift',
      phase: 'reviewing', spec: 'divergences #5+#6',
    })
    expect(formatBuildLine(state)).toBe('🌊 drift · divergences #5+#6 · reviewing (fb-64)')
    expect(formatBuildLine(state, { omitPhase: true })).toBe('🌊 drift · divergences #5+#6 (fb-64)')
  })

  test('round is opt-in, so messages that only name the build stay unchanged', () => {
    const state = mkBuild({
      ticket: 'fb-61-1111', pmThreadId: 'qol-pm-thread-11', builderName: 'drift', phase: 'reviewing',
    })
    mkReviewRun(state.builderThreadId!, 2, 3)

    expect(formatBuildLine(state)).not.toContain('round')
  })

  test('no round is shown outside the reviewing phase', () => {
    const state = mkBuild({
      ticket: 'fb-62-1111', pmThreadId: 'qol-pm-thread-12', builderName: 'drift', phase: 'building',
    })
    mkReviewRun(state.builderThreadId!, 2, 3)

    expect(formatBuildLine(state, { includeRound: true })).not.toContain('round')
  })

  test('a non-review run in the builder thread is not read as a review round', () => {
    const state = mkBuild({
      ticket: 'fb-65-1111', pmThreadId: 'qol-pm-thread-13c', builderName: 'drift', phase: 'reviewing',
    })
    mkReviewRun(state.builderThreadId!, 2, 3, 'build')

    expect(formatBuildLine(state, { includeRound: true })).not.toContain('round')
  })

  test('no round is shown when the run is already torn down', () => {
    const state = mkBuild({
      ticket: 'fb-63-1111', pmThreadId: 'qol-pm-thread-13', builderName: 'drift', phase: 'reviewing',
    })

    expect(formatBuildLine(state, { includeRound: true })).not.toContain('round')
  })
})

// ---------------------------------------------------------------------------
// 3. Accept links to the review summary
// ---------------------------------------------------------------------------

describe('accept', () => {
  test('links to the review message instead of reprinting the summary', async () => {
    const pmThreadId = 'qol-pm-thread-14'
    const pm = mkPm(pmThreadId)
    mkBuild({
      ticket: 'fb-70-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm',
      spec: 'divergences #5+#6', reviewed: true,
      reviewSummary: 'CONFIRMED: the retry path double-counts attempts',
      reviewMessageId: 'review-msg-77',
    })

    expect(factoryAccept('fb-70-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    const accept = sent.find(s => s.text.startsWith('🏭 ✅'))!
    expect(accept.text).toContain(`[review](https://chat.test/${pmThreadId}/review-msg-77)`)
    expect(accept.text).toContain('drift · divergences #5+#6')
    expect(accept.text).not.toContain('CONFIRMED')
  })

  test('the accept line names the build, then the event, then the link', async () => {
    const pmThreadId = 'qol-pm-thread-14b'
    const pm = mkPm(pmThreadId)
    mkBuild({
      ticket: 'fb-74-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm',
      spec: 'divergences #5+#6', reviewed: true, reviewMessageId: 'review-msg-77',
    })

    expect(factoryAccept('fb-74-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(sent.find(s => s.text.startsWith('🏭 ✅'))!.text).toBe(
      `🏭 ✅ 🌊 drift · divergences #5+#6 (fb-74) — accepted · [review](https://chat.test/${pmThreadId}/review-msg-77)`,
    )
  })

  test('falls back to a bare confirmation when there is no review message to link', async () => {
    const pmThreadId = 'qol-pm-thread-15'
    const pm = mkPm(pmThreadId)
    mkBuild({
      ticket: 'fb-71-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm',
      spec: 'divergences #5+#6', reviewed: true,
    })

    expect(factoryAccept('fb-71-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    const accept = sent.find(s => s.text.startsWith('🏭 ✅'))!
    expect(accept.text).not.toContain('[review]')
    expect(accept.text).toContain('drift · divergences #5+#6')
  })

  test('an unreviewed accept still says so', async () => {
    const pmThreadId = 'qol-pm-thread-16'
    const pm = mkPm(pmThreadId)
    mkBuild({
      ticket: 'fb-72-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: false,
    })

    expect(factoryAccept('fb-72-1111', pm.sessionId, true)).toEqual({ ok: true })
    await settle()

    expect(sent.find(s => s.text.startsWith('🏭 ✅'))!.text).toContain('(unreviewed)')
  })

  test('review completion records the message ID the next accept links to', async () => {
    const pmThreadId = 'qol-pm-thread-17'
    mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-73-1111', pmThreadId, builderName: 'drift', phase: 'reviewing', spec: 'divergences #5+#6',
    })

    protocolEvents.emitComplete({
      protocol: 'review',
      threadId: state.builderThreadId!,
      rounds: { completed: 3, requested: 3 },
      outcome: 'complete',
      decisions: [],
      durationMs: 1000,
      summary: 'CONFIRMED: nothing blocking',
    })
    await settle()

    const reviewMsg = sent.findIndex(s => s.text.includes('review complete'))
    expect(reviewMsg).toBeGreaterThanOrEqual(0)
    expect(state.reviewMessageId).toBe(`msg-${reviewMsg + 1}`)
  })
})

// ---------------------------------------------------------------------------
// 4. Full builder destruction
// ---------------------------------------------------------------------------

describe('builder destruction', () => {
  test('accept deletes the builder thread and the spawn announcement it hangs from', async () => {
    const pmThreadId = 'qol-pm-thread-18'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-80-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: true,
    })
    threadRegistry.threads.set(state.builderThreadId!, {
      threadId: state.builderThreadId!,
      parentChannelId: 'parent-channel',
      anchorMessageId: 'anchor-msg-9',
      topic: 'builder',
      respawnCount: 0,
      createdAt: Date.now(),
      lastActive: Date.now(),
      totalMessages: 0,
      sessionHistory: [],
    })
    trackedThreads.add(state.builderThreadId!)

    expect(factoryAccept('fb-80-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(deletedThreads).toEqual([state.builderThreadId!])
    expect(deletedMessages).toEqual([{ channelId: 'parent-channel', messageId: 'anchor-msg-9' }])
  })

  test('a post-mortem line still names the builder after the registry drops it', async () => {
    const pmThreadId = 'qol-pm-thread-24'
    mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-90-1111', pmThreadId, builderName: 'drift', spec: 'divergences #5+#6',
    })
    state.builderName = 'drift'

    // killSession deletes the session entry before session:death is emitted,
    // so every crash message renders against a registry that no longer has it.
    registry.delete(state.builderSessionId!)

    expect(formatBuildLine(state, { omitPhase: true })).toBe('🌊 drift · divergences #5+#6 (fb-90)')
  })

  test('the anchor is resolved from the builder session when thread metadata has none', async () => {
    const pmThreadId = 'qol-pm-thread-19'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-81-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: true,
    })
    const builder = registry.get(state.builderSessionId!)!
    builder.anchorChannelId = 'parent-from-session'
    builder.anchorMessageId = 'anchor-from-session'
    // The real killSession drops the session entry, which is why the anchor is
    // captured before the kill rather than after it.
    factory.setLifecycle({
      killSession: async (info: SessionInfo) => { registry.delete(info.sessionId) },
    })

    expect(factoryAccept('fb-81-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(deletedMessages).toEqual([
      { channelId: 'parent-from-session', messageId: 'anchor-from-session' },
    ])
  })

  test('an unresolvable anchor is asked of the platform, then let go', async () => {
    const pmThreadId = 'qol-pm-thread-20'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-82-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: true,
    })
    // A deleted thread cannot be described. Both lookups read the thread
    // itself, so asking after the delete can only ever fail — which is what
    // makes the ordering load-bearing rather than incidental.
    const gone = () => deletedThreads.includes(state.builderThreadId!)
    ;(gateway as any).fetchChannel = async (id: string) => {
      if (gone()) throw new Error('Unknown Channel')
      return { id, isDM: false, isThread: true, parentId: 'parent-from-platform', recipientId: '', sendable: true }
    }
    ;(gateway as any).getThreadStarterInfo = async () => {
      if (gone()) throw new Error('Unknown Channel')
      return { threadName: 'builder', starterUser: 'hydra', starterContent: '⚡ spawned', starterId: 'anchor-from-platform' }
    }

    expect(factoryAccept('fb-82-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(deletedThreads).toEqual([state.builderThreadId!])
    expect(deletedMessages).toEqual([
      { channelId: 'parent-from-platform', messageId: 'anchor-from-platform' },
    ])
  })

  test('a failed thread deletion does not go on to delete the anchor', async () => {
    const pmThreadId = 'qol-pm-thread-21'
    const pm = mkPm(pmThreadId)
    const state = mkBuild({
      ticket: 'fb-83-1111', pmThreadId, builderName: 'drift', phase: 'awaiting_pm', reviewed: true,
    })
    threadRegistry.threads.set(state.builderThreadId!, {
      threadId: state.builderThreadId!,
      parentChannelId: 'parent-channel',
      anchorMessageId: 'anchor-msg-9',
      topic: 'builder',
      respawnCount: 0,
      createdAt: Date.now(),
      lastActive: Date.now(),
      totalMessages: 0,
      sessionHistory: [],
    })
    trackedThreads.add(state.builderThreadId!)
    ;(gateway as any).deleteThread = async () => { throw new Error('Missing Access') }

    expect(factoryAccept('fb-83-1111', pm.sessionId)).toEqual({ ok: true })
    await settle()

    expect(deletedMessages).toEqual([])
  })
})
