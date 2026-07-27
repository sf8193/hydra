import { describe, test, expect } from 'bun:test'
import { resolveModifier, resolveModifiers, listModifierKeys } from '../modifiers.js'

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
