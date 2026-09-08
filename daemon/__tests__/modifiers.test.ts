import { describe, test, expect } from 'bun:test'
import { resolveModifier, resolveModifiers, listModifierKeys, partitionFlagModifiers, partitionSpawnModifiers, validateModifier, reservedRunParams } from '../modifiers.js'

describe('modifier registry', () => {
  test('security modifier resolves by name', () => {
    const mod = resolveModifier('security')
    expect(mod).toBeDefined()
    expect(mod!.type).toBe('seed')
    expect(mod!.name).toBe('security')
    expect(mod!.target).toBe('critic')
    expect(mod!.instructions).toContain('attack surface')
  })

  test('security modifier resolves by alias', () => {
    const mod = resolveModifier('s')
    expect(mod).toBeDefined()
    expect(mod!.name).toBe('security')
  })

  test('unknown modifier returns undefined', () => {
    expect(resolveModifier('nonexistent')).toBeUndefined()
  })

  test('resolveModifiers deduplicates aliases and splits unknown', () => {
    const { resolved, unknown } = resolveModifiers(['s', 'security', 'curate'])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].name).toBe('security')
    expect(unknown).toEqual(['curate'])
  })

  test('listModifierKeys includes names and aliases', () => {
    const keys = listModifierKeys()
    expect(keys).toContain('security')
    expect(keys).toContain('s')
  })
})

describe('flag modifiers', () => {
  test('subagent and no-fallback resolve, by name and by alias, to the params they set', () => {
    for (const [names, param] of [[['subagent', 'sa'], 'directSubagent'], [['no-fallback', 'nf'], 'noFallback']] as const) {
      for (const name of names) {
        const mod = resolveModifier(name)
        expect(mod).toBeDefined()
        expect(mod!.type).toBe('flag')
        expect((mod as { param: string }).param).toBe(param)
      }
    }
  })

  test('flag names reach listModifierKeys — that is what the router regex is built from', () => {
    const keys = listModifierKeys()
    for (const key of ['subagent', 'sa', 'no-fallback', 'nf']) expect(keys).toContain(key)
  })

  test('partitionFlagModifiers turns flags into params and leaves lens modifiers alone', () => {
    const { resolved } = resolveModifiers(['subagent', 'security', 'no-fallback'])
    const { params, rest } = partitionFlagModifiers(resolved)

    expect(params).toEqual({ directSubagent: true, noFallback: true })
    expect(rest).toHaveLength(1)
    expect(rest[0].name).toBe('security')
  })

  test('a run with no flags gets an empty param set, not undefined', () => {
    const { resolved } = resolveModifiers(['security'])
    const { params, rest } = partitionFlagModifiers(resolved)
    expect(params).toEqual({})
    expect(rest).toEqual(resolved)
  })

  test('a flag is not a spawn template — spawn ignores it and says so', () => {
    const { template, ignored } = partitionSpawnModifiers(['subagent', 'factory'])
    expect(template?.name).toBe('factory')
    expect(ignored).toEqual(['subagent'])
  })
})

describe('flag modifier registration discipline', () => {
  test('a flag naming a reserved run param is refused, not left to shadow it silently', () => {
    // partitionFlagModifiers spreads flags last, so such a flag would win over
    // the caller's value. The registry refuses it the way protocol() refuses a
    // half-declared fallback — at registration, not at runtime.
    for (const param of reservedRunParams()) {
      expect(() => validateModifier({ type: 'flag', name: `shadow-${param}`, aliases: [], param }))
        .toThrow(/reserved run param/)
    }
  })

  test('a flag with no param at all is refused', () => {
    expect(() => validateModifier({ type: 'flag', name: 'paramless', aliases: [], param: '' })).toThrow(/must name the run param/)
  })

  test('a flag naming an unreserved param registers fine', () => {
    expect(() => validateModifier({ type: 'flag', name: 'harmless-test-flag', aliases: [], param: 'someOwnParam' })).not.toThrow()
  })

  test('the reserved list covers every param startProtocolRun reads for run shape', () => {
    // If a new run param joins that set, it belongs here too — otherwise a
    // future flag can quietly overwrite it.
    expect(reservedRunParams().sort()).toEqual(['model', 'modifiers', 'rounds', 'strike', 'topic'])
  })
})
