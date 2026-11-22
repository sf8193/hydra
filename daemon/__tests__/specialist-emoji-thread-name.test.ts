// A specialist's `emoji` is the glyph its sessions wear in their thread names. Every name goes through `emojiOf` (the first name at spawn
// and every refresh after it), so these drive `refreshSessionVisual` and read the name the Discord and Slack gateways would set.
import { describe, test, expect, afterEach } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { registry, sessionEmoji } from '../../sessions/registry.js'
import { refreshSessionVisual, emojiOf } from '../../sessions/anchor-state.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { formatThreadName } from '../../gateways/discord.js'
import { slackSessionTitles } from '../../gateways/slack.js'
import type { SessionVisualOpts } from '../../gateways/gateway.js'

process.stderr.write = (() => true) as any

const decl = (id: string, over: Record<string, unknown> = {}) => ({ id, workdir: '/srv/x', kickoff: 'k', homePlace: '555', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...over })
const configure = (...specialists: ReturnType<typeof decl>[]) => _setHydraConfigForTesting({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', addresses: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: Object.fromEntries(specialists.map(s => [s.id, s])),
} as any)

const seen: SessionVisualOpts[] = []
;(gateway as any).updateSessionVisual = async (_t: string, o: SessionVisualOpts) => { seen.push(o) }
afterEach(() => { _setHydraConfigForTesting(undefined); seen.length = 0 })

let n = 0
/** A session in a thread, refreshed; the Discord thread name and the Slack title it gets. */
function names(over: Record<string, unknown> = {}, state?: { state?: 'killed' | 'live'; badge?: string }) {
  const id = `emoji-s${++n}`, threadId = `emoji-t${n}`
  registry.set(id, { sessionId: id, tmuxName: 'glyph', threadId, description: 'fixing auth middleware', createdAt: Date.now(), lastActive: Date.now(), listening: true, sessionType: 'thread_owner', ...over } as any)
  registry.setThread(threadId, id)
  refreshSessionVisual(threadId, { state: 'live', ...state })
  const opts = seen.at(-1)!
  return { discord: formatThreadName(opts).name, slack: slackSessionTitles(opts)[0] }
}

describe('without an emoji, a thread name is what it was', () => {
  test('a catalog session, golden (live, killed, paused, protocol, respawned)', () => {
    expect(sessionEmoji('glyph')).toBe('🔣')
    expect(names().discord).toBe('🔣 fixing auth middleware · glyph')
    expect(names().slack).toBe('🔣 glyph - fixing auth middleware')
    expect(names({}, { state: 'killed' }).discord).toBe('› ☠️ fixing auth middleware · glyph')
    expect(names({ paused: true }).discord).toBe('› ⏸ fixing auth middleware · glyph')
    expect(names({}, { badge: '⚔️²▲₃' }).discord).toBe('🔣 ⚔️²▲₃ fixing auth middleware · glyph')
    expect(names({ respawnCount: 2 }).discord).toBe('🔣 fixing auth middleware · glyph²')
  })

  test('a specialist that sets none, and a name outside the catalog', () => {
    configure(decl('ops'))
    expect(names({ policy: { specialist: 'ops', restricted: false } }).discord).toBe('🔣 fixing auth middleware · glyph')
    expect(names({ tmuxName: 'not-in-the-catalog' }).discord).toBe('🔹 fixing auth middleware · not-in-the-catalog')
  })
})

describe('with an emoji, it takes the default glyph, in the one position', () => {
  test('the session born for the specialist (its stored policy), on both gateways', () => {
    configure(decl('ops', { emoji: '🔐' }))
    const r = names({ policy: { specialist: 'ops', restricted: false } })
    expect(r.discord).toBe('🔐 fixing auth middleware · glyph')
    expect(r.slack).toBe('🔐 glyph - fixing auth middleware')
  })

  test('the presence grammar is unchanged: dead and paused still replace it, a protocol badge follows it, lineage still trails', () => {
    configure(decl('ops', { emoji: '🔐' }))
    const own = { policy: { specialist: 'ops', restricted: false } }
    expect(names(own, { state: 'killed' }).discord).toBe('› ☠️ fixing auth middleware · glyph')
    expect(names({ ...own, paused: true }).discord).toBe('› ⏸ fixing auth middleware · glyph')
    expect(names(own, { badge: '⚔️²▲₃' }).discord).toBe('🔐 ⚔️²▲₃ fixing auth middleware · glyph')
    expect(names({ ...own, respawnCount: 3 }).discord).toBe('🔐 fixing auth middleware · glyph³')
  })

  test('a per-conversation specialist\'s conversation session (named <id>_…) wears it', () => {
    configure(decl('crm', { emoji: '📇', sessions: 'per-conversation' }))
    expect(names({ tmuxName: 'crm_c0abc-1' }).discord).toBe('📇 fixing auth middleware · crm_c0abc-1')
  })

  test('a rename keeps it: a session born under the old id finds the specialist by renamed_from', () => {
    configure(decl('ledger', { emoji: '💰', renamedFrom: ['books'] }))
    expect(names({ policy: { specialist: 'books', restricted: false } }).discord).toBe('💰 fixing auth middleware · glyph')
  })

  test('respawn, handoff and every later refresh read hydra.toml live: an edit shows at the next refresh, and removing it restores the default', () => {
    const own = { policy: { specialist: 'ops', restricted: false } }
    configure(decl('ops', { emoji: '🔐' }))
    expect(names(own).discord).toStartWith('🔐 ')
    configure(decl('ops', { emoji: '🛠️' }))
    expect(names(own).discord).toStartWith('🛠️ ')
    configure(decl('ops'))
    expect(names(own).discord).toStartWith('🔣 ')
  })

  test('only that specialist\'s sessions: another specialist and an ordinary session keep the default', () => {
    configure(decl('ops', { emoji: '🔐' }), decl('crm'))
    expect(names({ policy: { specialist: 'crm', restricted: false } }).discord).toStartWith('🔣 ')
    expect(names().discord).toStartWith('🔣 ')
  })

  test('the first name, made at spawn before the session has a record, goes through the same function', () => {
    configure(decl('ops', { emoji: '🔐' }))
    expect(emojiOf({ tmuxName: 'glyph' }, 'ops')).toBe('🔐')
    expect(emojiOf({ tmuxName: 'glyph' }, undefined)).toBe('🔣')
  })
})

describe('no thread name is built from the default emoji alone', () => {
  // The first name is a template in doSpawnSession (it runs before a record exists, so a test cannot drive it); pin that it takes its glyph from emojiOf.
  test('the spawn-time thread name uses emojiOf', async () => {
    const src = await Bun.file(new URL('../../app/session-lifecycle.ts', import.meta.url)).text()
    expect(src).toMatch(/const threadName = `\$\{emojiOf\(/)
    expect(src).not.toMatch(/threadName = `\$\{sessionEmoji\(/)
  })
})

describe('hydra specialist show', () => {
  test('lists the emoji of a specialist that sets one, and only then', async () => {
    const { handleCLIRequest } = await import('../../app/cli-handler.js')
    const show = async (name: string) => (await handleCLIRequest({ type: 'cli', command: 'specialist', id: `show-${name}`, params: { action: 'show', name } }) as any).data
    configure(decl('ops', { emoji: '🔐' }), decl('crm'))
    expect(await show('ops')).toMatchObject({ emoji: '🔐' })
    expect(Object.hasOwn(await show('crm'), 'emoji')).toBe(false)
  })
})

describe('a session sitting in its specialist\'s own thread, with no stored policy', () => {
  test('is found by the thread, and wears the emoji', async () => {
    const { setSpecialistThread } = await import('../../sessions/specialists.js')
    configure(decl('ops', { emoji: '🔐' }))
    setSpecialistThread('ops', 'emoji-home-thread')
    const id = 'emoji-home-s'
    registry.set(id, { sessionId: id, tmuxName: 'glyph', threadId: 'emoji-home-thread', description: 'fixing auth middleware', createdAt: Date.now(), lastActive: Date.now(), listening: true, sessionType: 'thread_owner' } as any)
    registry.setThread('emoji-home-thread', id)
    refreshSessionVisual('emoji-home-thread', { state: 'live' })
    expect(formatThreadName(seen.at(-1)!).name).toBe('🔐 fixing auth middleware · glyph')
  })
})
