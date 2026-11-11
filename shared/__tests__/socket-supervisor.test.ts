import { describe, test, expect } from 'bun:test'
import {
  SocketSupervisor, type SocketEmitter, type SocketSupervisorOpts,
  STALE_THRESHOLD_MS, HEALTH_CHECK_MS, HEALTH_CHECK_FAST_MS, MAX_RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_BASE_MS, RECONNECT_BACKOFF_CAP_MS, OUTAGE_GAP_MS, HEARTBEAT_WRITE_THROTTLE_MS,
} from '../socket-supervisor.js'
import { createResumeDetector } from '../resume.js'

/** A Socket Mode client stand-in: tests fire its lifecycle events by name. */
class FakeClient implements SocketEmitter {
  private handlers = new Map<string, (() => void)[]>()
  on(event: string, fn: () => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this }
  emit(event: string) { for (const fn of this.handlers.get(event) ?? []) fn() }
}

function setup(over: Partial<SocketSupervisorOpts> = {}) {
  let now = 1_000_000
  const client = { current: new FakeClient() as FakeClient | null }
  const calls = { start: 0, heartbeat: 0, exhausted: [] as number[], gaps: [] as number[] }
  const logs: string[] = []
  const state = { network: true, startImpl: async () => {} }
  const sup = new SocketSupervisor({
    name: 'test',
    start: async () => { calls.start++; await state.startImpl() },
    emitter: () => client.current,
    healthUrl: 'https://example.test',
    onExhausted: n => calls.exhausted.push(n),
    onGap: g => calls.gaps.push(g),
    writeHeartbeat: () => { calls.heartbeat++ },
    now: () => now,
    fetch: async () => ({ ok: state.network }),
    log: l => logs.push(l),
    ...over,
  })
  return { sup, client, calls, logs, state, tick: (ms: number) => { now += ms }, now: () => now }
}

describe('SocketSupervisor: noticing a dead socket', () => {
  test('a connected socket is never stale however quiet; a blip that heals does not trip it', async () => {
    const t = setup()
    t.sup.attach()
    t.client.current!.emit('connected')
    t.tick(STALE_THRESHOLD_MS * 5)
    await t.sup.tick()
    expect(t.calls.start).toBe(0)
    t.client.current!.emit('reconnecting')
    t.tick(10_000)
    t.client.current!.emit('connected')
    t.tick(STALE_THRESHOLD_MS * 2)
    await t.sup.tick()
    expect(t.calls.start).toBe(0)
  })

  test('close marks the socket down at once, before the SDK says reconnecting', () => {
    const t = setup()
    t.sup.attach()
    t.client.current!.emit('connected')
    expect(t.sup.state.connected).toBe(true)
    t.client.current!.emit('close') // the ping monitor terminated it; reconnecting is at least 5s away
    expect(t.sup.state.connected).toBe(false)
    expect(t.sup.state.downSince).toBe(t.now())
  })

  test('continuously down past the threshold reconnects, and the tick withholds the heartbeat while it is stale', async () => {
    const t = setup()
    t.sup.attach()
    t.client.current!.emit('connected')
    t.client.current!.emit('disconnected')
    t.tick(STALE_THRESHOLD_MS + 1)
    const before = t.calls.heartbeat
    await t.sup.tick() // the start does not bring the socket back, so it stays stale
    expect(t.calls.start).toBe(1)
    expect(t.calls.heartbeat).toBe(before)
    // once connected again, the next tick is healthy and writes it
    t.client.current!.emit('connected')
    t.tick(HEARTBEAT_WRITE_THROTTLE_MS + 1)
    const mid = t.calls.heartbeat
    await t.sup.tick()
    expect(t.calls.heartbeat).toBeGreaterThan(mid - 1)
    expect(t.calls.start).toBe(1)
  })

  test('when the connection cannot be hooked, staleness falls back to activity time', async () => {
    const t = setup()
    t.client.current = null
    t.sup.attach()
    expect(t.sup.state.hooked).toBe(false)
    t.tick(STALE_THRESHOLD_MS - 1)
    await t.sup.tick()
    expect(t.calls.start).toBe(0)
    t.tick(2)
    await t.sup.tick()
    expect(t.calls.start).toBe(1)
  })

  test('a socket down across a sleep is not stale on the first tick after wake: only awake time counts', async () => {
    const resumes = createResumeDetector({ lastSleep: async () => null, log: () => {} })
    const t = setup({ awakeSince: (at, now) => resumes.awakeSince(at, now) })
    t.sup.attach()
    t.client.current!.emit('connected')
    t.client.current!.emit('close') // the lid closes a moment later
    t.tick(1_000 + 99 * 60_000)
    resumes.noteResume(99 * 60_000, t.now(), t.now() - 99 * 60_000)
    await t.sup.tick()
    expect(t.calls.start).toBe(0)
    t.tick(STALE_THRESHOLD_MS)
    await t.sup.tick()
    expect(t.calls.start).toBe(1)
    expect(t.logs[0]).toContain('socket down 181s')
  })

  test("a replaced connection's late events do nothing", async () => {
    const t = setup()
    t.sup.attach()
    const old = t.client.current!
    t.client.current = new FakeClient()
    t.sup.attach() // a new connection: a new generation
    t.client.current.emit('connected')
    old.emit('disconnected') // the dead socket's teardown, arriving late
    expect(t.sup.state.connected).toBe(true)
    expect(t.sup.state.downSince).toBeNull()
  })
})

describe('SocketSupervisor: reconnecting', () => {
  test('network down: poll fast, keep the heartbeat, reset the attempt count, do not start', async () => {
    const t = setup()
    t.state.network = false
    t.sup.attach()
    t.client.current!.emit('disconnected')
    t.tick(STALE_THRESHOLD_MS + 1)
    await t.sup.tick()
    expect(t.calls.start).toBe(0)
    expect(t.sup.checkIntervalMs).toBe(HEALTH_CHECK_FAST_MS)
    expect(t.calls.heartbeat).toBeGreaterThan(0)
  })

  test('failures back off 10s doubling to the cap; success returns to the normal interval', async () => {
    const t = setup()
    t.state.startImpl = async () => { throw new Error('slack down') }
    const waits: number[] = []
    for (let i = 0; i < 6; i++) { await t.sup.reconnect(); waits.push(t.sup.checkIntervalMs) }
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, RECONNECT_BACKOFF_CAP_MS])
    expect(RECONNECT_BACKOFF_BASE_MS).toBe(10_000)
    t.state.startImpl = async () => {}
    await t.sup.reconnect()
    expect(t.sup.checkIntervalMs).toBe(HEALTH_CHECK_MS)
    expect(t.sup.state.reconnectAttempts).toBe(0)
  })

  test('exhaustion calls the injected policy once the network is up and attempts run out; a policy that returns keeps trying', async () => {
    const t = setup()
    t.state.startImpl = async () => { throw new Error('nope') }
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) await t.sup.reconnect()
    expect(t.calls.exhausted).toEqual([])
    await t.sup.reconnect()
    expect(t.calls.exhausted).toEqual([MAX_RECONNECT_ATTEMPTS + 1])
    expect(t.sup.state.exhausted).toBe(true)
    expect(t.calls.start).toBe(MAX_RECONNECT_ATTEMPTS + 1) // it still tried
    t.state.startImpl = async () => {}
    await t.sup.reconnect()
    expect(t.sup.state.exhausted).toBe(false)
  })

  test('a reconnect after a long silence reports the gap; a short one does not', async () => {
    const t = setup()
    t.tick(OUTAGE_GAP_MS + 1000)
    await t.sup.reconnect()
    expect(t.calls.gaps).toHaveLength(1)
    expect(t.calls.gaps[0]).toBeGreaterThan(OUTAGE_GAP_MS)
    t.tick(5_000)
    await t.sup.reconnect()
    expect(t.calls.gaps).toHaveLength(1)
  })

  test('only one reconnect at a time, including a requested one', async () => {
    const t = setup()
    let release!: () => void
    t.state.startImpl = () => new Promise<void>(r => { release = r })
    const first = t.sup.reconnect()
    await Bun.sleep(5)
    expect(await t.sup.forceReconnect()).toMatchObject({ ok: false, message: 'reconnect already in progress' })
    await t.sup.reconnect() // returns immediately
    expect(t.calls.start).toBe(1)
    release()
    await first
  })

  test('forceReconnect reports an unreachable network and a failed start', async () => {
    const t = setup()
    t.state.network = false
    expect(await t.sup.forceReconnect()).toMatchObject({ ok: false, message: 'network unreachable' })
    t.state.network = true
    t.state.startImpl = async () => { throw new Error('bad token') }
    expect(await t.sup.forceReconnect()).toMatchObject({ ok: false, message: 'bad token' })
    t.state.startImpl = async () => {}
    expect(await t.sup.forceReconnect()).toMatchObject({ ok: true })
  })
})

describe('SocketSupervisor: heartbeat', () => {
  test('touch writes the owner heartbeat at most once per throttle window', () => {
    const t = setup()
    t.tick(HEARTBEAT_WRITE_THROTTLE_MS + 1)
    t.sup.touch(); t.sup.touch(); t.sup.touch()
    expect(t.calls.heartbeat).toBe(1)
    t.tick(HEARTBEAT_WRITE_THROTTLE_MS + 1)
    t.sup.touch()
    expect(t.calls.heartbeat).toBe(2)
  })

  test('a supervisor with no heartbeat writer runs fine (the listener has none)', async () => {
    const t = setup({ writeHeartbeat: undefined })
    t.sup.touch()
    await t.sup.tick()
    expect(t.calls.heartbeat).toBe(0)
  })

  test('begin is idempotent and stop clears the timer', () => {
    const t = setup()
    t.sup.begin(); t.sup.begin()
    t.sup.stop()
    t.sup.stop()
  })
})
