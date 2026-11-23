import { describe, expect, test } from 'bun:test'
import { parseBridgeToDaemonMessage, parseDaemonToBridgeMessage } from '../bridge-protocol.js'

describe('parseBridgeToDaemonMessage', () => {
  test('parses valid bridge frames with exact field preservation and coercion rules', () => {
    const cases: Array<[string, unknown, unknown]> = [
      [
        'register with valid optional fields',
        {
          type: 'register', sessionId: 's1', sessionToken: 'tok-abc', claudeSessionId: 'c1', pid: 42,
          connectionRole: 'control', sessionType: 'thread_owner', restricted: true, writeConfined: true,
        },
        {
          ok: true,
          msg: {
            type: 'register', sessionId: 's1', sessionToken: 'tok-abc', claudeSessionId: 'c1', pid: 42,
            connectionRole: 'control', sessionType: 'thread_owner', restricted: true, writeConfined: true,
          },
        },
      ],
      [
        'register strips negative/fractional pid, empty/non-string sessionToken, invalid connectionRole, and non-boolean restriction flags',
        {
          type: 'register', sessionId: 's2', sessionToken: '', pid: -1, connectionRole: 'admin',
          restricted: 'true', writeConfined: 1,
        },
        { ok: true, msg: { type: 'register', sessionId: 's2' } },
      ],
      [
        'register strips non-integer pid and non-string sessionToken',
        { type: 'register', sessionId: 's3', sessionToken: 123, pid: 1.5, restricted: false, writeConfined: false },
        { ok: true, msg: { type: 'register', sessionId: 's3' } },
      ],
      [
        'tool_call defaults omitted args to {}',
        { type: 'tool_call', id: '1', name: 'list_sessions' },
        { ok: true, msg: { type: 'tool_call', id: '1', name: 'list_sessions', args: {} } },
      ],
      [
        'tool_call preserves object args',
        { type: 'tool_call', id: '2', name: 'reply', args: { text: 'hi' } },
        { ok: true, msg: { type: 'tool_call', id: '2', name: 'reply', args: { text: 'hi' } } },
      ],
      [
        'tools_request',
        { type: 'tools_request', id: 'tr-1' },
        { ok: true, msg: { type: 'tools_request', id: 'tr-1' } },
      ],
      [
        'request_tools',
        { type: 'request_tools' },
        { ok: true, msg: { type: 'request_tools' } },
      ],
      [
        'permission_request defaults omitted description and input_preview to empty strings',
        { type: 'permission_request', request_id: 'r1', tool_name: 'Bash' },
        { ok: true, msg: { type: 'permission_request', request_id: 'r1', tool_name: 'Bash', description: '', input_preview: '' } },
      ],
      [
        'permission_response',
        { type: 'permission_response', request_id: 'r1', behavior: 'allow' },
        { ok: true, msg: { type: 'permission_response', request_id: 'r1', behavior: 'allow' } },
      ],
      [
        'cli health probe without params forwarded intact',
        { type: 'cli', command: 'health', id: 'probe' },
        { ok: true, msg: { type: 'cli', command: 'health', id: 'probe' } },
      ],
      [
        'cli command with params forwarded intact',
        { type: 'cli', command: 'list', id: 'c1', params: { all: true } },
        { ok: true, msg: { type: 'cli', command: 'list', id: 'c1', params: { all: true } } },
      ],
    ]

    for (const [label, input, expected] of cases) {
      expect(parseBridgeToDaemonMessage(input), label).toEqual(expected as any)
    }
  })

  test('rejects invalid bridge frames and attaches toolCallId for replyable malformed tool_call', () => {
    expect(parseBridgeToDaemonMessage(null).ok).toBe(false)
    expect(parseBridgeToDaemonMessage([]).ok).toBe(false)
    expect(parseBridgeToDaemonMessage({ type: 'register' }).ok).toBe(false)
    expect(parseBridgeToDaemonMessage({ type: 'tools_request' }).ok).toBe(false)
    expect(parseBridgeToDaemonMessage({ type: 'permission_request', request_id: 'r1' }).ok).toBe(false)
    expect(parseBridgeToDaemonMessage({ type: 'permission_response', request_id: 'r1' }).ok).toBe(false)

    // tool_call missing id cannot be replied to
    const missingId = parseBridgeToDaemonMessage({ type: 'tool_call', name: 'reply' })
    expect(missingId).toEqual({ ok: false, error: 'tool_call: id and name must be strings' })

    // tool_call with string id but invalid name or non-object args carries toolCallId so daemon replies
    expect(parseBridgeToDaemonMessage({ type: 'tool_call', id: 'c1' })).toEqual({
      ok: false, error: 'tool_call: id and name must be strings', toolCallId: 'c1',
    })
    expect(parseBridgeToDaemonMessage({ type: 'tool_call', id: 'c2', name: 'reply', args: null })).toEqual({
      ok: false, error: 'tool_call: args must be an object', toolCallId: 'c2',
    })
    expect(parseBridgeToDaemonMessage({ type: 'tool_call', id: 'c3', name: 'reply', args: ['a'] })).toEqual({
      ok: false, error: 'tool_call: args must be an object', toolCallId: 'c3',
    })
    expect(parseBridgeToDaemonMessage({ type: 'tool_call', id: 'c4', name: 'reply', args: 'bad' })).toEqual({
      ok: false, error: 'tool_call: args must be an object', toolCallId: 'c4',
    })

    const unknown = parseBridgeToDaemonMessage({ type: 'bogus' })
    expect(unknown).toEqual({ ok: false, error: 'unknown message type: bogus', unknownType: 'bogus' })
  })
})

describe('parseDaemonToBridgeMessage', () => {
  test('parses valid daemon frames with exact output shapes', () => {
    const cases: Array<[string, unknown, unknown]> = [
      [
        'registered full',
        {
          type: 'registered', sessionId: 's1', platform: 'discord',
          tools: [{ name: 'reply', description: 'd', inputSchema: { type: 'object' } }],
          sessionMetadata: { role: 'worker' },
        },
        {
          ok: true,
          msg: {
            type: 'registered', sessionId: 's1', platform: 'discord',
            tools: [{ name: 'reply', description: 'd', inputSchema: { type: 'object' } }],
            sessionMetadata: { role: 'worker' },
          },
        },
      ],
      [
        'registered minimal (no sessionId, tool with name only)',
        { type: 'registered', tools: [{ name: 'A' }] },
        { ok: true, msg: { type: 'registered', tools: [{ name: 'A' }] } },
      ],
      [
        'tool_result with isError',
        { type: 'tool_result', id: 'c1', content: [{ type: 'text', text: 'ok' }], isError: true },
        { ok: true, msg: { type: 'tool_result', id: 'c1', content: [{ type: 'text', text: 'ok' }], isError: true } },
      ],
      [
        'tools_result',
        { type: 'tools_result', id: 'tr-1', tools: [{ name: 'reply', description: 'd', inputSchema: {} }] },
        { ok: true, msg: { type: 'tools_result', id: 'tr-1', tools: [{ name: 'reply', description: 'd', inputSchema: {} }] } },
      ],
      [
        'tools_update',
        { type: 'tools_update', tools: [{ name: 'reply' }] },
        { ok: true, msg: { type: 'tools_update', tools: [{ name: 'reply' }] } },
      ],
      [
        'notification with meta',
        { type: 'notification', content: 'hi', meta: { chat_id: 't1' } },
        { ok: true, msg: { type: 'notification', content: 'hi', meta: { chat_id: 't1' } } },
      ],
      [
        'notification without meta',
        { type: 'notification', content: 'hi' },
        { ok: true, msg: { type: 'notification', content: 'hi' } },
      ],
      [
        'permission_request defaults description and input_preview',
        { type: 'permission_request', request_id: 'r1', tool_name: 'Bash' },
        { ok: true, msg: { type: 'permission_request', request_id: 'r1', tool_name: 'Bash', description: '', input_preview: '' } },
      ],
      [
        'permission_response allow',
        { type: 'permission_response', request_id: 'r1', behavior: 'allow' },
        { ok: true, msg: { type: 'permission_response', request_id: 'r1', behavior: 'allow' } },
      ],
    ]

    for (const [label, input, expected] of cases) {
      expect(parseDaemonToBridgeMessage(input), label).toEqual(expected as any)
    }
  })

  test('rejects malformed daemon frames instead of silently coercing them', () => {
    expect(parseDaemonToBridgeMessage('nope').ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'registered', sessionId: 42 }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'registered', tools: 'not-array' }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'registered', tools: [{ name: 'A', description: 123 }] }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'registered', tools: [{ name: 'A', inputSchema: [] }] }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'tool_result' }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'tool_result', id: 'c1', content: 'not-array' }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'tool_result', id: 'c1', content: [{ type: 'text' }] }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'tools_result', id: 't1', tools: 'bad' }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'tools_update', tools: 'not-array' }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'notification', content: 123 }).ok).toBe(false)
    // Non-string meta entries are dropped so a bad field never discards the user's notification
    expect(parseDaemonToBridgeMessage({ type: 'notification', content: 'hi', meta: { chat_id: '1', bad: 42 } })).toEqual({
      ok: true,
      msg: { type: 'notification', content: 'hi', meta: { chat_id: '1' } },
    })
    expect(parseDaemonToBridgeMessage({ type: 'notification', content: 'hi', meta: ['bad'] }).ok).toBe(false)
    expect(parseDaemonToBridgeMessage({ type: 'permission_response', request_id: 'r1', behavior: 'maybe' }).ok).toBe(false)

    const unknown = parseDaemonToBridgeMessage({ type: 'future_msg' })
    expect(unknown).toEqual({ ok: false, error: 'unknown message type: future_msg', unknownType: 'future_msg' })
  })
})
