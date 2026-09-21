import { describe, test, expect, afterEach } from 'bun:test'
import { SESSION_LABELS, isSessionLabel, parseSessionLabel, resolveModelAlias, resolveCodexModelAlias, isKnownModel, canonicalModel, byteTmuxName, MODEL_ALIASES, MODEL_ALIAS_PATTERN, CODEX_MODEL_ALIASES, CODEX_MODEL_ALIAS_PATTERN, KNOWN_MODELS } from '../constants.js'

describe('resolveModelAlias', () => {
  test('resolves short aliases', () => {
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5[1m]')
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-6[1m]')
    expect(resolveModelAlias('fable')).toBe('claude-fable-5-1[1m]')
  })

  test('resolves hyphenated aliases', () => {
    expect(resolveModelAlias('opus-4-7')).toBe('claude-opus-4-7[1m]')
    expect(resolveModelAlias('opus-4-8')).toBe('claude-opus-4-8[1m]')
    // sonnet-5 alias removed — 'sonnet' now points to sonnet-5
  })

  test('is case-insensitive', () => {
    expect(resolveModelAlias('Sonnet')).toBe('claude-sonnet-5[1m]')
    expect(resolveModelAlias('HAIKU')).toBe('claude-haiku-4-5-20251001')
  })

  test('returns undefined for unknown aliases', () => {
    expect(resolveModelAlias('gpt-4')).toBeUndefined()
    expect(resolveModelAlias('wt')).toBeUndefined()
    expect(resolveModelAlias('')).toBeUndefined()
  })

  test('returns undefined for full model IDs (not an alias lookup)', () => {
    expect(resolveModelAlias('claude-opus-4-6')).toBeUndefined()
    expect(resolveModelAlias('claude-sonnet-5[1m]')).toBeUndefined()
  })
})

describe('resolveCodexModelAlias', () => {
  test('resolves Codex aliases case-insensitively', () => {
    expect(resolveCodexModelAlias('astra')).toBe('gpt-6-astra')
    expect(resolveCodexModelAlias('sol')).toBe('gpt-5.6-sol')
    expect(resolveCodexModelAlias('Terra')).toBe('gpt-5.6-terra')
    expect(resolveCodexModelAlias('LUNA')).toBe('gpt-5.6-luna')
  })

  test('does not treat Claude or unknown aliases as Codex models', () => {
    expect(resolveCodexModelAlias('opus')).toBeUndefined()
    expect(resolveCodexModelAlias('spark')).toBeUndefined()
  })
})

describe('isKnownModel', () => {
  test('recognizes bare model IDs', () => {
    expect(isKnownModel('claude-opus-4-6')).toBe(true)
    expect(isKnownModel('claude-sonnet-5')).toBe(true)
    expect(isKnownModel('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('recognizes [1m] suffixed model IDs', () => {
    expect(isKnownModel('claude-opus-4-6[1m]')).toBe(true)
    expect(isKnownModel('claude-sonnet-5[1m]')).toBe(true)
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

describe('Codex spawn command regex integration', () => {
  const spawnCodexModelRe = new RegExp(`^(?:new session|spawn)\\s+(${CODEX_MODEL_ALIAS_PATTERN}):\\s*([\\s\\S]+)`, 'i')

  test('matches every Codex model alias', () => {
    for (const alias of Object.keys(CODEX_MODEL_ALIASES)) {
      const match = `spawn ${alias}: investigate thing`.match(spawnCodexModelRe)
      expect(match?.[1]).toBe(alias)
      expect(match?.[2]).toBe('investigate thing')
    }
  })

  test('does not capture Claude or unknown aliases', () => {
    expect('spawn opus: topic'.match(spawnCodexModelRe)).toBeNull()
    expect('spawn spark: topic'.match(spawnCodexModelRe)).toBeNull()
  })
})

describe('prototype-key safety', () => {
  // Plain object literals inherit from Object.prototype, so a bare index
  // returns the constructor for 'constructor'. These feed an egress allowlist.
  test.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    '%p is not a model', (key) => {
      expect(isKnownModel(key)).toBe(false)
      expect(resolveCodexModelAlias(key)).toBeUndefined()
      expect(resolveModelAlias(key)).toBeUndefined()
      expect(canonicalModel(key)).toBeUndefined()
    })
})

describe('canonicalModel', () => {
  // Case-insensitive on the codex arm only; known Claude models are an exact
  // Set lookup, so a mis-cased one is dropped rather than corrected.
    test('passes known claude models through unchanged', () => {
    expect(canonicalModel('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
    expect(canonicalModel('claude-fable-5')).toBe('claude-fable-5')
  })

  test('rejects anything uncatalogued', () => {
    expect(canonicalModel('SSN 123-45-6789')).toBeUndefined()
    expect(canonicalModel('claude-opus-5[1m][1m]')).toBeUndefined()
    expect(canonicalModel('CLAUDE-OPUS-5')).toBeUndefined()
    expect(canonicalModel('claude-opus-5[1M]')).toBeUndefined()
  })
})

describe('parseSessionLabel', () => {
  test.each(['review', 'build', 'investigate'] as const)('--%s is lifted off the topic', (label) => {
    expect(parseSessionLabel(`fix the thing --${label}`)).toEqual({ label, topic: 'fix the thing' })
  })

  // The topic becomes the prompt, so stray whitespace around a stripped flag
  // is user-visible.
  test.each([
    [' --review fix the bug', 'fix the bug'],
    ['a  --review', 'a'],
    ['  --build   ship it  ', 'ship it'],
  ])('%p leaves no stray whitespace in %p', (input, topic) => {
    expect(parseSessionLabel(input).topic).toBe(topic)
  })

  test('an unlabelled topic is returned untouched', () => {
    expect(parseSessionLabel('fix the thing')).toEqual({ topic: 'fix the thing' })
  })

  // A hyphen is a word boundary, so --build once matched inside --build-tools
  // and swallowed the space in front of it.
  // The leading anchor needs its own boundary: without it "--build-tools now"
  // became label=build with topic "-tools now", and the topic is the prompt.
  test.each([
    '--build-tools now',
    '--reviewer notes',
    '--investigate-later x',
    'ship it--build',
  ])('a lookalike at the edges of %p is not a label', (topic) => {
    expect(parseSessionLabel(topic)).toEqual({ topic })
  })

  test.each([
    'read --reviewer notes',
    'ship it --build-tools now',
    'x --build/y',
    'see --investigate-later',
    'path/--review/notes',
  ])('a lookalike %p is not a label and leaves the topic intact', (topic) => {
    expect(parseSessionLabel(topic)).toEqual({ topic })
  })

  // Two flags is not a supported form; what matters is that neither survives
  // into the prompt. Which one wins depends on the end they sit at — leading
  // flags resolve left-to-right, trailing ones right-to-left.
  test('with two flags one is chosen and both are stripped', () => {
    expect(parseSessionLabel('--build --review foo')).toEqual({ label: 'build', topic: 'foo' })
    expect(parseSessionLabel('--review --build foo')).toEqual({ label: 'review', topic: 'foo' })
    // Trailing flags are consumed right-to-left, so the rightmost is chosen.
    expect(parseSessionLabel('foo --review --build')).toEqual({ label: 'build', topic: 'foo' })
  })

  // The topic is the prompt the session is given, so a flag only counts where
  // a flag is actually typed. Matching mid-sentence deleted words from prompts.
  test.each([
    'run the linter with --build and report',
    'compare --review and --build modes',
    'a --investigate b --build c',
    'explain --review to me',
  ])('a flag inside prose in %p is left alone', (topic) => {
    expect(parseSessionLabel(topic)).toEqual({ topic })
  })

  test('no label flag survives into the spawned prompt', () => {
    for (const l of ['review', 'build', 'investigate']) {
      expect(parseSessionLabel('--build --review --investigate x').topic).not.toContain(`--${l}`)
    }
  })

  test.each([
    ['--review thing', 'thing'],
    ['a b --build', 'a b'],
    ['fix --investigate', 'fix'],
  ])('a real flag in %p yields topic %p', (input, topic) => {
    expect(parseSessionLabel(input).topic).toBe(topic)
  })

  test('the label never survives into the topic the session is given', () => {
    expect(parseSessionLabel('ship it --build').topic).not.toContain('--build')
  })
})

describe('byteTmuxName', () => {
  const saved = process.env.BYTE_SESSION_NAME
  afterEach(() => {
    if (saved === undefined) delete process.env.BYTE_SESSION_NAME
    else process.env.BYTE_SESSION_NAME = saved
  })

  test('an explicit name wins', () => {
    process.env.BYTE_SESSION_NAME = 'custom-byte'
    expect(byteTmuxName('slack')).toBe('custom-byte')
  })

  // `||` not `??`: a blank value in .env must fall through, or the daemon
  // targets tmux session "" while the shell scripts target <platform>-byte.
  test('a blank value falls through to the platform default', () => {
    process.env.BYTE_SESSION_NAME = ''
    expect(byteTmuxName('slack')).toBe('slack-byte')
  })

  test('unset falls through too', () => {
    delete process.env.BYTE_SESSION_NAME
    expect(byteTmuxName('discord')).toBe('discord-byte')
  })
})

test('canonicalModel resolves a Claude chat alias, not only a codex one', () => {
  expect(canonicalModel('opus')).toBe(MODEL_ALIASES['opus'])
  expect(canonicalModel('sol')).toBe(CODEX_MODEL_ALIASES['sol'])
})

describe('SESSION_LABELS', () => {
  // A wire contract: `label` rides on every raindrop session event, and any
  // template named after one is auto-labelled. Adding a member changes both.
  test('is exactly the three buckets', () => {
    expect([...SESSION_LABELS]).toEqual(['review', 'build', 'investigate'])
  })

  test('isSessionLabel admits exactly those and nothing else', () => {
    for (const l of SESSION_LABELS) expect(isSessionLabel(l)).toBe(true)
    for (const n of ['fix', 'factory', 'Review', 'design', '', 'constructor']) expect(isSessionLabel(n)).toBe(false)
  })

  test('the flag grammar covers every member', () => {
    for (const l of SESSION_LABELS) expect(parseSessionLabel(`do it --${l}`)).toEqual({ label: l, topic: 'do it' })
  })
})
