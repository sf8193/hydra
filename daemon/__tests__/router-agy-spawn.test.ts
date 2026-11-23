import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import * as access from '../../sessions/access.js'
import * as global from '../../app/commands/global.js'
import * as thread from '../../app/commands/thread.js'
import { setHydra } from './test-hydra.js'

// The production router: `spawn neon: …` must reach handleSpawnIntercept with the agy model AND the agy engine,
// and thread commands (`handoff`, `respawn`) must resolve every engine's aliases (agy, omp, codex, claude).
let handler: (msg: any) => Promise<void>
const spawns: any[][] = []
const handoffs: any[][] = []
const respawns: any[][] = []
const forks: any[][] = []
const sent: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { handler = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(setHydra({ operators: ['u1'], channels: { c1: {} } }))
  spies.push(spyOn(global, 'handleSpawnIntercept').mockImplementation((async (...args: any[]) => { spawns.push(args) }) as any))
  spies.push(spyOn(thread, 'handleHandoffIntercept').mockImplementation((async (...args: any[]) => { handoffs.push(args) }) as any))
  spies.push(spyOn(thread, 'handleRespawnIntercept').mockImplementation((async (...args: any[]) => { respawns.push(args) }) as any))
  spies.push(spyOn(thread, 'handleForkIntercept').mockImplementation((async (...args: any[]) => { forks.push(args) }) as any))
  ;(await import('../../app/router.js')).bindRouter()
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => { spawns.length = 0; handoffs.length = 0; respawns.length = 0; forks.length = 0; sent.length = 0 })

const say = (content: string, opts: { isThread?: boolean } = {}) =>
  handler({ id: 'm1', channelId: opts.isThread ? 't1' : 'c1', ...(opts.isThread ? { parentChannelId: 'c1' } : {}), authorId: 'u1', authorUsername: 'u', content, isBot: false, isDM: false, isThread: !!opts.isThread, attachments: [], createdAt: new Date() })

test('spawn neon: topic starts an agy session on the aliased model', async () => {
  await say('spawn neon: fix the bug')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['fix the bug'])
  expect(spawns[0].slice(2)).toEqual(['gemini-4-neon-high', 'agy'])
})

test('spawn-wt neon: repo topic starts an agy session in a worktree', async () => {
  await say('spawn-wt neon: options_bot fix the tests')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['wt:options_bot fix the tests'])
  expect(spawns[0].slice(2)).toEqual(['gemini-4-neon-high', 'agy'])
})

test('a bare alias is told it needs a topic, and spawns nothing', async () => {
  await say('spawn: neon')
  expect(spawns).toHaveLength(0)
  expect(sent.some(t => t.includes('needs a topic'))).toBe(true)
})

test('a Claude alias still starts a Claude session (no engine)', async () => {
  await say('spawn sonnet: fix the bug')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(2)).toEqual(['sonnet'])
})

test('handoff neon: note routes to handleHandoffIntercept with the agy model and engine', async () => {
  await say('handoff neon: finish the docs', { isThread: true })
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0].slice(1)).toEqual([{ model: 'gemini-4-neon-high', engine: 'agy' }, 'finish the docs'])
  expect(sent).toEqual([])
})

test('handoff neon without a note routes with the agy model and engine', async () => {
  await say('handoff neon', { isThread: true })
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0].slice(1)).toEqual([{ model: 'gemini-4-neon-high', engine: 'agy' }, undefined])
  expect(sent).toEqual([])
})

test('handoff omp-sonnet: note routes with the omp model and engine', async () => {
  await say('handoff omp-sonnet: finish the docs', { isThread: true })
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0].slice(1)).toEqual([{ model: 'claude-sonnet-5-5[1m]', engine: 'omp' }, 'finish the docs'])
  expect(sent).toEqual([])
})

test('handoff with an unknown model lists agy and omp aliases in the error', async () => {
  await say('handoff bogus', { isThread: true })
  expect(handoffs).toHaveLength(0)
  expect(sent.some(t => t.includes('Unknown model `bogus`') && t.includes('neon') && t.includes('omp-sonnet'))).toBe(true)
})

test('respawn neon routes to handleRespawnIntercept with the agy model and engine', async () => {
  await say('respawn neon', { isThread: true })
  expect(respawns).toHaveLength(1)
  expect(respawns[0][3]).toEqual({ model: 'gemini-4-neon-high', engine: 'agy' })
  expect(sent).toEqual([])
})

test('a bot-tagged spawn neon: strips the leading mention and spawns agy', async () => {
  Object.defineProperty(gateway, 'botId', { value: '999', configurable: true })
  try {
    await say('<@999> spawn neon: fix the bug')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].slice(1, 2)).toEqual(['fix the bug'])
    expect(spawns[0].slice(2)).toEqual(['gemini-4-neon-high', 'agy'])
  } finally {
    delete (gateway as any).botId
  }
})

test('fork neon: and fork omp-sonnet: route with the alias model and engine', async () => {
  await say('fork neon: continue docs', { isThread: true })
  await say('fork omp-sonnet: continue docs', { isThread: true })
  expect(forks).toHaveLength(2)
  expect(forks[0].slice(1)).toEqual(['continue docs', 'gemini-4-neon-high', { engine: 'agy' }])
  expect(forks[1].slice(1)).toEqual(['continue docs', 'claude-sonnet-5-5[1m]', { engine: 'omp' }])
})
