// Shared wire protocol for CLI ↔ daemon requests over the Unix domain socket.
// Pure Tier-0 module: types and runtime parsers only, no I/O.

import { DELIVER_WORD, type DeliverWord } from './exit-codes.js'

// ---------------------------------------------------------------------------
// Per-command parameter types
// ---------------------------------------------------------------------------

export type CLISpawnParams = {
  specialist?: string
  prompt?: string
  initiator?: string
  idempotencyKey?: string
  channel?: string
  message?: string
  ephemeral?: boolean
  idleTtl?: string
  forceWorktreeCleanup?: boolean
  quiet?: boolean
  model?: string
  /** Legacy self-reported caller id from older CLIs; preserved so cliCaller fails closed as unverified. */
  callerSessionId?: unknown
}

export type CLIListParams = {
  ended?: boolean
  /** Validated by endedWithinDays() in the daemon to preserve exact range/format error messages. */
  withinDays?: unknown
}

export type CLIStatusParams = {
  name?: string
  attach?: boolean
}

export type CLIKillParams = {
  name?: string
  destroy?: boolean
  /** Legacy self-reported caller id from older CLIs; preserved so cliCaller fails closed as unverified. */
  callerSessionId?: unknown
}

export type CLIHealthParams = Record<string, never>

export type CLIClearKeyParams = {
  key?: string
}

export type CLICheckKeyParams = {
  key?: string
}

export type CLIDeliverParams = {
  to?: string
  conversation?: string
  thread?: string
  session?: string
  specialist?: string
  message?: string
  initiator?: string
  idempotencyKey?: string
  idempotencyTtl?: string
  queue?: boolean
  revive?: boolean
}

export type CLISpecialistParams = {
  action?: string
  name?: string
  thread?: string
  channel?: string
  kickoff?: string
  kickoffFile?: string
  model?: string
  idle?: string
}

export type CLIConversationsParams = {
  action?: string
  conversation?: string
  to?: string
  why?: string
}

/** What `hydra route` asks. The app lists are comma-separated apps, each `app:<id>`. */
export type CLIRouteParams = {
  person?: string
  place?: string
  bound?: string
  app?: string
  heardBy?: string
  mentioned?: string
  boundApp?: string
}

export type CLIJobsRunParams = {
  name?: string
}

export type CLIJobsMarkDoneParams = {
  name?: string
}

export type CLIJobsSyncParams = Record<string, never>

export type CLICommandMap = {
  spawn: CLISpawnParams
  list: CLIListParams
  status: CLIStatusParams
  kill: CLIKillParams
  health: CLIHealthParams
  'clear-key': CLIClearKeyParams
  'check-key': CLICheckKeyParams
  deliver: CLIDeliverParams
  specialist: CLISpecialistParams
  conversations: CLIConversationsParams
  route: CLIRouteParams
  'jobs-run': CLIJobsRunParams
  'jobs-mark-done': CLIJobsMarkDoneParams
  'jobs-sync': CLIJobsSyncParams
}

export type CLICommand = keyof CLICommandMap

export type CLIRequestFor<C extends CLICommand> = {
  type: 'cli'
  command: C
  id: string
  params: CLICommandMap[C]
  /** Who is calling, as the CLI says (shared/caller.ts); read by cliCaller, never believed as given. */
  caller?: unknown
}

export type CLIRequest = { [C in CLICommand]: CLIRequestFor<C> }[CLICommand]

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type CLIResponse<T = unknown> = {
  type: 'cli-response'
  command: string
  id: string
  ok: boolean
  data?: T
  error?: string
  exitCode?: number
  /** deliver only: the one word the outcome means (shared/exit-codes.ts). */
  result?: DeliverWord
}

/** Minimal response shape accepted by output formatters and CLI test doubles. */
export type CLIResponseView = Pick<CLIResponse, 'ok' | 'data' | 'error' | 'exitCode' | 'result'> & {
  type?: 'cli-response'
  command?: string
  id?: string
}

// ---------------------------------------------------------------------------
// Runtime validation helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type FieldKind = 'string' | 'boolean' | 'unknown'
type FieldSpec = Record<string, FieldKind>

type FieldKindFor<T> =
  [Exclude<T, undefined>] extends [string] ? 'string'
  : [Exclude<T, undefined>] extends [boolean] ? 'boolean'
  : 'unknown'

type CommandSpecs = {
  [C in CLICommand]: { [K in keyof Required<CLICommandMap[C]>]: FieldKindFor<CLICommandMap[C][K]> }
}

function parseParams(raw: Record<string, unknown>, spec: FieldSpec): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, kind] of Object.entries(spec)) {
    const val = raw[key]
    if (val === undefined) continue
    if (kind === 'string') {
      if (typeof val !== 'string') return { ok: false, error: `invalid param "${key}": expected string` }
      out[key] = val
    } else if (kind === 'boolean') {
      if (typeof val !== 'boolean') return { ok: false, error: `invalid param "${key}": expected boolean` }
      out[key] = val
    } else {
      out[key] = val
    }
  }
  return { ok: true, params: out }
}

const COMMAND_SPECS: CommandSpecs = {
  spawn: {
    specialist: 'string',
    prompt: 'string',
    initiator: 'string',
    idempotencyKey: 'string',
    channel: 'string',
    message: 'string',
    ephemeral: 'boolean',
    idleTtl: 'string',
    forceWorktreeCleanup: 'boolean',
    quiet: 'boolean',
    model: 'string',
    callerSessionId: 'unknown',
  },
  list: {
    ended: 'boolean',
    withinDays: 'unknown',
  },
  status: {
    name: 'string',
    attach: 'boolean',
  },
  kill: {
    name: 'string',
    destroy: 'boolean',
    callerSessionId: 'unknown',
  },
  health: {},
  'clear-key': { key: 'string' },
  'check-key': { key: 'string' },
  deliver: {
    to: 'string',
    conversation: 'string',
    thread: 'string',
    session: 'string',
    specialist: 'string',
    message: 'string',
    initiator: 'string',
    idempotencyKey: 'string',
    idempotencyTtl: 'string',
    queue: 'boolean',
    revive: 'boolean',
  },
  specialist: {
    action: 'string',
    name: 'string',
    thread: 'string',
    channel: 'string',
    kickoff: 'string',
    kickoffFile: 'string',
    model: 'string',
    idle: 'string',
  },
  conversations: {
    action: 'string',
    conversation: 'string',
    to: 'string',
    why: 'string',
  },
  route: {
    person: 'string',
    place: 'string',
    bound: 'string',
    app: 'string',
    heardBy: 'string',
    mentioned: 'string',
    boundApp: 'string',
  },
  'jobs-run': { name: 'string' },
  'jobs-mark-done': { name: 'string' },
  'jobs-sync': {},
}

export type ParseCLIRequestResult =
  | { ok: true; request: CLIRequest }
  | { ok: false; command: string; id: string; error: string }

/**
 * Validate and narrow an untrusted CLI wire message into a discriminated CLIRequest.
 * Preserves exact existing error messages for missing/invalid params and unknown commands.
 */
export function parseCLIRequest(raw: unknown): ParseCLIRequestResult {
  if (!isRecord(raw)) {
    return { ok: false, command: '', id: '', error: 'request must be an object' }
  }
  const command = typeof raw.command === 'string' ? raw.command : ''
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (raw.type !== 'cli') {
    return { ok: false, command, id, error: 'request type must be "cli"' }
  }
  if (!isRecord(raw.params)) {
    return { ok: false, command, id, error: 'params must be an object' }
  }
  if (!Object.hasOwn(COMMAND_SPECS, command)) {
    return { ok: false, command, id, error: `unknown command: ${command}` }
  }
  const cmd = command as CLICommand
  const parsed = parseParams(raw.params, COMMAND_SPECS[cmd])
  if (!parsed.ok) {
    return { ok: false, command: cmd, id, error: parsed.error }
  }
  const request = {
    type: 'cli',
    command: cmd,
    id,
    params: parsed.params,
    ...(raw.caller !== undefined ? { caller: raw.caller } : {}),
  } as CLIRequest
  return { ok: true, request }
}

export type ParseCLIResponseResult =
  | { ok: true; response: CLIResponse }
  | { ok: false; error: string }

const DELIVER_WORDS: ReadonlySet<string> = new Set<string>(Object.values(DELIVER_WORD))

/** Validate an untrusted JSON object arriving at the CLI from the daemon socket. */
export function parseCLIResponse(raw: unknown): ParseCLIResponseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: 'response must be an object' }
  }
  if (raw.type !== undefined && raw.type !== 'cli-response') {
    return { ok: false, error: 'response type must be "cli-response"' }
  }
  if (typeof raw.ok !== 'boolean') {
    return { ok: false, error: 'response ok must be a boolean' }
  }
  if (raw.command !== undefined && typeof raw.command !== 'string') {
    return { ok: false, error: 'response command must be a string' }
  }
  if (raw.id !== undefined && typeof raw.id !== 'string') {
    return { ok: false, error: 'response id must be a string' }
  }
  if (raw.error !== undefined && typeof raw.error !== 'string') {
    return { ok: false, error: 'response error must be a string' }
  }
  if (raw.exitCode !== undefined && (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode))) {
    return { ok: false, error: 'response exitCode must be an integer' }
  }
  const result = typeof raw.result === 'string' && DELIVER_WORDS.has(raw.result)
    ? (raw.result as DeliverWord)
    : undefined
  return {
    ok: true,
    response: {
      type: 'cli-response',
      command: raw.command ?? '',
      id: raw.id ?? '',
      ok: raw.ok,
      ...(raw.data !== undefined ? { data: raw.data } : {}),
      ...(raw.error !== undefined ? { error: raw.error } : {}),
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      ...(result !== undefined ? { result } : {}),
    },
  }
}
