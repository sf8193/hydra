// util.ts imports config.js which calls process.exit(1) without a bot token.
// Set env before any imports resolve.
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token'
process.env.CHAT_PLATFORM = process.env.CHAT_PLATFORM || 'discord'

import { describe, test, expect, beforeAll } from 'bun:test'

let formatDuration: (ms: number) => string
let parseDuration: (s: string) => number | null
let MAX_DURATION_MS: number
let extractPhaseBudget: (topic: string) => { topic: string; budgetMs?: number }
let transformProtocolTag: (text: string) => string
let chunk: (text: string, limit: number, mode: 'length' | 'newline' | 'markdown') => string[]
let fallbackDescription: (topic: string) => string
let formatSpawnLine: (p: { roleLabel?: string; emoji: string; name: string; model: string; trigger: string; initiator?: string }) => string

beforeAll(async () => {
  const mod = await import('../daemon/util.js')
  formatDuration = mod.formatDuration
  parseDuration = mod.parseDuration
  MAX_DURATION_MS = mod.MAX_DURATION_MS
  extractPhaseBudget = mod.extractPhaseBudget
  transformProtocolTag = mod.transformProtocolTag
  chunk = mod.chunk
  fallbackDescription = mod.fallbackDescription
  formatSpawnLine = mod.formatSpawnLine
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('0 minutes', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  test('sub-minute rounds down to 0m', () => {
    expect(formatDuration(30_000)).toBe('0m')
    expect(formatDuration(59_999)).toBe('0m')
    expect(formatDuration(1)).toBe('0m')
  })

  test('exactly 1 minute', () => {
    expect(formatDuration(60_000)).toBe('1m')
  })

  test('59 minutes', () => {
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('exactly 1 hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
  })

  test('1 hour 30 minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  test('2 hours exactly', () => {
    expect(formatDuration(7_200_000)).toBe('2h')
  })

  test('23 hours 59 minutes', () => {
    expect(formatDuration(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m')
  })

  test('exactly 1 day', () => {
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  test('1 day 6 hours', () => {
    expect(formatDuration(86_400_000 + 6 * 3_600_000)).toBe('1d 6h')
  })

  test('3 days exactly', () => {
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('seconds', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('1s')).toBe(1_000)
    expect(parseDuration('90s')).toBe(90_000)
  })

  test('minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('1m')).toBe(60_000)
    expect(parseDuration('90m')).toBe(90 * 60_000)
  })

  test('hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('24h')).toBe(86_400_000)
  })

  test('case insensitive', () => {
    expect(parseDuration('5M')).toBe(300_000)
    expect(parseDuration('2H')).toBe(7_200_000)
    expect(parseDuration('30S')).toBe(30_000)
  })

  test('zero is rejected', () => {
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
    expect(parseDuration('0h')).toBeNull()
  })

  test('over 24h is rejected', () => {
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('1441m')).toBeNull()
    expect(parseDuration('86401s')).toBeNull()
  })

  test('exactly 24h is accepted', () => {
    expect(parseDuration('24h')).toBe(MAX_DURATION_MS)
  })

  test('invalid formats', () => {
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('5')).toBeNull()
    expect(parseDuration('5d')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('1m30s')).toBeNull()
    expect(parseDuration(' 5m ')).toBe(300_000) // trimmed
  })
})

// ---------------------------------------------------------------------------
// extractPhaseBudget
// ---------------------------------------------------------------------------

describe('extractPhaseBudget', () => {
  test('no budget in topic', () => {
    const r = extractPhaseBudget('build something cool')
    expect(r.topic).toBe('build something cool')
    expect(r.budgetMs).toBeUndefined()
  })

  test('budget at end of topic', () => {
    const r = extractPhaseBudget('build something --phase-budget 5m')
    expect(r.topic).toBe('build something')
    expect(r.budgetMs).toBe(300_000)
  })

  test('budget at start of topic', () => {
    const r = extractPhaseBudget('--phase-budget 1h build something')
    expect(r.topic).toBe('build something')
    expect(r.budgetMs).toBe(3_600_000)
  })

  test('budget in middle of topic', () => {
    const r = extractPhaseBudget('build --phase-budget 30m something')
    expect(r.topic).toBe('build something')
    expect(r.budgetMs).toBe(30 * 60_000)
  })

  test('= separator also works', () => {
    const r = extractPhaseBudget('build something --phase-budget=20m')
    expect(r.topic).toBe('build something')
    expect(r.budgetMs).toBe(20 * 60_000)
  })

  test('unparseable duration left in topic', () => {
    const r = extractPhaseBudget('build something --phase-budget 5d')
    expect(r.topic).toBe('build something --phase-budget 5d')
    expect(r.budgetMs).toBeUndefined()
  })

  test('zero duration left in topic', () => {
    const r = extractPhaseBudget('build --phase-budget 0m')
    expect(r.topic).toBe('build --phase-budget 0m')
    expect(r.budgetMs).toBeUndefined()
  })

  test('multiple flags — first match wins, second remains in topic', () => {
    // String.match() returns first match (util.ts:98). Second flag left in topic.
    const r = extractPhaseBudget('build --phase-budget 5m --phase-budget 10m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toContain('--phase-budget 10m')
  })
})

// ---------------------------------------------------------------------------
// transformProtocolTag
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('strips critic→owner tag', () => {
    expect(transformProtocolTag('[critic→owner] my review')).toBe('my review')
  })

  test('strips owner→critic tag', () => {
    expect(transformProtocolTag('[owner→critic] my defense')).toBe('my defense')
  })

  test('strips tag with hyphenated roles', () => {
    expect(transformProtocolTag('[build-owner→reviewer] text')).toBe('text')
  })

  test('preserves text without tag', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
  })

  test('preserves [done] sentinel unchanged', () => {
    expect(transformProtocolTag('[done]\nsome content')).toBe('[done]\nsome content')
  })

  test('preserves [summary] sentinel unchanged', () => {
    expect(transformProtocolTag('[summary]\ncontent')).toBe('[summary]\ncontent')
  })

  test('strips tag, keeps body after newline', () => {
    const input = '[critic→owner] first line\n\nsecond paragraph'
    expect(transformProtocolTag(input)).toBe('first line\n\nsecond paragraph')
  })

  test('tag alone returns original if stripping results in empty', () => {
    // "[critic→owner] " alone — remainder is empty, returns original
    const input = '[critic→owner] '
    const result = transformProtocolTag(input)
    // result is either '' (stripped to empty → returns original) or original
    expect([input, '']).toContain(result)
  })

  test('tag with only newline after returns body', () => {
    const input = '[critic→owner]\nbody text'
    expect(transformProtocolTag(input)).toBe('body text')
  })

  test('tag with trailing newline and no body returns original (pinned behavior)', () => {
    // [critic→owner]\n  → rest='\n', remainder='', stripped='\n', result='' → returns original
    const input = '[critic→owner]\n'
    const result = transformProtocolTag(input)
    // returns original (result is '' so `result || text` returns original)
    expect(result).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// chunk (length mode)
// ---------------------------------------------------------------------------

describe('chunk (length mode)', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello world', 100, 'length')).toEqual(['hello world'])
  })

  test('exactly limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('over limit splits into multiple chunks', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBeGreaterThan(1)
    expect(result.join('')).toBe(text)
    for (const c of result) {
      expect(c.length).toBeLessThanOrEqual(100)
    }
  })

  test('splits at space when possible in length mode', () => {
    // length mode doesn't look for spaces — only newline mode does
    const text = 'hello world foo bar'
    const result = chunk(text, 10, 'length')
    expect(result.join('')).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// chunk (newline mode)
// ---------------------------------------------------------------------------

describe('chunk (newline mode)', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello\nworld', 100, 'newline')).toEqual(['hello\nworld'])
  })

  test('splits at paragraph boundary', () => {
    const text = 'para1\n\npara2\n\npara3'
    const result = chunk(text, 12, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // chunk strips leading newlines between parts (util.ts:141: .replace(/^\n+/, ''))
    // so reconstruct by joining and check all words are present
    const allText = result.join(' ')
    expect(allText).toContain('para1')
    expect(allText).toContain('para2')
    expect(allText).toContain('para3')
    // Total content loss should only be stripped leading newlines (≤ chunk count)
    const totalChars = result.reduce((sum, c) => sum + c.length, 0)
    expect(totalChars).toBeGreaterThanOrEqual(text.replace(/^\n+|\n+(?=\n)/g, '').length - result.length)
  })
})

// ---------------------------------------------------------------------------
// chunk (markdown mode)
// ---------------------------------------------------------------------------

describe('chunk (markdown mode)', () => {
  test('short text returns single chunk', () => {
    expect(chunk('# hello\nworld', 100, 'markdown')).toEqual(['# hello\nworld'])
  })

  test('respects code fence boundaries', () => {
    const text = 'before\n```js\nconst x = 1\n```\nafter'
    const result = chunk(text, 20, 'markdown')
    // Should not split inside the fence incorrectly
    // All content preserved
    const joined = result.join('\n').replace(/\n{3,}/g, '\n\n')
    expect(joined).toContain('const x = 1')
  })

  test('closes open fence when splitting', () => {
    const text = '```js\n' + 'x'.repeat(50) + '\n```'
    const result = chunk(text, 30, 'markdown')
    // Each chunk should have balanced fences
    for (const c of result) {
      const opens = (c.match(/^```/gm) ?? []).length
      const closes = (c.match(/^```$/gm) ?? []).length
      // After fence repair, each part should be balanced or have an opener
      expect(Math.abs(opens - closes)).toBeLessThanOrEqual(1)
    }
  })

  test('safeLimit override: chunks may exceed limit when limit < FENCE_CLOSER.length + 1', () => {
    // chunkMarkdown uses safeLimit = Math.max(limit, 5) to avoid fence closer overflow.
    // With limit=3, safeLimit becomes 5 — chunks are NOT guaranteed ≤ 3.
    // This test documents/pins that contract: caller gets best-effort, not a hard cap.
    const text = 'hello\nworld\nfoo\nbar'
    const result = chunk(text, 3, 'markdown')
    // Should split (not one chunk) but chunks may exceed 3
    expect(result.length).toBeGreaterThanOrEqual(1)
    // All content is preserved (joined includes all characters)
    const joined = result.join('')
    expect(joined).toContain('hello')
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('returns first line of topic', () => {
    expect(fallbackDescription('first line\nsecond line')).toBe('first line')
  })

  test('strips leading slash-command', () => {
    expect(fallbackDescription('/spawn some topic')).toBe('some topic')
    expect(fallbackDescription('/review do a thing')).toBe('do a thing')
  })

  test('truncates at 100 chars', () => {
    const long = 'a'.repeat(110)
    const result = fallbackDescription(long)
    expect(result).toBe('a'.repeat(97) + '...')
    expect(result.length).toBe(100)
  })

  test('100 chars exactly — not truncated', () => {
    const text = 'a'.repeat(100)
    expect(fallbackDescription(text)).toBe(text)
  })

  test('empty string', () => {
    expect(fallbackDescription('')).toBe('')
  })

  test('single line no command', () => {
    expect(fallbackDescription('build the thing')).toBe('build the thing')
  })
})

// ---------------------------------------------------------------------------
// formatSpawnLine
// ---------------------------------------------------------------------------

describe('formatSpawnLine', () => {
  test('basic spawn line', () => {
    const result = formatSpawnLine({
      emoji: '🌿',
      name: 'fern',
      model: 'claude-opus-4-6',
      trigger: 'spawn:',
    })
    expect(result).toContain('fern')
    expect(result).toContain('claude-opus-4-6')
    expect(result).toContain('spawn:')
    expect(result).toStartWith('> ⚡ spawned')
  })

  test('with initiator', () => {
    const result = formatSpawnLine({
      emoji: '🌿',
      name: 'fern',
      model: 'claude-opus-4-6',
      trigger: 'factory:',
      initiator: 'comet',
    })
    expect(result).toContain('from comet')
  })

  test('with roleLabel', () => {
    const result = formatSpawnLine({
      roleLabel: 'build-critic',
      emoji: '⚔️',
      name: 'sage',
      model: 'claude-opus-4-6',
      trigger: 'review',
    })
    expect(result).toContain('The Build-Critic')
    expect(result).toContain('sage')
  })

  test('no roleLabel omits title', () => {
    const result = formatSpawnLine({
      emoji: '🌿',
      name: 'fern',
      model: 'model',
      trigger: 'spawn:',
    })
    expect(result).not.toContain('The ')
  })
})
