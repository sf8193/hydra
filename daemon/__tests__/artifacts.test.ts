import { describe, test, expect } from 'bun:test'
import {
  extractArtifactLinks,
  sanitizeArtifacts,
  mergeArtifacts,
  renderArtifactLink,
  renderContextLink,
  assembleContextLines,
  type WatchLine,
} from '../artifacts.js'

// ---------------------------------------------------------------------------
// extractArtifactLinks
// ---------------------------------------------------------------------------

describe('extractArtifactLinks', () => {
  test('extracts a GitHub PR URL', () => {
    expect(extractArtifactLinks('opened https://github.com/AngelList/treasury/pull/8210'))
      .toEqual(['https://github.com/AngelList/treasury/pull/8210'])
  })

  test('extracts a PR URL from Slack mrkdwn <url|label> (stops at pipe)', () => {
    expect(extractArtifactLinks('see <https://github.com/o/r/pull/5|my PR> now'))
      .toEqual(['https://github.com/o/r/pull/5'])
  })

  test('extracts an Arti design-doc URL, normalizing away the version', () => {
    expect(extractArtifactLinks('doc: https://arti.internal.angellist.com/s/mmf-architecture/124'))
      .toEqual(['https://arti.internal.angellist.com/s/mmf-architecture'])
  })

  test('extracts a Claude artifact URL', () => {
    expect(extractArtifactLinks('published https://claude.ai/public/artifacts/abc-123'))
      .toEqual(['https://claude.ai/public/artifacts/abc-123'])
  })

  test('normalizes scheme, strips anchors/query/markdown, dedupes variants', () => {
    // http→https, #anchor and trailing markdown * removed → all collapse to one canonical PR URL
    expect(extractArtifactLinks(
      'http://github.com/o/r/pull/5 and https://github.com/o/r/pull/5#discussion_r99 and **https://github.com/o/r/pull/5**',
    )).toEqual(['https://github.com/o/r/pull/5'])
  })

  test('rejects malformed artifact URLs (empty id, HTML-entity placeholder)', () => {
    expect(extractArtifactLinks('https://claude.ai/public/artifacts/')).toEqual([])
    expect(extractArtifactLinks('https://claude.ai/public/artifacts/&lt;id&gt;')).toEqual([])
  })

  test('ignores a plain repo URL with no /pull/ segment', () => {
    expect(extractArtifactLinks('https://github.com/AngelList/treasury')).toEqual([])
  })

  test('ignores non-artifact claude.ai URLs (only /public/artifacts counts)', () => {
    expect(extractArtifactLinks('https://claude.ai/chat/xyz')).toEqual([])
  })

  test('ignores GitHub issues/commit URLs (not deliverable artifacts)', () => {
    expect(extractArtifactLinks('https://github.com/o/r/issues/5')).toEqual([])
    expect(extractArtifactLinks('https://github.com/o/r/commit/deadbeef')).toEqual([])
  })

  test('ignores gists and Google Docs (dropped — never used)', () => {
    expect(extractArtifactLinks('https://gist.github.com/kevin/abc123')).toEqual([])
    expect(extractArtifactLinks('https://docs.google.com/document/d/XYZ/edit')).toEqual([])
  })

  test('ignores context-link domains (linear/slack/notion)', () => {
    const text = 'https://linear.app/x/issue/BANK-1 https://acme.slack.com/archives/C1/p123 https://notion.so/page'
    expect(extractArtifactLinks(text)).toEqual([])
  })

  test('dedupes a repeated URL', () => {
    const text = 'https://github.com/o/r/pull/9 and again https://github.com/o/r/pull/9'
    expect(extractArtifactLinks(text)).toEqual(['https://github.com/o/r/pull/9'])
  })

  test('strips trailing punctuation', () => {
    expect(extractArtifactLinks('shipped it: https://github.com/o/r/pull/9.'))
      .toEqual(['https://github.com/o/r/pull/9'])
  })

  test('does not capture wrapping quotes/brackets (JSON, backticks, parens)', () => {
    // Regression: a URL echoed inside `["...”]` must not swallow the trailing "]
    expect(extractArtifactLinks('comet.artifacts: ["https://github.com/o/r/pull/9"]'))
      .toEqual(['https://github.com/o/r/pull/9'])
    expect(extractArtifactLinks('see `https://github.com/o/r/pull/9`'))
      .toEqual(['https://github.com/o/r/pull/9'])
    expect(extractArtifactLinks("(https://github.com/o/r/pull/9)"))
      .toEqual(['https://github.com/o/r/pull/9'])
    expect(extractArtifactLinks("'https://github.com/o/r/pull/9'"))
      .toEqual(['https://github.com/o/r/pull/9'])
  })

  test('extracts multiple distinct artifacts (grouped by type)', () => {
    const text = 'PR https://github.com/o/r/pull/1 and doc https://arti.internal.angellist.com/s/design/1'
    expect(extractArtifactLinks(text)).toEqual([
      'https://github.com/o/r/pull/1',
      'https://arti.internal.angellist.com/s/design',
    ])
  })

  test('returns empty for text with no links', () => {
    expect(extractArtifactLinks('no links here')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sanitizeArtifacts — self-heals data captured before the extractor was tightened
// ---------------------------------------------------------------------------

describe('sanitizeArtifacts', () => {
  test('re-canonicalizes and drops malformed legacy entries', () => {
    const polluted = [
      'https://github.com/sf8193/hydra/pull/129',
      'https://github.com/sf8193/hydra/pull/129"]',   // trailing "] junk
      'https://github.com/sf8193/hydra/pull/129*',     // trailing markdown *
      'http://claude.ai/public/artifacts/',            // empty id → dropped
      'http://claude.ai/public/artifacts/&lt;id',      // HTML-entity placeholder → dropped
      'http://arti.internal.angellist.com/s/mmf-architecture/12', // http + version → normalized
      'https://arti.internal.angellist.com/s/mmf-architecture/124',
    ]
    expect(sanitizeArtifacts(polluted)).toEqual([
      'https://github.com/sf8193/hydra/pull/129',
      'https://arti.internal.angellist.com/s/mmf-architecture',
    ])
  })

  test('leaves already-clean entries untouched', () => {
    const clean = ['https://github.com/o/r/pull/1', 'https://claude.ai/public/artifacts/abc']
    expect(sanitizeArtifacts(clean)).toEqual(clean)
  })

  test('live-capture composition heals legacy junk (sanitize existing, then merge new)', () => {
    // Mirrors the bridge-dispatch capture path: sanitize the persisted list, merge the freshly-found URL.
    const persisted = ['https://github.com/o/r/pull/1"]', 'https://github.com/o/r/pull/1*']
    const found = extractArtifactLinks('now also https://claude.ai/public/artifacts/xyz')
    const { next } = mergeArtifacts(sanitizeArtifacts(persisted), found)
    expect(next).toEqual([
      'https://github.com/o/r/pull/1',
      'https://claude.ai/public/artifacts/xyz',
    ])
  })
})

// ---------------------------------------------------------------------------
// mergeArtifacts
// ---------------------------------------------------------------------------

describe('mergeArtifacts', () => {
  test('adds a new url and reports changed', () => {
    const r = mergeArtifacts(['a'], ['b'])
    expect(r.changed).toBe(true)
    expect(r.next).toEqual(['a', 'b'])
  })

  test('reports unchanged when all found urls are already present', () => {
    const existing = ['a', 'b']
    const r = mergeArtifacts(existing, ['a', 'b'])
    expect(r.changed).toBe(false)
    expect(r.next).toBe(existing) // returns the same reference, untouched
  })

  test('treats undefined existing as empty', () => {
    const r = mergeArtifacts(undefined, ['a'])
    expect(r.changed).toBe(true)
    expect(r.next).toEqual(['a'])
  })

  test('reports unchanged for empty found', () => {
    const r = mergeArtifacts(['a'], [])
    expect(r.changed).toBe(false)
    expect(r.next).toEqual(['a'])
  })

  test('dedupes within found and against existing', () => {
    const r = mergeArtifacts(['a'], ['b', 'b', 'a', 'c'])
    expect(r.changed).toBe(true)
    expect(r.next).toEqual(['a', 'b', 'c'])
  })

  test('caps to newest max, dropping oldest (11th unique drops the first)', () => {
    const existing = Array.from({ length: 10 }, (_, i) => `u${i}`) // u0..u9
    const r = mergeArtifacts(existing, ['u10'], 10)
    expect(r.changed).toBe(true)
    expect(r.next).toHaveLength(10)
    expect(r.next[0]).toBe('u1')      // u0 dropped
    expect(r.next[9]).toBe('u10')     // newest kept
  })

  test('at the cap boundary with no new urls, list is left unchanged', () => {
    const existing = Array.from({ length: 10 }, (_, i) => `u${i}`)
    const r = mergeArtifacts(existing, ['u5'], 10) // u5 already present
    expect(r.changed).toBe(false)
    expect(r.next).toBe(existing)
  })
})

// ---------------------------------------------------------------------------
// renderArtifactLink
// ---------------------------------------------------------------------------

describe('renderArtifactLink', () => {
  test('renders a PR as repo#num', () => {
    expect(renderArtifactLink('https://github.com/AngelList/treasury/pull/8210'))
      .toBe('• 📎 <https://github.com/AngelList/treasury/pull/8210|treasury#8210>')
  })

  test('labels an Arti doc with its slug', () => {
    expect(renderArtifactLink('https://arti.internal.angellist.com/s/mmf-architecture'))
      .toBe('• 📎 <https://arti.internal.angellist.com/s/mmf-architecture|Arti: mmf-architecture>')
  })

  test('labels a Claude artifact', () => {
    expect(renderArtifactLink('https://claude.ai/public/artifacts/abc-123'))
      .toBe('• 📎 <https://claude.ai/public/artifacts/abc-123|Claude artifact>')
  })

  test('falls back to hostname for unknown artifact URLs', () => {
    expect(renderArtifactLink('https://example.com/x')).toBe('• 📎 <https://example.com/x|example.com>')
  })
})

// ---------------------------------------------------------------------------
// renderContextLink (moved from dashboard.ts — behavior preserved)
// ---------------------------------------------------------------------------

describe('renderContextLink', () => {
  test('renders a slack channel mention', () => {
    expect(renderContextLink('slack:channel:C0ABC123:general')).toBe('• 🔗 <#C0ABC123|general>')
  })

  test('labels known domains', () => {
    expect(renderContextLink('https://linear.app/x/issue/BANK-1')).toBe('• 🔗 <https://linear.app/x/issue/BANK-1|Linear>')
    expect(renderContextLink('https://acme.slack.com/archives/C1/p1')).toBe('• 🔗 <https://acme.slack.com/archives/C1/p1|thread in <#C1>>')
    expect(renderContextLink('https://app.datadoghq.com/x')).toContain('|Datadog>')
  })
})

// ---------------------------------------------------------------------------
// assembleContextLines
// ---------------------------------------------------------------------------

const watch = (over: Partial<WatchLine> = {}): WatchLine => ({
  prUrl: 'https://github.com/o/r/pull/1',
  title: 'my PR',
  prNumber: 1,
  lastCheckStatus: 'success',
  ...over,
})

describe('assembleContextLines', () => {
  test('renders watches first with a check emoji', () => {
    const lines = assembleContextLines({ watches: [watch()], artifacts: [], contextLinks: [] })
    expect(lines).toEqual(['• <https://github.com/o/r/pull/1|my PR> ✓'])
  })

  test('appends artifacts after watches, context links last', () => {
    const lines = assembleContextLines({
      watches: [watch()],
      artifacts: ['https://arti.internal.angellist.com/s/design'],
      contextLinks: ['https://linear.app/x/issue/BANK-1'],
    })
    expect(lines).toEqual([
      '• <https://github.com/o/r/pull/1|my PR> ✓',
      '• 📎 <https://arti.internal.angellist.com/s/design|Arti: design>',
      '• 🔗 <https://linear.app/x/issue/BANK-1|Linear>',
    ])
  })

  test('dedupes a PR that is both watched and captured as an artifact (watch wins)', () => {
    const url = 'https://github.com/o/r/pull/1'
    const lines = assembleContextLines({ watches: [watch({ prUrl: url })], artifacts: [url], contextLinks: [] })
    expect(lines).toEqual([`• <${url}|my PR> ✓`])
  })

  test('dedupes watched PR vs artifact by PR identity even when URL forms differ', () => {
    // Watch stores the canonical URL; artifact captured a variant (trailing slash / extra path / legacy "] junk).
    const lines = assembleContextLines({
      watches: [watch({ prUrl: 'https://github.com/o/r/pull/1' })],
      artifacts: [
        'https://github.com/o/r/pull/1/files',
        'https://github.com/o/r/pull/1"]', // the exact malformed legacy entry that caused the visible duplicate
      ],
      contextLinks: [],
    })
    expect(lines).toEqual(['• <https://github.com/o/r/pull/1|my PR> ✓'])
  })

  test('dedupes an artifact URL that also appears in context links', () => {
    const url = 'https://claude.ai/public/artifacts/abc-123'
    const lines = assembleContextLines({ watches: [], artifacts: [url], contextLinks: [url] })
    expect(lines).toEqual([renderArtifactLink(url)])
  })

  test('preserves existing behavior: a watched PR URL in context links is skipped', () => {
    const url = 'https://github.com/o/r/pull/1'
    const lines = assembleContextLines({ watches: [watch({ prUrl: url })], artifacts: [], contextLinks: [url] })
    expect(lines).toEqual([`• <${url}|my PR> ✓`])
  })

  test('caps total lines at max (default 5), dropping lowest-priority first', () => {
    const lines = assembleContextLines({
      watches: [watch({ prUrl: 'https://github.com/o/r/pull/1' }), watch({ prUrl: 'https://github.com/o/r/pull/2', prNumber: 2 })],
      artifacts: ['https://arti.internal.angellist.com/s/a/1', 'https://claude.ai/public/artifacts/b'],
      contextLinks: ['https://linear.app/1', 'https://notion.so/2', 'https://sentry.io/3'],
    })
    expect(lines).toHaveLength(5)
    // 2 watches + 2 artifacts + 1 context link = 5; remaining context links dropped
    expect(lines.filter(l => l.includes('📎'))).toHaveLength(2)
    expect(lines.filter(l => l.includes('🔗'))).toHaveLength(1)
  })

  test('respects a custom max', () => {
    const lines = assembleContextLines({
      watches: [watch()],
      artifacts: ['https://arti.internal.angellist.com/s/a/1'],
      contextLinks: [],
      max: 1,
    })
    expect(lines).toHaveLength(1)
  })

  test('returns empty when all sources are empty', () => {
    expect(assembleContextLines({ watches: [], artifacts: [], contextLinks: [] })).toEqual([])
  })
})
