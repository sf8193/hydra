import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { decideHeal, healCheck, healCheckNow, healSession, healNotice, HEAL_COOLDOWN_MS, _setHealDepsForTesting, type HealDeps, type HealReason } from '../spin-heal.js'
import { autoRecoverEligible, registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { fakeAdapter } from './test-harness.js'
import { _setDaemonStartedAtForTesting, occupancy } from '../session-reachability.js'
import { liveStateOf } from '../engines/claude-status.js'
import type { LiveState } from '../engines/engine-adapter.js'

// 502 is the hot bridge in every spin case.
const SPIN: HealReason = { kind: 'spinning', pct: 99, pid: 502 }
const ORPHAN: HealReason = { kind: 'orphaned' }

const base = { enabled: true, eligible: true, ownsThread: true, healing: false, now: 1_000_000 }

describe('decideHeal', () => {
  test('heals an eligible worker when auto-recover is on', () => {
    expect(decideHeal(base)).toBe('heal')
  })
  test('off means today\'s alert', () => {
    expect(decideHeal({ ...base, enabled: false })).toBe('alert')
  })
  test('only a session boot recovery would also revive, and only its thread\'s owner', () => {
    expect(decideHeal({ ...base, eligible: false })).toBe('alert')
    // A stale owner: the revive would act on the thread's current session, not this one.
    expect(decideHeal({ ...base, ownsThread: false })).toBe('alert')
  })
  test('one heal at a time per thread, and one per cooldown window', () => {
    expect(decideHeal({ ...base, healing: true })).toBe('alert')
    expect(decideHeal({ ...base, lastHealAt: base.now - HEAL_COOLDOWN_MS + 1 })).toBe('alert')
    expect(decideHeal({ ...base, lastHealAt: base.now - HEAL_COOLDOWN_MS })).toBe('heal')
  })
})

test('healNotice names the cause in one line, and says "fresh" when there is no conversation to resume', () => {
  const resumable = { tmuxName: 'pixel', claudeSessionId: 'c-1' }
  expect(healNotice(resumable, SPIN)).toContain('spinning (99% CPU while idle)')
  expect(healNotice(resumable, ORPHAN)).toContain('unreachable')
  expect(healNotice(resumable, ORPHAN)).toContain('resuming with context')
  expect(healNotice(resumable, ORPHAN)).not.toContain('\n')
  expect(healNotice({ tmuxName: 'pixel' }, ORPHAN)).toContain('restarting it from the thread history')
  expect(healNotice({ tmuxName: 'pixel' }, ORPHAN)).not.toContain('context')
})

describe('healCheck', () => {
  const idle = { occupancy: 'orphaned' as const, spinning: 'bridge' as const, bridgePid: 502, live: 'idle' as const }
  test('an orphan or a spin that still holds, on a session its provider reports idle, is healed', () => {
    expect(healCheck(ORPHAN, idle)).toBe('needed')
    expect(healCheck(SPIN, idle)).toBe('needed')
  })
  test('only a positive idle signal allows a kill: working, blocked and unknown are left alone, on either trigger', () => {
    for (const live of ['working', 'blocked', null] as const) {
      expect(healCheck(ORPHAN, { ...idle, live })).toBe('not-idle')
      expect(healCheck(SPIN, { ...idle, live })).toBe('not-idle')
    }
    // Idle at the prompt with background work still running (Claude's `shell`): not idle.
    expect(healCheck(ORPHAN, { ...idle, background: true })).toBe('not-idle')
    expect(healCheck(SPIN, { ...idle, background: true })).toBe('not-idle')
  })
  test('a trigger that no longer holds is resolved', () => {
    expect(healCheck(ORPHAN, { ...idle, occupancy: 'reachable' })).toBe('resolved')
    expect(healCheck(SPIN, { ...idle, spinning: null })).toBe('resolved')
    expect(healCheck(SPIN, { ...idle, spinning: 'claude' })).toBe('resolved')
    // The spin moved to another bridge: a new episode, not this heal's.
    expect(healCheck(SPIN, { ...idle, bridgePid: 777 })).toBe('resolved')
    expect(healCheck(SPIN, { ...idle, live: 'working', spinning: null })).toBe('resolved')
  })
})

test("Claude's statuses: only `idle` is idle; `shell` (a background command running) has no signal, so it is never healed", () => {
  expect(liveStateOf('idle')).toBe('idle')
  expect(liveStateOf('shell')).toBeNull()
  expect(liveStateOf('waiting')).toBe('blocked')
  expect(liveStateOf('busy')).toBe('working')
})

describe('healCheckNow (the default stillNeeded, unstubbed)', () => {
  // An orphan for real: its tmux is alive, no bridge is connected, and the daemon has been up past the grace window.
  const orphanWith = (live: LiveState | null, backgroundWork?: boolean): SessionInfo => ({
    sessionId: `now-${live}`, threadId: `thread-now-${live}`, tmuxName: `now-${live}`, createdAt: 0,
    adapter: fakeAdapter({ isAlive: () => true, turn: () => ({ live, backgroundWork, activityAt: null, confirmedComplete: false, answer: () => null }) }),
  } as unknown as SessionInfo)
  beforeEach(() => _setDaemonStartedAtForTesting(0))
  afterEach(() => _setDaemonStartedAtForTesting(undefined))

  test('reads the provider live state: an idle orphan is needed; working, blocked or no signal is not idle', () => {
    expect(healCheckNow(orphanWith('idle'), ORPHAN, occupancy)).toBe('needed')
    for (const live of ['working', 'blocked', null] as const) expect(healCheckNow(orphanWith(live), ORPHAN, occupancy)).toBe('not-idle')
    expect(healCheckNow(orphanWith('idle', true), ORPHAN, occupancy)).toBe('not-idle') // the engine's backgroundWork
  })
  test('reads occupancy: an orphan that is not running is resolved, whatever its live state', () => {
    const gone = { ...orphanWith('idle'), adapter: fakeAdapter({ isAlive: () => false, turn: () => ({ live: 'idle', activityAt: null, confirmedComplete: false, answer: () => null }) }) } as unknown as SessionInfo
    expect(healCheckNow(gone, ORPHAN, occupancy)).toBe('resolved')
  })
  test('reads the spin vitals: with no reading of this bridge spinning, a spin is resolved', () => {
    expect(healCheckNow(orphanWith('idle'), SPIN, occupancy)).toBe('resolved')
  })
})

describe('healSession', () => {
  let log: string[]
  let alive: Set<number>
  let connected: boolean
  let fallbacks: string[]
  const seeded: SessionInfo[] = []
  const prevEnv = process.env.HYDRA_SPIN_HEAL
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

  function info(n: string, extra: Partial<SessionInfo> = {}): SessionInfo {
    const s = {
      sessionId: `heal-${n}`, threadId: `thread-heal-${n}`, tmuxName: `heal-${n}`, topic: 't', createdAt: 0, lastActive: 0,
      listening: false, engine: 'claude', sessionType: 'thread_owner',
      adapter: fakeAdapter({ recoveryPlan: () => ({ generic: true, resume: null, fork: null }) }),
      ...extra,
    } as unknown as SessionInfo
    registry.set(s.sessionId, s)
    registry.setThread(s.threadId, s.sessionId)
    threadRegistry.recordSpawn(s.threadId, { topic: 't', respawnCount: 0, sessionId: s.sessionId, tmuxName: s.tmuxName, originType: 'spawn', label: undefined })
    seeded.push(s)
    return s
  }
  const fallbackFor = (s: SessionInfo) => () => { fallbacks.push(s.sessionId) }

  function stubs(over: Partial<HealDeps> = {}): Partial<HealDeps> {
    const isConnected = over.connected ?? (() => connected)
    return {
      send: async (threadId, text, replyTo) => { log.push(`send ${threadId} ${text.split(" ")[0]}${replyTo ? ` ↩${replyTo}` : ''}`); return { id: 'notice-1' } },
      bridges: () => [...alive],
      // 501 honours SIGTERM; 502 is stuck spinning and only SIGKILL stops it.
      kill: (pid, sig) => { log.push(`kill ${pid} ${sig}`); if (sig === 'SIGKILL' || pid === 501) { alive.delete(pid); if (alive.size === 0) connected = false } },
      connected: isConnected,
      occupancy: async () => isConnected('') ? 'reachable' : 'orphaned',
      sleep: async ms => { log.push(`sleep ${ms}`) },
      lock: async (threadId, fn) => { log.push(`lock ${threadId}`); try { return await fn() } finally { log.push('unlock') } },
      targetKey: async threadId => threadId,
      backedOff: async () => undefined,
      stillNeeded: async () => 'needed',
      revive: async req => {
        log.push(`revive ${req.thread.threadId} orphan=${req.orphan?.info.sessionId} backoff=${req.backoffKey}`)
        return reviveResult(req)
      },
      ...over,
    }
  }
  let reviveResult: (req: any) => any = () => ({ ok: true, method: 'resumed', result: { name: 'heal-new', sessionId: 'heal-new' }, lastTmuxName: 'x' })

  beforeEach(() => {
    process.env.HYDRA_SPIN_HEAL = '1'
    log = []
    alive = new Set([501, 502])
    connected = true
    fallbacks = []
    reviveResult = () => ({ ok: true, method: 'resumed', result: { name: 'heal-new', sessionId: 'heal-new' }, lastTmuxName: 'x' })
    _setHealDepsForTesting(stubs())
  })

  afterEach(() => {
    _setHealDepsForTesting(undefined)
    for (const s of seeded.splice(0)) { registry.delete(s.sessionId); registry.deleteThread(s.threadId); threadRegistry.delete(s.threadId) }
    if (prevEnv === undefined) delete process.env.HYDRA_SPIN_HEAL
    else process.env.HYDRA_SPIN_HEAL = prevEnv
  })

  test('orphan, under the thread lock: notice, TERM every bridge, KILL survivors only, revive the orphan, announce', async () => {
    const s = info('a')
    expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(true)
    await settle()
    expect(log).toEqual([
      'lock thread-heal-a',
      'send thread-heal-a 🔌',
      'kill 501 SIGTERM',
      'kill 502 SIGTERM',
      'sleep 2000',
      'kill 502 SIGKILL',
      'revive thread-heal-a orphan=heal-a backoff=thread-heal-a',
      'send thread-heal-a ⏯️ ↩notice-1',
      'unlock',
    ])
    expect(fallbacks).toEqual([])
  })

  test('spin beside a healthy bridge: only the hot one dies, and a still-connected session is not revived', async () => {
    const s = info('a2')
    healSession(s, SPIN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(kill|revive|send)/.test(l))).toEqual([
      'send thread-heal-a2 🔥',
      'kill 502 SIGTERM',
      'kill 502 SIGKILL',
      'send thread-heal-a2 ✅ ↩notice-1',
    ])
    expect(alive).toEqual(new Set([501]))
    expect(fallbacks).toEqual([])
  })

  test('the still-connected reply says what happened: killed, or already gone before the heal ran', async () => {
    const texts: string[] = []
    const send: HealDeps['send'] = async (_t, text) => { texts.push(text); return { id: 'n' } }
    _setHealDepsForTesting(stubs({ send }))
    const killed = info('a2k')
    healSession(killed, SPIN, fallbackFor(killed))
    await settle()
    alive = new Set([501]) // the hot bridge exited on its own while the heal was queued
    _setHealDepsForTesting(stubs({ send }))
    const gone = info('a2g')
    healSession(gone, SPIN, fallbackFor(gone))
    await settle()
    expect(texts.filter(t => t.startsWith('✅'))).toEqual([
      expect.stringContaining('Killed the stuck bridge'),
      expect.stringContaining('had already exited'),
    ])
  })

  test('spin on the only bridge: it dies, the session is orphaned, and it is revived', async () => {
    alive = new Set([502])
    const s = info('a3')
    healSession(s, SPIN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(kill|revive)/.test(l))).toEqual(['kill 502 SIGTERM', 'kill 502 SIGKILL', 'revive thread-heal-a3 orphan=heal-a3 backoff=thread-heal-a3'])
    expect(fallbacks).toEqual([])
  })

  test('SIGKILL goes only to a bridge that was TERMed and is still the live one: never to a new pid, never to one that exited', async () => {
    // First read: 501 and 502. After the grace: 501 exited on TERM, 502 is still stuck, and 503 is a new bridge
    // (or a recycled pid that re-validated). Only 502 is KILLed.
    const reads = [[501, 502], [502, 503]]
    _setHealDepsForTesting(stubs({ bridges: () => reads.shift() ?? [], kill: (pid, sig) => { log.push(`kill ${pid} ${sig}`) }, connected: () => false }))
    const s = info('a4')
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.filter(l => l.startsWith('kill'))).toEqual(['kill 501 SIGTERM', 'kill 502 SIGTERM', 'kill 502 SIGKILL'])
  })

  test('waits for the socket to drop before checking occupancy', async () => {
    let asks = 0
    _setHealDepsForTesting(stubs({ bridges: () => [], occupancy: async () => 'orphaned', connected: () => { log.push('connected?'); return ++asks < 3 } }))
    const s = info('b')
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(connected|sleep|revive)/.test(l)).map(l => l.split(' ')[0])).toEqual(['connected?', 'sleep', 'connected?', 'sleep', 'connected?', 'revive'])
  })

  test('a notice that cannot be posted kills nothing and falls back to the alert', async () => {
    _setHealDepsForTesting(stubs({ send: async () => { throw new Error('thread archived') } }))
    const s = info('c')
    expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(true)
    await settle()
    expect(log.filter(l => /^(kill|revive)/.test(l))).toEqual([])
    expect(fallbacks).toEqual([s.sessionId])
  })

  test('backed off: refused before anything is posted or killed, and the alert fires', async () => {
    _setHealDepsForTesting(stubs({ backedOff: async () => 'not retrying until 12:00:00 (2 failures)' }))
    const s = info('c2')
    healSession(s, SPIN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(send|kill|revive)/.test(l))).toEqual([])
    expect(fallbacks).toEqual([s.sessionId])
  })

  test('not idle when its turn comes (working, a prompt, a shell running): nothing posted or killed, and the alert fires', async () => {
    for (const reason of [ORPHAN, SPIN]) {
      _setHealDepsForTesting(stubs({ stillNeeded: async () => 'not-idle' }))
      fallbacks = []
      const s = info(`w-${reason.kind}`)
      healSession(s, reason, fallbackFor(s))
      await settle()
      expect(log.filter(l => /^(send|kill|revive)/.test(l))).toEqual([])
      expect(fallbacks).toEqual([s.sessionId])
    }
  })

  test('recovered while queued (no longer orphaned or spinning): left alone, nothing posted, no alert', async () => {
    _setHealDepsForTesting(stubs({ stillNeeded: async () => 'resolved' }))
    const s = info('c3')
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(send|kill|revive)/.test(l))).toEqual([])
    expect(fallbacks).toEqual([])
  })

  test('starting after our own kill (inside the grace window) is an orphan all the same: revived, not left dead', async () => {
    _setHealDepsForTesting(stubs({ occupancy: async () => 'starting' }))
    const s = info('d-starting')
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.some(l => l.startsWith(`revive ${s.threadId}`))).toBe(true)
    expect(fallbacks).toEqual([])
  })

  test('starting or dead with nothing killed: not ours, no revive, the alert fires', async () => {
    for (const occ of ['starting', 'dead'] as const) {
      _setHealDepsForTesting(stubs({ bridges: () => [], connected: () => false, occupancy: async () => occ }))
      fallbacks = []
      const s = info(`d-none-${occ}`)
      healSession(s, ORPHAN, fallbackFor(s))
      await settle()
      expect(log.some(l => l.startsWith(`revive ${s.threadId}`))).toBe(false)
      expect(fallbacks).toEqual([s.sessionId])
    }
  })

  test('revived but its bridge never connected: said honestly in the thread, and the alert fires', async () => {
    reviveResult = () => ({ ok: true, method: 'resumed', result: { name: 'heal-new', sessionId: 'heal-new', bridgeOrphan: true }, lastTmuxName: 'x' })
    const s = info('d-deaf')
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.filter(l => l.startsWith('send'))).toEqual(['send thread-heal-d-deaf 🔌', 'send thread-heal-d-deaf ⚠️ ↩notice-1'])
    expect(fallbacks).toEqual([s.sessionId])
  })

  test('a fallback that throws does not stall the queue: later heals still run and clear their in-flight mark', async () => {
    _setHealDepsForTesting(stubs({ bridges: () => [], connected: () => false, backedOff: async key => key === 'thread-heal-q1' ? 'backed off' : undefined }))
    const [a, b] = [info('q1'), info('q2')]
    healSession(a, ORPHAN, () => { throw new Error('alert exploded') })
    healSession(b, ORPHAN, fallbackFor(b))
    await settle()
    expect(log.filter(l => l.startsWith('revive')).map(l => l.split(' ')[1])).toEqual(['thread-heal-q2'])
    // Neither thread is stuck "healing": past the cooldown, both can be healed again.
    const later = Date.now() + HEAL_COOLDOWN_MS
    expect(healSession(a, ORPHAN, fallbackFor(a), later)).toBe(true)
    expect(healSession(b, ORPHAN, fallbackFor(b), later)).toBe(true)
  })

  test('a revive that fails (or is backed off) falls back to the alert; one already in progress does not', async () => {
    reviveResult = () => ({ ok: false, reason: 'all recovery methods failed', lastTmuxName: 'x' })
    const failed = info('d1')
    healSession(failed, ORPHAN, fallbackFor(failed))
    await settle()
    expect(fallbacks).toEqual([failed.sessionId])

    reviveResult = () => ({ ok: false, busy: true, reason: 'busy', lastTmuxName: 'x' })
    const busy = info('d2')
    healSession(busy, ORPHAN, fallbackFor(busy))
    await settle()
    expect(fallbacks).toEqual([failed.sessionId])
  })

  test('replaced before the lock was taken: nothing posted, killed or revived, no alert', async () => {
    const s = info('d3')
    _setHealDepsForTesting(stubs({ lock: async (_t, fn) => { registry.setThread(s.threadId, 'someone-new'); return fn() } }))
    healSession(s, ORPHAN, fallbackFor(s))
    await settle()
    expect(log.filter(l => /^(send|kill|revive)/.test(l))).toEqual([])
    expect(fallbacks).toEqual([])
  })

  test('off (the default): returns false and touches nothing, so the caller alerts as today, even with boot auto-recover on', async () => {
    delete process.env.HYDRA_SPIN_HEAL
    const prevAuto = process.env.HYDRA_AUTO_RECOVER
    process.env.HYDRA_AUTO_RECOVER = '1' // the installer sets this on every daemon: it must not turn healing on
    const s = info('e')
    try { expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(false) } finally {
      if (prevAuto === undefined) delete process.env.HYDRA_AUTO_RECOVER
      else process.env.HYDRA_AUTO_RECOVER = prevAuto
    }
    await settle()
    expect(log).toEqual([])
    expect(fallbacks).toEqual([]) // the caller alerts on `false`, not the fallback
  })

  test('a second trigger for the same thread inside the window is left to the alert', async () => {
    const s = info('f')
    expect(healSession(s, SPIN, fallbackFor(s))).toBe(true)
    expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(false) // in flight
    await settle()
    expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(false) // cooldown
    expect(healSession(s, ORPHAN, fallbackFor(s), Date.now() + HEAL_COOLDOWN_MS)).toBe(true)
  })

  test('the cooldown starts at the kill: a heal refused before it (not idle, backed off) leaves none', async () => {
    for (const over of [{ stillNeeded: async () => 'not-idle' as const }, { backedOff: async () => 'backed off' }] as Partial<HealDeps>[]) {
      _setHealDepsForTesting(stubs(over))
      const s = info(`cd-${Object.keys(over)[0]}`)
      expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(true)
      await settle()
      expect(log.some(l => l.startsWith('kill'))).toBe(false)
      expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(true) // no cooldown: the next trigger may heal
    }
  })

  test('heals run one at a time', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    _setHealDepsForTesting(stubs({
      bridges: () => [], connected: () => false,
      revive: async req => { log.push(`revive ${req.thread.threadId}`); if (req.thread.threadId === 'thread-heal-g1') await gate; return reviveResult(req) },
    }))
    const [a, b] = [info('g1'), info('g2')]
    healSession(a, ORPHAN, fallbackFor(a))
    healSession(b, ORPHAN, fallbackFor(b))
    await settle()
    expect(log.filter(l => l.startsWith('revive'))).toEqual(['revive thread-heal-g1'])
    release()
    await settle()
    expect(log.filter(l => l.startsWith('revive'))).toEqual(['revive thread-heal-g1', 'revive thread-heal-g2'])
  })

  test('ineligible sessions are never healed: boot recovery\'s rule (autoRecoverEligible), and a stale owner', () => {
    const guest = info('h1', { sessionType: 'thread_guest' } as Partial<SessionInfo>)
    const orchestrator = info('h1o', { sessionType: 'master_orchestrator' } as Partial<SessionInfo>)
    const eph = info('h2', { ephemeral: true } as Partial<SessionInfo>)
    const parked = info('h2p', { suppressAutoRecover: true } as Partial<SessionInfo>)
    const codex = info('h2c', { adapter: fakeAdapter({ recoveryPlan: () => ({ generic: false, resume: null, fork: null }) }) } as Partial<SessionInfo>)
    const noRecord = info('h2n')
    threadRegistry.delete(noRecord.threadId)
    const stale = info('h3')
    registry.setThread(stale.threadId, 'someone-else')
    for (const s of [guest, orchestrator, eph, parked, codex, noRecord]) expect(autoRecoverEligible(s)).toBe(false)
    for (const s of [guest, orchestrator, eph, parked, codex, noRecord, stale]) expect(healSession(s, ORPHAN, fallbackFor(s))).toBe(false)
    expect(autoRecoverEligible(info('h4'))).toBe(true)
  })
})
