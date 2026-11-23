// The `react` tool posts a reaction where the platform shows one (Discord) and is a stated no-op where it does not (Slack): one table over both gateways (each gateway's own `postsReactions`, pinned in gateway-profiles.test.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { executeTool } from '../../app/bridge-dispatch.js'

process.stderr.write = (() => true) as any

const g = gateway as any
const original = { platform: g.platform, postsReactions: g.postsReactions, react: g.react }
const set = (key: string, value: unknown) => Object.defineProperty(g, key, { value, configurable: true })
afterEach(() => { set('platform', original.platform); set('postsReactions', original.postsReactions); g.react = original.react })

describe('react tool', () => {
  test.each([
    ['discord', 'reacted', 1],
    ['slack', 'no-op on Slack (reactions disabled)', 0],
  ] as const)('on %s: "%s", %d reaction posted', async (platform, text, posted) => {
    set('platform', platform)
    set('postsReactions', platform === 'discord')
    let calls = 0
    g.react = async () => { calls++ }
    const r = await executeTool('react', { chat_id: '123', message_id: '456', emoji: '👍' })
    expect(r.content[0]!.text).toBe(text)
    expect(calls).toBe(posted)
  })
})
