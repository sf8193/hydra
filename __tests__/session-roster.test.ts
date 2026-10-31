import { expect, test } from 'bun:test'
import { rosterLines } from '../scripts/session-roster'

const DAY = 86_400_000
const now = 1_800_000_000_000
const s = (tmuxName: string, daysIdle: number, extra = {}) => ({ tmuxName, lastActive: now - daysIdle * DAY, ...extra })

test('each session gets its own emoji, a dead one is dropped, newest first', () => {
  const out = rosterLines([s('orbit', 2), s('nova', 1), s('pixel', 3, { deadAt: now })], now)
  expect(out).toEqual([
    '💥 nova | (no link) | idle 1d',
    '🪐 orbit | (no link) | idle 2d',
  ])
})

test('a stored Slack link gets thread_ts and cid, a Discord link and a good Slack link stay as they are', () => {
  const slack = s('drift', 0, { threadUrl: 'https://a.slack.com/archives/D1/p123', anchorMessageId: '1.23', anchorChannelId: 'D1' })
  const good = s('flint', 0, { threadUrl: 'https://a.slack.com/archives/D1/p9?thread_ts=9&cid=D1', anchorMessageId: '9', anchorChannelId: 'D1' })
  const discord = s('ember', 0, { threadUrl: 'https://discord.com/channels/1/2/3' })
  const [a, b, c] = rosterLines([slack, good, discord], now)
  expect(a).toContain('https://a.slack.com/archives/D1/p123?thread_ts=1.23&cid=D1')
  expect(b).toContain('p9?thread_ts=9&cid=D1 |')
  expect(c).toContain('https://discord.com/channels/1/2/3 |')
})

test('idle-days keeps only sessions idle more than N days, and a contentEmoji wins', () => {
  const out = rosterLines([s('nova', 7), s('pixel', 8, { contentEmoji: '🧪' })], now, 7)
  expect(out).toEqual(['🧪 pixel | (no link) | idle 8d'])
})
