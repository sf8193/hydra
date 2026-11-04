// resolveSendTarget — a session name addresses a seat in a thread, not a process.
//
// Named sessions die and are replaced; a sender who addresses the name that has
// just been retired means whoever holds that seat now. These cases pin the walk
// that finds them: live session first, then the threads the name has occupied,
// most recent occupancy first.
//
// Both registries are injected rather than driven through the global ones: the
// daemon under test shares its state file with the operator's live daemon, whose
// real sessions carry the very catalog names these cases need to resolve by.

import { describe, test, expect } from 'bun:test'
import { resolveSendTarget } from '../sessions.js'
import type { SessionInfo, ThreadMetadata } from '../sessions.js'

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
