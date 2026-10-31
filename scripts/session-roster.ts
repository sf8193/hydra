// Prints one line per live session: "<emoji> <name> | <thread link> | idle <N>d", newest first.
// The thread-digest and forgotten-weekly jobs use it as their check script, so the agent
// copies the emoji and link instead of guessing them. Reads <state dir>/sessions.json only.
// With --idle-days N it lists only sessions idle more than N days; no output means nothing to report.
import { readFileSync } from 'fs'
import { join } from 'path'
import { sessionEmoji } from '../daemon/session-catalog.js'

export type RosterSession = {
  tmuxName: string
  contentEmoji?: string
  threadUrl?: string
  anchorMessageId?: string
  anchorChannelId?: string
  lastActive: number
  deadAt?: number
}

const DAY_MS = 86_400_000

// A Slack permalink opens the thread only with thread_ts and cid; older stored links lack them.
function threadLink(s: RosterSession): string {
  const url = s.threadUrl
  if (!url) return '(no link)'
  if (url.includes('slack.com') && !url.includes('thread_ts=') && s.anchorMessageId && s.anchorChannelId) {
    return `${url}?thread_ts=${s.anchorMessageId}&cid=${s.anchorChannelId}`
  }
  return url
}

export function rosterLines(sessions: RosterSession[], now: number, minIdleDays = 0): string[] {
  return sessions
    .filter(s => !s.deadAt && (minIdleDays <= 0 || now - s.lastActive > minIdleDays * DAY_MS))
    .sort((a, b) => b.lastActive - a.lastActive)
    .map(s => `${s.contentEmoji || sessionEmoji(s.tmuxName)} ${s.tmuxName} | ${threadLink(s)} | idle ${Math.floor((now - s.lastActive) / DAY_MS)}d`)
}

if (import.meta.main) {
  const stateDir = process.env.HYDRA_STATE_DIR
  if (!stateDir) { console.error('session-roster: HYDRA_STATE_DIR is not set'); process.exit(1) }
  const i = process.argv.indexOf('--idle-days')
  const minIdleDays = i > 0 ? Number(process.argv[i + 1]) : 0
  if (!Number.isFinite(minIdleDays)) { console.error('session-roster: --idle-days needs a number'); process.exit(1) }
  const sessions = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')) as RosterSession[]
  const lines = rosterLines(sessions, Date.now(), minIdleDays)
  if (lines.length) console.log(lines.join('\n'))
}
