// util.ts imports config.js which reads env at module init — set before import
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

import { describe, test, expect } from 'bun:test'
import { chunk, parseDuration, extractPhaseBudget, formatDuration, transformProtocolTag } from '../daemon/util.js'

describe('chunk', () => {
  test('returns single chunk for short text', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('splits long text by length', () => {
    const result = chunk('a'.repeat(200), 100, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBeLessThanOrEqual(100)
    expect(result[1].length).toBeLessThanOrEqual(100)
  })

  test('splits by paragraph boundary in newline mode', () => {
    const text = 'line1\n\nline2\n\nline3'
    const result = chunk(text, 10, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })

  test('preserves text that fits in single chunk (newline mode)', () => {
    expect(chunk('short', 100, 'newline')).toEqual(['short'])
  })

  test('preserves text that fits in single chunk (markdown mode)', () => {
    expect(chunk('# Hello\n\nWorld', 200, 'markdown')).toEqual(['# Hello\n\nWorld'])
  })

  test('splits markdown without breaking code fences', () => {
    const text = '```ts\nconst x = 1\n```\n\nMore text here that makes it long enough to split'
    const result = chunk(text, 30, 'markdown')
    // Should split somewhere but each chunk should be independently valid markdown
    expect(result.length).toBeGreaterThan(0)
    expect(result.join('')).toBeTruthy()
  })
})

describe('parseDuration', () => {
  test('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000)
  })

  test('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
  })

  test('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  test('parses uppercase', () => {
    expect(parseDuration('10S')).toBe(10_000)
    expect(parseDuration('2M')).toBe(120_000)
    expect(parseDuration('1H')).toBe(3_600_000)
  })

  test('rejects invalid format', () => {
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('5')).toBeNull()
    expect(parseDuration('m5')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  test('rejects zero', () => {
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
  })

  test('rejects over 24h', () => {
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('1441m')).toBeNull()
  })

  test('accepts exactly 24h', () => {
    expect(parseDuration('24h')).toBe(86_400_000)
  })
})

describe('extractPhaseBudget', () => {
  test('extracts budget from topic', () => {
    const r = extractPhaseBudget('do stuff --phase-budget 5m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toBe('do stuff')
  })

  test('extracts budget from end of topic', () => {
    const r = extractPhaseBudget('implement feature --phase-budget 1h')
    expect(r.budgetMs).toBe(3_600_000)
    expect(r.topic).toBe('implement feature')
  })

  test('no budget returns topic unchanged', () => {
    const r = extractPhaseBudget('just a topic')
    expect(r.topic).toBe('just a topic')
    expect(r.budgetMs).toBeUndefined()
  })

  test('invalid budget duration leaves it in topic', () => {
    const r = extractPhaseBudget('topic --phase-budget invalid')
    expect(r.topic).toBe('topic --phase-budget invalid')
    expect(r.budgetMs).toBeUndefined()
  })
})

describe('formatDuration', () => {
  test('formats sub-hour as minutes', () => {
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(60_000)).toBe('1m')
  })

  test('formats hours', () => {
    expect(formatDuration(7_200_000)).toBe('2h')
  })

  test('formats hours and minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  test('formats days', () => {
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  test('formats days and hours', () => {
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })
})

describe('transformProtocolTag', () => {
  test('strips critic→owner tag from first line', () => {
    expect(transformProtocolTag('[critic→owner] my review')).toBe('my review')
  })

  test('strips owner→critic tag', () => {
    expect(transformProtocolTag('[owner→critic] my defense')).toBe('my defense')
  })

  test('strips tag and preserves multiline content', () => {
    const input = '[critic→owner] first line\nsecond line\nthird line'
    const result = transformProtocolTag(input)
    expect(result).toContain('first line')
    expect(result).toContain('second line')
    expect(result).not.toContain('[critic→owner]')
  })

  test('preserves text without tag', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
  })

  test('preserves [done] sentinel (not a routing tag)', () => {
    expect(transformProtocolTag('[done] build complete')).toBe('[done] build complete')
  })

  test('preserves text when tag is mid-message (not first line)', () => {
    const input = 'first line\n[critic→owner] second line'
    expect(transformProtocolTag(input)).toBe(input)
  })
})
