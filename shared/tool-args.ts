// Typed MCP tool argument shapes and runtime parser for daemon tool dispatch.
// Pure Tier-0 module: types and runtime parsers only, no I/O.

import type { ToolName } from './tool-definitions.js'

// ---------------------------------------------------------------------------
// Per-tool argument types (one entry for every ToolName)
// Fields marked optional here where tool-definitions.ts lists them required
// mean the handler in app/bridge-dispatch.ts owns the domain refusal text.
// ---------------------------------------------------------------------------

export type ToolArgsMap = {
  reply: {
    chat_id: string
    text?: string
    reply_to?: string
    files?: string[]
  }
  react: {
    chat_id: string
    message_id: string
    emoji: string
  }
  edit_message: {
    chat_id?: string
    /** Validated by amendInConversation (owns Slack-timestamp error) or Discord path. */
    message_id?: unknown
    /** Expanded and deleted before parseToolCall; kept here to reject non-string link values. */
    link?: string
    text?: string
  }
  delete_message: {
    chat_id?: string
    /** Validated by amendInConversation (owns Slack-timestamp error) or Discord path. */
    message_id?: unknown
    /** Expanded and deleted before parseToolCall; kept here to reject non-string link values. */
    link?: string
  }
  download_attachment: {
    chat_id: string
    message_id: string
  }
  create_thread: {
    chat_id: string
    name: string
    message_id?: string
    text?: string
    auto_archive_minutes?: number
    files?: string[]
  }
  fetch_messages: {
    channel: string
    /** Validated by bridge-dispatch with its own bespoke message. */
    limit?: unknown
  }
  spawn_session: {
    topic: string
    chat_id?: string
    message_id?: string
    worktree?: string
    model?: string
    phase_budget?: string
    read_thread?: boolean | number
    fork_from?: string
    read_only?: boolean
  }
  list_sessions: {
    include_ended?: boolean
    /** Validated by endedWithinDays() with its own bespoke message. */
    ended_within_days?: unknown
  }
  send_to_thread: {
    target?: string
    type?: string
    text?: string
    files?: string[]
    visibility?: string
    summary?: string
    /** Passed by restricted callers (engines/bridge-tools.ts restrictedSend). */
    chat_id?: string
  }
  peek_session: {
    name?: string
    lines?: number
  }
  kill_session: {
    session_id?: string
    thread_id?: string
    destroy?: boolean
  }
  set_description: {
    session_id?: string
    description?: string
  }
  handoff: {
    path?: string
  }
  ask_predecessor: {
    question?: string
  }
  watch_pr: {
    pr_url?: string
    chat_id?: string
    notify_green?: boolean
  }
  unwatch_pr: {
    pr_url: string
  }
  bind_conversation: {
    conversation?: unknown
    target?: unknown
    why?: unknown
  }
  unbind_conversation: {
    conversation?: unknown
  }
  list_watches: {
    all?: boolean
  }
  advance: {
    content?: string
    verdict?: string
  }
  extend_phase: {
    reason?: string
    /** Coerced via Number(minutes) || 5 in bridge-dispatch. */
    minutes?: unknown
  }
  report_usage: {
    /** Observer payload: malformed entries are dropped by parseRateLimits, never rejected. */
    rate_limits?: unknown
  }
}

// Compile-time guard: ToolArgsMap keys must exactly match ToolName.
type _AssertExactToolNames = Exclude<ToolName, keyof ToolArgsMap> | Exclude<keyof ToolArgsMap, ToolName>
const _EXACT_TOOL_NAMES: _AssertExactToolNames extends never ? true : never = true
void _EXACT_TOOL_NAMES

export type ParsedToolCall = { [N in ToolName]: { name: N; args: ToolArgsMap[N] } }[ToolName]

// ---------------------------------------------------------------------------
// Compiler-enforced runtime specs (cannot drift from ToolArgsMap)
// ---------------------------------------------------------------------------

type ArgKind = 'string' | 'number' | 'boolean' | 'string[]' | 'boolean|number' | 'unknown'
type FieldRule = ArgKind | { readonly kind: ArgKind; readonly required: true }

type ArgKindFor<T> =
  [Exclude<T, undefined>] extends [string] ? 'string'
  : [Exclude<T, undefined>] extends [number] ? 'number'
  : [Exclude<T, undefined>] extends [boolean] ? 'boolean'
  : [Exclude<T, undefined>] extends [string[]] ? 'string[]'
  : [Exclude<T, undefined>] extends [boolean | number] ? 'boolean|number'
  : 'unknown'

type FieldRuleFor<T, K extends keyof T> =
  undefined extends T[K]
    ? ArgKindFor<T[K]>
    : { readonly kind: ArgKindFor<T[K]>; readonly required: true }

type ToolArgSpecs = {
  [N in ToolName]: { [K in keyof Required<ToolArgsMap[N]>]: FieldRuleFor<ToolArgsMap[N], K> }
}

const TOOL_ARG_SPECS: ToolArgSpecs = {
  reply: {
    chat_id: { kind: 'string', required: true },
    text: 'string',
    reply_to: 'string',
    files: 'string[]',
  },
  react: {
    chat_id: { kind: 'string', required: true },
    message_id: { kind: 'string', required: true },
    emoji: { kind: 'string', required: true },
  },
  edit_message: {
    chat_id: 'string',
    message_id: 'unknown',
    link: 'string',
    text: 'string',
  },
  delete_message: {
    chat_id: 'string',
    message_id: 'unknown',
    link: 'string',
  },
  download_attachment: {
    chat_id: { kind: 'string', required: true },
    message_id: { kind: 'string', required: true },
  },
  create_thread: {
    chat_id: { kind: 'string', required: true },
    name: { kind: 'string', required: true },
    message_id: 'string',
    text: 'string',
    auto_archive_minutes: 'number',
    files: 'string[]',
  },
  fetch_messages: {
    channel: { kind: 'string', required: true },
    limit: 'unknown',
  },
  spawn_session: {
    topic: { kind: 'string', required: true },
    chat_id: 'string',
    message_id: 'string',
    worktree: 'string',
    model: 'string',
    phase_budget: 'string',
    read_thread: 'boolean|number',
    fork_from: 'string',
    read_only: 'boolean',
  },
  list_sessions: {
    include_ended: 'boolean',
    ended_within_days: 'unknown',
  },
  send_to_thread: {
    target: 'string',
    type: 'string',
    text: 'string',
    files: 'string[]',
    visibility: 'string',
    summary: 'string',
    chat_id: 'string',
  },
  peek_session: {
    name: 'string',
    lines: 'number',
  },
  kill_session: {
    session_id: 'string',
    thread_id: 'string',
    destroy: 'boolean',
  },
  set_description: {
    session_id: 'string',
    description: 'string',
  },
  handoff: {
    path: 'string',
  },
  ask_predecessor: {
    question: 'string',
  },
  watch_pr: {
    pr_url: 'string',
    chat_id: 'string',
    notify_green: 'boolean',
  },
  unwatch_pr: {
    pr_url: { kind: 'string', required: true },
  },
  bind_conversation: {
    conversation: 'unknown',
    target: 'unknown',
    why: 'unknown',
  },
  unbind_conversation: {
    conversation: 'unknown',
  },
  list_watches: {
    all: 'boolean',
  },
  advance: {
    content: 'string',
    verdict: 'string',
  },
  extend_phase: {
    reason: 'string',
    minutes: 'unknown',
  },
  report_usage: {
    rate_limits: 'unknown',
  },
}

function matchesKind(val: unknown, kind: ArgKind): boolean {
  switch (kind) {
    case 'string':
      return typeof val === 'string'
    case 'number':
      return typeof val === 'number' && Number.isFinite(val)
    case 'boolean':
      return typeof val === 'boolean'
    case 'string[]':
      return Array.isArray(val) && val.every(item => typeof item === 'string')
    case 'boolean|number':
      return typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))
    case 'unknown':
      return true
  }
}

export type ParseToolCallResult =
  | { ok: true; call: ParsedToolCall }
  | { ok: false; error: string; unknownTool?: true }

/** Validate and narrow a tool invocation's name and argument record once at dispatch. */
export function parseToolCall(name: string, rawArgs: Record<string, unknown>): ParseToolCallResult {
  if (!Object.hasOwn(TOOL_ARG_SPECS, name)) {
    return { ok: false, unknownTool: true, error: `unknown tool: ${name}` }
  }
  const toolName = name as ToolName
  const spec = TOOL_ARG_SPECS[toolName] as Record<string, FieldRule>
  const out: Record<string, unknown> = {}

  for (const [key, rule] of Object.entries(spec)) {
    const kind = typeof rule === 'string' ? rule : rule.kind
    const required = typeof rule !== 'string' && rule.required
    const val = rawArgs[key]
    if (val === undefined || val === null) {
      if (required) return { ok: false, error: `${key} is required` }
      continue
    }
    if (!matchesKind(val, kind)) {
      return { ok: false, error: `invalid argument "${key}": expected ${kind}` }
    }
    out[key] = val
  }

  return { ok: true, call: { name: toolName, args: out } as ParsedToolCall }
}
