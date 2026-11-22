// handoff_protocol = "kill_and_respawn": a specialist's session is replaced by a fresh one in its own thread, from the kickoff, with no
// letter, and its old conversation is never resumed or forked: not by this restart, not by a later refill, not after a daemon restart lands
// mid-swap. Every revive tier is a seam here (resume, fork, respawn), so each test sees exactly which tier ran and with what launch args.
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { registry, threadRegistry, type SessionInfo, type ThreadMetadata } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { STATE_DIR } from '../../infra/config.js'
import { handoffIO } from '../../app/session-lifecycle.js'
import { _setRecoveryDeps, _resetRecoveryDeps } from '../../app/recovery.js'
import { _resetBackoff } from '../../infra/recovery-backoff.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { fakeAdapter } from '../../daemon/__tests__/test-harness.js'
import { _resetHeld, holdForSpecialist, setHeldDelivery } from '../../app/specialist-thread.js'
import { ensureSpecialist, killAndRespawn, NotReplaced, specialistDeps } from '../specialist-deliver.js'
import { setSpecialistThread } from '../../sessions/specialists.js'
import type { HydraConfig, Specialist } from '../../config/types.js'

process.stderr.write = (() => true) as any

let n = 0
const sessions: string[] = []
const threads: string[] = []
const realDeps = { ...specialistDeps }
const realIO = { ...handoffIO }

/** What each tier was asked to do: a resume or a fork here would bring the old conversation back. */
let resumes: unknown[] = []
let spawns: Array<{ topic: string; opts: Record<string, any> }> = []
let kills: Array<{ info: SessionInfo; reason: string; opts: Record<string, unknown> }> = []
let failSpawn = false
let duringKill: (() => void) | undefined
let atKill: (() => void) | undefined

function configure(name: string, over: Partial<Specialist> = {}) {
  _setHydraConfigForTesting({
    operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
    people: { op: { id: 'op', addresses: ['discord:100000000000000001'], roles: [], name: 'op' } },
    specialists: { [name]: { id: name, workdir: '/srv/ops', kickoff: 'be the helper', homePlace: '555', reachableBy: ['people'], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, handoffProtocol: 'kill_and_respawn', handoffAtPct: 25, ...over } as Specialist },
  } as unknown as HydraConfig)
}

/** A live session in `thread` named `tmuxName`, with a Claude conversation a resume could continue, and its history entry. */
function live(thread: string, tmuxName: string, over: Partial<SessionInfo> = {}): SessionInfo {
  const sessionId = `kar-sess-${++n}`
  sessions.push(sessionId); threads.push(thread)
  const info = { sessionId, tmuxName, threadId: thread, topic: 'be the helper', engine: 'claude', createdAt: Date.now(), lastActive: Date.now(), sessionType: 'thread_owner', claudeSessionId: `claude-${n}`, adapter: fakeAdapter({ isAlive: () => true }), ...over } as SessionInfo
  registry.set(sessionId, info)
  registry.threadToSession.set(thread, sessionId)
  if (!threadRegistry.get(thread)) threadRegistry.set(thread, { threadId: thread, topic: 'be the helper', respawnCount: 0, createdAt: Date.now(), lastActive: Date.now(), totalMessages: 0, sessionHistory: [] } as ThreadMetadata)
  threadRegistry.get(thread)!.sessionHistory.push({ sessionId, tmuxName, originType: 'spawn', startedAt: Date.now(), messageCount: 0, claudeSessionId: info.claudeSessionId })
  return info
}

/** The fresh session a respawn tier starts: registered in the thread it was given, as doSpawnSession would. */
async function spawn(topic: string, _chat: unknown, _msg: unknown, opts: Record<string, any>) {
  spawns.push({ topic, opts })
  await Bun.sleep(10)
  if (failSpawn) throw new Error('the daemon went down mid-swap')
  const info = live(opts.existingThreadId, opts.name ?? 'unnamed', { claudeSessionId: undefined })
  return { name: info.tmuxName, sessionId: info.sessionId, threadId: info.threadId, url: '' }
}

beforeEach(() => {
  resumes = []; spawns = []; kills = []; failSpawn = false; duringKill = undefined; atKill = undefined
  _resetHeld()
  specialistDeps.threadExists = async () => true
  _setRecoveryDeps({
    tryResume: (async (dead: unknown) => { resumes.push(dead); return null }) as any,
    // The fork tier and the respawn tier both land here; a fork names forkFrom.
    doSpawnSession: spawn as any,
    tryRespawn: ((threadId: string, topic: string, resurrectFrom: string | undefined, model: string | undefined, extra: any) =>
      spawn(topic, undefined, undefined, { ...extra, existingThreadId: threadId, resurrectFrom, model })) as any,
  })
  // The kill as killSession leaves it for a revive: the history entry closed (its Claude id kept), the record and the thread's pointer gone.
  handoffIO.killSession = async (info, reason, opts) => {
    kills.push({ info, reason, opts })
    atKill?.()
    threadRegistry.closeHistoryEntry(info.threadId, info)
    registry.threadToSession.delete(info.threadId)
    registry.delete(info.sessionId)
    duringKill?.()
  }
})

afterEach(() => {
  Object.assign(specialistDeps, realDeps)
  Object.assign(handoffIO, realIO)
  _resetRecoveryDeps()
  _resetBackoff()
  _resetHeld()
  _setHydraConfigForTesting(undefined)
  for (const s of sessions.splice(0)) { registry.delete(s); transport.bridges.delete(s) }
  for (const t of threads.splice(0)) { registry.threadToSession.delete(t); threadRegistry.threads.delete(t) }
})

const noContinuation = () => {
  expect(resumes).toEqual([])
  for (const s of spawns) {
    expect(s.opts.resumeFrom).toBeUndefined()
    expect(s.opts.forkFrom).toBeUndefined()
    expect(s.opts.resumeCodex).toBeUndefined()
    expect(s.opts.handedOffFrom).toBeUndefined()
    expect(s.opts.artifact).toBeUndefined()
    // A new birth from the kickoff, not a resurrection told to continue where the old session left off.
    expect(s.opts.resurrectFrom).toBeUndefined()
  }
}

describe('kill_and_respawn', () => {
  test('a shared specialist\'s session is replaced in the same thread, from its kickoff, with no letter and no resume or fork', async () => {
    const name = `kar-ops-${++n}`
    configure(name)
    setSpecialistThread(name, 'kar-thread-1')
    const old = live('kar-thread-1', name)

    const next = await killAndRespawn(old)

    expect(kills).toHaveLength(1)
    // Not a deliberate kill: the thread's watches, held messages and bound conversations stay for the fresh session.
    expect(kills[0].opts).toMatchObject({ keepWatches: true, ended: 'handed off' })
    expect(spawns).toHaveLength(1)
    expect(spawns[0].topic).toBe('be the helper')
    expect(spawns[0].opts).toMatchObject({ existingThreadId: 'kar-thread-1', name, specialist: name, cwd: '/srv/ops' })
    noContinuation()
    expect(next.threadId).toBe('kar-thread-1')
    expect(next.sessionId).not.toBe(old.sessionId)
    expect(registry.threadToSession.get('kar-thread-1')).toBe(next.sessionId)
  })

  test('the old conversation is marked on disk before the kill, so a daemon restart mid-swap still never resumes or forks it', async () => {
    const name = `kar-ops-${++n}`
    configure(name)
    setSpecialistThread(name, 'kar-thread-2')
    const old = live('kar-thread-2', name)
    let markedOnDiskAtKill: boolean | undefined
    atKill = () => {
      const onDisk = (JSON.parse(readFileSync(join(STATE_DIR, 'threads.json'), 'utf8')) as ThreadMetadata[]).find(t => t.threadId === 'kar-thread-2')
      markedOnDiskAtKill = onDisk?.sessionHistory.find(h => h.sessionId === old.sessionId)?.restartedFresh === true
    }
    failSpawn = true   // the daemon goes down after the kill, before the fresh session starts
    await expect(killAndRespawn(old)).rejects.toThrow()
    expect(markedOnDiskAtKill).toBe(true)

    // The restart: memory is gone, threads.json is read back; then the next message refills the specialist.
    const disk = (JSON.parse(readFileSync(join(STATE_DIR, 'threads.json'), 'utf8')) as ThreadMetadata[]).find(t => t.threadId === 'kar-thread-2')!
    threadRegistry.threads.set('kar-thread-2', disk)
    failSpawn = false; spawns = []
    _resetBackoff()
    const { info } = await ensureSpecialist(name)
    expect(info.threadId).toBe('kar-thread-2')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].topic).toBe('be the helper')
    noContinuation()
  })

  test('a restricted specialist (no handoff tool) is replaced the same way', async () => {
    const name = `kar-ops-${++n}`
    configure(name, { restricted: true, tools: ['Read'], mcpServerNames: [] } as Partial<Specialist>)
    setSpecialistThread(name, 'kar-thread-3')
    const old = live('kar-thread-3', name, { policy: { specialist: name, restricted: true } as any })
    await killAndRespawn(old)
    expect(spawns).toHaveLength(1)
    expect(spawns[0].opts).toMatchObject({ existingThreadId: 'kar-thread-3', name, specialist: name })
    noContinuation()
  })

  test('a per-conversation session is replaced by its own name, in its own thread, from its specialist\'s recipe', async () => {
    const spec = `karc${++n}`
    configure(spec, { sessions: 'per-conversation' })
    const own = `${spec}_c0abc-1793732224-093059`
    const old = live('kar-conv-thread', own)
    const next = await killAndRespawn(old)
    expect(spawns).toHaveLength(1)
    expect(spawns[0].topic).toBe('be the helper')
    expect(spawns[0].opts).toMatchObject({ existingThreadId: 'kar-conv-thread', name: own, specialist: spec })
    noContinuation()
    expect(next.tmuxName).toBe(own)
    expect(next.threadId).toBe('kar-conv-thread')
  })

  test('an operator message that arrives during the restart is held, then delivered to the fresh session', async () => {
    const name = `kar-ops-${++n}`
    configure(name)
    setSpecialistThread(name, 'kar-thread-4')
    const old = live('kar-thread-4', name)
    const delivered: Array<{ content: string; to: string }> = []
    setHeldDelivery(async (m, info) => { delivered.push({ content: m.content, to: info.sessionId }) })
    // The router holds an operator's message in a specialist's thread when no session is home there: after the kill, before the spawn.
    // The thread stops pointing at the old session before the kill runs: a message arriving meanwhile finds nobody home.
    let mappedAtKill: string | undefined = 'unread'
    atKill = () => { mappedAtKill = registry.threadToSession.get('kar-thread-4') }
    duringKill = () => {
      holdForSpecialist('kar-thread-4', name, { id: 'm1', channelId: 'kar-thread-4', content: 'are you there?', isThread: true, effectiveThreadId: 'kar-thread-4', authorId: 'op', attachments: [], createdAt: new Date() } as any)
    }
    const next = await killAndRespawn(old)
    for (let i = 0; i < 50 && !delivered.length; i++) await Bun.sleep(5)
    expect(delivered).toEqual([{ content: 'are you there?', to: next.sessionId }])
    expect(mappedAtKill).toBeUndefined()
    expect(spawns).toHaveLength(1)   // the held message waited for this restart's session; it started no second one
  })

  test('a session with no history entry to mark is left running: nothing is ended that a revive could later resume', async () => {
    const name = `kar-ops-${++n}`
    configure(name)
    setSpecialistThread(name, 'kar-thread-6')
    const old = live('kar-thread-6', name)
    threadRegistry.get('kar-thread-6')!.sessionHistory = []
    await expect(killAndRespawn(old)).rejects.toBeInstanceOf(NotReplaced)
    expect(kills).toEqual([])
    expect(registry.get(old.sessionId)).toBe(old)
    expect(registry.threadToSession.get('kar-thread-6')).toBe(old.sessionId)
  })

  test('a session already replaced is not replaced twice', async () => {
    const name = `kar-ops-${++n}`
    configure(name)
    setSpecialistThread(name, 'kar-thread-5')
    const old = live('kar-thread-5', name)
    const [a, b] = await Promise.allSettled([killAndRespawn(old), killAndRespawn(old)])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    expect(spawns).toHaveLength(1)
  })
})
