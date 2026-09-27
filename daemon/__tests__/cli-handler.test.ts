import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SCRUBBED_SPAWN_VARS } from '../../shared/spawn-env.js'
import { _setDeps, _resetDeps } from '../raindrop.js'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { registry } from '../sessions.js'
import { checkIdempotency } from '../idempotency.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { fakeAdapter } from './test-harness.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import { emit } from '../event-bus.js'
import { getIdempotencyEntry } from '../idempotency.js'

// Suppress stderr from daemon modules
process.stderr.write = (() => true) as any

function makeReq(overrides: Partial<CLIRequest> = {}): CLIRequest {
  return {
    type: 'cli',
    command: 'health',
    id: `test-${Date.now()}`,
    params: {},
    ...overrides,
  }
}

describe('cli-handler', () => {
  test('health returns session counts', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'health' }))
    expect(res.ok).toBe(true)
    expect(res.type).toBe('cli-response')
    const data = res.data as any
    expect(data.sessions).toBeDefined()
    expect(typeof data.sessions.total).toBe('number')
    expect(typeof data.sessions.connected).toBe('number')
    expect(typeof data.sessions.disconnected).toBe('number')
  })

  test('list returns array', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'list' }))
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
  })

  test('status with missing name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'status', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('name is required')
  })

  test('status with unknown name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'status', params: { name: 'nonexistent-session-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  test('kill with missing name returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'kill', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('name is required')
  })

  test('unknown command returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'foobar' }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown command')
  })

  test('spawn with missing prompt returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'spawn', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('prompt is required')
  })

  test('spawn with missing idempotency-key returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'spawn', params: { prompt: 'test', initiator: 'test' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('idempotency-key is required')
  })

  test('spawn with missing initiator returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'spawn', params: { prompt: 'test', idempotencyKey: 'k' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('initiator is required')
  })

  test('spawn with idempotency key blocks duplicate', async () => {
    const key = `cli-test-idem-${Date.now()}`
    const { registerIdempotency } = await import('../idempotency.js')
    registerIdempotency(key, 'existing-session')

    const res = await handleCLIRequest(makeReq({
      command: 'spawn',
      params: { prompt: 'test', idempotencyKey: key, initiator: 'test' },
    }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('idempotency')
    expect(res.error).toContain(key)
  })

  test('response always includes type and id', async () => {
    const id = `test-id-${Date.now()}`
    const res = await handleCLIRequest(makeReq({ id, command: 'health' }))
    expect(res.type).toBe('cli-response')
    expect(res.id).toBe(id)
  })

  test('clear-key with missing key returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: {} }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('key is required')
  })

  test('clear-key removes registered key', async () => {
    const key = `cli-test-clear-${Date.now()}`
    const { registerIdempotency } = await import('../idempotency.js')
    registerIdempotency(key, 'some-session')

    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: { key } }))
    expect(res.ok).toBe(true)
    const data = res.data as any
    expect(data.cleared).toBe(key)
  })

  test('clear-key with unknown key returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'clear-key', params: { key: 'no-such-key-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  test('factory list returns builds array', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'list' } }))
    expect(res.ok).toBe(true)
    const data = res.data as any
    expect(Array.isArray(data.builds)).toBe(true)
  })

  test('factory status without ticket returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'status' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ticket is required')
  })

  test('factory status with unknown ticket returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'status', ticket: 'fb-unknown-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  test('factory accept with unknown ticket returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'accept', ticket: 'fb-unknown-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unknown ticket')
  })

  test('factory abandon with unknown ticket returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'abandon', ticket: 'fb-unknown-xyz' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unknown ticket')
  })

  test('factory with unknown subcommand returns error', async () => {
    const res = await handleCLIRequest(makeReq({ command: 'factory', params: { sub: 'frobnicate' } }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown factory subcommand')
  })
})

describe('cli-handler: raindrop in health', () => {
  const VARS = SCRUBBED_SPAWN_VARS
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v] }
    _setDeps({ env: () => process.env })
  })
  afterEach(() => {
    _resetDeps()
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]!
    }
  })

  test('omits the field entirely when raindrop is off', async () => {
    delete process.env.RAINDROP_MODE
    const res = await handleCLIRequest(makeReq({ command: 'health' }))
    expect('raindrop' in (res.data as any)).toBe(false)
  })

  test('reports the mode and the full state-dir path, which chat never gets', async () => {
    process.env.RAINDROP_MODE = 'dryrun'
    const res = await handleCLIRequest(makeReq({ command: 'health' }))
    const line = (res.data as any).raindrop as string
    expect(line.startsWith('dryrun → ')).toBe(true)
    expect(line).toContain('raindrop-dryrun.jsonl')
  })

  test('surfaces a misconfiguration rather than staying silent', async () => {
    process.env.RAINDROP_MODE = 'dry-run'
    const res = await handleCLIRequest(makeReq({ command: 'health' }))
    expect((res.data as any).raindrop).toContain("unrecognized RAINDROP_MODE='dry-run'")
  })
})

// Z2: CLI deliver awaits adapter.deliver for both engines. Labels are today's:
// Claude delivered/socket_write, queued/persisted, write failure exit 6; Codex
// delivered/adapter. Codex rejected → error, unknown → exit 6, neither keeps a key.
describe('cli-handler: deliver (Z2)', () => {
  let fake: FakeTmux
  const ids: string[] = []
  beforeEach(() => { fake = withFakeTmux() })
  afterEach(() => {
    for (const id of ids.splice(0)) { registry.delete(id); transport.bridges.delete(id) }
    fake.restore()
  })

  let n = 0
  function seed(engine: 'claude' | 'codex', extra: Record<string, unknown> = {}) {
    const sessionId = `z2-${engine}-${++n}`
    ids.push(sessionId)
    fake.alive(`${sessionId}-tmux`)
    const info = { sessionId, tmuxName: `${sessionId}-tmux`, threadId: `${sessionId}-thread`, engine, createdAt: Date.now(), adapter: engines[engine], ...extra } as any
    registry.set(sessionId, info)
    return info
  }
  function codex(deliver: (...args: unknown[]) => Promise<unknown>) {
    return seed('codex', { adapter: fakeAdapter({ provider: 'codex', channel: 'engine', isConnected: () => true, deliver }) })
  }
  function bridge(sessionId: string, write: () => boolean, destroyed = false) {
    const written: string[] = []
    transport.set(sessionId, { sessionId, socket: { destroyed, write: (l: string) => { written.push(l); return write() } } } as any)
    return written
  }
  const deliver = (session: string, extra: Record<string, unknown> = {}) =>
    handleCLIRequest(makeReq({ command: 'deliver', params: { session, message: 'whisper', ...extra } }))
  const key = () => `z2-key-${Date.now()}-${++n}`
  const common = (info: any) => ({ sessionId: info.sessionId, sessionName: info.tmuxName, threadId: info.threadId })

  test('codex accepted → delivered/adapter, key completed', async () => {
    const seen: unknown[][] = []
    const info = codex(async (...args) => { seen.push(args); return { status: 'accepted', via: 'steer' } })
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res).toMatchObject({ ok: true, data: { status: 'delivered', proof: 'adapter', ...common(info) } })
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen[0])).toContain('"source":"cli-deliver"')
    expect(checkIdempotency(k)).toMatchObject({ blocked: true, entry: { status: 'completed' } })
    expect(getIdempotencyEntry(k)!.sessionId).toBe(info.sessionId)
  })

  // The in-flight reservation carries no sessionId, so the death handler's
  // getBySessionId can't mistake it for a spawn key and complete it.
  test('session dies mid-delivery → pending key untouched by the death handler, then cleared', async () => {
    let settle!: (r: unknown) => void
    const info = codex(() => new Promise(r => { settle = r }))
    const k = key()
    const pending = deliver(info.sessionId, { idempotencyKey: k })
    emit('session:death', { sessionId: info.sessionId, threadId: info.threadId, wasOwner: true, tmuxName: info.tmuxName })
    expect(getIdempotencyEntry(k)).toMatchObject({ status: 'pending' })
    settle({ status: 'unknown', reason: 'session died' })
    expect(await pending).toMatchObject({ ok: false, exitCode: 6 })
    expect(getIdempotencyEntry(k)).toBeUndefined()
  })

  test('codex rejected → error with the reason, no key', async () => {
    const info = codex(async () => ({ status: 'rejected', retryable: false, reason: 'session is retiring' }))
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('session is retiring')
    expect(res.exitCode).toBeUndefined()
    expect(checkIdempotency(k)).toEqual({ blocked: false })
  })

  test('codex unknown → exit 6, no key', async () => {
    const info = codex(async () => ({ status: 'unknown', reason: 'steer timed out' }))
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('steer timed out')
    expect(res.exitCode).toBe(6)
    expect(checkIdempotency(k)).toEqual({ blocked: false })
  })

  test('codex deliver throws → exit 6, no key', async () => {
    const info = codex(async () => { throw new Error('boom') })
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res).toMatchObject({ ok: false, exitCode: 6 })
    expect(res.error).toContain('boom')
    expect(checkIdempotency(k)).toEqual({ blocked: false })
  })

  test('a retry while the first is in flight → exit 7 "in flight"; after it lands → exit 2', async () => {
    let release!: () => void
    const info = codex(() => new Promise(r => { release = () => r({ status: 'accepted', via: 'steer' }) }))
    const k = key()
    const first = deliver(info.sessionId, { idempotencyKey: k })
    const second = await deliver(info.sessionId, { idempotencyKey: k })
    expect(second).toMatchObject({ ok: false, exitCode: 7 })
    expect(second.error).toContain('in flight')
    release?.()
    expect(await first).toMatchObject({ ok: true, data: { status: 'delivered' } })
    expect(await deliver(info.sessionId, { idempotencyKey: k })).toMatchObject({ ok: false, exitCode: 2 })
  })

  test('claude bridge write → delivered/socket_write, key completed', async () => {
    const info = seed('claude')
    const written = bridge(info.sessionId, () => true)
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k, initiator: 'op' })
    expect(res).toEqual({ type: 'cli-response', command: 'deliver', id: res.id, ok: true,
      data: { status: 'delivered', proof: 'socket_write', ...common(info) } })
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0])).toEqual({ type: 'notification', content: 'whisper', meta: { source: 'cli-deliver', initiator: 'op' } })
    expect(checkIdempotency(k)).toMatchObject({ blocked: true, entry: { status: 'completed' } })
  })

  test('claude socket destroyed → exit 6 "bridge write failed", no key', async () => {
    const info = seed('claude')
    bridge(info.sessionId, () => true, true)
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res).toEqual({ type: 'cli-response', command: 'deliver', id: res.id, ok: false,
      error: 'bridge write failed (socket destroyed) — transient, retry', exitCode: 6 })
    expect(checkIdempotency(k)).toEqual({ blocked: false })
  })

  test('claude --queue with no bridge past grace → queued/persisted, key completed', async () => {
    const info = seed('claude', { createdAt: 1 })
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k, queue: true })
    expect(res).toEqual({ type: 'cli-response', command: 'deliver', id: res.id, ok: true,
      data: { status: 'queued', proof: 'persisted', ...common(info) } })
    expect(checkIdempotency(k)).toMatchObject({ blocked: true, entry: { status: 'completed' } })
  })

  test('claude no bridge past grace without --queue → exit 4 orphaned, no key', async () => {
    const info = seed('claude', { createdAt: 1 })
    const k = key()
    const res = await deliver(info.sessionId, { idempotencyKey: k })
    expect(res).toMatchObject({ ok: false, exitCode: 4 })
    expect(checkIdempotency(k)).toEqual({ blocked: false })
  })
})


// The on-kill hook asks main to run /retro via `hydra deliver --session main`.
describe('cli-handler: deliver to main', () => {
  const deliverMain = (extra: Record<string, unknown> = {}) =>
    handleCLIRequest(makeReq({ command: 'deliver', params: { session: 'main', message: 'retro x', initiator: 'on-kill-hook', ...extra } }))

  test('main disconnected: refused without --queue, queued with it; connected: delivered to the main bridge', async () => {
    const origHas = transport.has, origSend = transport.sendOrQueue
    const sent: Array<[string, any]> = []
    let connected = false
    ;(transport as any).has = (id: string) => id === 'main' ? connected : origHas.call(transport, id)
    ;(transport as any).sendOrQueue = (id: string, msg: any) => { sent.push([id, msg]) }
    try {
      const refused = await deliverMain()
      expect(refused.ok).toBe(false)
      expect(sent).toEqual([])

      expect(((await deliverMain({ queue: true })).data as any).status).toBe('queued')
      connected = true
      expect(((await deliverMain()).data as any).status).toBe('delivered')

      expect(sent.map(([id]) => id)).toEqual(['main', 'main'])
      expect(sent[1][1]).toMatchObject({ type: 'notification', content: 'retro x', meta: { source: 'cli-deliver', initiator: 'on-kill-hook' } })
    } finally {
      ;(transport as any).has = origHas
      ;(transport as any).sendOrQueue = origSend
    }
  })
})
