import { describe, expect, test } from 'bun:test'
import { selectDefaultCodexModel } from '../codex-engine.js'

describe('selectDefaultCodexModel', () => {
  test('returns the model marked as default', () => {
    expect(selectDefaultCodexModel({ data: [
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', isDefault: false },
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: true },
    ] })).toBe('gpt-5.6-sol')
  })

  test('falls back to id for older model-list responses', () => {
    expect(selectDefaultCodexModel({ data: [{ id: 'gpt-default', isDefault: true }] })).toBe('gpt-default')
  })

  test('returns undefined when the response has no declared default', () => {
    expect(selectDefaultCodexModel({ data: [{ model: 'gpt-5.6-sol' }] })).toBeUndefined()
    expect(selectDefaultCodexModel(null)).toBeUndefined()
  })
})
