// util.ts imports gateway from config.ts which reads env vars at module init.
// Set the token before any dynamic imports to avoid process.exit(1).
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

import { describe, test, expect, beforeAll } from 'bun:test'

let chunk: typeof import('../daemon/util.js')['chunk']
let parseDuration: typeof import('../daemon/util.js')['parseDuration']
let extractPhaseBudget: typeof import('../daemon/util.js')['extractPhaseBudget']
let formatDuration: typeof import('../daemon/util.js')['formatDuration']
let transformProtocolTag: typeof import('../daemon/util.js')['transformProtocolTag']
let fallbackDescription: typeof import('../daemon/util.js')['fallbackDescription']
let MAX_DURATION_MS: number

beforeAll(async () => {
  const m = await import('../daemon/util.js')
  chunk = m.chunk
  parseDuration = m.parseDuration
  extractPhaseBudget = m.extractPhaseBudget
  formatDuration = m.formatDuration
  transformProtocolTag = m.transformProtocolTag
  fallbackDescription = m.fallbackDescription
  MAX_DURATION_MS = m.MAX_DURATION_MS
})

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

describe('chunk — length mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello world', 100, 'length')).toEqual(['hello world'])
  })

  test('text exactly at limit returns single chunk', () => {
    const t = 'a'.repeat(100)
    expect(chunk(t, 100, 'length')).toEqual([t])
  })

  test('text one over limit splits into two', () => {
    const t = 'a'.repeat(101)
    const result = chunk(t, 100, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBeLessThanOrEqual(100)
    expect(result.join('')).toBe(t)
  })

  test('hard-cuts at exact limit (no word-boundary search)', () => {
    const t = 'hello world this is longer than limit'
    const result = chunk(t, 12, 'length')
    // length mode hard-cuts at limit — no space/paragraph search
    expect(result[0].length).toBe(12)
    expect(result[0]).toBe(t.slice(0, 12))
  })

  test('empty string returns single empty chunk', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })
})

describe('chunk — newline mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('line1\nline2', 100, 'newline')).toEqual(['line1\nline2'])
  })

  test('prefers paragraph break over line break', () => {
    const para1 = 'a'.repeat(30)
    const para2 = 'b'.repeat(30)
    const para3 = 'c'.repeat(30)
    const t = `${para1}\n\n${para2}\n\n${para3}`
    const result = chunk(t, 65, 'newline')
    // Should split at paragraph boundary
    expect(result.length).toBeGreaterThan(1)
    expect(result.every(c => c.length > 0)).toBe(true)
  })

  test('falls back to line break when no paragraph break', () => {
    const t = 'line1\nline2\nline3\nline4\nline5'
    const result = chunk(t, 15, 'newline')
    expect(result.length).toBeGreaterThan(1)
    expect(result.join('\n').replace(/\n+/g, '\n').trim()).toBeTruthy()
  })

  test('preserves all content across chunks', () => {
    const t = 'aaaa\n\nbbbb\n\ncccc\n\ndddd'
    const result = chunk(t, 10, 'newline')
    // Every segment must appear in some chunk
    expect(result.some(c => c.includes('aaaa'))).toBe(true)
    expect(result.some(c => c.includes('bbbb'))).toBe(true)
    expect(result.some(c => c.includes('cccc'))).toBe(true)
    expect(result.some(c => c.includes('dddd'))).toBe(true)
  })
})

describe('chunk — markdown mode', () => {
  test('short text returns single chunk', () => {
    const t = '# Hello\nsome text'
    expect(chunk(t, 100, 'markdown')).toEqual([t])
  })

  test('closes open code fence when splitting', () => {
    const t = '```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```'
    const result = chunk(t, 25, 'markdown')
    // Must actually split — if not, the fence repair test is a no-op
    expect(result.length).toBeGreaterThan(1)
    // First chunk should close the fence
    expect(result[0]).toMatch(/```$/)
    // Second chunk should reopen
    expect(result[1]).toMatch(/^```/)
  })

  test('prefers splitting at paragraph breaks', () => {
    const t = 'paragraph one here\n\nparagraph two here\n\nparagraph three'
    const result = chunk(t, 25, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result[0]).not.toMatch(/^\s/)
  })

  test('does not split inside table rows', () => {
    const t = '| col1 | col2 |\n| --- | --- |\n| val1 | val2 |\n\nnext section here now'
    const result = chunk(t, 35, 'markdown')
    // Table rows should not be split mid-row
    for (const c of result) {
      const tableRows = c.split('\n').filter(l => l.trim().startsWith('|'))
      for (const row of tableRows) {
        expect(row.trim().endsWith('|') || row.trim() === '').toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('parses seconds', () => expect(parseDuration('30s')).toBe(30_000))
  test('parses seconds — uppercase', () => expect(parseDuration('30S')).toBe(30_000))
  test('parses minutes', () => expect(parseDuration('5m')).toBe(300_000))
  test('parses hours', () => expect(parseDuration('2h')).toBe(7_200_000))
  test('parses 1h exactly', () => expect(parseDuration('1h')).toBe(3_600_000))
  test('parses 24h (boundary)', () => expect(parseDuration('24h')).toBe(86_400_000))

  test('rejects zero seconds', () => expect(parseDuration('0s')).toBeNull())
  test('rejects zero minutes', () => expect(parseDuration('0m')).toBeNull())
  test('rejects over 24h', () => expect(parseDuration('25h')).toBeNull())
  test('rejects plain number', () => expect(parseDuration('100')).toBeNull())
  test('rejects days unit', () => expect(parseDuration('1d')).toBeNull())
  test('rejects float', () => expect(parseDuration('1.5m')).toBeNull())
  test('rejects empty string', () => expect(parseDuration('')).toBeNull())
  test('rejects text', () => expect(parseDuration('abc')).toBeNull())
  test('rejects number with spaces', () => expect(parseDuration('5 m')).toBeNull())
  test('rejects negative number', () => expect(parseDuration('-5m')).toBeNull())
  test('leading zeros parse as integer (007s → 7000ms)', () => expect(parseDuration('007s')).toBe(7_000))

  test('MAX_DURATION_MS is 24h', () => expect(MAX_DURATION_MS).toBe(24 * 3_600_000))
})

// ---------------------------------------------------------------------------
// extractPhaseBudget
// ---------------------------------------------------------------------------

describe('extractPhaseBudget', () => {
  test('no budget flag returns topic unchanged', () => {
    const r = extractPhaseBudget('just a plain topic')
    expect(r.topic).toBe('just a plain topic')
    expect(r.budgetMs).toBeUndefined()
  })

  test('extracts budget from end of topic', () => {
    const r = extractPhaseBudget('do some work --phase-budget 5m')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBe(300_000)
  })

  test('extracts budget from middle of topic', () => {
    const r = extractPhaseBudget('build --phase-budget 30m feature x')
    expect(r.topic).toBe('build feature x')
    expect(r.budgetMs).toBe(1_800_000)
  })

  test('extracts budget with = separator', () => {
    const r = extractPhaseBudget('task --phase-budget=1h')
    expect(r.topic).toBe('task')
    expect(r.budgetMs).toBe(3_600_000)
  })

  test('leaves unparseable duration in topic', () => {
    const r = extractPhaseBudget('task --phase-budget 99d')
    expect(r.topic).toBe('task --phase-budget 99d')
    expect(r.budgetMs).toBeUndefined()
  })

  test('handles budget at start of topic', () => {
    const r = extractPhaseBudget('--phase-budget 10m investigate bug')
    expect(r.topic).toBe('investigate bug')
    expect(r.budgetMs).toBe(600_000)
  })

  test('does not strip partial matches', () => {
    const r = extractPhaseBudget('phase-budget 5m') // missing --
    expect(r.topic).toBe('phase-budget 5m')
    expect(r.budgetMs).toBeUndefined()
  })

  test('double flag: first match wins, second flag stays in topic', () => {
    const r = extractPhaseBudget('task --phase-budget 5m --phase-budget 10m')
    expect(r.budgetMs).toBe(300_000) // first match
    expect(r.topic).toContain('--phase-budget 10m') // second flag remains
  })
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('0ms → 0m', () => expect(formatDuration(0)).toBe('0m'))
  test('59999ms → 0m', () => expect(formatDuration(59_999)).toBe('0m'))
  test('60000ms → 1m', () => expect(formatDuration(60_000)).toBe('1m'))
  test('90000ms → 1m', () => expect(formatDuration(90_000)).toBe('1m'))
  test('2 minutes', () => expect(formatDuration(120_000)).toBe('2m'))
  test('59 minutes', () => expect(formatDuration(59 * 60_000)).toBe('59m'))
  test('1 hour exact', () => expect(formatDuration(3_600_000)).toBe('1h'))
  test('1h 30m', () => expect(formatDuration(5_400_000)).toBe('1h 30m'))
  test('2 hours exact', () => expect(formatDuration(7_200_000)).toBe('2h'))
  test('23h 59m', () => expect(formatDuration(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m'))
  test('1 day exact', () => expect(formatDuration(86_400_000)).toBe('1d'))
  test('1d 12h', () => expect(formatDuration(86_400_000 + 12 * 3_600_000)).toBe('1d 12h'))
  test('2 days exact', () => expect(formatDuration(2 * 86_400_000)).toBe('2d'))
  test('negative input returns negative minutes (no guard)', () => {
    // Callers always pass Date.now() - pastTs (non-negative), but document behavior
    expect(formatDuration(-1)).toBe('-1m')
  })
})

// ---------------------------------------------------------------------------
// transformProtocolTag
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('strips [critic→owner] tag', () => {
    expect(transformProtocolTag('[critic→owner] my review text')).toBe('my review text')
  })

  test('strips [owner→critic] tag', () => {
    expect(transformProtocolTag('[owner→critic] my defense')).toBe('my defense')
  })

  test('strips tag from multiline text', () => {
    const input = '[critic→owner] first line\nsecond line\nthird line'
    const result = transformProtocolTag(input)
    expect(result).toBe('first line\nsecond line\nthird line')
  })

  test('passes through text without a tag', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
  })

  test('passes through [done] sentinel unchanged', () => {
    expect(transformProtocolTag('[done]')).toBe('[done]')
  })

  test('passes through [summary] unchanged', () => {
    expect(transformProtocolTag('[summary] final summary')).toBe('[summary] final summary')
  })

  test('tag with only tag on first line — returns body', () => {
    const input = '[critic→owner]\nsecond line'
    const result = transformProtocolTag(input)
    expect(result).toBe('second line')
  })

  test('tag case insensitive', () => {
    const result = transformProtocolTag('[CRITIC→OWNER] text')
    expect(result).toBe('text')
  })

  test('ASCII arrow -> does NOT match (strict U+2192 only)', () => {
    expect(transformProtocolTag('[critic->owner] text')).toBe('[critic->owner] text')
  })

  test('double arrow => does NOT match', () => {
    expect(transformProtocolTag('[critic=>owner] text')).toBe('[critic=>owner] text')
  })

  test('tag with hyphenated role name', () => {
    const result = transformProtocolTag('[build-critic→build-owner] findings')
    expect(result).toBe('findings')
  })

  test('returns original when tag is only content', () => {
    // Edge case: tag is the entire content, stripping leaves empty → return original
    const input = '[critic→owner]'
    const result = transformProtocolTag(input)
    // Result should be non-empty (falls back to original)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('short single line passes through', () => {
    expect(fallbackDescription('my topic')).toBe('my topic')
  })

  test('takes only first line of multi-line input', () => {
    expect(fallbackDescription('first line\nsecond line')).toBe('first line')
  })

  test('truncates long lines to 100 chars', () => {
    const long = 'a'.repeat(110)
    const result = fallbackDescription(long)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toMatch(/\.\.\.$/)
  })

  test('strips leading slash-command prefix', () => {
    expect(fallbackDescription('/spawn do a task')).toBe('do a task')
    expect(fallbackDescription('/review check this')).toBe('check this')
  })

  test('preserves text without slash prefix', () => {
    expect(fallbackDescription('no slash here')).toBe('no slash here')
  })
})
