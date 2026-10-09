import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
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

test('hook output is capped', async () => {
  writeHook(`head -c 5000 /dev/zero | tr '\\0' x\nexit 1`)
  const r = await runPreHandoffHook(registry.get('ph-1')!, letter)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.output.length).toBeLessThanOrEqual(1501)
})

test('hook times out: fails open with one log line', async () => {
  writeHook('exec sleep 5')
  const t = Date.now()
  expect(await runPreHandoffHook(registry.get('ph-1')!, letter, PRE_HANDOFF_HOOK_PATH, 200)).toEqual({ ok: true })
  expect(Date.now() - t).toBeLessThan(3000)
  expect(stderr.filter(l => l.startsWith('daemon: pre-handoff hook')).length).toBe(1)
})

test('the daemon keeps running while a hook runs', async () => {
  writeHook('sleep 1\nexit 0')
  const start = Date.now()
  let tickedAfter = Infinity
  setTimeout(() => { tickedAfter = Date.now() - start }, 50)
  expect(await runPreHandoffHook(registry.get('ph-1')!, letter)).toEqual({ ok: true })
  expect(tickedAfter).toBeLessThan(500)  // a blocking run would hold the timer until the hook's 1s sleep ends
})

test('a background child holding stdout open does not delay the verdict', async () => {
  writeHook('sleep 4 &\necho not ready\nexit 1')
  const t = Date.now()
  expect(await runPreHandoffHook(registry.get('ph-1')!, letter)).toEqual({ ok: false, output: 'not ready' })
  expect(Date.now() - t).toBeLessThan(2000)
})

test('non-executable hook: treated as no hook, with a warning', async () => {
  writeHook('exit 1', 0o644)
  expect((await executeTool('handoff', { path: letter }, 'ph-1')).isError).toBeFalsy()
  expect(stderr.some(l => l.includes('pre-handoff hook') && l.includes('not executable'))).toBe(true)
  await Bun.sleep(700)
  expect(spawned).toEqual(['flint'])
})

test('exit 126/127 (the hook could not run a command) is no verdict, not a refusal', async () => {
  writeHook('no-such-command-xyz "$1"')
  expect(await runPreHandoffHook(registry.get('ph-1')!, letter)).toEqual({ ok: true })
  expect(stderr.some(l => l.includes('exit 127'))).toBe(true)
})

test('the reason survives: large output is read to the end, and the tail is kept', async () => {
  writeHook(`head -c 200000 /dev/zero | tr '\\0' x\necho\necho "REASON: push first"\nexit 1`)
  const r = await runPreHandoffHook(registry.get('ph-1')!, letter)
  expect(r.ok).toBe(false)
  if (!r.ok) { expect(r.output.endsWith('REASON: push first')).toBe(true); expect(r.output.length).toBeLessThanOrEqual(1501) }
})

test('a second handoff call during the hook is refused at once; the first proceeds', async () => {
  writeHook('sleep 0.3\nexit 0')
  const [a, b] = await Promise.all([executeTool('handoff', { path: letter }, 'ph-1'), Bun.sleep(50).then(() => executeTool('handoff', { path: letter }, 'ph-1'))])
  expect(a.isError).toBeFalsy()
  expect(b.isError).toBe(true)
  expect(JSON.stringify(b)).toContain('already handing off')
  await Bun.sleep(700)
  expect(spawned).toEqual(['flint'])
})

test('a session killed during the hook does not hand off', async () => {
  writeHook('sleep 0.3\nexit 0')
  const call = executeTool('handoff', { path: letter }, 'ph-1')
  await Bun.sleep(50); registry.delete('ph-1')
  const r = await call
  expect(r.isError).toBe(true)
  expect(JSON.stringify(r)).toContain('ended during the pre-handoff check')
  await Bun.sleep(700)
  expect(spawned).toEqual([])
})

test('a relative letter path resolves against the session dir, for the daemon and the hook alike', async () => {
  const out = join(dir, 'arg')
  writeHook(`echo "$1|$HYDRA_CWD|$(pwd -P)" > ${out}`)
  registry.get('ph-1')!.worktreePath = dir
  expect((await executeTool('handoff', { path: 'HANDOFF.md' }, 'ph-1')).isError).toBeFalsy()
  const [arg, cwdVar, pwd] = readFileSync(out, 'utf8').trim().split('|')
  expect(arg).toBe(letter)
  expect(cwdVar).toBe(dir)
  expect(pwd).toBe(realpathSync(dir))
})

test('a session dir that is gone: the hook runs from the temp dir with HYDRA_CWD empty', async () => {
  const out = join(dir, 'cwd')
  writeHook(`echo "[$HYDRA_CWD]|$(pwd -P)" > ${out}`)
  registry.get('ph-1')!.worktreePath = join(dir, 'gone')
  await runPreHandoffHook(registry.get('ph-1')!, letter)
  const [cwdVar, pwd] = readFileSync(out, 'utf8').trim().split('|')
  expect(cwdVar).toBe('[]')
  expect(pwd).toBe(realpathSync(tmpdir()))
})

test('a timeout kills the hook\'s whole process group', async () => {
  const pidFile = join(dir, 'pid')
  writeHook(`sleep 30 &\necho $! > ${pidFile}\nwait`)
  expect(await runPreHandoffHook(registry.get('ph-1')!, letter, PRE_HANDOFF_HOOK_PATH, 300)).toEqual({ ok: true })
  await Bun.sleep(100)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  expect(alive).toBe(false)
})
