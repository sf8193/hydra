#!/usr/bin/env bun
/**
 * Chat routing daemon — orchestrator.
 *
 * Platform-agnostic message router that holds a single chat gateway connection
 * (Discord or Slack) and routes messages to/from Claude sessions via unix sockets.
 *
 * This file wires the decomposed modules together. Domain logic lives in daemon/.
 */

import { join } from 'path'
import { copyFileSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'

import { gateway, TOKEN, PLATFORM, STATE_DIR, CLAUDE_CONFIG, SOCK_PATH, heartbeatPath } from './daemon/config.js'
import { registry, threadRegistry } from './daemon/sessions.js'
import { transport } from './daemon/bridge-transport.js'
import { loadAccess } from './daemon/access.js'
import { setupPermissionHandler } from './daemon/permission.js'
import { socketServer } from './daemon/bridge-server.js'
import { announceRestartComplete } from './daemon/commands/global.js'

// Importing router wires up gateway.onMessage / onThreadDelete / onMessageDelete
import './daemon/router.js'
import { getContextPercent, formatDuration } from './daemon/util.js'
import { syncUpdate } from './daemon/list-sync.js'

// Boot ThreadRegistry — must happen after sessions are loaded
threadRegistry.boot(registry)
import { isSessionDead } from './daemon/commands/thread.js'

// ---------------------------------------------------------------------------
// Recovery report on reconnect
// ---------------------------------------------------------------------------

function sendRecoveryReport(gapMs: number): void {
  const hrs = Math.floor(gapMs / 3_600_000)
  const mins = Math.floor((gapMs % 3_600_000) / 60_000)
  const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
  const connected = [...registry.values()].filter(s => transport.has(s.sessionId)).length
  const disconnected = [...registry.values()].filter(s => !transport.has(s.sessionId)).length
  const queuedMsgCount = [...transport.messageQueues.values()].reduce((sum, q) => sum + q.length, 0)
  const report = [
    `**Recovery report** — back online after ${duration} outage`,
    `• Sessions: ${registry.size} total (${connected} connected, ${disconnected} disconnected)`,
    `• Queued messages: ${queuedMsgCount}`,
  ].join('\n')
  const access = loadAccess()
  for (const userId of access.allowFrom) {
    void gateway.sendDM(userId, report).catch(e =>
      process.stderr.write(`daemon: recovery report DM failed: ${e}\n`),
    )
  }
  process.stderr.write(`daemon: sent recovery report (offline ${duration})\n`)
}

gateway.onReconnectAfterOutage = sendRecoveryReport

// ---------------------------------------------------------------------------
// Permission UI
// ---------------------------------------------------------------------------

setupPermissionHandler(gateway)

// ---------------------------------------------------------------------------
// Bridge sync — keep plugin cache in sync with repo bridge.ts
// ---------------------------------------------------------------------------

try {
  const bridgeSrc = join(import.meta.dir, 'bridge.ts')
  const discordCache = join(CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord')
  const daemonConfig = JSON.stringify({ socket: SOCK_PATH, platform: PLATFORM })
  const versionDirs = readdirSync(discordCache, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const d of versionDirs) {
    const targetDir = join(discordCache, d.name)
    copyFileSync(bridgeSrc, join(targetDir, 'server.ts'))
    writeFileSync(join(targetDir, 'daemon.json'), daemonConfig)
  }
  process.stderr.write(`daemon: synced bridge.ts + daemon.json into ${discordCache}/*/\n`)
} catch (err) {
  process.stderr.write(`daemon: bridge sync skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
}

// ---------------------------------------------------------------------------
// Startup-time outage detection — check heartbeat gap from prior daemon
// ---------------------------------------------------------------------------

const OUTAGE_THRESHOLD_MS = 10 * 60_000
let startupGapMs: number | null = null
try {
  const lastHeartbeat = parseInt(readFileSync(heartbeatPath, 'utf8').trim(), 10)
  if (lastHeartbeat > 0) {
    const gapMs = Date.now() - lastHeartbeat
    if (gapMs > OUTAGE_THRESHOLD_MS) startupGapMs = gapMs
  }
} catch {}

// ---------------------------------------------------------------------------
// Gateway start & graceful shutdown
// ---------------------------------------------------------------------------

const GATEWAY_RETRY_INTERVAL_MS = 10_000
const GATEWAY_MAX_RETRIES = 30

async function startGateway(attempt = 0): Promise<void> {
  if (attempt > 0) {
    try { writeFileSync(heartbeatPath, String(Date.now()) + '\n') } catch {}
  }
  try {
    await gateway.start(TOKEN!)
    process.stderr.write(`daemon: ${PLATFORM} gateway started\n`)
    void announceRestartComplete()
    if (startupGapMs !== null) {
      sendRecoveryReport(startupGapMs)
      startupGapMs = null
    }
  } catch (err) {
    if (attempt >= GATEWAY_MAX_RETRIES) {
      process.stderr.write(`daemon: gateway start failed after ${attempt} attempts, exiting: ${err}\n`)
      process.exit(1)
    }
    process.stderr.write(`daemon: gateway start failed (attempt ${attempt + 1}/${GATEWAY_MAX_RETRIES}), retrying in ${GATEWAY_RETRY_INTERVAL_MS / 1000}s: ${err}\n`)
    await new Promise(r => setTimeout(r, GATEWAY_RETRY_INTERVAL_MS))
    return startGateway(attempt + 1)
  }
}

void startGateway()

// ---------------------------------------------------------------------------
// Session health — crash detection + context alerts (every 5 min)
// ---------------------------------------------------------------------------

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000
const CONTEXT_ALERT_THRESHOLD = 70
const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()

setInterval(() => {
  for (const info of registry.values()) {
    // Crash detection
    if (!crashAlerted.has(info.sessionId) && !info.isJoinMember && isSessionDead(info)) {
      crashAlerted.add(info.sessionId)
      process.stderr.write(`daemon: crash detected: ${info.tmuxName}\n`)
      void gateway.send(info.threadId, `💀 **${info.tmuxName}** died. Use \`resume\` to restore context or \`respawn\` for a fresh start.`).catch(() => {})
      continue
    }

    // Context alert
    const pct = getContextPercent(info.tmuxName)
    if (pct !== '?') {
      const num = parseInt(pct)
      if (num >= CONTEXT_ALERT_THRESHOLD && !contextAlerted.has(info.sessionId)) {
        contextAlerted.add(info.sessionId)
        process.stderr.write(`daemon: context alert: ${info.tmuxName} at ${pct}\n`)
        void gateway.send(info.threadId, `**${info.tmuxName}** is at **${pct}** context. Consider \`handoff\` to a fresh session before it fills up.`).catch(() => {})
      }
    }

    const healthThread = threadRegistry.get(info.threadId)
    if (healthThread?.listRecordId) {
      void syncUpdate(healthThread, {
        contextPct: pct !== '?' ? parseInt(pct) : undefined,
        messageCount: info.messageCount ?? 0,
        duration: formatDuration(Date.now() - info.createdAt),
      })
    }
  }
}, SESSION_CHECK_INTERVAL_MS)

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  transport.persistQueues()
  socketServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}

  for (const [, bridge] of transport.bridges) {
    try { bridge.socket.end() } catch {}
  }
  transport.clear()

  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(gateway.stop()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
