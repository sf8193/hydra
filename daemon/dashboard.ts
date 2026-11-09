/**
 * Dashboard — auto-updating session overview in Slack's App Home tab.
 */

import { gateway, PLATFORM } from './config.js'
import { registry, threadRegistry, sessionEmoji, type SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { formatDuration } from './util.js'
import { loadAccess, operatorIds } from './access.js'
import { getWatchesBySession, type WatchEntry } from '../connectors/github/pr-watch.js'
import { assembleContextLines } from './artifacts.js'
import { sessionLiveAsync } from './session-activity.js'
import { homeRecoverable, homeStatus, homeStatusAccessory, type HomeStatus } from './home-status.js'
import { confirmedStuckState, homeActionable, type BlockingState } from './pane-probe.js'
import { daemonPastOrphanGrace, occupancy, occupied } from './session-reachability.js'

const DEBOUNCE_MS = 2000
const PERIODIC_REFRESH_MS = 5 * 60 * 1000
const STATUS_CHECK_MS = 20_000
// Each session = up to 3 blocks (section + context + divider). Slack caps views at 100.
// Fixed blocks: header, dividers, spacer, input, timestamp, recent header = ~10.
// Active: up to 25 sessions × 3 blocks = 75. Recent: up to 5 × 2 = 10. Total ≤ 100.
const MAX_SESSION_BLOCKS = 25
const MAX_RECENT_BLOCKS = 5
let debounceTimer: ReturnType<typeof setTimeout> | null = null

type SessionRow = {
  name: string
  sessionId: string
  emoji: string
  desc: string
  age: string
  status: HomeStatus | null
  actionable: boolean
  url: string
  watches: WatchEntry[]
  contextLinks: string[]
  artifacts: string[]
  sessionType: string
  parent?: { name: string; url: string }
  buttonUrl: string
  oauthUrl: string | null
}

function sessionAppLink(s: SessionInfo): string {
  return gateway.getMessageAppLink?.(s.threadId, s.lastReplyId ?? gateway.getThreadAnchor(s.threadId)?.messageId ?? '') || sessionUrl(s)
}

function sessionUrl(s: SessionInfo): string {
  return s.lastReplyId
    ? gateway.getMessageUrl(s.threadId, s.lastReplyId) || s.threadUrl || ''
    : s.threadUrl ?? ''
}

async function sessionStatus(s: SessionInfo): Promise<{ status: HomeStatus; actionable: boolean; oauthUrl: string | null }> {
  const { live, working } = await sessionLiveAsync(s)
  const stuck = confirmedStuckState(s.tmuxName)
  const status = homeStatus({
    connected: transport.has(s.sessionId),
    live,
    working,
    stuck: stuck?.kind ?? null,
    lastReplyAt: s.lastReplyAt,
    lastUserMessageAt: s.lastUserMessageAt,
  })
  return { status, ...buttonTarget(status, stuck, s.sessionType, daemonPastOrphanGrace()) }
}

function buttonTarget(status: HomeStatus, stuck: BlockingState | null, sessionType: string, daemonWarm: boolean): { actionable: boolean; oauthUrl: string | null } {
  return {
    actionable: status === 'disconnected' ? homeRecoverable(sessionType, stuck, daemonWarm) : !stuck || homeActionable(stuck),
    oauthUrl: status === 'login_required' ? stuck?.oauthUrl ?? null : null,
  }
}

async function getActiveSessions(): Promise<SessionRow[]> {
  const all = [...registry.values()]
  const now = Date.now()

  all.sort((a, b) => b.lastActive - a.lastActive)

  const rows: SessionRow[] = []
  const live = all.filter(s => occupied(occupancy(s)))
  const statuses = await Promise.all(live.slice(0, MAX_SESSION_BLOCKS).map(sessionStatus))
  for (const [i, s] of live.entries()) {
    const rawDesc = s.description || s.topic || s.tmuxName
    const desc = rawDesc.length > 80 ? rawDesc.slice(0, 77) + '...' : rawDesc
    const url = sessionUrl(s)
    const parentInfo = s.parentId ? registry.get(s.parentId) : undefined
    rows.push({
      name: s.tmuxName,
      sessionId: s.sessionId,
      emoji: sessionEmoji(s.tmuxName),
      desc,
      age: formatDuration(now - s.createdAt),
      status: statuses[i]?.status ?? null,
      actionable: statuses[i]?.actionable ?? false,
      url,
      buttonUrl: statuses[i]?.oauthUrl ?? sessionAppLink(s),
      oauthUrl: statuses[i]?.oauthUrl ?? null,
      watches: getWatchesBySession(s.sessionId),
      contextLinks: s.contextLinks ?? [],
      artifacts: s.artifacts ?? [],
      sessionType: s.sessionType,
      parent: parentInfo ? { name: parentInfo.tmuxName, url: sessionUrl(parentInfo) } : undefined,
    })
  }

  return rows
}

type RecentRow = {
  name: string
  desc: string
  duration: string
  model: string
  url: string
}

function getRecentCompleted(limit: number = MAX_RECENT_BLOCKS): RecentRow[] {
  const now = Date.now()
  const threads = [...threadRegistry.values()]
    .filter(t => t.sessionHistory.some(h => h.endedAt != null))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, limit)

  return threads.map(t => {
    const last = t.sessionHistory[t.sessionHistory.length - 1]
    const duration = last?.endedAt && last?.startedAt
      ? formatDuration(last.endedAt - last.startedAt)
      : last?.endedAt ? formatDuration(now - t.createdAt) : '?'
    const model = last?.model?.replace(/^claude-/, '').replace(/\[1m\]$/, '') || ''
    return {
      name: last?.tmuxName ?? t.topic?.split('\n')[0].slice(0, 20) ?? '?',
      desc: (t.description || t.topic || '').slice(0, 60),
      duration,
      model,
      url: t.threadUrl ?? '',
    }
  })
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*~`]/g, '')
}

function buildSessionText(s: SessionRow): string {
  const link = s.url ? `<${s.url}|${s.name}>` : s.name
  const parent = s.parent ? ` ← ${s.parent.url ? `<${s.parent.url}|${s.parent.name}>` : s.parent.name}` : ''
  return `${s.emoji} *${link}*${parent} — ${escapeMrkdwn(s.desc)} · _${s.age}_`
}


function buildHomeBlocks(sessions: SessionRow[], recent: RecentRow[] = []): any[] {
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
        ...(s.status ? { accessory: homeStatusAccessory(s.status, s.sessionId, s.buttonUrl, s.actionable) } : {}),
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

  if (recent.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Recent (${recent.length})` },
    })
    for (const r of recent) {
      const link = r.url ? `<${r.url}|${escapeMrkdwn(r.name)}>` : escapeMrkdwn(r.name)
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

function homeTabUser(): string | null {
  if (PLATFORM !== 'slack' || !('publishHomeTab' in gateway)) return null
  return operatorIds(loadAccess())[0] ?? null
}

let publishedStatuses = ''
const statusKey = (rows: SessionRow[]) =>
  rows.slice(0, MAX_SESSION_BLOCKS).map(r => `${r.sessionId}=${r.status ?? ''}:${r.actionable}:${r.oauthUrl ?? ''}`).sort().join('|')

async function publish(onlyIfStatusChanged: boolean): Promise<void> {
  const userId = homeTabUser()
  if (!userId) return
  const sessions = await getActiveSessions()
  const key = statusKey(sessions)
  if (onlyIfStatusChanged && key === publishedStatuses) return
  const blocks = buildHomeBlocks(sessions, getRecentCompleted())

  try {
    await (gateway as any).publishHomeTab(userId, blocks)
    publishedStatuses = key
  } catch (err) {
    process.stderr.write(`dashboard: home tab publish failed for ${userId}: ${err}\n`)
  }
}

function coalesced(run: (onlyIfStatusChanged: boolean) => Promise<void>): (onlyIfStatusChanged?: boolean) => Promise<void> {
  let updating = false
  let queuedFull = false
  return async (onlyIfStatusChanged = false) => {
    if (updating) {
      if (!onlyIfStatusChanged) queuedFull = true
      return
    }
    updating = true
    let next = onlyIfStatusChanged
    for (;;) {
      queuedFull = false
      try {
        await run(next)
      } catch (err) {
        process.stderr.write(`dashboard: update failed: ${err}\n`)
      }
      if (!queuedFull) break
      next = false
    }
    updating = false
  }
}

const doUpdate = coalesced(publish)

export function refreshDashboard(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void doUpdate(), DEBOUNCE_MS)
}

export function refreshDashboardNow(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  void doUpdate()
}

// Periodic fallback refresh — keeps dashboard fresh even when no session changes occur
setInterval(() => void doUpdate(), PERIODIC_REFRESH_MS)

setInterval(() => void doUpdate(true), STATUS_CHECK_MS)

export const __test = process.env.NODE_ENV === 'test' ? { statusKey, coalesced, buttonTarget } : undefined
