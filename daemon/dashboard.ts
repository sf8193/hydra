/**
 * Dashboard — auto-updating session overview in Slack's App Home tab.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { gateway, PLATFORM } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { transport } from './bridge-transport.js'
import { formatDuration, tmuxHasSession, safeSend, getContextPercent } from './util.js'
import { loadAccess } from './access.js'
import { getWatchesBySession, type WatchEntry } from './pr-watch.js'
import { assembleContextLines } from './artifacts.js'
const execFileAsync = promisify(execFile)

// killSession import removed from here — kill action now sends a confirmation DM
import { formatCostUsd } from './observability.js'

const DEBOUNCE_MS = 2000
const PERIODIC_REFRESH_MS = 5 * 60 * 1000
// Each session = up to 3 blocks (section + context + divider). Slack caps views at 100.
// Fixed blocks: header, divider, spacer, input, timestamp, overflow msg = 6. (100-6)/3 = 31.
const MAX_SESSION_BLOCKS = 31
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
  originType?: string
  originFrom?: string
  isFactoryBuilder?: boolean
  model?: string
  costUsd?: number
}

type GroupedSession = {
  session: SessionRow
  depth: number
  isLastChild: boolean
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
    const rawModel = s.capabilities?.model
    const model = rawModel
      ? rawModel.replace(/^claude-/, '').replace(/\[1m\]$/, '')
      : undefined
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
      originType: s.originType,
      originFrom: s.originFrom,
      isFactoryBuilder: s.isFactoryBuilder,
      model,
      costUsd: s.costUsd,
    })
  }

  return rows
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*~`]/g, '')
}

function buildOriginBadge(s: SessionRow): string {
  if (s.isFactoryBuilder) return '🏭 factory'
  switch (s.originType) {
    case 'fork': return '🍴 fork'
    case 'handoff': return '🤝 handoff'
    case 'resurrect': return '🫀 resurrect'
    default: return '🚀 spawn'
  }
}

function buildSessionText(s: SessionRow): string {
  const link = s.url ? `<${s.url}|${s.name}>` : s.name
  const origin = buildOriginBadge(s)
  const modelBadge = s.model ? ` · ${s.model}` : ''
  const costBadge = s.costUsd != null ? ` · 💰 ${formatCostUsd(s.costUsd)}` : ''
  return `${s.emoji} *${link}* — ${escapeMrkdwn(s.desc)} · _${s.age}_ · ${origin}${modelBadge}${costBadge}`
}


/**
 * Group sessions into a tree based on originFrom relationships.
 * Children are sessions whose originFrom matches a root session's name.
 * Returns a flat list with depth info for visual indentation.
 */
export function groupSessions(sessions: SessionRow[]): GroupedSession[] {
  // Build a name→row index for O(1) parent lookup
  const byName = new Map<string, SessionRow>()
  for (const s of sessions) byName.set(s.name, s)

  // Identify roots: sessions with no originFrom, or whose parent isn't in the active set
  const roots: SessionRow[] = []
  const childrenOf = new Map<string, SessionRow[]>()

  for (const s of sessions) {
    const parentName = s.originFrom
    if (parentName && byName.has(parentName)) {
      const siblings = childrenOf.get(parentName) ?? []
      siblings.push(s)
      childrenOf.set(parentName, siblings)
    } else {
      roots.push(s)
    }
  }

  // Flatten into ordered list with depth, preserving input order within each level.
  // Roots come before their children so truncation never orphans displayed children.
  const result: GroupedSession[] = []

  function visit(row: SessionRow, depth: number, isLastChild: boolean): void {
    result.push({ session: row, depth, isLastChild })
    const children = childrenOf.get(row.name) ?? []
    for (let i = 0; i < children.length; i++) {
      visit(children[i], depth + 1, i === children.length - 1)
    }
  }

  for (const root of roots) visit(root, 0, false)

  // Sort so roots always precede their children. The visit() walk already
  // produces this order, but if the input `sessions` array had children listed
  // before their parents (e.g. sorted by lastActive), a child could appear as
  // a root because its parent hadn't been indexed yet. Re-sort the flattened
  // output: group by root, roots first, children after.
  const rootOrder = new Map<string, number>()
  let idx = 0
  for (const g of result) {
    if (g.depth === 0) rootOrder.set(g.session.name, idx++)
  }
  result.sort((a, b) => {
    const aRoot = a.depth === 0 ? a.session.name : (a.session.originFrom ?? a.session.name)
    const bRoot = b.depth === 0 ? b.session.name : (b.session.originFrom ?? b.session.name)
    const aRootIdx = rootOrder.get(aRoot) ?? Infinity
    const bRootIdx = rootOrder.get(bRoot) ?? Infinity
    if (aRootIdx !== bRootIdx) return aRootIdx - bRootIdx
    // Within the same root group, root comes first, then children in original order
    if (a.depth !== b.depth) return a.depth - b.depth
    return 0
  })

  return result
}

function buildOverflowMenu(s: SessionRow): any {
  const options: any[] = [
    { text: { type: 'plain_text', text: '📸 Peek' }, value: `peek:${s.sessionId}` },
    { text: { type: 'plain_text', text: s.paused ? '▶️ Resume' : '⏸️ Pause' }, value: `pause:${s.sessionId}` },
    { text: { type: 'plain_text', text: '🔪 Kill' }, value: `kill:${s.sessionId}` },
  ]
  return {
    type: 'overflow',
    action_id: `home:action:${s.sessionId}`,
    options,
  }
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
    const grouped = groupSessions(sessions)
    const shown = grouped.slice(0, MAX_SESSION_BLOCKS)
    for (let i = 0; i < shown.length; i++) {
      const { session: s, depth } = shown[i]
      const isChild = depth > 0

      if (isChild) {
        // Children render as compact context blocks with ↳ indent
        const childText = `↳ ${buildSessionText(s)}`
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: childText }],
        })
      } else {
        // Root sessions get a full section block with overflow menu
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: buildSessionText(s) },
          accessory: buildOverflowMenu(s),
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
      }

      // Divider after a root group (when next item is also a root or this is last)
      const next = shown[i + 1]
      if (next && next.depth === 0) blocks.push({ type: 'divider' })
      else if (!next) blocks.push({ type: 'divider' })
    }
    if (grouped.length > MAX_SESSION_BLOCKS) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_+${grouped.length - MAX_SESSION_BLOCKS} more not shown_` }],
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

  const sessions = getActiveSessions()
  const blocks = buildHomeBlocks(sessions)

  await Promise.allSettled(access.allowFrom.map(async userId => {
    try {
      await (gateway as any).publishHomeTab(userId, blocks)
    } catch (err) {
      process.stderr.write(`dashboard: home tab publish failed for ${userId}: ${err}\n`)
    }
  }))
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

export async function handleHomeAction(actionValue: string, userId: string): Promise<void> {
  const [action, sessionId] = actionValue.split(':', 2)
  if (!sessionId) return

  const info = registry.get(sessionId)
  if (!info) {
    void gateway.send(userId, `_Session not found — it may have already ended._`).catch(() => {})
    return
  }

  switch (action) {
    case 'kill': {
      void gateway.sendDM(userId, `Kill **${info.tmuxName}**? Type \`kill ${info.tmuxName}\` to confirm.`).catch(() => {})
      break
    }
    case 'peek': {
      if (!tmuxHasSession(info.tmuxName)) {
        void gateway.send(userId, `_**${info.tmuxName}** tmux not running_`).catch(() => {})
        return
      }
      const ctx = getContextPercent(info.tmuxName)
      const duration = formatDuration(Date.now() - info.createdAt)
      const msgs = info.messageCount ?? 0
      const header = `📸 **${info.tmuxName}** · ${ctx} · ${msgs} msgs · ${duration}`
      try {
        const { stdout } = await execFileAsync(
          'tmux', ['capture-pane', '-t', info.tmuxName, '-p', '-S', '-60'],
          { encoding: 'utf8', timeout: 5000 },
        )
        const text = stdout.trimEnd()
        void gateway.send(userId, `${header}\n\`\`\`\n${(text || '(empty)').slice(-1800)}\n\`\`\``).catch(() => {})
      } catch {
        void gateway.send(userId, `${header}\n_Capture failed_`).catch(() => {})
      }
      break
    }
    case 'pause': {
      info.paused = !info.paused
      registry.debouncedPersist()
      refreshDashboardNow()
      const state = info.paused ? 'paused ⏸️' : 'resumed ▶️'
      void gateway.send(userId, `_**${info.tmuxName}** ${state}_`).catch(() => {})
      break
    }
    default:
      process.stderr.write(`dashboard: unknown home action: ${action}\n`)
  }
}

// Periodic fallback refresh — keeps dashboard fresh even when no session changes occur
setInterval(() => {
  doUpdate().catch(err => {
    process.stderr.write(`dashboard: periodic refresh failed: ${err}\n`)
  })
}, PERIODIC_REFRESH_MS)
