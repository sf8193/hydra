/**
 * Unit tests for daemon/util.ts pure functions.
 *
 * Functions that depend on gateway or config (safeSend, reportError,
 * assertSendable, atomicWriteFileSync, tmuxHasSession, getContextPercent,
 * isAlive) are integration-level and excluded here.
 */

// config.ts reads env at module init and calls process.exit(1) without tokens.
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'

import { describe, test, expect } from 'bun:test'
import {
  formatDuration,
  parseDuration,
  MAX_DURATION_MS,
  extractPhaseBudget,
  transformProtocolTag,
  chunk,
  fallbackDescription,
  formatSpawnLine,
} from '../daemon/util.js'

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('zero ms → 0m', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  test('minutes only', () => {
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('exact hours', () => {
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(23 * 3_600_000)).toBe('23h')
  })

  test('hours and minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m')
  })

  test('exact days', () => {
    expect(formatDuration(24 * 3_600_000)).toBe('1d')
    expect(formatDuration(2 * 24 * 3_600_000)).toBe('2d')
  })

  test('days and hours', () => {
    expect(formatDuration(25 * 3_600_000)).toBe('1d 1h')
    expect(formatDuration(48 * 3_600_000 + 6 * 3_600_000)).toBe('2d 6h')
  })

  test('sub-minute rounds down', () => {
    // 90 seconds = 1 full minute
    expect(formatDuration(90_000)).toBe('1m')
    // 59 seconds = 0 minutes
    expect(formatDuration(59_000)).toBe('0m')
  })
})

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('parses seconds', () => {
    expect(parseDuration('1s')).toBe(1_000)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('60s')).toBe(60_000)
  })

  test('parses minutes', () => {
    expect(parseDuration('1m')).toBe(60_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('90m')).toBe(90 * 60_000)
  })

  test('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('24h')).toBe(24 * 3_600_000)
  })

  test('case insensitive', () => {
    expect(parseDuration('5M')).toBe(300_000)
    expect(parseDuration('2H')).toBe(2 * 3_600_000)
    expect(parseDuration('10S')).toBe(10_000)
  })

  test('trims whitespace', () => {
    expect(parseDuration('  5m  ')).toBe(300_000)
  })

  test('rejects 0 values', () => {
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
    expect(parseDuration('0h')).toBeNull()
  })

  test('rejects over 24h', () => {
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('1441m')).toBeNull() // 24h01m
  })

  test('accepts exactly 24h', () => {
    expect(parseDuration('24h')).toBe(MAX_DURATION_MS)
  })

  test('rejects invalid formats', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('5')).toBeNull()    // no unit
    expect(parseDuration('5ms')).toBeNull()  // unsupported unit
    expect(parseDuration('5 m')).toBeNull()  // space before unit
    expect(parseDuration('1.5m')).toBeNull() // decimal
    expect(parseDuration('-5m')).toBeNull()  // negative
  })

  test('MAX_DURATION_MS is 24h', () => {
    expect(MAX_DURATION_MS).toBe(24 * 3_600_000)
  })
})

// ---------------------------------------------------------------------------
// extractPhaseBudget
// ---------------------------------------------------------------------------

describe('extractPhaseBudget', () => {
  test('no budget flag → topic unchanged', () => {
    const r = extractPhaseBudget('do some work')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBeUndefined()
  })

  test('budget at end with space', () => {
    const r = extractPhaseBudget('do some work --phase-budget 5m')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBe(300_000)
  })

  test('budget at end with =', () => {
    const r = extractPhaseBudget('do some work --phase-budget=10m')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBe(600_000)
  })

  test('budget in middle', () => {
    const r = extractPhaseBudget('do --phase-budget 2h some work')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBe(2 * 3_600_000)
  })

  test('budget at start', () => {
    const r = extractPhaseBudget('--phase-budget 30s do some work')
    expect(r.topic).toBe('do some work')
    expect(r.budgetMs).toBe(30_000)
  })

  test('unparseable duration left in topic', () => {
    // "abc" is not a valid duration — leave it in topic, no budgetMs
    const r = extractPhaseBudget('do work --phase-budget abc extra')
    expect(r.budgetMs).toBeUndefined()
    expect(r.topic).toBe('do work --phase-budget abc extra')
  })

  test('case insensitive flag', () => {
    const r = extractPhaseBudget('work --PHASE-BUDGET 1h done')
    expect(r.budgetMs).toBe(3_600_000)
    expect(r.topic).toBe('work done')
  })

  test('cleans up extra spaces', () => {
    const r = extractPhaseBudget('a  --phase-budget 5m  b')
    expect(r.topic).toBe('a b')
  })

  test('empty topic after stripping', () => {
    const r = extractPhaseBudget('--phase-budget 5m')
    expect(r.topic).toBe('')
    expect(r.budgetMs).toBe(300_000)
  })

  test('duplicate flags — only first is consumed, second stays in topic', () => {
    // String.match() returns first match; second flag remains in topic string.
    // This documents current behavior rather than asserting it's ideal.
    const r = extractPhaseBudget('work --phase-budget 5m --phase-budget 10m end')
    expect(r.budgetMs).toBe(300_000)        // first flag consumed
    expect(r.topic).toContain('--phase-budget 10m')  // second stays
  })
})

// ---------------------------------------------------------------------------
// transformProtocolTag
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('strips [critic→owner] tag from first line', () => {
    expect(transformProtocolTag('[critic→owner] my critique')).toBe('my critique')
  })

  test('strips [owner→critic] tag', () => {
    expect(transformProtocolTag('[owner→critic] my defense')).toBe('my defense')
  })

  test('strips tag and preserves remaining text', () => {
    const input = '[critic→owner] First line\nSecond line'
    expect(transformProtocolTag(input)).toBe('First line\nSecond line')
  })

  test('strips tag when first line is only the tag', () => {
    const input = '[critic→owner]\nSecond line'
    expect(transformProtocolTag(input)).toBe('Second line')
  })

  test('passes through text without tag', () => {
    expect(transformProtocolTag('plain text')).toBe('plain text')
    expect(transformProtocolTag('[done] artifact')).toBe('[done] artifact')
    expect(transformProtocolTag('[summary] final')).toBe('[summary] final')
  })

  test('only strips from first line — tag on second line untouched', () => {
    const input = 'first line\n[critic→owner] second line'
    expect(transformProtocolTag(input)).toBe(input)
  })

  test('tag with hyphenated role names', () => {
    expect(transformProtocolTag('[build-owner→critic] text')).toBe('text')
  })

  test('returns original text when stripping produces empty result', () => {
    // Edge: [tag] with nothing after → result is empty → return original
    const input = '[critic→owner]'
    const result = transformProtocolTag(input)
    // Should return original because stripped result is empty
    expect(result).toBe(input)
  })

  test('whitespace trimmed after tag removal', () => {
    expect(transformProtocolTag('[critic→owner]   spaced text')).toBe('spaced text')
  })
})

// ---------------------------------------------------------------------------
// chunk — length mode
// ---------------------------------------------------------------------------

describe('chunk — length mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('text exactly at limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBeGreaterThan(1)
    expect(result.every(c => c.length <= 100)).toBe(true)
  })

  test('all chunks concatenate to original (length mode)', () => {
    const text = 'ab cd ef gh ij kl mn op qr st uv wx yz'
    const result = chunk(text, 10, 'length')
    // length mode never strips content — rejoin without separator restores original
    expect(result.join('')).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// chunk — newline mode
// ---------------------------------------------------------------------------

describe('chunk — newline mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'newline')).toEqual(['hello'])
  })

  test('prefers paragraph breaks', () => {
    const text = 'para one\n\npara two\n\npara three'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be reasonable
    result.forEach(c => expect(c.length).toBeLessThanOrEqual(20 + 10))
  })

  test('falls back to line breaks when no paragraph', () => {
    const text = 'line one\nline two\nline three\nline four'
    const result = chunk(text, 15, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })

  test('strips leading newlines from continuation chunks', () => {
    const text = 'aaa\n\nbbb'
    const result = chunk(text, 5, 'newline')
    result.forEach(c => expect(c.startsWith('\n')).toBe(false))
  })
})

// ---------------------------------------------------------------------------
// chunk — markdown mode
// ---------------------------------------------------------------------------

describe('chunk — markdown mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'markdown')).toEqual(['hello'])
  })

  test('closes open code fence when splitting', () => {
    // Construct text that MUST be split: 3 long lines inside a fence, limit=40
    const text = '```js\nconst alpha = "aaaaaaaaaa";\nconst beta = "bbbbbbbbbbb";\nconst gamma = "cccccccccc";\n```'
    const result = chunk(text, 40, 'markdown')
    // With limit=40, the full text (97 chars) must split
    expect(result.length).toBeGreaterThan(1)
    // Every split chunk that opened a fence must close it (fence repair)
    for (let i = 0; i < result.length - 1; i++) {
      const c = result[i]
      // Count openers (``` followed by anything) vs closers (``` alone on a line)
      const openers = (c.match(/^```\S*/gm) ?? []).length
      const closers = (c.match(/^```$/gm) ?? []).length
      // An open fence in a non-final chunk must be closed
      if (openers > closers) {
        expect(c.trimEnd()).toMatch(/```$/)
      }
    }
  })

  test('prefers splitting at paragraph boundaries', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three and more text here.'
    const result = chunk(text, 25, 'markdown')
    expect(result.length).toBeGreaterThan(1)
  })

  test('all chunks together have same content as original', () => {
    const text = 'Line A\nLine B\nLine C\nLine D\nLine E'
    const result = chunk(text, 15, 'markdown')
    // Content preserved (strips are allowed at boundaries)
    const rejoined = result.join('\n')
    expect(rejoined.includes('Line A')).toBe(true)
    expect(rejoined.includes('Line E')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('returns first line for short topics', () => {
    expect(fallbackDescription('simple topic')).toBe('simple topic')
  })

  test('strips slash commands from start', () => {
    expect(fallbackDescription('/spawn some topic')).toBe('some topic')
    expect(fallbackDescription('/review: audit the auth')).toBe('audit the auth')
  })

  test('truncates at 100 chars', () => {
    const long = 'a'.repeat(150)
    const result = fallbackDescription(long)
    expect(result.endsWith('...')).toBe(true)
    expect(result.length).toBe(100)
  })

  test('uses only first line for multi-line topics', () => {
    const result = fallbackDescription('first line\nsecond line')
    expect(result).toBe('first line')
  })

  test('strips slash command before truncation', () => {
    const long = '/spawn ' + 'a'.repeat(150)
    const result = fallbackDescription(long)
    expect(result.endsWith('...')).toBe(true)
    expect(result.length).toBe(100)
  })

  test('slash command with no space — entire token stripped, returns empty', () => {
    // /spawn:topic matches /^\\/\\S+\\s*/ as one token → entire string stripped → empty
    // This documents the edge case: fallbackDescription can return '' for
    // inputs like '/spawn:topic' where the command and content are joined.
    const result = fallbackDescription('/spawn:topic')
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatSpawnLine
// ---------------------------------------------------------------------------

describe('formatSpawnLine', () => {
  test('minimal: emoji, name, model, trigger — no roleLabel or initiator', () => {
    const result = formatSpawnLine({ emoji: '🌱', name: 'cedar', model: 'opus', trigger: 'spawn:' })
    expect(result).toBe('> ⚡ spawned [ 🌱 cedar ] · model `opus` · by spawn:')
  })

  test('with initiator shows "trigger from initiator"', () => {
    const result = formatSpawnLine({ emoji: '🌱', name: 'cedar', model: 'opus', trigger: 'factory:', initiator: 'comet' })
    expect(result).toBe('> ⚡ spawned [ 🌱 cedar ] · model `opus` · by factory: from comet')
  })

  test('with roleLabel adds "The Role •" prefix', () => {
    const result = formatSpawnLine({ emoji: '⚔️', name: 'fern', model: 'sonnet', trigger: 'review', roleLabel: 'critic' })
    expect(result).toContain('The Critic •')
    expect(result).toContain('⚔️ fern')
  })

  test('roleLabel is title-cased including hyphenated parts', () => {
    const result = formatSpawnLine({ emoji: '🔨', name: 'bolt', model: 'haiku', trigger: 'build', roleLabel: 'build-owner' })
    expect(result).toContain('The Build-Owner •')
  })

  test('all params present', () => {
    const result = formatSpawnLine({
      emoji: '🏗️', name: 'sage', model: 'opus-5', trigger: 'factory:',
      roleLabel: 'builder', initiator: 'comet',
    })
    expect(result).toContain('The Builder •')
    expect(result).toContain('🏗️ sage')
    expect(result).toContain('opus-5')
    expect(result).toContain('factory: from comet')
    expect(result.startsWith('> ⚡ spawned [')).toBe(true)
  })
})
