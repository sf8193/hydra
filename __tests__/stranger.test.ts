import { expect, test } from 'bun:test'
import { decide, flagStranger, notePrompt } from '../app/stranger.js'
import { thumbOf } from '../shared/constants.js'

// Regression: a typed "yes" meant for another comment admitted every flagged stranger. Only a reaction on the prompt decides now.
test('a reaction decides only the prompt it is on, once', () => {
  expect(flagStranger('t', 'kevin')).toBe(true)
  notePrompt('m1', 't', 'kevin')
  expect(decide('other-message', true)).toBeUndefined()
  expect(decide('m1', true)).toEqual({ threadId: 't', senderId: 'kevin' })
  expect(decide('m1', true)).toBeUndefined()
})

test('thumbs down keeps the stranger flagged (ignored, not re-prompted); thumbs up clears it', () => {
  flagStranger('t2', 'a'); notePrompt('p', 't2', 'a'); decide('p', false)
  expect(flagStranger('t2', 'a')).toBe(false)
  flagStranger('t3', 'b'); notePrompt('q', 't3', 'b'); decide('q', true)
  expect(flagStranger('t3', 'b')).toBe(true)
})

test('thumbOf reads Slack names and Discord emoji', () => {
  expect([thumbOf('+1'), thumbOf('thumbsup'), thumbOf('👍'), thumbOf('-1'), thumbOf('👎'), thumbOf('hocho')]).toEqual([true, true, true, false, false, undefined])
})
