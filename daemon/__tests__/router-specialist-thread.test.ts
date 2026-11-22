// The production router: an operator's message in a specialist's own thread while no session is home there.
// It is held for the specialist, the specialist is started by the rule, and the message lands in its session: never main's.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import * as access from '../../sessions/access.js'
import { registry, type SessionInfo } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { _setRecoveryDeps, _resetRecoveryDeps, reviveDeps } from '../recovery.js'
import { _resetBackoff } from '../../infra/recovery-backoff.js'
import { _setDaemonStartedAtForTesting } from '../../sessions/session-reachability.js'
import { removeSpecialist, setSpecialist } from '../../sessions/specialists.js'
import { _forgetMemory, _resetHeld, heldCount, MAX_HOLD_MS, restoreHeld, RETRY_MS, specialistThreadDeps } from '../specialist-thread.js'
import { fakeAdapter } from './test-harness.js'

process.stderr.write = (() => true) as any

let onMessage: (msg: any) => Promise<void>
const spies: Array<{ mockRestore(): void }> = []
const said: Array<{ threadId: string; text: string }> = []
const landed: Array<{ to: string; content: string }> = []
const spawns: any[][] = []
const timers: Array<() => void> = []
let failSpawn: string | undefined
let clock = 1_000_000
let n = 0
const sessions: string[] = []
const threads: string[] = []
const names: string[] = []
const real = { ...specialistThreadDeps, threadExists: reviveDeps.threadExists }

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { onMessage = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'x' })) as any))
  spies.push(spyOn(gateway, 'typing').mockImplementation((async () => {}) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  spies.push(spyOn(access, 'loadAccess').mockImplementation((() => ({ allowFrom: ['op'], groups: { chan: { requireMention: false } }, pending: {} })) as any))
  spies.push(spyOn(transport, 'sendOrQueue').mockImplementation(((to: string, m: any) => { if (m.type === 'notification') landed.push({ to, content: m.content }) }) as any))
  await import('../router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })

/** A session in `threadId`: alive and bridged unless told otherwise. */
function occupy(threadId: string, o: { alive?: boolean; connected?: boolean; listening?: boolean; tmuxName?: string; createdAt?: number } = {}): SessionInfo {
  const sessionId = `st-sess-${++n}`
  const info = {
    sessionId, tmuxName: o.tmuxName ?? `st-${n}`, topic: 't', threadId, createdAt: o.createdAt ?? Date.now() - 600_000, lastActive: 1, listening: o.listening ?? false,
    engine: 'claude', sessionType: 'thread_owner', adapter: fakeAdapter({ isAlive: () => o.alive ?? true, usage: () => null }),
  } as unknown as SessionInfo
  registry.set(sessionId, info)
  registry.setThread(threadId, sessionId)
  sessions.push(sessionId); threads.push(threadId)
  return info
}

beforeEach(() => {
  landed.length = 0; said.length = 0; spawns.length = 0; timers.length = 0; failSpawn = undefined; clock = 1_000_000
  reviveDeps.threadExists = async () => true
  _setDaemonStartedAtForTesting(0)
  specialistThreadDeps.now = () => clock
  specialistThreadDeps.after = (_ms, fn) => { timers.push(fn) }
  specialistThreadDeps.say = async (threadId, text) => { said.push({ threadId, text }) }
  const spawn = async (...args: any[]) => {
    spawns.push(args)
    if (failSpawn) throw new Error(failSpawn)
    const threadId = args[3]?.existingThreadId ?? `st-new-${++n}`
    const info = occupy(threadId, { tmuxName: args[3]?.name ?? `st-new-${n}`, connected: false, createdAt: Date.now() })
    return { name: info.tmuxName, sessionId: info.sessionId, threadId, url: '' }
  }
  _setRecoveryDeps({
    doSpawnSession: spawn as any, tryResume: async () => null,
    tryRespawn: ((threadId: string, topic: string, from: string, model: string, extra: any) => spawn(topic, undefined, undefined, { ...extra, existingThreadId: threadId, resurrectFrom: from, model })) as any,
  })
})
afterEach(() => {
  _resetRecoveryDeps(); _resetBackoff(); _resetHeld(); _setDaemonStartedAtForTesting(undefined)
  Object.assign(specialistThreadDeps, real); reviveDeps.threadExists = real.threadExists
  for (const s of sessions.splice(0)) registry.delete(s)
  for (const t of threads.splice(0)) registry.deleteThread(t)
  for (const name of names.splice(0)) removeSpecialist(name)
})

const specialist = (threadId: string, extra: Record<string, unknown> = {}) => {
  const name = `stspec${++n}`
  names.push(name)
  setSpecialist(name, { threadId, channel: 'chan', kickoff: 'be the specialist', ...extra })
  return name
}
const say = (threadId: string, content = 'proceed with it', authorId = 'op') =>
  onMessage({ id: `m${++n}`, channelId: threadId, authorId, authorUsername: 'u', content, isBot: false, isDM: false, isThread: true, parentChannelId: 'chan', effectiveThreadId: threadId, attachments: [], createdAt: new Date() })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
const toMain = () => landed.filter(l => l.to === 'main')

test('a vacant specialist thread: the specialist is started, the message lands in its session once, main gets nothing', async () => {
  const name = specialist('st-thread-1')
  await say('st-thread-1')
  await settle()
  expect(spawns).toHaveLength(1)
  expect(spawns[0][3]).toMatchObject({ existingThreadId: 'st-thread-1', specialist: name })
  const started = registry.get(registry.getByThread('st-thread-1')!)!
  expect(landed.map(l => l.to)).toEqual([started.sessionId])
  expect(landed[0].content).toContain('proceed with it')
  expect(toMain()).toHaveLength(0)
  expect(heldCount('st-thread-1')).toBe(0)
})

test('an ended session record in a specialist thread is vacant too: started again, not main', async () => {
  specialist('st-thread-2')
  const dead = occupy('st-thread-2', { alive: false, connected: false })
  await say('st-thread-2')
  await settle()
  expect(spawns).toHaveLength(1)
  expect(landed.some(l => l.to === dead.sessionId)).toBe(false)
  expect(toMain()).toHaveLength(0)
  expect(landed).toHaveLength(1)
})

test('an occupied specialist thread is unchanged: straight to its session, nothing started', async () => {
  specialist('st-thread-3')
  const live = occupy('st-thread-3', { listening: true })
  transport.bridges.set(live.sessionId, { sessionId: live.sessionId, socket: { destroyed: false, write: () => true } } as any)
  await say('st-thread-3')
  await settle()
  transport.bridges.delete(live.sessionId)
  expect(spawns).toHaveLength(0)
  expect(landed.map(l => l.to)).toEqual([live.sessionId])
})

test('golden: an ordinary session thread is unchanged. Occupied goes to its session; vacant still goes to main, nothing started', async () => {
  const live = occupy('st-plain-1', { listening: true })
  transport.bridges.set(live.sessionId, { sessionId: live.sessionId, socket: { destroyed: false, write: () => true } } as any)
  await say('st-plain-1'); await settle()
  transport.bridges.delete(live.sessionId)
  expect(landed.map(l => l.to)).toEqual([live.sessionId])

  landed.length = 0
  occupy('st-plain-2', { alive: false, connected: false })
  await say('st-plain-2')
  await settle()
  expect(spawns).toHaveLength(0)
  expect(landed.map(l => l.to)).toEqual(['main'])
})

test('only the operator revives: another sender in a vacant specialist thread starts nothing', async () => {
  specialist('st-thread-4')
  await say('st-thread-4', 'hello', 'someone-else')
  await settle()
  expect(spawns).toHaveLength(0)
  expect(heldCount('st-thread-4')).toBe(0)
  expect(landed.map(l => l.to)).toEqual(['main'])  // pre-existing, reported in the PR: this sender's message still falls through to main
})

test('two answers while it starts: one start, both delivered, in order', async () => {
  specialist('st-thread-5')
  await say('st-thread-5', 'first')
  await say('st-thread-5', 'second')
  await settle()
  expect(spawns).toHaveLength(1)
  expect(landed.map(l => l.content.includes('first') ? 'first' : 'second')).toEqual(['first', 'second'])
  expect(toMain()).toHaveLength(0)
})

test('a start that fails is held, told once, retried, and delivered once when it succeeds', async () => {
  specialist('st-thread-6')
  failSpawn = 'no seat'
  await say('st-thread-6')
  await settle()
  expect(landed).toHaveLength(0)
  expect(heldCount('st-thread-6')).toBe(1)
  expect(said).toHaveLength(1)
  expect(said[0].text).toContain('wait for it')
  expect(said[0].text).toContain('no seat')
  expect(timers).toHaveLength(1)

  failSpawn = undefined
  clock += RETRY_MS + 1
  _resetBackoff()
  timers.shift()!()
  await settle()
  expect(heldCount('st-thread-6')).toBe(0)
  expect(landed).toHaveLength(1)
  expect(landed[0].to).not.toBe('main')
  expect(said).toHaveLength(1)
})

test('still not started after the hold: the thread is told what was not delivered and what to do; nothing reaches main', async () => {
  const name = specialist('st-thread-7')
  failSpawn = 'no seat'
  await say('st-thread-7')
  await settle()
  clock += MAX_HOLD_MS + 1
  timers.shift()!()
  await settle()
  expect(heldCount('st-thread-7')).toBe(0)
  expect(landed).toHaveLength(0)
  expect(said).toHaveLength(2)
  expect(said[1].text).toContain('did not start within 60 minutes')
  expect(said[1].text).toContain('1 message was not delivered')
  expect(said[1].text).toContain('no seat')
  expect(said[1].text).toContain(`hydra specialist show ${name}`)
  expect(timers).toHaveLength(0)
})

test('a start that can never succeed is told at once and not held', async () => {
  const name = specialist('st-thread-8', { channel: undefined })
  reviveDeps.threadExists = async () => false
  await say('st-thread-8')
  await settle()
  expect(spawns).toHaveLength(0)
  expect(heldCount('st-thread-8')).toBe(0)
  expect(timers).toHaveLength(0)
  expect(said).toHaveLength(1)
  expect(said[0].text).toContain(`specialist "${name}"`)
  expect(said[0].text).toContain('not delivered')
  expect(landed).toHaveLength(0)
})

test('more answers while a retry is pending join it: one retry chain, one start per attempt, order kept', async () => {
  specialist('st-thread-9')
  failSpawn = 'no seat'
  await say('st-thread-9', 'one')
  await settle()
  await say('st-thread-9', 'two')
  await say('st-thread-9', 'three')
  await settle()
  expect(timers).toHaveLength(1)
  expect(heldCount('st-thread-9')).toBe(3)
  expect(said).toHaveLength(1)

  failSpawn = undefined
  _resetBackoff()
  clock += RETRY_MS + 1
  timers.shift()!()
  await settle()
  expect(landed.map(l => ['one', 'two', 'three'].find(w => l.content.includes(w)))).toEqual(['one', 'two', 'three'])
  expect(toMain()).toHaveLength(0)
})

test('restart: what was held during a failed start is restored and delivered once, in order, to the revived specialist, never main', async () => {
  specialist('st-thread-10')
  failSpawn = 'no seat'
  await say('st-thread-10', 'one')
  await say('st-thread-10', 'two')
  await settle()
  expect(heldCount('st-thread-10')).toBe(2)

  _forgetMemory()                       // the daemon went down: memory is gone, the file stays
  timers.length = 0                     // and so is the retry it had scheduled
  expect(heldCount('st-thread-10')).toBe(0)
  failSpawn = undefined
  _resetBackoff()
  expect(restoreHeld()).toBe(2)         // boot
  await settle()
  expect(heldCount('st-thread-10')).toBe(0)
  expect(landed.map(l => ['one', 'two'].find(w => l.content.includes(w)))).toEqual(['one', 'two'])
  expect(toMain()).toHaveLength(0)

  _forgetMemory()                       // a second restart finds nothing left to deliver
  expect(restoreHeld()).toBe(0)
  await settle()
  expect(landed).toHaveLength(2)
})

test('restart: a held message that cannot start yet is still there, retried on the stored schedule', async () => {
  specialist('st-thread-11')
  failSpawn = 'no seat'
  await say('st-thread-11', 'wait for me')
  await settle()
  _forgetMemory(); timers.length = 0
  expect(restoreHeld()).toBe(1)
  await settle()
  expect(heldCount('st-thread-11')).toBe(1)
  expect(timers).toHaveLength(1)        // still failing: the retry is scheduled again
  expect(said).toHaveLength(1)          // and the thread is not told "held" a second time
  expect(landed).toHaveLength(0)
})

test('restart: expiry runs from the stored time, not from the restart', async () => {
  specialist('st-thread-12')
  failSpawn = 'no seat'
  await say('st-thread-12', 'too late')
  await settle()
  _forgetMemory(); timers.length = 0
  clock += MAX_HOLD_MS + 1              // the daemon was down for more than the hold
  restoreHeld()
  await settle()
  expect(heldCount('st-thread-12')).toBe(0)
  expect(landed).toHaveLength(0)
  expect(said.at(-1)!.text).toContain('did not start within 60 minutes')
  expect(said.at(-1)!.text).toContain('1 message was not delivered')
  _forgetMemory()
  expect(restoreHeld()).toBe(0)         // said once; not restored again
})
