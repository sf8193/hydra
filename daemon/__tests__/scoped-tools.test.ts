// The `scoped` session type: a specialist set to access = "workdir". Each removed tool is refused where it is enforced
// (isToolAllowed, and executeTool behind it), each kept tool is refused outside the session's own conversation, and no
// shape of an unregistered or half-registered caller falls back to a wider surface.
import { afterEach, describe, expect, test } from 'bun:test'
import { executeTool, scopedRefusal } from '../bridge-dispatch.js'
import { registry } from '../sessions.js'
import { getToolsForSession, isToolAllowed, noteDeclaredSessionType } from '../tool-surface.js'
import { UNIVERSAL_TOOLS } from '../../shared/tool-definitions.js'
import { computeToolsForSession } from '../bridge-tools.js'
import { BASE_TOOLS } from '../../shared/constants.js'

process.stderr.write = (() => true) as any

const ALL: string[] = UNIVERSAL_TOOLS.map(t => t.name)
const namesOf = (id: string): string[] => getToolsForSession(id).map(t => t.name).sort()
const KEPT = ['reply', 'react', 'edit_message', 'delete_message', 'fetch_messages', 'download_attachment', 'set_description']
const REMOVED = ['spawn_session', 'kill_session', 'peek_session', 'list_sessions', 'send_to_thread', 'handoff', 'bind_conversation', 'watch_pr', 'ask_predecessor']

const mk = (id: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'scoped', specialist: 'ops', ...extra,
} as any)
const ids: string[] = []
const scoped = (extra: Record<string, unknown> = {}) => { const id = `sc-${ids.length}-${Math.random().toString(36).slice(2, 7)}`; ids.push(id); mk(id, extra); return id }
afterEach(() => { while (ids.length) registry.delete(ids.pop()!) })

describe('the surface of a scoped session', () => {
  test('is exactly the kept tools, advertised and enforced, over every tool the daemon defines', () => {
    const id = scoped()
    expect(ALL.filter(n => isToolAllowed(id, n)).sort()).toEqual([...KEPT].sort())
    expect(namesOf(id)).toEqual([...KEPT].sort())
    expect([...BASE_TOOLS.scoped].map(String).sort()).toEqual([...KEPT].sort())
  })
  test.each(REMOVED)('%s is refused at isToolAllowed and at executeTool', async tool => {
    const id = scoped()
    expect(isToolAllowed(id, tool)).toBe(false)
    const r = await executeTool(tool, {}, id)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`${tool} is not available to a scoped session: it has set_description (on itself) and, each only in its own conversation, reply, react, edit_message, delete_message, fetch_messages, download_attachment`)   // once: the wrapper does not repeat the tool name
  })
  test('no capability or predecessor grants a scoped session a removed tool', () => {
    const id = scoped({ capabilities: ['protocol_spawn', 'protocol_context', 'main_handoff'], predecessor: { engine: 'claude', fork: { claudeSessionId: 'p', parentName: 'x' }, cwd: '/x' } })
    for (const tool of [...REMOVED, 'advance', 'extend_phase']) expect(isToolAllowed(id, tool)).toBe(false)
    expect(namesOf(id)).not.toContain('ask_predecessor')
  })
  test('computeToolsForSession itself grants no capability to a scoped type (the guard is live, not decoration)', () => {
    const plain = computeToolsForSession('scoped', new Set()).map(t => t.name).sort()
    const loaded = computeToolsForSession('scoped', new Set(['protocol_spawn', 'protocol_context', 'main_handoff', 'predecessor', 'conversations'])).map(t => t.name).sort()
    expect(loaded).toEqual(plain)
    expect(computeToolsForSession('thread_owner', new Set(['protocol_spawn', 'conversations'])).map(t => t.name)).toContain('bind_conversation')
  })
  test('reply is advertised without files', () => {
    const reply = getToolsForSession(scoped()).find(t => t.name === 'reply')! as { inputSchema: { properties: Record<string, unknown> } }
    expect(Object.keys(reply.inputSchema.properties).sort()).toEqual(['chat_id', 'reply_to', 'text'])
  })
})

describe('an unknown or unregistered caller is never handed thread_owner tools when it is scoped', () => {
  test('a bridge that declared scoped, with no registry record, gets the scoped surface', () => {
    noteDeclaredSessionType('ghost-scoped', 'scoped')
    expect(ALL.filter(n => isToolAllowed('ghost-scoped', n)).sort()).toEqual([...KEPT].sort())
    expect(namesOf('ghost-scoped')).toEqual([...KEPT].sort())
    for (const tool of REMOVED) expect(isToolAllowed('ghost-scoped', tool)).toBe(false)
  })
  test('a record that says scoped wins over a bridge that declares nothing', () => {
    const id = scoped()
    expect(isToolAllowed(id, 'spawn_session')).toBe(false)
  })
  test('a record of another type whose bridge declares scoped is narrowed, never widened', () => {
    const id = scoped({ sessionType: 'thread_owner' })
    expect(isToolAllowed(id, 'spawn_session')).toBe(true)
    noteDeclaredSessionType(id, 'scoped')
    expect(isToolAllowed(id, 'spawn_session')).toBe(false)
  })
  test('declaring any other type changes nothing', () => {
    noteDeclaredSessionType('ghost-owner', 'thread_owner')
    expect(isToolAllowed('ghost-owner', 'spawn_session')).toBe(true)   // today's behaviour for an unregistered id, unchanged
  })
  test('an unregistered declared-scoped caller reaches no conversation at all', async () => {
    noteDeclaredSessionType('ghost-scoped-2', 'scoped')
    const r = await executeTool('reply', { chat_id: 'slack:C1:1.0', text: 'x' }, 'ghost-scoped-2')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
  })
})

describe('a kept tool works only in the session\'s own conversation', () => {
  const own = (id: string) => registry.get(id)!.threadId
  test.each([['reply', 'chat_id'], ['react', 'chat_id'], ['edit_message', 'chat_id'], ['delete_message', 'chat_id'], ['download_attachment', 'chat_id'], ['fetch_messages', 'channel']])('%s outside its own conversation is refused', async (tool, key) => {
    const id = scoped()
    for (const other of ['th-someone-else', '123456789', 'slack:C0OTHER:1.0', 'slack:dm', '']) {
      expect(scopedRefusal(id, tool, { [key]: other, text: 'x', message_id: 'm', emoji: 'x' })).toBe(other ? `${tool}: ${key} ${other} is not this session's own conversation; a scoped session acts only in its own thread or in a Slack conversation bound to its specialist` : `${tool}: ${key} is required: pass the ${key} of ${key === 'chat_id' ? 'the message you are answering' : 'the conversation you are reading'}`)
    }
    expect(scopedRefusal(id, tool, { text: 'x' })).toBe(key === 'chat_id' ? `${tool}: chat_id is required: pass the chat_id of the message you are answering` : `${tool}: channel is required: pass the channel of the conversation you are reading`)   // no place named at all
    const r = await executeTool(tool, { [key]: 'th-someone-else', text: 'x', message_id: 'm', emoji: 'x' }, id)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("not this session's own conversation")
  })
  test.each([['reply', 'chat_id'], ['react', 'chat_id'], ['edit_message', 'chat_id'], ['delete_message', 'chat_id'], ['download_attachment', 'chat_id'], ['fetch_messages', 'channel']])('%s in its own session thread passes the scope check', (tool, key) => {
    const id = scoped()
    expect(scopedRefusal(id, tool, { [key]: own(id), text: 'x' })).toBeUndefined()
  })
  test('reply never carries files, even into its own thread', () => {
    const id = scoped()
    expect(scopedRefusal(id, 'reply', { chat_id: own(id), text: 'x', files: ['/etc/passwd'] })).toBe('reply: a scoped session posts text only, so remove files (attachments are not sent)')
    expect(scopedRefusal(id, 'reply', { chat_id: own(id), text: 'x', files: [] })).toBeUndefined()
  })
  test('set_description changes only its own description', () => {
    const id = scoped(); const other = scoped()
    expect(scopedRefusal(id, 'set_description', { session_id: other, description: 'x' })).toBe("set_description: a scoped session describes only itself; session_id must be this session's own")
    expect(scopedRefusal(id, 'set_description', { session_id: id, description: 'x' })).toBeUndefined()
  })
  test('another session\'s thread is not its own, even by the same specialist', () => {
    const a = scoped(); const b = scoped()
    expect(scopedRefusal(a, 'reply', { chat_id: own(b), text: 'x' })).toContain("not this session's own conversation")
  })
})
