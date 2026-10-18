#!/usr/bin/env bun
/**
 * Hydra channel bridge for Claude Code.
 *
 * Thin MCP server that relays tool calls and notifications between a Claude
 * session and a standalone daemon over a unix socket. Each Claude session
 * (including the main "byte" session) spawns its own bridge instance.
 *
 * Protocol: newline-delimited JSON over unix socket (path via DAEMON_SOCK env)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'net'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

import { ToolsWaiterSet, type ToolsWaiter } from './shared/tools-waiters.js'
import { appendBridgeLife, bridgeLifePath, type BridgeLifeEvent } from './shared/bridge-life.js'
import { BRIDGE_SHUTDOWN_GRACE_MS, LONG_TOOL_TIMEOUTS_MS, SESSION_INSTRUCTIONS } from './shared/constants.js'

// Resolve daemon socket path. Priority:
// 1. DAEMON_SOCK env var (explicit override — needed when multiple daemons share a plugin cache)
// 2. daemon-{platform}.json next to this bridge (platform-keyed — no race when two daemons share a plugin cache)
// 3. HYDRA_STATE_DIR / CHAT_PLATFORM env var fallback
function resolveSocketPath(): string {
  if (process.env.DAEMON_SOCK) {
    process.stderr.write(`bridge: socket path from DAEMON_SOCK env: ${process.env.DAEMON_SOCK}\n`)
    return process.env.DAEMON_SOCK
  }

  const platform = process.env.CHAT_PLATFORM ?? 'discord'
  const platformExplicit = !!process.env.CHAT_PLATFORM

  const bridgeDir = dirname(fileURLToPath(import.meta.url))

  try {
    const platformPath = join(bridgeDir, `daemon-${platform}.json`)
    if (existsSync(platformPath)) {
      const config = JSON.parse(readFileSync(platformPath, 'utf-8'))
      if (config.platform && config.platform !== platform) {
        process.stderr.write(`bridge: WARNING: daemon-${platform}.json contains platform=${config.platform} (expected ${platform})\n`)
      }
      if (config.socket) {
        if (!platformExplicit) {
          const otherPlatform = platform === 'discord' ? 'slack' : 'discord'
          if (existsSync(join(bridgeDir, `daemon-${otherPlatform}.json`))) {
            process.stderr.write(`bridge: WARNING: CHAT_PLATFORM not set, defaulting to '${platform}' — set CHAT_PLATFORM to route to the correct daemon\n`)
          }
        }
        process.stderr.write(`bridge: socket path from daemon-${platform}.json: ${config.socket}\n`)
        return config.socket
      }
    }
  } catch (err) {
    process.stderr.write(`bridge: failed to read daemon-${platform}.json, trying legacy fallback: ${err}\n`)
  }

  const stateDir = process.env.HYDRA_STATE_DIR
    ?? process.env.DISCORD_STATE_DIR
    ?? join(homedir(), '.claude', 'channels', process.env.CHAT_PLATFORM ?? 'discord')
  return join(stateDir, 'daemon.sock')
}

const SOCKET_PATH = resolveSocketPath()

// Who is this bridge? The most consequential decision in the file — determines
// whether the session gets control-plane tools or is inert.
function resolveSessionIdentity(): { sessionId: string; isMain: boolean } {
  const explicit = process.env.HYDRA_SESSION_ID
  const role = process.env.HYDRA_ROLE
  if (explicit) {
    if (role === 'main') {
      process.stderr.write(`bridge: identity: spawned session ${explicit} (HYDRA_ROLE=main ignored — HYDRA_SESSION_ID takes priority)\n`)
    } else {
      process.stderr.write(`bridge: identity: spawned session ${explicit}\n`)
    }
    return { sessionId: explicit, isMain: false }
  }
  if (role === 'main') {
    process.stderr.write(`bridge: identity: main (HYDRA_ROLE=main)\n`)
    return { sessionId: 'main', isMain: true }
  }
  const id = `stray-${randomUUID().slice(0, 8)}`
  process.stderr.write(`bridge: identity: unconfigured bridge, assigned ${id}\n`)
  return { sessionId: id, isMain: false }
}

const { sessionId: SESSION_ID, isMain: IS_MAIN } = resolveSessionIdentity()
const IS_STRAY = SESSION_ID.startsWith('stray-')
const RECONNECT_INTERVAL = 5000

const LIFE_PATH = bridgeLifePath(dirname(SOCKET_PATH), SESSION_ID, process.pid)
const WAKE_TICK_MS = 10_000
const WAKE_GAP_MS = 60_000
const MAX_ERROR_RECORDS = 20
let errorRecords = 0

function recordLife(event: BridgeLifeEvent): void {
  if (IS_STRAY) return
  appendBridgeLife(LIFE_PATH, event)
}

function recordError(kind: string, err: unknown): void {
  if (errorRecords >= MAX_ERROR_RECORDS) return
  errorRecords++
  recordLife({ ev: 'error', ts: Date.now(), detail: `${kind}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` })
}

const CLAUDE_SESSION_ID_ENV_NAMES = ['CLAUDE_CODE_SESSION_ID', 'SESSION_ID']

function resolveClaudeSessionId(): string | undefined {
  for (const name of CLAUDE_SESSION_ID_ENV_NAMES) {
    const val = process.env[name]
    if (val && val !== SESSION_ID) return val
  }
  return undefined
}

// ── Pending tool call tracker ──────────────────────────────────────────

type PendingCall = {
  resolve: (value: { content: Array<{ type: string; text: string }>; isError?: boolean }) => void
  reject: (reason: Error) => void
}

const pendingCalls = new Map<string, PendingCall>()

// ── Notification queue (buffered while disconnected) ───────────────────

const notificationQueue: Array<{ content: string; meta: Record<string, string> }> = []
let socketReady = false

// ── Dynamic tool list (updated on daemon registration) ────────────────

let dynamicTools: Array<Record<string, unknown>> | null = null
let sessionMetadata: Record<string, unknown> | null = null

// Every in-flight tools/list waits here. See ToolsWaiterSet for why this cannot
// be a single slot.
const pendingToolsWaiters = new ToolsWaiterSet<Array<Record<string, unknown>>>()

// ── Tool refresh fallback ────────────────────────────────────────────
// Notifications from the daemon often coincide with phase transitions that
// change the tool surface. If a tools_update was lost in transit, the bridge
// requests a fresh tool list after receiving a notification. Debounced so
// rapid-fire notifications don't flood the daemon.
let lastToolRefreshRequestAt = 0
const TOOL_REFRESH_DEBOUNCE_MS = 2_000

// ── Socket connection ──────────────────────────────────────────────────

let sock: Socket | null = null
let lineBuf = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function sendToSocket(obj: Record<string, unknown>): void {
  if (!sock || sock.destroyed) {
    process.stderr.write('bridge: socket not connected, dropping message\n')
    return
  }
  sock.write(JSON.stringify(obj) + '\n')
}

function handleDaemonMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string
  const size = typeof msg.content === 'string' ? msg.content.length : undefined
  process.stderr.write(`bridge: ← daemon msg type=${type}${size !== undefined ? ` size=${size}b` : ''} ts=${new Date().toISOString()}\n`)

  switch (type) {
    case 'registered': {
      process.stderr.write(`bridge: registered as session ${msg.sessionId}\n`)
      socketReady = true

      const meta = msg.sessionMetadata as Record<string, unknown> | undefined
      if (meta) {
        sessionMetadata = meta
        process.stderr.write(`bridge: session metadata received: role=${meta.role}\n`)
      }

      // Update tool list if daemon sent one (dynamic tool refresh)
      const tools = msg.tools as Array<Record<string, unknown>> | undefined
      if (tools && tools.length > 0) {
        dynamicTools = tools
        process.stderr.write(`bridge: received ${tools.length} tool definitions from daemon\n`)
        mcp.notification({ method: 'notifications/tools/list_changed' }).catch(err => {
          process.stderr.write(`bridge: failed to send tools/list_changed: ${err}\n`)
        })
      }

      // Flush queued notifications
      while (notificationQueue.length > 0) {
        const queued = notificationQueue.shift()!
        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: queued.content, meta: queued.meta },
        }).catch(err => {
          process.stderr.write(`bridge: failed to deliver queued notification: ${err}\n`)
        })
      }
      break
    }

    case 'tool_result': {
      const id = msg.id as string
      const pending = pendingCalls.get(id)
      if (!pending) {
        process.stderr.write(`bridge: received tool_result for unknown id ${id}\n`)
        return
      }
      pendingCalls.delete(id)
      pending.resolve({
        content: msg.content as Array<{ type: string; text: string }>,
        ...(msg.isError ? { isError: true } : {}),
      })
      break
    }

    case 'notification': {
      const content = msg.content as string
      const meta = msg.meta as Record<string, string>
      mcp.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      }).then(() => {
        process.stderr.write(`bridge: → CC notifications/claude/channel delivered ts=${new Date().toISOString()} size=${content.length}b\n`)
      }).catch(err => {
        process.stderr.write(`bridge: → CC notifications/claude/channel FAILED: ${err} ts=${new Date().toISOString()}\n`)
      })

      // Pull-based tool refresh fallback: notifications from the daemon often
      // coincide with protocol phase transitions that change the tool surface.
      // If the push-path tools_update was lost (socket race, backpressure, etc.),
      // requesting a refresh here provides a second chance at delivery.
      const now = Date.now()
      if (socketReady && now - lastToolRefreshRequestAt > TOOL_REFRESH_DEBOUNCE_MS) {
        lastToolRefreshRequestAt = now
        sendToSocket({ type: 'request_tools' })
      }
      break
    }

    case 'permission_request': {
      mcp.notification({
        method: 'notifications/claude/channel/permission_request',
        params: {
          request_id: msg.request_id as string,
          tool_name: msg.tool_name as string,
          description: msg.description as string,
          input_preview: msg.input_preview as string,
        },
      }).catch(err => {
        process.stderr.write(`bridge: failed to deliver permission_request: ${err}\n`)
      })
      break
    }

    case 'tools_update': {
      const tools = msg.tools as Array<Record<string, unknown>> | undefined
      const prevCount = dynamicTools?.length ?? 0
      process.stderr.write(`bridge: ← daemon tools_update received: ${tools?.length ?? 0} tools (was ${prevCount}) ts=${new Date().toISOString()}\n`)
      if (tools) {
        dynamicTools = tools
        // This update answers a `request_tools` we sent — almost always on behalf
        // of a `tools/list` the client just made. Settling the waiters IS the
        // delivery; announcing `list_changed` on top of it tells the client its
        // own answer is news, and it asks again. That is a closed cycle with
        // nothing to damp it. Only an unsolicited push below is news.
        //
        // Asked before settling, because settleAll empties the set — afterwards
        // there is no way to tell a pull answer from an unsolicited push.
        const answeredPull = pendingToolsWaiters.size > 0
        pendingToolsWaiters.settleAll(tools)
        if (answeredPull) break
        mcp.notification({ method: 'notifications/tools/list_changed' }).then(() => {
          process.stderr.write(`bridge: → CC notifications/tools/list_changed delivered ts=${new Date().toISOString()} tools=${tools.length}\n`)
        }).catch(err => {
          process.stderr.write(`bridge: → CC notifications/tools/list_changed FAILED: ${err} ts=${new Date().toISOString()}\n`)
        })
      }
      break
    }

    default:
      process.stderr.write(`bridge: unknown daemon message type: ${type}\n`)
  }
}

function connectSocket(): void {
  if (sock && !sock.destroyed) return

  sock = connect(SOCKET_PATH)

  sock.on('connect', () => {
    process.stderr.write(`bridge: connected to daemon\n`)
    lineBuf = ''
    const claudeId = resolveClaudeSessionId()
    sendToSocket({ type: 'register', sessionId: SESSION_ID, claudeSessionId: claudeId, pid: IS_STRAY ? undefined : process.pid })
  })

  sock.on('data', (data: Buffer) => {
    lineBuf += data.toString()
    let newlineIdx: number
    while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, newlineIdx)
      lineBuf = lineBuf.slice(newlineIdx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        handleDaemonMessage(msg)
      } catch (err) {
        process.stderr.write(`bridge: failed to parse daemon message: ${err}\n`)
      }
    }
  })

  sock.on('error', (err: Error) => {
    process.stderr.write(`bridge: socket error: ${err.message} ts=${new Date().toISOString()} pendingCalls=${pendingCalls.size}\n`)
  })

  sock.on('end', () => {
    process.stderr.write(`bridge: socket end (daemon closed its side) ts=${new Date().toISOString()} pendingCalls=${pendingCalls.size}\n`)
  })

  sock.on('close', () => {
    process.stderr.write(`bridge: socket closed ts=${new Date().toISOString()} pendingCalls=${pendingCalls.size}\n`)
    socketReady = false
    sock = null

    // Reject all pending tool calls
    for (const [id, pending] of pendingCalls) {
      pending.reject(new Error('daemon connection lost'))
      pendingCalls.delete(id)
    }

    if (!IS_STRAY) {
      scheduleReconnect()
    } else {
      process.stderr.write('bridge: stray bridge — not reconnecting\n')
    }
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectSocket()
  }, RECONNECT_INTERVAL)
}

// ── MCP server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'hydra-bridge', version: '1.0.0' },
  {
    capabilities: {
      tools: { listChanged: true },
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: SESSION_INSTRUCTIONS,
  },
)

// ── Permission response handler (Claude → daemon) ─────────────────────

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission'),
    params: z.object({
      request_id: z.string(),
      behavior: z.string(),
    }),
  }),
  async ({ params }) => {
    sendToSocket({
      type: 'permission_response',
      request_id: params.request_id,
      behavior: params.behavior,
    })
  },
)

// ── Tool definitions ───────────────────────────────────────────────────

const SESSION_INFO_TOOL = {
  name: 'get_session_info',
  description: 'Get session metadata: role, available tools, model, working directory, platform.',
  inputSchema: { type: 'object' as const, properties: {} },
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  // Pull-authoritative: always query the daemon for the current tool list.
  // This ensures tools/list never returns stale data — the daemon computes
  // tools from live session state (type + capabilities) on every call.
  // Falls back to cached dynamicTools if the daemon is unreachable.
  if (socketReady) {
    try {
      const fresh = await new Promise<Array<Record<string, unknown>> | null>(resolve => {
        const waiter: ToolsWaiter<Array<Record<string, unknown>>> = tools => resolve(tools)
        pendingToolsWaiters.add(waiter)
        sendToSocket({ type: 'request_tools' })
        setTimeout(() => pendingToolsWaiters.timeout(waiter), 2_000)
      })
      if (fresh) {
        dynamicTools = fresh
        return { tools: [SESSION_INFO_TOOL, ...dynamicTools] }
      }
    } catch {
      process.stderr.write(`bridge: request_tools failed, using cache ts=${new Date().toISOString()}\n`)
    }
  }
  // Fallback: wait for initial registration or use cache
  if (!dynamicTools) {
    for (let i = 0; i < 50 && !dynamicTools; i++) {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  if (dynamicTools) return { tools: [SESSION_INFO_TOOL, ...dynamicTools] }
  process.stderr.write('bridge: daemon not yet registered — returning minimal tool set\n')
  return { tools: [SESSION_INFO_TOOL] }
})

// ── Tool call handler (relay to daemon) ────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const args = req.params.arguments ?? {}

  if (name === 'get_session_info') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_id: SESSION_ID,
          sessionMetadata: sessionMetadata ?? {
            role: IS_MAIN ? 'main' : 'worker',
            tools: [],
            model: 'unknown',
            cwd: process.cwd(),
            platform: 'unknown',
          },
        }, null, 2),
      }],
    }
  }

  if (!sock || sock.destroyed || !socketReady) {
    return {
      content: [{ type: 'text', text: `${name} failed: not connected to daemon` }],
      isError: true,
    }
  }

  const id = randomUUID()

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(id)
      resolve({
        content: [{ type: 'text', text: `${name} failed: timeout waiting for daemon response` }],
        isError: true,
      })
    }, LONG_TOOL_TIMEOUTS_MS[name] ?? 60_000)

    pendingCalls.set(id, {
      resolve: (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      reject: (err) => {
        clearTimeout(timeout)
        resolve({
          content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
          isError: true,
        })
      },
    })

    sendToSocket({ type: 'tool_call', id, name, args })
  })
})

// ── Safety nets ────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  recordError('unhandledRejection', err)
  process.stderr.write(`bridge: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  recordError('uncaughtException', err)
  process.stderr.write(`bridge: uncaught exception: ${err}\n`)
})

// ── Shutdown ───────────────────────────────────────────────────────────

let lastTick = Date.now()
function noteWake(): void {
  const now = Date.now()
  if (now - lastTick > WAKE_GAP_MS) recordLife({ ev: 'wake', ts: now, gapMs: now - lastTick })
  lastTick = now
}

let shuttingDown = false
function shutdown(ev: 'stdin' | 'signal', detail: string): void {
  if (shuttingDown) return
  shuttingDown = true
  noteWake()
  const cause: BridgeLifeEvent = { ev, ts: Date.now(), ppid: process.ppid, detail }
  recordLife(cause)
  process.stderr.write(`bridge: shutting down: ${JSON.stringify(cause)}\n`)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (sock && !sock.destroyed) {
    sock.destroy()
  }
  // Reject any remaining pending calls
  for (const [id, pending] of pendingCalls) {
    pending.reject(new Error('bridge shutting down'))
    pendingCalls.delete(id)
  }
  setTimeout(() => process.exit(0), BRIDGE_SHUTDOWN_GRACE_MS)
}

process.stdin.on('end', () => shutdown('stdin', 'end'))
process.stdin.on('close', () => shutdown('stdin', 'close'))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown('signal', signal))
}
process.on('exit', code => recordLife({ ev: 'exit', ts: Date.now(), code }))

recordLife({ ev: 'start', ts: Date.now(), pid: process.pid, ppid: process.ppid, sessionId: SESSION_ID })
setInterval(noteWake, WAKE_TICK_MS).unref()

// ── Start ──────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
connectSocket()
