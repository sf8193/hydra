import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs'
import { createServer, type Socket } from 'net'
import { gateway, SOCK_PATH, STATE_DIR, PLATFORM } from './config.js'
import { registry } from './sessions.js'
import { transport, type BridgeConn } from './bridge-transport.js'
import { executeTool, computeToolsForSession, MAIN_ONLY_TOOLS, SPAWN_MODEL } from './bridge-dispatch.js'
import { pendingPermissions } from './permission.js'
import { discoverClaudeSessionId } from './session-lifecycle.js'
import { loadAccess } from './access.js'
import { isReviewParticipant, onReviewReply, onParticipantDisconnect, onParticipantReconnect } from './adversarial.js'
import type { ButtonDef } from '../gateway.js'

// ---------------------------------------------------------------------------
// Bridge protocol handler
// ---------------------------------------------------------------------------

function handleBridgeMessage(conn: BridgeConn, raw: string): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    process.stderr.write(`daemon: invalid JSON from bridge: ${raw.slice(0, 200)}\n`)
    return
  }

  switch (msg.type) {
    case 'register': {
      const sessionId = msg.sessionId as string
      conn.sessionId = sessionId

      const claudeSessionId = msg.claudeSessionId as string | undefined
      const info = registry.get(sessionId)
      if (info) {
        const resolved = claudeSessionId || discoverClaudeSessionId(info.tmuxName)
        if (resolved) {
          info.claudeSessionId = resolved
          registry.persist()
        }
      }

      const existing = transport.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        process.stderr.write(`daemon: replacing bridge for session ${sessionId}\n`)
        try { existing.socket.end() } catch {}
      }

      transport.set(sessionId, conn)
      const tools = computeToolsForSession(sessionId)
      transport.sendToBridge(conn, {
        type: 'registered',
        sessionId,
        tools,
        platform: PLATFORM,
        capabilities: info?.capabilities ?? {
          role: sessionId === 'main' ? 'main' : 'worker',
          tools: tools.map(t => t.name),
          model: SPAWN_MODEL,
          cwd: process.env.SPAWN_CWD ?? '(unknown)',
          platform: PLATFORM,
        },
      })
      transport.flushQueue(sessionId)
      if (isReviewParticipant(sessionId)) onParticipantReconnect(sessionId)
      process.stderr.write(`daemon: bridge registered for session ${sessionId}\n`)
      break
    }

    case 'tool_call': {
      const { id, name, args } = msg as { id: string; name: string; args: Record<string, unknown> }

      if (MAIN_ONLY_TOOLS.has(name) && conn.sessionId !== 'main') {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: [{ type: 'text', text: `${name} is only available to the main session` }],
          isError: true,
        })
        return
      }

      if (conn.sessionId !== 'main') {
        const info = registry.get(conn.sessionId)
        if (info) info.lastActive = Date.now()
      }

      void executeTool(name, args).then(result => {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        })

        // Adversarial review: detect reply from any review participant
        if (name === 'reply' && !result.isError && conn.sessionId && isReviewParticipant(conn.sessionId)) {
          onReviewReply(conn.sessionId, args.text as string, args.chat_id as string, result.sentIds ?? [])
        }
      }).catch(err => {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: [{ type: 'text', text: `internal error: ${err}` }],
          isError: true,
        })
      })
      break
    }

    case 'permission_response': {
      break
    }

    case 'permission_request': {
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess()
      const text = `Permission: ${tool_name}`
      const buttons: ButtonDef[] = [
        { id: `perm:more:${request_id}`, label: 'See more', style: 'secondary' },
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '✅' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '❌' },
      ]
      for (const userId of access.allowFrom) {
        void gateway.sendDM(userId, text, buttons).catch(e => {
          process.stderr.write(`daemon: permission_request send to ${userId} failed: ${e}\n`)
        })
      }
      break
    }

    default:
      process.stderr.write(`daemon: unknown message type from bridge: ${msg.type}\n`)
  }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

try {
  if (existsSync(SOCK_PATH)) {
    unlinkSync(SOCK_PATH)
  }
} catch {}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

export const socketServer = createServer((socket: Socket) => {
  const conn: BridgeConn = {
    sessionId: '',
    socket,
    buf: '',
  }

  socket.on('data', (data: Buffer) => {
    conn.buf += data.toString()
    let nl: number
    while ((nl = conn.buf.indexOf('\n')) !== -1) {
      const line = conn.buf.slice(0, nl).trim()
      conn.buf = conn.buf.slice(nl + 1)
      if (line) handleBridgeMessage(conn, line)
    }
  })

  socket.on('end', () => {
    if (conn.sessionId) {
      process.stderr.write(`daemon: bridge disconnected for session ${conn.sessionId}\n`)
      if (transport.get(conn.sessionId) === conn) {
        transport.delete(conn.sessionId)
      }
      // Adversarial review: handle participant disconnect
      if (isReviewParticipant(conn.sessionId)) {
        onParticipantDisconnect(conn.sessionId)
      }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`daemon: bridge socket error: ${err}\n`)
    if (conn.sessionId && transport.get(conn.sessionId) === conn) {
      transport.delete(conn.sessionId)
    }
  })
})

socketServer.listen(SOCK_PATH, () => {
  try { chmodSync(SOCK_PATH, 0o700) } catch {}
  process.stderr.write(`daemon: listening on ${SOCK_PATH}\n`)
})
