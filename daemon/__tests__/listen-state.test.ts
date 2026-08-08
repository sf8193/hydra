import { describe, test, expect } from 'bun:test'
import { resolveListenStatePure } from '../session-lifecycle.js'

process.stderr.write = (() => true) as any

describe('resolveListenStatePure', () => {
  test('listenOverride wins over everything', () => {
    expect(resolveListenStatePure('ch1', { groups: { ch1: { defaultListen: false } }, defaultListen: false }, true)).toBe(true)
    expect(resolveListenStatePure('ch1', { groups: { ch1: { defaultListen: true } }, defaultListen: true }, false)).toBe(false)
  })

  test('channel group defaultListen applies when no override', () => {
    expect(resolveListenStatePure('ch1', { groups: { ch1: { defaultListen: true } } })).toBe(true)
    expect(resolveListenStatePure('ch1', { groups: { ch1: { defaultListen: false } } })).toBe(false)
  })

  test('parent channel group applies when direct channelId misses', () => {
    expect(resolveListenStatePure('thread-id', { groups: { 'parent-ch': { defaultListen: true } } }, undefined, 'parent-ch')).toBe(true)
  })

  test('falls through to global defaultListen when no group matches', () => {
    expect(resolveListenStatePure('ch1', { groups: {}, defaultListen: true })).toBe(true)
  })

  test('defaults to false when nothing is configured', () => {
    expect(resolveListenStatePure(undefined, { groups: {} })).toBe(false)
  })

  test('respawn path: no channelId, parent from thread registry', () => {
    expect(resolveListenStatePure(undefined, { groups: { 'parent-ch': { defaultListen: true } } }, undefined, 'parent-ch')).toBe(true)
  })

  test('recovery path: no channelId or parentChannelId, anchorChannelId from thread registry', () => {
    expect(resolveListenStatePure(undefined, { groups: { 'anchor-ch': { defaultListen: true } } }, undefined, undefined, 'anchor-ch')).toBe(true)
  })

  test('anchorChannelId is lowest priority in group lookup', () => {
    const access = { groups: { 'parent-ch': { defaultListen: false }, 'anchor-ch': { defaultListen: true } } }
    expect(resolveListenStatePure(undefined, access, undefined, 'parent-ch', 'anchor-ch')).toBe(false)
  })
})
