// T4 (adapter-policy): pins the bridge-register connection role (D1) and the
// spawn sessionMetadata tool list (D7).
import { describe, test, expect } from 'bun:test'
import { connectionRoleFor } from '../bridge-server.js'
import { spawnToolNames } from '../session-lifecycle.js'
import { computeToolsForSession } from '../bridge-tools.js'
import type { SessionInfo } from '../sessions.js'

const claude = { sessionId: 's1', engine: 'claude' } as SessionInfo
const codex = { sessionId: 's2', engine: 'codex' } as SessionInfo

describe('connectionRoleFor', () => {
  test('Claude, role undeclared -> session', () => {
    expect(connectionRoleFor({}, claude)).toBe('session')
  })
  test('Claude, declared control -> control', () => {
    expect(connectionRoleFor({ connectionRole: 'control' }, claude)).toBe('control')
  })
  test('Codex, role undeclared -> control', () => {
    expect(connectionRoleFor({}, codex)).toBe('control')
  })
  test('Codex, declared session -> control', () => {
    expect(connectionRoleFor({ connectionRole: 'session' }, codex)).toBe('control')
  })
  test('no record, undeclared -> session', () => {
    expect(connectionRoleFor({}, undefined)).toBe('session')
  })
})

describe('spawnToolNames', () => {
  test('Claude gets the computed tool list', () => {
    const expected = computeToolsForSession('thread_owner', new Set()).map(t => t.name)
    expect(expected.length).toBeGreaterThan(0)
    expect(spawnToolNames('claude', 'thread_owner')).toEqual(expected)
  })
  test('Codex gets []', () => {
    expect(spawnToolNames('codex', 'thread_owner')).toEqual([])
  })
})
