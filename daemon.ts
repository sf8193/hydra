#!/usr/bin/env bun
/**
 * Chat routing daemon.
 *
 * Platform-agnostic message router that holds a single chat gateway connection
 * (Discord or Slack) and routes messages to/from Claude sessions via unix sockets.
 *
 * Platform selection: set CHAT_PLATFORM=discord (default) or CHAT_PLATFORM=slack
 *
 * Protocol: newline-delimited JSON over unix socket at
 *   ~/.claude/channels/discord/daemon.sock
 *
 * Bridge -> Daemon:
 *   {type: "register", sessionId: "main" | "<uuid>"}
 *   {type: "tool_call", id: "<unique>", name: "reply"|"react"|..., args: {...}}
 *   {type: "permission_response", request_id: "...", behavior: "allow"|"deny"}
 *
 * Daemon -> Bridge:
 *   {type: "registered", sessionId: "..."}
 *   {type: "tool_result", id: "<unique>", content: [...], isError?: true}
 *   {type: "notification", content: "...", meta: {...}}
 *   {type: "permission_request", request_id: "...", tool_name: "...", description: "...", input_preview: "..."}
 */

import { randomBytes, randomUUID } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { createServer, type Socket } from 'net'
import { execSync, execFileSync } from 'child_process'

import type { ChatGateway, InboundMessage, ButtonDef } from './gateway.js'

// ---------------------------------------------------------------------------
// Config & env
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude-personal')
const DEFAULT_SESSION_CHANNEL = process.env.DEFAULT_SESSION_CHANNEL ?? '1506825982127112252'

// Load .env files into process.env. Real env wins, local .env takes priority over state dir .env.
const LOCAL_ENV_FILE = join(import.meta.dir, '.env')
for (const envFile of [LOCAL_ENV_FILE, ENV_FILE]) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// Platform selection
const PLATFORM = (process.env.CHAT_PLATFORM ?? 'discord') as 'discord' | 'slack'

let TOKEN: string | undefined
let SLACK_APP_TOKEN: string | undefined

if (PLATFORM === 'slack') {
  TOKEN = process.env.SLACK_BOT_TOKEN
  SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
  if (!TOKEN || !SLACK_APP_TOKEN) {
    process.stderr.write(
      `daemon: SLACK_BOT_TOKEN and SLACK_APP_TOKEN required for slack platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
} else {
  TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    process.stderr.write(
      `daemon: DISCORD_BOT_TOKEN required for discord platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
}

const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Permission regex
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Gateway instantiation
// ---------------------------------------------------------------------------

let gateway: ChatGateway
let forceReconnect: (() => Promise<{ ok: boolean; message: string }>) | null = null

if (PLATFORM === 'slack') {
  const heartbeatPath = join(STATE_DIR, 'daemon.alive')
  const { SlackGateway } = await import('./slack-gateway.js')
  const slackGw = new SlackGateway(SLACK_APP_TOKEN!, { heartbeatPath })
  forceReconnect = () => slackGw.forceReconnect()
  slackGw.onReconnectAfterOutage = (gapMs: number) => {
    const hrs = Math.floor(gapMs / 3_600_000)
    const mins = Math.floor((gapMs % 3_600_000) / 60_000)
    const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`
    const connected = [...sessions.values()].filter(s => bridges.has(s.sessionId)).length
    const disconnected = [...sessions.values()].filter(s => !bridges.has(s.sessionId)).length
    const queuedMsgCount = [...messageQueues.values()].reduce((sum, q) => sum + q.length, 0)
    const report = [
      `**Recovery report** — back online after ${duration} outage`,
      `• Sessions: ${sessions.size} total (${connected} connected, ${disconnected} disconnected)`,
      `• Queued messages: ${queuedMsgCount}`,
    ].join('\n')
    const access = loadAccess()
    for (const userId of access.allowFrom) {
      void slackGw.sendDM(userId, report).catch(e =>
        process.stderr.write(`daemon: recovery report DM failed: ${e}\n`),
      )
    }
    process.stderr.write(`daemon: sent recovery report (offline ${duration})\n`)
  }
  gateway = slackGw
} else {
  const { DiscordGateway } = await import('./discord-gateway.js')
  gateway = new DiscordGateway()
}

// ---------------------------------------------------------------------------
// Access control types & helpers
// ---------------------------------------------------------------------------

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  threadReply?: boolean
  threadArchiveMinutes?: 60 | 1440 | 4320 | 10080
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`daemon: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('daemon: static mode -- dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Gate logic
// ---------------------------------------------------------------------------

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(msg: InboundMessage): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.authorId

  if (msg.isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  // Guild/channel message
  const channelId = msg.isThread
    ? msg.parentChannelId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await gateway.isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ---------------------------------------------------------------------------
// Approval polling
// ---------------------------------------------------------------------------

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }
    void (async () => {
      try {
        await gateway.send(dmChannelId, "Paired! Say hi to Claude.")
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---------------------------------------------------------------------------
// Chunk splitting
// ---------------------------------------------------------------------------

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// Cute session names
// ---------------------------------------------------------------------------

const SESSION_CATALOG: Array<{ name: string; emoji: string; slackName: string }> = [
  { name: 'spark', emoji: '⚡', slackName: 'zap' },
  { name: 'pixel', emoji: '🟦', slackName: 'blue_square' },
  { name: 'nova',  emoji: '💥', slackName: 'boom' },
  { name: 'drift', emoji: '🌊', slackName: 'ocean' },
  { name: 'flint', emoji: '🪨', slackName: 'rock' },
  { name: 'ember', emoji: '🔥', slackName: 'fire' },
  { name: 'bloom', emoji: '🌸', slackName: 'cherry_blossom' },
  { name: 'atlas', emoji: '🗺️', slackName: 'world_map' },
  { name: 'qubit', emoji: '⚛️', slackName: 'atom_symbol' },
  { name: 'prism', emoji: '🌈', slackName: 'rainbow' },
  { name: 'orbit', emoji: '🪐', slackName: 'ringed_planet' },
  { name: 'comet', emoji: '☄️', slackName: 'comet' },
  { name: 'patch', emoji: '🩹', slackName: 'adhesive_bandage' },
  { name: 'glyph', emoji: '🔣', slackName: 'symbols' },
  { name: 'pulse', emoji: '💓', slackName: 'heartbeat' },
  { name: 'scout', emoji: '🔭', slackName: 'telescope' },
  { name: 'cedar', emoji: '🪵', slackName: 'wood' },
  { name: 'dusk',  emoji: '🌇', slackName: 'sunset' },
  { name: 'fern',  emoji: '🌿', slackName: 'herb' },
  { name: 'haze',  emoji: '🌫️', slackName: 'fog' },
  { name: 'jade',  emoji: '🐉', slackName: 'dragon' },
  { name: 'lark',  emoji: '🪶', slackName: 'feather' },
  { name: 'moss',  emoji: '🪴', slackName: 'potted_plant' },
  { name: 'pine',  emoji: '🌲', slackName: 'evergreen_tree' },
  { name: 'reef',  emoji: '🪸', slackName: 'coral' },
  { name: 'sage',  emoji: '🦉', slackName: 'owl' },
  { name: 'tide',  emoji: '🌙', slackName: 'crescent_moon' },
  { name: 'vale',  emoji: '🏞️', slackName: 'national_park' },
  { name: 'wren',  emoji: '🐦', slackName: 'bird' },
  { name: 'zinc',  emoji: '🔧', slackName: 'wrench' },
  { name: 'bolt',  emoji: '🔩', slackName: 'nut_and_bolt' },
  { name: 'crisp', emoji: '❄️', slackName: 'snowflake' },
]
const SESSION_NAMES = SESSION_CATALOG.map(s => s.name)

function sessionEmoji(name: string): string {
  return SESSION_CATALOG.find(s => s.name === name)?.emoji ?? '🔹'
}

function pickSessionName(): string {
  const used = new Set([...sessions.values()].map(s => s.tmuxName))
  try {
    const tmuxOut = execSync('tmux ls -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' })
    for (const line of tmuxOut.split('\n')) {
      if (line.trim()) used.add(line.trim())
    }
  } catch {}
  for (const name of SESSION_NAMES) {
    if (!used.has(name)) return name
  }
  return `session-${randomBytes(3).toString('hex')}`
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

type SessionInfo = {
  sessionId: string
  topic: string
  threadId: string
  createdAt: number
  lastActive: number
  tmuxName: string
  listening: boolean
  description?: string
  messageCount?: number
  claudeSessionId?: string
  originType?: 'spawn' | 'fork' | 'handoff'
  originFrom?: string
}

function fallbackDescription(topic: string): string {
  const firstLine = topic.split('\n')[0].replace(/^\/\S+\s*/, '').trim()
  return firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine
}

const sessions = new Map<string, SessionInfo>()
const threadToSession = new Map<string, string>()

const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

function persistSessions(): void {
  try {
    const data = [...sessions.values()]
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`daemon: failed to persist sessions: ${err}\n`)
  }
}

function loadPersistedSessions(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf8')
    const data = JSON.parse(raw) as SessionInfo[]
    let restored = 0
    let dead = 0
    for (const info of data) {
      try {
        execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
      } catch {
        dead++
        continue
      }
      // Migrate old forkedFrom/handedOffFrom fields
      const legacy = info as any
      if (!info.originType) {
        if (legacy.forkedFrom) { info.originType = 'fork'; info.originFrom = legacy.forkedFrom }
        else if (legacy.handedOffFrom) { info.originType = 'handoff'; info.originFrom = legacy.handedOffFrom }
        else { info.originType = 'spawn' }
        delete legacy.forkedFrom; delete legacy.handedOffFrom
      }
      sessions.set(info.sessionId, info)
      threadToSession.set(info.threadId, info.sessionId)
      restored++
    }
    if (restored > 0 || dead > 0) {
      process.stderr.write(`daemon: restored ${restored} session(s), pruned ${dead} dead\n`)
    }
    if (dead > 0) persistSessions()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: failed to load sessions: ${err}\n`)
    }
  }
}

loadPersistedSessions()

// ---------------------------------------------------------------------------
// Bridge connection registry & message queueing
// ---------------------------------------------------------------------------

type BridgeConn = {
  sessionId: string
  socket: Socket
  buf: string
}

const bridges = new Map<string, BridgeConn>()
const messageQueues = new Map<string, Array<Record<string, unknown>>>()
const MAX_QUEUE_SIZE = 50
const QUEUE_FILE = join(STATE_DIR, 'message-queue.json')

function persistQueues(): void {
  try {
    const data: Record<string, Array<Record<string, unknown>>> = {}
    for (const [sid, queue] of messageQueues) {
      if (queue.length > 0) data[sid] = queue
    }
    if (Object.keys(data).length > 0) {
      writeFileSync(QUEUE_FILE, JSON.stringify(data) + '\n', { mode: 0o600 })
    } else {
      try { unlinkSync(QUEUE_FILE) } catch {}
    }
  } catch (err) {
    process.stderr.write(`daemon: failed to persist message queues: ${err}\n`)
  }
}

function loadPersistedQueues(): void {
  try {
    const raw = readFileSync(QUEUE_FILE, 'utf8')
    const data = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>
    let total = 0
    for (const [sid, msgs] of Object.entries(data)) {
      if (sessions.has(sid) && msgs.length > 0) {
        messageQueues.set(sid, msgs)
        total += msgs.length
      }
    }
    if (total > 0) process.stderr.write(`daemon: restored ${total} queued message(s)\n`)
    try { unlinkSync(QUEUE_FILE) } catch {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: failed to load queued messages: ${err}\n`)
    }
  }
}

function sendToBridge(bridge: BridgeConn, msg: Record<string, unknown>): void {
  try {
    bridge.socket.write(JSON.stringify(msg) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: failed to write to bridge ${bridge.sessionId}: ${err}\n`)
  }
}

function sendOrQueue(sessionId: string, msg: Record<string, unknown>): void {
  const bridge = bridges.get(sessionId)
  if (bridge) {
    sendToBridge(bridge, msg)
  } else {
    let queue = messageQueues.get(sessionId)
    if (!queue) {
      queue = []
      messageQueues.set(sessionId, queue)
    }
    if (queue.length < MAX_QUEUE_SIZE) {
      queue.push(msg)
      persistQueues()
    }
  }
}

function flushQueue(sessionId: string): void {
  const queue = messageQueues.get(sessionId)
  if (!queue || queue.length === 0) return
  const bridge = bridges.get(sessionId)
  if (!bridge) return
  process.stderr.write(`daemon: flushing ${queue.length} queued message(s) for ${sessionId}\n`)
  for (const msg of queue) {
    sendToBridge(bridge, msg)
  }
  messageQueues.delete(sessionId)
  persistQueues()
}

function getBridgeForSession(sessionId: string): BridgeConn | undefined {
  return bridges.get(sessionId)
}

loadPersistedQueues()

// ---------------------------------------------------------------------------
// Bridge tool definitions (sent to bridges on registration for dynamic refresh)
// ---------------------------------------------------------------------------

const BRIDGE_TOOLS = [
  { name: 'reply', description: 'Reply on Discord. Pass chat_id from the inbound message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' }, reply_to: { type: 'string', description: 'Message ID to thread under.' }, files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach.' } }, required: ['chat_id', 'text'] } },
  { name: 'react', description: 'Add an emoji reaction to a message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } }, required: ['chat_id', 'message_id', 'emoji'] } },
  { name: 'edit_message', description: 'Edit a message the bot previously sent.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'message_id', 'text'] } },
  { name: 'download_attachment', description: 'Download attachments from a message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['chat_id', 'message_id'] } },
  { name: 'create_thread', description: 'Create a thread in a channel.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, auto_archive_minutes: { type: 'number' }, files: { type: 'array', items: { type: 'string' } } }, required: ['chat_id', 'name'] } },
  { name: 'fetch_messages', description: 'Fetch recent messages from a channel.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } },
  { name: 'spawn_session', description: 'Spawn a new Claude session. Main session only.', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, chat_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['topic'] } },
  { name: 'list_sessions', description: 'List all active sessions. Main session only.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kill_session', description: 'Kill a session by ID or thread ID. Main session only.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, thread_id: { type: 'string' } } } },
  { name: 'set_description', description: 'Set a brief description for your session.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, description: { type: 'string' } }, required: ['session_id', 'description'] } },
]

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

type SpawnResult = { name: string; sessionId: string; threadId: string; url: string }

type SpawnOpts = {
  forkFrom?: { claudeSessionId: string; parentName: string }
  handedOffFrom?: string
  artifact?: string
}

async function doSpawnSession(topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts): Promise<SpawnResult> {
  let threadId: string | undefined

  const sessionId = randomUUID()
  const tmuxName = pickSessionName()
  const threadName = `${tmuxName}: ${topic}`.slice(0, 100)
  const isFork = !!opts?.forkFrom
  const isHandoff = !!opts?.handedOffFrom
  const originType: 'spawn' | 'fork' | 'handoff' = isFork ? 'fork' : isHandoff ? 'handoff' : 'spawn'
  const originFrom = opts?.forkFrom?.parentName ?? opts?.handedOffFrom

  // Determine where to create the thread
  let targetChannelId = chatId
  if (targetChannelId) {
    try {
      const ch = await gateway.fetchChannel(targetChannelId)
      if (ch.isThread) {
        threadId = ch.id
      } else if (ch.isDM && gateway.platform === 'discord') {
        targetChannelId = DEFAULT_SESSION_CHANNEL
      }
    } catch {
      targetChannelId = DEFAULT_SESSION_CHANNEL
    }
  } else {
    targetChannelId = DEFAULT_SESSION_CHANNEL
  }

  // Create thread if we don't have one yet
  if (!threadId) {
    if (messageId && targetChannelId === chatId) {
      try {
        const thread = await gateway.createThread(targetChannelId!, threadName, {
          messageId,
          archiveDuration: 1440,
        })
        threadId = thread.id
      } catch (err) {
        process.stderr.write(`daemon: createThread on message failed: ${err}\n`)
      }
    }

    if (!threadId) {
      const e = sessionEmoji(tmuxName)
      let anchorText: string
      if (originFrom) {
        const pe = sessionEmoji(originFrom)
        const verb = isHandoff ? 'handed off from' : 'forked from'
        anchorText = `${e} \`${tmuxName}\` — ${verb} ${pe} \`${originFrom}\``
        if (isFork) anchorText += `\n${topic}`
      } else {
        anchorText = `Starting session **${tmuxName}**: ${topic}`
      }
      const anchor = await gateway.send(targetChannelId!, anchorText)
      const thread = await gateway.createThread(targetChannelId!, threadName, {
        messageId: anchor.id,
        archiveDuration: 1440,
      })
      threadId = thread.id
    }
  }

  const channelFlag = `plugin:discord@claude-plugins-official`
  const spawnCwd = process.env.SPAWN_CWD
  if (!spawnCwd) throw new Error('SPAWN_CWD env var is required — set it to the working directory for spawned sessions')

  // POSIX single-quote helper: wraps any string so the shell treats it 100% literally.
  const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

  let prompt: string
  if (isHandoff) {
    const contextLine = opts!.artifact
      ? `Read your handoff context from \`${opts!.artifact}\`, then read your memory files.`
      : `Read your memory files and workstream canon for context.`
    prompt = [
      `You are ${tmuxName}, a session created by handoff from ${originFrom}. Topic: ${topic}`,
      ``,
      `Your Discord thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `${contextLine}`,
      `After reading the artifact, append a "### Reception (by ${tmuxName})" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.`,
      `Send a greeting to your thread using reply(chat_id=${threadId}). In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
      `After greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.`,
    ].join('\n')
  } else if (isFork) {
    prompt = [
      `You are ${tmuxName}, forked from ${originFrom}.`,
      `Topic: ${topic}`,
      ``,
      `Your new thread chat_id is ${threadId}. Your session_id is ${sessionId}.`,
      `Greet your new thread using reply(chat_id=${threadId}).`,
      `Mention you were forked from **${originFrom}** and describe your focus.`,
      `Then call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary.`,
    ].join('\n')
  } else {
    prompt = `You are ${tmuxName}, a spawned session. Topic: ${topic}\n\nYour Discord thread chat_id is ${threadId}. Your session_id is ${sessionId}. Read your memory files for context, then send a greeting to your thread using reply(chat_id=${threadId}). After orienting, call set_description(session_id="${sessionId}", description="...") with a ≤10 word summary of what you're doing. Update it if your focus shifts significantly.`
  }

  // Build claude command — fork adds --resume --fork-session
  const claudeArgs = isFork
    ? [
        `claude`,
        `--resume ${shq(opts!.forkFrom!.claudeSessionId)}`,
        `--fork-session`,
        `--model ${shq('claude-opus-4-6[1m]')}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ')
    : `claude --model ${shq('claude-opus-4-6[1m]')} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}`

  const inner = [
    `cd ${shq(spawnCwd)}`,
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    claudeArgs,
  ].join(' && ')

  try {
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, inner], { stdio: 'pipe' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to spawn tmux session: ${msg}`)
  }

  const now = Date.now()
  sessions.set(sessionId, {
    sessionId, topic, threadId: threadId!, createdAt: now, lastActive: now,
    tmuxName, listening: false, originType, originFrom,
  })
  threadToSession.set(threadId!, sessionId)
  persistSessions()

  const url = await gateway.getThreadUrl(threadId!)

  return { name: tmuxName, sessionId, threadId: threadId!, url }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{type: string; text: string}>; isError?: boolean }> {
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        // Validate channel is allowed
        const ch = await gateway.fetchChannel(chat_id)
        const access = loadAccess()
        if (ch.isDM) {
          if (!access.allowFrom.includes(ch.recipientId)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        } else {
          const key = ch.isThread ? ch.parentId ?? ch.id : ch.id
          if (!(key in access.groups)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        }

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('max 10 attachments per message')

        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await gateway.send(chat_id, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { replyTo: reply_to } : {}),
            })
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'fetch_messages': {
        const channelId = args.channel as string
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await gateway.fetchMessages(channelId, limit)
        const botId = gateway.botId
        const out =
          msgs.length === 0
            ? '(no messages)'
            : msgs
                .map(m => {
                  const who = m.authorId === botId ? 'me' : m.authorUsername
                  const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : ''
                  const text = m.content.replace(/[\r\n]+/g, ' \u23CE ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        await gateway.react(args.chat_id as string, args.message_id as string, args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const edited = await gateway.edit(args.chat_id as string, args.message_id as string, args.text as string)
        return { content: [{ type: 'text', text: `edited (id: ${edited})` }] }
      }

      case 'create_thread': {
        const threadName = (args.name as string).slice(0, 100)
        const thread = await gateway.createThread(args.chat_id as string, threadName, {
          messageId: args.message_id as string | undefined,
          archiveDuration: (args.auto_archive_minutes as number | undefined) ?? 1440,
          text: args.text as string | undefined,
          files: (args.files as string[] | undefined),
        })
        const hasText = args.text as string | undefined
        return {
          content: [{
            type: 'text',
            text: hasText
              ? `thread created (thread_id: ${thread.id})`
              : `thread created (thread_id: ${thread.id})`,
          }],
        }
      }

      case 'download_attachment': {
        const results = await gateway.downloadAttachments(
          args.chat_id as string,
          args.message_id as string,
          INBOX_DIR,
        )
        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines = results.map(r => `  ${r.path}  (${r.name}, ${r.contentType}, ${r.sizeKB}KB)`)
        return {
          content: [{ type: 'text', text: `downloaded ${results.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      // --- Session management tools ---

      case 'spawn_session': {
        const result = await doSpawnSession(args.topic as string, args.chat_id as string | undefined, args.message_id as string | undefined)
        return { content: [{ type: 'text', text: `session spawned (name: ${result.name}, session_id: ${result.sessionId}, thread_id: ${result.threadId}${result.url ? `, url: ${result.url}` : ''})` }] }
      }

      case 'list_sessions': {
        const sorted = [...sessions.values()].sort((a, b) => b.lastActive - a.lastActive)
        const list = await Promise.all(sorted.map(async s => {
          const url = await gateway.getThreadUrl(s.threadId).catch(() => '')
          const desc = s.description ?? fallbackDescription(s.topic)
          return {
            name: s.tmuxName,
            description: desc,
            url,
            context: getContextPercent(s.tmuxName),
            messages: s.messageCount ?? 0,
            running_for: formatDuration(Date.now() - s.createdAt),
            status: bridges.has(s.sessionId) ? 'connected' : 'disconnected',
          }
        }))
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
      }

      case 'set_description': {
        const sessionId = args.session_id as string | undefined
        const description = args.description as string | undefined
        if (!sessionId || !description) throw new Error('session_id and description are required')
        const info = sessions.get(sessionId)
        if (!info) throw new Error('session not found')
        info.description = description.slice(0, 120)
        persistSessions()
        return { content: [{ type: 'text', text: `description set for ${info.tmuxName}` }] }
      }

      case 'kill_session': {
        const sessionId = args.session_id as string | undefined
        const threadId = args.thread_id as string | undefined

        let targetId: string | undefined
        if (sessionId) {
          targetId = sessionId
        } else if (threadId) {
          targetId = threadToSession.get(threadId)
        }

        if (!targetId || !sessions.has(targetId)) {
          throw new Error('session not found')
        }

        const info = sessions.get(targetId)!
        await killSession(info, 'session ended')
        return { content: [{ type: 'text', text: `killed session ${targetId}` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const killsInProgress = new Set<string>()

async function killSession(info: SessionInfo, reason: string): Promise<void> {
  if (killsInProgress.has(info.sessionId)) return
  killsInProgress.add(info.sessionId)

  try {
    try {
      await gateway.send(info.threadId, `_${reason}_`)
    } catch (err) {
      process.stderr.write(`daemon: failed to post session end message: ${err}\n`)
    }

    const tmuxName = info.tmuxName
    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
    } catch {}

    const bridge = bridges.get(info.sessionId)
    if (bridge) {
      try { bridge.socket.end() } catch {}
      bridges.delete(info.sessionId)
    }

    threadToSession.delete(info.threadId)
    sessions.delete(info.sessionId)
    persistSessions()

    setTimeout(() => {
      try {
        execSync(`tmux has-session -t "${tmuxName}"`, { stdio: 'pipe' })
        execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' })
        process.stderr.write(`daemon: deferred kill caught lingering tmux session "${tmuxName}"\n`)
      } catch {}
      killsInProgress.delete(info.sessionId)
    }, 3000)
  } catch (err) {
    killsInProgress.delete(info.sessionId)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Permission handling
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

gateway.onButtonClick(click => {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(click.customId)
  if (!m) return

  const access = loadAccess()
  if (!access.allowFrom.includes(click.userId)) {
    void click.respond('Not authorized.')
    return
  }

  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      void click.respond('Details no longer available.')
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
    } catch {
      prettyInput = input_preview
    }
    const expanded =
      `Permission: ${tool_name}\n\n` +
      `tool_name: ${tool_name}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const buttons: ButtonDef[] = [
      { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '\u2705' },
      { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '\u274C' },
    ]
    void click.respond(expanded, buttons)
    return
  }

  // Forward to main session bridge
  const mainBridge = getBridgeForSession('main')
  if (mainBridge) {
    sendToBridge(mainBridge, {
      type: 'permission_response',
      request_id,
      behavior,
    })
  }
  pendingPermissions.delete(request_id)
  const label = behavior === 'allow' ? 'Allowed' : 'Denied'
  void click.clearButtons(`${click.messageContent}\n\n${label}`)
})

// ---------------------------------------------------------------------------
// Spawn / kill / list intercepts
// ---------------------------------------------------------------------------

async function handleSpawnIntercept(msg: InboundMessage, topic: string, access: Access): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🚀').catch(() => {})

  try {
    const result = await doSpawnSession(topic, msg.channelId, msg.id)

    if (msg.isDM) {
      // Slack DMs support threads natively — the session thread is already visible,
      // so skip the URL. Discord DMs redirect to a guild channel, so the URL helps.
      const e = sessionEmoji(result.name)
      const base = (result.url && gateway.platform === 'discord')
        ? `Spawned ${e} \`${result.name}\` — ${result.url}`
        : `Spawned ${e} \`${result.name}\``
      // The session is a plain tmux session — surface the attach command so it can be
      // viewed/driven from any terminal tab (paste into the tab you want).
      const reply = `${base}\nView in any terminal: \`tmux attach -t ${result.name}\``
      await gateway.send(msg.channelId, reply, { replyTo: msg.id })
    }

    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned ${sessionEmoji(result.name)} \`${result.name}\` for topic: ${topic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: spawn intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Spawn failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

async function handleKillIntercept(msg: InboundMessage, name: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  let target: SessionInfo | undefined
  for (const s of sessions.values()) {
    if (s.tmuxName === name || s.topic.toLowerCase() === name.toLowerCase()) {
      target = s
      break
    }
  }
  if (!target) {
    try { await gateway.send(msg.channelId, `No session found matching "${name}"`, { replyTo: msg.id }) } catch {}
    return
  }
  await killSession(target, 'session ended')
  try { await gateway.send(msg.channelId, `Killed session **${target.tmuxName}**`, { replyTo: msg.id }) } catch {}
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`
}

function getContextPercent(tmuxName: string): string {
  try {
    const pane = execSync(`tmux capture-pane -t '${tmuxName}' -p 2>/dev/null`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
    const match = pane.match(/(\d+)%\n/)
    return match ? `${match[1]}%` : '?'
  } catch { return '?' }
}

async function handleListIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📊').catch(() => {})
  if (sessions.size === 0) {
    try { await gateway.send(msg.channelId, 'No active sessions.', { replyTo: msg.id }) } catch {}
    return
  }

  async function formatSession(s: SessionInfo, prefix: string): Promise<string> {
    const url = await gateway.getThreadUrl(s.threadId).catch(() => '')
    const desc = s.description ?? fallbackDescription(s.topic)
    const duration = formatDuration(Date.now() - s.createdAt)
    const msgs = s.messageCount ?? 0
    const ctx = getContextPercent(s.tmuxName)
    const disconnected = bridges.has(s.sessionId) ? '' : ' ⚠️'
    const emoji = sessionEmoji(s.tmuxName)
    const title = url ? `[**${desc}**](${url})` : `**${desc}**`
    const provenance = s.originFrom ? ` ← ${s.originType === 'handoff' ? '🤝' : '🍴'} ${s.originFrom}` : ''
    return `${prefix}${emoji} \`${s.tmuxName}\`${disconnected}${provenance} — ${title}\n    ◦ ${ctx} (${msgs} msgs · ${duration})`
  }

  const all = [...sessions.values()].sort((a, b) => b.lastActive - a.lastActive)
  const roots = all.filter(s => s.originType !== 'fork')
  const forksByParent = new Map<string, SessionInfo[]>()
  for (const s of all) {
    if (s.originType === 'fork' && s.originFrom) {
      const list = forksByParent.get(s.originFrom) ?? []
      list.push(s)
      forksByParent.set(s.originFrom, list)
    }
  }

  const blocks: string[] = []
  const shown = new Set<string>()
  for (const root of roots) {
    const block: string[] = [await formatSession(root, '')]
    shown.add(root.sessionId)
    const forks = forksByParent.get(root.tmuxName) ?? []
    for (const fork of forks) {
      block.push(await formatSession(fork, '╰ '))
      shown.add(fork.sessionId)
    }
    blocks.push(block.join('\n'))
  }
  for (const s of all) {
    if (!shown.has(s.sessionId)) {
      blocks.push(await formatSession(s, '╰ '))
    }
  }

  try { await gateway.send(msg.channelId, blocks.join('\n\n'), { replyTo: msg.id }) } catch {}
}

const daemonStartedAt = Date.now()

// Thread-scoped intercept: resolves the calling thread's session, or ❌
function resolveThreadSession(msg: InboundMessage): SessionInfo | null {
  if (!msg.isThread) return null
  const mappedSession = threadToSession.get(msg.channelId)
    ?? (msg.existingThreadId ? threadToSession.get(msg.existingThreadId) : undefined)
  if (!mappedSession) return null
  return sessions.get(mappedSession) ?? null
}

async function handleThreadKillIntercept(msg: InboundMessage): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '☠️').catch(() => {})
  await killSession(info, 'session ended')
}

async function handleUsageIntercept(msg: InboundMessage): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '📈').catch(() => {})
  const ctx = getContextPercent(info.tmuxName)
  const duration = formatDuration(Date.now() - info.createdAt)
  const msgs = info.messageCount ?? 0
  const status = bridges.has(info.sessionId) ? 'connected' : 'disconnected'
  const desc = info.description ?? fallbackDescription(info.topic)

  const forkCount = [...sessions.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName).length

  const e = sessionEmoji(info.tmuxName)
  const lines = [
    `${e} \`${info.tmuxName}\` — ${desc}`,
    `    ◦ ${ctx} · ${msgs} msgs · ${duration} · ${status}`,
  ]
  if (forkCount > 0) lines.push(`    ◦ ${forkCount} fork${forkCount > 1 ? 's' : ''}`)
  if (info.originType === 'handoff' && info.originFrom) {
    const pe = sessionEmoji(info.originFrom)
    lines.push(`    ◦ 🤝 handed off from ${pe} \`${info.originFrom}\``)
  } else if (info.originType === 'fork' && info.originFrom) {
    const pe = sessionEmoji(info.originFrom)
    lines.push(`    ◦ 🍴 forked from ${pe} \`${info.originFrom}\``)
  }

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

const RESTART_PENDING_FILE = join(STATE_DIR, 'restart-pending.json')

async function handleRestartIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔄').catch(() => {})

  const restartScript = join(import.meta.dir, 'restart-daemon.sh')
  try {
    await gateway.send(msg.channelId, `🔄 Restarting daemon — back in a moment...`, { replyTo: msg.id })
  } catch {}

  try {
    writeFileSync(RESTART_PENDING_FILE, JSON.stringify({ chatId: msg.channelId, messageId: msg.id, ts: Date.now() }) + '\n')
  } catch {}

  try {
    execSync(`bash "${restartScript}"`, {
      stdio: 'pipe',
      timeout: 30_000,
      env: { ...process.env, PATH: `${homedir()}/.asdf/shims:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: restart failed: ${errMsg}\n`)
  }
  try { unlinkSync(RESTART_PENDING_FILE) } catch {}
  try {
    await gateway.send(msg.channelId, `❌ Restart failed — daemon is still running on old code.`, { replyTo: msg.id })
  } catch {}
}

async function announceRestartComplete(): Promise<void> {
  try {
    const raw = readFileSync(RESTART_PENDING_FILE, 'utf8')
    const { chatId, messageId, ts } = JSON.parse(raw) as { chatId: string; messageId: string; ts: number }
    unlinkSync(RESTART_PENDING_FILE)
    const elapsedSec = Math.round((Date.now() - ts) / 1000)
    await gateway.send(chatId, `✨ Back online — restart took ${elapsedSec}s.`, { replyTo: messageId })
  } catch {}
}

async function handleHealthIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '💚').catch(() => {})
  const uptimeMin = Math.round((Date.now() - daemonStartedAt) / 60000)
  const connectedSessions = [...sessions.values()].filter(s => bridges.has(s.sessionId))
  const disconnectedSessions = [...sessions.values()].filter(s => !bridges.has(s.sessionId))
  const queuedMsgCount = [...messageQueues.values()].reduce((sum, q) => sum + q.length, 0)

  let heartbeatAge = 'n/a'
  try {
    const hb = statSync(join(STATE_DIR, 'daemon.alive'))
    heartbeatAge = `${Math.round((Date.now() - hb.mtimeMs) / 1000)}s ago`
  } catch {}

  const lines = [
    `**Daemon Health**`,
    `• Uptime: ${uptimeMin}m`,
    `• Gateway: ${PLATFORM}`,
    `• Heartbeat: ${heartbeatAge}`,
    `• Sessions: ${sessions.size} total (${connectedSessions.length} connected, ${disconnectedSessions.length} disconnected)`,
    `• Queued messages: ${queuedMsgCount}`,
  ]

  if (disconnectedSessions.length > 0) {
    lines.push(`• Disconnected: ${disconnectedSessions.map(s => s.tmuxName).join(', ')}`)
  }

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

async function handleReconnectIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔌').catch(() => {})
  if (!forceReconnect) {
    try { await gateway.send(msg.channelId, `Reconnect not available on ${PLATFORM} platform.`, { replyTo: msg.id }) } catch {}
    return
  }
  const result = await forceReconnect()
  const emoji = result.ok ? '✅' : '❌'
  try { await gateway.send(msg.channelId, `${emoji} ${result.message}`, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Claude session ID discovery (fallback when bridge registration missed it)
// ---------------------------------------------------------------------------

function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execSync(`tmux list-panes -t '${tmuxName}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim()
    if (!panePid) return null
    const childPids = execSync(`pgrep -P ${panePid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const childPid of childPids) {
      const envOutput = execSync(`ps -E -p ${childPid} 2>/dev/null`, { encoding: 'utf8' })
      if (!envOutput.includes('HYDRA_SESSION_ID')) continue
      // Heuristic: find any UUID-shaped env var with "SESSION" in the name that isn't HYDRA's
      const hydraId = envOutput.match(/HYDRA_SESSION_ID=([^\s]+)/)?.[1]
      const candidates = [...envOutput.matchAll(/([A-Z_]*SESSION[A-Z_]*)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
      const claudeId = candidates.find(m => m[2] !== hydraId)?.[2]
      if (claudeId) return claudeId
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

async function handleForkIntercept(msg: InboundMessage, description?: string): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  if (!info.claudeSessionId) {
    const discovered = discoverClaudeSessionId(info.tmuxName)
    if (discovered) {
      info.claudeSessionId = discovered
      persistSessions()
    } else {
      void gateway.send(msg.channelId, 'Fork unavailable — could not resolve Claude session ID.', { replyTo: msg.id }).catch(() => {})
      return
    }
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot fork — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍴').catch(() => {})

  const parentName = info.tmuxName
  const parentMessages = info.messageCount ?? 0
  const parentContext = getContextPercent(parentName)
  const forkTopic = description || `continuing: ${info.topic}`
  const baseChatId = msg.channelId.split(':')[0]

  try {
    const result = await doSpawnSession(forkTopic, baseChatId, undefined, {
      forkFrom: { claudeSessionId: info.claudeSessionId, parentName },
    })

    const pe = sessionEmoji(parentName)
    const ce = sessionEmoji(result.name)
    await gateway.send(msg.channelId, [
      `🍴 ${pe} \`${parentName}\` forked → ${ce} \`${result.name}\` — ${result.url}`,
      `    ◦ ${parentContext} (${parentMessages} msgs)`,
    ].join('\n'), { replyTo: msg.id })

    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] ${pe} \`${parentName}\` forked → ${ce} \`${result.name}\`: ${forkTopic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: fork intercept failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Fork failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

async function handleForksIntercept(msg: InboundMessage): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🍽️').catch(() => {})
  const forks = [...sessions.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName)
  if (forks.length === 0) {
    try { await gateway.send(msg.channelId, `No forks from ${sessionEmoji(info.tmuxName)} \`${info.tmuxName}\`.`, { replyTo: msg.id }) } catch {}
    return
  }

  const lines = await Promise.all(forks.sort((a, b) => a.createdAt - b.createdAt).map(async s => {
    const url = await gateway.getThreadUrl(s.threadId).catch(() => '')
    const desc = s.description ?? fallbackDescription(s.topic)
    const ctx = getContextPercent(s.tmuxName)
    const msgs = s.messageCount ?? 0
    const duration = formatDuration(Date.now() - s.createdAt)
    const e = sessionEmoji(s.tmuxName)
    const title = url ? `[**${desc}**](${url})` : `**${desc}**`
    return `╰ ${e} \`${s.tmuxName}\` — ${title}\n    ◦ ${ctx} (${msgs} msgs · ${duration})`
  }))

  const pe = sessionEmoji(info.tmuxName)
  try { await gateway.send(msg.channelId, `Forks from ${pe} \`${info.tmuxName}\`\n\n${lines.join('\n')}`, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

const HANDOFF_PROTOCOL = `HANDOFF PROTOCOL
================

You are about to hand off your work to a successor session. Your context
window is being retired. The successor will start fresh with access to the
filesystem, memory files, and workstream canon -- but NOT your conversation
history.

User's direction for the successor: "{user_direction}"
(If empty: the successor should continue the current line of work.)

Execute the following steps. Do not ask for confirmation.

STEP 1: PERSIST DURABLE LEARNINGS
----------------------------------
Review your conversation for insights that should survive beyond this
immediate handoff -- things future sessions (not just the successor)
would benefit from knowing.

Write these to the appropriate files using your normal editing tools:
- Workstream canon (CANON.md): architectural decisions, gotchas, patterns
- Memory files (~/.claude/memory/): cross-project patterns, user preferences
- Workstream notes: action items not for the immediate successor

Route by asking: "Will a future session in a *different* project benefit?"
→ global memory/technique/skill files (~/.claude/memory/, ~/.claude/skills/).
"Is this about how *this workstream* works?" → workstream canon.
"Is this about a specific artifact type (HTML, diagrams, etc.)?" → the
relevant skill file. Don't put learnings in the handoff doc -- the handoff
is ephemeral; skills and canon are permanent.

If a spec exists for this work and the implementation diverged from it,
update the spec to match reality or add a note at the top:
"Superseded by [description]. See [reference]."

If nothing is durable, say so and move to Step 2.

STEP 2: PRODUCE THE HANDOFF ARTIFACT
--------------------------------------
Write the artifact to: {artifact_path}

Structure it as a self-contained prompt -- the successor has never seen
your conversation:

### Orientation
What we're working on and why. 2-3 sentences.

### Prerequisites
Skills, canon docs, or conventions the successor MUST read before touching
anything. Not suggestions -- gates. If the workstream has specialized tooling
(validation scripts, editing conventions, pipeline patterns), list the skill
or doc path here. The successor reads these before acting on anything else.

### State of the work
- Done (with file paths). For each done item whose mechanism isn't
  obvious from the name alone, add one sentence explaining how it works.
  Names you coined in-session are opaque to the successor.
- In progress (with locations and status)
- Blocked or unresolved (with enough context to unblock)

### Key decisions
Decisions that were expensive to reach. Include reasoning and rejected
alternatives. Format: "Decision: X. Reasoning: Y. Rejected: Z."

### Dead ends
Approaches tried and abandoned, with why.

### Anchors
Function/constant names and file paths the successor needs. Include
approximate line numbers as a convenience, but name the function --
names persist, line numbers drift.

### Next action
The single most important thing to do first. One sentence.

### Remaining steps
Other actions, ordered by priority. Organized around the user's
direction: "{user_direction}"

STEP 3: PRESENT FOR REVIEW
---------------------------
Reply in the thread with a TLDR: one sentence on what was persisted,
one sentence summarizing the artifact, and the file path. Then say:
"Type \`go\` to launch the successor, or give feedback to iterate."

If the user sends feedback instead of \`go\`, revise the artifact file
and post an updated TLDR. Repeat until \`go\`.
`

const HANDOFF_DIR = join(STATE_DIR, 'handoffs')

async function handleHandoffIntercept(msg: InboundMessage, direction?: string): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  try {
    execSync(`tmux has-session -t '${info.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
  } catch {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    void gateway.send(msg.channelId, `Cannot handoff — **${info.tmuxName}** is no longer running.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})

  const userDirection = direction || ''
  mkdirSync(HANDOFF_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactPath = join(HANDOFF_DIR, `${ts}-${info.tmuxName}.md`)

  const ctx = getContextPercent(info.tmuxName)
  const ctxNum = parseInt(ctx) || 0
  const estimate = ctxNum >= 70 ? '30-60s' : ctxNum >= 40 ? '45-90s' : '60-120s'
  void gateway.send(msg.channelId,
    `🤝 **${info.tmuxName}** is preparing the handoff — persisting learnings and composing the artifact (~${estimate} at ${ctx} context). I'll post a TLDR when ready for your review.`,
    { replyTo: msg.id },
  ).catch(() => {})

  const protocol = HANDOFF_PROTOCOL
    .replace(/\{user_direction\}/g, userDirection || '(continue current line of work)')
    .replace(/\{artifact_path\}/g, artifactPath)
  let contextNote = ''
  if (ctxNum >= 80) {
    contextNote = `\n\nCONTEXT NOTE: You are at ${ctx} context. Keep the artifact concise — prioritize decisions, dead ends, and anchors over comprehensive state. Consider delegating artifact composition to a subagent if available.`
  } else if (ctxNum >= 60) {
    contextNote = `\n\nCONTEXT NOTE: You are at ${ctx} context. Balance thoroughness with conciseness.`
  }

  const protocolMessage = `[system] Handoff requested.${userDirection ? ` User direction: '${userDirection}'.` : ''} Execute the handoff protocol now.\n\n${protocol}${contextNote}`

  sendOrQueue(info.sessionId, {
    type: 'notification',
    content: protocolMessage,
    meta: {
      chat_id: info.threadId,
      message_id: msg.id,
      user: 'system',
      user_id: 'system',
      ts: new Date().toISOString(),
    },
  })
}

async function handleGoIntercept(msg: InboundMessage): Promise<void> {
  const info = resolveThreadSession(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  // Find the most recent artifact file for this session
  let artifactPath: string | null = null
  try {
    const files = readdirSync(HANDOFF_DIR)
      .filter(f => f.endsWith(`-${info.tmuxName}.md`))
      .sort()
    if (files.length > 0) {
      artifactPath = join(HANDOFF_DIR, files[files.length - 1])
    }
  } catch {}

  if (!artifactPath) {
    void gateway.send(msg.channelId, `No handoff artifact found for **${info.tmuxName}**. Run \`handoff\` first.`, { replyTo: msg.id }).catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})

  const baseChatId = msg.channelId.split(':')[0]
  const topic = info.description ?? fallbackDescription(info.topic)

  try {
    const result = await doSpawnSession(topic, baseChatId, undefined, {
      handedOffFrom: info.tmuxName,
      artifact: artifactPath,
    })

    // Wait for successor's bridge to register (up to 30s)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (bridges.has(result.sessionId)) break
      await new Promise(r => setTimeout(r, 500))
    }

    // Post cross-link in old thread
    const pe = sessionEmoji(info.tmuxName)
    const ce = sessionEmoji(result.name)
    try {
      await gateway.send(info.threadId, [
        `🤝 ${pe} \`${info.tmuxName}\` handed off → ${ce} \`${result.name}\` — ${result.url}`,
        `View in any terminal: \`tmux attach -t ${result.name}\``,
      ].join('\n'))
    } catch {}

    // Notify main session
    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] 🤝 ${pe} \`${info.tmuxName}\` handed off → ${ce} \`${result.name}\`${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: baseChatId, user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }

    // Predecessor stays alive — user decides when to kill
    try {
      await gateway.send(info.threadId, `${ce} \`${result.name}\` is live. Type \`kill\` here to end \`${info.tmuxName}\`.`)
    } catch {}
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: handoff go failed: ${errMsg}\n`)
    try { await gateway.send(msg.channelId, `Handoff failed: ${errMsg}`, { replyTo: msg.id }) } catch {}
  }
}

async function handleCommandsIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📋').catch(() => {})
  const text = [
    '**Bridge Commands**',
    '',
    '**Global (work from anywhere):**',
    '• `new session: <topic>` / `spawn: <topic>` — spawn an isolated Claude session in its own thread',
    '• `list sessions` — show all running sessions with lineage',
    '• `kill session: <name>` — terminate a named session',
    '• `health` / `status` — daemon health and diagnostics',
    '• `reconnect` — re-establish Slack connection without restarting (sessions untouched)',
    '• `restart` — restart the daemon (picks up code changes, sessions reconnect)',
    '',
    '**Thread-scoped (in a session thread only, ❌ elsewhere):**',
    '• `fork` — fork into a new thread carrying full conversation history',
    '• `fork: <description>` — directed fork with a specific focus',
    '• `forks` — list all forks from this thread',
    '• `handoff` — distill context into an artifact for review',
    '• `handoff: <direction>` — directed handoff with a specific focus',
    '• `go` — launch the successor (predecessor stays alive until you `kill` it)',
    '• `usage` — session stats: context %, messages, runtime, fork count',
    '• `kill` — kill this session',
    '• `listen` / `pause` — toggle whether the session responds to all messages',
    '',
    '**Other:**',
    '• `commands` — this directory',
  ].join('\n')
  try { await gateway.send(msg.channelId, text, { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Deliver a message to a session
// ---------------------------------------------------------------------------

async function deliverToSession(msg: InboundMessage, targetSessionId: string, access: Access): Promise<void> {
  void gateway.typing(msg.channelId).catch(() => {})
  if (access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, access.ackReaction).catch(() => {})
  }

  const atts: string[] = msg.attachments.map(att => {
    const kb = (att.size / 1024).toFixed(0)
    return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
  })
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  let threadContext: Record<string, string> = {}
  if (msg.isThread) {
    const starter = await (gateway as any).getThreadStarterInfo?.(msg.channelId)
    if (starter) {
      threadContext = {
        thread_name: starter.threadName,
        thread_starter_user: starter.starterUser,
        thread_starter_content: starter.starterContent,
        thread_starter_id: starter.starterId,
      }
    }
  }

  // Use the session's threadId as chat_id so replies go to the right thread
  const sessionInfo = sessions.get(targetSessionId)
  if (sessionInfo) {
    sessionInfo.messageCount = (sessionInfo.messageCount ?? 0) + 1
  }
  const chatId = sessionInfo?.threadId ?? msg.channelId

  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  sendOrQueue(targetSessionId, { type: 'notification', content, meta })
}

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------

gateway.onThreadDelete(threadId => {
  const sessionId = threadToSession.get(threadId)
  if (!sessionId) return
  const info = sessions.get(sessionId)
  if (!info) return
  process.stderr.write(`daemon: thread ${threadId} deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'thread deleted')
})

gateway.onMessageDelete((messageId, threadId) => {
  if (!threadId) return
  const sessionId = threadToSession.get(threadId)
  if (!sessionId) return
  const info = sessions.get(sessionId)
  if (!info) return
  process.stderr.write(`daemon: anchor message deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'anchor message deleted')
})

gateway.onMessage(async (msg: InboundMessage) => {
  if (msg.isBot) return

  const access = loadAccess()
  const senderId = msg.authorId
  const isAllowed = access.allowFrom.includes(senderId)

  if (isAllowed) {
    // ── Global commands (work from anywhere) ──────────────────────────
    //   spawn: <topic>         start a new session         🚀
    //   kill: <name>           kill a named session        ☠️
    //   list sessions          list all sessions           📊
    //   health / status        daemon health               💚
    //   commands               command directory            📋

    // `[\s\S]` (not `.`) so the topic captures multi-line/multi-paragraph prompts, not just the first line.
    const spawnMatch = msg.content.match(/^(?:new session:|spawn:|\/spawn)\s*([\s\S]+)/i)
    if (spawnMatch) {
      const topic = spawnMatch[1].trim()
      if (topic) {
        void handleSpawnIntercept(msg, topic, access)
        return
      }
    }

    const killMatch = msg.content.match(/^(?:kill session:|kill:|\/kill)\s*(.+)/i)
    if (killMatch) {
      void handleKillIntercept(msg, killMatch[1].trim())
      return
    }

    const listMatch = msg.content.match(/^(?:\/sessions|list sessions)\s*$/i)
    if (listMatch) {
      void handleListIntercept(msg)
      return
    }

    const restartMatch = msg.content.match(/^(?:\/restart|restart daemon|restart)\s*$/i)
    if (restartMatch) {
      void handleRestartIntercept(msg)
      return
    }

    const healthMatch = msg.content.match(/^(?:\/health|health|status)\s*$/i)
    if (healthMatch) {
      void handleHealthIntercept(msg)
      return
    }

    const reconnectMatch = msg.content.match(/^(?:\/reconnect|reconnect)\s*$/i)
    if (reconnectMatch) {
      void handleReconnectIntercept(msg)
      return
    }

    const commandsMatch = msg.content.match(/^(?:\/commands|commands|list commands|show commands)\s*$/i)
    if (commandsMatch) {
      void handleCommandsIntercept(msg)
      return
    }

    // ── Thread commands (spawn thread only, ❌ elsewhere) ─────────────
    //   kill                   kill this session              ☠️
    //   usage                  session stats                  📈
    //   fork / fork: <desc>    fork with full context         🍴
    //   forks                  list forks from this thread    🍽️
    //   listen / pause         toggle listening               👂/⏸️

    const threadKillMatch = msg.content.match(/^(?:kill|\/kill)\s*$/i)
    if (threadKillMatch) {
      void handleThreadKillIntercept(msg)
      return
    }

    const usageMatch = msg.content.match(/^(?:\/usage|usage)\s*$/i)
    if (usageMatch) {
      void handleUsageIntercept(msg)
      return
    }

    if (msg.isThread) {
      const forkMatch = msg.content.match(/^(?:fork|\/fork)(?::\s*([\s\S]+))?$/i)
      if (forkMatch) {
        void handleForkIntercept(msg, forkMatch[1]?.trim())
        return
      }

      const forksMatch = msg.content.match(/^(?:forks|\/forks)\s*$/i)
      if (forksMatch) {
        void handleForksIntercept(msg)
        return
      }

      const handoffMatch = msg.content.match(/^(?:handoff|\/handoff)(?::\s*([\s\S]+))?$/i)
      if (handoffMatch) {
        void handleHandoffIntercept(msg, handoffMatch[1]?.trim())
        return
      }

      const goMatch = msg.content.match(/^(?:go|\/go)\s*$/i)
      if (goMatch) {
        void handleGoIntercept(msg)
        return
      }
    }

    // Session thread routing
    if (msg.isThread) {
      // Discord: channelId IS the thread ID. Slack: need composite channelId:thread_ts.
      const mappedSession = threadToSession.get(msg.channelId)
        ?? (msg.existingThreadId ? threadToSession.get(msg.existingThreadId) : undefined)
      process.stderr.write(`daemon: thread routing: channelId=${msg.channelId} existingThreadId=${msg.existingThreadId} mappedSession=${mappedSession ?? 'none'} threadToSession keys=[${[...threadToSession.keys()].join(',')}]\n`)
      if (mappedSession) {
        const info = sessions.get(mappedSession)
        if (info) {
          const listenMatch = msg.content.match(/^(listen|pause)\s*$/i)
          if (listenMatch) {
            info.listening = listenMatch[1].toLowerCase() === 'listen'
            persistSessions()
            void gateway.react(msg.channelId, msg.id, info.listening ? '👂' : '⏸️').catch(() => {})
            return
          }

          // In Slack DM threads, always route — the thread IS the session.
          // In Discord guild threads, require explicit addressing (listen mode,
          // name prefix, or reply-to-bot) to avoid responding to bystanders.
          const alwaysRoute = gateway.platform === 'slack' && msg.isDM
          const shouldRoute =
            alwaysRoute ||
            info.listening ||
            msg.content.toLowerCase().startsWith(info.tmuxName) ||
            (msg.referenceMessageId && gateway.wasSentByUs(msg.referenceMessageId))

          if (shouldRoute) {
            info.lastActive = Date.now()
            void deliverToSession(msg, mappedSession, access)
            return
          }

          // Fallback: check if replying to bot message via gateway
          if (msg.referenceMessageId) {
            const mentioned = await gateway.isMentioned(msg)
            if (mentioned) {
              info.lastActive = Date.now()
              void deliverToSession(msg, mappedSession, access)
              return
            }
          }

          return
        }
      }
    }
  }

  // Normal gate
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await gateway.send(msg.channelId, `${lead} -- run in Claude Code:\n\n/discord:access pair ${result.code}`, { replyTo: msg.id })
    } catch (err) {
      process.stderr.write(`daemon: failed to send pairing code: ${err}\n`)
    }
    return
  }

  let chat_id = msg.channelId

  // Thread creation for threadReply policy
  if (!msg.isDM && !msg.isThread) {
    const channelId = msg.channelId
    const policy = result.access.groups[channelId]
    if (policy?.threadReply) {
      const preview = msg.content.slice(0, 50).replace(/<@!?\d+>\s*/g, '').trim() || 'Thread'
      const archiveDuration = policy.threadArchiveMinutes ?? 1440

      if (msg.hasExistingThread && msg.existingThreadId) {
        chat_id = msg.existingThreadId
      } else {
        const threadId = await (gateway as any).startThreadOnMessage?.(msg, preview, archiveDuration)
        if (threadId) {
          chat_id = threadId
        }
      }
    }
  }

  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const mainBridge = getBridgeForSession('main')
    if (mainBridge) {
      sendToBridge(mainBridge, {
        type: 'permission_response',
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      })
    }
    const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '\u2705' : '\u274C'
    void gateway.react(msg.channelId, msg.id, emoji).catch(() => {})
    return
  }

  // Typing indicator
  void gateway.typing(msg.channelId).catch(() => {})

  // Ack reaction
  if (result.access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, result.access.ackReaction).catch(() => {})
  }

  // Build notification
  const atts: string[] = msg.attachments.map(att => {
    const kb = (att.size / 1024).toFixed(0)
    return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
  })
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  let threadContext: Record<string, string> = {}
  if (msg.isThread) {
    const starter = await (gateway as any).getThreadStarterInfo?.(msg.channelId)
    if (starter) {
      threadContext = {
        thread_name: starter.threadName,
        thread_starter_user: starter.starterUser,
        thread_starter_content: starter.starterContent,
        thread_starter_id: starter.starterId,
      }
    }
  }

  const meta: Record<string, string> = {
    chat_id,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...threadContext,
  }

  // Route to session
  let targetSessionId = 'main'

  if (msg.isThread) {
    const mappedSession = threadToSession.get(msg.channelId)
      ?? (msg.existingThreadId ? threadToSession.get(msg.existingThreadId) : undefined)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
      meta.chat_id = info.threadId
    }
  }
  if (targetSessionId === 'main' && chat_id !== msg.channelId) {
    const mappedSession = threadToSession.get(chat_id)
      ?? (msg.existingThreadId ? threadToSession.get(msg.existingThreadId) : undefined)
    if (mappedSession && sessions.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = sessions.get(mappedSession)!
      info.lastActive = Date.now()
      meta.chat_id = info.threadId
    }
  }

  sendOrQueue(targetSessionId, { type: 'notification', content, meta })
})

// ---------------------------------------------------------------------------
// Unix socket server
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
      const info = sessions.get(sessionId)
      if (info) {
        const resolved = claudeSessionId || discoverClaudeSessionId(info.tmuxName)
        if (resolved) {
          info.claudeSessionId = resolved
          persistSessions()
        }
      }

      const existing = bridges.get(sessionId)
      if (existing && existing.socket !== conn.socket) {
        process.stderr.write(`daemon: replacing bridge for session ${sessionId}\n`)
        try { existing.socket.end() } catch {}
      }

      bridges.set(sessionId, conn)
      sendToBridge(conn, { type: 'registered', sessionId, tools: BRIDGE_TOOLS })
      flushQueue(sessionId)
      process.stderr.write(`daemon: bridge registered for session ${sessionId}\n`)
      break
    }

    case 'tool_call': {
      const { id, name, args } = msg as { id: string; name: string; args: Record<string, unknown> }

      if (['spawn_session', 'list_sessions', 'kill_session'].includes(name)) {
        if (conn.sessionId !== 'main') {
          sendToBridge(conn, {
            type: 'tool_result',
            id,
            content: [{ type: 'text', text: `${name} is only available to the main session` }],
            isError: true,
          })
          return
        }
      }

      if (conn.sessionId !== 'main') {
        const info = sessions.get(conn.sessionId)
        if (info) info.lastActive = Date.now()
      }

      void executeTool(name, args).then(result => {
        sendToBridge(conn, {
          type: 'tool_result',
          id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        })
      }).catch(err => {
        sendToBridge(conn, {
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
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '\u2705' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '\u274C' },
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

// Unlink stale socket file on startup
try {
  if (existsSync(SOCK_PATH)) {
    unlinkSync(SOCK_PATH)
  }
} catch {}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const socketServer = createServer((socket: Socket) => {
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
      if (bridges.get(conn.sessionId) === conn) {
        bridges.delete(conn.sessionId)
      }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`daemon: bridge socket error: ${err}\n`)
    if (conn.sessionId && bridges.get(conn.sessionId) === conn) {
      bridges.delete(conn.sessionId)
    }
  })
})

socketServer.listen(SOCK_PATH, () => {
  try { chmodSync(SOCK_PATH, 0o700) } catch {}
  process.stderr.write(`daemon: listening on ${SOCK_PATH}\n`)
})

// ---------------------------------------------------------------------------
// Gateway start & graceful shutdown
// ---------------------------------------------------------------------------

// Keep the plugin-cache bridge (the server.ts Claude actually loads) in sync with the
// repo's bridge.ts, so spawned sessions never run stale code after a daemon restart.
// Mirrors the copy launch-bitbot.sh does for the main bot. Best-effort, never fatal.
try {
  const bridgeSrc = join(import.meta.dir, 'bridge.ts')
  const discordCache = join(CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord')
  execSync(`for d in "${discordCache}"/*/ ; do cp "${bridgeSrc}" "$d/server.ts"; done`, { stdio: 'pipe' })
  process.stderr.write(`daemon: synced bridge.ts into ${discordCache}/*/server.ts\n`)
} catch (err) {
  process.stderr.write(`daemon: bridge sync skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
}

await gateway.start(TOKEN!)
process.stderr.write(`daemon: ${PLATFORM} gateway started\n`)
void announceRestartComplete()

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('daemon: shutting down\n')

  persistQueues()
  socketServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}

  for (const [, bridge] of bridges) {
    try { bridge.socket.end() } catch {}
  }
  bridges.clear()

  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(gateway.stop()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
