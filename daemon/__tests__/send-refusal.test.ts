// A send_to_thread that the delivery gate refuses is not "delivered": the sender is told the cause and the one remedy, whoever the sender
// is and whichever refusal it was (a drifted policy, a start not yet verified). The target's thread hears it once, under the engine
// the session really runs on.
import { afterEach, describe, expect, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { transport } from '../bridge-transport.js'
import { executeTool } from '../bridge-dispatch.js'
import { registry } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { endVerifying, policyIdFor, startVerifying, type LaunchPolicy } from '../restricted.js'
import { threadNotices } from '../notice-limit.js'
import type { HydraConfig, Specialist } from '../../config/types.js'
import '../engines/codex-runtime.js'

process.stderr.write = (() => true) as any

const spec = (over: Partial<Specialist> = {}): Specialist => ({ id: 'ops', workdir: '/srv/ops', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...over }) as Specialist
const configure = (over: Partial<Specialist> = {}): void => _setHydraConfigForTesting({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', addresses: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: { ops: spec(over) },
} as HydraConfig)
const operatorPolicy: LaunchPolicy = { specialist: 'ops', restricted: false, id: 'operator' }
// The session was born as the operator's; hydra.toml now restricts the specialist.
const drift = () => configure({ restricted: true, tools: ['Read'], mcpServerNames: [] })
const REMEDY = (name: string) => `hydra kill ${name}`

const ids: string[] = []
function session(id: string, over: Record<string, unknown> = {}) {
  ids.push(id)
  registry.set(id, {
    sessionId: id, tmuxName: `${id}-tmux`, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', policy: operatorPolicy, sessionType: 'thread_owner', adapter: Object.assign(Object.create(engines.claude), { isAlive: () => true }), ...over,
  } as any)
  return registry.get(id)!
}
const bridgeConn = (id: string) => { const written: any[] = []; return { conn: { sessionId: id, socket: { destroyed: false, write: (s: string) => { written.push(JSON.parse(s)); return true } } } as any, written } }

let posted: [string, string][] = []
const realSend = gateway.send
const watch = () => { posted = []; threadNotices.clear(); (gateway as any).send = async (c: string, t: string) => { posted.push([c, t]); return { id: 'm', channelId: c } } }
afterEach(() => {
  ;(gateway as any).send = realSend
  _setHydraConfigForTesting(undefined)
  for (const id of ids.splice(0)) { endVerifying(id); registry.delete(id); transport.bridges.delete(id); transport.messageQueues.delete(id) }
})
const textOf = (r: any): string => r.content[0].text
const toThread = (thread: string) => posted.filter(([c]) => c === thread).map(([, t]) => t)

describe('the sender is told when the gate refused the message', () => {
  const setup = () => {
    configure(); watch()
    const target = session('t1')
    const { conn, written } = bridgeConn('t1'); transport.bridges.set('t1', conn)
    drift()
    return { target, written }
  }
  const senders: [string, () => string][] = [
    ['a spawned session', () => session('s1', { tmuxName: 'spawned', threadId: 'th-s1', policy: undefined }).sessionId],
    ['a specialist session', () => session('s2', { tmuxName: 'ops2', threadId: 'th-s2', policy: { specialist: 'ops', restricted: false, id: 'operator' } }).sessionId],
    ['main', () => 'main'],
  ]
  for (const [who, make] of senders) {
    for (const type of ['progress', 'result'])
      test(`${who} (${type}): an error naming the cause and the remedy, never "delivered" or "sent"`, async () => {
        const { target, written } = setup()
        const from = make()
        const r = await executeTool('send_to_thread', { target: target.tmuxName, type, text: 'hello' }, from)
        expect(r.isError).toBe(true)
        const text = textOf(r)
        expect(text).toContain('nothing was delivered')
        expect(text).toContain(REMEDY(target.tmuxName))
        expect(text).not.toMatch(/^(delivered|sent)/)
        expect(written.filter(m => m.type === 'notification')).toEqual([])
      })
  }

  test('a start that has not been verified is a refusal too: the sender hears it, with its own cause', async () => {
    drift(); watch()
    const target = session('t2', { sessionType: 'thread_owner', policy: { specialist: 'ops', restricted: true, workdir: '/srv/ops', tools: ['Read'], servers: [], id: policyIdFor('/srv/ops', ['Read'], []) } }); startVerifying('t2')
    const r = await executeTool('send_to_thread', { target: target.tmuxName, type: 'result', text: 'hello' }, session('s3', { tmuxName: 'spawned3', policy: undefined }).sessionId)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('still being checked against its policy')
  })

  test('the control: a session the gate does not refuse is still told "sent"', async () => {
    configure(); watch()
    const target = session('t3')
    const { conn, written } = bridgeConn('t3'); transport.bridges.set('t3', conn)
    const r = await executeTool('send_to_thread', { target: target.tmuxName, type: 'result', text: 'hello' }, session('s4', { tmuxName: 'spawned4', policy: undefined }).sessionId)
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toMatch(/^(delivered|sent)/)
    expect(written.filter(m => m.type === 'notification')).toHaveLength(1)
  })
})

describe('one refusal, one notice, under the engine the session runs on', () => {
  test('a refused send_to_thread puts the refusal once in the target\'s thread, and no line names Codex for a Claude session', async () => {
    configure(); watch()
    const target = session('t4')
    const { conn } = bridgeConn('t4'); transport.bridges.set('t4', conn)
    drift()
    await executeTool('send_to_thread', { target: target.tmuxName, type: 'result', text: 'hello' }, session('s5', { tmuxName: 'spawned5', policy: undefined }).sessionId)
    await Bun.sleep(30)
    const notices = toThread('th-t4').filter(t => t.startsWith('⚠️'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(REMEDY(target.tmuxName))
    expect(toThread('th-t4').join('\n')).not.toContain('Codex')
  })

  test('a rejection that no gate announced is said once, labelled with the session\'s own engine', async () => {
    configure(); watch()
    const claude = session('t5'); const codex = session('t6', { engine: 'codex' })
    const { emit } = await import('../../infra/event-bus.js')
    emit('delivery:failed', { sessionId: claude.sessionId, status: 'rejected', reason: 'busy', messageId: 'm-1' })
    emit('delivery:failed', { sessionId: codex.sessionId, status: 'rejected', reason: 'busy', messageId: 'm-2' })
    await Bun.sleep(30)
    expect(toThread('th-t5')).toEqual(['⚠️ Claude delivery was rejected (message m-1): busy'])
    expect(toThread('th-t6')).toEqual(['⚠️ Codex delivery was rejected (message m-2): busy'])
  })
})

// ── review round: nothing is shown or recorded for a refused message; the other outcomes are worded exactly ──
import { tmpdir } from 'os'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { deliveryWait } from '../bridge-dispatch.js'
import { registerProtocol } from '../protocol-registry.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

const accepts = { status: 'accepted', via: 'bridge-socket' }
const claudeWith = (deliver: (...a: any[]) => Promise<unknown>) => Object.assign(Object.create(engines.claude), { isAlive: () => true, deliver })
const results: [string, string, string][] = []
registerProtocol('send-refusal-test', {
  getByThread: () => false, isParticipant: id => id === 'pp-sender', onReply: () => {}, onDisconnect: () => {}, onReconnect: () => {},
  onChildResult: (child, target, text) => { results.push([child, target, text]); return true },
})
const file = join(tmpdir(), 'send-refusal-attachment.txt'); writeFileSync(file, 'x')
const sender = (id: string, over: Record<string, unknown> = {}) => session(id, { tmuxName: `${id}-name`, policy: undefined, ...over }).sessionId
const send = (target: string, from: string, extra: Record<string, unknown> = {}) => executeTool('send_to_thread', { target, type: 'result', text: 'hello', ...extra }, from)

describe('a refused message is neither shown nor recorded', () => {
  for (const [label, extra, from] of [
    ['a plain send', {}, () => sender('r1')],
    ['a send with a file (posted in full)', { files: [file] }, () => sender('r2')],
    ['a send from a protocol participant (posted in full)', {}, () => sender('pp-sender')],
  ] as [string, Record<string, unknown>, () => string][]) {
    test(`${label}: no text in the target's thread, no note in the sender's, no protocol result`, async () => {
      configure(); watch(); results.length = 0
      const target = session('rt-' + label.length)
      transport.bridges.set(target.sessionId, bridgeConn(target.sessionId).conn)
      drift()
      const r = await send(target.tmuxName, from(), extra)
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('nothing was posted or sent')
      expect(toThread(target.threadId).filter(t => !t.startsWith('⚠️'))).toEqual([])
      expect(posted.filter(([c]) => c !== target.threadId)).toEqual([])
      expect(results).toEqual([])
    })
  }
})

describe('a message the gate let through but the session did not take', () => {
  const adapterOf = (deliver: (...a: any[]) => Promise<unknown>) => claudeWith(deliver)
  for (const [label, extra, from] of [
    ['plain', {}, () => sender('u1')],
    ['with a file', { files: [file] }, () => sender('u2')],
    ['from a protocol participant', {}, () => sender('pp-sender')],
  ] as [string, Record<string, unknown>, () => string][]) {
    test(`rejected (${label}): says it is posted but not taken, the cause, and a retry hint when retryable; no protocol result`, async () => {
      configure(); watch(); results.length = 0
      const target = session('ut-' + label.length, { adapter: adapterOf(async () => ({ status: 'rejected', retryable: true, reason: 'the session is busy' })) })
      const r = await send(target.tmuxName, from(), extra)
      expect(r.isError).toBe(true)
      const t = textOf(r)
      // The quiet route (a plain send) leaves one line in the thread; a file or a protocol participant posts the text in full.
      expect(t).toContain(label === 'plain'
        ? `A one-line note of it is in ${target.tmuxName}'s thread, but the session did not take the message: the session is busy`
        : `The message is posted in ${target.tmuxName}'s thread, but the session did not take it: the session is busy`)
      expect(t).toContain('Retrying may succeed')
      expect(t).not.toContain('check its thread')
      expect(results).toEqual([])
    })
  }
  test('rejected and not retryable: no retry hint', async () => {
    configure(); watch()
    const target = session('u3', { adapter: adapterOf(async () => ({ status: 'rejected', retryable: false, reason: 'no' })) })
    expect(textOf(await send(target.tmuxName, sender('u3s')))).not.toContain('Retrying')
  })
  test('unknown (the adapter throws): it may have landed, so the sender is told not to resend blindly', async () => {
    configure(); watch(); results.length = 0
    const target = session('u4', { adapter: adapterOf(async () => { throw new Error('socket lost') }) })
    const r = await send(target.tmuxName, sender('u4s'))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('may have landed')
    expect(textOf(r)).toContain('socket lost')
    expect(textOf(r)).not.toContain('check its thread')
    expect(results).toEqual([])
  })
  test('a delivery that never answers does not hold the sender: a note says it may land, and the result is recorded', async () => {
    configure(); watch(); results.length = 0
    const was = deliveryWait.ms; deliveryWait.ms = 20
    try {
      const target = session('u5', { adapter: adapterOf(() => new Promise(() => {})) })
      const t0 = Date.now()
      const r = await send(target.tmuxName, sender('u5s'))
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('still being delivered and may land: do not send it again')
    } finally { deliveryWait.ms = was }
  })
  test('a slow delivery accepted late records the protocol result then, not before', async () => {
    configure(); watch(); results.length = 0
    const was = deliveryWait.ms; deliveryWait.ms = 10
    try {
      const target = session('u8', { adapter: adapterOf(() => new Promise(res => setTimeout(() => res(accepts), 60))) })
      const r = await send(target.tmuxName, sender('pp-sender'))
      expect(textOf(r)).toContain('still being delivered')
      expect(results).toEqual([])
      await Bun.sleep(120)
      expect(results).toEqual([['pp-sender', target.sessionId, 'hello']])
    } finally { deliveryWait.ms = was }
  })
  test('a slow delivery rejected late never records it: the step does not count as done', async () => {
    configure(); watch(); results.length = 0
    const was = deliveryWait.ms; deliveryWait.ms = 10
    try {
      const target = session('u9', { adapter: adapterOf(() => new Promise(res => setTimeout(() => res({ status: 'rejected', retryable: false, reason: 'busy' }), 60))) })
      const r = await send(target.tmuxName, sender('pp-sender'))
      expect(textOf(r)).toContain('still being delivered')
      await Bun.sleep(120)
      expect(results).toEqual([])
    } finally { deliveryWait.ms = was }
  })
  test('a slow private delivery is held to the same: recorded only if accepted late', async () => {
    configure(); watch(); results.length = 0
    const was = deliveryWait.ms; deliveryWait.ms = 10
    try {
      for (const [late, expected] of [[accepts, 1], [{ status: 'rejected', retryable: false, reason: 'busy' }, 0]] as const) {
        results.length = 0
        const parent = session('pl-parent' + expected, { tmuxName: 'plparent' + expected, adapter: adapterOf(() => new Promise(res => setTimeout(() => res(late), 60))) })
        const child = session('pl-child' + expected, { tmuxName: 'plchild' + expected, policy: undefined, parentId: parent.sessionId, initiator: parent.tmuxName })
        const r = await executeTool('send_to_thread', { target: parent.tmuxName, type: 'result', text: 'r', visibility: 'private' }, child.sessionId)
        expect(textOf(r)).toContain('still being delivered')
        expect(results).toEqual([])
        await Bun.sleep(120)
        expect(results).toHaveLength(expected)
      }
    } finally { deliveryWait.ms = was }
  })
  test('a Codex target the gate refuses is refused before anything is posted', async () => {
    configure(); watch()
    const adapter = Object.assign(new CodexEngineAdapter({ isConnected: () => true } as any), { isAlive: () => true })
    const target = session('u6', { engine: 'codex', adapter })
    drift()
    const r = await send(target.tmuxName, sender('u6s'))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(REMEDY(target.tmuxName))
    expect(toThread(target.threadId).filter(t => !t.startsWith('⚠️'))).toEqual([])
  })
  test('the control: an accepted message is recorded once, as the protocol participant\'s result', async () => {
    configure(); watch(); results.length = 0
    const target = session('u7', { adapter: adapterOf(async () => accepts) })
    expect((await send(target.tmuxName, sender('pp-sender'))).isError).toBeFalsy()
    expect(results).toEqual([['pp-sender', target.sessionId, 'hello']])
  })
})

describe('a private send is held to the same account', () => {
  const pair = (deliver?: (...a: any[]) => Promise<unknown>) => {
    const parent = session('pv-parent', { tmuxName: 'pvparent', ...(deliver ? { adapter: claudeWith(deliver) } : {}) })
    const child = session('pv-child', { tmuxName: 'pvchild', policy: undefined, parentId: parent.sessionId, initiator: parent.tmuxName })
    return { parent, child }
  }
  const priv = (child: string, parent: string, type = 'result') => executeTool('send_to_thread', { target: parent, type, text: 'secret result', visibility: 'private' }, child)
  test('refused by the gate: an error with the cause and remedy, nothing recorded', async () => {
    configure(); watch(); results.length = 0
    const { parent, child } = pair()
    drift()
    const r = await priv(child.sessionId, parent.tmuxName)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(REMEDY(parent.tmuxName))
    expect(results).toEqual([])
  })
  test('rejected by the session: an error that says nothing was posted; unknown: may have landed', async () => {
    configure(); watch()
    const a = pair(async () => ({ status: 'rejected', retryable: false, reason: 'busy' }))
    const r = await priv(a.child.sessionId, a.parent.tmuxName, 'progress')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('The session did not take the message: busy')
    ids.length = 0
    registry.delete('pv-parent'); registry.delete('pv-child')
    const b = pair(async () => { throw new Error('socket lost') })
    const u = await priv(b.child.sessionId, b.parent.tmuxName, 'progress')
    expect(textOf(u)).toContain('may have landed')
  })
  test('the control: an accepted private result is delivered and recorded', async () => {
    configure(); watch(); results.length = 0
    const { parent, child } = pair(async () => accepts)
    const r = await priv(child.sessionId, parent.tmuxName)
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('privately delivered')
  })
})

describe('the notice for a rejection the gate did not announce', () => {
  test('is said for every message, not once a minute per cause', async () => {
    configure(); watch()
    const s = session('n1')
    const { emit } = await import('../../infra/event-bus.js')
    emit('delivery:failed', { sessionId: s.sessionId, status: 'rejected', reason: 'busy', messageId: 'm-1' })
    emit('delivery:failed', { sessionId: s.sessionId, status: 'rejected', reason: 'busy', messageId: 'm-2' })
    await Bun.sleep(30)
    expect(toThread(s.threadId)).toEqual(['⚠️ Claude delivery was rejected (message m-1): busy', '⚠️ Claude delivery was rejected (message m-2): busy'])
  })
})

describe('any other route to a refused session says it once too', () => {
  test('a message sent by sendOrQueue (a chat message, a notification): the gate\'s notice and the delivery:failed one are one notice, with no Codex label', async () => {
    configure(); watch()
    const target = session('o1')
    transport.bridges.set('o1', bridgeConn('o1').conn)
    drift()
    transport.sendOrQueue('o1', { type: 'notification', content: 'from a person', meta: { message_id: 'm-9' } })
    await Bun.sleep(30)
    const notices = toThread(target.threadId)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(REMEDY(target.tmuxName))
    expect(notices[0]).not.toContain('Codex')
  })
})
