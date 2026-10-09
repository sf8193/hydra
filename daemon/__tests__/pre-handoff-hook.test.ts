import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { executeTool } from '../bridge-dispatch.js'
import { PRE_HANDOFF_HOOK_PATH, runPreHandoffHook } from '../session-lifecycle.js'
import { registry, type SessionInfo } from '../sessions.js'
import { STATE_DIR } from '../config.js'
import { openHandoffThread, waitFor, type HandoffThread } from './handoff-thread.js'

const stderr: string[] = []
process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any

let dir: string, letter: string, thread: HandoffThread, info: SessionInfo, id: string
// Who each successor spawn handed off from.
const spawned = () => thread.spawned.map(o => o.handedOffFrom)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-handoff-'))
  letter = join(dir, 'HANDOFF.md'); writeFileSync(letter, '# Goal\nx\n# Next action\ny\n')
  stderr.length = 0
  thread = openHandoffThread('flint'); info = thread.info; id = info.sessionId
  mkdirSync(dirname(PRE_HANDOFF_HOOK_PATH), { recursive: true })
})

afterEach(() => {
  thread.restore()
  rmSync(PRE_HANDOFF_HOOK_PATH, { force: true })
  rmSync(dir, { recursive: true, force: true })
})

const writeHook = (body: string, mode = 0o755) => { writeFileSync(PRE_HANDOFF_HOOK_PATH, `#!/bin/sh\n${body}\n`); chmodSync(PRE_HANDOFF_HOOK_PATH, mode) }

test('hook path lives under the test state dir, never the real one', () => {
  expect(PRE_HANDOFF_HOOK_PATH.startsWith(STATE_DIR)).toBe(true)
})

test('no hook: the handoff proceeds', async () => {
  expect((await executeTool('handoff', { path: letter }, id)).isError).toBeFalsy()
  await waitFor(() => spawned().length > 0)
  expect(spawned()).toEqual(['flint'])
})

test('hook exits 0: the handoff proceeds, and the hook got the letter path and session name', async () => {
  const out = join(dir, 'seen')
  writeHook(`echo "$1|$HYDRA_SESSION_NAME" > ${out}`)
  expect((await executeTool('handoff', { path: letter }, id)).isError).toBeFalsy()
  expect(readFileSync(out, 'utf8').trim()).toBe(`${letter}|flint`)
  await waitFor(() => spawned().length > 0)
  expect(spawned()).toEqual(['flint'])
})

test('hook exits non-zero: the tool errors with its output and the session is not handed off', async () => {
  writeHook(`echo "letter has no Next action"\necho "push your branch" >&2\nexit 1`)
  const res = await executeTool('handoff', { path: letter }, id)
  expect(res.isError).toBe(true)
  const text = res.content.map((c: any) => c.text).join('')
  expect(text).toContain('handoff refused by hooks/pre-handoff:')
  expect(text).toContain('letter has no Next action')
  expect(text).toContain('push your branch')
  await Bun.sleep(700)
  expect(spawned()).toEqual([])
  expect(registry.has(id)).toBe(true)
})

test('hook times out: fails open with one log line', async () => {
  writeHook('exec sleep 5')
  const t = Date.now()
  expect(await runPreHandoffHook(info, letter, PRE_HANDOFF_HOOK_PATH, 200)).toEqual({ ok: true })
  expect(Date.now() - t).toBeLessThan(3000)
  expect(stderr.filter(l => l.startsWith('daemon: pre-handoff hook')).length).toBe(1)
})

test('every run logs one line: outcome, exit code, duration, and why for a fail-open', async () => {
  const runs: Array<[string, RegExp]> = [
    ['exit 0', /^daemon: pre-handoff hook flint: pass, exit 0, \d+ms\n$/],
    ['echo no; exit 3', /^daemon: pre-handoff hook flint: refused, exit 3, \d+ms\n$/],
    ['no-such-command-xyz', /^daemon: pre-handoff hook flint: fail-open, exit 127, \d+ms \(the hook could not run a command\)\n$/],
    ['kill -9 $$', /^daemon: pre-handoff hook flint: fail-open, exit none, \d+ms \(signal SIGKILL\)\n$/],
  ]
  for (const [body, line] of runs) {
    writeHook(body); stderr.length = 0
    await runPreHandoffHook(info, letter)
    const logged = stderr.filter(l => l.startsWith('daemon: pre-handoff hook'))
    expect([body, logged.length]).toEqual([body, 1])
    expect(logged[0]).toMatch(line)
  }
})

test('a hook that cannot start logs one fail-open line with no exit code', async () => {
  // The interpreter doesn't exist, so the spawn itself fails (a throw or an 'error' event): no verdict, hand off anyway.
  writeFileSync(PRE_HANDOFF_HOOK_PATH, '#!/nonexistent/interpreter\nexit 1\n'); chmodSync(PRE_HANDOFF_HOOK_PATH, 0o755)
  expect(await runPreHandoffHook(info, letter)).toEqual({ ok: true })
  const logged = stderr.filter(l => l.startsWith('daemon: pre-handoff hook'))
  expect(logged.length).toBe(1)
  expect(logged[0]).toMatch(/^daemon: pre-handoff hook flint: fail-open, exit none, \d+ms \(.+\)\n$/)
})

test('the daemon keeps running while a hook runs', async () => {
  writeHook('sleep 1\nexit 0')
  const start = Date.now()
  let tickedAfter = Infinity
  setTimeout(() => { tickedAfter = Date.now() - start }, 50)
  expect(await runPreHandoffHook(info, letter)).toEqual({ ok: true })
  expect(tickedAfter).toBeLessThan(500)  // a blocking run would hold the timer until the hook's 1s sleep ends
})

test('a background child holding stdout open does not delay the verdict', async () => {
  writeHook('sleep 4 &\necho not ready\nexit 1')
  const t = Date.now()
  expect(await runPreHandoffHook(info, letter)).toEqual({ ok: false, output: 'not ready' })
  expect(Date.now() - t).toBeLessThan(2000)
})

test('non-executable hook: treated as no hook, with a warning', async () => {
  writeHook('exit 1', 0o644)
  expect((await executeTool('handoff', { path: letter }, id)).isError).toBeFalsy()
  expect(stderr.some(l => l.includes('pre-handoff hook') && l.includes('not executable'))).toBe(true)
  await waitFor(() => spawned().length > 0)
  expect(spawned()).toEqual(['flint'])
})

test('exit 126/127 (the hook could not run a command) is no verdict, not a refusal', async () => {
  writeHook('no-such-command-xyz "$1"')
  expect(await runPreHandoffHook(info, letter)).toEqual({ ok: true })
  expect(stderr.some(l => l.includes('exit 127'))).toBe(true)
})

test('the reason survives: large output is read to the end, and the tail is kept', async () => {
  writeHook(`head -c 200000 /dev/zero | tr '\\0' x\necho\necho "REASON: push first"\nexit 1`)
  const r = await runPreHandoffHook(info, letter)
  expect(r.ok).toBe(false)
  if (!r.ok) { expect(r.output.endsWith('REASON: push first')).toBe(true); expect(r.output.length).toBeLessThanOrEqual(1501) }
})

test('a second handoff call during the hook is refused at once; the first proceeds', async () => {
  writeHook('sleep 0.3\nexit 0')
  const [a, b] = await Promise.all([executeTool('handoff', { path: letter }, id), Bun.sleep(50).then(() => executeTool('handoff', { path: letter }, id))])
  expect(a.isError).toBeFalsy()
  expect(b.isError).toBe(true)
  expect(JSON.stringify(b)).toContain('already handing off')
  await waitFor(() => spawned().length > 0)
  expect(spawned()).toEqual(['flint'])
})

test('a session killed during the hook does not hand off', async () => {
  writeHook('sleep 0.3\nexit 0')
  const call = executeTool('handoff', { path: letter }, id)
  await Bun.sleep(50); registry.delete(id)
  const r = await call
  expect(r.isError).toBe(true)
  expect(JSON.stringify(r)).toContain('ended during the pre-handoff check')
  await Bun.sleep(700)
  expect(spawned()).toEqual([])
})

test('a relative letter path resolves against the session dir, for the daemon and the hook alike', async () => {
  const out = join(dir, 'arg')
  writeHook(`echo "$1|$HYDRA_CWD|$(pwd -P)" > ${out}`)
  info.worktreePath = dir
  expect((await executeTool('handoff', { path: 'HANDOFF.md' }, id)).isError).toBeFalsy()
  const [arg, cwdVar, pwd] = readFileSync(out, 'utf8').trim().split('|')
  expect(arg).toBe(letter)
  expect(cwdVar).toBe(dir)
  expect(pwd).toBe(realpathSync(dir))
  // Let the handoff finish here, so its timer can't fire after afterEach restores the gateway.
  await waitFor(() => spawned().length > 0)
})

test('a session dir that is gone: the hook runs from the temp dir with HYDRA_CWD empty', async () => {
  const out = join(dir, 'cwd')
  writeHook(`echo "[$HYDRA_CWD]|$(pwd -P)" > ${out}`)
  info.worktreePath = join(dir, 'gone')
  await runPreHandoffHook(info, letter)
  const [cwdVar, pwd] = readFileSync(out, 'utf8').trim().split('|')
  expect(cwdVar).toBe('[]')
  expect(pwd).toBe(realpathSync(tmpdir()))
})

test('a timeout kills the hook\'s whole process group', async () => {
  const pidFile = join(dir, 'pid')
  writeHook(`sleep 30 &\necho $! > ${pidFile}\nwait`)
  expect(await runPreHandoffHook(info, letter, PRE_HANDOFF_HOOK_PATH, 300)).toEqual({ ok: true })
  await Bun.sleep(100)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  expect(alive).toBe(false)
})
