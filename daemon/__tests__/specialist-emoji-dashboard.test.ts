// The Slack home-tab dashboard shows each live session with its emoji (daemon/dashboard.ts `getActiveSessions`): a session born for a specialist with
// `emoji = "🔐"` wears it there, and an ordinary session, a specialist with no emoji, and a name outside the catalog keep their catalog glyph (🔣, 🔣, 🔹).
// The dashboard publishes only on the Slack platform, a module-load constant, so this file is its own: it sets CHAT_PLATFORM before the first daemon import
// (the suite runs each file isolated) and drives `refreshDashboardNow` into a stubbed `publishHomeTab`.
import { describe, test, expect, afterAll } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const env = { p: process.env.CHAT_PLATFORM, b: process.env.SLACK_BOT_TOKEN, a: process.env.SLACK_APP_TOKEN }
process.env.CHAT_PLATFORM = 'slack'; process.env.SLACK_BOT_TOKEN = 'x'; process.env.SLACK_APP_TOKEN = 'x'
const { gateway, STATE_DIR, PLATFORM } = await import('../config.js')
for (const [k, v] of [['CHAT_PLATFORM', env.p], ['SLACK_BOT_TOKEN', env.b], ['SLACK_APP_TOKEN', env.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
const { registry } = await import('../sessions.js')
const { _setHydraConfigForTesting } = await import('../hydra-config.js')
const { refreshDashboardNow } = await import('../dashboard.js')
const { fakeAdapter } = await import('./test-harness.js')

process.stderr.write = (() => true) as any

const decl = (id: string, over: Record<string, unknown> = {}) => ({ id, workdir: '/srv/x', kickoff: 'k', home: '555', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...over })
const ACCESS = join(STATE_DIR, 'access.json')
writeFileSync(ACCESS, JSON.stringify({ dmPolicy: 'pairing', allowFrom: ['U1'], groups: {}, pending: {} }))
afterAll(() => { rmSync(ACCESS, { force: true }); _setHydraConfigForTesting(undefined) })

/** The home tab as the dashboard publishes it: every block's text, one string. */
function published(): Promise<string> {
  return new Promise((resolve, reject) => {
    ;(gateway as any).publishHomeTab = async (_user: string, blocks: unknown) => { resolve(JSON.stringify(blocks)) }
    setTimeout(() => reject(new Error('the dashboard did not publish')), 5000).unref()
    refreshDashboardNow()
  })
}

let n = 0
describe('dashboard.ts rows', () => {
  test('the platform is Slack here', () => { expect(PLATFORM).toBe('slack') })

  test('each live session\'s row wears its emoji', async () => {
    _setHydraConfigForTesting({
      operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
      people: { op: { id: 'op', addresses: ['slack:U1'], roles: [], name: 'op' } },
      specialists: { ops: decl('ops', { emoji: '🔐' }), plain: decl('plain') },
    } as any)
    const kinds = [
      { name: 'glyph', specialist: 'ops', glyph: '🔐' },     // born for a specialist with an emoji
      { name: 'glyph', glyph: '🔣' },                        // ordinary
      { name: 'glyph', specialist: 'plain', glyph: '🔣' },   // a specialist with no emoji
      { name: 'not-in-the-catalog', glyph: '🔹' },           // outside the catalog
    ]
    for (const k of kinds) {
      const id = `eve-dash-${++n}`
      registry.set(id, {
        sessionId: id, tmuxName: k.name, threadId: `${id}-thread`, topic: 'fixing auth middleware', description: 'fixing auth middleware', createdAt: Date.now(), lastActive: Date.now(),
        listening: false, engine: 'claude', sessionType: 'thread_owner', ...(k.specialist && { policy: { specialist: k.specialist, access: 'operator' } }),
        adapter: fakeAdapter({ isAlive: () => true, usage: () => null }),
      } as any)
      try {
        const tab = await published()
        expect(tab).toContain(`${k.glyph} *${k.name}* — fixing auth middleware`)
      } finally { registry.delete(id) }
    }
  })
})
