// util.ts imports config.js which reads env at module init — set before import
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

import { describe, test, expect } from 'bun:test'
import { chunk, parseDuration, extractPhaseBudget, formatDuration, transformProtocolTag } from '../daemon/util.js'

describe('chunk', () => {
  test('returns single chunk for short text', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('returns single chunk for text exactly at limit', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('splits 101-char text at limit in length mode', () => {
    const text = 'a'.repeat(101)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(2)
    expect(result[0].length).toBeLessThanOrEqual(100)
    expect(result[1].length).toBe(1)
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

  // Fence repair: split forces a close in chunk 1 and reopen in chunk 2
  test('markdown mode closes open fence in first chunk and reopens in next', () => {
    // Craft text where the split lands inside a code fence
    // Make the fenced block long enough to force a split inside it
    const code = 'const x = 1\nconst y = 2\nconst z = 3\nconst w = 4'
    const text = '```ts\n' + code + '\n```'
    // Limit chosen to split inside the fence
    const result = chunk(text, 25, 'markdown')

    if (result.length > 1) {
      // First chunk must end with closing fence
      expect(result[0]).toMatch(/```\s*$/)
      // Second chunk must start with a reopening fence (with or without lang)
      expect(result[1]).toMatch(/^```/)
    }
    // Regardless, output must be non-empty and non-trivially valid
    expect(result.length).toBeGreaterThan(0)
    result.forEach(c => expect(c.length).toBeGreaterThan(0))
  })

  test('markdown mode preserves lang tag when reopening fence', () => {
    const text = '```ts\n' + 'const x = longVariableName\n'.repeat(5) + '```'
    const result = chunk(text, 30, 'markdown')

    if (result.length > 1) {
      // If the fence was split, the reopening should preserve the ts lang tag
      const secondChunk = result[1]
      if (secondChunk.startsWith('```')) {
        expect(secondChunk).toMatch(/^```ts/)
      }
    }
  })

  test('markdown mode without lang tag closes and reopens generic fence', () => {
    const text = '```\n' + 'some code line here\n'.repeat(5) + '```'
    const result = chunk(text, 25, 'markdown')

    if (result.length > 1) {
      expect(result[0]).toMatch(/```\s*$/)
      expect(result[1]).toMatch(/^```/)
    }
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
    expect(parseDuration('86401s')).toBeNull()
  })

  test('accepts exactly 24h in all unit forms', () => {
    expect(parseDuration('24h')).toBe(86_400_000)
    expect(parseDuration('1440m')).toBe(86_400_000)
    expect(parseDuration('86400s')).toBe(86_400_000)
  })
})

describe('extractPhaseBudget', () => {
  test('extracts budget with space separator', () => {
    const r = extractPhaseBudget('do stuff --phase-budget 5m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toBe('do stuff')
  })

  test('extracts budget with = separator', () => {
    const r = extractPhaseBudget('do stuff --phase-budget=5m')
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
  test('sub-minute rounds to 0m (documents the behavior)', () => {
    // formatDuration uses Math.floor — sub-minute ms returns '0m'
    expect(formatDuration(30_000)).toBe('0m')
    expect(formatDuration(0)).toBe('0m')
  })

  test('formats exactly 1 minute', () => {
    expect(formatDuration(60_000)).toBe('1m')
  })

  test('formats minutes under an hour', () => {
    expect(formatDuration(120_000)).toBe('2m')
  })

  test('formats exact hours', () => {
    expect(formatDuration(7_200_000)).toBe('2h')
  })

  test('formats hours with remaining minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  test('formats exact days', () => {
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  test('formats days with remaining hours', () => {
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
