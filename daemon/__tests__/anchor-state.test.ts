// The anchor state of a session's thread: which of the four a session is in, and what the Discord anchor shows for each. `respawned_session` is the
// running session that has been respawned at least once; it is computed from `respawnCount` each time and stored nowhere.
import { describe, test, expect, afterEach } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { registry } from '../sessions.js'
import { refreshSessionVisual, ANCHOR_STATES } from '../anchor-state.js'
import { DiscordGateway } from '../../gateways/discord.js'
import { slackSessionStatus } from '../../gateways/slack.js'
import type { SessionVisualOpts } from '../../gateways/gateway.js'

process.stderr.write = (() => true) as any

const seen: SessionVisualOpts[] = []
;(gateway as any).updateSessionVisual = async (_t: string, o: SessionVisualOpts) => { seen.push(o) }
afterEach(() => { seen.length = 0 })

let n = 0
function stateOf(over: Record<string, unknown>, opts?: { state?: SessionVisualOpts['state'] }) {
  const id = `anchor-s${++n}`, threadId = `anchor-t${n}`
  registry.set(id, { sessionId: id, tmuxName: 'glyph', threadId, createdAt: Date.now(), lastActive: Date.now(), listening: true, sessionType: 'thread_owner', adapter: { isAlive: () => true, isConnected: () => true }, ...over } as any)
  registry.setThread(threadId, id)
  refreshSessionVisual(threadId, opts)
  return seen.at(-1)!.state
}

/** What the Discord anchor message is given for a visual update: the emoji, and the digit for respawns. */
async function anchorReaction(opts: SessionVisualOpts) {
  const enqueued: Array<{ channelId: string; emoji: string; countEmoji?: string }> = []
  const self = { renameThread: async () => {}, reactionQueue: { enqueue: (_id: string, r: { channelId: string; emoji: string; countEmoji?: string }) => { enqueued.push(r) } } }
  await DiscordGateway.prototype.updateSessionVisual.call(self, 't', opts)
  return enqueued[0]
}

describe('anchor state', () => {
  test('the four states, as one set', () => {
    expect([...ANCHOR_STATES]).toEqual(['live', 'crashed', 'killed', 'respawned_session'])
  })

  test('a running session is live until it has been respawned, then respawned_session', () => {
    expect(stateOf({ respawnCount: 0 })).toBe('live')
    expect(stateOf({})).toBe('live')
    expect(stateOf({ respawnCount: 1 })).toBe('respawned_session')
    expect(stateOf({ respawnCount: 3 })).toBe('respawned_session')
  })

  test('a dead session is crashed, whatever its respawn count', () => {
    expect(stateOf({ respawnCount: 2, adapter: { isAlive: () => false, isConnected: () => false }, deadAt: Date.now() })).toBe('crashed')
  })

  test('a respawn count never reaches the state of a session the caller marked killed', () => {
    expect(stateOf({ respawnCount: 3 }, { state: 'killed' })).toBe('killed')
  })

  test('Discord shows the respawn count as a digit on the anchor for respawned_session only', async () => {
    const base: SessionVisualOpts = { state: 'live', emoji: '🔭', sessionName: 'scout', anchorChannelId: 'c', anchorMessageId: 'm' }
    expect(await anchorReaction({ ...base, state: 'respawned_session', respawnCount: 2 })).toEqual({ channelId: 'c', emoji: '🔭', countEmoji: '3️⃣' })
    expect((await anchorReaction({ ...base, state: 'live', respawnCount: 2 }))?.countEmoji).toBeUndefined()
    expect(await anchorReaction({ ...base, state: 'killed', respawnCount: 2 })).toEqual({ channelId: 'c', emoji: '☠️', countEmoji: undefined })
  })

  test('Slack reads respawned_session as an active session', () => {
    expect(slackSessionStatus('respawned_session')).toBe('active')
  })
})
