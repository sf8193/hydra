import { describe, expect, it } from 'bun:test'

import {
  ORPHAN_GRACE_MS,
  blocksRecovery,
  classifyReachability,
  type Reachability,
} from '../session-reachability.js'

const old = ORPHAN_GRACE_MS + 1
const fresh = ORPHAN_GRACE_MS - 1

function classify(over: Partial<Parameters<typeof classifyReachability>[0]>): Reachability {
  return classifyReachability({ executionAlive: true, bridgeConnected: true, ageMs: old, ...over })
}

describe('classifyReachability', () => {
  it('calls a session with a live pane and a connected bridge reachable', () => {
    expect(classify({})).toBe('reachable')
  })

  it('calls a long-running session with no bridge orphaned — the case recovery refused', () => {
    expect(classify({ bridgeConnected: false })).toBe('orphaned')
  })

  it('calls a freshly spawned session with no bridge starting, not orphaned', () => {
    expect(classify({ bridgeConnected: false, ageMs: fresh })).toBe('starting')
  })

  it('treats a connected bridge as reachable however new the session is', () => {
    expect(classify({ ageMs: 0 })).toBe('reachable')
  })

  it('calls a session with no pane gone, bridge state notwithstanding', () => {
    expect(classify({ executionAlive: false, bridgeConnected: false })).toBe('gone')
    expect(classify({ executionAlive: false, bridgeConnected: true })).toBe('gone')
  })

  it('needs the age to pass the grace window, not merely reach it', () => {
    expect(classify({ bridgeConnected: false, ageMs: ORPHAN_GRACE_MS })).toBe('starting')
    expect(classify({ bridgeConnected: false, ageMs: ORPHAN_GRACE_MS + 1 })).toBe('orphaned')
  })

  it('honours an explicit grace window over the default', () => {
    expect(classify({ bridgeConnected: false, ageMs: 500, graceMs: 100 })).toBe('orphaned')
    expect(classify({ bridgeConnected: false, ageMs: 500, graceMs: 10_000 })).toBe('starting')
  })
})

describe('blocksRecovery', () => {
  it('refuses recovery for sessions that are fine or still booting', () => {
    expect(blocksRecovery('reachable')).toBe(true)
    expect(blocksRecovery('starting')).toBe(true)
  })

  it('lets recovery proceed for orphaned and gone sessions', () => {
    expect(blocksRecovery('orphaned')).toBe(false)
    expect(blocksRecovery('gone')).toBe(false)
  })
})
