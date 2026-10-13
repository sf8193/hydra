import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../config.js'
import * as access from '../access.js'
import * as global from '../commands/global.js'

// The production router: `spawn omp-sonnet: …` must reach handleSpawnIntercept with the omp model AND the omp engine.
let handler: (msg: any) => Promise<void>
const spawns: any[][] = []
const sent: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { handler = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(access, 'loadAccess').mockImplementation((() => ({ allowFrom: ['u1'] })) as any))
  spies.push(spyOn(global, 'handleSpawnIntercept').mockImplementation((async (...args: any[]) => { spawns.push(args) }) as any))
  await import('../router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => { spawns.length = 0; sent.length = 0 })

const say = (content: string) =>
  handler({ id: 'm1', channelId: 'c1', authorId: 'u1', authorUsername: 'u', content, isBot: false, isDM: false, isThread: false, attachments: [], createdAt: new Date() })

test('spawn omp-sonnet: topic starts an omp session on the aliased model', async () => {
  await say('spawn omp-sonnet: fix the bug')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['fix the bug'])
  expect(spawns[0].slice(3)).toEqual(['claude-sonnet-5-5[1m]', 'omp'])
})

test('spawn-wt omp-sonnet: repo topic starts an omp session in a worktree', async () => {
  await say('spawn-wt omp-sonnet: options_bot fix the tests')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['wt:options_bot fix the tests'])
  expect(spawns[0].slice(3)).toEqual(['claude-sonnet-5-5[1m]', 'omp'])
})

test('a bare alias is told it needs a topic, and spawns nothing', async () => {
  await say('spawn: omp-sonnet')
  expect(spawns).toHaveLength(0)
  expect(sent.some(t => t.includes('needs a topic'))).toBe(true)
})

test('a Claude alias still starts a Claude session (no engine)', async () => {
  await say('spawn sonnet: fix the bug')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(3)).toEqual(['sonnet'])
})
