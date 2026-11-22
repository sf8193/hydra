// What the operator ends ends: an explicit kill of a specialist drops the messages waiting for its thread (once told, file updated).
// A refill's kill, a handoff, a resumable idle end and a restart keep them. Uses the real killSession, so the keep/drop line is `session:death`'s `deliberate`.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from '../../infra/config.js'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { emitSessionDeath, killSession } from '../session-lifecycle.js'
import { removeSpecialist, setSpecialist } from '../../sessions/specialists.js'
import { _forgetMemory, _resetHeld, heldCount, holdForSpecialist, restoreHeld, setHeldDelivery, specialistThreadDeps } from '../specialist-thread.js'
import type { SessionInfo } from '../../sessions/registry.js'

process.stderr.write = (() => true) as any

const file = join(STATE_DIR, 'held-for-specialist.json')
const msg = (id: string): any => ({ id, channelId: 'kt1', authorId: 'op', authorUsername: 'u', content: id, isBot: false, isDM: false, isThread: true, parentChannelId: 'c', hasExistingThread: false, existingThreadId: null, referenceMessageId: null, effectiveThreadId: 'kt1', attachments: [], createdAt: new Date(1_000) })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
const said: string[] = []
const delivered: string[] = []
const timers: Array<() => void> = []
let ensures = 0
let name = ''
const real = { ...specialistThreadDeps }
const orig = { send: gateway.send, rp: registry.persist, tp: threadRegistry.persist }
const info = { sessionId: 'kt-s', tmuxName: 'kt-s' } as unknown as SessionInfo

const mk = (id: string) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: '', threadId: 'kt1', createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {}, isAlive: (i: any) => !i.deadAt, isConnected: () => false }, sessionType: 'thread_owner',
} as any)

beforeEach(() => {
  said.length = 0; delivered.length = 0; timers.length = 0; ensures = 0
  ;(gateway as any).send = async () => ({ id: 'm' }); (registry as any).persist = () => {}; (threadRegistry as any).persist = () => {}
  specialistThreadDeps.say = async (_t, text) => { said.push(text) }
  specialistThreadDeps.after = (_ms, fn) => { timers.push(fn) }
  specialistThreadDeps.ensure = async () => { ensures++; throw new Error('no seat') }   // cannot start: the messages wait
  setHeldDelivery(async m => { delivered.push(m.content) })
  _resetHeld()
  name = 'ktspec'
  setSpecialist(name, { threadId: 'kt1', channel: 'chan', kickoff: 'k' })
})
afterEach(() => {
  Object.assign(specialistThreadDeps, real); _resetHeld(); removeSpecialist(name)
  ;(gateway as any).send = orig.send; (registry as any).persist = orig.rp; (threadRegistry as any).persist = orig.tp
  for (const id of ['kt-plain', 'kt-refill', 'kt-record']) registry.delete(id)
})

const waiting = async () => { holdForSpecialist('kt1', name, msg('one')); holdForSpecialist('kt1', name, msg('two')); await settle(); expect(heldCount('kt1')).toBe(2) }

test('an explicit kill drops the waiting messages, tells the thread once, empties the file, and no retry refills the specialist', async () => {
  await waiting()
  const before = ensures
  mk('kt-plain')
  await killSession(registry.get('kt-plain')!, 'session ended')
  await settle()
  expect(heldCount('kt1')).toBe(0)
  const told = said.filter(t => t.includes('ended on purpose'))
  expect(told).toHaveLength(1)
  expect(told[0]).toContain('2 messages were waiting for it not delivered')
  expect(told[0]).toContain(`hydra spawn --specialist ${name}`)
  expect(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).kt1 : undefined).toBeUndefined()
  for (const t of timers.splice(0)) t()               // the retry that was scheduled
  await settle()
  expect(ensures).toBe(before)                        // it does not start the specialist again
  expect(delivered).toEqual([])
})

test('a refill\'s kill (keepWatches), a resumable idle end (keepRecord) and a death with no flag keep the waiting messages', async () => {
  await waiting()
  mk('kt-refill'); mk('kt-record')
  await killSession(registry.get('kt-refill')!, 'replaced by new spawn', { keepWatches: true })
  await killSession(registry.get('kt-record')!, 'idle', { keepRecord: true })
  emitSessionDeath({ sessionId: 'kt-crash', tmuxName: 'kt-crash', threadId: 'kt1' } as any)   // a crash: no flag
  await settle()
  expect(heldCount('kt1')).toBe(2)
  expect(said.filter(t => t.includes('ended on purpose'))).toHaveLength(0)
  expect(JSON.parse(readFileSync(file, 'utf8')).kt1.items).toHaveLength(2)
})

test('a refill that kills the old record while a message is being delivered does not drop it', async () => {
  let finishFirst!: () => void
  setHeldDelivery(async m => { delivered.push(m.content); if (m.content === 'one') await new Promise<void>(r => { finishFirst = r }) })
  specialistThreadDeps.ensure = async () => info
  holdForSpecialist('kt1', name, msg('one')); holdForSpecialist('kt1', name, msg('two'))
  await settle()
  expect(delivered).toEqual(['one'])
  mk('kt-refill')
  await killSession(registry.get('kt-refill')!, 'replaced by new spawn', { keepWatches: true })   // what a refill does to the dead record
  finishFirst(); await settle()
  expect(delivered).toEqual(['one', 'two'])
})

test('a restart keeps them (the kill rule is about the session, not the daemon)', async () => {
  await waiting()
  _forgetMemory(); timers.length = 0
  expect(restoreHeld()).toBe(2)
  await settle()
  expect(heldCount('kt1')).toBe(2)
  expect(said.filter(t => t.includes('ended on purpose'))).toHaveLength(0)
})
