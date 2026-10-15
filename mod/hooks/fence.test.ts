import { expect, test } from 'claude-code/testing'
import { fenceArt } from './fence.ts'

test('table gets fenced, prose does not', () => {
  expect(fenceArt('hi\n| a | b |\n|---|---|\n| 1 | 2 |\nbye')).toBe('hi\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nbye')
})
test('box art at end of text is closed', () => {
  expect(fenceArt('┌─┐\n└─┘')).toBe('```\n┌─┐\n└─┘\n```')
})
test('already fenced text is untouched', () => {
  const t = '```\n| a | b |\n```'
  expect(fenceArt(t)).toBe(t)
})
test('a longer or ~~~ fence is not closed by a nested marker', () => {
  const a = '````md\n```\n| a |\n```\n````'
  const b = '~~~\n| a | b |\n~~~'
  expect(fenceArt(a)).toBe(a)
  expect(fenceArt(b)).toBe(b)
})
