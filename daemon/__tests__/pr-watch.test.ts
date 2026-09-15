import { describe, test, expect, beforeEach } from 'bun:test'
import { deliverPrUpdate } from '../pr-watch.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// We can't import the module directly because it pulls in config/gateway/registry.
// Instead, extract and test the pure logic by re-implementing the key functions here.
// This mirrors the actual implementations in pr-watch.ts.

// ---------------------------------------------------------------------------
// parsePrUrl
// ---------------------------------------------------------------------------

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (match) {
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3]) }
  }
  return null
}

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

function maxId(items: any[] | null): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0
  return Math.max(...items.map((i: any) => i.id ?? 0))
}

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

const WATCH_ERRORS = {
  NO_SESSION: 'bare `watch` only works in a session thread — provide a PR URL',
  NO_CWD: 'no URL provided and could not determine session cwd — provide a PR URL',
  NO_PR: 'no open PR found on current branch — provide a PR URL',
  PR_CLOSED: (url: string, state: string) => `PR ${url} is ${state} — provide a URL for the current PR`,
  INVALID_URL: (url: string) => `detected URL from current branch but it doesn't look like a GitHub PR: ${url}`,
} as const

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
// State check case-insensitivity
// ---------------------------------------------------------------------------

describe('PR state check', () => {
  function isOpen(state: string): boolean {
    return state.toLowerCase() === 'open'
  }

  test('OPEN (uppercase from GitHub API)', () => {
    expect(isOpen('OPEN')).toBe(true)
  })

  test('open (lowercase)', () => {
    expect(isOpen('open')).toBe(true)
  })

  test('Open (mixed case)', () => {
    expect(isOpen('Open')).toBe(true)
  })

  test('CLOSED is not open', () => {
    expect(isOpen('CLOSED')).toBe(false)
  })

  test('MERGED is not open', () => {
    expect(isOpen('MERGED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Watch CRUD logic (in-memory, no network)
// ---------------------------------------------------------------------------

describe('watch map operations', () => {
  let watches: Map<string, any>

  beforeEach(() => {
    watches = new Map()
  })

  function watchPr(prUrl: string, sessionId: string, threadId: string) {
    if (watches.has(prUrl)) {
      return `already watching ${prUrl} (session: ${watches.get(prUrl).sessionId})`
    }
    const parsed = parsePrUrl(prUrl)
    if (!parsed) throw new Error(`invalid PR URL: ${prUrl}`)
    watches.set(prUrl, { prUrl, sessionId, threadId, ...parsed, createdAt: Date.now() })
    return `watching ${prUrl}`
  }

  function unwatchPr(prUrl: string, callerSessionId?: string) {
    const entry = watches.get(prUrl)
    if (!entry) return `not watching ${prUrl}`
    if (callerSessionId && callerSessionId !== entry.sessionId && callerSessionId !== 'main') {
      return `cannot unwatch — owned by session ${entry.sessionId}`
    }
    watches.delete(prUrl)
    return `stopped watching ${prUrl}`
  }

  test('watch adds entry', () => {
    const result = watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    expect(result).toBe('watching https://github.com/o/r/pull/1')
    expect(watches.size).toBe(1)
  })

  test('duplicate watch returns already watching', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    const result = watchPr('https://github.com/o/r/pull/1', 'sess-2', 'thread-2')
    expect(result).toContain('already watching')
    expect(watches.size).toBe(1)
  })

  test('invalid URL throws', () => {
    expect(() => watchPr('https://not-github.com/foo', 's', 't')).toThrow('invalid PR URL')
  })

  test('unwatch removes entry', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    const result = unwatchPr('https://github.com/o/r/pull/1', 'sess-1')
    expect(result).toBe('stopped watching https://github.com/o/r/pull/1')
    expect(watches.size).toBe(0)
  })

  test('unwatch non-existent returns not watching', () => {
    expect(unwatchPr('https://github.com/o/r/pull/999')).toBe('not watching https://github.com/o/r/pull/999')
  })

  test('unwatch by wrong session is rejected', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    const result = unwatchPr('https://github.com/o/r/pull/1', 'sess-2')
    expect(result).toContain('cannot unwatch')
    expect(watches.size).toBe(1)
  })

  test('unwatch by main session is allowed', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    const result = unwatchPr('https://github.com/o/r/pull/1', 'main')
    expect(result).toBe('stopped watching https://github.com/o/r/pull/1')
    expect(watches.size).toBe(0)
  })

  test('unwatch without callerSessionId is allowed', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    const result = unwatchPr('https://github.com/o/r/pull/1')
    expect(result).toBe('stopped watching https://github.com/o/r/pull/1')
  })

  test('multiple watches for different PRs', () => {
    watchPr('https://github.com/o/r/pull/1', 'sess-1', 'thread-1')
    watchPr('https://github.com/o/r/pull/2', 'sess-1', 'thread-1')
    watchPr('https://github.com/o/r/pull/3', 'sess-2', 'thread-2')
    expect(watches.size).toBe(3)
  })
})

describe('deliverPrUpdate (the real production wiring, not a simulation)', () => {
  let delivered: string[]

  function codexSession(sessionId: string, opts: { deadAt?: number } = {}) {
    delivered = []
    registry.set(sessionId, {
      sessionId, engine: 'codex', threadId: 'thread-1', ...opts,
      adapter: {
        provider: 'codex', deliveryIsFree: false,
        deliver: async (_i: any, text: string) => { delivered.push(text); return { status: 'accepted' } },
      },
    } as any)
  }

  // Claude sessions deliver via a bridge socket, not adapter.deliver() — a
  // fake socket, not the codex mock, is what proves "delivered immediately."
  function claudeSession(sessionId: string): string[] {
    const written: string[] = []
    registry.set(sessionId, {
      sessionId, engine: 'claude', threadId: 'thread-1',
      adapter: { provider: 'claude', deliveryIsFree: true, deliver: async () => ({ status: 'accepted' }) },
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

  test('a dead codex session does not get buffered — the !info.deadAt guard is live', () => {
    codexSession('pr-s3', { deadAt: Date.now() })
    deliverPrUpdate('pr-s3', 'thread-1', 'CI failed on PR #3')
    // Falls through to the immediate path (dead sessions aren't piggyback-eligible);
    // whether that immediate send actually reaches anyone is transport's problem,
    // not this function's — the guard's job is just "don't buffer for a dead session."
    expect(delivered).toEqual(['CI failed on PR #3'])
  })

  test('an unknown session id does not throw', () => {
    delivered = []
    expect(() => deliverPrUpdate('no-such-session', 'thread-1', 'content')).not.toThrow()
  })
})
