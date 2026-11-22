// A session's prompt file goes with the session, at each of the three places a session ends: killSession, markDead and destroyThread.
// One test per place: remove the call there and exactly that test fails.
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { engines } from '../../engines/instances.js'
import { gateway } from '../../infra/config.js'
import { destroyThread } from '../../app/destroy.js'
import { spawnPromptDir, writeSpawnPrompt } from '../../infra/launch-files.js'
import { killSession } from '../../app/session-lifecycle.js'
import { markDead, registry, threadRegistry, type SessionInfo } from '../../sessions/registry.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const gone = (s: SessionInfo) => !existsSync(`${spawnPromptDir()}/${s.tmuxName}-${s.sessionId}.prompt`)
let seq = 0
let tmux: FakeTmux
let origStderr: typeof process.stderr.write
let orig: Record<string, unknown> = {}
const seeded: SessionInfo[] = []

beforeAll(() => {
  orig = { rp: registry.persist, tp: threadRegistry.persist, deleteThread: gateway.deleteThread, delete: gateway.delete, react: gateway.react, send: gateway.send }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})
afterAll(() => {
  ;(registry as any).persist = orig.rp
  ;(threadRegistry as any).persist = orig.tp
  Object.assign(gateway as any, { deleteThread: orig.deleteThread, delete: orig.delete, react: orig.react, send: orig.send })
})
beforeEach(() => {
  tmux = withFakeTmux()
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  rmSync(spawnPromptDir(), { recursive: true, force: true })
  Object.assign(gateway as any, { deleteThread: async () => {}, delete: async () => {}, react: async () => {}, send: async (c: string) => ({ id: 'm', channelId: c }) })
})
afterEach(() => {
  tmux.restore()
  process.stderr.write = origStderr
  for (const s of seeded.splice(0)) { registry.delete(s.sessionId); registry.deleteThread(s.threadId); threadRegistry.threads.delete(s.threadId) }
})

/** A session on its own thread, with its prompt file written, and another session's file beside it that must stay. */
function seed(extra: Partial<SessionInfo> = {}): { info: SessionInfo; other: SessionInfo } {
  const mk = (name: string): SessionInfo => {
    const n = ++seq
    return {
      sessionId: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`, topic: 't', threadId: `th-lf-${n}`, createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: `${name}-${n}`, listening: false, engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner', ...extra,
    } as SessionInfo
  }
  const [info, other] = [mk('lf'), mk('lf-other')]
  for (const s of [info, other]) {
    registry.set(s.sessionId, s); registry.setThread(s.threadId, s.sessionId); seeded.push(s)
    threadRegistry.threads.set(s.threadId, { threadId: s.threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [] })
    writeSpawnPrompt(s.tmuxName, s.sessionId, 'kickoff text')
  }
  if (!extra.deadAt) tmux.alive(info.tmuxName)
  return { info, other }
}

describe("a session's prompt file is removed where the session ends", () => {
  test('killSession', async () => {
    const { info, other } = seed()
    expect(gone(info)).toBe(false)
    await killSession(info, 'test')
    expect(gone(info)).toBe(true)
    expect(gone(other)).toBe(false)
  })

  test('markDead', () => {
    const { info, other } = seed()
    markDead(info)
    expect(gone(info)).toBe(true)
    expect(gone(other)).toBe(false)
  })

  test('destroyThread, for a dead session whose record it forgets', async () => {
    const { info, other } = seed({ deadAt: Date.now() })
    const out = await destroyThread(info.threadId, 'test')
    expect(out.ok).toBe(true)
    expect(registry.get(info.sessionId)).toBeUndefined()
    expect(gone(info)).toBe(true)
    expect(gone(other)).toBe(false)
  })
})
