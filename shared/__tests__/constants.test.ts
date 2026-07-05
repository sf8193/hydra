import { describe, test, expect } from 'bun:test'
import { resolveModelAlias, isKnownModel, MODEL_ALIASES, MODEL_ALIAS_PATTERN, KNOWN_MODELS } from '../constants.js'

describe('resolveModelAlias', () => {
  test('resolves short aliases', () => {
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-6[1m]')
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-6[1m]')
    expect(resolveModelAlias('fable')).toBe('claude-fable-5[1m]')
  })

  test('resolves hyphenated aliases', () => {
    expect(resolveModelAlias('opus-4-7')).toBe('claude-opus-4-7[1m]')
    expect(resolveModelAlias('opus-4-8')).toBe('claude-opus-4-8[1m]')
    expect(resolveModelAlias('sonnet-5')).toBe('claude-sonnet-5[1m]')
  })

  test('is case-insensitive', () => {
    expect(resolveModelAlias('Sonnet')).toBe('claude-sonnet-4-6[1m]')
    expect(resolveModelAlias('HAIKU')).toBe('claude-haiku-4-5-20251001')
  })

  test('returns undefined for unknown aliases', () => {
    expect(resolveModelAlias('gpt-4')).toBeUndefined()
    expect(resolveModelAlias('wt')).toBeUndefined()
    expect(resolveModelAlias('')).toBeUndefined()
  })

  test('returns undefined for full model IDs (not an alias lookup)', () => {
    expect(resolveModelAlias('claude-opus-4-6')).toBeUndefined()
    expect(resolveModelAlias('claude-sonnet-4-6[1m]')).toBeUndefined()
  })
})

describe('isKnownModel', () => {
  test('recognizes bare model IDs', () => {
    expect(isKnownModel('claude-opus-4-6')).toBe(true)
    expect(isKnownModel('claude-sonnet-4-6')).toBe(true)
    expect(isKnownModel('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('recognizes [1m] suffixed model IDs', () => {
    expect(isKnownModel('claude-opus-4-6[1m]')).toBe(true)
    expect(isKnownModel('claude-sonnet-4-6[1m]')).toBe(true)
  })

  test('rejects unknown models', () => {
    expect(isKnownModel('gpt-4')).toBe(false)
    expect(isKnownModel('claude-nonexistent')).toBe(false)
    expect(isKnownModel('')).toBe(false)
  })

  test('rejects non-[1m] bracket suffixes', () => {
    expect(isKnownModel('claude-opus-4-6[garbage]')).toBe(false)
    expect(isKnownModel('claude-opus-4-6[99m]')).toBe(false)
    expect(isKnownModel('claude-opus-4-6[beta]')).toBe(false)
  })
})

describe('MODEL_ALIAS_PATTERN', () => {
  test('matches all alias keys', () => {
    const re = new RegExp(`^(${MODEL_ALIAS_PATTERN})$`, 'i')
    for (const key of Object.keys(MODEL_ALIASES)) {
      expect(re.test(key)).toBe(true)
    }
  })

  test('does not match non-aliases', () => {
    const re = new RegExp(`^(${MODEL_ALIAS_PATTERN})$`, 'i')
    expect(re.test('wt')).toBe(false)
    expect(re.test('gpt')).toBe(false)
  })
})

describe('spawn command regex integration', () => {
  const spawnModelRe = new RegExp(`^(?:new session|spawn)\\s+(${MODEL_ALIAS_PATTERN}):\\s*([\\s\\S]+)`, 'i')

  test('matches spawn with alias', () => {
    const m = 'spawn sonnet: investigate thing'.match(spawnModelRe)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('sonnet')
    expect(m![2]).toBe('investigate thing')
  })

  test('matches new session with alias', () => {
    const m = 'new session haiku: quick check'.match(spawnModelRe)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('haiku')
    expect(m![2]).toBe('quick check')
  })

  test('matches hyphenated aliases', () => {
    const m = 'spawn opus-4-7: deep research'.match(spawnModelRe)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('opus-4-7')
  })

  test('does not match non-alias words', () => {
    expect('spawn wt: options_bot fix'.match(spawnModelRe)).toBeNull()
    expect('spawn unknown: topic'.match(spawnModelRe)).toBeNull()
  })

  test('does not match plain spawn:', () => {
    expect('spawn: normal topic'.match(spawnModelRe)).toBeNull()
  })
})
