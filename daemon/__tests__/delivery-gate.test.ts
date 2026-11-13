// The drift gate holds for what is already queued, and for every engine: a message queued before hydra.toml changed is not
// flushed to a session born under the old policy; a persisted queue restored at boot is held to the same rule; a Codex
// session in a specialist's thread is refused too. A refusal caused by hydra.toml is not a failure that backs off a revive.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../config.js'
import { BridgeTransport, transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import type { LaunchPolicy } from '../scope.js'
import { threadNotices } from '../notice-limit.js'
import type { HydraConfig, Specialist } from '../../config/types.js'

process.stderr.write = (() => true) as any

const spec = (over: Partial<Specialist> = {}): Specialist => ({ id: 'ops', workdir: '/srv/ops', listens: [], allow: [], sessions: 'shared', max: 20, was: [], access: 'operator', ...over })
const configure = (over: Partial<Specialist> = {}): void => _setHydraConfigForTesting({
  operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: { ops: spec(over) },
} as HydraConfig)
const operatorPolicy: LaunchPolicy = { specialist: 'ops', access: 'operator', id: 'operator' }
const flip = () => configure({ access: 'workdir', tools: ['Read'], mcp: [] })

const ids: string[] = []
/** The real Claude adapter (the gate is in its `deliver`), reported alive, for a session of the operator-access specialist `ops`. */
function session(id: string, over: Record<string, unknown> = {}) {
  ids.push(id)
  registry.set(id, {
    sessionId: id, tmuxName: `${id}-tmux`, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', policy: operatorPolicy, sessionType: 'thread_owner', adapter: Object.assign(Object.create(engines.claude), { isAlive: () => true }), ...over,
  } as any)
  return registry.get(id)!
}
/** A bridge connection that records what is written to it. */
const bridgeConn = (id: string) => { const written: any[] = []; return { conn: { sessionId: id, socket: { destroyed: false, write: (s: string) => { written.push(JSON.parse(s)); return true } } } as any, written } }

let posted: string[] = []
const realSend = gateway.send
const watch = () => { posted = []; threadNotices.clear(); (gateway as any).send = async (_c: string, t: string) => { posted.push(t); return { id: 'm' } } }
afterEach(() => {
  ;(gateway as any).send = realSend
  _setHydraConfigForTesting(undefined)
  for (const id of ids.splice(0)) { registry.delete(id); transport.bridges.delete(id); transport.messageQueues.delete(id) }
  rmSync(join(STATE_DIR, 'message-queue.json'), { force: true })
})
const REMEDY = (name: string) => `Run \`hydra kill ${name}\`; the next message to the specialist starts a new session that re-reads hydra.toml.`
const notifications = (w: any[]) => w.filter(m => m.type === 'notification')

describe('a queued message is not flushed to a session whose policy drifted', () => {
  test('queued before hydra.toml changed, flushed after: dropped, the thread told the remedy; non-message traffic still goes', async () => {
    configure(); watch()
    const s = session('q1')
    transport.writeOrQueue('q1', { type: 'notification', content: 'queued while it was starting' })
    transport.sendOrQueue('q1', { type: 'tools_update', tools: [] })
    expect(transport.messageQueues.get('q1')).toHaveLength(2)
    flip()
    const { conn, written } = bridgeConn('q1')
    transport.bridges.set('q1', conn)
    transport.flushQueue('q1')
    await Bun.sleep(30)
    expect(notifications(written)).toEqual([])
    expect(written.map(m => m.type)).toEqual(['tools_update'])
    expect(transport.messageQueues.has('q1')).toBe(false)
    expect(posted.join('\n')).toContain(REMEDY(s.tmuxName))
  })

  test('queued through sendOrQueue while the session was starting (no bridge yet), flushed when it registers', async () => {
    configure(); watch()
    const s = session('q2')
    transport.sendOrQueue('q2', { type: 'notification', content: 'first message', meta: {} })
    await Bun.sleep(20)
    expect(transport.messageQueues.get('q2')).toHaveLength(1)
    flip()
    const { conn, written } = bridgeConn('q2')
    transport.bridges.set('q2', conn)
    transport.flushQueue('q2')
    await Bun.sleep(30)
    expect(notifications(written)).toEqual([])
    expect(posted.join('\n')).toContain(REMEDY(s.tmuxName))
  })

  test('a persisted queue restored at boot is held to the same rule', async () => {
    configure(); watch()
    const s = session('q3')
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, 'message-queue.json'), JSON.stringify({ q3: [{ type: 'notification', content: 'sent before the daemon restarted' }] }) + '\n')
    const restarted = new BridgeTransport()
    expect(restarted.messageQueues.get('q3')).toHaveLength(1)
    flip()
    const { conn, written } = bridgeConn('q3')
    restarted.bridges.set('q3', conn)
    restarted.flushQueue('q3')
    await Bun.sleep(30)
    expect(notifications(written)).toEqual([])
    expect(posted.join('\n')).toContain(REMEDY(s.tmuxName))
  })

  test('the control: with no drift the queue is flushed in order', async () => {
    configure(); watch()
    session('q4')
    transport.writeOrQueue('q4', { type: 'notification', content: 'one' })
    transport.writeOrQueue('q4', { type: 'notification', content: 'two' })
    const { conn, written } = bridgeConn('q4')
    transport.bridges.set('q4', conn)
    transport.flushQueue('q4')
    expect(written.map(m => m.content)).toEqual(['one', 'two'])
    expect(posted).toEqual([])
  })

  test('a session no specialist fills, and one with no policy of an operator-access specialist, flush as ever', async () => {
    configure(); watch()
    session('q5', { policy: undefined, threadId: 'th-elsewhere' })
    transport.writeOrQueue('q5', { type: 'notification', content: 'plain' })
    const { conn, written } = bridgeConn('q5')
    transport.bridges.set('q5', conn)
    transport.flushQueue('q5')
    expect(written.map(m => m.content)).toEqual(['plain'])
  })
})

describe('every engine is held to it: a Codex session in a specialist\'s thread', () => {
  const adapter = new CodexEngineAdapter({} as any)
  test('after hydra.toml says workdir, a message to a Codex session born as operator is refused with the remedy', async () => {
    configure(); watch()
    const info = { ...session('cx1', { engine: 'codex' }), adapter }
    flip()
    const r = await adapter.deliver(info as any, { type: 'notification', content: 'hello' })
    expect(r).toMatchObject({ status: 'rejected', retryable: false })
    expect((r as any).reason).toContain(REMEDY(info.tmuxName))
    expect((r as any).reason).toContain('access: operator -> workdir')
  })
  test('a Codex session of an operator-access specialist, or of no specialist, is not refused by the gate', async () => {
    configure()
    const info = { ...session('cx2', { engine: 'codex' }), adapter }
    const r = await adapter.deliver(info as any, { type: 'notification', content: 'hello', optional: true } as any)
    // `optional` is Codex's own refusal: the gate did not speak.
    expect((r as any).reason).toBe('optional delivery dropped for codex')
    const plain = { ...session('cx3', { engine: 'codex', policy: undefined, threadId: 'th-nowhere' }), adapter }
    expect(((await adapter.deliver(plain as any, { type: 'notification', content: 'x', optional: true } as any)) as any).reason).toBe('optional delivery dropped for codex')
  })
})
