import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { registry, threadRegistry } from '../../sessions/registry.js'
import { gateway } from '../../infra/config.js'
import { on } from '../../infra/event-bus.js'
import { killSession } from '../../app/session-lifecycle.js'
import { executeTool } from '../../app/bridge-dispatch.js'
import { handleCLIRequest } from '../../app/cli-handler.js'

// `session:death` says whether the session was ended on purpose. What the operator ends ends: a kill takes the thread's
// Slack subscriptions with it. A crash, a handoff, a respawn or a resumable idle end keeps them.

const heard: { id: string; deliberate?: boolean }[] = []
const mk = (id: string, extra = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: '', threadId: `t-${id}`, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {}, isAlive: (i: any) => !i.deadAt, isConnected: () => false }, sessionType: 'thread_owner', ...extra,
} as any)

async function withQuietPlatform(run: () => Promise<void>) {
  const orig = { send: gateway.send, rp: registry.persist, tp: threadRegistry.persist }
  ;(gateway as any).send = async () => ({ id: 'm' })
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  const off = on('session:death', ({ sessionId, deliberate }) => { heard.push({ id: sessionId, deliberate }) }, 'test')
  try { await run() } finally {
    off()
    ;(gateway as any).send = orig.send; (registry as any).persist = orig.rp; (threadRegistry as any).persist = orig.tp
    heard.length = 0
  }
}
const deliberateOf = (id: string) => heard.find(h => h.id === id)?.deliberate

test('killSession: a plain kill is deliberate; keepRecord (resumable idle end), keepWatches (handoff, respawn, recovery) and a guest are not', async () => {
  await withQuietPlatform(async () => {
    mk('kd-plain'); mk('kd-record'); mk('kd-watches'); mk('kd-guest', { sessionType: 'thread_guest' })
    await killSession(registry.get('kd-plain')!, 'session ended')
    await killSession(registry.get('kd-record')!, 'idle', { keepRecord: true })
    await killSession(registry.get('kd-watches')!, 'handed off', { keepWatches: true })
    await killSession(registry.get('kd-guest')!, 'session ended')
    expect([deliberateOf('kd-plain'), deliberateOf('kd-record'), deliberateOf('kd-watches'), deliberateOf('kd-guest')]).toEqual([true, false, false, false])
    for (const id of ['kd-plain', 'kd-record', 'kd-watches', 'kd-guest']) registry.delete(id)
  })
})

test('the kill_session tool, from an agent and from main, and `hydra kill` are deliberate', async () => {
  await withQuietPlatform(async () => {
    mk('kd-parent'); mk('kd-child', { initiator: 'kd-parent' }); mk('kd-by-main'); mk('kd-by-cli')
    await executeTool('kill_session', { session_id: 'kd-child' }, 'kd-parent')
    await executeTool('kill_session', { session_id: 'kd-by-main' }, 'main')
    await handleCLIRequest({ type: 'cli', command: 'kill', id: 'kd-1', params: { name: 'kd-by-cli' } } as any)
    expect([deliberateOf('kd-child'), deliberateOf('kd-by-main'), deliberateOf('kd-by-cli')]).toEqual([true, true, true])
    for (const id of ['kd-parent', 'kd-child', 'kd-by-main', 'kd-by-cli']) registry.delete(id)
  })
})

// Every end that is not a handoff, a respawn, a recovery or a resumable idle end goes through killSession with default options (the
// `kill` command and its reaction, a non-resumable idle reap, a phase-budget end, a protocol end, an ephemeral [done]), so it is deliberate.
// This reads each call's whole argument list, across lines, and pins which files may keep subscriptions: a new one must be added on purpose.
const argsOf = (src: string, from: number): string => {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1)
  }
  return src.slice(from)
}
test('only these files call killSession with keepRecord or keepWatches (any layout); the destroy path emits a deliberate death', () => {
  const root = join(import.meta.dir, '..', '..')
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === 'node_modules' || f === '__tests__' || f.startsWith('.')) continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.includes('/scripts/')) files.push(p) } }
  for (const d of ['app', 'infra', 'engines', 'sessions', 'specialists', 'connectors', 'shared']) walk(join(root, d))
  const keeping = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bkillSession\(/g)) {
      if (/export (async )?function $/.test(src.slice(Math.max(0, m.index! - 24), m.index!))) continue
      if (/keepRecord|keepWatches/.test(argsOf(src, m.index! + 'killSession'.length))) keeping.add(f.slice(root.length + 1))
    }
  }
  expect([...keeping].sort()).toEqual(['app/recovery.ts', 'app/session-lifecycle.ts'])
  expect(readFileSync(join(root, 'app/destroy.ts'), 'utf8')).toContain('emitSessionDeath(info, true)')
})
