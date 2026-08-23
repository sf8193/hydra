import { describe, test, expect } from 'bun:test'
import { workKey, dedupForRecovery } from '../recovery.js'
import { SESSION_NAMES, type SessionInfo } from '../sessions.js'
import { restoreWatches, getWatchesBySession, unwatchBySession, type WatchEntry } from '../pr-watch.js'

// workKey drives auto-recovery dedup: two dead sessions sharing a PR/ticket must
// map to the same key so only one is revived (the "two sessions on one PR" bug).

describe('workKey — recovery dedup keying', () => {
  test('PR URL in artifacts → pr identity key', () => {
    expect(workKey({ artifacts: ['https://github.com/angellist/treasury/pull/9516'] }))
      .toBe('pr:angellist/treasury#9516')
  })

  test('two sessions on the same PR share a key (dedup target)', () => {
    const a = workKey({ artifacts: ['https://github.com/angellist/nova/pull/42'] })
    const b = workKey({ artifacts: ['https://github.com/angellist/nova/pull/42', 'https://claude.ai/public/artifacts/abc'] })
    expect(a).toBe(b)
  })

  test('PR wins over ticket when both present', () => {
    expect(workKey({
      artifacts: ['https://github.com/angellist/treasury/pull/1'],
      topic: 'BANK-1750 classifier fix',
    })).toBe('pr:angellist/treasury#1')
  })

  test('ticket from topic when no PR', () => {
    expect(workKey({ topic: 'BANK-1750 classifier fix + last thing' })).toBe('ticket:BANK-1750')
  })

  test('ticket from description when topic has none', () => {
    expect(workKey({ topic: 'session', description: 'NOVA-3786 matchmaking staging' }))
      .toBe('ticket:NOVA-3786')
  })

  test('non-PR github/claude artifact links do not produce a PR key', () => {
    expect(workKey({ artifacts: ['https://claude.ai/public/artifacts/xyz'] })).toBeNull()
  })

  test('no PR and no ticket → null (always unique, never deduped)', () => {
    expect(workKey({ topic: 'refactor the thing', description: 'general cleanup' })).toBeNull()
  })

  test('non-ticket tokens mid-text do NOT produce a false ticket key', () => {
    // Loose \b matching would collide these on ticket:UTF-8 / ticket:SHA-256 and
    // wrongly skip recoverable sessions. Only a LEADING token counts.
    expect(workKey({ topic: 'fix the UTF-8 decoding bug' })).toBeNull()
    expect(workKey({ topic: 'validate SHA-256 checksums', description: 'handle ISO-8601 dates' })).toBeNull()
  })

  test('empty session → null', () => {
    expect(workKey({})).toBeNull()
  })
})

// baseNameFromBranch peels `wt/<name>[-<suffix>]` → `<name>` by splitting on '-', which is
// only correct if catalog session names are hyphen-free. Guard the invariant here so a future
// hyphenated name fails CI instead of silently reserving the wrong branch token.
describe('SESSION_CATALOG naming invariant', () => {
  test('no catalog name contains a hyphen (baseNameFromBranch relies on this)', () => {
    expect(SESSION_NAMES.filter(n => n.includes('-'))).toEqual([])
  })
})

// dedupForRecovery is the higher-risk logic: winner/loser selection, sibling-watch handoff,
// null-key uniqueness. In the test env no candidate's tmux is alive, so `liveKeys` stays empty
// for these synthetic PR keys and the byKey (dead-vs-dead) path is exercised directly.
describe('dedupForRecovery — winner/loser + sibling watches', () => {
  const mk = (fields: Partial<SessionInfo> & { sessionId: string }): SessionInfo => ({
    threadId: `${fields.sessionId}-thread`,
    tmuxName: `tmux_${fields.sessionId.replace(/[^a-z0-9]/gi, '')}`,
    topic: '',
    createdAt: 0,
    lastActive: 0,
    sessionType: 'thread_owner',
    ...fields,
  }) as SessionInfo

  test('two dead sessions on the same PR collapse to one winner (most-recently-active)', async () => {
    const older = mk({ sessionId: 'dd-older', artifacts: ['https://github.com/testorg/testrepo/pull/70001'], lastActive: 100 })
    const newer = mk({ sessionId: 'dd-newer', artifacts: ['https://github.com/testorg/testrepo/pull/70001'], lastActive: 200 })
    // input order reversed to prove the lastActive sort — not input order — picks the winner
    const { unique, skipped } = await dedupForRecovery([older, newer])
    expect(unique.map(u => u.sessionId)).toEqual(['dd-newer'])
    expect(skipped.map(s => s.info.sessionId)).toEqual(['dd-older'])
    expect(skipped[0].reason).toContain('same work as')
  })

  test('null-key sessions are never deduped (always unique)', async () => {
    const a = mk({ sessionId: 'nk-a', topic: 'refactor the thing' })
    const b = mk({ sessionId: 'nk-b', topic: 'general cleanup' })
    const { unique, skipped } = await dedupForRecovery([a, b])
    expect(unique).toHaveLength(2)
    expect(skipped).toHaveLength(0)
  })

  test('distinct PR keys all survive', async () => {
    const a = mk({ sessionId: 'dk-a', artifacts: ['https://github.com/testorg/testrepo/pull/70011'] })
    const b = mk({ sessionId: 'dk-b', artifacts: ['https://github.com/testorg/testrepo/pull/70012'] })
    const { unique, skipped } = await dedupForRecovery([a, b])
    expect(unique).toHaveLength(2)
    expect(skipped).toHaveLength(0)
  })

  test('a skipped sibling\'s PR watches (with cursors) are handed to the winner', async () => {
    const winner = mk({ sessionId: 'sw-winner', artifacts: ['https://github.com/testorg/testrepo/pull/70021'], lastActive: 200 })
    const loser = mk({ sessionId: 'sw-loser', artifacts: ['https://github.com/testorg/testrepo/pull/70021'], lastActive: 100 })
    const entry: WatchEntry = {
      prUrl: 'https://github.com/testorg/testrepo/pull/70021', owner: 'testorg', repo: 'testrepo', prNumber: 70021,
      sessionId: loser.sessionId, threadId: loser.threadId,
      lastCheckedAt: 'T', lastReviewCommentId: 5, lastIssueCommentId: 6, lastReviewId: 7,
      lastHeadSha: 'abc', lastCheckStatus: 'success', createdAt: 0,
    }
    restoreWatches([entry], loser.sessionId, loser.threadId)
    try {
      const { unique, skipped, siblingWatches } = await dedupForRecovery([winner, loser])
      expect(unique.map(u => u.sessionId)).toEqual(['sw-winner'])
      expect(skipped.map(s => s.info.sessionId)).toEqual(['sw-loser'])
      const handed = siblingWatches.get(winner.sessionId)
      expect(handed?.map(w => w.prUrl)).toContain('https://github.com/testorg/testrepo/pull/70021')
      expect(handed?.[0].lastReviewCommentId).toBe(5)  // cursor preserved through the handoff
    } finally {
      unwatchBySession(loser.sessionId)
      unwatchBySession(winner.sessionId)
    }
  })
})
