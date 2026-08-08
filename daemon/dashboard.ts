/**
 * Dashboard — auto-updating session overview in Slack's App Home tab.
 */

import { gateway, PLATFORM } from './config.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { formatDuration, tmuxHasSession } from './util.js'
import { loadAccess } from './access.js'
import { getWatchesBySession, type WatchEntry } from './pr-watch.js'
import { assembleContextLines } from './artifacts.js'

const DEBOUNCE_MS = 2000
const PERIODIC_REFRESH_MS = 5 * 60 * 1000
// Each session = up to 3 blocks (section + context + divider). Slack caps views at 100.
// Fixed blocks: header, divider, spacer, input, timestamp, overflow msg = 6.
// Recent section: divider + header + up to 5 section blocks = 7 more fixed.
// (100 - 6 - 7) / 3 = 29.
const MAX_SESSION_BLOCKS = 29
const MAX_RECENT = 5
let debounceTimer: ReturnType<typeof setTimeout> | null = null

type SessionRow = {
  name: string
  sessionId: string
  emoji: string
  desc: string
  age: string
  connected: boolean
  paused: boolean
  url: string
  watches: WatchEntry[]
  contextLinks: string[]
  artifacts: string[]
}

function getActiveSessions(): SessionRow[] {
  const all = [...registry.values()]
  const now = Date.now()

  all.sort((a, b) => b.lastActive - a.lastActive)

  const rows: SessionRow[] = []
  for (const s of all) {
    if (!tmuxHasSession(s.tmuxName)) continue
    const rawDesc = s.description || s.topic || s.tmuxName
    const desc = rawDesc.length > 80 ? rawDesc.slice(0, 77) + '...' : rawDesc
    const url = s.lastReplyId
      ? gateway.getMessageUrl(s.threadId, s.lastReplyId) || s.threadUrl || ''
      : s.threadUrl ?? ''
    rows.push({
      name: s.tmuxName,
      sessionId: s.sessionId,
      emoji: sessionEmoji(s.tmuxName),
      desc,
      age: formatDuration(now - s.createdAt),
      connected: transport.has(s.sessionId),
      paused: !!s.paused,
      url,
      watches: getWatchesBySession(s.sessionId),
      contextLinks: s.contextLinks ?? [],
      artifacts: s.artifacts ?? [],
    })
  }

  return rows
}

type RecentRow = {
  name: string
  desc: string
  duration: string
  url: string
  model: string
}

function getRecentCompleted(limit: number = MAX_RECENT): RecentRow[] {
  const threads = [...threadRegistry.values()]
    .filter(t => t.sessionHistory.some(h => h.endedAt))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, limit)

  return threads.map(t => {
    const last = t.sessionHistory[t.sessionHistory.length - 1]
    const duration = last?.endedAt && last?.startedAt
      ? formatDuration(last.endedAt - last.startedAt)
      : '?'
    const model = last?.model?.replace(/^claude-/, '').replace(/\[1m\]$/, '') ?? ''
    const rawDesc = t.description || t.topic || ''
    return {
      name: last?.tmuxName ?? '?',
      desc: rawDesc.length > 60 ? rawDesc.slice(0, 57) + '...' : rawDesc,
      duration,
      url: t.threadUrl ?? '',
      model,
    }
  })
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*~`]/g, '')
}

function buildSessionText(s: SessionRow): string {
  const link = s.url ? `<${s.url}|${s.name}>` : s.name
  return `${s.emoji} *${link}* — ${escapeMrkdwn(s.desc)} · _${s.age}_`
}


function buildHomeBlocks(sessions: SessionRow[]): any[] {
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Active Sessions (${sessions.length})` },
    },
  ]

  if (sessions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No sessions running._' },
    })
  } else {
    const shown = sessions.slice(0, MAX_SESSION_BLOCKS)
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i]
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: buildSessionText(s) },
      })
      const contextLines = assembleContextLines({
        watches: s.watches,
        artifacts: s.artifacts,
        contextLinks: s.contextLinks,
      })
      if (contextLines.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: contextLines.join('\n') }],
        })
      }
      if (i < shown.length - 1) blocks.push({ type: 'divider' })
    }
    if (sessions.length > MAX_SESSION_BLOCKS) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_+${sessions.length - MAX_SESSION_BLOCKS} more not shown_` }],
      })
    }
  }

  const recent = getRecentCompleted()
  if (recent.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Recent (${recent.length})` },
    })
    for (const r of recent) {
      const link = r.url ? `<${r.url}|${r.name}>` : r.name
      const modelTag = r.model ? ` · \`${r.model}\`` : ''
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${link} — ${escapeMrkdwn(r.desc)} · _${r.duration}_${modelTag}` },
      })
    }
  }

  blocks.push({ type: 'divider' })
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ' ' } })
  blocks.push({
    type: 'input',
    dispatch_action: true,
    element: {
      type: 'plain_text_input',
      action_id: 'home:spawn',
      placeholder: { type: 'plain_text', text: 'describe task... (prefix wt:repo for worktree)' },
      max_length: 500,
      dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
    },
    label: { type: 'plain_text', text: 'Spawn Session' },
  })
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `<!date^${Math.floor(Date.now() / 1000)}^Updated {time}|Updated just now>`,
    }],
  })

  return blocks
}

async function doUpdate(): Promise<void> {
  if (PLATFORM !== 'slack') return
  if (!('publishHomeTab' in gateway)) return

  const access = loadAccess()
  if (!access.allowFrom.length) return

  const userId = access.allowFrom[0]
  const sessions = getActiveSessions()
  const blocks = buildHomeBlocks(sessions)

  try {
    await (gateway as any).publishHomeTab(userId, blocks)
  } catch (err) {
    process.stderr.write(`dashboard: home tab publish failed for ${userId}: ${err}\n`)
  }
}

export function refreshDashboard(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    doUpdate().catch(err => {
      process.stderr.write(`dashboard: update failed: ${err}\n`)
    })
  }, DEBOUNCE_MS)
}

export function refreshDashboardNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  doUpdate().catch(err => {
    process.stderr.write(`dashboard: update failed: ${err}\n`)
  })
}

// Periodic fallback refresh — keeps dashboard fresh even when no session changes occur
setInterval(() => {
  doUpdate().catch(err => {
    process.stderr.write(`dashboard: periodic refresh failed: ${err}\n`)
  })
}, PERIODIC_REFRESH_MS)
