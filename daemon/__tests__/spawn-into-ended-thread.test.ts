// A spawn into a thread whose session has ended answers to that thread's lineage (lineage.ts). Before, any session could spawn a child into
// an ended hydra-made thread, inherit the thread's `hydraMade`, then kill and destroy the child through the live path: the thread was gone.
//
// What must hold:
//  - by tool, by CLI and by the message the thread hangs on: only the lineage's owner (the spawner, or its handoff successor), main and the
//    operator may spawn into an ended thread; a sibling, a stranger, a protocol guest or participant, and a caller that cannot show which
//    session it is are refused before anything is replaced.
//  - hydra's own starts in the thread (resume, respawn, revive, handoff) are not spawns into it, and keep the entry's `hydraMade`.
//  - a session the lineage's owner spawns into the thread continues that lineage: the owner may still destroy it, live or ended. One that
//    main or the operator spawns in is not hydra-made for: neither the live nor the ended destroy deletes the thread through it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { doSpawnSession } from '../../app/session-lifecycle.js'
import { registry, threadRegistry, type SessionInfo, type SpawnOpts } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { engines } from '../../sessions/engine-instances.js'
import { executeTool } from '../../app/bridge-dispatch.js'
import { handleCLIRequest } from '../../app/cli-handler.js'
import { callerRefusal, endedDestroyRefusal } from '../../app/destroy.js'
import { sessionTokenHash } from '../../sessions/cli-caller.js'
import { registerProtocol, _resetForTesting as resetProtocols } from '../../sessions/protocol-registry.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { fakeAdapter } from './test-harness.js'

const PARENT = '1563248896690626651'
const NEW_THREAD = '1573000000000000777'
// Thread ids (Discord snowflakes) by role.
const PM_T = '1573000000000000101', KID_T = '1573000000000000102', SIB_T = '1573000000000000103', STR_T = '1573000000000000104'

const launched: Array<{ sessionId: string; sessionToken?: string }> = []
const fakeClaude = {
  provider: 'claude', channel: 'bridge',
  launch: async (i: { sessionId: string; sessionToken?: string }) => { launched.push(i); return { provider: 'claude', model: 'claude-x', identity: { claudeSessionId: 'c1' } } },
  stop: async () => ({ status: 'stopped' }), isAlive: () => false, surface: () => null,
}
const orig: Record<string, any> = {}
let fake: FakeTmux
const created: string[] = []
let existingOnMessage = false
let slackLike = false   // Slack's createThread on a message names the thread `channel:ts` and never refuses

beforeAll(() => {
  orig.stderr = process.stderr.write
  process.stderr.write = (() => true) as any
  fake = withFakeTmux()
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'deleteThread', 'delete', 'react'] as const) orig[k] = (gateway as any)[k]
  orig.claude = engines.claude; orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist; orig.cwd = process.env.SPAWN_CWD
  engines.claude = fakeClaude as any
  ;(gateway as any).send = async (c: string) => ({ id: 'anchor-1', channelId: c })
  ;(gateway as any).createThread = async (c: string, _n: string, o?: { messageId?: string }) => {
    if (existingOnMessage && o?.messageId) throw Object.assign(new Error('exists'), { code: 'MessageExistingThread' })
    if (slackLike && o?.messageId) return { id: o.messageId }
    created.push(c); return { id: NEW_THREAD }
  }
  ;(gateway as any).deleteThread = async () => {}
  ;(gateway as any).delete = async () => {}
  ;(gateway as any).react = async () => {}
  // A thread is any id but the parent channel.
  ;(gateway as any).fetchChannel = async (id: string) => id === PARENT ? { isThread: false, isDM: false, parentId: null, id } : { isThread: true, isDM: false, parentId: PARENT, id }
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  ;(transport as any).has = () => false
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = process.cwd()
})
afterAll(() => {
  engines.claude = orig.claude
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'deleteThread', 'delete', 'react'] as const) (gateway as any)[k] = orig[k]
  ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
  if (orig.cwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.cwd
  fake.restore()
  process.stderr.write = orig.stderr
})
beforeEach(() => { launched.length = 0; created.length = 0; existingOnMessage = false; slackLike = false })
afterEach(() => {
  for (const s of [...registry.values()]) { registry.delete(s.sessionId); registry.deleteThread(s.threadId) }
  for (const t of [PM_T, KID_T, SIB_T, STR_T, NEW_THREAD]) threadRegistry.threads.delete(t)
  resetProtocols()
})

let seq = 0
/** A live session owning `threadId`, with a token its CLI presents (`tok-<id>`). */
function live(name: string, threadId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const info = {
    sessionId: `sie-${name}-${++seq}`, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => true }), ...over,
  } as SessionInfo
  info.sessionTokenHash = sessionTokenHash(`tok-${info.sessionId}`)
  registry.set(info.sessionId, info)
  if (info.sessionType !== 'thread_guest') registry.setThread(threadId, info.sessionId)
  fake.alive(name)
  return info
}
/** A thread hydra made for a child `pm` spawned; the child has ended (its dead record is still in the registry, as after a crash). */
// Its id is fresh each time: a kill of an earlier test's record of the same id may still be in flight (killSession skips an id it is killing).
let deadKid = ''
function endedChild(spawnerThread: string | undefined, threadId = KID_T): void {
  deadKid = `kid-gone-${++seq}`
  threadRegistry.threads.set(threadId, { threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, hydraMade: true, parentChannelId: PARENT,
    sessionHistory: [{ sessionId: deadKid, tmuxName: 'kid', originType: 'spawn', engine: 'claude', startedAt: 1, endedAt: 2, messageCount: 0, hydraMade: true, ...(spawnerThread && { spawnerThreadId: spawnerThread }) }] })
  registry.set(deadKid, { sessionId: deadKid, tmuxName: 'kid', topic: 't', threadId, createdAt: 1, lastActive: 1, listening: false, engine: 'claude',
    sessionType: 'thread_owner', deadAt: 2, adapter: fakeAdapter({ isAlive: () => false, stop: async () => undefined }) } as any)
  registry.setThread(threadId, deadKid)
}
const spawnInto = (askedBy: SpawnOpts['askedBy'], threadId = KID_T) => doSpawnSession('t', threadId, undefined, askedBy === undefined ? {} : { askedBy })
const lastEntry = (t: string) => threadRegistry.get(t)!.sessionHistory.at(-1)!

describe('who may spawn into an ended thread', () => {
  test('the lineage owner may; its new session continues the lineage (hydra-made for, as the thread was)', async () => {
    const pm = live('pm', PM_T)
    endedChild(PM_T)
    const r = await spawnInto(pm.sessionId)
    expect(r.threadId).toBe(KID_T)
    expect(lastEntry(KID_T).hydraMade).toBe(true)
    expect(threadRegistry.get(KID_T)!.hydraMade).toBe(true)   // the anchor is still hydra's (destroyThreadById keeps it only otherwise)
  })
  test('its handoff successor (the thread\'s owner now) may', async () => {
    live('pm', PM_T)
    const successor = live('pm2', PM_T)   // setThread: the successor owns the thread
    endedChild(PM_T)
    expect((await spawnInto(successor.sessionId)).threadId).toBe(KID_T)
  })
  test('main and the operator (no askedBy) may', async () => {
    endedChild(PM_T)
    expect((await spawnInto(undefined)).threadId).toBe(KID_T)
  })
  for (const who of ['sibling', 'stranger', 'unregistered'] as const) {
    test(`a ${who} is refused before the dead record is replaced, and nothing launches`, async () => {
      live('pm', PM_T)
      const caller = who === 'sibling' ? live('sib', SIB_T, { parentId: 'whoever' }).sessionId : who === 'stranger' ? live('str', STR_T).sessionId : 'no-such-session'
      endedChild(PM_T)
      await expect(spawnInto(caller)).rejects.toThrow('cannot spawn into thread')
      expect(launched).toEqual([])
      expect(registry.getByThread(KID_T)).toBe(deadKid)
      expect(threadRegistry.get(KID_T)!.sessionHistory).toHaveLength(1)
    })
  }
  test('a protocol guest in the spawner\'s thread is refused: in the thread is not owning it', async () => {
    live('pm', PM_T)
    const critic = live('critic', PM_T, { sessionType: 'thread_guest' })
    endedChild(PM_T)
    await expect(spawnInto(critic.sessionId)).rejects.toThrow('cannot spawn into thread')
  })
  test('a protocol participant that owns the spawner\'s thread is refused', async () => {
    const pm = live('pm', PM_T)
    registerProtocol('spawn-into-test', { getByThread: () => false, isParticipant: id => id === pm.sessionId, onReply: () => {}, onDisconnect: () => {}, onReconnect: () => {} })
    endedChild(PM_T)
    await expect(spawnInto(pm.sessionId)).rejects.toThrow('cannot spawn into thread')
  })
  test('a caller that could not show which session it is (null) is refused, and told why', async () => {
    endedChild(PM_T)
    await expect(spawnInto(null)).rejects.toThrow('showed no valid session token')
  })
  test('an ended thread with no recorded spawner is refused to every session (as an ended destroy is)', async () => {
    const pm = live('pm', PM_T)
    endedChild(undefined)
    await expect(spawnInto(pm.sessionId)).rejects.toThrow('cannot spawn into thread')
  })
  test('by the message the thread hangs on (its anchor): the same refusal', async () => {
    const str = live('str', STR_T)
    endedChild(PM_T)
    existingOnMessage = true
    await expect(doSpawnSession('t', PARENT, KID_T, { askedBy: str.sessionId })).rejects.toThrow('cannot spawn into thread')
    expect(launched).toEqual([])
  })
  test('by the message, where the gateway names the existing thread instead of refusing (Slack): the same refusal', async () => {
    const str = live('str', STR_T)
    endedChild(PM_T)
    slackLike = true
    await expect(doSpawnSession('t', PARENT, KID_T, { askedBy: str.sessionId })).rejects.toThrow('cannot spawn into thread')
    expect(launched).toEqual([])
    expect(registry.getByThread(KID_T)).toBe(deadKid)
  })
  test('not refused here: a thread hydra never had a session in, and a thread a live session is in (refused for everyone, as before)', async () => {
    const str = live('str', STR_T)
    expect((await spawnInto(str.sessionId, '1573000000000000999')).threadId).toBe('1573000000000000999')
    threadRegistry.threads.delete('1573000000000000999')
    const pm = live('pm', PM_T)
    await expect(spawnInto(str.sessionId, PM_T)).rejects.toThrow('thread has a live session')
    void pm
  })
})

describe('hydra\'s own starts in a thread continue it', () => {
  test('a session spawning into a hydra-made thread with no session history owns no lineage there: its entry is not made for', async () => {
    const str = live('str', STR_T)
    threadRegistry.threads.set(KID_T, { threadId: KID_T, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, hydraMade: true, sessionHistory: [] })
    await spawnInto(str.sessionId)
    expect(lastEntry(KID_T).hydraMade).toBe(false)
  })
  test('a respawn, revive or handoff (existingThreadId) is never refused, and keeps the entry\'s hydraMade', async () => {
    const str = live('str', STR_T)
    endedChild(PM_T)
    const r = await doSpawnSession('t', undefined, undefined, { existingThreadId: KID_T, resurrectFrom: 'kid', askedBy: str.sessionId })
    expect(r.threadId).toBe(KID_T)
    expect(lastEntry(KID_T).hydraMade).toBe(true)
  })
  test('...and a start that continues a session main spawned in keeps its false', async () => {
    endedChild(PM_T)
    const into = await spawnInto(undefined)
    expect(lastEntry(KID_T).hydraMade).toBe(false)
    registry.get(into.sessionId)!.deadAt = 3
    ;(registry.get(into.sessionId) as any).adapter = fakeAdapter({ isAlive: () => false, stop: async () => undefined })
    await doSpawnSession('t', undefined, undefined, { existingThreadId: KID_T, resurrectFrom: 'kid' })
    expect(lastEntry(KID_T).hydraMade).toBe(false)
  })
  test('a fresh thread hydra makes is hydra-made for its session', async () => {
    const r = await doSpawnSession('t', PARENT)
    expect(r.threadId).toBe(NEW_THREAD)
    expect(lastEntry(NEW_THREAD).hydraMade).toBe(true)
  })
})

describe('the takeover is closed end to end', () => {
  test('the owner that spawns back into its child\'s ended thread may still destroy it, live and after it ends', async () => {
    const pm = live('pm', PM_T)
    endedChild(PM_T)
    // As spawn_session does: the asker is the new session's parent.
    const into = await doSpawnSession('t', KID_T, undefined, { askedBy: pm.sessionId, parentId: pm.sessionId })
    const child = registry.get(into.sessionId)!
    expect(callerRefusal(pm, child, 'destroy')).toBeUndefined()
    registry.delete(child.sessionId); registry.deleteThread(KID_T)
    expect(endedDestroyRefusal(pm.sessionId, KID_T, 'kid')).toBeUndefined()
  })
  test('a session that main or the operator spawns into an ended thread is not hydra-made for: no session destroys through it, live or ended', async () => {
    const pm = live('pm', PM_T)
    endedChild(PM_T)
    // No asker (main, the operator); even were it given pm as its parent, the thread is not made for it.
    const into = await doSpawnSession('t', KID_T, undefined, { parentId: pm.sessionId })
    expect(lastEntry(KID_T).spawnerThreadId).toBe(PM_T)
    expect(lastEntry(KID_T).hydraMade).toBe(false)
    const child = registry.get(into.sessionId)!
    expect(callerRefusal(pm, child, 'destroy')).toContain('not created for it by hydra')
    registry.delete(child.sessionId); registry.deleteThread(KID_T)
    expect(endedDestroyRefusal(pm.sessionId, KID_T, 'kid')).toContain('cannot destroy')
  })
  test('an old entry without the field reads the thread\'s: the spawner\'s destroy is as before', () => {
    const pm = live('pm', PM_T)
    endedChild(PM_T)
    delete (lastEntry(KID_T) as any).hydraMade
    expect(endedDestroyRefusal(pm.sessionId, KID_T, 'kid')).toBeUndefined()
    threadRegistry.get(KID_T)!.hydraMade = undefined
    expect(endedDestroyRefusal(pm.sessionId, KID_T, 'kid')).toContain('cannot destroy')
  })
})

describe('the callers pass who asked', () => {
  test('spawn_session: a stranger is refused, the owner is not', async () => {
    const pm = live('pm', PM_T)
    const str = live('str', STR_T)
    endedChild(PM_T)
    const r = await executeTool('spawn_session', { topic: 't', chat_id: KID_T }, str.sessionId)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('cannot spawn into thread')
    const ok = await executeTool('spawn_session', { topic: 't', chat_id: KID_T }, pm.sessionId)
    expect(ok.isError).toBeFalsy()
  })
  /** Runs `fn` with the gateway's `threadMention` set (or removed), then puts it back. */
  async function withMention<T>(mention: ((id: string) => string) | undefined, fn: () => Promise<T>): Promise<T> {
    const g = gateway as any
    const had = Object.getOwnPropertyDescriptor(g, 'threadMention')
    g.threadMention = mention
    try { return await fn() } finally { if (had) Object.defineProperty(g, 'threadMention', had); else delete g.threadMention }
  }
  const spawnIn = async (chat_id: string) => (await executeTool('spawn_session', { topic: 't', chat_id })).content[0].text
  test('spawn_session names the new thread with the gateway\'s mention, and keeps the url beside it', async () => {
    const text = await withMention(id => `<#${id}>`, () => spawnIn(PARENT))
    expect(text).toContain(`mention: <#${NEW_THREAD}>, url: https://x/thread`)
  })
  test('spawn_session gives no mention where the gateway has none: the url alone', async () => {
    const text = await withMention(undefined, () => spawnIn(PARENT))
    expect(text).not.toContain('mention:')
    expect(text).toContain('url: https://x/thread')
  })
  test('spawn_session asked from a Slack conversation gives no mention: its reader is not in the gateway\'s chat, so the url alone points at the thread', async () => {
    const text = await withMention(id => `<#${id}>`, () => spawnIn('slack:C0TEST:1700000000.000100'))
    expect(text).not.toContain('mention:')
    expect(text).toContain('url: https://x/thread')
  })
  test('spawn_session from main is not asked', async () => {
    endedChild(PM_T)
    const ok = await executeTool('spawn_session', { topic: 't', chat_id: KID_T })
    expect(ok.isError).toBeFalsy()
  })
  const spawnCli = (caller?: unknown) => handleCLIRequest({ type: 'cli', command: 'spawn', id: `sie-${++seq}`, params: { prompt: 't', channel: KID_T, initiator: 'x', idempotencyKey: `k-${seq}`, quiet: true }, ...(caller !== undefined && { caller }) })
  test('hydra spawn --channel: a stranger\'s token is refused, the owner\'s is not, the operator\'s shell is not', async () => {
    const pm = live('pm', PM_T)
    const str = live('str', STR_T)
    endedChild(PM_T)
    const refused = await spawnCli({ token: `tok-${str.sessionId}` })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toContain('cannot spawn into thread')
    expect((await spawnCli({ token: `tok-${pm.sessionId}` })).ok).toBe(true)
    endedChild(PM_T)
    expect((await spawnCli()).ok).toBe(true)
  })
  test('hydra spawn --channel from a session\'s environment with no token is refused, not the operator', async () => {
    endedChild(PM_T)
    const r = await spawnCli({ inSession: true })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('showed no valid session token')
  })
})

describe('every launch is given a token; its record keeps only the hash', () => {
  test('the engine gets the token, the record its sha256, and no two launches share one', async () => {
    const a = await doSpawnSession('t', PARENT)
    threadRegistry.threads.delete(NEW_THREAD); registry.deleteThread(NEW_THREAD)
    const b = await doSpawnSession('t', PARENT)
    const [la, lb] = launched
    expect(la.sessionToken).toMatch(/^[0-9a-f]{64}$/)
    expect(la.sessionToken).not.toBe(lb.sessionToken)
    expect(registry.get(a.sessionId)!.sessionTokenHash).toBe(sessionTokenHash(la.sessionToken!))
    expect(registry.get(b.sessionId)!.sessionTokenHash).toBe(sessionTokenHash(lb.sessionToken!))
    expect(JSON.stringify(registry.get(a.sessionId))).not.toContain(la.sessionToken!)
  })
})
