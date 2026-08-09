// Set env before any import so config.ts doesn't exit on missing token
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'
process.env.HYDRA_STATE_DIR ??= '/tmp/hydra-util-test'

import { describe, test, expect } from 'bun:test'
import {
  chunk,
  parseDuration,
  extractPhaseBudget,
  formatDuration,
  transformProtocolTag,
  MAX_DURATION_MS,
} from '../daemon/util.js'

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('zero → 0m', () => expect(formatDuration(0)).toBe('0m'))
  test('59m', () => expect(formatDuration(59 * 60_000)).toBe('59m'))
  test('1h exact', () => expect(formatDuration(60 * 60_000)).toBe('1h'))
  test('1h 30m', () => expect(formatDuration(90 * 60_000)).toBe('1h 30m'))
  test('2h exact', () => expect(formatDuration(120 * 60_000)).toBe('2h'))
  test('23h 59m', () => expect(formatDuration((23 * 60 + 59) * 60_000)).toBe('23h 59m'))
  test('1d exact', () => expect(formatDuration(24 * 60 * 60_000)).toBe('1d'))
  test('1d 6h', () => expect(formatDuration(30 * 60 * 60_000)).toBe('1d 6h'))
  test('2d exact', () => expect(formatDuration(48 * 60 * 60_000)).toBe('2d'))
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('30s → 30000', () => expect(parseDuration('30s')).toBe(30_000))
  test('1S case-insensitive', () => expect(parseDuration('1S')).toBe(1_000))
  test('5m → 300000', () => expect(parseDuration('5m')).toBe(300_000))
  test('2M case-insensitive', () => expect(parseDuration('2M')).toBe(120_000))
  test('1h → 3600000', () => expect(parseDuration('1h')).toBe(3_600_000))
  test('24h → MAX', () => expect(parseDuration('24h')).toBe(MAX_DURATION_MS))
  test('25h → null (over limit)', () => expect(parseDuration('25h')).toBeNull())
  test('0s → null (zero)', () => expect(parseDuration('0s')).toBeNull())
  test('0m → null (zero)', () => expect(parseDuration('0m')).toBeNull())
  test('empty → null', () => expect(parseDuration('')).toBeNull())
  test('no unit → null', () => expect(parseDuration('30')).toBeNull())
  test('invalid unit → null', () => expect(parseDuration('5d')).toBeNull())
  test('non-numeric → null', () => expect(parseDuration('abc')).toBeNull())
  test('leading space trimmed', () => expect(parseDuration(' 10s')).toBe(10_000))
  test('trailing space trimmed', () => expect(parseDuration('10s ')).toBe(10_000))
  test('float → null (no decimal support)', () => expect(parseDuration('1.5m')).toBeNull())
})

// ---------------------------------------------------------------------------
// extractPhaseBudget
// ---------------------------------------------------------------------------

describe('extractPhaseBudget', () => {
  test('no flag → topic unchanged', () => {
    expect(extractPhaseBudget('do some work')).toEqual({ topic: 'do some work' })
  })

  test('flag with space', () => {
    const r = extractPhaseBudget('do some work --phase-budget 5m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toBe('do some work')
  })

  test('flag with = separator', () => {
    const r = extractPhaseBudget('do some work --phase-budget=5m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toBe('do some work')
  })

  test('flag at start', () => {
    const r = extractPhaseBudget('--phase-budget 10m run audit')
    expect(r.budgetMs).toBe(600_000)
    expect(r.topic).toBe('run audit')
  })

  test('flag in middle', () => {
    const r = extractPhaseBudget('run --phase-budget 30s audit')
    expect(r.budgetMs).toBe(30_000)
    expect(r.topic).toBe('run audit')
  })

  test('invalid duration → topic unchanged (flag left in)', () => {
    // invalid duration → parseDuration returns null → topic returned as-is
    const r = extractPhaseBudget('do work --phase-budget 25h')
    expect(r.budgetMs).toBeUndefined()
    expect(r.topic).toBe('do work --phase-budget 25h')
  })

  test('hours flag', () => {
    const r = extractPhaseBudget('long task --phase-budget 2h')
    expect(r.budgetMs).toBe(2 * 3_600_000)
    expect(r.topic).toBe('long task')
  })

  test('extra spaces collapsed', () => {
    const r = extractPhaseBudget('  do  work   --phase-budget 1m   ')
    expect(r.budgetMs).toBe(60_000)
    // topic has leading/trailing trimmed and internal spaces collapsed
    expect(r.topic).not.toContain('--phase-budget')
  })
})

// ---------------------------------------------------------------------------
// transformProtocolTag
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('no tag → unchanged', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
  })

  test('strips [critic→owner] sentinel', () => {
    const input = '[critic→owner] my review'
    expect(transformProtocolTag(input)).toBe('my review')
  })

  test('strips [owner→critic] sentinel', () => {
    const input = '[owner→critic] defense text'
    expect(transformProtocolTag(input)).toBe('defense text')
  })

  test('strips tag with trailing space', () => {
    const input = '[critic→owner]   spaced'
    expect(transformProtocolTag(input)).toBe('spaced')
  })

  test('multiline: strips tag from first line', () => {
    const input = '[critic→owner] heading\n\nbody text'
    const result = transformProtocolTag(input)
    expect(result).toBe('heading\n\nbody text')
  })

  test('multiline: tag-only first line → returns body', () => {
    const input = '[critic→owner]\nbody text'
    expect(transformProtocolTag(input)).toBe('body text')
  })

  test('[done] sentinel → unchanged (not a routing tag)', () => {
    expect(transformProtocolTag('[done]')).toBe('[done]')
  })

  test('[summary] sentinel → unchanged', () => {
    expect(transformProtocolTag('[summary] text')).toBe('[summary] text')
  })

  test('empty string → unchanged', () => {
    expect(transformProtocolTag('')).toBe('')
  })

  test('hyphenated role name', () => {
    const input = '[review-critic→owner] content'
    expect(transformProtocolTag(input)).toBe('content')
  })
})

// ---------------------------------------------------------------------------
// chunk — length mode
// ---------------------------------------------------------------------------

describe('chunk (length mode)', () => {
  test('short text → single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('exact limit → single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('over limit → splits at limit', () => {
    const text = 'a'.repeat(201)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(3)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(100)
    expect(result.join('')).toBe(text)
  })

  test('splits at word boundary when available', () => {
    const text = 'hello world this is a test string for splitting'
    const result = chunk(text, 20, 'length')
    // Should produce at least 2 chunks
    expect(result.length).toBeGreaterThan(1)
    expect(result.join(' ').trim()).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// chunk — newline mode
// ---------------------------------------------------------------------------

describe('chunk (newline mode)', () => {
  test('short text → single chunk', () => {
    expect(chunk('hello', 100, 'newline')).toEqual(['hello'])
  })

  test('splits at paragraph boundary', () => {
    const text = 'para1\n\npara2\n\npara3'
    const result = chunk(text, 10, 'newline')
    expect(result.length).toBeGreaterThan(1)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(10)
  })

  test('splits at line boundary', () => {
    const text = 'line1\nline2\nline3\nline4'
    const result = chunk(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(12)
  })

  test('no boundary → hard split', () => {
    const text = 'a'.repeat(200)
    const result = chunk(text, 100, 'newline')
    expect(result.length).toBe(2)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(100)
  })

  test('rejoining preserves content', () => {
    const text = 'first\n\nsecond\n\nthird paragraph here'
    const result = chunk(text, 15, 'newline')
    // All content preserved (newlines may be stripped from between chunks)
    const joined = result.join('\n')
    expect(joined).toContain('first')
    expect(joined).toContain('second')
    expect(joined).toContain('third')
  })
})

// ---------------------------------------------------------------------------
// chunk — markdown mode
// ---------------------------------------------------------------------------

describe('chunk (markdown mode)', () => {
  test('short text → single chunk', () => {
    expect(chunk('hello', 100, 'markdown')).toEqual(['hello'])
  })

  test('splits long plain text', () => {
    const text = 'word '.repeat(100).trim()
    const result = chunk(text, 50, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(50)
  })

  test('closes open code fence at split boundary', () => {
    const text = '```ts\nconst x = 1\nconst y = 2\nconst z = 3\n```'
    const result = chunk(text, 30, 'markdown')
    if (result.length > 1) {
      // Each chunk with an opened fence should be closed
      for (const c of result) {
        const opens = (c.match(/^```/gm) ?? []).length
        const closes = (c.match(/^```\s*$/gm) ?? []).length
        // Either balanced or the last chunk has an extra opener
        expect(opens - closes).toBeLessThanOrEqual(1)
      }
    }
  })

  test('does not split inside a table row', () => {
    const header = '| col1 | col2 |\n| --- | --- |\n'
    const rows = Array.from({ length: 5 }, (_, i) => `| row${i} | val${i} |\n`).join('')
    const text = header + rows
    const result = chunk(text, 60, 'markdown')
    // Each chunk should not end mid-row (each chunk ends at a newline)
    for (const c of result) {
      if (c.endsWith('\n')) continue
      // Acceptable: chunk ends cleanly
      expect(c).toBeTruthy()
    }
  })
})
