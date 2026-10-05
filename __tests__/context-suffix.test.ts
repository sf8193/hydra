import { test, expect } from 'bun:test'
import { withContextSuffix, contextWindowOf } from '../shared/constants.js'

test('bare known 1M-capable ID gets [1m]; others unchanged', () => {
  expect(withContextSuffix('claude-opus-5-5')).toBe('claude-opus-5-5[1m]')
  expect(contextWindowOf(withContextSuffix('claude-opus-5-5'))).toBe(1_000_000)
  expect(withContextSuffix('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  expect(withContextSuffix('gpt-6-astra')).toBe('gpt-6-astra')
})
