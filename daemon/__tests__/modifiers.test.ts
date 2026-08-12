import { describe, test, expect } from 'bun:test'
import { resolveModifier, resolveModifiers, listModifierKeys, resolveTemplateModifier } from '../modifiers.js'

describe('modifier registry', () => {
  test('security modifier resolves by name', () => {
    const mod = resolveModifier('security')
    expect(mod).toBeDefined()
    if (!mod || mod.type !== 'seed') throw new Error('expected seed modifier')
    expect(mod.name).toBe('security')
    expect(mod.target).toBe('critic')
    expect(mod.instructions).toContain('attack surface')
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

  test('factory template modifier resolves by name and alias', () => {
    const byName = resolveModifier('factory')
    expect(byName).toBeDefined()
    expect(byName!.type).toBe('template')
    expect((byName as { templateName: string }).templateName).toBe('factory')

    const byAlias = resolveModifier('f')
    expect(byAlias).toBeDefined()
    expect(byAlias!.name).toBe('factory')
  })

  test('resolveTemplateModifier returns the first template modifier', () => {
    expect(resolveTemplateModifier(['f'])?.templateName).toBe('factory')
    expect(resolveTemplateModifier(['factory'])?.templateName).toBe('factory')
    // seed modifiers are not template modifiers
    expect(resolveTemplateModifier(['s'])).toBeUndefined()
    // a seed modifier before a template modifier: the template one still wins
    expect(resolveTemplateModifier(['s', 'f'])?.name).toBe('factory')
    // unknown names are ignored
    expect(resolveTemplateModifier(['nope'])).toBeUndefined()
  })
})
