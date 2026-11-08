import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration } from './util.js'
import { parseIdleTtl } from '../shared/constants.js'
import { occupancy, occupied } from './session-reachability.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { existsSync } from 'fs'
import { checkIdempotency, registerIdempotency, updateIdempotency, getBySessionId, clearIdempotency, listIdempotencyEntries } from './idempotency.js'
import { spawnSpecialist, specialistStatus, SpecialistError } from './specialist-deliver.js'
import { getSpecialist, listSpecialists, removeSpecialist, setSpecialist, withTargetLock, type Specialist } from './specialists.js'
import { getSlackWatcher, slackWatchHealth, addSlackWatch, refreshSlackSpecialistSurface, formatSlackWatches } from './slack-watch-runtime.js'
import { deliverToTarget, deliverVia, sessionByName, toSession, toThread, type DeliverOutcome } from './targets.js'
import { gateway } from './config.js'
import { loadAccess } from './access.js'
import { on } from './event-bus.js'
import { raindropStatusLine } from './raindrop.js'
import { getCpuVitals } from './cpu-watch.js'
import { formatCpuSummary } from './cpu-spin.js'
import { jobsClock } from './jobs-clock.js'

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
    updateIdempotency(idempotencyKey, { status: 'failed' })
    if (err instanceof SpecialistError) return respond(req, false, err.message, undefined, err.exitCode)
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

// Absent until the vitals tick has sampled the session twice (a percentage needs two readings).
function cpuField(sessionId: string): { cpu?: string } {
  const v = getCpuVitals(sessionId)
  return v && (v.claudePct !== undefined || v.bridgePct !== undefined) ? { cpu: formatCpuSummary(v) } : {}
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
    ...cpuField(s.sessionId),
    ...(s.initiator && { initiator: s.initiator }),
  }))
  return respond(req, true, list)
}

function handleStatus(req: CLIRequest): CLIResponse {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = sessionByName(name)
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
    ...cpuField(info.sessionId),
    origin: info.originType,
    // Only `hydra attach` asks: surface() may recreate tmux and relaunch the Codex TUI.
    attachTarget: (req.params as { attach?: unknown }).attach === true ? info.adapter.surface(info) : undefined,
  })
}

async function handleKill(req: CLIRequest): Promise<CLIResponse> {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')

  const info = sessionByName(name)
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
    ...(jobsClock() ? { jobs: jobsClock()!.health() } : {}),
  })
}

// `hydra jobs run`: a manual dispatch through the clock. Answered after the spawn, with {id, pid, lstart}.
function handleJobsRun(req: CLIRequest): CLIResponse {
  const { name } = req.params as { name?: string }
  if (!name) return respond(req, false, 'name is required')
  const clock = jobsClock()
  if (!clock) return respond(req, false, 'jobs clock not running in this daemon')
  const r = clock.requestRun(name)
  return r.ok ? respond(req, true, r.reply) : respond(req, false, r.error)
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
  const { to, thread, session, specialist, message, initiator, idempotencyKey, queue, revive } = req.params as {
    to?: string
    thread?: string
    session?: string
    specialist?: string
    message?: string
    initiator?: string
    idempotencyKey?: string
    queue?: boolean
    revive?: boolean
  }

  if (!message) return respond(req, false, 'message is required')
  const addresses = [to, thread, session, specialist].filter(Boolean).length
  if (addresses === 0) return respond(req, false, '--to, --thread, --session or --specialist is required')
  if (to && addresses > 1) return respond(req, false, '--to is the whole address: drop --thread/--session/--specialist')
  if (specialist && (thread || session)) return respond(req, false, '--specialist is its own address: drop --thread/--session')
  if (revive && !(to || (thread && !session))) return respond(req, false, '--revive takes --to or --thread (a specialist always revives)')

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

  const opts = { initiator: initiator ?? 'unknown', ...(idempotencyKey && { idempotencyKey }), ...(queue && { queue }) }
  let r: DeliverOutcome
  if (to) r = await deliverToTarget({ to, ...(revive && { revive }) }, message, opts)
  else if (specialist) r = await deliverToTarget({ to: specialist }, message, opts)
  else if (session === 'main') r = await deliverToTarget({ to: 'main' }, message, opts)
  else if (thread && !session) r = await deliverVia(() => toThread(thread, message, opts, !!revive), message, opts)
  else {
    const info = [...registry.values()].find(s => s.tmuxName === session || s.sessionId === session)
    if (info && thread && info.threadId !== thread) return respond(req, false, `session "${session}" is in thread ${info.threadId}, not ${thread}`)
    if (info) r = await deliverVia(() => toSession(info, message, opts), message, opts)
    else if (thread) r = await deliverVia(() => toThread(thread, message, opts, false), message, opts)
    else return respond(req, false, `session "${session}" not found`)
  }
  // `permanent`: drop it rather than retry (it can never be delivered), as distinct from a gone session.
  if (!r.ok) return respond(req, false, r.reason, r.permanent ? { permanent: true } : undefined, r.exit)
  return respond(req, true, {
    status: r.status, proof: r.proof, sessionId: r.sessionId, sessionName: r.sessionName, threadId: r.threadId,
    ...(r.specialist && { specialist: r.specialist, spawned: r.revived }),
    ...(revive && { revived: r.revived }),
  })
}

// ---------------------------------------------------------------------------
// Specialists — named, refillable addresses (see specialists.ts)
// ---------------------------------------------------------------------------

async function handleSpecialist(req: CLIRequest): Promise<CLIResponse> {
  const p = req.params as { action?: string; name?: string; thread?: string; channel?: string; kickoff?: string; kickoffFile?: string; model?: string; idle?: string }
  const view = (name: string, s: Specialist & { invalid?: string }) => ({ name, ...s, ...specialistStatus(name) })
  switch (p.action) {
    case 'list': return respond(req, true, listSpecialists().map(([name, s]) => view(name, s)))
    case 'show': {
      // The stored entry, as `rm` sees it: one saved under a name no longer allowed is shown, flagged, not "not found".
      const entry = listSpecialists().find(([name]) => name === p.name)
      return entry ? respond(req, true, view(entry[0], entry[1])) : respond(req, false, `specialist "${p.name ?? ''}" not found`)
    }
    case 'rm': {
      const name = p.name
      // Under the specialist's lock: a removal never lands in the middle of its refill.
      if (!name || !(await withTargetLock(name, async () => removeSpecialist(name)))) return respond(req, false, `specialist "${name ?? ''}" not found`)
      refreshSlackSpecialistSurface() // its occupant loses the Slack-watch tools
      return respond(req, true, { removed: name })
    }
    case 'set': {
      const name = p.name
      if (!name) return respond(req, false, 'specialist name is required')
      // Under the specialist's lock, so the record a refill writes its thread to is the one set here.
      return withTargetLock(name, async () => setSpecialistUnderLock(req, name, p, view))
    }
    default: return respond(req, false, 'specialist action must be set, show, rm or list')
  }
}

function setSpecialistUnderLock(
  req: CLIRequest, name: string,
  p: { thread?: string; channel?: string; kickoff?: string; kickoffFile?: string; model?: string; idle?: string },
  view: (name: string, s: Specialist) => unknown,
): CLIResponse {
  const existing = getSpecialist(name)
  // G: two sessions answering to one name is never allowed, so a live specialist moves only once it has stopped.
  const fromId = existing?.threadId && p.thread && p.thread !== existing.threadId ? registry.getByThread(existing.threadId) : undefined
  const from = fromId ? registry.get(fromId) : undefined
  if (from && occupied(occupancy(from))) return respond(req, false, `${name}: is live in ${existing!.threadId}; hydra kill ${name} first`, undefined, 3)
  const threadId = p.thread ?? existing?.threadId
  if (!threadId && !(p.channel ?? existing?.channel)) return respond(req, false, '--channel (where to open its thread) or --thread is required for a new specialist')
  if (p.kickoffFile && !existsSync(p.kickoffFile)) return respond(req, false, `kickoff file not found: ${p.kickoffFile}`)
  if (p.idle && parseIdleTtl(p.idle) === null) return respond(req, false, `--idle "${p.idle}" is not a duration like 30m, 4h or 1d (at most 7d)`)
  // Fields not passed keep their current value, so re-pointing a specialist's thread leaves its kickoff alone.
  const { updatedAt: _t, ...rest } = existing ?? { updatedAt: 0 }
  try {
    const specialist = setSpecialist(name, {
      ...rest,
      ...(threadId && { threadId }),
      ...(p.channel && { channel: p.channel }),
      ...(p.kickoff && { kickoff: p.kickoff }),
      ...(p.kickoffFile && { kickoffFile: p.kickoffFile }),
      ...(p.model && { model: p.model }),
      ...(p.idle && { idle: p.idle }),
    })
    refreshSlackSpecialistSurface() // the specialist's occupant may have just gained or lost the Slack-watch tools
    return respond(req, true, view(name, specialist))
  } catch (err) {
    return respond(req, false, err instanceof Error ? err.message : String(err))
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
      try { return respond(req, true, { watching: addSlackWatch(p.channel, p.threadTs) }) } catch (err) { return respond(req, false, err instanceof Error ? err.message : String(err)) }
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
      case 'jobs-run': response = handleJobsRun(req); break
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
