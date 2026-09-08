import { describe, test, expect } from 'bun:test'
import { resolveModifier, resolveModifiers, listModifierKeys, partitionFlagModifiers, partitionSpawnModifiers } from '../modifiers.js'

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
