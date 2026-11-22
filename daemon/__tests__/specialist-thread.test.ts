// The messages waiting for a specialist, as a module: what is on disk and when, and how a restart reads it back.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../infra/config.js'
import type { SessionInfo } from '../../sessions/registry.js'
import { removeSpecialist, setSpecialist } from '../../sessions/specialists.js'
import { _resetHeld, heldCount, holdForSpecialist, restoreHeld, setHeldDelivery, specialistThreadDeps } from '../../app/specialist-thread.js'

process.stderr.write = (() => true) as any

const file = join(STATE_DIR, 'held-for-specialist.json')
const stored = (): Record<string, { items: { msg: { content: string } }[] }> => JSON.parse(readFileSync(file, 'utf8'))
const msg = (id: string, content = id): any => ({ id, channelId: 'T', authorId: 'op', authorUsername: 'u', content, isBot: false, isDM: false, isThread: true, parentChannelId: 'c', hasExistingThread: false, existingThreadId: null, referenceMessageId: null, effectiveThreadId: 'T', attachments: [], createdAt: new Date(1_000) })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
const info = { sessionId: 's1', tmuxName: 's1' } as unknown as SessionInfo

const said: string[] = []
const delivered: string[] = []
const names: string[] = []
const real = { ...specialistThreadDeps }
let release: (() => void) | undefined

const declare = (thread: string) => { const name = `sth${names.length}-${thread.toLowerCase()}`; names.push(name); setSpecialist(name, { threadId: thread, channel: 'chan', kickoff: 'k' }); return name }

beforeEach(() => {
  said.length = 0; delivered.length = 0; release = undefined
  specialistThreadDeps.say = async (_t, text) => { said.push(text) }
  specialistThreadDeps.after = () => {}
  specialistThreadDeps.ensure = async () => info
  setHeldDelivery(async m => { delivered.push(m.content) })
  _resetHeld()
})
afterEach(() => { Object.assign(specialistThreadDeps, real); _resetHeld(); for (const n of names.splice(0)) removeSpecialist(n) })

test('written before anything is tried: while the start is still pending, the file already holds the message', async () => {
  const name = declare('T')
  specialistThreadDeps.ensure = () => new Promise<SessionInfo>(res => { release = () => res(info) })
  holdForSpecialist('T', name, msg('m1'))
  await settle()
  expect(delivered).toEqual([])
  expect(stored().T.items.map(i => i.msg.content)).toEqual(['m1'])
  release!(); await settle()
  expect(delivered).toEqual(['m1'])
  expect(existsSync(file) ? stored().T : undefined).toBeUndefined()
})

test('a message leaves the file when it is delivered, not before: with two, the file keeps the second while the first lands', async () => {
  const name = declare('T')
  let finishFirst!: () => void
  const seenInFile: string[][] = []
  setHeldDelivery(async m => {
    delivered.push(m.content)
    seenInFile.push(stored().T.items.map(i => i.msg.content))
    if (m.content === 'one') await new Promise<void>(res => { finishFirst = res })
  })
  holdForSpecialist('T', name, msg('m1', 'one'))
  holdForSpecialist('T', name, msg('m2', 'two'))
  await settle()
  expect(delivered).toEqual(['one'])
  expect(seenInFile[0]).toEqual(['one', 'two'])      // mid-delivery of the first: both are still on disk
  finishFirst(); await settle()
  expect(delivered).toEqual(['one', 'two'])
  expect(seenInFile[1]).toEqual(['two'])             // the first was removed once delivered, the second not yet
  expect(existsSync(file) ? stored().T : undefined).toBeUndefined()
})

test('restore: one malformed entry is skipped and the others are kept; the original is kept aside', async () => {
  const a = declare('A'), c = declare('C')
  specialistThreadDeps.ensure = async () => { throw new Error('later') }   // keep them waiting so the file is rewritten by persist()
  const good = (n: string, spec: string) => ({ specialist: spec, told: true, lastError: 'x', items: [{ at: Date.now(), msg: msg(n) }] })
  writeFileSync(file, JSON.stringify({ A: good('a1', a), B: { specialist: 'nope', items: [{ at: 'x', msg: {} }] }, C: good('c1', c) }))
  expect(restoreHeld()).toBe(2)
  await settle()
  expect(heldCount('A')).toBe(1)
  expect(heldCount('B')).toBe(0)
  expect(heldCount('C')).toBe(1)
  expect(Object.keys(stored()).sort()).toEqual(['A', 'C'])
  expect(Object.keys(JSON.parse(readFileSync(file + '.corrupt', 'utf8'))).sort()).toEqual(['A', 'B', 'C'])
})

test('restore: an unreadable file is set aside as .corrupt before anything writes, and boot goes on', async () => {
  const name = declare('T')
  writeFileSync(file, '{ this is not json')
  expect(restoreHeld()).toBe(0)
  expect(existsSync(file)).toBe(false)
  expect(readFileSync(file + '.corrupt', 'utf8')).toBe('{ this is not json')
  holdForSpecialist('T', name, msg('m1'))          // the next write does not touch the kept copy
  await settle()
  expect(readFileSync(file + '.corrupt', 'utf8')).toBe('{ this is not json')
})

test('a thread that no longer belongs to any specialist: its messages are told as not delivered, nothing is started', async () => {
  const name = declare('T')
  let started = 0
  specialistThreadDeps.ensure = async () => { started++; return info }
  writeFileSync(file, JSON.stringify({ T: { specialist: name, told: false, lastError: 'x', items: [{ at: Date.now(), msg: msg('m2') }] } }))
  removeSpecialist(name)                            // hydra.toml changed while the message waited
  restoreHeld(); await settle()
  expect(started).toBe(0)
  expect(delivered).toEqual([])
  expect(said[0]).toContain(`no longer ${name}'s`)
  expect(said[0]).toContain('1 message was not delivered')
})
