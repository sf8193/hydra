// `hydra deliver --thread <id> --revive` (spec §2, P1): an unnamed thread heals only when asked. Flows B, D, E, F
// for a thread id, and the deleted-thread case (exit 3). The spawn is stubbed through recovery.ts's seam.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { _setRecoveryDeps, _resetRecoveryDeps, reviveDeps } from '../recovery.js'
import { _resetBackoff } from '../recovery-backoff.js'
import { _setDaemonStartedAtForTesting } from '../session-reachability.js'
import { fakeAdapter } from './test-harness.js'
import { removeSpecialist, setSpecialist } from '../specialists.js'
import { getBackoff } from '../recovery-backoff.js'

process.stderr.write = (() => true) as any

let n = 0
const sessions: string[] = []
const threads: string[] = []
const realThreadExists = reviveDeps.threadExists
let spawns: any[][] = []

const deliver = (thread: string, extra: Record<string, unknown> = {}) =>
  handleCLIRequest({ type: 'cli', command: 'deliver', id: `dr-${++n}`, params: { thread, message: 'nightly: 3 failures', initiator: 'jobs', revive: true, ...extra } } as CLIRequest)

/** A thread hydra knows, whose last session is `alive` (or not), `connected` (or not), `ageMs` old. */
function seedThread(o: { alive?: boolean; connected?: boolean; ageMs?: number; stampedDead?: boolean } = {}): { threadId: string; sessionId: string } {
  const threadId = `dr-thread-${++n}`, sessionId = `dr-sess-${n}`
  threadRegistry.threads.set(threadId, { threadId, topic: 'nightly', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
    sessionHistory: [{ sessionId, tmuxName: `dr-old-${n}`, originType: 'spawn', startedAt: 1, endedAt: o.alive ? undefined : 2, messageCount: 0 }] } as any)
  registry.set(sessionId, {
    sessionId, tmuxName: `dr-old-${n}`, topic: 'nightly', threadId, createdAt: Date.now() - (o.ageMs ?? 10 * 60_000), lastActive: 1,
    listening: false, engine: 'claude', sessionType: 'thread_owner', ...(o.stampedDead && { deadAt: 1 }),
    adapter: fakeAdapter({ isAlive: () => !!o.alive }),
  } as unknown as SessionInfo)
  registry.setThread(threadId, sessionId)
  if (o.connected) transport.bridges.set(sessionId, { sessionId, socket: { destroyed: false, write: () => true } } as any)
  sessions.push(sessionId); threads.push(threadId)
  return { threadId, sessionId }
}

/** A spawn that registers a booting session in the thread it was asked to fill. */
function spawnOk() {
  const spawn = async (...args: any[]) => {
    spawns.push(args)
    await Bun.sleep(10)
    const threadId = args[3].existingThreadId
    const sessionId = `dr-new-${++n}`
    registry.set(sessionId, { sessionId, tmuxName: `dr-new-${n}`, topic: 't', threadId, createdAt: Date.now(), lastActive: 1, listening: false,
      engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => true }) } as unknown as SessionInfo)
    registry.setThread(threadId, sessionId)
    sessions.push(sessionId)
    return { name: `dr-new-${n}`, sessionId, threadId, url: '' }
  }
  _setRecoveryDeps({
    doSpawnSession: spawn as any, tryResume: async () => null,
    tryRespawn: ((threadId: string, topic: string, from: string, model: string, extra: any) => spawn(topic, undefined, undefined, { ...extra, existingThreadId: threadId, resurrectFrom: from, model })) as any,
  })
}

beforeEach(() => { spawns = []; _setDaemonStartedAtForTesting(0); reviveDeps.threadExists = async () => true; spawnOk() })
afterEach(() => {
  _resetRecoveryDeps(); _resetBackoff(); _setDaemonStartedAtForTesting(undefined)
  reviveDeps.threadExists = realThreadExists
  for (const s of sessions.splice(0)) { registry.delete(s); transport.bridges.delete(s) }
  for (const t of threads.splice(0)) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
})

describe('deliver --thread <id> --revive', () => {
  test('B: a dead session in a thread the platform still has is revived there, reading the thread; the message queues for it', async () => {
    const { threadId } = seedThread()
    const res = await deliver(threadId)
    expect(res).toMatchObject({ ok: true, data: { sessionId: expect.stringMatching(/^dr-new-/), threadId, revived: true } })
    expect(spawns).toHaveLength(1)
    expect(spawns[0][3]).toMatchObject({ existingThreadId: threadId, resurrectFrom: expect.stringMatching(/^dr-old-/) })
    expect(spawns[0][0]).toBe('nightly') // the plain resume prompt: the thread's topic, not a kickoff
  })

  test('without --revive the same dead thread still says gone (exit 3): nothing heals unasked', async () => {
    const { threadId } = seedThread()
    expect(await deliver(threadId, { revive: undefined })).toMatchObject({ ok: false, exitCode: 3 })
    expect(spawns).toHaveLength(0)
  })

  test('a thread deleted on the platform is reported (exit 3), never reopened elsewhere', async () => {
    const { threadId } = seedThread()
    reviveDeps.threadExists = async () => false
    expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 3, error: expect.stringContaining('gone') })
    expect(spawns).toHaveLength(0)
  })

  test('F: a running session with no bridge (orphaned, or stamped dead while running) is reported (exit 4), never revived over', async () => {
    for (const o of [{ alive: true }, { alive: true, stampedDead: true }]) {
      const { threadId } = seedThread(o)
      expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 4 })
    }
    expect(spawns).toHaveLength(0)
  })

  test('someone home: a live session gets it with nothing spawned', async () => {
    const { threadId, sessionId } = seedThread({ alive: true, connected: true })
    expect(await deliver(threadId)).toMatchObject({ ok: true, data: { status: 'delivered', sessionId, revived: false } })
    expect(spawns).toHaveLength(0)
  })

  test('D: a burst of sends to a dead thread starts one session and every message queues for it', async () => {
    const { threadId } = seedThread()
    const all = await Promise.all(Array.from({ length: 8 }, () => deliver(threadId)))
    expect(all.map(r => r.ok)).toEqual(Array(8).fill(true))
    expect(spawns).toHaveLength(1)
    expect(new Set(all.map(r => (r.data as any).sessionId)).size).toBe(1)
  })

  test('E: a failed start is exit 6 with its reason, then backs off per thread', async () => {
    const { threadId } = seedThread()
    _setRecoveryDeps({ tryResume: async () => null, tryRespawn: async () => { spawns.push([]); throw new Error('tmux exploded') } })
    expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: tmux exploded') })
    expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('not retrying until') })
    expect(spawns).toHaveLength(1)
  })

  test('M4: a thread hydra has no record of, but the platform still has, is revived there', async () => {
    const threadId = `dr-unknown-${++n}`
    threads.push(threadId)
    const res = await deliver(threadId)
    expect(res).toMatchObject({ ok: true, data: { threadId, revived: true } })
    expect(spawns[0][3]).toMatchObject({ existingThreadId: threadId })
  })

  test('M3: a specialist\'s thread revives as the specialist: its name, its kickoff, its back-off', async () => {
    const { threadId } = seedThread()
    const name = `drspec${++n}`
    setSpecialist(name, { threadId, kickoff: 'be the nightly specialist' })
    try {
      const res = await deliver(threadId)
      expect(res).toMatchObject({ ok: true, data: { specialist: name, revived: true } })
      expect(spawns[0][0]).toBe('be the nightly specialist')
      expect(spawns[0][3]).toMatchObject({ name, existingThreadId: threadId })

      _setRecoveryDeps({ tryResume: async () => null, tryRespawn: async () => { throw new Error('boom') } })
      registry.deleteThread(threadId) // nobody home again
      expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 6 })
      expect(getBackoff(name)).toBeDefined()
      expect(getBackoff(threadId)).toBeUndefined()
    } finally { removeSpecialist(name) }
  })

  test('L3: while a thread backs off, a delivery never asks the platform about it', async () => {
    const { threadId } = seedThread()
    _setRecoveryDeps({ tryResume: async () => null, tryRespawn: async () => { throw new Error('boom') } })
    await deliver(threadId)
    let asked = 0
    reviveDeps.threadExists = async () => { asked++; return true }
    expect(await deliver(threadId)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('not retrying until') })
    expect(asked).toBe(0)
  })

  test('--revive takes --thread only', async () => {
    expect(await handleCLIRequest({ type: 'cli', command: 'deliver', id: 'dr-x', params: { session: 's', message: 'm', revive: true } } as CLIRequest))
      .toMatchObject({ ok: false, error: expect.stringContaining('--revive takes --thread') })
  })
})
