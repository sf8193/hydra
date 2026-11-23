// T4 (adapter-policy): pins the bridge-register connection role (D1) and the
// spawn sessionMetadata tool list (D7).
import { describe, test, expect } from 'bun:test'
import { connectionRoleFor, __test as bridgeServerTest } from '../../app/bridge-server.js'
import { spawnToolNames } from '../../app/session-lifecycle.js'
import { computeToolsForSession } from '../../engines/bridge-tools.js'
import type { SessionInfo } from '../../sessions/registry.js'
import { engines } from '../../sessions/engine-instances.js'

const claude = { sessionId: 's1', engine: 'claude', adapter: engines.claude } as SessionInfo
const codex = { sessionId: 's2', engine: 'codex', adapter: engines.codex } as SessionInfo

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
    expect(spawnToolNames(engines.claude, 'thread_owner')).toEqual(expected)
  })
  test('Codex gets []', () => {
    expect(spawnToolNames(engines.codex, 'thread_owner')).toEqual([])
  })
})

describe('handleBridgeMessage malformed tool_call reply', () => {
  test('replies with an error tool_result when tool_call has a string id but invalid name or args', () => {
    const written: string[] = []
    const conn = {
      sessionId: 's-malformed',
      socket: {
        destroyed: false,
        write: (chunk: string) => { written.push(chunk); return true },
      },
    } as any

    bridgeServerTest!.handleBridgeMessage(conn, JSON.stringify({ type: 'tool_call', id: 'tc-1', name: 'reply', args: null }))
    bridgeServerTest!.handleBridgeMessage(conn, JSON.stringify({ type: 'tool_call', id: 'tc-2' }))

    expect(written.map(line => JSON.parse(line))).toEqual([
      {
        type: 'tool_result',
        id: 'tc-1',
        content: [{ type: 'text', text: 'Invalid tool_call: tool_call: args must be an object' }],
        isError: true,
      },
      {
        type: 'tool_result',
        id: 'tc-2',
        content: [{ type: 'text', text: 'Invalid tool_call: tool_call: id and name must be strings' }],
        isError: true,
      },
    ])
  })
})
