import { afterEach, describe, test, expect } from 'bun:test'
import { resolveListenStatePure } from '../../app/session-lifecycle.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { setHydra } from './test-hydra.js'

process.stderr.write = (() => true) as any
afterEach(() => _setHydraConfigForTesting(undefined))

// hydra.toml's channel `listen` and `[gateways.<platform>] listen`, in the order a thread resolves them.
describe('resolveListenStatePure', () => {
  test('listenOverride wins over everything', () => {
    setHydra({ channels: { ch1: { listen: false } }, gate: { off: false, listen: false } })
    expect(resolveListenStatePure('ch1', true)).toBe(true)
    setHydra({ channels: { ch1: { listen: true } }, gate: { off: false, listen: true } })
    expect(resolveListenStatePure('ch1', false)).toBe(false)
  })

  test('channel listen applies when no override', () => {
    setHydra({ channels: { ch1: { listen: true } } })
    expect(resolveListenStatePure('ch1')).toBe(true)
    setHydra({ channels: { ch1: { listen: false } } })
    expect(resolveListenStatePure('ch1')).toBe(false)
  })

  test('parent channel applies when direct channelId misses', () => {
    setHydra({ channels: { 'parent-ch': { listen: true } } })
    expect(resolveListenStatePure('thread-id', undefined, 'parent-ch')).toBe(true)
  })

  test('falls through to the gateway listen when no channel matches', () => {
    setHydra({ gate: { off: false, listen: true } })
    expect(resolveListenStatePure('ch1')).toBe(true)
  })

  test('defaults to false when nothing is configured', () => {
    setHydra()
    expect(resolveListenStatePure(undefined)).toBe(false)
  })

  test('respawn path: no channelId, parent from thread registry', () => {
    setHydra({ channels: { 'parent-ch': { listen: true } } })
    expect(resolveListenStatePure(undefined, undefined, 'parent-ch')).toBe(true)
  })

  test('recovery path: no channelId or parentChannelId, anchorChannelId from thread registry', () => {
    setHydra({ channels: { 'anchor-ch': { listen: true } } })
    expect(resolveListenStatePure(undefined, undefined, undefined, 'anchor-ch')).toBe(true)
  })

  test('anchorChannelId is lowest priority in channel lookup', () => {
    setHydra({ channels: { 'parent-ch': { listen: false }, 'anchor-ch': { listen: true } } })
    expect(resolveListenStatePure(undefined, undefined, 'parent-ch', 'anchor-ch')).toBe(false)
  })

  test('full priority chain: channelId > parentChannelId > anchorChannelId', () => {
    setHydra({ channels: { ch: { listen: false }, 'parent-ch': { listen: true }, 'anchor-ch': { listen: true } } })
    expect(resolveListenStatePure('ch', undefined, 'parent-ch', 'anchor-ch')).toBe(false)
  })
})
