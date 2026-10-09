import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { executeTool } from '../bridge-dispatch.js'
import { handoffIO, PRE_HANDOFF_HOOK_PATH, runPreHandoffHook } from '../session-lifecycle.js'
import { registry } from '../sessions.js'
import { gateway, STATE_DIR } from '../config.js'

const stderr: string[] = []
process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any

const mk = (id: string, name: string, threadId: string) => registry.set(id, {
  sessionId: id, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner',
} as any)

let dir: string, letter: string, spawned: string[]
const orig = { ...handoffIO, send: gateway.send }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-handoff-'))
  letter = join(dir, 'HANDOFF.md'); writeFileSync(letter, '# Goal\nx\n# Next action\ny\n')
  spawned = []; stderr.length = 0
  handoffIO.killSession = (async (i: any) => { registry.delete(i.sessionId) }) as any
  handoffIO.doSpawnSession = (async (_t: string, _c?: string, _m?: string, o?: any) => { spawned.push(o.handedOffFrom); return { name: 'fresh', sessionId: 'ph-1b', threadId: 'ph-thread', url: '' } }) as any
  ;(gateway as any).send = async () => ({ id: 'm' })
  mk('ph-1', 'flint', 'ph-thread')
  mkdirSync(dirname(PRE_HANDOFF_HOOK_PATH), { recursive: true })
})

afterEach(() => {
  handoffIO.killSession = orig.killSession; handoffIO.doSpawnSession = orig.doSpawnSession
  ;(gateway as any).send = orig.send
  registry.delete('ph-1')
  rmSync(PRE_HANDOFF_HOOK_PATH, { force: true })
  rmSync(dir, { recursive: true, force: true })
})

const writeHook = (body: string, mode = 0o755) => { writeFileSync(PRE_HANDOFF_HOOK_PATH, `#!/bin/sh\n${body}\n`); chmodSync(PRE_HANDOFF_HOOK_PATH, mode) }

test('hook path lives under the test state dir, never the real one', () => {
  expect(PRE_HANDOFF_HOOK_PATH.startsWith(STATE_DIR)).toBe(true)
})

test('no hook: the handoff proceeds', async () => {
  expect((await executeTool('handoff', { path: letter }, 'ph-1')).isError).toBeFalsy()
  await Bun.sleep(700)
  expect(spawned).toEqual(['flint'])
})

test('hook exits 0: the handoff proceeds, and the hook got the letter path and session name', async () => {
  const out = join(dir, 'seen')
  writeHook(`echo "$1|$HYDRA_SESSION_NAME" > ${out}`)
  expect((await executeTool('handoff', { path: letter }, 'ph-1')).isError).toBeFalsy()
  expect(readFileSync(out, 'utf8').trim()).toBe(`${letter}|flint`)
  await Bun.sleep(700)
  expect(spawned).toEqual(['flint'])
})

test('hook exits non-zero: the tool errors with its output and the session is not handed off', async () => {
  writeHook(`echo "letter has no Next action"\necho "push your branch" >&2\nexit 1`)
  const res = await executeTool('handoff', { path: letter }, 'ph-1')
  expect(res.isError).toBe(true)
  const text = res.content.map((c: any) => c.text).join('')
  expect(text).toContain('handoff refused by hooks/pre-handoff:')
  expect(text).toContain('letter has no Next action')
  expect(text).toContain('push your branch')
  await Bun.sleep(700)
  expect(spawned).toEqual([])
  expect(registry.has('ph-1')).toBe(true)
})

test('hook output is capped', () => {
  writeHook(`head -c 5000 /dev/zero | tr '\\0' x\nexit 1`)
  const r = runPreHandoffHook(registry.get('ph-1')!, letter)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.output.length).toBeLessThanOrEqual(1501)
})

test('hook times out: fails open with one log line', () => {
  writeHook('exec sleep 5')
  const t = Date.now()
  expect(runPreHandoffHook(registry.get('ph-1')!, letter, PRE_HANDOFF_HOOK_PATH, 200)).toEqual({ ok: true })
  expect(Date.now() - t).toBeLessThan(3000)
  expect(stderr.filter(l => l.startsWith('daemon: pre-handoff hook')).length).toBe(1)
})

test('non-executable hook: treated as no hook, with a warning', async () => {
  writeHook('exit 1', 0o644)
  expect((await executeTool('handoff', { path: letter }, 'ph-1')).isError).toBeFalsy()
  expect(stderr.some(l => l.includes('pre-handoff hook') && l.includes('not executable'))).toBe(true)
  await Bun.sleep(700)
  expect(spawned).toEqual(['flint'])
})
