#!/usr/bin/env bun
/**
 * Hydra MCP Tool Server — exposes daemon tools to Codex sessions via MCP stdio.
 *
 * Spawned by codex as an MCP server. When codex calls a tool (reply, react, etc.),
 * this server forwards it to the daemon via the daemon's unix socket, using the
 * same protocol as Claude's bridge. From the daemon's perspective, tool calls
 * from codex look identical to tool calls from Claude.
 *
 * Usage (in codex config):
 *   mcp_servers.hydra.command = "bun /path/to/codex-mcp-server.ts"
 *
 * Env vars (set by the spawn script):
 *   DAEMON_SOCK — path to daemon's unix socket
 *   HYDRA_SESSION_ID — this session's ID
 */

import { connect, type Socket } from 'net'
import { createInterface } from 'readline'

const DAEMON_SOCK = process.env.DAEMON_SOCK
const SESSION_ID = process.env.HYDRA_SESSION_ID

if (!DAEMON_SOCK || !SESSION_ID) {
  process.stderr.write('codex-mcp-server: DAEMON_SOCK and HYDRA_SESSION_ID required\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Daemon bridge connection
// ---------------------------------------------------------------------------

let daemonSocket: Socket | null = null
let daemonBuf = ''
let toolCallCounter = 0
const pendingToolCalls = new Map<string, (result: any) => void>()

function connectToDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false
    const sock = connect(DAEMON_SOCK!)
    const onError = (err: Error) => reject(err)
    sock.once('error', onError)
    sock.once('connect', () => {
      connected = true
      sock.removeListener('error', onError)
      daemonSocket = sock
      sock.write(JSON.stringify({ type: 'register', sessionId: SESSION_ID }) + '\n')
      sock.on('error', (err) => {
        process.stderr.write(`codex-mcp-server: daemon socket error: ${err.message}\n`)
      })
      resolve()
    })
    sock.on('data', (chunk) => {
      daemonBuf += chunk.toString()
      let nl: number
      while ((nl = daemonBuf.indexOf('\n')) !== -1) {
        const line = daemonBuf.slice(0, nl)
        daemonBuf = daemonBuf.slice(nl + 1)
        handleDaemonMessage(line)
      }
    })
    sock.on('close', () => {
      daemonSocket = null
      daemonBuf = ''
      if (connected) {
        // Only reconnect if we were previously connected (not a failed connect attempt)
        process.stderr.write('codex-mcp-server: daemon connection closed, reconnecting...\n')
        scheduleReconnect()
      }
    })
  })
}

function handleDaemonMessage(line: string): void {
  try {
    const msg = JSON.parse(line)
    if (msg.type === 'tool_result' && msg.id) {
      const resolve = pendingToolCalls.get(msg.id)
      if (resolve) {
        pendingToolCalls.delete(msg.id)
        resolve(msg)
      }
    }
    // Ignore 'registered', 'notification', etc. — those are for the session, not us
  } catch {}
}

async function waitForDaemon(): Promise<void> {
  if (daemonSocket) return
  const start = Date.now()
  while (!daemonSocket && Date.now() - start < 15_000) {
    await new Promise(r => setTimeout(r, 500))
  }
  if (!daemonSocket) throw new Error('not connected to daemon after 15s')
}

async function callDaemonTool(id: string, name: string, args: Record<string, unknown>): Promise<any> {
  await waitForDaemon()
  if (!daemonSocket) throw new Error('not connected to daemon')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingToolCalls.has(id)) {
        pendingToolCalls.delete(id)
        reject(new Error(`tool call ${name} timed out`))
      }
    }, 30_000)
    pendingToolCalls.set(id, (result: any) => { clearTimeout(timer); resolve(result) })
    daemonSocket!.write(JSON.stringify({ type: 'tool_call', id, name, args }) + '\n')
  })
}

// ---------------------------------------------------------------------------
// MCP stdio server (JSON-RPC)
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin })

// Import tools from the canonical source — keeps codex and claude tool sets in sync
import { computeToolsForSession } from './bridge-tools.js'
const TOOLS = computeToolsForSession('worker').map(t => ({
  name: t.name, description: t.description, inputSchema: t.inputSchema,
}))

function send(msg: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function handleToolCall(id: number, params: any): Promise<void> {
  const toolName = params?.name
  const toolArgs = params?.arguments ?? {}
  try {
    const callId = `codex-${SESSION_ID}-${toolCallCounter++}`
    const result = await callDaemonTool(callId, toolName, toolArgs)
    send({ id, result: { content: result.content ?? [{ type: 'text', text: 'ok' }], isError: result.isError ?? false } })
  } catch (err) {
    send({ id, result: { content: [{ type: 'text', text: `Tool error: ${err instanceof Error ? err.message : err}` }], isError: true } })
  }
}

rl.on('line', async (line) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return }

  const { id, method, params } = parsed
  switch (method) {
    case 'initialize':
      send({ id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hydra-tools', version: '1.0.0' } } })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      send({ id, result: { tools: TOOLS } })
      break
    case 'tools/call':
      await handleToolCall(id, params)
      break
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
})

// ---------------------------------------------------------------------------
// Reconnection with exponential backoff
// ---------------------------------------------------------------------------

let reconnectDelay = 10_000
const MAX_RECONNECT_DELAY = 60_000

function scheduleReconnect(): void {
  setTimeout(() => {
    connectToDaemon()
      .then(() => {
        reconnectDelay = 2000 // reset on success
        process.stderr.write('codex-mcp-server: reconnected to daemon\n')
      })
      .catch(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
        process.stderr.write(`codex-mcp-server: reconnect failed, retrying in ${reconnectDelay}ms\n`)
        scheduleReconnect()
      })
  }, reconnectDelay)
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Deferred connect: the readline handler (MCP protocol) must be registered before
// connectToDaemon runs, otherwise codex's `initialize` request arrives on stdin
// before we're listening. The 100ms delay ensures the event loop registers `rl.on('line')`
// before the daemon connection attempt begins.
setTimeout(() => {
  connectToDaemon().catch(err => {
    process.stderr.write(`codex-mcp-server: initial connect failed: ${err?.message}, will retry...\n`)
    scheduleReconnect()
  })
}, 100)
