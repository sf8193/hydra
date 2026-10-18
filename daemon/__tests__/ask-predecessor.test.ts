import { afterEach, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '../bridge-dispatch.js'
import { registry, type Predecessor } from '../sessions.js'
import { claudeEngine, engines } from '../engines/instances.js'
import { askForkArgv, askForkEnv, claudeForkProcess, forkFailureOutput } from '../engines/claude-engine.js'
import { getToolsForSession, isToolAllowed } from '../tool-surface.js'
import { codexStaticTools } from '../bridge-tools.js'
import { buildHandoffPrompt } from '../prompts/session.js'
import { ASK_PREDECESSOR_TIMEOUT_MS } from '../../shared/constants.js'

process.stderr.write = (() => true) as any

const mk = (id: string, name: string, threadId: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner', ...extra,
} as any)

const claudePred: Predecessor = { engine: 'claude', fork: { claudeSessionId: 'pred-uuid', parentName: 'flint' }, cwd: '/wt/flint', model: 'claude-opus-5-5' }
const restores: Array<() => void> = []
afterEach(() => { while (restores.length) restores.pop()!() })

test('the tool is on the surface only where it works: a Claude predecessor and a non-Codex successor', () => {
  const codexPred: Predecessor = { engine: 'codex', fork: { codexThreadId: 'th-9', codexHomeName: 'reef-home', parentName: 'reef' }, cwd: '/repo' }
  const ids = ['ap-surf-1', 'ap-surf-2', 'ap-surf-3', 'ap-surf-4', 'ap-surf-5']
  mk('ap-surf-1', 'flint', 'ap-thread-s1')
  mk('ap-surf-2', 'reef', 'ap-thread-s2', { predecessor: claudePred })
  mk('ap-surf-3', 'moss', 'ap-thread-s3', { predecessor: codexPred })
  mk('ap-surf-4', 'tern', 'ap-thread-s4', { predecessor: claudePred, engine: 'codex' })
  mk('ap-surf-5', 'wren', 'ap-thread-s5', { predecessor: claudePred, engine: 'omp' })
  try {
    const has = (id: string) => getToolsForSession(id).map(t => t.name).includes('ask_predecessor')
    // No predecessor; Claude → Claude; Codex predecessor; Codex successor (60s client); omp successor (60s bridge).
    expect(ids.map(has)).toEqual([false, true, false, false, false])
    expect(ids.map(id => isToolAllowed(id, 'ask_predecessor'))).toEqual([false, true, false, false, false])
    expect(registry.get('ap-surf-2')!.capabilities).toBeUndefined()  // derived, never stored
    // Codex's MCP client stops at its default 60s, so it never advertises the tool.
    expect(codexStaticTools().map(t => t.name)).not.toContain('ask_predecessor')
  } finally {
    for (const id of ids) registry.delete(id)
  }
})

test('ask_predecessor errors clearly without a predecessor', async () => {
  mk('ap-none', 'flint', 'ap-thread-none')
  try {
    const r = await executeTool('ask_predecessor', { question: 'why?' }, 'ap-none')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('ask_predecessor is not available to this session')
  } finally {
    registry.delete('ap-none')
  }
})

test('dispatch hands the predecessor\'s plan, cwd, model and the timeout to its engine\'s askFork', async () => {
  const calls: any[] = []
  const orig = engines.claude.askFork
  let self: unknown
  engines.claude.askFork = (async function (this: unknown, ...a: any[]) { self = this; calls.push(a); return 'it was the flaky test' }) as any
  restores.push(() => { engines.claude.askFork = orig })
  mk('ap-ask', 'fresh', 'ap-thread-ask', { predecessor: claudePred })
  try {
    const r = await executeTool('ask_predecessor', { question: 'why skip X?' }, 'ap-ask')
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toBe('it was the flaky test')
    expect(calls).toEqual([[claudePred.fork, '/wt/flint', 'why skip X?', ASK_PREDECESSOR_TIMEOUT_MS, 'claude-opus-5-5']])
    expect(self).toBe(engines.claude)  // called as a method: an adapter's askFork may use this
    expect((await executeTool('ask_predecessor', { question: '  ' }, 'ap-ask')).isError).toBe(true)
    expect(calls.length).toBe(1)
  } finally {
    registry.delete('ap-ask')
  }
})

// A fake `claude` child: emits the given output, then exits.
function fakeChild(stdout: string, code: number | null, stderr = '') {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {}
  child.killed = false; child.exitCode = null; child.signalCode = null
  child.kill = (sig: string) => { child.killed = sig; setTimeout(() => child.emit('close', null, sig), 0); return true }
  if (code !== null) setTimeout(() => { child.stdout.emit('data', stdout); child.stderr.emit('data', stderr); child.emit('close', code, null) }, 0)
  return child
}

test('Claude askFork: exact argv, predecessor cwd, Hydra-free env; answer trimmed; failures reject', async () => {
  const orig = claudeForkProcess.spawn
  const cwd = mkdtempSync(join(tmpdir(), 'ap-cwd-'))
  restores.push(() => { claudeForkProcess.spawn = orig; rmSync(cwd, { recursive: true, force: true }) })
  const calls: any[] = []
  let next = () => fakeChild('  the answer\n', 0)
  claudeForkProcess.spawn = ((args: string[], opts: any) => { calls.push({ args, opts }); return next() }) as any

  expect(await claudeEngine.askFork(claudePred.fork, cwd, 'why?', 5000, 'claude-opus-5-5')).toBe('the answer')
  expect(calls[0].args).toEqual([
    '--resume', 'pred-uuid', '--fork-session', '--no-session-persistence',
    '--strict-mcp-config', '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob',
    '--model', 'claude-opus-5-5',
    '-p', '--', 'why?\n\nAnswer only; change nothing.',
  ])
  expect(askForkArgv('id', 'q')).not.toContain('--model')
  expect(calls[0].opts.cwd).toBe(cwd)
  for (const v of ['HYDRA_SESSION_ID', 'HYDRA_SESSION_NAME', 'HYDRA_ROLE', 'DAEMON_SOCK', 'TMUX', 'TMUX_PANE']) expect(calls[0].opts.env[v]).toBeUndefined()
  expect(askForkEnv({ HYDRA_SESSION_ID: 's', DAEMON_SOCK: '/x', PATH: '/bin' }).PATH).toBe('/bin')

  next = () => fakeChild('', 1, 'No conversation found with session ID: pred-uuid')
  await expect(claudeEngine.askFork(claudePred.fork, cwd, 'why?', 5000)).rejects.toThrow('No conversation found')
  next = () => fakeChild('   ', 0)
  await expect(claudeEngine.askFork(claudePred.fork, cwd, 'why?', 5000)).rejects.toThrow('empty answer')
  let hung: any
  next = () => (hung = fakeChild('', null))
  await expect(claudeEngine.askFork(claudePred.fork, cwd, 'why?', 20)).rejects.toThrow('no answer within')
  expect(hung.killed).toBe('SIGTERM')
  await expect(claudeEngine.askFork(claudePred.fork, join(cwd, 'gone'), 'why?', 5000)).rejects.toThrow('no longer exists')
  await expect(claudeEngine.askFork({ parentName: 'flint' }, cwd, 'why?', 5000)).rejects.toThrow('no Claude session id')
  expect(calls.length).toBe(4)
})

test('only Claude can be forked headless: Codex and omp have no askFork, so dispatch never reaches them', async () => {
  expect(typeof engines.claude.askFork).toBe('function')
  expect(engines.codex.askFork).toBeUndefined()
  expect(engines.omp.askFork).toBeUndefined()
  const plan = { codexThreadId: 'th-9', codexHomeName: 'reef-home', parentName: 'reef' }
  mk('ap-codex', 'fresh', 'ap-thread-codex', { predecessor: { engine: 'codex', fork: plan, cwd: '/repo' } })
  try {
    const r = await executeTool('ask_predecessor', { question: 'why?' }, 'ap-codex')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('ask_predecessor is not available to this session')
  } finally {
    registry.delete('ap-codex')
  }
})

test('successor prompt: ask_predecessor first where it works, the spawned fork for longer digging', () => {
  const p = { sessionId: 's-1', tmuxName: 'fresh', threadId: 'th-1', topic: 't', originFrom: 'flint', artifact: '/h.md' }
  const recipe = 'spawn_session(fork_from="predecessor", headless=true, read_only=true, phase_budget="5m", topic="<question>")'
  const none = buildHandoffPrompt(p)
  const forkOnly = buildHandoffPrompt({ ...p, hasPredecessor: true })  // a Codex or omp successor
  const both = buildHandoffPrompt({ ...p, hasPredecessor: true, canAsk: true })
  expect(none).not.toContain('fork_from')
  expect(forkOnly).toContain(`If a question comes up that only flint can answer, ask a fork of it: ${recipe}. Its answer arrives as a result message.`)
  expect(forkOnly).not.toContain('ask_predecessor')
  expect(both).toContain('If a question comes up that only flint can answer, call ask_predecessor(question) for a one-turn answer. For digging that takes more than one turn, ask a fork of it: ')
  expect(both).toContain(recipe)
  expect(both.split('\n').length).toBe(none.split('\n').length + 1)
})

test('a failed fork reports both streams, each from its start', () => {
  expect(forkFailureOutput('', '')).toBe('no output')
  expect(forkFailureOutput('Prompt is too long', 'hook: started')).toBe('stderr: hook: started | stdout: Prompt is too long')
  const trace = 'Error: boom\n' + '    at frame\n'.repeat(100)
  expect(forkFailureOutput('', trace)).toStartWith('stderr: Error: boom')
  expect(forkFailureOutput('', trace)).toEndWith('…')
})

test('one ask_predecessor at a time per session; the slot frees after an answer or a failure', async () => {
  let release!: (a: string) => void
  const orig = engines.claude.askFork
  engines.claude.askFork = (() => new Promise<string>(r => { release = r })) as any
  restores.push(() => { engines.claude.askFork = orig })
  mk('ap-busy', 'fresh', 'ap-thread-busy', { predecessor: claudePred })
  try {
    const first = executeTool('ask_predecessor', { question: 'one' }, 'ap-busy')
    const second = await executeTool('ask_predecessor', { question: 'two' }, 'ap-busy')
    expect(second.isError).toBe(true)
    expect(second.content[0].text).toContain('still running')
    release('done')
    expect((await first).content[0].text).toBe('done')
    // A rejected ask frees the slot too.
    engines.claude.askFork = (async () => { throw new Error('fork failed') }) as any
    expect((await executeTool('ask_predecessor', { question: 'three' }, 'ap-busy')).isError).toBe(true)
    engines.claude.askFork = (async () => 'again') as any
    expect((await executeTool('ask_predecessor', { question: 'four' }, 'ap-busy')).content[0].text).toBe('again')
  } finally {
    registry.delete('ap-busy')
  }
})
