import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import * as global from '../../app/commands/global.js'
import { setHydra } from './test-hydra.js'

// The production router: `spawn sol: …` must reach handleSpawnIntercept with the Codex model AND the codex engine.
let handler: (msg: any) => Promise<void>
const spawns: any[][] = []
const sent: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(gateway, 'onMessage').mockImplementation(((cb: any) => { handler = cb }) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(setHydra({ operators: ['u1'], channels: { c1: {} } }))
  spies.push(spyOn(global, 'handleSpawnIntercept').mockImplementation((async (...args: any[]) => { spawns.push(args) }) as any))
  await import('../../app/router.js')
})
afterAll(() => { for (const s of spies) s.mockRestore() })
beforeEach(() => { spawns.length = 0; sent.length = 0 })

const say = (content: string) =>
  handler({ id: 'm1', channelId: 'c1', authorId: 'u1', authorUsername: 'u', content, isBot: false, isDM: false, isThread: false, attachments: [], createdAt: new Date() })

test('spawn sol: topic starts a codex session on the aliased model', async () => {
  await say('spawn sol: fix the bug')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['fix the bug'])
  expect(spawns[0].slice(2)).toEqual(['gpt-6.1-sol', 'codex'])
})

test('spawn-wt sol: repo topic starts a codex session in a worktree', async () => {
  await say('spawn-wt sol: options_bot fix the tests')
  expect(spawns).toHaveLength(1)
  expect(spawns[0].slice(1, 2)).toEqual(['wt:options_bot fix the tests'])
  expect(spawns[0].slice(2)).toEqual(['gpt-6.1-sol', 'codex'])
})

test('a bare alias is told it needs a topic, and spawns nothing', async () => {
  await say('spawn: sol')
  expect(spawns).toHaveLength(0)
  expect(sent.some(t => t.includes('needs a topic'))).toBe(true)
})
