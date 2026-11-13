// A confined session is unreachable until its start has been verified (hydra#619.1, .2): the one delivery gate (the Claude adapter's
// `deliver`, and the queue flush behind it) refuses a scoped session that carries no `verified` marker, whichever route a message took:
// by id, by name, send_to_thread, a second conversation's message, a typed paste. The marker is persisted, so a record restored at boot
// without it (a crash inside the wait, or a session started before hydra verified starts) is not delivered to and is not killed.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../config.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { endVerifying, policyIdFor, sessionDrift, startVerifying, unverified, type LaunchPolicy } from '../scope.js'
import { threadNotices } from '../notice-limit.js'
import type { HydraConfig, Specialist } from '../../config/types.js'

process.stderr.write = (() => true) as any

const spec = (over: Partial<Specialist> = {}): Specialist => ({ id: 'ops', workdir: '/srv/ops', listens: [], allow: [], sessions: 'shared', max: 20, was: [], access: 'workdir', tools: ['Read'], mcp: [], ...over })
const configure = (): void => _setHydraConfigForTesting({
  operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: { ops: spec() },
} as HydraConfig)
const confinedPolicy = (): LaunchPolicy => ({ specialist: 'ops', access: 'workdir', workdir: '/srv/ops', tools: ['Read'], servers: [], id: policyIdFor('/srv/ops', ['Read'], []) })
const operatorPolicy: LaunchPolicy = { specialist: 'ops', access: 'operator', id: 'operator' }

const ids: string[] = []
function session(id: string, over: Record<string, unknown> = {}) {
  ids.push(id)
  registry.set(id, {
    sessionId: id, tmuxName: `${id}-tmux`, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', policy: confinedPolicy(), sessionType: 'scoped', adapter: Object.assign(Object.create(engines.claude), { isAlive: () => true }), ...over,
  } as any)
  return registry.get(id)!
}
const bridgeConn = (id: string) => { const written: any[] = []; return { conn: { sessionId: id, socket: { destroyed: false, write: (s: string) => { written.push(JSON.parse(s)); return true } } } as any, written } }
let posted: string[] = []
const realSend = gateway.send
const watch = () => { posted = []; threadNotices.clear(); (gateway as any).send = async (_c: string, t: string) => { posted.push(t); return { id: 'm' } } }
afterEach(() => {
  ;(gateway as any).send = realSend
  _setHydraConfigForTesting(undefined)
  for (const id of ids.splice(0)) { endVerifying(id); registry.delete(id); transport.bridges.delete(id); transport.messageQueues.delete(id) }
  rmSync(join(STATE_DIR, 'message-queue.json'), { force: true })
})
const note = { type: 'notification', content: 'hello', meta: { message_id: 'm1' } } as any
const deliver = (id: string) => registry.get(id)!.adapter.deliver(registry.get(id)!, note)

describe('while the start is being verified, nothing reaches the session', () => {
  test('a delivery by session record is refused, and says the session is still being checked', async () => {
    configure(); watch()
    const s = session('v1'); startVerifying('v1')
    const { conn, written } = bridgeConn('v1'); transport.bridges.set('v1', conn)
    const r = await deliver('v1')
    expect(r).toMatchObject({ status: 'rejected' })
    expect((r as any).reason).toContain('still being checked against its policy')
    expect(written).toEqual([])
    expect(posted.join('\n')).toContain(s.tmuxName)
  })
  test('send_to_thread by name, and a second conversation\'s message, take the same route: the adapter\'s deliver', async () => {
    configure(); watch()
    session('v2', { tmuxName: 'ops_conv-1' }); startVerifying('v2')
    const { conn, written } = bridgeConn('v2'); transport.bridges.set('v2', conn)
    // sendOrQueue is what a send_to_thread to a named session, a Slack delivery to a per-conversation session and `hydra deliver --session` end in.
    transport.sendOrQueue('v2', note)
    await Bun.sleep(30)
    expect(written.filter(m => m.type === 'notification')).toEqual([])
  })
  test('a message queued earlier is not flushed to it while it is unverified', async () => {
    configure(); watch()
    session('v3'); startVerifying('v3')
    transport.messageQueues.set('v3', [note])
    const { conn, written } = bridgeConn('v3'); transport.bridges.set('v3', conn)
    transport.flushQueue('v3')
    expect(written.filter(m => m.type === 'notification')).toEqual([])
  })
  test('a typed paste into its pane is refused too (the gate the channel path shares)', () => {
    configure()
    const s = session('v4'); startVerifying('v4')
    expect(unverified(s)).toBe(true)
  })
})

describe('the marker', () => {
  test('a confined session without it is unverified; with it, not; operator and non-specialist sessions never are', () => {
    configure()
    expect(unverified(session('m1'))).toBe(true)
    expect(unverified(session('m2', { verified: true }))).toBe(false)
    expect(unverified(session('m3', { policy: operatorPolicy, sessionType: 'thread_owner' }))).toBe(false)
    expect(unverified(session('m4', { policy: undefined, sessionType: 'thread_owner' }))).toBe(false)
  })
  test('after a pass, delivery works', async () => {
    configure(); watch()
    session('m5', { verified: true })
    const { conn, written } = bridgeConn('m5'); transport.bridges.set('m5', conn)
    expect(await deliver('m5')).toMatchObject({ status: 'accepted' })
    expect(written.filter(m => m.type === 'notification')).toHaveLength(1)
    expect(posted).toEqual([])
  })
  test('is written to sessions.json, so it survives a restart', () => {
    configure()
    session('m6', { verified: true })
    registry.persist()
    expect(JSON.parse(readFileSync(join(STATE_DIR, 'sessions.json'), 'utf8')).find((s: any) => s.sessionId === 'm6').verified).toBe(true)
  })
})

describe('a record restored at boot without the marker', () => {
  test('is not delivered to, the thread is told what to do, and it is not killed', async () => {
    configure(); watch()
    const s = session('r1')    // no marker: a crash inside the wait, or a session started before hydra checked starts
    expect(registry.get('r1')).toBeDefined()
    const r = await deliver('r1')
    expect(r).toMatchObject({ status: 'rejected', retryable: false })
    expect((r as any).reason).toContain('has not been checked against its policy')
    expect((r as any).reason).toContain(`Run \`hydra kill ${s.tmuxName}\``)
    expect(posted.join('\n')).toContain('has not been checked against its policy')
    expect(registry.get('r1')).toBeDefined()   // nothing killed it
  })
  test('the drift check and the paste path agree it is unreachable', () => {
    configure()
    const s = session('r2')
    expect(unverified(s)).toBe(true)
    expect(sessionDrift(s).drift).toEqual([])   // not drift: the gate says it separately
  })
  test('an operator-access session restored without any marker is delivered to as ever (golden)', async () => {
    configure(); watch()
    session('r3', { policy: undefined, sessionType: 'thread_owner' })
    const { conn, written } = bridgeConn('r3'); transport.bridges.set('r3', conn)
    expect(await deliver('r3')).toMatchObject({ status: 'accepted' })
    expect(written.filter(m => m.type === 'notification')).toHaveLength(1)
  })
})

