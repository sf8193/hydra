// T0.7: pins the Codex runtime's boot sweep, its engine-event effects and the
// persisted-liveness classification, before they move out of codex-bootstrap.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { registry, threadRegistry, SessionRegistry, type SessionInfo } from '../sessions.js'
import { codexEngine } from '../engines/instances.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { getLastCodexMessage, isCodexTurnComplete, noteCodexTurnState } from '../engines/codex-observation.js'
import { notePendingReply, _pendingForTesting } from '../reply-guard.js'
import { queueCodexKeys, queuedCodexKeyCount } from '../codex-key-queue.js'
import { registerProtocol } from '../protocol-registry.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

// The boot sweep over every Codex record in the registry.
const sweep = (adapter: CodexEngineAdapter) => adapter.start([...registry.values()].filter(r => r.adapter === adapter))

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
const ids: string[] = []
let fake: FakeTmux

function put(over: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  const info = {
    topic: 't', threadId: `th-${over.sessionId}`, createdAt: 1, lastActive: 1, tmuxName: over.sessionId,
    listening: false, sessionType: 'thread_owner', engine: 'codex', ...over,
  } as SessionInfo
  registry.set(info.sessionId, info)
  ids.push(info.sessionId)
  return info
}

// Count calls to a registry's persist for the duration of fn.
async function counting<T>(reg: { persist(): void }, fn: () => Promise<T> | T): Promise<{ n: number; out: T }> {
  const orig = reg.persist
  let n = 0
  reg.persist = function () { n++; return orig.call(this) }
  try { const out = await fn(); return { n, out } } finally { reg.persist = orig }
}

const disconnects: string[] = []
registerProtocol('t07-probe', {
  getByThread: () => false,
  isParticipant: sid => sid.startsWith('t07-'),
  onReply: () => {}, onDisconnect: sid => { disconnects.push(sid) }, onReconnect: () => {},
})

beforeEach(() => { fake = withFakeTmux(); disconnects.length = 0 })
afterEach(() => {
  for (const id of ids.splice(0)) { const i = registry.get(id); if (i) threadRegistry.delete(i.threadId); registry.delete(id) }
  fake.restore()
})

describe('T0.7 boot sweep', () => {
  // Fake engine: socket live per home, resume records its start/end order.
  function engineFor(live: Set<string>, order: string[]) {
    return {
      isSocketLive: async (sock: string) => [...live].some(h => sock.includes(`hydra-${h}`)),
      connectAndResume: async (sid: string) => { order.push(`start:${sid}`); await tick(5); order.push(`end:${sid}`); return { model: 'm-new' } },
      connect: async () => { throw new Error('no fresh connect in this test') },
      disconnect: () => {},
      isConnected: () => false,
    }
  }

  async function isolated<T>(fn: () => Promise<T>): Promise<T> {
    // The sweep reads the shared registry: hide what other files left there.
    const others = [...registry.values()].filter(i => !ids.includes(i.sessionId))
    for (const i of others) registry.delete(i.sessionId)
    try { return await fn() } finally { for (const i of others) registry.set(i.sessionId, i) }
  }

  test('success refreshes history and the surface; failure stamps without dispatch; dead skipped; sequential; one final persist', async () => {
    const order: string[] = []
    const adapter = new CodexEngineAdapter(engineFor(new Set(['t07-a', 't07-b']), order) as any) as any
    const surfaced: string[] = []
    adapter.surface = (i: SessionInfo) => { surfaced.push(i.sessionId); return null }
    const mk = (sid: string, over: Partial<SessionInfo> = {}) => {
      const info = put({ sessionId: sid, codexThreadId: `T-${sid}`, codexHomeName: sid, adapter, sessionMetadata: { model: 'm-old' } as any, deadAt: 7, ...over })
      threadRegistry.set(info.threadId, { threadId: info.threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [{ sessionId: sid } as any] } as any)
      return info
    }
    const a = mk('t07-a'), b = mk('t07-b'), fail = mk('t07-fail')
    delete a.deadAt; delete b.deadAt; delete fail.deadAt
    const dead = mk('t07-dead', { deadAt: 3 })
    let threadPersists = 0
    const { n } = await counting(registry, async () => {
      const t = await counting(threadRegistry, () => isolated(() => sweep(adapter)))
      threadPersists = t.n
    })

    expect(order).toEqual(['start:t07-a', 'end:t07-a', 'start:t07-b', 'end:t07-b'])
    for (const ok of [a, b]) {
      expect(ok.deadAt).toBeUndefined()
      const entry = threadRegistry.get(ok.threadId)!.sessionHistory[0] as any
      expect(entry).toMatchObject({ codexThreadId: `T-${ok.sessionId}`, codexHomeName: ok.sessionId, model: 'm-new' })
    }
    expect(threadPersists).toBe(2)
    expect(surfaced).toEqual(['t07-a', 't07-b'])
    expect(typeof fail.deadAt).toBe('number')
    expect(threadRegistry.get(fail.threadId)!.sessionHistory[0]).toEqual({ sessionId: 't07-fail' } as any)
    expect(dead.deadAt).toBe(3)
    expect(n).toBe(1)
    await tick(10)
    expect(disconnects).toEqual([])
  })
})

// S0.7: start() owns the logging daemon.ts:79-83 did, and never rejects.
describe('Codex start: outcome logging', () => {
  async function stderrOf(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [], orig = process.stderr.write
    process.stderr.write = ((l: string) => { lines.push(String(l)); return true }) as any
    try { await fn() } finally { process.stderr.write = orig }
    return lines
  }

  test('a rejecting sweep resolves start and logs the failure', async () => {
    const adapter = new CodexEngineAdapter({} as any) as any
    const info = put({ sessionId: 't07-throw', adapter })
    adapter.reconnect = async () => { throw new Error('boom') }
    let settled = 'pending'
    const lines = await stderrOf(() => adapter.start([info]).then(() => { settled = 'resolved' }, () => { settled = 'rejected' }))
    expect(settled).toBe('resolved')
    expect(lines).toContain('daemon: codex reconnection failed: Error: boom\n')
  })

  test('a finished sweep logs completion, also with no records', async () => {
    const adapter = new CodexEngineAdapter({} as any)
    expect(await stderrOf(() => adapter.start([]))).toEqual(['daemon: codex reconnection sweep complete\n'])
  })
})

describe('T0.7 engine events', () => {
  test('message: activity, working, the stashed message, turn not complete', () => {
    const info = put({ sessionId: 't07-msg', turnState: 'idle' })
    noteCodexTurnState('t07-msg', true)
    notePendingReply('t07-msg', { chat_id: 'c-msg', message_id: 'm', user: 'u' }, Date.now() - 1000)
    codexEngine.emit('message', 't07-msg', 'hello there')
    expect(info.lastActive).toBeGreaterThan(1)
    expect(info.turnState).toBe('working')
    expect([..._pendingForTesting().values()].find(p => p.sessionId === 't07-msg')!.activitySeenAfterDelivery).toBe(true)
    expect(getLastCodexMessage('t07-msg', 0)).toBe('hello there')
    expect(isCodexTurnComplete('t07-msg')).toBe(false)
  })

  test('autoApproved: appended to the spawn log', () => {
    const log = join(STATE_DIR, 't07-spawn.log')
    writeFileSync(log, '')
    put({ sessionId: 't07-auto', spawnLogPath: log })
    codexEngine.emit('autoApproved', 't07-auto', 'item/commandExecution')
    expect(readFileSync(log, 'utf8')).toMatch(/^\[.+\] auto-approved: item\/commandExecution\n$/)
    rmSync(log)
  })

  test('turnCompleted: idle, complete, surface now, keys flushed, silence handled', async () => {
    let surfaced = 0
    const info = put({ sessionId: 't07-done', turnState: 'working', adapter: { surface: () => { surfaced++; return null } } as any })
    noteCodexTurnState('t07-done', false)
    const settled: Array<Error | undefined> = []
    queueCodexKeys('t07-done', { target: 't07-done:hydra-chat', mode: 'raw', keys: ['Enter'] }, e => { settled.push(e) })
    const gone = put({ sessionId: 't07-done-dead', deadAt: 1, adapter: { surface: () => null } as any })
    notePendingReply(gone.sessionId, { chat_id: 'c-done', message_id: 'm', user: 'u' })

    codexEngine.emit('turnCompleted', 't07-done')
    expect(info.turnState).toBe('idle')
    expect(isCodexTurnComplete('t07-done')).toBe(true)
    expect(surfaced).toBe(1)
    expect(queuedCodexKeyCount('t07-done')).toBe(0)
    for (let i = 0; i < 40 && !settled.length; i++) await tick(50)
    expect(settled).toEqual([undefined])
    expect(fake.calls()).toContain('send-keys -t t07-done:hydra-chat Enter')

    codexEngine.emit('turnCompleted', gone.sessionId)
    expect([..._pendingForTesting().values()].some(p => p.sessionId === gone.sessionId)).toBe(false)
  })

  // #378 rewrote the stall notice to carry the engine's reason and added the uncertain-delivery notice.
  test('turnStalled, turnDeliveryUnknown and usageWarning: a notice to the session thread', async () => {
    const sent: Array<[string, string]> = []
    const orig = gateway.send
    ;(gateway as any).send = async (c: string, text: string) => { sent.push([c, text]); return { id: 'x', channelId: c } }
    try {
      const info = put({ sessionId: 't07-warn' })
      codexEngine.emit('turnStalled', 't07-warn', 'no progress for 20 minutes')
      codexEngine.emit('turnStalled', 't07-warn', '')
      codexEngine.emit('turnDeliveryUnknown', 't07-warn', 'text', new Error('socket lost'))
      codexEngine.emit('usageWarning', 't07-warn', 87)
      await tick()
      expect(sent).toEqual([
        [info.threadId, '⚠️ Codex needs attention: no progress for 20 minutes'],
        [info.threadId, '⚠️ Codex needs attention: turn progress is unresolved.'],
        [info.threadId, '⚠️ Codex input delivery is uncertain; retaining it while checking thread history. Error: socket lost'],
        [info.threadId, '⚠️ Codex usage at **87%** of monthly limit.'],
      ])
    } finally { (gateway as any).send = orig }
  })

  test('contextUsage: stored with updatedAt, persisted, sampled to the log', async () => {
    const info = put({ sessionId: 't07-ctx' })
    const usage = { usedTokens: 10, contextWindow: 100, percent: 10 }
    const { n } = await counting(registry, () => { codexEngine.emit('contextUsage', 't07-ctx', usage) })
    expect(n).toBe(1)
    expect(info.contextUsage).toMatchObject(usage)
    expect(typeof info.contextUsage!.updatedAt).toBe('number')
    const lines = readFileSync(join(STATE_DIR, 'context-usage-samples.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ sessionId: 't07-ctx', tmuxName: 't07-ctx', ...usage })
  })

  test('disconnected → reconnect: revived and its surface ensured', async () => {
    let reconnects = 0, surfaced = 0
    const info = put({ sessionId: 't07-dc-ok', codexThreadId: 'T', deadAt: 1,
      adapter: { reconnect: async () => { reconnects++; return true }, surface: () => { surfaced++; return null } } as any })
    codexEngine.emit('disconnected', 't07-dc-ok')
    await tick(400)
    expect(reconnects).toBe(1)
    expect(info.deadAt).toBeUndefined()
    expect(surfaced).toBe(1)
    expect(disconnects).toEqual([])
  })

  test('disconnected, reconnect exhausted: stamps, persists, clears keys, dispatches', async () => {
    let reconnects = 0
    const info = put({ sessionId: 't07-dc-fail', codexThreadId: 'T',
      adapter: { reconnect: async () => { reconnects++; return false }, surface: () => null } as any })
    const settled: Array<Error | undefined> = []
    queueCodexKeys('t07-dc-fail', { target: 'x', mode: 'raw', keys: ['Enter'] }, e => { settled.push(e) })
    const { n } = await counting(registry, async () => { codexEngine.emit('disconnected', 't07-dc-fail'); await tick(2800) })
    expect(reconnects).toBe(3)
    expect(typeof info.deadAt).toBe('number')
    expect(n).toBe(1)
    expect(queuedCodexKeyCount('t07-dc-fail')).toBe(0)
    expect(settled.map(e => e?.message)).toEqual(['key action cancelled because the session disconnected'])
    expect(disconnects).toEqual(['t07-dc-fail'])
  }, 8000)
})

describe('T0.7 persisted liveness at load', () => {
  test('Codex with a thread id defers to the provider; everything else follows tmux', () => {
    const file = join(STATE_DIR, 'sessions.json')
    const saved = existsSync(file) ? readFileSync(file, 'utf8') : null
    const rec = (sessionId: string, over: Record<string, unknown>) => ({
      sessionId, topic: 't', threadId: `th-${sessionId}`, createdAt: 1, lastActive: 1, tmuxName: sessionId,
      listening: false, sessionType: 'thread_owner', deadAt: 5, ...over,
    })
    const records = [
      rec('k-codex-thread-tmux', { engine: 'codex', codexThreadId: 'T' }),
      rec('k-codex-thread-notmux', { engine: 'codex', codexThreadId: 'T' }),
      rec('k-codex-nothread-tmux', { engine: 'codex' }),
      rec('k-codex-nothread-notmux', { engine: 'codex' }),
      rec('k-claude-tmux', { engine: 'claude', claudeSessionId: 'c' }),
      rec('k-claude-notmux-codexid', { engine: 'claude', codexThreadId: 'T' }),
    ]
    for (const r of ['k-codex-thread-tmux', 'k-codex-nothread-tmux', 'k-claude-tmux']) fake.alive(r)
    try {
      writeFileSync(file, JSON.stringify(records))
      const reg = new SessionRegistry()
      const deadAt = Object.fromEntries(records.map(r => [r.sessionId, reg.get(r.sessionId)?.deadAt ?? null]))
      expect(deadAt).toEqual({
        'k-codex-thread-tmux': null,
        'k-codex-thread-notmux': null,
        'k-codex-nothread-tmux': null,
        'k-codex-nothread-notmux': 5,
        'k-claude-tmux': null,
        'k-claude-notmux-codexid': 5,
      })
    } finally {
      if (saved === null) rmSync(file, { force: true }); else writeFileSync(file, saved)
    }
  })
})
