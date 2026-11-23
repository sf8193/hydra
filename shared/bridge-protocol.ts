// Shared wire protocol for the Unix domain socket between the daemon and its bridges
// (Claude bridge.ts, Codex/agy codex-mcp-server.ts, omp/hydra-bridge.ts, and CLI requests).
// Pure Tier-0 module: types and runtime parsers only, no I/O.

export type ConnectionRole = 'session' | 'control'

export type BridgeToolContent = {
  type: string
  text: string
}

export type BridgeToolDef = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type BridgeRegisterMessage = {
  type: 'register'
  sessionId: string
  sessionToken?: string
  claudeSessionId?: string
  pid?: number
  connectionRole?: ConnectionRole
  sessionType?: string
  restricted?: boolean
  writeConfined?: boolean
}

export type BridgeToolCallMessage = {
  type: 'tool_call'
  id: string
  name: string
  args: Record<string, unknown>
}

export type BridgeToolsRequestMessage = {
  type: 'tools_request'
  id: string
}

export type BridgeRequestToolsMessage = {
  type: 'request_tools'
}

export type BridgePermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type BridgePermissionResponseMessage = {
  type: 'permission_response'
  request_id: string
  behavior: string
}

/** Unvalidated CLI envelope forwarded intact to handleCLIRequest so it can emit structured cli-response errors. */
export type BridgeCliWireMessage = {
  type: 'cli'
} & Record<string, unknown>

export type BridgeToDaemonMessage =
  | BridgeRegisterMessage
  | BridgeToolCallMessage
  | BridgeToolsRequestMessage
  | BridgeRequestToolsMessage
  | BridgePermissionRequestMessage
  | BridgePermissionResponseMessage
  | BridgeCliWireMessage

export type DaemonRegisteredMessage = {
  type: 'registered'
  sessionId?: string
  tools?: BridgeToolDef[]
  platform?: string
  sessionMetadata?: Record<string, unknown>
}

export type DaemonToolResultMessage = {
  type: 'tool_result'
  id: string
  content: BridgeToolContent[]
  isError?: boolean
}

export type DaemonToolsResultMessage = {
  type: 'tools_result'
  id: string
  tools: BridgeToolDef[]
}

export type DaemonToolsUpdateMessage = {
  type: 'tools_update'
  tools: BridgeToolDef[]
}

export type DaemonNotificationMessage = {
  type: 'notification'
  content: string
  meta?: Record<string, string>
}

export type DaemonPermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export type DaemonPermissionResponseMessage = {
  type: 'permission_response'
  request_id: string
  behavior: 'allow' | 'deny'
}

export type DaemonToBridgeMessage =
  | DaemonRegisteredMessage
  | DaemonToolResultMessage
  | DaemonToolsResultMessage
  | DaemonToolsUpdateMessage
  | DaemonNotificationMessage
  | DaemonPermissionRequestMessage
  | DaemonPermissionResponseMessage

export type ParseResult<T> =
  | { ok: true; msg: T }
  | { ok: false; error: string; unknownType?: string; toolCallId?: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isToolContentArray(v: unknown): v is BridgeToolContent[] {
  return Array.isArray(v) && v.every(item => isRecord(item) && typeof item.type === 'string' && typeof item.text === 'string')
}

function isToolDefArray(v: unknown): v is BridgeToolDef[] {
  return Array.isArray(v) && v.every(item =>
    isRecord(item)
    && typeof item.name === 'string'
    && (item.description === undefined || typeof item.description === 'string')
    && (item.inputSchema === undefined || isRecord(item.inputSchema)),
  )
}

/** Validate and narrow an untrusted JSON object arriving on the daemon socket from a bridge or CLI client. */
export function parseBridgeToDaemonMessage(raw: unknown): ParseResult<BridgeToDaemonMessage> {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return { ok: false, error: 'message must be an object with a string type' }
  }
  switch (raw.type) {
    case 'register': {
      if (typeof raw.sessionId !== 'string') return { ok: false, error: 'register: sessionId must be a string' }
      return {
        ok: true,
        msg: {
          type: 'register',
          sessionId: raw.sessionId,
          ...(typeof raw.sessionToken === 'string' && raw.sessionToken ? { sessionToken: raw.sessionToken } : {}),
          ...(typeof raw.claudeSessionId === 'string' ? { claudeSessionId: raw.claudeSessionId } : {}),
          ...(typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}),
          ...(raw.connectionRole === 'control' || raw.connectionRole === 'session' ? { connectionRole: raw.connectionRole } : {}),
          ...(typeof raw.sessionType === 'string' ? { sessionType: raw.sessionType } : {}),
          ...(raw.restricted === true ? { restricted: true } : {}),
          ...(raw.writeConfined === true ? { writeConfined: true } : {}),
        },
      }
    }
    case 'tool_call': {
      if (typeof raw.id !== 'string') {
        return { ok: false, error: 'tool_call: id and name must be strings' }
      }
      if (typeof raw.name !== 'string') {
        return { ok: false, error: 'tool_call: id and name must be strings', toolCallId: raw.id }
      }
      if (raw.args !== undefined && !isRecord(raw.args)) {
        return { ok: false, error: 'tool_call: args must be an object', toolCallId: raw.id }
      }
      return { ok: true, msg: { type: 'tool_call', id: raw.id, name: raw.name, args: raw.args ?? {} } }
    }
    case 'tools_request': {
      if (typeof raw.id !== 'string') return { ok: false, error: 'tools_request: id must be a string' }
      return { ok: true, msg: { type: 'tools_request', id: raw.id } }
    }
    case 'request_tools':
      return { ok: true, msg: { type: 'request_tools' } }
    case 'permission_request': {
      if (typeof raw.request_id !== 'string' || typeof raw.tool_name !== 'string') {
        return { ok: false, error: 'permission_request: request_id and tool_name must be strings' }
      }
      return {
        ok: true,
        msg: {
          type: 'permission_request',
          request_id: raw.request_id,
          tool_name: raw.tool_name,
          description: typeof raw.description === 'string' ? raw.description : '',
          input_preview: typeof raw.input_preview === 'string' ? raw.input_preview : '',
        },
      }
    }
    case 'permission_response': {
      if (typeof raw.request_id !== 'string' || typeof raw.behavior !== 'string') {
        return { ok: false, error: 'permission_response: request_id and behavior must be strings' }
      }
      return { ok: true, msg: { type: 'permission_response', request_id: raw.request_id, behavior: raw.behavior } }
    }
    case 'cli': {
      // Forward raw CLI payload intact so handleCLIRequest returns structured cli-response errors
      // (including missing/non-object params, e.g. cli/helpers.ts health probe).
      return { ok: true, msg: raw as BridgeCliWireMessage }
    }
    default:
      return { ok: false, error: `unknown message type: ${raw.type}`, unknownType: raw.type }
  }
}

/** Validate and narrow a JSON object arriving at a bridge from the daemon socket. */
export function parseDaemonToBridgeMessage(raw: unknown): ParseResult<DaemonToBridgeMessage> {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return { ok: false, error: 'message must be an object with a string type' }
  }
  switch (raw.type) {
    case 'registered': {
      if (raw.sessionId !== undefined && typeof raw.sessionId !== 'string') {
        return { ok: false, error: 'registered: sessionId must be a string' }
      }
      if (raw.tools !== undefined && !isToolDefArray(raw.tools)) {
        return { ok: false, error: 'registered: tools must be an array of tool definitions' }
      }
      return {
        ok: true,
        msg: {
          type: 'registered',
          ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
          ...(raw.tools !== undefined ? { tools: raw.tools } : {}),
          ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
          ...(isRecord(raw.sessionMetadata) ? { sessionMetadata: raw.sessionMetadata } : {}),
        },
      }
    }
    case 'tool_result': {
      if (typeof raw.id !== 'string') return { ok: false, error: 'tool_result: id must be a string' }
      if (!isToolContentArray(raw.content)) {
        return { ok: false, error: 'tool_result: content must be an array of { type, text } blocks' }
      }
      return {
        ok: true,
        msg: { type: 'tool_result', id: raw.id, content: raw.content, ...(raw.isError === true ? { isError: true } : {}) },
      }
    }
    case 'tools_result': {
      if (typeof raw.id !== 'string' || !isToolDefArray(raw.tools)) {
        return { ok: false, error: 'tools_result: id and tools array required' }
      }
      return { ok: true, msg: { type: 'tools_result', id: raw.id, tools: raw.tools } }
    }
    case 'tools_update': {
      if (!isToolDefArray(raw.tools)) return { ok: false, error: 'tools_update: tools array required' }
      return { ok: true, msg: { type: 'tools_update', tools: raw.tools } }
    }
    case 'notification': {
      if (typeof raw.content !== 'string') return { ok: false, error: 'notification: content must be a string' }
      if (raw.meta !== undefined && !isRecord(raw.meta)) {
        return { ok: false, error: 'notification: meta must be an object' }
      }
      // Drop non-string meta fields rather than discarding the user's message.
      let meta: Record<string, string> | undefined
      if (raw.meta !== undefined) {
        meta = {}
        for (const [k, v] of Object.entries(raw.meta)) {
          if (typeof v === 'string') meta[k] = v
        }
      }
      return {
        ok: true,
        msg: {
          type: 'notification',
          content: raw.content,
          ...(meta !== undefined ? { meta } : {}),
        },
      }
    }
    case 'permission_request': {
      if (typeof raw.request_id !== 'string' || typeof raw.tool_name !== 'string') {
        return { ok: false, error: 'permission_request: request_id and tool_name must be strings' }
      }
      return {
        ok: true,
        msg: {
          type: 'permission_request',
          request_id: raw.request_id,
          tool_name: raw.tool_name,
          description: typeof raw.description === 'string' ? raw.description : '',
          input_preview: typeof raw.input_preview === 'string' ? raw.input_preview : '',
        },
      }
    }
    case 'permission_response': {
      if (typeof raw.request_id !== 'string' || (raw.behavior !== 'allow' && raw.behavior !== 'deny')) {
        return { ok: false, error: 'permission_response: request_id and allow|deny behavior required' }
      }
      return { ok: true, msg: { type: 'permission_response', request_id: raw.request_id, behavior: raw.behavior } }
    }
    default:
      return { ok: false, error: `unknown message type: ${raw.type}`, unknownType: raw.type }
  }
}
