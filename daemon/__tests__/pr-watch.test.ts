import { describe, test, expect, afterEach } from 'bun:test'
import { deliverPrUpdate, parsePrUrl, maxId, WATCH_ERRORS, watchPr, unwatchPr, restoreWatches, listWatches, type WatchEntry } from '../pr-watch.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { fakeCodexAdapter } from './test-harness.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// parsePrUrl
// ---------------------------------------------------------------------------

describe('parsePrUrl', () => {
  test('parses standard GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/sf8193/hydra/pull/33')).toEqual({
      owner: 'sf8193', repo: 'hydra', prNumber: 33,
    })
  })

  test('parses URL with trailing slash', () => {
    expect(parsePrUrl('https://github.com/owner/repo/pull/123/')).toEqual({
      owner: 'owner', repo: 'repo', prNumber: 123,
    })
  })

  test('parses URL with extra path segments', () => {
    expect(parsePrUrl('https://github.com/owner/repo/pull/42/files')).toEqual({
      owner: 'owner', repo: 'repo', prNumber: 42,
    })
  })

  test('returns null for non-GitHub URL', () => {
    expect(parsePrUrl('https://gitlab.com/owner/repo/pull/1')).toBeNull()
  })

  test('returns null for GitHub URL without pull path', () => {
    expect(parsePrUrl('https://github.com/owner/repo/issues/5')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parsePrUrl('')).toBeNull()
  })

  test('returns null for malformed URL', () => {
    expect(parsePrUrl('not a url')).toBeNull()
  })

  test('parses URL with hyphenated owner and repo', () => {
    expect(parsePrUrl('https://github.com/my-org/my-repo/pull/999')).toEqual({
      owner: 'my-org', repo: 'my-repo', prNumber: 999,
    })
  })
})

// ---------------------------------------------------------------------------
// maxId
// ---------------------------------------------------------------------------

describe('maxId', () => {
  test('returns max id from array', () => {
    expect(maxId([{ id: 1 }, { id: 5 }, { id: 3 }])).toBe(5)
  })

  test('returns 0 for empty array', () => {
    expect(maxId([])).toBe(0)
  })

  test('returns 0 for null', () => {
    expect(maxId(null)).toBe(0)
  })

  test('returns 0 for non-array', () => {
    expect(maxId('not an array' as any)).toBe(0)
  })

  test('handles items with missing id', () => {
    expect(maxId([{ id: 10 }, { name: 'no id' }, { id: 3 }])).toBe(10)
  })

  test('single item', () => {
    expect(maxId([{ id: 42 }])).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// WATCH_ERRORS
// ---------------------------------------------------------------------------

describe('WATCH_ERRORS', () => {
  test('PR_CLOSED formats with url and state', () => {
    expect(WATCH_ERRORS.PR_CLOSED('https://github.com/o/r/pull/1', 'merged'))
      .toBe('PR https://github.com/o/r/pull/1 is merged — provide a URL for the current PR')
  })

  test('INVALID_URL formats with url', () => {
    expect(WATCH_ERRORS.INVALID_URL('https://enterprise.git/foo'))
      .toBe('detected URL from current branch but it doesn\'t look like a GitHub PR: https://enterprise.git/foo')
  })

  test('static error messages are strings', () => {
    expect(typeof WATCH_ERRORS.NO_SESSION).toBe('string')
    expect(typeof WATCH_ERRORS.NO_CWD).toBe('string')
    expect(typeof WATCH_ERRORS.NO_PR).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Watch map operations (real module map; seeded via restoreWatches, no network)
// ---------------------------------------------------------------------------

describe('watch map operations', () => {
  const URL1 = 'https://github.com/o/r/pull/1'

  function seed(prUrl: string, sessionId: string) {
    restoreWatches([{ prUrl, owner: 'o', repo: 'r', prNumber: 1, sessionId, threadId: 'thread-1', lastCheckedAt: '', lastReviewCommentId: 0, lastIssueCommentId: 0, lastReviewId: 0, lastHeadSha: '', lastCheckStatus: 'unknown', createdAt: Date.now() } as WatchEntry], sessionId, 'thread-1')
  }
  const watched = (prUrl: string) => listWatches().some(w => w.prUrl === prUrl)

  afterEach(() => { unwatchPr(URL1) })

  test('duplicate watch returns already watching, without replacing the owner', async () => {
    seed(URL1, 'sess-1')
    expect(await watchPr(URL1, 'sess-2', 'thread-2')).toBe(`already watching ${URL1} (session: sess-1)`)
    expect(listWatches().find(w => w.prUrl === URL1)!.sessionId).toBe('sess-1')
  })

  test('invalid URL throws', async () => {
    await expect(watchPr('https://not-github.com/foo', 's', 't')).rejects.toThrow('invalid PR URL')
  })

  test('unwatch removes entry', () => {
    seed(URL1, 'sess-1')
    expect(unwatchPr(URL1, 'sess-1')).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })

  test('unwatch non-existent returns not watching', () => {
    expect(unwatchPr('https://github.com/o/r/pull/999')).toBe('not watching https://github.com/o/r/pull/999')
  })

  test('unwatch by wrong session is rejected', () => {
    seed(URL1, 'sess-1')
    expect(unwatchPr(URL1, 'sess-2')).toBe('cannot unwatch — owned by session sess-1')
    expect(watched(URL1)).toBe(true)
  })

  test('unwatch by main session is allowed', () => {
    seed(URL1, 'sess-1')
    expect(unwatchPr(URL1, 'main')).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })

  test('unwatch without callerSessionId is allowed', () => {
    seed(URL1, 'sess-1')
    expect(unwatchPr(URL1)).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })
})

describe('deliverPrUpdate (the real production wiring, not a simulation)', () => {
  let delivered: string[]

  function codexSession(sessionId: string, opts: { deadAt?: number } = {}) {
    delivered = []
    registry.set(sessionId, {
      sessionId, engine: 'codex', threadId: 'thread-1', ...opts,
      // A real Codex adapter (it owns the piggyback buffer) with only its
      // one-turn delivery faked.
      // A dead record's app-server socket is gone (the runtime stamps deadAt then).
      adapter: Object.assign(fakeCodexAdapter({ isConnected: () => !opts.deadAt }), {
        deliverTurn: async (_i: any, m: any) => { delivered.push(m.content); return { status: 'accepted' } },
      }),
    } as any)
  }

  // registry is a module-level singleton shared by the whole bun test
  // process, not reset between files. These adapters deliberately omit
  // usage() (they only need deliver()) — left behind, they're exactly the
  // shape that broke list-display.test.ts's isAlive()-filtered registry
  // scan in CI (order-dependent: only reproduced when this file happened
  // to run first on CI's file ordering, never locally on macOS's).
  afterEach(() => {
    for (const id of ['pr-s1', 'pr-s2', 'pr-s3']) registry.delete(id)
  })

  // Claude sessions deliver through their adapter onto the bridge socket — a
  // fake socket, not the codex mock, is what proves "delivered immediately."
  function claudeSession(sessionId: string): string[] {
    const written: string[] = []
    registry.set(sessionId, {
      sessionId, engine: 'claude', threadId: 'thread-1',
      adapter: new ClaudeEngine(transport),
    } as any)
    transport.set(sessionId, { sessionId, socket: { write: (d: string) => { written.push(d); return true }, end() {}, destroyed: false }, buf: '' } as any)
    return written
  }

  test('a codex session buffers instead of firing its own turn', () => {
    codexSession('pr-s1')
    deliverPrUpdate('pr-s1', 'thread-1', 'CI failed on PR #1')
    expect(delivered).toEqual([]) // not delivered yet — buffered
    // Prove it's actually buffered (not dropped) by piggybacking a real turn onto it.
    transport.sendOrQueue('pr-s1', { type: 'notification', content: 'real user message', allowPiggyback: true })
    expect(delivered[0]).toContain('CI failed on PR #1')
  })

  test('a claude session gets it immediately, not buffered', () => {
    const written = claudeSession('pr-s2')
    deliverPrUpdate('pr-s2', 'thread-1', 'CI failed on PR #2')
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('CI failed on PR #2')
  })

  // Dead: rejected outright — neither buffered for a turn that will never come
  // nor delivered (Sam, 2026-09-28: PR notices may be lost).
  test('a dead codex session neither buffers nor delivers', () => {
    codexSession('pr-s3', { deadAt: Date.now() })
    deliverPrUpdate('pr-s3', 'thread-1', 'CI failed on PR #3')
    expect(delivered).toEqual([])
    const info = registry.get('pr-s3') as any
    expect(info.adapter.piggyback.begin('pr-s3')).toBeUndefined()
  })

  test('an unknown session id does not throw', () => {
    delivered = []
    expect(() => deliverPrUpdate('no-such-session', 'thread-1', 'content')).not.toThrow()
  })
})
