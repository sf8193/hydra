// contract PR-0 T0.2: pins what the pr-watch notice and the three protocol
// notices put on the wire today, before S0.2 turns them into intents
// (lowPriority / handoff) on the Notification. Claude: the exact JSON written
// to the bridge and the exact persisted queue entry. No record: the same, via
// sendOrQueue's fallback. Codex: protocol notices queue a next turn; pr-watch
// buffers for piggyback while alive and delivers at once when deadAt.
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { STATE_DIR } from '../config.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { fakeCodexAdapter } from './test-harness.js'
import { deliverPrUpdate } from '../pr-watch.js'
import { __test } from '../protocol-runner.js'

const { notifyNextActor, notifyActorOfTimeout, notifyParticipant } = __test!
const NOW = new Date('2026-09-27T12:00:00.000Z')
const TS = NOW.toISOString()
const THREAD = 'di-thread'
let seq = 0
const ids = new Set<string>()
const realStderr = process.stderr.write

const sid = () => { const id = `di-${++seq}`; ids.add(id); return id }
const run = (actorSid: string) => ({
  threadId: THREAD, phase: 'p', currentRound: 1, rounds: 2,
  participants: new Map([['a', actorSid]]),
  protocol: {
    display: 'D', phases: { p: { actor: 'a' } }, phaseInteraction: () => undefined,
    windowMs: () => undefined, notifications: { onTurn: () => 'TURN' },
  },
}) as any

const put = (id: string, extra: Record<string, unknown>) =>
  registry.set(id, { sessionId: id, threadId: THREAD, tmuxName: id, sessionType: 'thread_owner', ...extra } as any)
const claude = (id: string) => put(id, { engine: 'claude', adapter: new ClaudeEngine(transport) })
const codex = (id: string, calls: string[], extra: Record<string, unknown> = {}) => put(id, {
  engine: 'codex', ...extra,
  adapter: fakeCodexAdapter({ calls, isConnected: () => !extra.deadAt }), // dead ⇔ its app-server socket is gone
})
const bridge = (id: string) => {
  const written: string[] = []
  transport.set(id, { sessionId: id, buf: '', socket: { write: (d: string) => { written.push(d); return true }, end() {}, destroyed: false } as any })
  return written
}
const persisted = (id: string) => JSON.stringify(JSON.parse(readFileSync(join(STATE_DIR, 'message-queue.json'), 'utf8'))[id])
const tick = () => new Promise(r => setTimeout(r, 0))

// The exact envelopes today's senders build, key order included.
const prEnvelope = (content: string) => JSON.stringify({
  type: 'notification', content,
  meta: { chat_id: THREAD, message_id: '', user: 'pr-watch', user_id: 'system', ts: TS },
})
const systemEnvelope = (content: string) => JSON.stringify({
  type: 'notification', content,
  meta: { chat_id: THREAD, message_id: '', user: 'system', user_id: 'system', ts: TS },
})

// The four senders, each with the content it produces for an actor named `id`.
const senders: Array<[string, (id: string) => void, (id: string) => string, (id: string) => string]> = [
  ['pr-watch', id => deliverPrUpdate(id, THREAD, 'CI failed on PR #7'), () => 'CI failed on PR #7', prEnvelope],
  ['notifyNextActor', id => notifyNextActor(run(id), 'prev'), () => 'TURN', systemEnvelope],
  ['notifyActorOfTimeout', id => notifyActorOfTimeout(run(id), id, 'p'),
    id => `[system] ⏰ ${registry.get(id) ? `**${id}**, phase` : 'Phase'} "p" timed out. The protocol is advancing.`, systemEnvelope],
  ['notifyParticipant', id => notifyParticipant(run(id), id, 'hello participant'), () => 'hello participant', systemEnvelope],
]

beforeEach(() => {
  setSystemTime(NOW)
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  setSystemTime()
  process.stderr.write = realStderr
  for (const id of ids) {
    registry.delete(id)
    transport.delete(id)
    transport.messageQueues.delete(id)
  }
  ids.clear()
  transport.persistQueues()
})

describe('T0.2 Claude wire bytes', () => {
  for (const [name, send, content, envelope] of senders) {
    test(`${name}: bridge present → exactly today's JSON line`, () => {
      const id = sid(); claude(id)
      const written = bridge(id)
      send(id)
      expect(written).toEqual([envelope(content(id)) + '\n'])
    })

    test(`${name}: bridge absent → exactly today's queue entry, in memory and on disk`, () => {
      const id = sid(); claude(id)
      send(id)
      const q = transport.messageQueues.get(id)!
      expect(q.map(m => JSON.stringify(m))).toEqual([envelope(content(id))])
      expect(persisted(id)).toBe(`[${envelope(content(id))}]`)
    })
  }
})

// Peer #2: sendOrQueue's no-record fallback writes the caller's object as-is.
describe('T0.2 no record (sendOrQueue fallback)', () => {
  for (const [name, send, content, envelope] of senders) {
    test(`${name}: queued with exactly today's bytes`, () => {
      const id = sid()
      send(id)
      expect(transport.messageQueues.get(id)!.map(m => JSON.stringify(m))).toEqual([envelope(content(id))])
      expect(persisted(id)).toBe(`[${envelope(content(id))}]`)
    })

    test(`${name}: bridged → exactly today's JSON line`, () => {
      const id = sid()
      const written = bridge(id)
      send(id)
      expect(written).toEqual([envelope(content(id)) + '\n'])
    })
  }
})

describe('T0.2 Codex', () => {
  for (const [name, send, content] of senders.slice(1)) {
    test(`${name}: queued for the next turn, never steered`, () => {
      const calls: string[] = []
      const id = sid(); codex(id, calls)
      send(id)
      expect(calls).toEqual(['queue:' + content(id)])
    })
  }

  test('pr-watch, alive: buffered, then carried by the next allowPiggyback delivery and consumed', async () => {
    const calls: string[] = []
    const id = sid(); codex(id, calls)
    deliverPrUpdate(id, THREAD, 'CI failed on PR #7')
    expect(calls).toEqual([])
    transport.sendOrQueue(id, { type: 'notification', content: 'real', allowPiggyback: true })
    expect(calls).toEqual(['steer:CI failed on PR #7\n\n---\n\nreal'])
    await tick()
    transport.sendOrQueue(id, { type: 'notification', content: 'next', allowPiggyback: true })
    expect(calls[1]).toBe('steer:next')
  })

  test('dead: pr-watch and user input are rejected — nothing steered, queued or buffered', async () => {
    const calls: string[] = []
    const id = sid(); codex(id, calls, { deadAt: 1 })
    deliverPrUpdate(id, THREAD, 'CI failed on PR #7')
    transport.sendOrQueue(id, { type: 'notification', content: 'real', allowPiggyback: true })
    await tick()
    expect(calls).toEqual([])
  })
})
