import { describe, test, expect } from 'bun:test'
import { chunk, formatDuration, fallbackDescription, transformProtocolTag, formatSpawnLine, parseDuration, extractPhaseBudget } from '../util.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// chunk()
// ---------------------------------------------------------------------------

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('exact limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('length mode splits at limit boundary', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(3)
    expect(result[0].length).toBe(100)
    expect(result[1].length).toBe(100)
    expect(result[2].length).toBe(50)
  })

  test('newline mode prefers paragraph break', () => {
    const text = 'first paragraph\n\nsecond paragraph that is very long and keeps going'
    const result = chunk(text, 30, 'newline')
    // First chunk includes text up to the paragraph break point
    expect(result[0]).toContain('first paragraph')
    expect(result.length).toBeGreaterThan(1)
    // Second chunk should have the continuation
    expect(result.slice(1).join('')).toContain('second paragraph')
  })

  test('newline mode falls back to line break', () => {
    const text = 'line one\nline two\nline three is here'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })

  test('newline mode splits long text without newlines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const result = chunk(text, 30, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // All content should be preserved
    expect(result.join('').replace(/\s+/g, ' ').trim()).toContain('one two three')
  })

  test('empty text returns single empty chunk', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('all content preserved across chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const result = chunk(text, 50, 'newline')
    const reassembled = result.join('')
    // Content should be preserved (minus stripped leading newlines between chunks)
    expect(reassembled.length).toBeLessThanOrEqual(text.length)
    expect(reassembled.length).toBeGreaterThan(text.length * 0.95)
  })
})

// ---------------------------------------------------------------------------
// chunk() — markdown mode
// ---------------------------------------------------------------------------

describe('chunk markdown mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'markdown')).toEqual(['hello'])
  })

  test('plain prose splits at paragraph boundaries', () => {
    const text = 'First paragraph here.\n\nSecond paragraph that continues on and on.'
    const result = chunk(text, 40, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result[0]).toContain('First paragraph')
  })

  test('fence spanning a split is closed and reopened', () => {
    const code = 'x = 1\n'.repeat(30)
    const text = 'Before code:\n\n```python\n' + code + '```\n\nAfter code.'
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('fence language tag is preserved on reopen', () => {
    const code = 'line\n'.repeat(40)
    const text = '```typescript\n' + code + '```'
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    expect(result[0]).toMatch(/^```typescript/)
    expect(result[0]).toMatch(/```$/)

    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toMatch(/^```typescript/)
      const fences = (result[i].match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('single code block exceeding limit is split with fence close/reopen', () => {
    const bigLine = 'x'.repeat(80)
    const code = (bigLine + '\n').repeat(40)
    const text = '```js\n' + code + '```'
    const result = chunk(text, 200, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('table near boundary avoids mid-row splits when possible', () => {
    const header = '| Col A | Col B |\n|-------|-------|\n'
    const rows = '| data  | value |\n'.repeat(15)
    const text = 'Some intro text.\n\n' + header + rows + '\nAfter the table.'
    const result = chunk(text, 250, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result[0]).toContain('Some intro text.')
    const firstChunkTableLines = result[0].split('\n').filter(l => l.startsWith('|'))
    for (const line of firstChunkTableLines) {
      expect(line).toMatch(/\|$/)
    }
  })

  test('plain prose unchanged when under limit', () => {
    const text = 'Just a simple message.'
    expect(chunk(text, 100, 'markdown')).toEqual([text])
  })

  test('content round-trips minus injected fence markers', () => {
    const code = 'const a = 1\nconst b = 2\n'.repeat(20)
    const text = 'Intro.\n\n```ts\n' + code + '```\n\nOutro paragraph.'
    const result = chunk(text, 150, 'markdown')
    const reassembled = result.join('\n')
    expect(reassembled).toContain('Intro.')
    expect(reassembled).toContain('Outro paragraph.')
    expect(reassembled).toContain('const a = 1')
    expect(reassembled).toContain('const b = 2')
  })

  test('multiple code blocks both handled', () => {
    const block1 = '```python\n' + 'print("hi")\n'.repeat(15) + '```'
    const block2 = '```ruby\n' + 'puts "hello"\n'.repeat(15) + '```'
    const text = block1 + '\n\nSome text.\n\n' + block2
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('does not infinite loop on long line inside fence', () => {
    const longLine = 'x'.repeat(2500)
    const text = '```python\n' + longLine + '\n```'
    const result = chunk(text, 2000, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    const allXs = result.join('').replace(/[^x]/g, '')
    expect(allXs.length).toBe(2500)
  })

  test('chunks do not exceed the limit', () => {
    const code = 'line of code here\n'.repeat(150)
    const text = '```ts\n' + code + '```'
    const result = chunk(text, 200, 'markdown')
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(200)
    }
  })

  test('does not hang with very small limit', () => {
    const text = '```python\nhello world\n```'
    const result = chunk(text, 15, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result.join('')).toContain('hello world')
  })

  test('legacy modes still work', () => {
    const text = 'a'.repeat(250)
    expect(chunk(text, 100, 'length').length).toBe(3)

    const text2 = 'word '.repeat(50)
    const result = chunk(text2, 30, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// formatDuration()
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('hours and minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(60 * 60_000)).toBe('1h')
    expect(formatDuration(23 * 60 * 60_000)).toBe('23h')
  })

  test('days and hours', () => {
    expect(formatDuration(25 * 60 * 60_000)).toBe('1d 1h')
    expect(formatDuration(48 * 60 * 60_000)).toBe('2d')
    expect(formatDuration(49 * 60 * 60_000)).toBe('2d 1h')
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription()
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('strips leading slash command', () => {
    expect(fallbackDescription('/spawn some topic')).toBe('some topic')
  })

  test('uses first line only', () => {
    expect(fallbackDescription('first line\nsecond line')).toBe('first line')
  })

  test('truncates long descriptions', () => {
    const long = 'a'.repeat(150)
    const result = fallbackDescription(long)
    expect(result.length).toBe(100)
    expect(result.endsWith('...')).toBe(true)
  })

  test('short description passes through', () => {
    expect(fallbackDescription('hello world')).toBe('hello world')
  })

  test('empty string', () => {
    expect(fallbackDescription('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatSpawnLine()
// ---------------------------------------------------------------------------

describe('formatSpawnLine', () => {
  test('role spawn with initiator', () => {
    expect(formatSpawnLine({ roleLabel: 'critic', emoji: '🌊', name: 'drift', model: 'claude-x', trigger: 'review', initiator: 'dan' }))
      .toBe('> ⚡ spawned [ The Critic • 🌊 drift ] · model `claude-x` · by review from dan')
  })

  test('plain spawn without role', () => {
    expect(formatSpawnLine({ emoji: '🟦', name: 'pixel', model: 'claude-x', trigger: 'spawn:', initiator: 'dan' }))
      .toBe('> ⚡ spawned [ 🟦 pixel ] · model `claude-x` · by spawn: from dan')
  })

  test('no initiator omits from-clause; multiword role title-cases', () => {
    expect(formatSpawnLine({ roleLabel: 'contract-lawyer', emoji: '🗺️', name: 'atlas', model: 'm', trigger: 'design' }))
      .toBe('> ⚡ spawned [ The Contract-Lawyer • 🗺️ atlas ] · model `m` · by design')
  })
})
// parseDuration() / extractPhaseBudget()
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('parses s/m/h units', () => {
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('20m')).toBe(1_200_000)
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  test('rejects garbage', () => {
    expect(parseDuration('banana')).toBeNull()
    expect(parseDuration('20')).toBeNull()
    expect(parseDuration('m20')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  test('rejects zero and setTimeout-overflowing values', () => {
    expect(parseDuration('0m')).toBeNull()
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('999999h')).toBeNull()
    expect(parseDuration('24h')).toBe(86_400_000)
  })
})

describe('extractPhaseBudget', () => {
  test('strips the flag and returns ms', () => {
    expect(extractPhaseBudget('fix the bug --phase-budget 20m off main'))
      .toEqual({ topic: 'fix the bug off main', budgetMs: 1_200_000 })
  })

  test('flag at start and equals form', () => {
    expect(extractPhaseBudget('--phase-budget 90s quick check'))
      .toEqual({ topic: 'quick check', budgetMs: 90_000 })
    expect(extractPhaseBudget('audit logs --phase-budget=1h'))
      .toEqual({ topic: 'audit logs', budgetMs: 3_600_000 })
  })

  test('no flag → topic unchanged', () => {
    expect(extractPhaseBudget('plain topic')).toEqual({ topic: 'plain topic' })
  })

  test('unparseable duration stays in the topic (visible, not swallowed)', () => {
    expect(extractPhaseBudget('task --phase-budget banana'))
      .toEqual({ topic: 'task --phase-budget banana' })
  })
})
// transformProtocolTag()
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('routing tag is stripped, content preserved', () => {
    expect(transformProtocolTag('[critic→owner]\nFinding 1: bug'))
      .toBe('Finding 1: bug')
  })

  test('routing tag with content on same line', () => {
    expect(transformProtocolTag('[builder→critic] done with round'))
      .toBe('done with round')
  })

  test('body-less routing tag returns original text', () => {
    expect(transformProtocolTag('[critic→owner]'))
      .toBe('[critic→owner]')
  })

  test('[summary] sentinel is stripped from display', () => {
    expect(transformProtocolTag('[summary]\nAll good.')).toBe('All good.')
  })

  test('[summary] with no body returns original', () => {
    expect(transformProtocolTag('[summary]')).toBe('[summary]')
  })

  test('other move sentinels without an arrow are untouched', () => {
    expect(transformProtocolTag('[done]')).toBe('[done]')
  })

  test('free-form posts are untouched', () => {
    expect(transformProtocolTag('just chatting here')).toBe('just chatting here')
  })
})
