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
import { copyFileSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { connect } from 'net'

// ---------------------------------------------------------------------------
// Singleton enforcement — exactly one daemon per state dir.
// PID check is best-effort diagnostic — the socket probe (post-import,
// pre-listen) is the authoritative singleton gate.
// ---------------------------------------------------------------------------

const STATE_DIR_EARLY = process.env.HYDRA_STATE_DIR ?? join(require('os').homedir(), '.claude', 'channels', process.env.CHAT_PLATFORM ?? 'discord')
const PID_FILE = join(STATE_DIR_EARLY, 'daemon.pid')

try {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0)
        process.stderr.write(`daemon: another daemon may be running (PID ${oldPid}) — socket probe will decide\n`)
      } catch {}
    }
  }
} catch {}

writeFileSync(PID_FILE, `${process.pid}\n`)
process.on('exit', () => { try { unlinkSync(PID_FILE) } catch {} })

import { gateway, TOKEN, PLATFORM, STATE_DIR, CLAUDE_CONFIG, SOCK_PATH, heartbeatPath } from './daemon/config.js'
import { registry, threadRegistry, sessionEmoji } from './daemon/sessions.js'
import { transport } from './daemon/bridge-transport.js'
import { loadAccess } from './daemon/access.js'
import { setupPermissionHandler } from './daemon/permission.js'
import { socketServer, startBridgeServer, initEphemeralTimers } from './daemon/bridge-server.js'
import { announceRestartComplete } from './daemon/commands/global.js'

threadRegistry.boot(registry)

// ---------------------------------------------------------------------------
// Singleton enforcement — socket probe (more reliable than PID-only check).
// Must run AFTER imports but BEFORE startBridgeServer() creates the socket.
// ---------------------------------------------------------------------------

if (existsSync(SOCK_PATH)) {
  const alive = await new Promise<boolean>(resolve => {
    const sock = connect(SOCK_PATH)
    sock.on('connect', () => { sock.end(); resolve(true) })
    sock.on('error', () => resolve(false))
    setTimeout(() => { sock.destroy(); resolve(false) }, 1000)
  })
  if (alive) {
    process.stderr.write(`daemon: another daemon is already listening on ${SOCK_PATH}. Exiting.\n`)
    process.exit(1)
  }
}

startBridgeServer()
initEphemeralTimers()


// Reconnect persisted codex sessions to their app-server sockets
import { reconnectCodexSessions } from './daemon/codex-bootstrap.js'
reconnectCodexSessions().then(() => {
  process.stderr.write('daemon: codex reconnection sweep complete\n')
}).catch(err => {
  process.stderr.write(`daemon: codex reconnection failed: ${err}\n`)
})

// Sweep orphaned factory builders left by previous daemon instance
import { sweepOrphanedBuilders } from './daemon/factory.js'
sweepOrphanedBuilders().catch(err => {
  process.stderr.write(`daemon: factory sweep failed: ${err}\n`)
})

import { logSubscriptions } from './daemon/event-bus.js'
queueMicrotask(logSubscriptions)

import { initPhaseBudgets } from './daemon/phase-budget.js'
import { killSession, discoverClaudeSessionId } from './daemon/session-lifecycle.js'
initPhaseBudgets(killSession)

import { startVitalsSnapshots } from './daemon/observability.js'
startVitalsSnapshots((id) => transport.has(id))

import { refreshDashboard, refreshDashboardNow } from './daemon/dashboard.js'
import { debouncedRefreshListDisplay } from './daemon/commands/status.js'
import { extractArtifactLinks, mergeArtifacts, sanitizeArtifacts, cachePrTitle, cacheSlackChannel, cacheSlackThread } from './daemon/artifacts.js'
registry.onPersist = refreshDashboard

if ('homeTabHandler' in gateway) {
  (gateway as any).homeTabHandler = async (_userId: string) => {
    refreshDashboardNow()
  }
}

if ('homeSpawnHandler' in gateway) {
  const { doSpawnSession } = await import('./daemon/session-lifecycle.js')
  const { parseTemplateTopic, buildTemplateSpawnOpts, runTemplateAction } = await import('./daemon/templates.js')
  const { resolveModelAlias } = await import('./shared/constants.js')
  ;(gateway as any).homeSpawnHandler = async (topic: string, userId: string) => {
    try {
      let parsed = parseTemplateTopic(topic)
      let modelOverride: string | undefined
      let engine: 'claude' | 'codex' | undefined

      // "factory sonnet: topic" — parseTemplateTopic sees "factory sonnet" as candidate, misses it.
      // Fall back: split prefix on space to find "template model: topic".
      if (!parsed) {
        const colonIdx = topic.indexOf(':')
        if (colonIdx > 0) {
          const prefix = topic.slice(0, colonIdx).trim().toLowerCase()
          const spaceIdx = prefix.indexOf(' ')
          if (spaceIdx > 0) {
            const { getTemplate } = await import('./daemon/templates.js')
            const tplName = prefix.slice(0, spaceIdx)
            const modelAlias = prefix.slice(spaceIdx + 1)
            const tpl = getTemplate(tplName)
            const resolved = resolveModelAlias(modelAlias)
            if (tpl && resolved) {
              parsed = { templateName: tplName, template: tpl, topic: topic.slice(colonIdx + 1).trim() }
              modelOverride = resolved
            }
          }
        }
      }

      let cleanTopic = parsed?.topic || topic

      // --codex flag support
      if (/\s*--codex\b/.test(cleanTopic)) {
        engine = 'codex'
        cleanTopic = cleanTopic.replace(/\s*--codex\b/, '').trim()
      }
      if (!cleanTopic.trim()) {
        const hint = parsed?.templateName ?? 'factory'
        void gateway.send(userId, `_Need a topic — e.g. \`${hint}: describe the task\`_`).catch(() => {})
        return
      }

      const spawnOpts = {
        ...(parsed && buildTemplateSpawnOpts(parsed.templateName, parsed.template, modelOverride)),
        ...(engine && { engine }),
        initiator: userId,
      }

      const result = await doSpawnSession(cleanTopic, undefined, undefined, spawnOpts)

      if (parsed) {
        const parts: string[] = [`**${parsed.templateName}** template`]
        if (modelOverride) parts.push(`model \`${modelOverride}\``)
        void gateway.send(result.threadId, `_Using ${parts.join(' · ')}_`).catch(() => {})
        if (parsed.template.action) {
          try {
            await runTemplateAction(parsed.template.action, result.threadId, result.sessionId, cleanTopic)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            void gateway.send(result.threadId, `_Action **${parsed.template.action}** failed: ${errMsg}_`).catch(() => {})
          }
        }
      }

      // Notify main bridge so the main session sees the spawn
      const mainBridge = transport.get('main')
      if (mainBridge) {
        const label = parsed?.templateName
        const labelSuffix = label ? ` (${label})` : ''
        const modelSuffix = modelOverride ? ` [${modelOverride}]` : ''
        transport.sendToBridge(mainBridge, {
          type: 'notification',
          content: `[system] Spawned ${sessionEmoji(result.name)} \`${result.name}\`${labelSuffix}${modelSuffix} for: ${cleanTopic}${result.url ? ` — ${result.url}` : ''}`,
          meta: { chat_id: 'home', message_id: '', user: 'system', user_id: userId, ts: new Date().toISOString() },
        })
      }

      process.stderr.write(`daemon: home:spawn created session ${result.name}${parsed ? ` (template: ${parsed.templateName})` : ''}\n`)
      refreshDashboardNow()
      debouncedRefreshListDisplay()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: home:spawn failed: ${errMsg}\n`)
      void gateway.send(userId, `_Spawn failed: ${errMsg}_`).catch(() => {})
    }
  }
}

// Importing router wires up gateway.onMessage / onThreadDelete / onMessageDelete
import { fetchSlackThreadSummary } from './daemon/router.js'
import { getLenses } from './daemon/lens-loader.js'
await getLenses().catch(err => process.stderr.write(`daemon: lens preload failed: ${err}\n`))
import { startPrWatcher, backfillTitles, fetchPrTitle, parsePrUrl } from './daemon/pr-watch.js'
import { handleSilenceEvent, handleActivityEvent, sessionsWithPendingReplies } from './daemon/reply-guard.js'
import { getContextPercent, tmuxHasSession } from './daemon/util.js'
import { refreshSessionVisual } from './daemon/anchor-state.js'

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
  const mcpJson = JSON.stringify({
    mcpServers: {
      discord: {
        command: 'bun',
        args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start'],
      },
    },
  }, null, 2)
  const pluginJson = JSON.stringify({
    name: 'discord',
    description: 'Discord channel for Claude Code — messaging bridge with built-in access control.',
    version: '0.0.4',
    keywords: ['discord', 'messaging', 'channel', 'mcp'],
  }, null, 2)
  const versionDirs = readdirSync(discordCache, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const d of versionDirs) {
    const targetDir = join(discordCache, d.name)
    copyFileSync(bridgeSrc, join(targetDir, 'server.ts'))
    writeFileSync(join(targetDir, `daemon-${PLATFORM}.json`), daemonConfig)
    writeFileSync(join(targetDir, '.mcp.json'), mcpJson)
    mkdirSync(join(targetDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(targetDir, '.claude-plugin', 'plugin.json'), pluginJson)
  }
  process.stderr.write(`daemon: synced bridge.ts + daemon-${PLATFORM}.json + .mcp.json into ${discordCache}/*/\n`)
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
    const { resolveDefaultChannel } = await import('./daemon/config.js')
    await resolveDefaultChannel()
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

void startGateway().then(async () => {
  if (gateway.getLastReplyId) {
    let backfilled = 0
    for (const s of registry.values()) {
      if (s.lastReplyId) continue
      try {
        const lastId = await gateway.getLastReplyId(s.threadId)
        if (lastId) { s.lastReplyId = lastId; backfilled++ }
      } catch (err) {
        process.stderr.write(`daemon: backfill failed for ${s.tmuxName} (${s.threadId}): ${err instanceof Error ? err.message : err}\n`)
      }
    }
    if (backfilled > 0) {
      registry.persist()
      process.stderr.write(`daemon: backfilled lastReplyId for ${backfilled} session(s)\n`)
    }
  }
  await backfillArtifacts()
})

// Backfill artifacts from each live session's own recent thread posts, so
// deliverables produced before this feature existed appear without waiting for a
// new reply. Idempotent (mergeArtifacts dedupes), so it's safe to run every boot.
async function backfillArtifacts(): Promise<void> {
  if (!gateway.fetchMessages) return
  let changedCount = 0
  let dirty = false
  for (const s of registry.values()) {
    if (!tmuxHasSession(s.tmuxName)) continue
    if (s.artifactsBackfilled) continue  // one-time scan — avoids a fetch-burst on every restart
    try {
      const msgs = await gateway.fetchMessages(s.threadId, 100)
      const found: string[] = []
      for (const m of msgs) {
        // Only the session's own posts (bot-authored, in its own thread) — not the human's inbound refs.
        if (gateway.botId && m.authorId !== gateway.botId) continue
        found.push(...extractArtifactLinks(m.content))
      }
      // Re-canonicalize existing entries too, so this pass also self-heals any
      // pollution captured before the extractor was tightened.
      const before = s.artifacts ?? []
      const { next } = mergeArtifacts(sanitizeArtifacts(before), found)
      if (JSON.stringify(next) !== JSON.stringify(before)) { s.artifacts = next; changedCount++ }
      s.artifactsBackfilled = true
      dirty = true
    } catch (err) {
      // Leave the flag unset so a transient fetch failure retries next boot.
      process.stderr.write(`daemon: artifact backfill failed for ${s.tmuxName}: ${err instanceof Error ? err.message : err}\n`)
    }
  }
  if (dirty) registry.persist()
  if (changedCount > 0) {
    refreshDashboardNow()
    process.stderr.write(`daemon: backfilled artifacts for ${changedCount} session(s)\n`)
  }
}

// ---------------------------------------------------------------------------
// PR watcher — polls GitHub for new PR comments/reviews
// ---------------------------------------------------------------------------

startPrWatcher()

// Reply guard: polls window_activity timestamp every 20s (see below).

// Backfill PR titles for existing watches (non-blocking)
backfillTitles().then(n => {
  if (n > 0) {
    process.stderr.write(`daemon: backfilled ${n} PR title(s)\n`)
    refreshDashboardNow()
  }
}).catch(err => process.stderr.write(`daemon: PR title backfill failed: ${err}\n`))

// Backfill PR titles for artifact links (non-blocking)
void (async () => {
  let filled = 0
  for (const s of registry.values()) {
    for (const url of s.artifacts ?? []) {
      if (!parsePrUrl(url)) continue
      try {
        const title = await fetchPrTitle(url)
        if (title) { cachePrTitle(url, title); filled++ }
      } catch {}
    }
  }
  if (filled > 0) {
    refreshDashboardNow()
    process.stderr.write(`daemon: backfilled ${filled} artifact PR title(s)\n`)
  }
})().catch(err => process.stderr.write(`daemon: artifact title backfill failed: ${err}\n`))

// Backfill Slack channel names + thread summaries for context links (non-blocking)
void (async () => {
  const channelIds = new Set<string>()
  const threadUrls: string[] = []
  for (const s of registry.values()) {
    for (const url of s.contextLinks ?? []) {
      const m = url.match(/slack\.com\/archives\/([A-Z0-9]+)/)
      if (m) { channelIds.add(m[1]); threadUrls.push(url) }
    }
  }
  let filled = 0
  for (const id of channelIds) {
    try {
      const ch = await gateway.fetchChannel(id)
      if (ch.name) { cacheSlackChannel(id, ch.name); filled++ }
    } catch {}
  }
  for (const url of threadUrls) {
    try {
      const summary = await fetchSlackThreadSummary(url)
      if (summary) { cacheSlackThread(url, summary); filled++ }
    } catch {}
  }
  if (filled > 0) {
    refreshDashboardNow()
    process.stderr.write(`daemon: backfilled ${filled} Slack context link(s)\n`)
  }
})().catch(err => process.stderr.write(`daemon: Slack context backfill failed: ${err}\n`))

// ---------------------------------------------------------------------------
// Session health — crash detection + context alerts (every 5 min)
// ---------------------------------------------------------------------------

const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000
const SPAWN_GRACE_MS = 60_000
const ORPHAN_GRACE_MS = 90_000
const CONTEXT_ALERT_THRESHOLD = 70
const contextAlerted = new Set<string>()
const crashAlerted = new Set<string>()
const orphanAlerted = new Set<string>()

setInterval(() => {
  const now = Date.now()
  for (const info of registry.values()) {
    // Crash detection — both tmux AND bridge must be gone. Bridge-only disconnects are handled
    // by the bridge-server disconnect handler (3s delay + tmux check). Skip sessions in spawn
    // grace period (bridge needs time to connect).
    if (!crashAlerted.has(info.sessionId) && !info.isJoinMember && !info.deadAt && (now - info.createdAt > SPAWN_GRACE_MS) && !tmuxHasSession(info.tmuxName) && !transport.has(info.sessionId)) {
      crashAlerted.add(info.sessionId)
      info.deadAt = now
      registry.persist()
      const thread = threadRegistry.get(info.threadId)
      if (thread) {
        const histEntry = thread.sessionHistory.find((h: any) => h.sessionId === info.sessionId && !h.endedAt)
        if (histEntry) {
          histEntry.endedAt = now
          histEntry.messageCount = info.messageCount ?? 0
          histEntry.claudeSessionId = info.claudeSessionId
        }
        threadRegistry.persist()
      }
      process.stderr.write(`daemon: crash detected: ${info.tmuxName}\n`)
      void gateway.send(info.threadId, `💀 **${info.tmuxName}** died. Use \`resume\` to restore context or \`respawn\` for a fresh start.`).catch(() => {})
      refreshSessionVisual(info.threadId, { state: 'crashed' })
      continue
    }

    // Orphan detection — tmux alive but bridge never connected past grace window.
    // Discovery retries every poll (claudeSessionId may become available later).
    // Alert fires once per orphan episode; clears when bridge reconnects.
    if (!info.isJoinMember && !info.deadAt && !info.headless && (now - info.createdAt > ORPHAN_GRACE_MS) && tmuxHasSession(info.tmuxName) && !transport.has(info.sessionId)) {
      if (!info.claudeSessionId && info.engine !== 'codex') {
        const discovered = discoverClaudeSessionId(info.tmuxName)
        if (discovered) {
          info.claudeSessionId = discovered
          registry.persist()
          const thread = threadRegistry.get(info.threadId)
          if (thread) {
            const histEntry = thread.sessionHistory.find((h: any) => h.sessionId === info.sessionId && !h.endedAt)
            if (histEntry) histEntry.claudeSessionId = discovered
            threadRegistry.persist()
          }
          process.stderr.write(`daemon: orphan ${info.tmuxName}: discovered claudeSessionId=${discovered}\n`)
        }
      }
      if (!orphanAlerted.has(info.sessionId)) {
        orphanAlerted.add(info.sessionId)
        process.stderr.write(`daemon: orphan detected: ${info.tmuxName} (tmux alive, bridge disconnected for ${Math.round((now - info.createdAt) / 1000)}s)\n`)
        void gateway.send(info.threadId, `⚠️ **${info.tmuxName}** is running but its bridge isn't connected — replies can't reach this thread. Use \`respawn\` to start fresh.`).catch(() => {})
      }
    } else {
      orphanAlerted.delete(info.sessionId)
    }

    // Context alert
    const pct = getContextPercent(info.tmuxName)
    if (pct === '?') continue
    const num = parseInt(pct)
    if (num >= CONTEXT_ALERT_THRESHOLD && !contextAlerted.has(info.sessionId)) {
      contextAlerted.add(info.sessionId)
      process.stderr.write(`daemon: context alert: ${info.tmuxName} at ${pct}\n`)
      void gateway.send(info.threadId, `**${info.tmuxName}** is at **${pct}** context. Consider \`respawn\` to continue in a fresh session.`).catch(() => {})
    }


  }
}, SESSION_CHECK_INTERVAL_MS)

// Reply guard: poll window_activity timestamp every 20s.
// Only checks sessions with pending replies — O(pending) not O(sessions).
const MIN_IDLE_BEFORE_NUDGE_S = 45
setInterval(() => {
  const pendingNames = sessionsWithPendingReplies()
  if (pendingNames.size === 0) return
  const nowSec = Math.floor(Date.now() / 1000)
  for (const tmuxName of pendingNames) {
    const info = tmuxName === 'main' ? undefined : registry.findByName(tmuxName)
    let lastActivitySec = 0
    try {
      lastActivitySec = parseInt(
        execSync(`tmux display -t '${tmuxName}' -p '#{window_activity}'`, { stdio: 'pipe', timeout: 2000 }).toString().trim(),
      ) || 0
    } catch { continue }
    const secSinceActivity = nowSec - lastActivitySec
    if (secSinceActivity < MIN_IDLE_BEFORE_NUDGE_S) {
      if (info && info.turnState !== 'working') info.turnState = 'working'
      handleActivityEvent(tmuxName)
    } else {
      if (info && info.turnState !== 'idle') info.turnState = 'idle'
      handleSilenceEvent(tmuxName)
    }
  }
}, 20_000)

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  registry.persist()
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
