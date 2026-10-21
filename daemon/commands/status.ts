import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR, PLATFORM } from '../config.js'
import { registry, sessionEmoji, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { fallbackDescription, formatDuration, atomicWriteFileSync, executionAlive, isAlive, safeSend, safeEdit, chunk, editErrorOutcome, type EditOutcome } from '../util.js'
import { formatContextPercent } from '../engines/engine-adapter.js'
import { getWatchesBySession } from '../pr-watch.js'
import { getActiveRuns } from '../protocol-runner.js'
import { raindropStatusLine } from '../raindrop.js'
import { isForMain, mainAlive, mainContext, mainStartedAt, mainTmux } from '../main-session.js'
import type { InboundMessage } from '../../gateway.js'

export const daemonStartedAt = Date.now()

// ---------------------------------------------------------------------------
// List display helpers (shared by handleListIntercept and refreshListDisplay)
// ---------------------------------------------------------------------------

type SessionEntry = { session: SessionInfo; latestLine?: string }

function listTimeBucket(lastActiveMs: number, now: number): string {
  const diffH = (now - lastActiveMs) / 3_600_000
  if (diffH < 1) return 'Past hour'
  if (diffH < 3) return 'Past 3 hours'
  const last = new Date(lastActiveMs)
  const today = new Date(now)
  const lastDay = new Date(last.getFullYear(), last.getMonth(), last.getDate())
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const daysDiff = Math.round((todayDay.getTime() - lastDay.getTime()) / 86_400_000)
  if (daysDiff === 0) return `${Math.round(diffH)} hours ago`
  if (daysDiff === 1) return 'Yesterday'
  return `${daysDiff} days ago`
}

function formatSessionEntry(e: SessionEntry, indent?: string): string {
  const s = e.session
  const thread = threadRegistry.get(s.threadId)
  const desc = s.description ?? fallbackDescription(thread?.topic ?? '')
  const duration = formatDuration(Date.now() - s.createdAt)
  const msgCount = s.messageCount ?? 0
  const ctx = formatContextPercent(s.adapter, s)
  const badge = transport.has(s.sessionId) ? '' : ' ⚠️'
  const emoji = sessionEmoji(s.tmuxName)
  const url = thread?.threadUrl
  const title = url ? `[**${desc}**](${url})` : `**${desc}**`
  const provenanceEmoji = s.originType === 'handoff' ? '🤝' : s.originType === 'resurrect' ? '🫀' : '🍴'
  const provenance = s.originFrom && !indent ? ` ← ${provenanceEmoji} (${s.originFrom})` : ''
  const prefix = indent ?? ''
  const lines = [
    `${prefix}${emoji} \`${s.tmuxName}\`${badge}${provenance}`,
    `${prefix}- ${title}`,
    `${prefix}- ${ctx} (${msgCount} msgs · ${duration})`,
  ]
  if (e.latestLine) lines.push(`${prefix}- ${e.latestLine}`)
  return lines.join('\n')
}

/** Render a list of sessions with parent-child grouping using tree connectors. */
function renderGrouped(items: SessionEntry[]): string {
  // Build name→entry lookup for parent resolution
  const byName = new Map<string, SessionEntry>(items.map(e => [e.session.tmuxName, e]))
  // The tree draws one level, so a session nests only under a parent that is itself top-level.
  // Self-origins (a handoff keeps its name), chains and cycles therefore all stay printed as roots.
  const parentOf = (e: SessionEntry) => {
    const n = e.session.originFrom
    return n && n !== e.session.tmuxName ? byName.get(n) : undefined
  }
  const children = new Map<string, SessionEntry[]>() // parent tmuxName → children
  const roots: SessionEntry[] = []
  for (const e of items) {
    const parent = parentOf(e)
    if (parent && !parentOf(parent)) {
      const arr = children.get(parent.session.tmuxName) ?? []
      arr.push(e)
      children.set(parent.session.tmuxName, arr)
    } else {
      roots.push(e)
    }
  }

  const parts: string[] = []
  for (const root of roots) {
    parts.push(formatSessionEntry(root))
    const kids = children.get(root.session.tmuxName) ?? []
    for (let i = 0; i < kids.length; i++) {
      const isLast = i === kids.length - 1
      const connector = isLast ? '└─ ' : '├─ '
      parts.push(formatSessionEntry(kids[i], connector))
    }
  }
  return parts.join('\n\n')
}

function buildListOutput(list: SessionEntry[], now: number): string {
  const buckets = new Map<string, SessionEntry[]>()
  for (const e of list) {
    const bucket = listTimeBucket(e.session.lastActive, now)
    const arr = buckets.get(bucket) ?? []
    arr.push(e)
    buckets.set(bucket, arr)
  }
  const sections: string[] = []
  for (const [label, items] of buckets) {
    sections.push(`### ${label}\n\n${renderGrouped(items)}`)
  }
  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// Auto-refresh: FILO queue of up to 5 list-session messages that get silently
// edited on lifecycle events. edit_message doesn't trigger push notifications.
// ---------------------------------------------------------------------------

const LIST_MSGS_FILE = join(STATE_DIR, 'list-messages.json')
const MAX_LIST_MSGS = 5
type ListMsg = { channelId: string; messageIds: string[] }
let lastListMsgs: ListMsg[] = []

function persistListMsgsToDisk(): void {
  try {
    atomicWriteFileSync(LIST_MSGS_FILE, JSON.stringify(lastListMsgs) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: failed to persist list-messages: ${err}\n`)
  }
}

// Late-bound so a test can drive refreshListDisplay without writing into the
// operator's live daemon state.
let persistListMsgs = persistListMsgsToDisk

function loadPersistedListMsgs(): void {
  try {
    const raw = readFileSync(LIST_MSGS_FILE, 'utf8')
    // Older files stored one `messageId` per list; they hold the first chunk only.
    lastListMsgs = (JSON.parse(raw) as Array<ListMsg & { messageId?: string }>)
      .map(m => ({ channelId: m.channelId, messageIds: m.messageIds ?? [m.messageId!] }))
    if (lastListMsgs.length > 0) {
      process.stderr.write(`daemon: restored ${lastListMsgs.length} list message(s)\n`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: failed to load list-messages: ${err}\n`)
    }
  }
}

loadPersistedListMsgs()

/**
 * Rewrite a posted list in place. The text is re-chunked across the list's
 * messages: extra chunks are sent, leftover messages deleted. safeEdit alone
 * would cut the text to one message and drop the sessions after it.
 */
function editListMsgs(lm: ListMsg, text: string): Promise<EditOutcome> {
  // One at a time: two overlapping edits of a growing list would each send the new chunk.
  const run = listEdits.then(async () => {
    const outcome = await rewriteListMsgs(lm, text)
    persistListMsgs() // chunk IDs may have changed
    return outcome
  })
  listEdits = run.then(() => {}, () => {})
  return run
}
let listEdits: Promise<void> = Promise.resolve()

async function rewriteListMsgs(lm: ListMsg, text: string): Promise<EditOutcome> {
  const chunks = chunk(text, gateway.maxMessageLength, 'markdown')
  const ids = lm.messageIds
  for (let i = 0; i < chunks.length; i++) {
    if (i >= ids.length) {
      const sent = await safeSend(lm.channelId, chunks[i], { unfurl: false })
      if (sent.length === 0) return 'failed'
      ids.push(...sent)
      continue
    }
    const outcome = await safeEdit(lm.channelId, ids[i], chunks[i])
    if (outcome !== 'ok') return outcome
  }
  persistListMsgs() // before the deletes: a crash must not leave deleted IDs on file
  // A leftover stays tracked until it is deleted (or already gone), so a rate limit retries next refresh.
  for (const id of ids.slice(chunks.length)) {
    try { await gateway.delete(lm.channelId, id) } catch (err) {
      if (editErrorOutcome(err) !== 'message-gone') continue
    }
    ids.splice(ids.indexOf(id), 1)
  }
  return 'ok'
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null

export function debouncedRefreshListDisplay(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshListDisplay()
  }, 500)
}

/** The list text for the live sessions, each row with its thread's latest message. */
async function renderLiveList(): Promise<string> {
  const all = [...registry.values()].filter(s => isAlive(s)).sort((a, b) => b.lastActive - a.lastActive)
  if (all.length === 0) return 'No active sessions.'
  const latestInfos = await Promise.all(all.map(async (session): Promise<string | undefined> => {
    try {
      const msgs = await gateway.fetchMessages(session.threadId, 1)
      if (msgs.length === 0) return undefined
      const m = msgs[0]
      const who = m.authorId === gateway.botId ? `<@${gateway.botId}>` : 'you'
      const msgUrl = gateway.getMessageUrl(session.threadId, m.id)
      return msgUrl ? `[📩 latest](${msgUrl}) — by ${who}` : `📩 latest — by ${who}`
    } catch { return undefined }
  }))
  return buildListOutput(all.map((session, i) => ({ session, latestLine: latestInfos[i] })), Date.now())
}

async function refreshListDisplay(): Promise<void> {
  if (lastListMsgs.length === 0) return
  const output = await renderLiveList()

  let changed = false
  for (let i = lastListMsgs.length - 1; i >= 0; i--) {
    const lm = lastListMsgs[i]
    // Forget a message only when it is really gone. Dropping it on a
    // rate-limit or a dropped connection retires the auto-refreshing display
    // permanently — it is persisted, so it never comes back on its own.
    const outcome = await editListMsgs(lm, output)
    if (outcome === 'message-gone' || outcome === 'channel-gone') {
      lastListMsgs.splice(i, 1)
      changed = true
    }
  }
  if (changed) persistListMsgs()
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function handleListIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📊').catch(() => {})
  const text = await renderLiveList()
  // safeSend chunks over-length output — a raw gateway.send silently drops
  // the whole list once enough sessions push it past Discord's 2000-char cap.
  const sentIds = await safeSend(msg.channelId, text, { replyTo: msg.id, unfurl: false })
  if (sentIds.length === 0) return

  // Track for auto-refresh on lifecycle events (FILO — most recent first).
  // One list per channel: a growing refresh would otherwise send a new chunk per old list.
  lastListMsgs = lastListMsgs.filter(m => m.channelId !== msg.channelId)
  lastListMsgs.unshift({ channelId: msg.channelId, messageIds: sentIds })
  if (lastListMsgs.length > MAX_LIST_MSGS) lastListMsgs.pop()
  persistListMsgs()
}

export async function handleUsageIntercept(msg: InboundMessage): Promise<void> {
  const info = registry.resolveThreadSession(msg.channelId, msg.existingThreadId, msg.isThread)
  if (!info && isForMain(msg)) return handleMainUsage(msg)
  if (!info) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  if (!executionAlive(info)) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }

  void gateway.react(msg.channelId, msg.id, '📈').catch(() => {})
  const ctx = formatContextPercent(info.adapter, info)
  const duration = formatDuration(Date.now() - info.createdAt)
  const msgs = info.messageCount ?? 0
  const status = transport.has(info.sessionId) ? 'connected' : 'disconnected'
  const thread = threadRegistry.get(info.threadId)
  const desc = info.description ?? fallbackDescription(thread?.topic ?? '')

  const forkCount = [...registry.values()].filter(s => s.originType === 'fork' && s.originFrom === info.tmuxName).length

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

  await safeSend(msg.channelId, lines.join('\n'), { replyTo: msg.id })
}

// Main has no registry record, so no message count, description or lineage: only what its pane and tmux can say.
async function handleMainUsage(msg: InboundMessage): Promise<void> {
  if (!mainAlive()) {
    void gateway.react(msg.channelId, msg.id, '❌').catch(() => {})
    return
  }
  void gateway.react(msg.channelId, msg.id, '📈').catch(() => {})
  const ctx = mainContext() ?? '?'
  const name = mainTmux()
  await safeSend(msg.channelId, [
    `${sessionEmoji(name)} \`${name}\` — main hydra session`,
    `    ◦ ${ctx} · ${formatDuration(Date.now() - mainStartedAt())} · ${transport.has('main') ? 'connected' : 'disconnected'}`,
  ].join('\n'), { replyTo: msg.id })
}

export async function handleHealthIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '💚').catch(() => {})
  const uptimeMin = Math.round((Date.now() - daemonStartedAt) / 60000)
  const allSessions = [...registry.values()]
  const deadSessions = allSessions.filter(s => !isAlive(s))
  const liveSessions = allSessions.filter(s => isAlive(s))
  const connectedSessions = liveSessions.filter(s => transport.has(s.sessionId))
  const disconnectedSessions = liveSessions.filter(s => !transport.has(s.sessionId))
  const queuedMsgCount = [...transport.messageQueues.values()].reduce((sum, q) => sum + q.length, 0)

  let heartbeatAge = 'n/a'
  try {
    const hb = statSync(join(STATE_DIR, 'daemon.alive'))
    heartbeatAge = `${Math.round((Date.now() - hb.mtimeMs) / 1000)}s ago`
  } catch {}

  const raindropLine = raindropStatusLine('chat')
  const lines = [
    `**Daemon Health**`,
    `• Uptime: ${uptimeMin}m`,
    `• Gateway: ${PLATFORM}`,
    `• Heartbeat: ${heartbeatAge}`,
    `• Sessions: ${liveSessions.length} live (${connectedSessions.length} connected, ${disconnectedSessions.length} disconnected)${deadSessions.length > 0 ? `, ${deadSessions.length} dead` : ''}`,
    `• Queued messages: ${queuedMsgCount}`,
    ...(raindropLine ? [`• Raindrop: ${raindropLine}`] : []),
  ]

  if (disconnectedSessions.length > 0) {
    lines.push(`• Disconnected: ${disconnectedSessions.map(s => s.tmuxName).join(', ')}`)
  }
  if (deadSessions.length > 0) {
    lines.push(`• Dead (recoverable): ${deadSessions.map(s => s.tmuxName).join(', ')}`)
  }

  await safeSend(msg.channelId, lines.join('\n'), { replyTo: msg.id })
}

// ---------------------------------------------------------------------------
// Protocols — show active review/build/design sessions
// ---------------------------------------------------------------------------

export async function handleHistoryIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '📜').catch(() => {})

  const now = Date.now()
  // Collect threads that have at least one completed session
  const threads = [...threadRegistry.values()]
    .filter(t => t.sessionHistory.some(h => h.endedAt))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, 10)

  if (threads.length === 0) {
    await safeSend(msg.channelId, '_No completed sessions in history._', { replyTo: msg.id })
    return
  }

  const lines: string[] = ['**Recent Sessions**', '']
  for (const t of threads) {
    // Find the most recent completed session in this thread
    const completed = t.sessionHistory.filter(h => h.endedAt).sort((a, b) => b.startedAt - a.startedAt)
    if (!completed.length) continue
    const last = completed[0]
    const duration = last.endedAt && last.startedAt
      ? formatDuration(last.endedAt - last.startedAt)
      : '?'
    const msgs = last.messageCount ?? 0
    const model = last.model?.replace(/^claude-/, '').replace(/\[1m\]$/, '') ?? '?'
    const desc = t.description || t.topic?.slice(0, 60) || 'untitled'
    const url = t.threadUrl
    const sessionLink = url ? `<${url}|${last.tmuxName}>` : last.tmuxName
    const age = formatDuration(now - (last.endedAt ?? last.startedAt))
    lines.push(`• ${sessionLink} — ${desc} · ${duration} · ${msgs} msgs · \`${model}\` · _${age} ago_`)
  }

  await safeSend(msg.channelId, lines.join('\n'), { replyTo: msg.id })
}

export async function handleProtocolsIntercept(msg: InboundMessage): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🧩').catch(() => {})

  const runs = getActiveRuns()

  if (runs.length === 0) {
    try { await gateway.send(msg.channelId, `No active protocols.`, { replyTo: msg.id }) } catch {}
    return
  }

  const lines: string[] = ['**Active Protocols**']

  for (const r of runs) {
    const elapsed = formatDuration(Date.now() - r.startedAt)
    const topic = r.params.topic as string | undefined
    const topicLine = topic ? ` — ${topic}` : ''
    lines.push(`• ${r.protocol.emoji} **${r.protocol.display}** (${r.currentRound}/${r.rounds}) ${r.phase}${topicLine}`)
    const roster = [...r.participants]
      .map(([role, sid]) => `${role}: ${registry.get(sid)?.tmuxName ?? '?'}`)
      .join(' · ')
    lines.push(`  ${roster} · ${elapsed}`)
  }

  await safeSend(msg.channelId, lines.join('\n'), { replyTo: msg.id })
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export const __test = process.env.NODE_ENV === 'test'
  ? {
      refreshListDisplay,
      renderGrouped,
      trackedListMsgs: () => lastListMsgs,
      setTrackedListMsgs(msgs: ListMsg[]): void {
        lastListMsgs = msgs
      },
      /** Keep persistence off the real STATE_DIR for the duration of a test. */
      setPersist(fn: () => void): void { persistListMsgs = fn },
      resetPersist(): void { persistListMsgs = persistListMsgsToDisk },
    } as const
  : undefined
