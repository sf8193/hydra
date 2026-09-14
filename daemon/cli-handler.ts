import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, isAlive } from './util.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { resolveEngine } from './engines/instances.js'
import { checkIdempotency, registerIdempotency, updateIdempotency, getBySessionId, clearIdempotency, listIdempotencyEntries } from './idempotency.js'
import { ORPHAN_GRACE_MS } from './session-reachability.js'
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
    threadId: s.threadId,
    description: s.description ?? (s.topic ? fallbackDescription(s.topic) : ''),
    url: (s.lastReplyId ? gateway.getMessageUrl(s.threadId, s.lastReplyId) : '') || s.threadUrl || '',
    context: formatContextPercent(s.adapter ?? resolveEngine(s.engine), s),
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
    context: formatContextPercent(info.adapter ?? resolveEngine(info.engine), info),
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

function handleFactory(req: CLIRequest): CLIResponse {
  const { sub, ticket, allowUnreviewed } = req.params as { sub?: string; ticket?: string; allowUnreviewed?: boolean }
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
      const r = factoryAcceptByTicket(ticket, allowUnreviewed ?? false)
      if ('error' in r) return respond(req, false, r.error)
      return respond(req, true, { accepted: ticket })
    }
    case 'abandon': {
      if (!ticket) return respond(req, false, 'ticket is required')
      const r = factoryAbandonByTicket(ticket)
      if ('error' in r) return respond(req, false, r.error)
      return respond(req, true, { abandoned: ticket })
    }
    default:
      return respond(req, false, `unknown factory subcommand: "${sub ?? ''}" (expected list|status|accept|abandon)`)
  }
}

// ---------------------------------------------------------------------------
// Deliver — whisper channel: message to session context, not thread
// ---------------------------------------------------------------------------

const DELIVER_MAX_MESSAGE_BYTES = 10_000
const DELIVER_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000

function handleDeliver(req: CLIRequest): CLIResponse {
  const { thread, session, message, initiator, idempotencyKey, queue } = req.params as {
    thread?: string
    session?: string
    message?: string
    initiator?: string
    idempotencyKey?: string
    queue?: boolean
  }

  if (!message) return respond(req, false, 'message is required')
  if (Buffer.byteLength(message) > DELIVER_MAX_MESSAGE_BYTES) {
    return respond(req, false, `message too large (${Buffer.byteLength(message)} bytes, max ${DELIVER_MAX_MESSAGE_BYTES})`)
  }
  if (!thread && !session) return respond(req, false, '--thread or --session is required')

  if (idempotencyKey) {
    const check = checkIdempotency(idempotencyKey)
    if (check.blocked) {
      return respond(req, false, `already delivered with key "${idempotencyKey}"`, { existing: check.entry }, 2)
    }
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
  if (!bridgeConnected) {
    const ageMs = Date.now() - info.createdAt
    if (ageMs < ORPHAN_GRACE_MS) {
      return respond(req, false, 'session still booting — retry in ~30s', undefined, 5)
    }
    if (!queue) {
      return respond(req, false, 'session orphaned (tmux alive, bridge disconnected) — try \'resume\' in the thread, or use --queue to queue for later', undefined, 4)
    }
  }

  const meta: Record<string, string> = { source: 'cli-deliver' }
  if (initiator) meta.initiator = initiator

  const notification = { type: 'notification', content: message, meta }

  // Codex sessions route through their adapter, not the bridge socket
  if (info.engine === 'codex' && info.adapter) {
    void info.adapter.deliver(info, message, undefined, meta)
    if (idempotencyKey) {
      registerIdempotency(idempotencyKey, info.sessionId, DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
    }
    return respond(req, true, {
      status: 'delivered',
      proof: 'adapter',
      sessionId: info.sessionId,
      sessionName: info.tmuxName,
      threadId: info.threadId,
    })
  }

  // With --queue: use sendOrQueue (persists for later flush)
  // Without: direct sendToBridge (binary outcome)
  if (queue && !bridgeConnected) {
    transport.sendOrQueue(info.sessionId, notification)
    if (idempotencyKey) {
      registerIdempotency(idempotencyKey, info.sessionId, DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
    }
    return respond(req, true, {
      status: 'queued',
      proof: 'persisted',
      sessionId: info.sessionId,
      sessionName: info.tmuxName,
      threadId: info.threadId,
    })
  }

  const bridge = transport.get(info.sessionId)
  if (!bridge) {
    return respond(req, false, 'bridge unexpectedly absent after reachability check', undefined, 6)
  }

  const written = transport.sendToBridge(bridge, notification)

  if (!written) {
    return respond(req, false, 'bridge write failed (socket destroyed) — transient, retry', undefined, 6)
  }

  if (idempotencyKey) {
    registerIdempotency(idempotencyKey, info.sessionId, DELIVER_IDEMPOTENCY_TTL_MS, 'completed')
  }

  return respond(req, true, {
    status: 'delivered',
    proof: 'socket_write',
    sessionId: info.sessionId,
    sessionName: info.tmuxName,
    threadId: info.threadId,
  })
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
      case 'factory': response = handleFactory(req); break
      case 'deliver': response = handleDeliver(req); break
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
