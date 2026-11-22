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
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { connect } from 'net'
import { bootRefusal, BOOT_REFUSED_FILE } from './infra/migrate.js'

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

// ---------------------------------------------------------------------------
// hydra.toml beside the old state it replaces: refuse before anything connects, and say why where the watchdog,
// `hydra health` and the daemon log will show it (a daemon that never connects can't reach chat).
// ---------------------------------------------------------------------------

{
  const refused = bootRefusal(STATE_DIR_EARLY)
  const marker = join(STATE_DIR_EARLY, BOOT_REFUSED_FILE)
  if (refused) {
    process.stderr.write(`daemon: ${refused}\n`)
    try { writeFileSync(marker, JSON.stringify({ reason: refused, at: Math.floor(Date.now() / 1000) }) + '\n') } catch {}
    process.exit(78) // EX_CONFIG
  }
  try { unlinkSync(marker) } catch {}
}

// DEFAULT_SESSION_CHANNEL is a live binding: resolveDefaultChannel fills it after boot.
import { gateway, TOKEN, PLATFORM, STATE_DIR, CLAUDE_CONFIG, SOCK_PATH, heartbeatPath, DEFAULT_SESSION_CHANNEL, resolveDefaultChannel } from './infra/config.js'
import { syncMods } from './infra/mods.js'
import { syncDaemonBridge } from './engines/bridge-sync.js'
import { registry, threadRegistry, reattachAdapters, engineRecords } from './sessions/registry.js'
import { isPlainWorker } from './shared/policy-record.js'
import { emojiOfName } from './sessions/anchor-state.js'
import { engines, resolveEngine } from './sessions/engine-instances.js'
import { transport } from './sessions/bridge-transport.js'
import { operatorIds, notifyOperator } from './sessions/access.js'
import { setupPermissionHandler } from './app/permission.js'
import { socketServer, startBridgeServer } from './app/bridge-server.js'
import { announceRestartComplete } from './app/commands/global.js'
import { deliverWatchdogAlert } from './app/watchdog-alert.js'
import { autoRecoverAfterBoot } from './app/recovery.js'
import { startJobsClock, stopJobsClock, realDeps } from './connectors/clock/jobs-clock.js'
import { deliverToTarget, targetDeps } from './specialists/targets.js'

threadRegistry.boot(registry)
reattachAdapters(resolveEngine)
for (const info of registry.values()) {
  if (!info.adapter) throw new Error(`boot: session ${info.sessionId} (${info.tmuxName}) has no adapter after reattach`)
}

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

// The pid file is written only here, once no other daemon is running, and removed on exit only
// while it still holds this daemon's pid. A second daemon used to write it at startup, find the
// first one running, exit, and delete the running daemon's file on the way out.
writeFileSync(PID_FILE, `${process.pid}\n`)
process.on('exit', () => {
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE) } catch {}
})

transport.restorePersistedQueues()
startBridgeServer()

// Start each engine over its persisted records (Codex reconnects its sessions to
// their app-server sockets). Not awaited; each start logs its own outcome.
for (const adapter of Object.values(engines)) {
  adapter.start(engineRecords(adapter)).catch(err => {
    process.stderr.write(`daemon: ${adapter.provider} start failed: ${err}\n`)
  })
}

import { logSubscriptions, emit } from './infra/event-bus.js'
queueMicrotask(logSubscriptions)

import { initPhaseBudgets } from './sessions/phase-budget.js'
import { initIdleLimits } from './sessions/idle-limit.js'
import { killSession, backfillAnchorChannelIds, doSpawnSession } from './app/session-lifecycle.js'
import { runHomeStatusAction } from './app/home-actions.js'
import { parseTemplateTopic, buildTemplateSpawnOpts, runTemplateAction, getTemplate } from './app/templates.js'
import { resolveModelAlias } from './shared/constants.js'
initPhaseBudgets((info, reason) => killSession(info, reason, { ended: 'killed by hydra' }))
initIdleLimits((info, reason, opts) => killSession(info, reason, { ...opts, ended: 'killed by hydra' }))

backfillAnchorChannelIds().catch(err => {
  process.stderr.write(`daemon: anchorChannelId backfill failed: ${err}\n`)
})

import { startLoopWatch, timed, pendingGap, heldNotAsleep } from './shared/loop-watch.js'
import { createResumeDetector, installResumeDetector } from './shared/resume.js'
import { sysctlLastSleep } from './infra/last-sleep.js'
// The loop watch hands each unexplained gap to the resume detector, which every age-based alarm reads; a gap the OS
// says was no sleep comes back to the watch as a stall, alerted under its limit.
const resumes = createResumeDetector({ lastSleep: sysctlLastSleep, pendingGap, onStalled: heldNotAsleep })
installResumeDetector(resumes)
startLoopWatch({ alert: notifyOperator, onResume: (gapMs, at, servedAt) => { resumes.noteResume(gapMs, at, servedAt); emit('clock:resumed', { at, gapMs }) } })

import { startVitalsSnapshots } from './sessions/observability.js'
startVitalsSnapshots((id) => transport.has(id), { alert: notifyOperator })

import { refreshDashboard, refreshDashboardNow } from './app/dashboard.js'
import { debouncedRefreshListDisplay } from './app/commands/status.js'
import { extractArtifactLinks, mergeArtifacts, sanitizeArtifacts, cachePrTitle } from './infra/artifacts.js'
import type { ProviderId } from './engines/engine-adapter.js'
registry.onPersist = refreshDashboard
targetDeps.stuckState = confirmedStuckState

if ('operators' in gateway) {
  (gateway as any).operators = operatorIds
}
if ('homeTabHandler' in gateway) {
  (gateway as any).homeTabHandler = async (_userId: string) => {
    refreshDashboardNow()
  }
}

if ('homeStatusHandler' in gateway) {
  ;(gateway as any).homeStatusHandler = runHomeStatusAction
}

if ('homeSpawnHandler' in gateway) {
  ;(gateway as any).homeSpawnHandler = async (topic: string, userId: string) => {
    try {
      let parsed = parseTemplateTopic(topic)
      let modelOverride: string | undefined
      let engine: ProviderId | undefined

      // "review sonnet: topic" — parseTemplateTopic sees "review sonnet" as candidate, misses it.
      // Fall back: split prefix on space to find "template model: topic".
      if (!parsed) {
        const colonIdx = topic.indexOf(':')
        if (colonIdx > 0) {
          const prefix = topic.slice(0, colonIdx).trim().toLowerCase()
          const spaceIdx = prefix.indexOf(' ')
          if (spaceIdx > 0) {
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
        const hint = parsed?.templateName ?? 'review'
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
          content: `[system] Spawned ${emojiOfName(result.name)} \`${result.name}\`${labelSuffix}${modelSuffix} for: ${cleanTopic}${result.url ? ` — ${result.url}` : ''}`,
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
import { warmContextLink } from './app/router.js'
import { restoreHeld } from './app/specialist-thread.js'
import { startPrWatcher, backfillTitles, fetchPrTitle, parsePrUrl } from './connectors/github/pr-watch.js'
import { startConversationTable, stopConversationTable, startSlackListener } from './connectors/slack/runtime.js'
import { pruneEvents } from './infra/events.js'
import { startHydraConfig, stopHydraConfig, retryHydraConfigAlert, currentHydraConfig, onHydraConfigLoad, reloadHydraConfig, hydraConfigLoadedOk } from './infra/hydra-config.js'
import { jobsFromSchedules } from './shared/schedules.js'
import { schedulesAreSource } from './infra/schedule-source.js'
import { readDaemonState } from './infra/job-files.js'
import { pollActivityOnce } from './app/reply-guard.js'
import { flushAllHeld } from './app/typed-delivery.js'
import { probeAllSessions, mainStuckCause, confirmedStuckState } from './app/pane-probe.js'
import { safeSend } from './infra/util.js'
import { tmuxHasSession } from './infra/tmux.js'

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
  for (const userId of operatorIds()) {
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
// Mods — copy mod/ and mods.local/* where every session loads them (infra/mods.ts)
// ---------------------------------------------------------------------------

process.stderr.write(`daemon: synced mods into ${STATE_DIR}/mods: ${syncMods(import.meta.dir, STATE_DIR).join(', ')}\n`)

// ---------------------------------------------------------------------------
// Bridge sync — keep plugin cache in sync with repo bridge.ts
// ---------------------------------------------------------------------------

try {
  // Not awaiting `ready`: boot never waits on the registry. A spawn awaits it (claude-engine.ts).
  const { dirs, relinked } = syncDaemonBridge()
  process.stderr.write(`daemon: synced the bridge plugin in ${dirs.length} version dir(s)${relinked.length ? `; relinked server.ts in ${relinked.join(', ')}` : ''}\n`)
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
    await resolveDefaultChannel(operatorIds())
    void announceRestartComplete()
    void deliverWatchdogAlert()
    void retryHydraConfigAlert()
    // Send the standalone recovery report only if auto-recovery won't run —
    // otherwise the gap info is folded into the auto-recovery summary (which
    // fires ~30s later) and the standalone report would mislead with "N disconnected"
    // right before auto-recovery fixes them.
    if (startupGapMs !== null) {
      const hasDeadWorkers = [...registry.values()].some(s => !!s.deadAt && isPlainWorker(s))
      if (!hasDeadWorkers || (process.env.HYDRA_AUTO_RECOVER || '') !== '1') {
        sendRecoveryReport(startupGapMs)
      }
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
  // Opt-in (HYDRA_AUTO_RECOVER=1): revive dead workers after a reboot. Runs after
  // the gateway is up (respawns post to their threads). No-op otherwise.
  await autoRecoverAfterBoot(startupGapMs ?? undefined).catch(err =>
    process.stderr.write(`daemon: auto-recovery failed: ${err instanceof Error ? err.message : err}\n`),
  )
  // After recovery, so a specialist refill never races it: answers held for a specialist when the daemon last stopped.
  restoreHeld()
  // After recovery, so a specialist refill never races it. Never throws, never blocks the boot.
  void startSlackListener().catch(err =>
    process.stderr.write(`daemon: slack connector failed to start: ${err instanceof Error ? err.message : err}\n`),
  )
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

startHydraConfig({ alert: notifyOperator })
startPrWatcher({
  deliver: deliverToTarget,
  // A merged or closed PR leaves every session's artifact list and the home tab.
  onWatchRemoved: entry => { registry.dropArtifact(entry.prUrl); refreshDashboard() },
})
startConversationTable()
pruneEvents()

// Reply guard: polls session activity every 20s (see below).

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
  let filled = 0
  for (const s of registry.values()) for (const url of s.contextLinks ?? []) filled += await warmContextLink(url)
  if (filled > 0) {
    refreshDashboardNow()
    process.stderr.write(`daemon: backfilled ${filled} Slack context link(s)\n`)
  }
})().catch(err => process.stderr.write(`daemon: Slack context backfill failed: ${err}\n`))

// ---------------------------------------------------------------------------
// Session health — crash detection, orphan detection, context alerts
// ---------------------------------------------------------------------------

import { startSessionHealthPoll } from './app/session-health.js'
startSessionHealthPoll()

// Reply guard: poll session activity every 20s (see pollActivityOnce). The same tick releases
// typed-delivery messages held for an idle session (app/typed-delivery.ts): no timer of its own.
setInterval(() => timed('reply-guard', () => {
  pollActivityOnce(Math.floor(Date.now() / 1000))
  void flushAllHeld()
}), 20_000)

// Pane probe: detect CC sessions stuck on interactive prompts (plan mode, login).
// Lower cadence than reply guard — these stalls are minutes-scale.
setInterval(() => timed('pane-probe', () => { probeAllSessions().catch(err => process.stderr.write(`daemon: pane-probe error: ${err}\n`)) }), 60_000)

// Jobs clock: runs jobs.toml's jobs, or once migrate has moved them, hydra.toml's [schedules], as detached attempts and
// applies their results (connectors/clock/jobs-clock.ts). A job's failure goes to its `to` target, then main; a schedule's to its `target`, then main;
// if neither can take one, straight to a channel. A main stuck on a prompt is told and the channel hears it too, with the cause.
startJobsClock(realDeps({
  stateDir: STATE_DIR,
  platform: PLATFORM,
  hydraEntry: join(import.meta.dir, 'cli', 'hydra.ts'),
  toMain: (text, initiator) => {
    if (!transport.has('main')) return false
    transport.sendOrQueue('main', { type: 'notification', content: text, meta: { source: 'jobs', initiator } })
    return true
  },
  mainStuck: mainStuckCause,
  toTarget: async (to, text, initiator) => (await deliverToTarget({ to }, text, { initiator, queue: true })).ok,
  schedules: () => jobsFromSchedules(currentHydraConfig()),
  reloadSchedules: reloadHydraConfig,
  schedulesLoadedOk: hydraConfigLoadedOk,
  // The clock resolves job channel → top-level channel → home channel; this only sends.
  direct: async (text, channel) => {
    if (!channel) { process.stderr.write(`daemon: jobs alert has no channel: ${text}\n`); return false }
    return (await safeSend(channel, text)).length > 0
  },
  homeChannel: () => DEFAULT_SESSION_CHANNEL || undefined,
  gatewayConnected: () => gateway.isConnected(),
}))
// An edited [schedules] re-registers its launchd entries: `schedules sync` asks this daemon for them, and its reload
// finds the file unchanged, so it can't come back here.
onHydraConfigLoad(() => {
  if (!schedulesAreSource(STATE_DIR, readDaemonState(STATE_DIR).state)) return
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'cli', 'hydra.ts'), '--state-dir', STATE_DIR, 'schedules', 'sync', PLATFORM], { stdout: 'ignore', stderr: 'pipe' })
  void p.exited.then(async code => { if (code) process.stderr.write(`daemon: schedules sync after a hydra.toml change exited ${code}: ${(await new Response(p.stderr).text()).trim().slice(-300)}\n`) })
})

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  stopConversationTable()
  stopJobsClock()
  stopHydraConfig()
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
