import { describe, expect, test } from 'bun:test'
import { parseCLIRequest, parseCLIResponse } from '../cli-protocol.js'

describe('parseCLIRequest', () => {
  test('parses valid CLI requests across all 14 commands with exact shapes', () => {
    const cases: Array<[string, unknown, unknown]> = [
      [
        'spawn full',
        {
          type: 'cli', command: 'spawn', id: '1', caller: { token: 'abc' },
          params: {
            prompt: 'do x', initiator: 'sam', idempotencyKey: 'k1', channel: 'c1',
            message: 'm1', ephemeral: true, idleTtl: '2h', forceWorktreeCleanup: false,
            quiet: true, model: 'opus', extraIgnored: 'drop-me',
          },
        },
        {
          ok: true,
          request: {
            type: 'cli', command: 'spawn', id: '1', caller: { token: 'abc' },
            params: {
              prompt: 'do x', initiator: 'sam', idempotencyKey: 'k1', channel: 'c1',
              message: 'm1', ephemeral: true, idleTtl: '2h', forceWorktreeCleanup: false,
              quiet: true, model: 'opus',
            },
          },
        },
      ],
      [
        'spawn preserves legacy callerSessionId across non-string values so cliCaller fails closed',
        { type: 'cli', command: 'spawn', id: '2', params: { prompt: 'p', callerSessionId: null } },
        { ok: true, request: { type: 'cli', command: 'spawn', id: '2', params: { prompt: 'p', callerSessionId: null } } },
      ],
      [
        'spawn preserves numeric callerSessionId',
        { type: 'cli', command: 'spawn', id: '2b', params: { prompt: 'p', callerSessionId: 5 } },
        { ok: true, request: { type: 'cli', command: 'spawn', id: '2b', params: { prompt: 'p', callerSessionId: 5 } } },
      ],
      [
        'list preserves withinDays untouched for endedWithinDays validation',
        { type: 'cli', command: 'list', id: '3', params: { ended: true, withinDays: 'bad' } },
        { ok: true, request: { type: 'cli', command: 'list', id: '3', params: { ended: true, withinDays: 'bad' } } },
      ],
      [
        'status with attach',
        { type: 'cli', command: 'status', id: '4', params: { name: 'sage', attach: true } },
        { ok: true, request: { type: 'cli', command: 'status', id: '4', params: { name: 'sage', attach: true } } },
      ],
      [
        'kill preserves destroy and legacy callerSessionId (string and object)',
        { type: 'cli', command: 'kill', id: '5', params: { name: 'sage', destroy: true, callerSessionId: 's-old' } },
        { ok: true, request: { type: 'cli', command: 'kill', id: '5', params: { name: 'sage', destroy: true, callerSessionId: 's-old' } } },
      ],
      [
        'kill preserves object callerSessionId and drops __proto__ in params',
        { type: 'cli', command: 'kill', id: '5b', params: JSON.parse('{"name":"sage","callerSessionId":{"id":"x"},"__proto__":{"polluted":true}}') },
        { ok: true, request: { type: 'cli', command: 'kill', id: '5b', params: { name: 'sage', callerSessionId: { id: 'x' } } } },
      ],
      [
        'health strips extra params',
        { type: 'cli', command: 'health', id: '6', params: { unused: 1 } },
        { ok: true, request: { type: 'cli', command: 'health', id: '6', params: {} } },
      ],
      [
        'clear-key and check-key',
        { type: 'cli', command: 'clear-key', id: '7', params: { key: 'k' } },
        { ok: true, request: { type: 'cli', command: 'clear-key', id: '7', params: { key: 'k' } } },
      ],
      [
        'check-key',
        { type: 'cli', command: 'check-key', id: '8', params: { key: 'k' } },
        { ok: true, request: { type: 'cli', command: 'check-key', id: '8', params: { key: 'k' } } },
      ],
      [
        'deliver full',
        {
          type: 'cli', command: 'deliver', id: '9',
          params: {
            to: 'specialist:ops', conversation: 'c1', message: 'hi', initiator: 'sam',
            idempotencyKey: 'ik', idempotencyTtl: '1h', queue: true, revive: true,
          },
        },
        {
          ok: true,
          request: {
            type: 'cli', command: 'deliver', id: '9',
            params: {
              to: 'specialist:ops', conversation: 'c1', message: 'hi', initiator: 'sam',
              idempotencyKey: 'ik', idempotencyTtl: '1h', queue: true, revive: true,
            },
          },
        },
      ],
      [
        'specialist',
        { type: 'cli', command: 'specialist', id: '10', params: { action: 'show', name: 'ops' } },
        { ok: true, request: { type: 'cli', command: 'specialist', id: '10', params: { action: 'show', name: 'ops' } } },
      ],
      [
        'conversations',
        { type: 'cli', command: 'conversations', id: '11', params: { action: 'bind', conversation: 'c', to: 'ops', why: 'reason' } },
        { ok: true, request: { type: 'cli', command: 'conversations', id: '11', params: { action: 'bind', conversation: 'c', to: 'ops', why: 'reason' } } },
      ],
      [
        'route',
        { type: 'cli', command: 'route', id: '12', params: { person: 'stranger', place: 'slack:C1', app: 'app:default' } },
        { ok: true, request: { type: 'cli', command: 'route', id: '12', params: { person: 'stranger', place: 'slack:C1', app: 'app:default' } } },
      ],
      [
        'jobs-run',
        { type: 'cli', command: 'jobs-run', id: '13', params: { name: 'sweep' } },
        { ok: true, request: { type: 'cli', command: 'jobs-run', id: '13', params: { name: 'sweep' } } },
      ],
      [
        'jobs-mark-done',
        { type: 'cli', command: 'jobs-mark-done', id: '14', params: { name: 'sweep' } },
        { ok: true, request: { type: 'cli', command: 'jobs-mark-done', id: '14', params: { name: 'sweep' } } },
      ],
      [
        'jobs-sync',
        { type: 'cli', command: 'jobs-sync', id: '15', params: {} },
        { ok: true, request: { type: 'cli', command: 'jobs-sync', id: '15', params: {} } },
      ],
    ]

    for (const [label, input, expected] of cases) {
      expect(parseCLIRequest(input), label).toEqual(expected as any)
    }
  })

  test('rejects invalid envelopes, non-object/array params, unknown commands, and wrong param types', () => {
    expect(parseCLIRequest(null)).toEqual({ ok: false, command: '', id: '', error: 'request must be an object' })
    expect(parseCLIRequest({ type: 'other', command: 'health', id: '1', params: {} })).toEqual({
      ok: false, command: 'health', id: '1', error: 'request type must be "cli"',
    })
    expect(parseCLIRequest({ type: 'cli', command: 'health', id: 'probe' })).toEqual({
      ok: false, command: 'health', id: 'probe', error: 'params must be an object',
    })
    expect(parseCLIRequest({ type: 'cli', command: 'health', id: '2', params: [] })).toEqual({
      ok: false, command: 'health', id: '2', error: 'params must be an object',
    })
    expect(parseCLIRequest({ type: 'cli', command: 'foobar', id: '3', params: {} })).toEqual({
      ok: false, command: 'foobar', id: '3', error: 'unknown command: foobar',
    })
    for (const protoCmd of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(parseCLIRequest({ type: 'cli', command: protoCmd, id: '4', params: {} })).toEqual({
        ok: false, command: protoCmd, id: '4', error: `unknown command: ${protoCmd}`,
      })
    }
    expect(parseCLIRequest({ type: 'cli', command: 'status', id: '5', params: { name: 123 } })).toEqual({
      ok: false, command: 'status', id: '5', error: 'invalid param "name": expected string',
    })
    expect(parseCLIRequest({ type: 'cli', command: 'kill', id: '6', params: { name: 'a', destroy: 'true' } })).toEqual({
      ok: false, command: 'kill', id: '6', error: 'invalid param "destroy": expected boolean',
    })
  })
})

describe('parseCLIResponse', () => {
  test('parses valid cli-response frames and rejects malformed ones', () => {
    expect(parseCLIResponse({
      type: 'cli-response', command: 'deliver', id: '1', ok: true, data: { status: 'delivered' }, result: 'done',
    })).toEqual({
      ok: true,
      response: {
        type: 'cli-response', command: 'deliver', id: '1', ok: true, data: { status: 'delivered' }, result: 'done',
      },
    })
    expect(parseCLIResponse({
      type: 'cli-response', command: 'deliver', id: '2', ok: false, error: 'busy', exitCode: 5, result: 'deferred',
    })).toEqual({
      ok: true,
      response: {
        type: 'cli-response', command: 'deliver', id: '2', ok: false, error: 'busy', exitCode: 5, result: 'deferred',
      },
    })
    // Minimal error response from bridge-server catch block (omits command)
    expect(parseCLIResponse({ type: 'cli-response', id: '3', ok: false, error: 'internal error: boom' })).toEqual({
      ok: true,
      response: { type: 'cli-response', command: '', id: '3', ok: false, error: 'internal error: boom' },
    })
    // Minimal { ok: true } reply (omits type, e.g. lightweight socket servers)
    expect(parseCLIResponse({ ok: true })).toEqual({
      ok: true,
      response: { type: 'cli-response', command: '', id: '', ok: true },
    })
    // ok: false without error is accepted
    expect(parseCLIResponse({ type: 'cli-response', command: 'status', id: '4', ok: false })).toEqual({
      ok: true,
      response: { type: 'cli-response', command: 'status', id: '4', ok: false },
    })
    // Unknown result word is dropped rather than failing a valid response (forward-compat)
    expect(parseCLIResponse({ type: 'cli-response', command: 'deliver', id: '5', ok: true, result: 'future_word' })).toEqual({
      ok: true,
      response: { type: 'cli-response', command: 'deliver', id: '5', ok: true },
    })

    expect(parseCLIResponse(null).ok).toBe(false)
    expect(parseCLIResponse({ type: 'other', ok: true }).ok).toBe(false)
    expect(parseCLIResponse({ type: 'cli-response', ok: 'yes' }).ok).toBe(false)
    expect(parseCLIResponse({ type: 'cli-response', ok: false, error: 42 }).ok).toBe(false)
    expect(parseCLIResponse({ type: 'cli-response', ok: false, exitCode: '1' }).ok).toBe(false)
    expect(parseCLIResponse({ type: 'cli-response', ok: false, exitCode: 2.5 }).ok).toBe(false)
  })
})
