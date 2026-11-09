import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { gateway } from '../../../daemon/config.js'
import { parsePrUrl, maxId, WATCH_ERRORS, watchPr, unwatchPr, listWatches, parsePersistedWatches, applyCheckResult, formatWatchEntry, selectNewReviews, _setWatchForTesting, type WatchEntry, type CheckResult } from '../pr-watch.js'
import { parseWatchCommand } from '../../../daemon/commands/watch.js'
import { UNIVERSAL_TOOLS } from '../../../shared/tool-definitions.js'
import { registry } from '../../../daemon/sessions.js'
import { transport } from '../../../daemon/bridge-transport.js'

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
// Watch map operations (real module map; seeded directly, no network)
// ---------------------------------------------------------------------------

// A watch made in thread-1 delivers to thread-1, revived when its session is dead.
function seedWatch(prUrl: string, extra: Partial<WatchEntry> = {}): void {
  _setWatchForTesting({ prUrl, owner: 'o', repo: 'r', prNumber: 1, to: 'thread-1', revive: true, threadId: 'thread-1', lastCheckedAt: '', lastReviewCommentId: 0, lastIssueCommentId: 0, lastReviewId: 0, lastHeadSha: '', lastCheckStatus: 'unknown', createdAt: Date.now(), ...extra })
}

describe('watch map operations', () => {
  const URL1 = 'https://github.com/o/r/pull/1'
  const seed = (prUrl: string) => seedWatch(prUrl)
  const watched = (prUrl: string) => listWatches().some(w => w.prUrl === prUrl)

  beforeEach(() => {
    registry.set('sess-1', { sessionId: 'sess-1', threadId: 'thread-1', tmuxName: 'one' } as any)
    registry.set('sess-2', { sessionId: 'sess-2', threadId: 'thread-2', tmuxName: 'two' } as any)
  })
  afterEach(() => { unwatchPr(URL1); registry.delete('sess-1'); registry.delete('sess-2') })

  test('duplicate watch returns already watching, without replacing the target', async () => {
    seed(URL1)
    expect(await watchPr(URL1, 'sess-2', 'thread-2')).toBe(`already watching ${URL1} (→ thread thread-1)`)
    expect(listWatches().find(w => w.prUrl === URL1)!.to).toBe('thread-1')
  })

  test('invalid URL throws', async () => {
    await expect(watchPr('https://not-github.com/foo', 's', 't')).rejects.toThrow('invalid PR URL')
  })

  test('unwatch removes entry', () => {
    seed(URL1)
    expect(unwatchPr(URL1, 'sess-1')).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })

  test('unwatch non-existent returns not watching', () => {
    expect(unwatchPr('https://github.com/o/r/pull/999')).toBe('not watching https://github.com/o/r/pull/999')
  })

  test('unwatch by wrong session is rejected', () => {
    seed(URL1)
    expect(unwatchPr(URL1, 'sess-2')).toBe('cannot unwatch — it delivers to thread thread-1')
    expect(watched(URL1)).toBe(true)
  })

  test('unwatch by main session is allowed', () => {
    seed(URL1)
    expect(unwatchPr(URL1, 'main')).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })

  test('unwatch without callerSessionId is allowed', () => {
    seed(URL1)
    expect(unwatchPr(URL1)).toBe(`stopped watching ${URL1}`)
    expect(watched(URL1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Opt-in green CI notice
// ---------------------------------------------------------------------------

describe('notify-green: persistence', () => {
  const base = { prUrl: 'https://github.com/o/r/pull/7', owner: 'o', repo: 'r', prNumber: 7, to: 't', revive: true, threadId: 't', lastCheckedAt: '', lastReviewCommentId: 0, lastIssueCommentId: 0, lastReviewId: 0, createdAt: 1 }

  test('old JSON without the fields loads as opted out, with backfilled CI fields', () => {
    const [e] = parsePersistedWatches(JSON.stringify([base]))
    expect(e.notifyGreen).toBeUndefined()
    expect(!!e.notifyGreen).toBe(false)
    expect(e.greenAnnouncedSha).toBeUndefined()
    expect(e.lastHeadSha).toBe('')
    expect(e.lastCheckStatus).toBe('unknown')
  })

  test('new fields round-trip', () => {
    const entry = { ...base, lastHeadSha: 'abc', lastCheckStatus: 'success', notifyGreen: true, greenAnnouncedSha: 'abc' }
    const [e] = parsePersistedWatches(JSON.stringify([entry], null, 2))
    expect(e.notifyGreen).toBe(true)
    expect(e.greenAnnouncedSha).toBe('abc')
  })
})

describe('notify-green: watch_pr schema + upgrade path', () => {
  const URL7 = 'https://github.com/o/r/pull/7'
  const entry = () => listWatches().find(w => w.prUrl === URL7)!
  const seed = (extra: Partial<WatchEntry> = {}) => seedWatch(URL7, { prNumber: 7, ...extra })
  afterEach(() => { unwatchPr(URL7) })

  test('watch_pr declares an optional boolean notify_green', () => {
    const def = UNIVERSAL_TOOLS.find(t => t.name === 'watch_pr')! as any
    expect(def.inputSchema.properties.notify_green.type).toBe('boolean')
    expect(def.inputSchema.required ?? []).not.toContain('notify_green')
  })

  test('notify_green on an already-watched PR upgrades in place (owner + thread kept)', async () => {
    seed()
    const res = await watchPr(URL7, 'sess-2', 'thread-2', { notifyGreen: true })
    expect(res).toContain('will now post when CI goes green')
    expect(entry().notifyGreen).toBe(true)
    expect(entry().to).toBe('thread-1')
    expect(entry().threadId).toBe('thread-1')
  })

  test('plain duplicate watch keeps the existing message and never downgrades', async () => {
    seed({ notifyGreen: true })
    expect(await watchPr(URL7, 'sess-2', 'thread-2')).toBe(`already watching ${URL7} (→ thread thread-1)`)
    expect(entry().notifyGreen).toBe(true)
  })

  test('upgrade preserves a persisted greenAnnouncedSha (no re-announce)', async () => {
    seed({ notifyGreen: true, greenAnnouncedSha: 'abc' })
    await watchPr(URL7, 'sess-1', 'thread-1', { notifyGreen: true })
    expect(entry().greenAnnouncedSha).toBe('abc')
  })

  test('watches listing marks notify-green entries', () => {
    seed({ notifyGreen: true })
    expect(formatWatchEntry(entry())).toContain('🟢')
    seed({ notifyGreen: false })
    expect(formatWatchEntry(entry())).not.toContain('🟢')
  })
})

describe('notify-green: chat parse', () => {
  test.each([
    ['watch', { url: undefined, notifyGreen: false }],
    ['watch +green', { url: undefined, notifyGreen: true }],
    ['/watch +GREEN', { url: undefined, notifyGreen: true }],
    ['watch https://github.com/o/r/pull/1', { url: 'https://github.com/o/r/pull/1', notifyGreen: false }],
    ['watch https://github.com/o/r/pull/1 +green', { url: 'https://github.com/o/r/pull/1', notifyGreen: true }],
    ['watch <https://github.com/o/r/pull/1|o/r#1> +green', { url: 'https://github.com/o/r/pull/1', notifyGreen: true }],
  ] as const)('%p', (input, expected) => {
    expect(parseWatchCommand(input)).toEqual(expected as any)
  })

  test.each(['watches', 'watch +blue', 'watch green', 'unwatch https://github.com/o/r/pull/1', 'watch +green https://github.com/o/r/pull/1'])('%p does not match', input => {
    expect(parseWatchCommand(input)).toBeNull()
  })
})

describe('notify-green: delivery is a thread post, never a session turn', () => {
  let sends: Array<{ channelId: string; text: string; opts?: any }>
  let queued: number
  let sendFails = false
  // Captured lazily: config.ts creates the gateway behind a top-level await.
  let origSend: any
  const origQueue = transport.sendOrQueue
  const ok = (headSha: string): CheckResult => ({ headSha, status: 'success', failed: [], total: 4 })

  function mkEntry(extra: Partial<WatchEntry> = {}): WatchEntry {
    return { prUrl: 'https://github.com/o/r/pull/9', owner: 'o', repo: 'r', prNumber: 9, title: 'Add [thing]', to: 'thread-g', revive: true, threadId: 'thread-g', lastCheckedAt: '', lastReviewCommentId: 0, lastIssueCommentId: 0, lastReviewId: 0, lastHeadSha: '', lastCheckStatus: 'pending', createdAt: 1, notifyGreen: true, ...extra }
  }

  afterEach(() => {
    if (origSend) (gateway as any).send = origSend
    ;(transport as any).sendOrQueue = origQueue
  })
  function mock() {
    sends = []; queued = 0; sendFails = false
    origSend ??= gateway.send
    ;(gateway as any).send = async (channelId: string, text: string, opts?: any) => {
      if (sendFails) throw new Error('discord down')
      sends.push({ channelId, text, opts }); return { id: `m${sends.length}` }
    }
    ;(transport as any).sendOrQueue = () => { queued++ }
  }

  test('posts once per head in the watch thread; no transport delivery; no ciChanged', async () => {
    mock()
    const e = mkEntry()
    expect(await applyCheckResult(e, ok('abcdef1234'))).toBe(false)
    expect(sends).toHaveLength(1)
    expect(sends[0].channelId).toBe('thread-g')
    expect(sends[0].text).toBe('✅ CI green · [#9 Add thing](https://github.com/o/r/pull/9) · `abcdef1` · 4 checks passed')
    expect(e.greenAnnouncedSha).toBe('abcdef1234')
    expect(queued).toBe(0)
    await applyCheckResult(e, ok('abcdef1234'))
    expect(sends).toHaveLength(1)
    await applyCheckResult(e, { headSha: 'fff0000', status: 'pending', failed: [], total: 4 })
    await applyCheckResult(e, ok('fff0000'))
    expect(sends).toHaveLength(2)
    expect(queued).toBe(0)
  })

  test('null fetch holds state and posts nothing', async () => {
    mock()
    const e = mkEntry({ lastHeadSha: 'a', lastCheckStatus: 'pending' })
    expect(await applyCheckResult(e, null)).toBe(false)
    expect(sends).toHaveLength(0)
    expect(e.lastCheckStatus).toBe('pending')
  })

  test('a failed send leaves greenAnnouncedSha unset so the next poll retries', async () => {
    mock(); sendFails = true
    const e = mkEntry()
    await applyCheckResult(e, ok('abc'))
    expect(e.greenAnnouncedSha).toBeUndefined()
    sendFails = false
    await applyCheckResult(e, ok('abc'))
    expect(sends).toHaveLength(1)
    expect(e.greenAnnouncedSha).toBe('abc')
  })

  test('overlapping poll cycles post once', async () => {
    mock()
    const e = mkEntry()
    await Promise.all([applyCheckResult(e, ok('abc')), applyCheckResult(e, ok('abc'))])
    expect(sends).toHaveLength(1)
    expect(e.greenAnnouncedSha).toBe('abc')
  })

  test('brackets and backslashes in the title cannot break the link', async () => {
    mock()
    await applyCheckResult(mkEntry({ title: 'Fix [x] path\\' }), ok('abcdef1234'))
    expect(sends[0].text).toContain('[#9 Fix x path](https://github.com/o/r/pull/9)')
  })

  test('failure path unchanged: returns ciChanged, no green post', async () => {
    mock()
    const e = mkEntry()
    expect(await applyCheckResult(e, { headSha: 'abc', status: 'failure', failed: [{ name: 'ci', conclusion: 'failure', url: '' }], total: 1 })).toBe(true)
    expect(sends).toHaveLength(0)
  })

  test('not opted in: success posts nothing', async () => {
    mock()
    await applyCheckResult(mkEntry({ notifyGreen: undefined }), ok('abc'))
    expect(sends).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// selectNewReviews
// ---------------------------------------------------------------------------

describe('selectNewReviews', () => {
  // Regression: GitHub returns /reviews oldest-first. An old review at the head of the list
  // used to stop the scan, so a later approval with a body was never delivered.
  test('returns a new approval that follows older reviews, with its body', () => {
    const data = [
      { id: 1, user: { login: 'cursor[bot]' }, state: 'COMMENTED', body: 'x', submitted_at: '2026-11-06T15:31:23Z' },
      { id: 2, user: { login: 'cursor[bot]' }, state: 'COMMENTED', body: 'y', submitted_at: '2026-11-06T15:43:22Z' },
      { id: 3, user: { login: 'dcetlin' }, state: 'APPROVED', body: 'LGTM, nit aside', submitted_at: '2026-11-06T18:03:32Z' },
    ]
    const out = selectNewReviews(data, { lastReviewId: 2, lastCheckedAt: '2026-11-06T17:59:00Z' })
    expect(out.map(r => [r.id, r.user, r.state, r.body])).toEqual([[3, 'dcetlin', 'APPROVED', 'LGTM, nit aside']])
  })
})
