import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs'
import { execSync } from 'child_process'
import { createServer, type Socket } from 'net'
import { gateway, SOCK_PATH, STATE_DIR, PLATFORM } from './config.js'
import { registry, threadRegistry } from './sessions.js'
import { transport, type BridgeConn } from './bridge-transport.js'
import { executeTool } from './bridge-dispatch.js'
import { computeToolsForSession, MAIN_ONLY_TOOLS } from './bridge-tools.js'
import { spawnModel } from '../shared/constants.js'
import { pendingPermissions } from './permission.js'
import { discoverClaudeSessionId, killSession } from './session-lifecycle.js'
import { loadAccess } from './access.js'
import { dispatchReconnect, dispatchReply, dispatchDisconnect } from './protocol-registry.js'
import { onBuilderDone } from './factory.js'
import { maybeNudgeMissingSentinel } from './sentinel-nudge.js'
import { refreshSessionVisual } from './anchor-state.js'
import { handleCLIRequest, type CLIRequest } from './cli-handler.js'
import { watchPr, getWatchesBySession } from './pr-watch.js'
import { shouldHoldIncumbentMain } from './main-guard.js'
import { buildAutopsy, logCorrelation, tailSpawnLog, buildCrashNotice, getVitalsSample } from './observability.js'
import { safeSend } from './util.js'
import { createMainBridgeCycle, formatReconnectLine, mainCloseRecordsReason } from './main-bridge-cycle.js'
import type { ButtonDef } from '../gateway.js'

const DEATH_DETECT_DELAY_MS = 3_000

// ---------------------------------------------------------------------------
// Auto-watch: scan session replies for GitHub PR URLs
// ---------------------------------------------------------------------------

const PR_URL_RE = /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g

// ---------------------------------------------------------------------------
// Ephemeral TTL — safety net for stuck ephemeral sessions
// ---------------------------------------------------------------------------

const EPHEMERAL_TTL_MS = 30 * 60 * 1000 // 30 minutes
const ephemeralTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function startEphemeralTtl(sessionId: string): void {
  clearEphemeralTtl(sessionId)
  ephemeralTimers.set(sessionId, setTimeout(() => {
    const info = registry.get(sessionId)
    if (info?.ephemeral) {
      process.stderr.write(`daemon: ephemeral session ${info.tmuxName} TTL expired (${EPHEMERAL_TTL_MS / 60000}min), killing\n`)
      void killSession(info, 'ephemeral TTL expired').catch(err => {
        process.stderr.write(`daemon: ephemeral TTL kill failed: ${err}\n`)
      })
    }
    ephemeralTimers.delete(sessionId)
  }, EPHEMERAL_TTL_MS))
}

function clearEphemeralTtl(sessionId: string): void {
  const timer = ephemeralTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    ephemeralTimers.delete(sessionId)
  }
}

/** Boot-time sweep: start TTL for any restored ephemeral sessions */
export function initEphemeralTimers(): void {
  for (const info of registry.values()) {
    if (info.ephemeral) {
      startEphemeralTtl(info.sessionId)
    }
  }
}

function autoWatchPrUrls(sessionId: string, text: string): void {
  if (!text) return
  const info = registry.get(sessionId)
  if (!info) return

  const urls = text.match(PR_URL_RE)
  if (!urls) return

  const existingWatches = new Set(getWatchesBySession(sessionId).map(w => w.prUrl))

  for (const url of new Set(urls)) {
    if (existingWatches.has(url)) continue

    watchPr(url, sessionId, info.threadId).then(msg => {
      process.stderr.write(`daemon: auto-watch: ${msg}\n`)
      if (!msg.startsWith('already watching')) {
        gateway.send(info.threadId, `_Auto-watching_ ${url}`).catch(() => {})
      }
    }).catch(err => {
      process.stderr.write(`daemon: auto-watch failed for ${url}: ${err instanceof Error ? err.message : err}\n`)
    })
  }
}

// ---------------------------------------------------------------------------
// Bridge flap circuit breaker — kill sessions that reconnect too rapidly
// ---------------------------------------------------------------------------

const FLAP_WINDOW_MS = 60_000
const MAIN_COOLDOWN_MS = 10_000
const FLAP_THRESHOLD = 10
const flapTracker = new Map<string, number[]>()

// Tracks each cycle's disconnect reason + true uptime for the 'main' reconnect
// log below. Instruments an unresolved reconnect-flapping issue; does not fix it.
// Logic lives in main-bridge-cycle.ts (pure + tested); this owns the stderr write.
const mainBridge = createMainBridgeCycle()

function trackRegistration(sessionId: string): boolean {
  const now = Date.now()
  const timestamps = flapTracker.get(sessionId) ?? []
  timestamps.push(now)
  const recent = timestamps.filter(t => now - t < FLAP_WINDOW_MS)
  flapTracker.set(sessionId, recent)
  if (recent.length >= FLAP_THRESHOLD) {
    flapTracker.delete(sessionId)
    return true
  }
  return false
}

// Refuse newcomer 'main' bridges until this time once a duplicate-'main' flap is
// detected (see main-guard.ts). 'main' is exempt from the kill path above, so the
// guard holds the incumbent instead.
let duplicateMainCooldownUntil = 0
let duplicateMainIncumbentSocket: import('net').Socket | undefined

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

          // Flow claudeSessionId to thread history
          const thread = threadRegistry.get(info.threadId)
          if (thread) {
            const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId)
            if (histEntry) histEntry.claudeSessionId = resolved
            threadRegistry.persist()
          }
        }
        if (sessionId !== 'main') logCorrelation(info)
      }

      if (sessionId !== 'main' && info?.engine !== 'codex' && trackRegistration(sessionId)) {
        process.stderr.write(`daemon: circuit breaker: ${info?.tmuxName ?? sessionId} flapping (${FLAP_THRESHOLD}+ registrations in ${FLAP_WINDOW_MS / 1000}s) — killing session\n`)
        try { execSync(`tmux kill-session -t '${info?.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }) } catch {}
        if (info) {
          info.deadAt = Date.now()
          registry.persist()
          void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** killed by circuit breaker — bridge was flapping (${FLAP_THRESHOLD}+ reconnects in ${FLAP_WINDOW_MS / 1000}s). Use \`respawn\` to start fresh.`).catch(() => {})
        }
        try { conn.socket.end() } catch {}
        break
      }

      // Whether a live 'main' incumbent already existed at registration —
      // carried to mainBridge.connect() to flag a two-process fight vs. a reconnect.
      let mainHadOtherIncumbent = false

      // Duplicate-'main' guard. The circuit breaker above exempts 'main' (never
      // tmux-kill the control session), but 'main' is the id every bridge defaults
      // to without HYDRA_SESSION_ID — so two byte processes can both claim it and
      // evict each other unboundedly via the socket replacement below. When 'main'
      // flaps, hold the incumbent and refuse the newcomer instead. A single
      // legitimate byte restart (no recent flap) falls through to normal replace.
      if (sessionId === 'main') {
        const incumbent = transport.get('main')
        const hasOtherIncumbent = !!incumbent && incumbent.socket !== conn.socket
        mainHadOtherIncumbent = hasOtherIncumbent
        const now = Date.now()

        // Cooldown refusal — do NOT track this registration. Refused
        // registrations must not feed the flap detector, or the guard's own
        // enforcement generates the signal that perpetuates it.
        if (hasOtherIncumbent && now < duplicateMainCooldownUntil) {
          if (duplicateMainIncumbentSocket !== transport.get('main')?.socket) {
            duplicateMainCooldownUntil = 0
            duplicateMainIncumbentSocket = undefined
            process.stderr.write(`daemon: duplicate 'main' cooldown cleared — incumbent died, accepting newcomer\n`)
          } else {
            process.stderr.write(`daemon: duplicate 'main' — cooldown active (${Math.ceil((duplicateMainCooldownUntil - now) / 1000)}s remaining), refusing newcomer\n`)
            try { conn.socket.end() } catch {}
            break
          }
        }

        // Flap detection — only reached by registrations that passed the
        // cooldown check, so the count reflects real registration attempts.
        const flapping = trackRegistration('main')
        if (shouldHoldIncumbentMain({ hasOtherIncumbent, flapping, now, cooldownUntil: duplicateMainCooldownUntil })) {
          duplicateMainCooldownUntil = now + MAIN_COOLDOWN_MS
          duplicateMainIncumbentSocket = transport.get('main')?.socket
          process.stderr.write(`daemon: duplicate 'main' bridge flapping — holding incumbent, refusing newcomer. A second byte/main process is running; kill the extra and keep one.\n`)
          try { conn.socket.end() } catch {}
          break
        }
      }

      const existing = transport.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        if (sessionId !== 'main') process.stderr.write(`daemon: replacing bridge for session ${sessionId}\n`)
        // The main replace is otherwise silent — record it as the disconnect
        // cause for the next reconnect log line. SYNC: mainBridge.connect() below
        // must run in the same synchronous pass as this notifyReplaced (before the
        // evicted socket's async 'end' arrives) — do not insert an await between
        // them, or the 'replaced' reason will be lost. See main-bridge-cycle.ts.
        if (sessionId === 'main') mainBridge.notifyReplaced(Date.now())
        try { existing.socket.end() } catch {}
      }

      transport.set(sessionId, conn)
      // Deliberately kept (diagnostics-only). This self-wipes the flap counter
      // that trackRegistration('main') just fed, so the flap threshold can never
      // trip and shouldHoldIncumbentMain stays inert. Removing it is the actual
      // circuit-breaker fix — but on the live 5s flap, each reconnect reads
      // hasOtherIncumbent=true (replace path), so an accumulating counter would
      // cross the threshold in ~50s and refuse main's own reconnects, locking out
      // the control channel. Held until the close cause is confirmed — the uptime +
      // disconnect-reason instrumentation here is what makes that confirmation possible.
      // TODO(fix-main-flap): remove flapTracker.delete('main') once the disconnect cause is confirmed.
      if (sessionId === 'main' && !mainHadOtherIncumbent) flapTracker.delete('main')
      const tools = computeToolsForSession(sessionId)
      transport.sendToBridge(conn, {
        type: 'registered',
        sessionId,
        tools,
        platform: PLATFORM,
        capabilities: info?.capabilities ?? {
          role: sessionId === 'main' ? 'main' : 'worker',
          tools: tools.map(t => t.name),
          model: spawnModel(),
          cwd: process.env.SPAWN_CWD ?? '(unknown)',
          platform: PLATFORM,
        },
      })
      transport.flushQueue(sessionId)
      dispatchReconnect(sessionId)
      if (info && !info.isJoinMember) refreshSessionVisual(info.threadId)
      if (sessionId === 'main') {
        const r = mainBridge.connect(mainHadOtherIncumbent, Date.now())
        if (r.kind === 'first') process.stderr.write('daemon: main bridge connected\n')
        else if (!r.throttled) process.stderr.write(formatReconnectLine(r) + '\n')
      } else {
        process.stderr.write(`daemon: bridge registered for session ${sessionId}\n`)
        if (info?.ephemeral) startEphemeralTtl(sessionId)
      }
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

      void executeTool(name, args, conn.sessionId).then(async result => {
        transport.sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        })

        try {
          if (name === 'reply' && !result.isError && conn.sessionId) {
            const replyInfo = registry.get(conn.sessionId)
            const replyText = args.text as string

            if (replyInfo && !replyInfo.ephemeral) {
              autoWatchPrUrls(conn.sessionId, replyText)
            }

            await dispatchReply(conn.sessionId, replyText, args.chat_id as string, result.sentIds ?? [])
            maybeNudgeMissingSentinel(conn.sessionId, replyText, args.chat_id as string)

            // Factory builder: [done] prefix triggers review (may have trailing artifact)
            const FACTORY_DONE_RE = /^\[done\]/m
            // Ephemeral: [done] must be the entire line (no trailing content)
            const EPHEMERAL_DONE_RE = /^\[done\]$/m

            if (FACTORY_DONE_RE.test(replyText)) {
              onBuilderDone(conn.sessionId, replyText)
            }

            if (replyInfo?.ephemeral && EPHEMERAL_DONE_RE.test(replyText)) {
              process.stderr.write(`daemon: ephemeral session ${replyInfo.tmuxName} posted [done], killing\n`)
              clearEphemeralTtl(conn.sessionId)
              const sid = conn.sessionId
              setTimeout(() => {
                const current = registry.get(sid)
                if (current) {
                  void killSession(current, 'ephemeral [done]').catch(err => {
                    process.stderr.write(`daemon: ephemeral kill failed: ${err}\n`)
                  })
                }
              }, 2000)
            }
          }
        } catch (err) {
          process.stderr.write(`daemon: post-reply hook failed: ${err}\n`)
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
      const sessionId = conn.sessionId || 'main'
      pendingPermissions.set(request_id, { tool_name, description, input_preview, sessionId })
      const access = loadAccess()
      const text = `Permission: ${tool_name}`
      const buttons: ButtonDef[] = [
        { id: `perm:more:${request_id}`, label: 'See more', style: 'secondary' },
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '✅' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '❌' },
      ]
      // Post buttons in the session's thread (if it's a spawned session), otherwise DM allowFrom users
      const permInfo = sessionId !== 'main' ? registry.get(sessionId) : undefined
      if (permInfo) {
        void gateway.send(permInfo.threadId, text, { buttons }).catch(e => {
          process.stderr.write(`daemon: permission_request send to thread ${permInfo.threadId} failed: ${e}\n`)
        })
      } else {
        for (const userId of access.allowFrom) {
          void gateway.sendDM(userId, text, buttons).catch(e => {
            process.stderr.write(`daemon: permission_request send to ${userId} failed: ${e}\n`)
          })
        }
      }
      break
    }

    case 'cli': {
      void handleCLIRequest(msg as CLIRequest).then(response => {
        conn.socket.write(JSON.stringify(response) + '\n')
      }).catch(err => {
        conn.socket.write(JSON.stringify({
          type: 'cli-response',
          id: msg.id ?? '',
          ok: false,
          error: `internal error: ${err instanceof Error ? err.message : String(err)}`,
        }) + '\n')
      })
      break
    }

    default:
      process.stderr.write(`daemon: unknown message type from bridge: ${msg.type}\n`)
  }
}

// ---------------------------------------------------------------------------
// Session death detection
// ---------------------------------------------------------------------------

async function checkSessionDeath(sessionId: string): Promise<void> {
  if (transport.has(sessionId)) return

  const info = registry.get(sessionId)
  if (!info) return

  let tmuxAlive = false
  try { execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' }); tmuxAlive = true } catch {}

  if (!tmuxAlive) {
    // Read the pane tail once, for the autopsy — which goes to the daemon log
    // (PRESERVE, hardware-only). The channel gets a LINK to the log, never the bytes.
    let tail: string[] = []
    if (info.spawnLogPath) {
      try {
        tail = tailSpawnLog(info.spawnLogPath)
      } catch (err) {
        process.stderr.write(`daemon: session ${info.tmuxName} black box unreadable (${info.spawnLogPath}): ${err}\n`)
      }
    }
    process.stderr.write(buildAutopsy(info, 'crashed (tmux dead, bridge disconnected)', tail, Date.now(), getVitalsSample(info.sessionId)) + '\n')

    const thread = threadRegistry.get(info.threadId)
    if (thread) {
      const histEntry = thread.sessionHistory.find(h => h.sessionId === sessionId && !h.endedAt)
      if (histEntry) {
        histEntry.endedAt = Date.now()
        histEntry.messageCount = info.messageCount ?? 0
        histEntry.claudeSessionId = info.claudeSessionId
      }
      threadRegistry.persist()
    }

    info.deadAt = Date.now()
    registry.persist()

    // Ephemeral sessions die silently — no crash message or skull visual
    if (!info.ephemeral) {
      // safeSend (never throws, chunks, logs) — the daemon's delivery path.
      await safeSend(info.threadId, buildCrashNotice(info))
      refreshSessionVisual(info.threadId, { state: 'crashed' })
    }
  }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

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

  function handleSocketClose(reason: string): void {
    if (!conn.sessionId) return
    const isOwner = transport.get(conn.sessionId) === conn
    // First reason wins. A socket can emit both 'error' and 'end'; the owner's
    // first close records the cause (and the transport.delete below then makes any
    // later close a non-owner), so this flag is belt-and-suspenders that keeps the
    // real cause even if that ordering ever changes.
    if (mainCloseRecordsReason(conn.sessionId, isOwner) && !conn.mainCloseRecorded) {
      conn.mainCloseRecorded = true
      mainBridge.disconnect(reason, Date.now())
    }
    if (isOwner) {
      transport.delete(conn.sessionId)
    }
    const protocolClaimed = dispatchDisconnect(conn.sessionId)
    if (conn.sessionId !== 'main' && !protocolClaimed) {
      const sid = conn.sessionId
      setTimeout(() => checkSessionDeath(sid), DEATH_DETECT_DELAY_MS)
    }
  }

  socket.on('end', () => {
    if (conn.sessionId && conn.sessionId !== 'main') {
      process.stderr.write(`daemon: bridge disconnected for session ${conn.sessionId}\n`)
    }
    handleSocketClose('end')
  })

  socket.on('error', (err) => {
    process.stderr.write(`daemon: bridge socket error: ${err}\n`)
    handleSocketClose(`error: ${err instanceof Error ? err.message : String(err)}`)
  })
})

export function startBridgeServer(): void {
  // Clean up stale socket and ensure state dir exists — must happen here
  // (not at module level) so the socket probe in daemon.ts can test the
  // incumbent's socket before we delete it.
  try {
    if (existsSync(SOCK_PATH)) {
      unlinkSync(SOCK_PATH)
    }
  } catch {}
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  socketServer.listen(SOCK_PATH, () => {
    try { chmodSync(SOCK_PATH, 0o700) } catch {}
    process.stderr.write(`daemon: listening on ${SOCK_PATH}\n`)
  })
}
