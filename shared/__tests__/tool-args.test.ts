import { describe, expect, test } from 'bun:test'
import { parseToolCall } from '../tool-args.js'
import { UNIVERSAL_TOOLS } from '../tool-definitions.js'

describe('parseToolCall', () => {
  test('accepts every tool defined in UNIVERSAL_TOOLS with valid arguments', () => {
    const validByTool: Record<string, Record<string, unknown>> = {
      reply: { chat_id: 'c1', text: 'hi', reply_to: 'm1', files: ['/tmp/a.txt'] },
      react: { chat_id: 'c1', message_id: 'm1', emoji: '👍' },
      edit_message: { chat_id: 'c1', message_id: 'm1', text: 'new' },
      delete_message: { chat_id: 'c1', message_id: 'm1' },
      download_attachment: { chat_id: 'c1', message_id: 'm1' },
      create_thread: { chat_id: 'c1', name: 't', message_id: 'm1', text: 'body', auto_archive_minutes: 60, files: ['/a'] },
      fetch_messages: { channel: 'c1', limit: 25 },
      spawn_session: { topic: 'work', chat_id: 'c1', message_id: 'm1', worktree: 'hydra', model: 'opus', phase_budget: '10m', read_thread: 30, fork_from: 'sage', read_only: true },
      list_sessions: { include_ended: true, ended_within_days: 7 },
      send_to_thread: { target: 'cedar', type: 'progress', text: 'ok', files: ['/a'], visibility: 'public', summary: 's', chat_id: 'slack:C1:1.0' },
      peek_session: { name: 'cedar', lines: 100 },
      kill_session: { session_id: 's1', thread_id: 't1', destroy: true },
      set_description: { session_id: 's1', description: 'desc' },
      handoff: { path: '/tmp/h.md' },
      ask_predecessor: { question: 'why?' },
      watch_pr: { pr_url: 'https://github.com/o/r/pull/1', chat_id: 'c1', notify_green: true },
      unwatch_pr: { pr_url: 'https://github.com/o/r/pull/1' },
      bind_conversation: { conversation: 'slack:C1:1.0', target: 'cedar', why: 'reason' },
      unbind_conversation: { conversation: 'slack:C1:1.0' },
      list_watches: { all: true },
      advance: { content: 'done', verdict: 'approve' },
      extend_phase: { reason: 'more time', minutes: 10 },
      report_usage: { rate_limits: [{ kind: 'five_hour', percent_used: 50 }] },
    }

    expect(Object.keys(validByTool).sort()).toEqual(UNIVERSAL_TOOLS.map(t => t.name).sort())

    for (const [name, args] of Object.entries(validByTool)) {
      expect(parseToolCall(name, { ...args, extraDropped: 'x' }), name).toEqual({
        ok: true,
        call: { name, args },
      } as any)
    }
  })

  test('every inputSchema.properties key in UNIVERSAL_TOOLS survives parseToolCall (cannot drift)', () => {
    const sampleFor = (prop: Record<string, unknown>): unknown => {
      if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0]
      const t = Array.isArray(prop.type) ? prop.type[0] : prop.type
      if (t === 'string') return 'val'
      if (t === 'number') return 1
      if (t === 'boolean') return true
      if (t === 'array') {
        const items = prop.items as Record<string, unknown> | undefined
        return items?.type === 'string' ? ['/tmp/a'] : [{ kind: 'five_hour', percent_used: 10 }]
      }
      return 'val'
    }

    for (const tool of UNIVERSAL_TOOLS) {
      const props = (tool.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}
      const args: Record<string, unknown> = {}
      for (const [k, schema] of Object.entries(props)) args[k] = sampleFor(schema)
      const parsed = parseToolCall(tool.name, args)
      expect(parsed.ok, `${tool.name} should parse all schema properties`).toBe(true)
      if (parsed.ok) {
        expect(Object.keys(parsed.call.args).sort(), `${tool.name} keys`).toEqual(Object.keys(props).sort())
      }
    }
  })

  test('treats null like undefined (omitted for optional args, required error for required args)', () => {
    expect(parseToolCall('spawn_session', { topic: 'work', worktree: null, model: null, read_only: null })).toEqual({
      ok: true,
      call: { name: 'spawn_session', args: { topic: 'work' } },
    })
    expect(parseToolCall('reply', { chat_id: 'c1', text: 'hi', reply_to: null, files: null })).toEqual({
      ok: true,
      call: { name: 'reply', args: { chat_id: 'c1', text: 'hi' } },
    })
    expect(parseToolCall('reply', { chat_id: null, text: 'hi' })).toEqual({
      ok: false,
      error: 'chat_id is required',
    })
    expect(parseToolCall('spawn_session', { topic: null })).toEqual({
      ok: false,
      error: 'topic is required',
    })
  })

  test('supports boolean|number read_thread on spawn_session and strips unknown keys', () => {
    expect(parseToolCall('spawn_session', { topic: 't', read_thread: true })).toEqual({
      ok: true,
      call: { name: 'spawn_session', args: { topic: 't', read_thread: true } },
    })
    expect(parseToolCall('spawn_session', { topic: 't', read_thread: 40 })).toEqual({
      ok: true,
      call: { name: 'spawn_session', args: { topic: 't', read_thread: 40 } },
    })
    expect(parseToolCall('spawn_session', { topic: 't', read_thread: '50' })).toEqual({
      ok: false,
      error: 'invalid argument "read_thread": expected boolean|number',
    })
    expect(parseToolCall('spawn_session', { topic: 't', read_thread: Number.NaN })).toEqual({
      ok: false,
      error: 'invalid argument "read_thread": expected boolean|number',
    })
  })

  test('rejects unknown tools, prototype keys, missing required args, and wrong types', () => {
    for (const bad of ['bogus', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(parseToolCall(bad, {})).toEqual({
        ok: false,
        unknownTool: true,
        error: `unknown tool: ${bad}`,
      })
    }

    expect(parseToolCall('reply', { text: 'hi' })).toEqual({ ok: false, error: 'chat_id is required' })
    expect(parseToolCall('react', { chat_id: 'c1', message_id: 'm1' })).toEqual({ ok: false, error: 'emoji is required' })
    expect(parseToolCall('download_attachment', { chat_id: 'c1' })).toEqual({ ok: false, error: 'message_id is required' })
    expect(parseToolCall('create_thread', { chat_id: 'c1' })).toEqual({ ok: false, error: 'name is required' })
    expect(parseToolCall('fetch_messages', {})).toEqual({ ok: false, error: 'channel is required' })
    expect(parseToolCall('spawn_session', {})).toEqual({ ok: false, error: 'topic is required' })
    expect(parseToolCall('unwatch_pr', {})).toEqual({ ok: false, error: 'pr_url is required' })

    expect(parseToolCall('reply', { chat_id: 'c1', files: 'not-array' })).toEqual({
      ok: false,
      error: 'invalid argument "files": expected string[]',
    })
    expect(parseToolCall('reply', { chat_id: 'c1', files: ['/a', 42] })).toEqual({
      ok: false,
      error: 'invalid argument "files": expected string[]',
    })
    expect(parseToolCall('create_thread', { chat_id: 'c1', name: 't', auto_archive_minutes: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: 'invalid argument "auto_archive_minutes": expected number',
    })
    expect(parseToolCall('peek_session', { name: 'cedar', lines: '50' })).toEqual({
      ok: false,
      error: 'invalid argument "lines": expected number',
    })
    expect(parseToolCall('kill_session', { session_id: 's1', destroy: 'true' })).toEqual({
      ok: false,
      error: 'invalid argument "destroy": expected boolean',
    })
  })
})
