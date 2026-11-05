import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, isAlive } from './util.js'
import { parseIdleTtl, DELIVER_MAX_MESSAGE_BYTES } from '../shared/constants.js'
import { formatContextPercent, type DeliveryResult } from './engines/engine-adapter.js'
import { existsSync } from 'fs'
import { checkIdempotency, registerIdempotency, updateIdempotency, getBySessionId, clearIdempotency, listIdempotencyEntries, DELIVER_IDEMPOTENCY_TTL_MS } from './idempotency.js'
import { deliveryOutcome } from './delivery-outcome.js'
import { deliverToSpecialist, spawnSpecialist, specialistStatus, SpecialistError } from './specialist-deliver.js'
import { getSpecialist, listSpecialists, removeSpecialist, setSpecialist, type Specialist } from './specialists.js'
import { getSlackWatcher, slackWatchHealth, slackWatchChannels, refreshSlackSpecialistSurface, formatSlackWatches } from './slack-watch-runtime.js'
import { ORPHAN_GRACE_MS, bridgeWaitMs } from './session-reachability.js'
import { gateway } from './config.js'
import { loadAccess } from './access.js'
import { on } from './event-bus.js'
import { raindropStatusLine } from './raindrop.js'

// ---------------------------------------------------------------------------
// Idempotency completion on session death
// ---------------------------------------------------------------------------

on('session:death', ({ sessionId }) => {
  const idemEntry = getBySessionId(sessionId)
  if (idemEntry) {
    updateIdempotency(idemEntry.key, { status: 'completed' })
    process.stderr.write(`daemon: cli idempotency key "${idemEntry.key}" → completed (session ${sessionId} died)\n`)
  }
}, 'cli:idempotency-completion')

// ---------------------------------------------------------------------------
// CLI request/response types
// ---------------------------------------------------------------------------

export type CLIRequest = {
  type: 'cli'
  command: string
  id: string
  params: Record<string, unknown>
}

export type CLIResponse = {
  type: 'cli-response'
  command: string
  id: string
  ok: boolean
  data?: unknown
  error?: string
  exitCode?: number
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function respond(req: CLIRequest, ok: true, data?: unknown): CLIResponse
function respond(req: CLIRequest, ok: false, error: string, data?: unknown, exitCode?: number): CLIResponse
function respond(req: CLIRequest, ok: boolean, dataOrError?: unknown, maybeData?: unknown, exitCode?: number): CLIResponse {
  if (ok) {
    return { type: 'cli-response', command: req.command, id: req.id, ok: true, data: dataOrError }
  }
  return {
    type: 'cli-response', command: req.command, id: req.id, ok: false,
    error: dataOrError as string,
    ...(maybeData !== undefined ? { data: maybeData } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSpawn(req: CLIRequest): Promise<CLIResponse> {
  const { prompt, initiator, idempotencyKey, channel, message, ephemeral, idleTtl, forceWorktreeCleanup, quiet, model, specialist } = req.params as {
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
  }

  if (specialist) {
    // The declaration is the recipe: its kickoff is the prompt, and its channel and model are the spawn's.
    const given = Object.entries({ prompt, channel, message, model, ephemeral, idleTtl, forceWorktreeCleanup }).filter(([, v]) => v !== undefined && v !== false).map(([k]) => k)
    if (given.length) return respond(req, false, `--specialist takes the prompt, channel and model from the specialist's declaration; remove: ${given.join(', ')}`)
  } else if (!prompt) return respond(req, false, 'prompt is required')
  let idleTtlMs: number | undefined
  if (idleTtl !== undefined) {
    if (!ephemeral) return respond(req, false, '--idle-ttl only applies to --ephemeral spawns')
    idleTtlMs = parseIdleTtl(idleTtl) ?? undefined
    if (!idleTtlMs) return respond(req, false, `--idle-ttl "${idleTtl}" is not a duration like 90m, 12h or 4d (max 7d)`)
  }
  if (!idempotencyKey) return respond(req, false, 'idempotency-key is required')
  if (!initiator) return respond(req, false, 'initiator is required')

  const check = checkIdempotency(idempotencyKey)
  if (check.blocked) {
    return respond(req, false,
      `idempotency key "${idempotencyKey}" already exists (status: ${check.entry.status}, session: ${check.entry.sessionId})`,
      { existing: check.entry },
      2,
    )
  }
  registerIdempotency(idempotencyKey, '', undefined, 'pending')

  let result
  try {
    if (specialist) {
      const filled = await spawnSpecialist(specialist, initiator)
      result = { sessionId: filled.info.sessionId, name: filled.info.tmuxName, threadId: filled.info.threadId, url: filled.url }
    } else {
      result = await doSpawnSession(prompt!, channel ?? undefined, message ?? undefined, { initiator, model, ephemeral, idleTtlMs, forceWorktreeCleanup: forceWorktreeCleanup === true, trigger: 'CLI' })
    }
  } catch (err) {
    if (!(err instanceof SpecialistError && err.sessionId)) updateIdempotency(idempotencyKey, { status: 'failed' })
    if (err instanceof SpecialistError) {
      // A session that did start (a re-point during the spawn) keeps the key, so a retry is blocked.
      if (err.sessionId) updateIdempotency(idempotencyKey, { status: 'spawned', sessionId: err.sessionId })
      return respond(req, false, err.message, undefined, err.exitCode)
    }
    throw err
  }

  updateIdempotency(idempotencyKey, { status: 'spawned', sessionId: result.sessionId })

  if (!quiet) {
    const access = loadAccess()
    if (access.allowFrom.length > 0) {
      const mentions = access.allowFrom.map(id => `<@${id}>`).join(' ')
      void gateway.send(result.threadId, `${mentions} spawned via CLI by **${initiator}**`).catch(() => {})
    }
  }

  return respond(req, true, {
    sessionId: result.sessionId,
    name: result.name,
    threadId: result.threadId,
    url: result.url,
    idempotencyKey,
  })
}

function handleList(req: CLIRequest): CLIResponse {
  const sorted = [...registry.values()].sort((a, b) => b.lastActive - a.lastActive)
  const list = sorted.map(s => ({
    name: s.tmuxName,
    sessionId: s.sessionId,
    threadId: s.threadId,
    description: s.description ?? (s.topic ? fallbackDescription(s.topic) : ''),
    url: (s.lastReplyId ? gateway.getMessageUrl(s.threadId, s.lastReplyId) : '') || s.threadUrl || '',
    context: formatContextPercent(s.adapter, s),
    running_for: formatDuration(Date.now() - s.createdAt),
    status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
    ...(s.initiator && { initiator: s.initiator }),
  }))
  return respond(req, true, list)
}

function handleStatus(req: CLIRequest): CLIResponse {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return respond(req, false, `session "${name}" not found`)

  const tmuxAlive = (() => {
    try {
      const result = Bun.spawnSync(['tmux', 'has-session', '-t', info.tmuxName], { stdio: ['pipe', 'pipe', 'pipe'] })
      return result.exitCode === 0
    } catch { return false }
  })()

  return respond(req, true, {
    name: info.tmuxName,
    sessionId: info.sessionId,
    topic: info.topic,
    description: info.description,
    threadId: info.threadId,
    url: info.threadUrl,
    context: formatContextPercent(info.adapter, info),
    running_for: formatDuration(Date.now() - info.createdAt),
    bridge: transport.has(info.sessionId) ? 'connected' : 'disconnected',
    tmux: tmuxAlive ? 'alive' : 'dead',
    origin: info.originType,
    // Only `hydra attach` asks: surface() may recreate tmux and relaunch the Codex TUI.
    attachTarget: (req.params as { attach?: unknown }).attach === true ? info.adapter.surface(info) : undefined,
  })
}

async function handleKill(req: CLIRequest): Promise<CLIResponse> {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = [...registry.values()].find(s => s.tmuxName === name || s.sessionId === name)
  if (!info) return respond(req, false, `session "${name}" not found`)

  // Capture key before kill — getBySessionId only finds spawned/pending,
  // and the death handler will set it to completed during killSession
  const idemKey = getBySessionId(info.sessionId)?.key

  await killSession(info, 'killed via CLI')

  // Overwrite to failed AFTER death handler set completed — unblocks retry
  if (idemKey) {
    updateIdempotency(idemKey, { status: 'failed' })
  }

  return respond(req, true, { killed: info.tmuxName })
}

function handleHealth(req: CLIRequest): CLIResponse {
  const sessions = [...registry.values()]
  const connected = sessions.filter(s => transport.has(s.sessionId)).length
  const disconnected = sessions.length - connected

  let tmuxRunning = false
  try {
    const result = Bun.spawnSync(['tmux', 'list-sessions'], { stdio: ['pipe', 'pipe', 'pipe'] })
    tmuxRunning = result.exitCode === 0
  } catch {}

  const raindropLine = raindropStatusLine('cli')
  return respond(req, true, {
    sessions: { total: sessions.length, connected, disconnected },
    tmux: tmuxRunning ? 'running' : 'not running',
    idempotency: { active: listIdempotencyEntries().length },
    ...(raindropLine ? { raindrop: raindropLine } : {}),
    ...(slackWatchHealth() ? { slackWatch: slackWatchHealth() } : {}),
  })
}

function handleClearKey(req: CLIRequest): CLIResponse {
  const { key } = req.params as { key?: string }
  if (!key) return respond(req, false, 'key is required')
  const cleared = clearIdempotency(key)
  if (!cleared) return respond(req, false, `key "${key}" not found`)
  return respond(req, true, { cleared: key })
}

function handleCheckKey(req: CLIRequest): CLIResponse {
  const { key } = req.params as { key?: string }
  if (!key) return respond(req, false, 'key is required')
  const entries = listIdempotencyEntries()
  const entry = entries.find(e => e.key === key)
  if (!entry) return respond(req, true, { key, status: 'not_found' })
  return respond(req, true, { key, status: entry.status, sessionId: entry.sessionId })
}

// ---------------------------------------------------------------------------
// Deliver — whisper channel: message to session context, not thread
// ---------------------------------------------------------------------------


async function handleDeliver(req: CLIRequest): Promise<CLIResponse> {
  const { thread, session, specialist, message, initiator, idempotencyKey, queue } = req.params as {
    thread?: string
    session?: string
    specialist?: string
    message?: string
    initiator?: string
    idempotencyKey?: string
    queue?: boolean
  }

  if (!message) return respond(req, false, 'message is required')
  if (Buffer.byteLength(message) > DELIVER_MAX_MESSAGE_BYTES) {
    return respond(req, false, `message too large (${Buffer.byteLength(message)} bytes, max ${DELIVER_MAX_MESSAGE_BYTES})`)
  }
  if (!thread && !session && !specialist) return respond(req, false, '--thread, --session or --specialist is required')
  if (specialist && (thread || session)) return respond(req, false, '--specialist is its own address: drop --thread/--session')

  if (idempotencyKey) {
    const check = checkIdempotency(idempotencyKey)
    // Exit 7: a delivery with this key is still awaiting its adapter — retry once
    // it settles (it then answers 2 if it landed, or proceeds if it failed).
    if (check.blocked && check.entry.status === 'pending') {
      return respond(req, false, `delivery with key "${idempotencyKey}" still in flight — retry shortly`, { existing: check.entry }, 7)
    }
    if (check.blocked) {
      return respond(req, false, `already delivered with key "${idempotencyKey}"`, { existing: check.entry }, 2)
    }
  }

  if (specialist) {
    const r = await deliverToSpecialist({ specialist, message, initiator, idempotencyKey })
    return r.ok ? respond(req, true, r.data) : respond(req, false, r.error, r.data, r.exitCode)
  }

  // 'main' (the platform's byte session) has no registry record; it's reached by its bridge id.
  if (session === 'main') {
    const connected = transport.has('main')
    if (!connected && !queue) return respond(req, false, 'main not connected — use --queue to queue for later', undefined, 4)
    const meta: Record<string, string> = { source: 'cli-deliver', ...(initiator && { initiator }) }
    transport.sendOrQueue('main', { type: 'notification', content: message, meta })
    if (idempotencyKey) registerIdempotency(idempotencyKey, 'main', DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
    return respond(req, true, { status: connected ? 'delivered' : 'queued', sessionId: 'main', sessionName: 'main' })
  }

  let info = session
    ? [...registry.values()].find(s => s.tmuxName === session || s.sessionId === session)
    : undefined

  if (thread && !info) {
    const sessionId = registry.getByThread(thread)
    if (sessionId) info = registry.get(sessionId)
  }

  if (thread && session && info && info.threadId !== thread) {
    return respond(req, false, `session "${session}" is in thread ${info.threadId}, not ${thread}`)
  }

  if (!info && thread) {
    const threadMeta = threadRegistry.get(thread)
    if (threadMeta) {
      return respond(req, false, 'session gone — use \'hydra spawn\' to create a new session in this thread, or \'resume\'/\'respawn\' in chat', undefined, 3)
    }
  }

  if (!info) return respond(req, false, `${thread ? 'thread' : 'session'} "${thread ?? session}" not found`)

  const executionAlive = isAlive(info)
  const bridgeConnected = transport.has(info.sessionId)

  if (!executionAlive) {
    return respond(req, false, 'session gone — use \'hydra spawn\' to create a new session, or \'resume\'/\'respawn\' in chat', undefined, 3)
  }
  if (!bridgeConnected && !queue) {
    const waitMs = bridgeWaitMs(info.createdAt)
    if (waitMs < ORPHAN_GRACE_MS) {
      return respond(req, false, `session still booting — retry in ~${Math.ceil((ORPHAN_GRACE_MS - waitMs) / 1000)}s`, undefined, 5)
    }
    return respond(req, false, 'session orphaned (tmux alive, bridge disconnected) — try \'resume\' in the thread, or use --queue to queue for later', undefined, 4)
  }

  const meta: Record<string, string> = { source: 'cli-deliver' }
  if (initiator) meta.initiator = initiator

  const notification = { type: 'notification' as const, content: message, meta }

  // Both engines deliver through their adapter. Reserve the key just before the
  // await so a concurrent retry is blocked; only an accepted delivery keeps it.
  // Reserved without the sessionId so the session's death/kill bookkeeping
  // (getBySessionId) can't pick up an in-flight deliver key.
  if (idempotencyKey) registerIdempotency(idempotencyKey, '', DELIVER_IDEMPOTENCY_TTL_MS, 'pending')
  let result: DeliveryResult
  try {
    result = await info.adapter.deliver(info, notification)
  } catch (err) {
    result = { status: 'unknown', reason: String(err) }
  }

  const outcome = deliveryOutcome(result, !!queue && !bridgeConnected)
  if (!outcome.ok) {
    if (idempotencyKey) clearIdempotency(idempotencyKey)
    return respond(req, false, outcome.error, undefined, outcome.exitCode)
  }

  if (idempotencyKey) registerIdempotency(idempotencyKey, info.sessionId, DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
  return respond(req, true, {
    status: outcome.status,
    proof: outcome.proof,
    sessionId: info.sessionId,
    sessionName: info.tmuxName,
    threadId: info.threadId,
  })
}

// ---------------------------------------------------------------------------
// Specialists — named, refillable addresses (see specialists.ts)
// ---------------------------------------------------------------------------

async function handleSpecialist(req: CLIRequest): Promise<CLIResponse> {
  const p = req.params as { action?: string; name?: string; thread?: string; channel?: string; kickoff?: string; kickoffFile?: string; model?: string }
  const view = (name: string, s: Specialist) => ({ name, ...s, ...specialistStatus(name) })
  switch (p.action) {
    case 'list': return respond(req, true, listSpecialists().map(([name, s]) => view(name, s)))
    case 'show': {
      const s = p.name ? getSpecialist(p.name) : undefined
      return s ? respond(req, true, view(p.name!, s)) : respond(req, false, `specialist "${p.name ?? ''}" not found`)
    }
    case 'rm': {
      if (!p.name || !removeSpecialist(p.name)) return respond(req, false, `specialist "${p.name ?? ''}" not found`)
      refreshSlackSpecialistSurface() // its occupant loses the Slack-watch tools
      return respond(req, true, { removed: p.name })
    }
    case 'set': {
      if (!p.name) return respond(req, false, 'specialist name is required')
      const existing = getSpecialist(p.name)
      const threadId = p.thread ?? existing?.threadId
      if (!threadId && !(p.channel ?? existing?.channel)) return respond(req, false, '--channel (where to open its thread) or --thread is required for a new specialist')
      if (p.kickoffFile && !existsSync(p.kickoffFile)) return respond(req, false, `kickoff file not found: ${p.kickoffFile}`)
      // Fields not passed keep their current value, so re-pointing a specialist's thread leaves its kickoff alone.
      const { updatedAt: _t, ...rest } = existing ?? { updatedAt: 0 }
      const specialist = setSpecialist(p.name, {
        ...rest,
        ...(threadId && { threadId }),
        ...(p.channel && { channel: p.channel }),
        ...(p.kickoff && { kickoff: p.kickoff }),
        ...(p.kickoffFile && { kickoffFile: p.kickoffFile }),
        ...(p.model && { model: p.model }),
      })
      refreshSlackSpecialistSurface() // the specialist's occupant may have just gained or lost the Slack-watch tools
      return respond(req, true, view(p.name, specialist))
    }
    default: return respond(req, false, 'specialist action must be set, show, rm or list')
  }
}

// ---------------------------------------------------------------------------
// Slack watches — operator view (the specialist's own session uses the bridge tools)
// ---------------------------------------------------------------------------

function handleSlackWatch(req: CLIRequest): CLIResponse {
  const p = req.params as { action?: string; channel?: string; threadTs?: string }
  const w = getSlackWatcher()
  switch (p.action) {
    case 'list': return respond(req, true, { watches: formatSlackWatches(), health: slackWatchHealth() })
    case 'rm': {
      if (!p.channel || !p.threadTs) return respond(req, false, 'channel and thread are required')
      return w.unwatch(p.channel, p.threadTs) ? respond(req, true, { removed: `${p.channel}:${p.threadTs}` }) : respond(req, false, `${p.channel}:${p.threadTs} is not watched`)
    }
    case 'add': {
      if (!p.channel || !p.threadTs) return respond(req, false, 'channel and thread are required')
      if (!/^\d{1,12}\.\d{1,6}$/.test(p.threadTs)) return respond(req, false, 'thread must look like 1793732224.093059')
      const specialist = slackWatchHealth()?.specialist
      if (!specialist) return respond(req, false, 'Slack watching is not configured: <state>/slack-watch.json is missing or invalid')
      if (!slackWatchChannels().includes(p.channel)) return respond(req, false, `${p.channel} is not one of the channels in slack-watch.json, so nothing in it would ever reach the specialist`)
      return w.watch(p.channel, p.threadTs, specialist, 'cli') ? respond(req, true, { watching: `${p.channel}:${p.threadTs}` }) : respond(req, false, 'the watch table is full')
    }
    default: return respond(req, false, 'slack-watch action must be list, add or rm')
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleCLIRequest(req: CLIRequest): Promise<CLIResponse> {
  if (typeof req.params !== 'object' || req.params === null) {
    return respond(req, false, 'params must be an object')
  }
  process.stderr.write(`daemon: cli ${req.command} (id: ${req.id})\n`)
  try {
    let response: CLIResponse
    switch (req.command) {
      case 'spawn': response = await handleSpawn(req); break
      case 'list': response = handleList(req); break
      case 'status': response = handleStatus(req); break
      case 'kill': response = await handleKill(req); break
      case 'health': response = handleHealth(req); break
      case 'clear-key': response = handleClearKey(req); break
      case 'check-key': response = handleCheckKey(req); break
      case 'deliver': response = await handleDeliver(req); break
      case 'specialist': response = await handleSpecialist(req); break
      case 'slack-watch': response = handleSlackWatch(req); break
      default:
        response = respond(req, false, `unknown command: ${req.command}`)
    }
    if (!response.ok) {
      process.stderr.write(`daemon: cli ${req.command} failed: ${response.error}\n`)
    }
    return response
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: cli ${req.command} error: ${msg}\n`)
    return respond(req, false, msg)
  }
}
