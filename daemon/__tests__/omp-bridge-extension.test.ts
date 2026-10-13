import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

// omp's hydra extension against a fake omp (`pi`) and a fake daemon socket: no model, runs in CI.
const dir = mkdtempSync(join(tmpdir(), 'hydra-omp-ext-'))
const sock = join(dir, 'd.sock')
process.env.DAEMON_SOCK = sock
process.env.HYDRA_SESSION_ID = 's-ext'
let extension: (pi: any) => void
beforeAll(async () => { extension = (await import('../../omp/hydra-bridge.js')).default })

let server: Server | undefined
let conn: Socket | undefined
afterEach(() => { server?.close(); conn?.destroy(); delete (globalThis as any)[Symbol.for('hydra.omp.bridge')]; delete process.env.HYDRA_SPAWN_PROMPT })

const until = async (cond: () => boolean) => { const end = Date.now() + 3000; while (!cond() && Date.now() < end) await Bun.sleep(20); return cond() }
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })

function setup(activeTools: string[], serve = true) {
  const handlers: Record<string, (e: any) => unknown> = {}
  const sent: Array<[string, any]> = []
  const pi = { registerTool() {}, on: (ev: string, h: any) => { handlers[ev] = h }, getActiveTools: () => activeTools, sendUserMessage: (t: string, o?: any) => { sent.push([t, o]) } }
  let registers = 0
  if (serve) server = createServer(s => {
    conn = s
    s.on('data', d => { for (const l of d.toString().split('\n').filter(Boolean)) if (JSON.parse(l).type === 'register') { registers++; s.write(JSON.stringify({ type: 'registered', tools: [tool('A')] }) + '\n') } })
  }).listen(sock)
  return { pi, handlers, sent, registered: () => registers > 0 }
}

test('nothing is injected before omp has started; then the spawn prompt goes first, notifications as asides, and the prompt leaves the environment', async () => {
  process.env.HYDRA_SPAWN_PROMPT = 'boot'
  const t = setup(['A'])
  extension(t.pi)
  expect(process.env.HYDRA_SPAWN_PROMPT).toBeUndefined()
  expect(await until(t.registered)).toBe(true)
  conn!.write(JSON.stringify({ type: 'notification', content: 'hi', meta: { chat_id: '1' } }) + '\n')
  await Bun.sleep(300)
  expect(t.sent).toEqual([])
  await t.handlers.session_start({})
  expect(await until(() => t.sent.length === 2)).toBe(true)
  expect(t.sent[0]).toEqual(['boot', undefined])
  expect(t.sent[1][0]).toContain('hi')
  expect(t.sent[1][1]).toEqual({ deliverAs: 'aside' })
})

test('a tool that arrives later and never becomes active does not stall delivery', async () => {
  const t = setup(['A'])
  extension(t.pi)
  expect(await until(t.registered)).toBe(true)
  await t.handlers.session_start({})
  conn!.write(JSON.stringify({ type: 'tools_update', tools: [tool('A'), tool('B')] }) + '\n')
  conn!.write(JSON.stringify({ type: 'notification', content: 'later', meta: {} }) + '\n')
  expect(await until(() => t.sent.length === 1)).toBe(true)
  expect(t.sent[0][0]).toContain('later')
})

test('a second extension load in the same process does not open a second bridge', async () => {
  const first = setup(['A'])
  extension(first.pi)
  expect(await until(first.registered)).toBe(true)
  const second = setup(['A'], false)
  extension(second.pi)
  expect(Object.keys(second.handlers)).toEqual([])
})
