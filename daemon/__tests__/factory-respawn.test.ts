import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { factoryRespawn, factoryAbandon, __factoryTestHooks } from '../factory.js'

// Suppress stderr noise (safeSend/log write to stderr in test env)
let originalStderrWrite: typeof process.stderr.write
beforeEach(() => {
  originalStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
  __factoryTestHooks.reset()
  // Stub the respawn spawn so no real session machinery runs.
  __factoryTestHooks.setRespawnImpl(async () => {})
})
afterEach(() => {
  __factoryTestHooks.restoreRespawnImpl()
  __factoryTestHooks.reset()
  process.stderr.write = originalStderrWrite
})

describe('factoryRespawn validation', () => {
  test('unknown ticket returns error', () => {
    const result = factoryRespawn('fb-nope', 'pm-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('Unknown ticket')
  })

  test('non-PM caller is rejected', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-1', pmSessionId: 'pm-1', phase: 'failed', builderThreadId: 'thr-1' })
    const result = factoryRespawn('fb-1', 'someone-else')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('Only the PM')
  })

  test('wrong phase (reviewing) is rejected', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-2', pmSessionId: 'pm-1', phase: 'reviewing', builderThreadId: 'thr-2' })
    const result = factoryRespawn('fb-2', 'pm-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('Cannot respawn')
  })

  test('missing builder thread is rejected', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-3', pmSessionId: 'pm-1', phase: 'failed' })
    const result = factoryRespawn('fb-3', 'pm-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('No builder thread')
  })
})

describe('factoryRespawn transition', () => {
  test('dead ticket (failed) transitions back to building', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-4', pmSessionId: 'pm-1', phase: 'failed', builderThreadId: 'thr-4', retryCount: 1 })
    const result = factoryRespawn('fb-4', 'pm-1')
    expect(result).toEqual({ ok: true })
    expect(__factoryTestHooks.getPhase('fb-4')).toBe('building')
    expect(__factoryTestHooks.getRetryCount('fb-4')).toBe(2)
  })

  test('stuck ticket (awaiting_pm) transitions back to building', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-5', pmSessionId: 'pm-1', phase: 'awaiting_pm', builderThreadId: 'thr-5' })
    const result = factoryRespawn('fb-5', 'pm-1')
    expect(result).toEqual({ ok: true })
    expect(__factoryTestHooks.getPhase('fb-5')).toBe('building')
  })
})

describe('factoryAbandon on recoverable failed ticket', () => {
  test('a failed-but-alive ticket can be abandoned', () => {
    // A builder that died in awaiting_pm leaves the ticket in `failed` phase but
    // still in the builds map. The PM must be able to abandon it.
    __factoryTestHooks.seedBuild({ ticket: 'fb-6', pmSessionId: 'pm-1', phase: 'failed' })
    const result = factoryAbandon('fb-6', 'pm-1')
    expect(result).toEqual({ ok: true })
    // Ticket is cleaned up after abandon.
    expect(__factoryTestHooks.getPhase('fb-6')).toBeUndefined()
  })

  test('a completed ticket cannot be abandoned', () => {
    __factoryTestHooks.seedBuild({ ticket: 'fb-7', pmSessionId: 'pm-1', phase: 'complete' })
    const result = factoryAbandon('fb-7', 'pm-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toContain('already completed')
  })
})
