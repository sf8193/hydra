// A write-confined specialist runs on the operator's account, and the daemon acts with its authority for every bridge call. So it keeps the
// tools a restricted session keeps (BASE_TOOLS.restricted, never a second list), minus send_to_thread, and uses them only in its own conversation:
// no tool that starts, reaches, lists, reads or ends another session, and none that reads another conversation.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { executeTool } from '../bridge-dispatch.js'
import { gateway } from '../../infra/config.js'
import { registry } from '../../sessions/registry.js'
import { getToolsForSession, isToolAllowed } from '../../sessions/tool-surface.js'
import { UNIVERSAL_TOOLS } from '../../shared/tool-definitions.js'
import { BASE_TOOLS } from '../../shared/constants.js'
import { confinementIdFor } from '../restricted.js'
import { confinementSettings } from '../write-confinement.js'

process.stderr.write = (() => true) as any

const ALL: string[] = UNIVERSAL_TOOLS.map(t => t.name)
const KEPT: string[] = [...BASE_TOOLS.restricted].map(String).filter(t => t !== 'send_to_thread').sort()
const REFUSED: string[] = ['spawn_session', 'kill_session', 'peek_session', 'list_sessions', 'handoff', 'bind_conversation', 'unbind_conversation', 'watch_pr', 'unwatch_pr', 'list_watches', 'ask_predecessor', 'create_thread', 'send_to_thread', 'advance', 'extend_phase', 'report_usage']
const policy = () => { const w = { workdir: '/w', denyCommands: [], cannotRead: ['/s'], servers: [] }; return { specialist: 'ops', restricted: false, canOnlyWriteTo: w, id: confinementIdFor(w) } }
const mk = (id: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: '', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude',
  adapter: { stop: async () => {}, isAlive: () => true, isConnected: () => false }, sessionType: 'thread_owner', specialist: 'ops', ...extra,
} as any)
let spies: { mockRestore(): void }[] = []
const fetched: string[] = []
beforeEach(() => {
  fetched.length = 0
  spies = [spyOn(gateway, 'fetchMessages').mockImplementation((async (c: string) => { fetched.push(c); return [] }) as any)]
  mk('ct-confined', { policy: policy(), verified: true, capabilities: ['protocol_spawn', 'protocol_context'] })
  mk('ct-plain', { capabilities: ['protocol_spawn'] })
})
afterEach(() => { for (const s of spies) s.mockRestore(); registry.delete('ct-confined'); registry.delete('ct-plain') })

describe('the surface of a write-confined session', () => {
  test('is exactly the restricted session\'s kept tools minus send_to_thread, advertised and enforced, whatever capabilities it holds', () => {
    expect(ALL.filter(n => isToolAllowed('ct-confined', n)).sort()).toEqual(KEPT)
    expect(getToolsForSession('ct-confined').map(t => t.name as string).sort()).toEqual(KEPT)
  })
  test.each(REFUSED)('%s is refused at the gate with the cause, and does nothing', async tool => {
    expect(isToolAllowed('ct-confined', tool)).toBe(false)
    const r = await executeTool(tool, { target: 'x', type: 'result', text: 't', chat_id: 'th-ct-confined', name: 'n', session_id: 'other', path: '/x' }, 'ct-confined')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain(`${tool} is not available to a write-confined session`)
  })
  test('a session without write confinement keeps what it had', () => {
    for (const t of ['spawn_session', 'peek_session', 'list_sessions', 'send_to_thread', 'handoff']) expect(isToolAllowed('ct-plain', t)).toBe(true)
  })
})

describe('what the settings give its shell', () => {
  test('sandbox settings allow no unix socket, so its Bash cannot reach the daemon\'s (the live test shows connect() fails; this pins that nothing here opens it)', () => {
    const s = confinementSettings({ denyCommands: [], cannotRead: ['/s'] }) as { sandbox: { network?: unknown } }
    expect(s.sandbox.network).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('allowUnixSockets')
  })
})

describe('what it keeps is used in its own conversation only', () => {
  test('fetch_messages of its own thread works; of another conversation is refused and reads nothing', async () => {
    expect((await executeTool('fetch_messages', { channel: 'th-ct-confined' }, 'ct-confined')).isError).toBeFalsy()
    const r = await executeTool('fetch_messages', { channel: 'th-someone-else' }, 'ct-confined')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
    expect(fetched).toEqual(['th-ct-confined'])
  })
  test.each(['react', 'edit_message', 'delete_message', 'download_attachment'])('%s in another conversation is refused', async tool => {
    const r = await executeTool(tool, { chat_id: 'th-someone-else', message_id: 'm', text: 't', emoji: 'x' }, 'ct-confined')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
  })
  test('set_description describes only itself', async () => {
    expect((await executeTool('set_description', { session_id: 'ct-plain', description: 'd' }, 'ct-confined')).isError).toBe(true)
  })
  test('reply to a chat that is not its own conversation (a home_place, say) is refused', async () => {
    const r = await executeTool('reply', { chat_id: 'th-home-place', text: 'hi' }, 'ct-confined')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
  })
  test('a session without write confinement may still read another channel', async () => {
    expect((await executeTool('fetch_messages', { channel: 'th-someone-else' }, 'ct-plain')).isError).toBeFalsy()
  })
})
