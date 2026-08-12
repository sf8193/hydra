import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent } from './util.js'
import { checkIdempotency, registerIdempotency, updateIdempotency, getBySessionId, clearIdempotency, listIdempotencyEntries } from './idempotency.js'
import { gateway } from './config.js'
import { loadAccess } from './access.js'
import { on } from './event-bus.js'
import { factoryListAll, factoryAcceptByTicket, factoryAbandonByTicket } from './factory.js'

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
  const { prompt, initiator, idempotencyKey, channel, message, ephemeral, quiet, model } = req.params as {
    prompt?: string
    initiator?: string
    idempotencyKey?: string
    channel?: string
    message?: string
    ephemeral?: boolean
    quiet?: boolean
    model?: string
  }

  if (!prompt) return respond(req, false, 'prompt is required')
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
    result = await doSpawnSession(prompt, channel ?? undefined, message ?? undefined, { initiator, model, ephemeral, trigger: 'CLI' })
  } catch (err) {
    updateIdempotency(idempotencyKey, { status: 'failed' })
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
    description: s.description ?? (s.topic ? fallbackDescription(s.topic) : ''),
    url: (s.lastReplyId ? gateway.getMessageUrl(s.threadId, s.lastReplyId) : '') || s.threadUrl || '',
    context: getContextPercent(s.tmuxName),
    running_for: formatDuration(Date.now() - s.createdAt),
    status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
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
    context: getContextPercent(info.tmuxName),
    running_for: formatDuration(Date.now() - info.createdAt),
    bridge: transport.has(info.sessionId) ? 'connected' : 'disconnected',
    tmux: tmuxAlive ? 'alive' : 'dead',
    origin: info.originType,
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

  return respond(req, true, {
    sessions: { total: sessions.length, connected, disconnected },
    tmux: tmuxRunning ? 'running' : 'not running',
    idempotency: { active: listIdempotencyEntries().length },
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

async function handleFactory(req: CLIRequest): Promise<CLIResponse> {
  const { sub, ticket, allowUnreviewed, reason } = req.params as { sub?: string; ticket?: string; allowUnreviewed?: boolean; reason?: string }
  switch (sub) {
    case 'list':
      return respond(req, true, factoryListAll())
    case 'status': {
      if (!ticket) return respond(req, false, 'ticket is required')
      const result = factoryListAll(ticket)
      if (result.builds.length === 0) return respond(req, false, `ticket "${ticket}" not found`)
      return respond(req, true, result)
    }
    case 'accept': {
      if (!ticket) return respond(req, false, 'ticket is required')
      const r = await factoryAcceptByTicket(ticket, allowUnreviewed ?? false)
      if ('error' in r) return respond(req, false, r.error)
      return respond(req, true, { accepted: ticket })
    }
    case 'abandon': {
      if (!ticket) return respond(req, false, 'ticket is required')
      const r = factoryAbandonByTicket(ticket, reason)
      if ('error' in r) return respond(req, false, r.error)
      return respond(req, true, { abandoned: ticket })
    }
    default:
      return respond(req, false, `unknown factory subcommand: "${sub ?? ''}" (expected list|status|accept|abandon)`)
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
      case 'factory': response = await handleFactory(req); break
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
