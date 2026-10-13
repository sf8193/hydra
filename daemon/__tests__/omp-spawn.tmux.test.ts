import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway } from '../config.js'
import * as access from '../access.js'
import { registry, threadRegistry } from '../sessions.js'
import { handleSpawnIntercept } from '../commands/global.js'
import { handleResumeIntercept } from '../commands/thread.js'
import { killSession } from '../session-lifecycle.js'
import { startBridgeServer, socketServer } from '../bridge-server.js'
import { engines } from '../engines/instances.js'

// The whole path with real parts: `spawn omp-sonnet:` -> doSpawnSession -> OmpEngine in tmux -> real omp -> the hydra extension -> the real bridge
// server -> the real `reply` tool -> the gateway; then kill and `resume` in the thread. Only Discord is stubbed. Real model: HYDRA_OMP_E2E=1.
const run = process.env.HYDRA_OMP_E2E === '1' && Bun.spawnSync(['tmux', '-V']).exitCode === 0
const until = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(100); return cond() }

const THREAD = 'omp-int-thread'
const sent: Array<{ to: string; text: string }> = []
const spies: Array<{ mockRestore(): void }> = []
let cwd = ''
let savedCwd: string | undefined
let persisted: Array<() => void> = []

beforeAll(() => {
  if (!run) return
  cwd = mkdtempSync(join(tmpdir(), 'hydra-omp-int-'))
  savedCwd = process.env.SPAWN_CWD
  process.env.SPAWN_CWD = cwd
  spies.push(
    spyOn(gateway, 'send').mockImplementation((async (to: string, text: string) => { sent.push({ to, text }); return { id: `m${sent.length}`, channelId: to } }) as any),
    spyOn(gateway, 'react').mockImplementation((async () => {}) as any),
    spyOn(gateway, 'edit').mockImplementation((async () => {}) as any),
    spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => ({ isThread: id === THREAD, isDM: false, parentId: id === THREAD ? 'omp-int-chan' : undefined })) as any),
    spyOn(gateway, 'createThread').mockImplementation((async () => ({ id: THREAD })) as any),
    spyOn(gateway, 'getThreadUrl').mockImplementation((async () => 'https://discord.test/thread') as any),
    spyOn(access, 'loadAccess').mockImplementation((() => ({ allowFrom: ['u1'], groups: { 'omp-int-chan': {} }, pending: {} })) as any),
    spyOn(registry, 'persist').mockImplementation((() => {}) as any),
    spyOn(threadRegistry, 'persist').mockImplementation((() => {}) as any),
  )
  startBridgeServer()
})
afterAll(() => {
  for (const s of spies) s.mockRestore()
  if (savedCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = savedCwd
  socketServer.close()
  if (cwd) rmSync(cwd, { recursive: true, force: true })
})

const said = (needle: string) => sent.some(m => m.to === THREAD && m.text.includes(needle))
const msg = (content: string, isThread: boolean) => ({
  id: `m-${Math.random()}`, channelId: isThread ? THREAD : 'omp-int-chan', authorId: 'u1', authorUsername: 'sam', content, isDM: false, isThread, isBot: false,
  parentChannelId: 'omp-int-chan', hasExistingThread: false, existingThreadId: null, referenceMessageId: null, effectiveThreadId: isThread ? THREAD : null, attachments: [], createdAt: new Date(),
}) as any

test.skipIf(!run)('spawn omp-sonnet answers through the reply tool, and after a kill `resume` brings the same conversation back', async () => {
  await handleSpawnIntercept(msg('spawn omp-sonnet: x', false), 'Tell the sender "ready" with the reply tool, then stop.', {} as any, 'claude-sonnet-5-5[1m]', 'omp')
  const first = registry.get(registry.getByThread(THREAD)!)!
  expect(first.engine).toBe('omp')
  expect(await until(() => said('ready'), 120_000)).toBe(true)
  // The secret goes in the conversation, not the topic: a fresh respawn reads the topic, only a resume has the conversation.
  await engines.omp.deliver(first, { type: 'notification', content: 'The secret word is MANGO. Answer the sender "noted" via the reply tool.', meta: { chat_id: THREAD, message_id: 'q0', user: 'sam' } })
  expect(await until(() => said('noted'), 120_000)).toBe(true)

  // omp's own session id: a resume continues the same session file, so the id survives; a fresh session has a new one.
  const ompId = engines.omp.usageTotals(first, undefined)!.providerSessionId
  expect(ompId).not.toBe('')
  await killSession(first, 'integration test')
  expect(registry.getByThread(THREAD)).toBeUndefined()

  await handleResumeIntercept(msg('resume', true))
  const second = registry.get(registry.getByThread(THREAD)!)!
  expect(second.engine).toBe('omp')
  expect(second.sessionId).not.toBe(first.sessionId)
  expect(await until(() => engines.omp.isConnected(second), 90_000)).toBe(true)
  expect(engines.omp.usageTotals(second, undefined)?.providerSessionId).toBe(ompId)
  // and it still knows what only the first session knew (a fresh session that found the old file on disk could too, so the id above is the proof).
  await engines.omp.deliver(second, { type: 'notification', content: 'What was the secret word? Answer the sender via the reply tool.', meta: { chat_id: THREAD, message_id: 'q1', user: 'sam' } })
  expect(await until(() => said('MANGO'), 120_000)).toBe(true)
  await killSession(second, 'integration test done')
}, 600_000)
