// `kill_session {destroy:true}` and `hydra kill --destroy`: kill, then delete the
// thread, through the same destroyThread step `kill +d` uses.
//
// What must hold: a session destroys only what it spawned, and refuses BEFORE
// killing anything; a thread another session answers in is never deleted from
// under it; a declined destroy leaves the kill standing and says so; main and the
// CLI keep their reach.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { engines } from '../../engines/instances.js'
import { executeTool } from '../bridge-dispatch.js'
import { handleCLIRequest } from '../cli-handler.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../../infra/config.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { sessionTokenHash } from '../cli-caller.js'
import { rmSync } from 'fs'
import { join } from 'path'

const PARENT_CH = 'parent-channel-ksd'
let deleted: string[] = []
let deleteFails = false
let orig: Record<string, unknown> = {}
let tmux: FakeTmux
let origStderr: typeof process.stderr.write
let seq = 0
const seeded = new Set<string>()
const threadsSeeded = new Set<string>()

beforeAll(() => {
  orig = { deleteThread: gateway.deleteThread, delete: gateway.delete, react: gateway.react, send: gateway.send, fetchChannel: gateway.fetchChannel, getThreadStarterInfo: gateway.getThreadStarterInfo, rp: registry.persist, tp: threadRegistry.persist }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})
afterAll(() => {
  Object.assign(gateway as any, { deleteThread: orig.deleteThread, delete: orig.delete, react: orig.react, send: orig.send, fetchChannel: orig.fetchChannel, getThreadStarterInfo: orig.getThreadStarterInfo })
  ;(registry as any).persist = orig.rp
  ;(threadRegistry as any).persist = orig.tp
})
beforeEach(() => {
  tmux = withFakeTmux()
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  deleted = []
  deleteFails = false
  Object.assign(gateway as any, {
    deleteThread: async (id: string) => { if (deleteFails) throw new Error('missing access'); deleted.push(id) },
    delete: async () => {},
    react: async () => {},
    send: async (c: string) => ({ id: 'm1', channelId: c }),
    fetchChannel: async () => ({ isThread: true, isDM: false, parentId: PARENT_CH }),
    getThreadStarterInfo: async () => ({ starterId: 'anchor' }),
  })
})
afterEach(() => {
  tmux.restore()
  for (const id of seeded) {
    const t = registry.get(id)?.threadId
    registry.delete(id)
    if (t) registry.deleteThread(t)
  }
  seeded.clear()
  for (const t of threadsSeeded) threadRegistry.threads.delete(t)
  threadsSeeded.clear()
  process.stderr.write = origStderr
})

function seed(name: string, threadId: string, extra: Partial<SessionInfo> = {}, hydraMade = true): SessionInfo {
  const info = {
    sessionId: `sess-ksd-${++seq}`, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: name, listening: false, engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner',
    anchorChannelId: PARENT_CH, anchorMessageId: 'anchor', ...extra,
  } as SessionInfo
  info.sessionTokenHash = sessionTokenHash(`tok-${info.sessionId}`)
  registry.set(info.sessionId, info)
  registry.setThread(threadId, info.sessionId)
  seeded.add(info.sessionId)
  threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [], ...(hydraMade && { hydraMade: true }) })
  threadsSeeded.add(threadId)
  tmux.alive(name)
  return info
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

describe('kill_session destroy', () => {
  test('a session destroys a child it spawned: killed, thread deleted, record gone', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('deleted its thread th-kid')
    expect(deleted).toEqual(['th-kid'])
    expect(registry.get(kid.sessionId)).toBeUndefined()
    expect(registry.get(pm.sessionId)).toBeDefined()
  })

  test('without destroy the thread survives, as before', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    const r = await executeTool('kill_session', { session_id: kid.sessionId }, pm.sessionId)
    expect(text(r)).toBe(`killed session ${kid.sessionId}`)
    expect(deleted).toEqual([])
  })

  test('a session cannot destroy one it did not spawn, and nothing is killed or deleted', async () => {
    const pm = seed('pm', 'th-pm')
    const other = seed('other', 'th-other', { parentId: 'someone-else' })
    const r = await executeTool('kill_session', { session_id: other.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('cannot destroy other — you can only destroy sessions you spawned')
    expect(deleted).toEqual([])
    expect(registry.get(other.sessionId)).toBeDefined()
  })

  test('a child cannot destroy its parent', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    const r = await executeTool('kill_session', { session_id: pm.sessionId, destroy: true }, kid.sessionId)
    expect(r.isError).toBe(true)
    expect(deleted).toEqual([])
  })

  test('a thread shared with another session is refused before the kill', async () => {
    const pm = seed('pm', 'th-shared')
    const kid = seed('kid', 'th-shared', { parentId: pm.sessionId })
    registry.setThread('th-shared', pm.sessionId)
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('its thread is also yours; nothing was killed')
    expect(deleted).toEqual([])
    expect(registry.get(kid.sessionId)).toBeDefined()
  })

  test('the thread refusal names a sibling that answers there', async () => {
    const pm = seed('pm', 'th-pm')
    seed('sib', 'th-kid', { parentId: pm.sessionId })
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(text(r)).toContain("its thread is also sib's")
    expect(deleted).toEqual([])
  })

  test('if the thread cannot be deleted the kill stands and the reply says so', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    deleteFails = true
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('killed kid, but its thread was NOT deleted')
    expect(text(r)).toContain('missing access')
    expect(deleted).toEqual([])
  })

  test('a thread hydra did not make for the spawn is not destroyable by a session, and nothing is killed', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-human', { parentId: pm.sessionId }, false)
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('its thread was not created for it by hydra')
    expect(deleted).toEqual([])
    expect(registry.get(kid.sessionId)).toBeDefined()
  })

  test('where threads cannot be deleted, nothing is killed', async () => {
    const pm = seed('pm', 'th-pm')
    const kid = seed('kid', 'th-kid', { parentId: pm.sessionId })
    ;(gateway as any).deleteThread = undefined
    const r = await executeTool('kill_session', { session_id: kid.sessionId, destroy: true }, pm.sessionId)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('kid was NOT killed')
    expect(registry.get(kid.sessionId)).toBeDefined()
  })

  test('main may destroy any session', async () => {
    const kid = seed('kid', 'th-kid', { parentId: 'whoever' }, false)
    const r = await executeTool('kill_session', { thread_id: 'th-kid', destroy: true })
    expect(text(r)).toContain('deleted its thread th-kid')
    expect(deleted).toEqual(['th-kid'])
    expect(registry.get(kid.sessionId)).toBeUndefined()
  })
})

describe('hydra kill --destroy', () => {
  // The CLI run in a session's shell presents its token (shared/caller.ts); with no claim it is the operator's shell.
  const req = (params: Record<string, unknown>, caller?: unknown) => ({ type: 'cli' as const, command: 'kill', id: `ksd-${++seq}`, params, ...(caller !== undefined && { caller }) })
  const as = (s: SessionInfo) => ({ token: `tok-${s.sessionId}` })

  test('kills then deletes the thread', async () => {
    seed('kid-cli', 'th-cli')
    const res = await handleCLIRequest(req({ name: 'kid-cli', destroy: true }))
    expect(res.ok).toBe(true)
    expect((res.data as any).destroyed).toBe('th-cli')
    expect(deleted).toEqual(['th-cli'])
  })

  test('plain kill leaves the thread', async () => {
    seed('kid-cli2', 'th-cli2')
    const res = await handleCLIRequest(req({ name: 'kid-cli2' }))
    expect(res.ok).toBe(true)
    expect(deleted).toEqual([])
  })

  test('a declined destroy is reported as a failure that names the kill', async () => {
    seed('kid-cli3', 'th-cli3')
    deleteFails = true
    const res = await handleCLIRequest(req({ name: 'kid-cli3', destroy: true }))
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('killed kid-cli3, but its thread was NOT deleted')
  })

  test('run from inside a session (its token) a destroy answers to the tool\'s rules: a stranger is refused, nothing killed', async () => {
    const pm = seed('pm-c', 'th-pm-c')
    seed('kid-cli4', 'th-cli4', { parentId: 'someone-else' })
    const res = await handleCLIRequest(req({ name: 'kid-cli4', destroy: true }, as(pm)))
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('you can only destroy sessions you spawned')
    expect(deleted).toEqual([])
    expect(registry.getByThread('th-cli4')).toBeDefined()
  })

  test('...a thread hydra did not make is refused, and a spawner\'s own hydra-made child is destroyed', async () => {
    const pm = seed('pm-c2', 'th-pm-c2')
    seed('kid-cli5', 'th-human5', { parentId: pm.sessionId }, false)
    const refused = await handleCLIRequest(req({ name: 'kid-cli5', destroy: true }, as(pm)))
    expect(refused.ok).toBe(false)
    expect(deleted).toEqual([])

    seed('kid-cli6', 'th-cli6', { parentId: pm.sessionId })
    const ok = await handleCLIRequest(req({ name: 'kid-cli6', destroy: true }, as(pm)))
    expect(ok.ok).toBe(true)
    expect(deleted).toEqual(['th-cli6'])
  })

  test('the operator\'s shell (no caller claim; main\'s shell is one) keeps its reach', async () => {
    seed('kid-cli7', 'th-human7', { parentId: 'x' }, false)
    const res = await handleCLIRequest(req({ name: 'kid-cli7', destroy: true }))
    expect(res.ok).toBe(true)
    expect(deleted).toEqual(['th-human7'])
  })

  // A caller that is in a session but cannot show which is refused, never promoted to the operator; nothing is killed.
  for (const [what, caller, params] of [
    ['a session\'s environment without a token', { inSession: true }, {}],
    ['a token no session holds', { token: 'forged' }, {}],
    ['an older CLI\'s self-reported callerSessionId, even "main"', undefined, { callerSessionId: 'main' }],
  ] as const) {
    test(`unverified: ${what}`, async () => {
      seed('kid-cli8', 'th-human8', { parentId: 'x' }, false)
      const res = await handleCLIRequest(req({ name: 'kid-cli8', destroy: true, ...params }, caller))
      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).toContain('Nothing was killed')
      expect(deleted).toEqual([])
      expect(registry.getByThread('th-human8')).toBeDefined()
    })
  }

  test('the token of a session that has ended (a crash left its record) is unverified: nothing is killed', async () => {
    const pm = seed('pm-c10', 'th-pm-c10')
    seed('kid-cli10', 'th-cli10', { parentId: pm.sessionId })
    pm.deadAt = Date.now(); rmSync(join(tmux.dir, 'alive-pm-c10'))   // its pane is gone
    const res = await handleCLIRequest(req({ name: 'kid-cli10', destroy: true }, as(pm)))
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('which has ended')
    expect(deleted).toEqual([])
    expect(registry.getByThread('th-cli10')).toBeDefined()
  })

  test('a session\'s token is the session, whatever else the request names', async () => {
    const pm = seed('pm-c9', 'th-pm-c9')
    seed('kid-cli9', 'th-cli9', { parentId: 'someone-else' })
    // A token wins over a self-reported id: the request cannot claim to be main.
    const res = await handleCLIRequest(req({ name: 'kid-cli9', destroy: true, callerSessionId: 'main' }, as(pm)))
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('you can only destroy sessions you spawned')
    expect(deleted).toEqual([])
  })
})
