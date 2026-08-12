import { describe, test, expect } from 'bun:test'
import { resolveModifier, resolveModifiers, listModifierKeys, partitionSpawnModifiers } from '../modifiers.js'

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

  test('partitionSpawnModifiers picks the template and reports the rest as ignored', () => {
    // the template modifier is selected, nothing ignored
    const a = partitionSpawnModifiers(['f'])
    expect(a.template?.templateName).toBe('factory')
    expect(a.ignored).toEqual([])

    // full name works too
    expect(partitionSpawnModifiers(['factory']).template?.templateName).toBe('factory')

    // a seed modifier before a template: template still wins, seed is ignored
    const b = partitionSpawnModifiers(['s', 'f'])
    expect(b.template?.name).toBe('factory')
    expect(b.ignored).toEqual(['s'])

    // no template modifier at all: none selected, seed reported as ignored
    const c = partitionSpawnModifiers(['s'])
    expect(c.template).toBeUndefined()
    expect(c.ignored).toEqual(['s'])

    // unknown names are ignored, not matched
    const d = partitionSpawnModifiers(['nope'])
    expect(d.template).toBeUndefined()
    expect(d.ignored).toEqual(['nope'])

    // a second template modifier is ignored (a spawn uses exactly one)
    const e = partitionSpawnModifiers(['f', 'factory'])
    expect(e.template?.name).toBe('factory')
    expect(e.ignored).toEqual(['factory'])
  })
})
