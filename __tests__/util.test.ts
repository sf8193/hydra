// util.ts tests — covers pure functions only (no gateway/config imports needed).
// gateway-dependent exports (safeSend, reportError, assertSendable) require a
// live daemon and are excluded. isAlive/tmuxHasSession require a running tmux.

// Set env before any imports so config.ts doesn't process.exit(1).
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

import { describe, test, expect } from 'bun:test'

let formatDuration: (ms: number) => string
let parseDuration: (s: string) => number | null
let extractPhaseBudget: (topic: string) => { topic: string; budgetMs?: number }
let transformProtocolTag: (text: string) => string
let chunk: (text: string, limit: number, mode: 'length' | 'newline' | 'markdown') => string[]
let fallbackDescription: (topic: string) => string
let formatSpawnLine: (p: { roleLabel?: string; emoji: string; name: string; model: string; trigger: string; initiator?: string }) => string
let MAX_DURATION_MS: number

// Dynamic import so env is set before config.ts runs
const mod = await import('../daemon/util.js')
formatDuration = mod.formatDuration
parseDuration = mod.parseDuration
extractPhaseBudget = mod.extractPhaseBudget
transformProtocolTag = mod.transformProtocolTag
chunk = mod.chunk
fallbackDescription = mod.fallbackDescription
formatSpawnLine = mod.formatSpawnLine
MAX_DURATION_MS = mod.MAX_DURATION_MS

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe('formatDuration', () => {
  test('sub-hour: minutes only', () => {
    expect(formatDuration(2 * 60_000)).toBe('2m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('exact hours: no minutes', () => {
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(3_600_000)).toBe('1h')
  })

  test('hours with remaining minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m')
  })

  test('exact days: no hours', () => {
    expect(formatDuration(24 * 3_600_000)).toBe('1d')
    expect(formatDuration(48 * 3_600_000)).toBe('2d')
  })

  test('days with remaining hours', () => {
    expect(formatDuration(25 * 3_600_000)).toBe('1d 1h')
    expect(formatDuration(36 * 3_600_000)).toBe('1d 12h')
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------
describe('parseDuration', () => {
  test('seconds', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('1s')).toBe(1_000)
  })

  test('minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('90m')).toBe(5_400_000)
  })

  test('hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('24h')).toBe(MAX_DURATION_MS)
  })

  test('case insensitive', () => {
    expect(parseDuration('5M')).toBe(300_000)
    expect(parseDuration('2H')).toBe(7_200_000)
    expect(parseDuration('10S')).toBe(10_000)
  })

  test('returns null for invalid input', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('5')).toBeNull()        // no unit
    expect(parseDuration('5ms')).toBeNull()       // wrong unit
    expect(parseDuration('1.5m')).toBeNull()      // decimal
    expect(parseDuration('-5m')).toBeNull()       // negative
  })

  test('returns null for zero', () => {
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
  })

  test('returns null for over 24h', () => {
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('1441m')).toBeNull()   // 24h1m = 86460000 > MAX
  })

  test('boundary: 24h exactly is valid', () => {
    expect(parseDuration('24h')).toBe(MAX_DURATION_MS)
    expect(parseDuration('1440m')).toBe(MAX_DURATION_MS)
    expect(parseDuration('86400s')).toBe(MAX_DURATION_MS)
  })
})

// ---------------------------------------------------------------------------
// extractPhaseBudget
// ---------------------------------------------------------------------------
describe('extractPhaseBudget', () => {
  test('extracts budget at end of topic', () => {
    const r = extractPhaseBudget('do stuff --phase-budget 5m')
    expect(r.budgetMs).toBe(300_000)
    expect(r.topic).toBe('do stuff')
  })

  test('extracts budget at start of topic', () => {
    const r = extractPhaseBudget('--phase-budget 1h do stuff')
    expect(r.budgetMs).toBe(3_600_000)
    expect(r.topic).toBe('do stuff')
  })

  test('extracts budget in middle of topic', () => {
    const r = extractPhaseBudget('do --phase-budget 30m stuff')
    expect(r.budgetMs).toBe(1_800_000)
    expect(r.topic).toBe('do stuff')
  })

  test('supports = separator', () => {
    const r = extractPhaseBudget('task --phase-budget=20m done')
    expect(r.budgetMs).toBe(1_200_000)
    expect(r.topic).toBe('task done')
  })

  test('no budget: returns topic unchanged', () => {
    const r = extractPhaseBudget('just a topic')
    expect(r.topic).toBe('just a topic')
    expect(r.budgetMs).toBeUndefined()
  })

  test('invalid budget: leaves flag in topic (surfaced in thread name)', () => {
    const r = extractPhaseBudget('task --phase-budget abc')
    expect(r.budgetMs).toBeUndefined()
    expect(r.topic).toBe('task --phase-budget abc')
  })
})

// ---------------------------------------------------------------------------
// transformProtocolTag
// ---------------------------------------------------------------------------
describe('transformProtocolTag', () => {
  test('strips [role→role] sentinel from first line', () => {
    expect(transformProtocolTag('[critic→owner] my review')).toBe('my review')
    expect(transformProtocolTag('[owner→critic] defense text')).toBe('defense text')
  })

  test('preserves body after stripping sentinel', () => {
    const input = '[critic→owner]\n\nThis is the review body.'
    expect(transformProtocolTag(input)).toBe('This is the review body.')
  })

  test('preserves text without sentinel unchanged', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
    expect(transformProtocolTag('[done]\nartifact')).toBe('[done]\nartifact')
    expect(transformProtocolTag('[summary]\ncontent')).toBe('[summary]\ncontent')
  })

  test('returns original if stripping would produce empty string', () => {
    // sentinel only, nothing after → original returned
    const input = '[critic→owner]'
    expect(transformProtocolTag(input)).toBe(input)
  })

  test('handles multi-word role names with hyphens', () => {
    expect(transformProtocolTag('[build-owner→critic] text')).toBe('text')
  })

  test('case insensitive sentinel match', () => {
    expect(transformProtocolTag('[Critic→Owner] text')).toBe('text')
  })

  test('sentinel must be on first line', () => {
    const input = 'intro\n[critic→owner] not a sentinel'
    expect(transformProtocolTag(input)).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------
describe('chunk', () => {
  test('short text returned as single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
    expect(chunk('hello', 100, 'newline')).toEqual(['hello'])
    expect(chunk('hello', 100, 'markdown')).toEqual(['hello'])
  })

  test('length mode: splits at hard limit', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBeGreaterThan(1)
    for (const c of result) expect(c.length).toBeLessThanOrEqual(100)
    expect(result.join('')).toBe(text)
  })

  test('newline mode: prefers paragraph boundaries', () => {
    const text = 'paragraph one\n\nparagraph two\n\nparagraph three'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be a recognizable paragraph
    const joined = result.join('')
    expect(joined).toContain('paragraph one')
    expect(joined).toContain('paragraph two')
  })

  test('markdown mode: respects code fences', () => {
    const text = '```js\nconst x = 1\nconst y = 2\nconst z = 3\n```'
    const result = chunk(text, 20, 'markdown')
    // If split, any chunk opening a fence should close it
    for (const c of result) {
      const opens = (c.match(/^```/gm) || []).length
      const closes = (c.match(/^```$/gm) || []).length
      // Either balanced or the fence is properly continued
      expect(opens - closes).toBeLessThanOrEqual(1)
    }
  })

  test('markdown mode: unclosed fence gets closed', () => {
    const longCode = '```ts\n' + 'const x = 1\n'.repeat(20) + '```'
    const result = chunk(longCode, 100, 'markdown')
    if (result.length > 1) {
      // First chunk should end with ``` if it was split mid-fence
      const firstHasFenceClose = result[0].endsWith('```')
      const firstHasFenceOpen = result[0].startsWith('```')
      if (firstHasFenceOpen && !result[0].includes('\n```\n')) {
        expect(firstHasFenceClose).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription
// ---------------------------------------------------------------------------
describe('fallbackDescription', () => {
  test('returns first line of topic', () => {
    expect(fallbackDescription('hello world\nsecond line')).toBe('hello world')
  })

  test('strips leading slash command', () => {
    expect(fallbackDescription('/spawn: do the thing')).toBe('do the thing')
  })

  test('truncates at 100 chars', () => {
    const long = 'x'.repeat(120)
    const result = fallbackDescription(long)
    expect(result.length).toBe(100)
    expect(result.endsWith('...')).toBe(true)
  })

  test('single line within limit returned as-is', () => {
    expect(fallbackDescription('short topic')).toBe('short topic')
  })
})

// ---------------------------------------------------------------------------
// formatSpawnLine
// ---------------------------------------------------------------------------
describe('formatSpawnLine', () => {
  test('basic format', () => {
    const result = formatSpawnLine({
      emoji: '🌟',
      name: 'cedar',
      model: 'claude-opus-4-6',
      trigger: 'spawn:',
    })
    expect(result).toContain('cedar')
    expect(result).toContain('claude-opus-4-6')
    expect(result).toContain('spawn:')
    expect(result).toStartWith('>')
  })

  test('includes role label when provided', () => {
    const result = formatSpawnLine({
      roleLabel: 'build-owner',
      emoji: '🔨',
      name: 'moss',
      model: 'claude-sonnet-4-6',
      trigger: 'review',
    })
    expect(result).toContain('Build-Owner')
    expect(result).toContain('moss')
  })

  test('includes initiator in by clause', () => {
    const result = formatSpawnLine({
      emoji: '⚡',
      name: 'sage',
      model: 'claude-opus-4-6',
      trigger: 'factory:',
      initiator: 'comet',
    })
    expect(result).toContain('from comet')
  })

  test('no initiator: trigger only', () => {
    const result = formatSpawnLine({
      emoji: '⚡',
      name: 'sage',
      model: 'claude-opus-4-6',
      trigger: 'spawn:',
    })
    expect(result).toContain('spawn:')
    expect(result).not.toContain('from')
  })
})
