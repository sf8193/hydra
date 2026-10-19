// Pins one session-health pass (pollSessionsOnce): crash detection, orphan
// alert (+ Claude id discovery, C4) and the context alert. Real tmux checks
// and discovery run against a PATH-shim tmux (see fake-tmux.ts).
//
// The alert sets are module-level and keyed by sessionId, so every case uses
// fresh ids. Only messages to this file's threads are asserted — the registry
// is a process-wide singleton.

import { engines } from '../engines/instances.js'
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { pollSessionsOnce } from '../session-health.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway, ACCESS_FILE, envPercent } from '../config.js'
import { noteMainChannel } from '../main-session.js'
import { ORPHAN_GRACE_MS } from '../session-reachability.js'
import { requestHandoff } from '../session-lifecycle.js'
import { pendingPermissions } from '../permission.js'
import { HANDOFF_TEMPLATE_DIR } from '../handoff-templates.js'
import { fakeAdapter } from './test-harness.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const SID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const PID = '515151'

let tmux: FakeTmux
let sent: Array<{ threadId: string; text: string }> = []
let stderr: string[] = []
let seq = 0
const seededSessions = new Set<string>()
const seededThreads = new Set<string>()
let orig: Record<string, any> = {}

beforeAll(() => {
  orig = { send: gateway.send, registryPersist: registry.persist, threadPersist: threadRegistry.persist }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})

afterAll(() => {
  ;(gateway as any).send = orig.send
  ;(registry as any).persist = orig.registryPersist
  ;(threadRegistry as any).persist = orig.threadPersist
})

beforeEach(() => {
  tmux = withFakeTmux()
  sent = []; stderr = []
  ;(gateway as any).send = async (threadId: string, text: string) => { sent.push({ threadId, text }); return { id: 'm1' } }
  orig.stderrWrite = process.stderr.write
  process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any
})

afterEach(() => {
  process.stderr.write = orig.stderrWrite
  tmux.restore()
  for (const id of seededSessions) { registry.delete(id); transport.bridges.delete(id) }
  for (const t of seededThreads) threadRegistry.threads.delete(t)
  seededSessions.clear(); seededThreads.clear()
})

function seed(extra: Partial<SessionInfo> & { ageMs: number }): SessionInfo {
  const n = ++seq
  const { ageMs, ...rest } = extra
  const info: SessionInfo = {
    sessionId: `sess-sh-${n}`,
    topic: 'topic',
    threadId: `thread-sh-${n}`,
    createdAt: NOW - ageMs,
    lastActive: NOW,
    tmuxName: `hydra-t3-sh-${n}`,
    listening: false,
    engine: 'claude',
    adapter: engines[rest.engine ?? 'claude'],
    sessionType: 'thread_owner',
    ...rest,
  }
  registry.set(info.sessionId, info)
  seededSessions.add(info.sessionId)
  seededThreads.add(info.threadId)
  threadRegistry.recordSpawn(info.threadId, {
    topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName,
    originType: 'spawn', label: undefined,
  })
  return info
}

const NOW = Date.now()
const OLD = ORPHAN_GRACE_MS + 60_000
const to = (info: SessionInfo, marker: string) => sent.filter(m => m.threadId === info.threadId && m.text.includes(marker))
const history = (info: SessionInfo) => threadRegistry.get(info.threadId)!.sessionHistory.find(h => h.sessionId === info.sessionId)!

describe('crash detection', () => {
  test('tmux and bridge gone past spawn grace: deadAt set, history closed, 💀 sent once', () => {
    const info = seed({ ageMs: OLD })

    pollSessionsOnce(NOW)
    pollSessionsOnce(NOW + 1000)

    expect(info.deadAt).toBe(NOW)
    expect(history(info).endedAt).toBeDefined()
    expect(to(info, '💀')).toHaveLength(1)
    expect(to(info, '💀')[0].text).toContain(`**${info.tmuxName}** died`)
  })

  test('inside spawn grace: not a crash', () => {
    const info = seed({ ageMs: 1000 })
    pollSessionsOnce(NOW)
    expect(info.deadAt).toBeUndefined()
    expect(to(info, '💀')).toHaveLength(0)
  })
})

describe('orphan detection', () => {
  test('alert fires once per episode and clears when the bridge returns', () => {
    const info = seed({ ageMs: OLD, claudeSessionId: 'known' })
    tmux.alive(info.tmuxName)

    pollSessionsOnce(NOW)
    pollSessionsOnce(NOW + 1000)
    expect(to(info, '⚠️')).toHaveLength(1)
    expect(to(info, '⚠️')[0].text).toContain(`**${info.tmuxName}** is running but its bridge isn't connected`)

    transport.bridges.set(info.sessionId, {} as any)
    pollSessionsOnce(NOW + 2000)
    expect(to(info, '⚠️')).toHaveLength(1)

    transport.bridges.delete(info.sessionId)
    pollSessionsOnce(NOW + 3000)
    expect(to(info, '⚠️')).toHaveLength(2)
    expect(info.deadAt).toBeUndefined()
  })

  test("the alert names a launch-time cause when the launch recorded one, and only then", () => {
    const noted = seed({ ageMs: OLD, claudeSessionId: 'known', channelNote: 'Claude Code had the bridge marked needs-auth (cleared at launch)' })
    tmux.alive(noted.tmuxName)
    pollSessionsOnce(NOW)
    const plain = seed({ ageMs: OLD, claudeSessionId: 'known' })
    tmux.alive(plain.tmuxName)
    pollSessionsOnce(NOW + 1000)
    expect(to(noted, '⚠️')[0].text).toContain("isn't connected — replies can't reach this thread. Claude Code had the bridge marked needs-auth (cleared at launch). Use `resume`")
    expect(to(plain, '⚠️')[0].text).toContain("replies can't reach this thread. Use `resume`")
    expect(stderr.join('')).toContain(`orphan detected: ${noted.tmuxName}`)
  })

  describe('several orphans in one pass', () => {
    let dms: Array<{ userId: string; text: string }> = []
    let origSendDM: any
    let failSlowDM: () => void = () => {}

    beforeEach(() => {
      dms = []
      origSendDM = gateway.sendDM
      ;(gateway as any).sendDM = async (userId: string, text: string) => {
        if (userId.startsWith('U-closed')) throw new Error('DMs closed')
        if (userId === 'U-slow') return new Promise<void>((_, reject) => { failSlowDM = () => reject(new Error('timed out')) })
        dms.push({ userId, text })
      }
    })

    afterEach(() => {
      ;(gateway as any).sendDM = origSendDM
      rmSync(ACCESS_FILE, { force: true })
    })

    const settle = () => new Promise(r => setTimeout(r, 0))
    const seedOrphans = (n: number) => Array.from({ length: n }, () => {
      const info = seed({ ageMs: OLD, claudeSessionId: 'known' })
      tmux.alive(info.tmuxName)
      return info
    })

    test('one operator summary replaces the per-thread alerts', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-op'] }))
      const [a, b, c, d] = seedOrphans(4)
      threadRegistry.get(a.threadId)!.threadUrl = 'https://chat/a'
      b.description = '  fixing the thing\r\nsecond line'
      b.channelNote = 'bridge marked needs-auth'
      threadRegistry.get(a.threadId)!.topic = 'z'.repeat(150)
      threadRegistry.get(d.threadId)!.topic = `short\n${'y'.repeat(500)}`
      d.description = '\r\nhidden'

      pollSessionsOnce(NOW)
      await settle()

      expect(to(a, '⚠️')).toHaveLength(0)
      expect(to(b, '⚠️')).toHaveLength(0)
      expect(dms).toHaveLength(1)
      expect(dms[0].userId).toBe('U-op')
      expect(dms[0].text).toStartWith('⚠️ **4 sessions lost their bridge**')
      expect(dms[0].text).toContain(`• [${a.tmuxName}](https://chat/a) — ${'z'.repeat(97)}...\n`)
      expect(dms[0].text).toContain(`• \`${b.tmuxName}\` — fixing the thing (bridge marked needs-auth)\n`)
      expect(dms[0].text).toContain(`• \`${c.tmuxName}\` — topic\n`)
      expect(dms[0].text).toEndWith(`• \`${d.tmuxName}\` — short`)

      pollSessionsOnce(NOW + 1000)
      await settle()
      expect(dms).toHaveLength(1)
    })

    test('a summary past the platform limit is split, not dropped', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-op'] }))
      const orphans = seedOrphans(20)
      for (const info of orphans) {
        threadRegistry.get(info.threadId)!.threadUrl = `https://chat/${info.threadId}/${'x'.repeat(200)}`
      }

      pollSessionsOnce(NOW)
      await settle()

      expect(dms.length).toBeGreaterThan(1)
      expect(dms[0].text).toStartWith('⚠️ **20 sessions lost their bridge**')
      for (const dm of dms) expect(dm.text.length).toBeLessThanOrEqual(gateway.maxMessageLength)
      const joined = dms.map(d => d.text).join('\n')
      for (const info of orphans) expect(joined).toContain(`[${info.tmuxName}](https://chat/${info.threadId}/${'x'.repeat(200)})`)
    })

    test('when no operator DM lands, each thread gets its own alert', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-closed-1', 'U-closed-2'] }))
      const [a, b] = seedOrphans(2)

      pollSessionsOnce(NOW)
      await settle()

      expect(dms).toHaveLength(0)
      expect(to(a, '⚠️')).toHaveLength(1)
      expect(to(b, '⚠️')).toHaveLength(1)
    })

    test('the fallback skips sessions that reconnected, died or were replaced while the DMs were failing', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-closed'] }))
      const [reconnected, died, replaced, stillOrphaned] = seedOrphans(4)

      pollSessionsOnce(NOW)
      transport.bridges.set(reconnected.sessionId, {} as any)
      died.deadAt = NOW
      registry.set(replaced.sessionId, { ...replaced })
      await settle()

      expect(to(reconnected, '⚠️')).toHaveLength(0)
      expect(to(died, '⚠️')).toHaveLength(0)
      expect(to(replaced, '⚠️')).toHaveLength(0)
      expect(to(stillOrphaned, '⚠️')).toHaveLength(1)

      transport.bridges.delete(reconnected.sessionId)
      pollSessionsOnce(NOW + 1000)
      await settle()
      expect(to(reconnected, '⚠️')).toHaveLength(1)
    })

    test('a DM that fails after a newer episode was alerted does not alert again', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-slow'] }))
      const [a] = seedOrphans(2)

      pollSessionsOnce(NOW)
      transport.bridges.set(a.sessionId, {} as any)
      pollSessionsOnce(NOW + 1000)
      transport.bridges.delete(a.sessionId)
      pollSessionsOnce(NOW + 2000)
      expect(to(a, '⚠️')).toHaveLength(1)

      failSlowDM()
      await settle()
      expect(to(a, '⚠️')).toHaveLength(1)
    })

    test('one recipient failing does not stop the others or trigger the fallback', async () => {
      writeFileSync(ACCESS_FILE, JSON.stringify({ allowFrom: ['U-closed', 'U-op'] }))
      const [a, b] = seedOrphans(2)

      pollSessionsOnce(NOW)
      await settle()

      expect(dms.map(d => d.userId)).toEqual(['U-op'])
      expect(to(a, '⚠️')).toHaveLength(0)
      expect(to(b, '⚠️')).toHaveLength(0)
    })
  })

  test('C4: Claude orphan without an id discovers it and updates the open history entry', () => {
    const info = seed({ ageMs: OLD })
    tmux.alive(info.tmuxName)
    tmux.pid(info.tmuxName, PID)
    tmux.seedClaudeSession(PID, SID)

    pollSessionsOnce(NOW)

    expect(info.claudeSessionId).toBe(SID)
    expect(history(info).claudeSessionId).toBe(SID)
    expect(history(info).endedAt).toBeUndefined()
    expect(stderr.join('')).toContain(`daemon: orphan ${info.tmuxName}: discovered claudeSessionId=${SID}`)
    expect(to(info, '⚠️')).toHaveLength(1)
  })

  test('C4: discovery retries on a later poll when the id was not yet available', () => {
    const info = seed({ ageMs: OLD })
    tmux.alive(info.tmuxName)
    tmux.pid(info.tmuxName, PID)

    pollSessionsOnce(NOW)
    expect(info.claudeSessionId).toBeUndefined()

    tmux.seedClaudeSession(PID, SID)
    pollSessionsOnce(NOW + 1000)
    expect(info.claudeSessionId).toBe(SID)
    expect(history(info).claudeSessionId).toBe(SID)
  })

  test('C4: Codex orphan never asks tmux for the pane', () => {
    // The real Codex adapter, disconnected, so the orphan branch is reached (its isConnected is a constant true).
    const adapter = Object.assign(Object.create(engines.codex), { isConnected: () => false })
    const info = seed({ ageMs: OLD, engine: 'codex', adapter })
    tmux.alive(info.tmuxName); tmux.pid(info.tmuxName, PID); tmux.seedClaudeSession(PID, SID)
    pollSessionsOnce(NOW)
    expect(tmux.calls().filter(c => c.startsWith('list-panes'))).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
    expect(to(info, '⚠️')).toHaveLength(1)
  })

  test('C4: discovery persists the registry', () => {
    let n = 0; const p = registry.persist; (registry as any).persist = () => { n++ }
    const info = seed({ ageMs: OLD })
    tmux.alive(info.tmuxName); tmux.pid(info.tmuxName, PID); tmux.seedClaudeSession(PID, SID)
    pollSessionsOnce(NOW)
    ;(registry as any).persist = p
    expect(n).toBe(1)
  })

  test('headless and guest sessions are never orphans', () => {
    const headless = seed({ ageMs: OLD, headless: true, claudeSessionId: 'k1' })
    const guest = seed({ ageMs: OLD, sessionType: 'thread_guest', claudeSessionId: 'k2' })
    tmux.alive(headless.tmuxName); tmux.alive(guest.tmuxName)

    pollSessionsOnce(NOW)
    expect(to(headless, '⚠️')).toHaveLength(0)
    expect(to(guest, '⚠️')).toHaveLength(0)
  })
})

describe('context alert', () => {
  test('≥70% fires once; below 50 does not', () => {
    const hot = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 70 }) }) })
    const cool = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 49 }) }) })

    pollSessionsOnce(NOW)
    pollSessionsOnce(NOW + 1000)

    expect(to(hot, 'context')).toHaveLength(1)
    expect(to(hot, 'context')[0].text).toBe(`**${hot.tmuxName}** is at **70%** context. Consider a \`handoff\` to a fresh session (\`handoff: <note>\` passes a note to it).`)
    expect(to(cool, 'context')).toHaveLength(0)
  })

  test('50% then 70% each fire once; a jump past both fires once', () => {
    let pct = 50
    const climbing = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: pct }) }) })
    const jumping = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 85 }) }) })

    pollSessionsOnce(NOW)
    pollSessionsOnce(NOW + 1000)
    expect(to(climbing, 'context')).toHaveLength(1)
    expect(to(climbing, 'context')[0].text).toBe(`**${climbing.tmuxName}** is at **50%** context. Consider a \`handoff\` to a fresh session (\`handoff: <note>\` passes a note to it).`)
    pct = 70
    pollSessionsOnce(NOW + 2000)
    pollSessionsOnce(NOW + 3000)
    expect(to(climbing, 'context')).toHaveLength(2)
    expect(to(jumping, 'context')).toHaveLength(1)
  })

  test('a drop in context (/clear, /compact) re-arms the alerts', () => {
    let pct = 70
    const info = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: pct }) }) })
    pollSessionsOnce(NOW)
    pct = 10
    pollSessionsOnce(NOW + 1000)
    pct = 70
    pollSessionsOnce(NOW + 2000)
    expect(to(info, 'context')).toHaveLength(2)
  })

  test('the main session alerts into the main channel, once per climb', () => {
    noteMainChannel('')
    try {
      const pane = (p: number) => `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:${p}%\n`
      const mainSent = () => sent.filter(m => m.threadId === 'main-chan-ctx' && m.text.includes('context'))
      tmux.alive('discord-byte')
      tmux.pane('discord-byte', pane(72))
      pollSessionsOnce(NOW)  // main has not been messaged yet: nowhere to alert, and nothing is marked alerted
      expect(sent.filter(m => m.text.includes('discord-byte'))).toHaveLength(0)
      noteMainChannel('main-chan-ctx')
      pollSessionsOnce(NOW + 500)
      pollSessionsOnce(NOW + 1000)
      expect(mainSent()).toHaveLength(1)
      expect(mainSent()[0].text).toContain('**discord-byte** is at **72%**')
      tmux.pane('discord-byte', pane(5))
      pollSessionsOnce(NOW + 2000)
      tmux.pane('discord-byte', pane(72))
      pollSessionsOnce(NOW + 3000)
      expect(mainSent()).toHaveLength(2)
    } finally { noteMainChannel('') }
  })

  test('unknown usage ("?") never alerts', () => {
    const info = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => null }) })
    pollSessionsOnce(NOW)
    expect(to(info, 'context')).toHaveLength(0)
  })
})

describe('auto handoff', () => {
  let asked: string[] = []
  let requests: string[] = []   // what each request told the session
  let timers: Array<{ fn: () => void; ms: number }> = []
  let origSendOrQueue: any
  let origSetTimeout: any
  beforeEach(() => {
    asked = []; requests = []; timers = []
    origSendOrQueue = transport.sendOrQueue
    ;(transport as any).sendOrQueue = (sid: string, m: { content: string }) => { asked.push(sid); requests.push(m.content) }
    process.env.AUTO_HANDOFF_CACHE = '1'
    process.env.AUTO_HANDOFF_FULL = '1'
    origSetTimeout = globalThis.setTimeout
    // Only the handoff retry timer is captured; everything else keeps its real delay.
    ;(globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === 3 * 60_000 ? (timers.push({ fn, ms }), 0) : origSetTimeout(fn, ms, ...rest)
  })
  afterEach(() => {
    globalThis.setTimeout = origSetTimeout
    ;(transport as any).sendOrQueue = origSendOrQueue
    delete process.env.AUTO_HANDOFF_CACHE
    delete process.env.AUTO_HANDOFF_FULL
    delete process.env.AUTO_HANDOFF_FULL_PCT
    delete process.env.AUTO_CONVERGE_PCT
    pendingPermissions.clear()
  })

  const MIN = 60_000
  const session = (o: { pct?: () => number; live?: string; engine?: 'claude' | 'codex'; lastActive?: number; type?: SessionInfo['sessionType']; bridge?: boolean } = {}) => {
    const info = seed({
      ageMs: OLD, lastActive: o.lastActive ?? NOW - 120 * MIN, engine: o.engine ?? 'claude', sessionType: o.type ?? 'thread_owner',
      adapter: fakeAdapter({
        usage: () => ({ usedTokens: 0, contextWindow: 0, percent: (o.pct ?? (() => 60))() }),
        turn: () => ({ activityAt: null, confirmedComplete: false, answer: () => null, live: o.live ?? 'idle' }),
      }),
    })
    if (o.bridge !== false) transport.bridges.set(info.sessionId, {} as any)
    return info
  }
  const LATER = NOW + 51 * MIN  // past the 50-minute idle line
  // The idle clock starts at the first poll that sees a session idle, so a first poll one minute in comes before the one under test.
  const pollAt = (t: number) => { pollSessionsOnce(NOW + MIN); pollSessionsOnce(t) }

  test('50%+ and untouched 50 min: asks once, tells the thread', () => {
    const info = session()
    pollAt(LATER)
    pollAt(LATER + MIN)
    expect(asked).toEqual([info.sessionId])
    expect(to(info, 'Asked')).toHaveLength(1)
  })

  test('below 50%: nothing; climbing back past it after a drop asks again', () => {
    let pct = 49
    const info = session({ pct: () => pct })
    pollAt(LATER)
    expect(asked).toEqual([])
    pct = 60; pollAt(LATER)
    pct = 40; pollAt(LATER)
    pct = 60; pollAt(LATER)
    expect(asked).toEqual([info.sessionId, info.sessionId])
  })

  test('touched less than 50 min ago: nothing', () => {
    session({ lastActive: LATER - 49 * MIN })
    pollAt(LATER)
    expect(asked).toEqual([])
  })

  test('a session seen for the first time (a daemon restart) is not idle for 50 minutes yet, however stale its lastActive', () => {
    session({ lastActive: NOW - 600 * MIN })
    pollSessionsOnce(LATER)
    expect(asked).toEqual([])
  })

  test('working, waiting on a permission, or a Codex session: nothing', () => {
    session({ live: 'working' })
    const waiting = session()
    pendingPermissions.set('req1', { tool_name: 't', description: 'd', input_preview: 'p', sessionId: waiting.sessionId })
    session({ engine: 'codex' })
    pollAt(LATER)
    expect(asked).toEqual([])
  })

  test('a guest session, or one with no bridge: nothing', () => {
    session({ type: 'thread_guest' })
    session({ bridge: false })
    pollAt(LATER)
    expect(asked).toEqual([])
  })

  test('a failed request does not stop the pass for the other sessions', () => {
    ;(transport as any).sendOrQueue = () => { throw new Error('disk full') }
    session()
    const crashed = seed({ ageMs: OLD })
    pollAt(LATER)
    expect(to(crashed, '💀')).toHaveLength(1)
    expect(stderr.join('')).toContain('auto-handoff failed')
  })

  test('both are off until their flag is 1: unset or 0 asks nothing', () => {
    session({ pct: () => 90 })
    delete process.env.AUTO_HANDOFF_CACHE
    delete process.env.AUTO_HANDOFF_FULL
    pollAt(LATER)
    process.env.AUTO_HANDOFF_CACHE = '0'
    process.env.AUTO_HANDOFF_FULL = '0'
    pollAt(LATER + MIN)
    expect(asked).toEqual([])
  })

  test('AUTO_HANDOFF_CACHE=1 alone turns on only the cache handoff', () => {
    delete process.env.AUTO_HANDOFF_FULL
    session({ pct: () => 95, lastActive: LATER - MIN })  // full-context only: needs the other flag
    const stale = session({ pct: () => 60 })
    pollAt(LATER)
    expect(asked).toEqual([stale.sessionId])
  })

  test('85%+ and idle: asks even when touched a minute ago, on any engine', () => {
    const claude = session({ pct: () => 85, lastActive: LATER - MIN })
    const codex = session({ pct: () => 90, lastActive: LATER - MIN, engine: 'codex' })
    pollAt(LATER)
    pollAt(LATER + MIN)
    expect(asked.sort()).toEqual([claude.sessionId, codex.sessionId].sort())
  })

  test('84%, or working, or a guest: the full handoff leaves it alone', () => {
    session({ pct: () => 84, lastActive: LATER - MIN })
    session({ pct: () => 95, live: 'working', lastActive: LATER - MIN })
    session({ pct: () => 95, type: 'thread_guest', lastActive: LATER - MIN })
    pollAt(LATER)
    expect(asked).toEqual([])
  })

  test('a session due for both is asked once, and a drop below 85% re-arms the full handoff', () => {
    let pct = 90
    const info = session({ pct: () => pct })
    pollAt(LATER)
    pollAt(LATER + MIN)
    expect(asked).toEqual([info.sessionId])
    pct = 60; pollAt(LATER)  // re-arms the full one; the cache one stays asked while above 50%
    pct = 90; pollAt(LATER)
    expect(asked).toEqual([info.sessionId, info.sessionId])
  })

  test('AUTO_HANDOFF_FULL=1 alone turns on only the full handoff', () => {
    delete process.env.AUTO_HANDOFF_CACHE
    const fresh = session({ pct: () => 95, lastActive: LATER - MIN })
    session({ pct: () => 60 })  // cache-only case: needs the other flag
    pollAt(LATER)
    expect(asked).toEqual([fresh.sessionId])
  })

  test('still the same session and no letter after 3 minutes: asks once more, and not a third time', () => {
    const info = session()
    pollAt(LATER)
    expect(timers).toHaveLength(1)
    timers[0].fn()
    expect(asked).toEqual([info.sessionId, info.sessionId])
    expect(timers).toHaveLength(1)  // the retry sets no timer of its own
  })

  test('no retry when the session wrote its letter, or is already gone', () => {
    const wrote = session()
    pollAt(LATER)
    const letter = requests[0].match(/path="([^"]+)"/)![1]
    writeFileSync(letter, '# Goal\nx')
    const gone = session()
    pollAt(LATER + MIN)
    registry.delete(gone.sessionId)
    for (const t of timers) t.fn()
    rmSync(letter, { force: true })
    expect(asked).toEqual([wrote.sessionId, gone.sessionId])
  })

  test('a manual handoff after the automatic ask keeps its model and note: no retry', async () => {
    const info = session()
    pollAt(LATER)
    await Bun.sleep(2)  // the letter path carries the millisecond
    requestHandoff(info, { channelId: info.threadId, threadId: info.threadId, requester: 'sam', options: { selection: { model: 'claude-opus-5-5', engine: 'claude' }, note: 'keep X' } })
    timers[0].fn()
    expect(asked).toHaveLength(2)
    expect(info.handoffSelection?.model).toBe('claude-opus-5-5')
    expect(info.handoffNote?.text).toBe('keep X')
  })

  test('an automatic ask leaves the model choice and note of a pending manual handoff alone', () => {
    const info = session()
    requestHandoff(info, { channelId: info.threadId, threadId: info.threadId, requester: 'sam', options: { selection: { model: 'claude-opus-5-5', engine: 'claude' }, note: 'keep X' } })
    pollAt(LATER)
    expect(asked).toHaveLength(2)
    expect(info.handoffSelection?.model).toBe('claude-opus-5-5')
    expect(info.handoffNote?.text).toBe('keep X')
  })

  test('the retry waits for the session to be idle: one that is busy again at 3 minutes is not asked a third time', () => {
    let live = 'idle'
    const info = seed({
      ageMs: OLD, lastActive: NOW - 120 * MIN, engine: 'claude',
      adapter: fakeAdapter({
        usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 60 }),
        turn: () => ({ activityAt: null, confirmedComplete: false, answer: () => null, live }),
      }),
    })
    transport.bridges.set(info.sessionId, {} as any)
    pollAt(LATER)
    live = 'working'
    timers[0].fn()
    expect(asked).toEqual([info.sessionId])
  })

  test('the request an automatic ask sends does not claim anyone typed it', () => {
    session()
    pollAt(LATER)
    expect(requests[0]).toStartWith('[system] hydra is handing this thread off')
    expect(requests[0]).toContain('Open questions for the user;')
  })

  test('the retry skips a session that was messaged or called a tool after the ask', () => {
    const info = session()
    pollAt(LATER)
    info.lastActive = Date.now() + 1000
    timers[0].fn()
    expect(asked).toEqual([info.sessionId])
  })

  test('a session that only ran native tools is idle from the first poll that saw it idle, not from its last hydra activity', () => {
    const info = session()  // lastActive two hours before NOW
    pollSessionsOnce(NOW + 60 * MIN)
    pollSessionsOnce(NOW + 100 * MIN)
    expect(asked).toEqual([])
    pollSessionsOnce(NOW + 112 * MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('a poll that sees the session working restarts that clock', () => {
    let live = 'idle'
    const info = seed({
      ageMs: OLD, lastActive: NOW - 120 * MIN, engine: 'claude',
      adapter: fakeAdapter({
        usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 60 }),
        turn: () => ({ activityAt: null, confirmedComplete: false, answer: () => null, live }),
      }),
    })
    transport.bridges.set(info.sessionId, {} as any)
    pollSessionsOnce(NOW + 60 * MIN)
    live = 'working'; pollSessionsOnce(NOW + 90 * MIN)
    live = 'idle'; pollSessionsOnce(NOW + 120 * MIN)
    pollSessionsOnce(NOW + 160 * MIN)
    expect(asked).toEqual([])
    pollSessionsOnce(NOW + 175 * MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('dropping below 50% resets the idle clock: the climb back starts a fresh one', () => {
    let pct = 60
    const info = session({ pct: () => pct })
    pollSessionsOnce(NOW + 60 * MIN)       // idle clock starts here
    pct = 40; pollSessionsOnce(NOW + 70 * MIN)
    pct = 60; pollSessionsOnce(NOW + 100 * MIN)  // fresh clock; the old one would make this 40 minutes
    pollSessionsOnce(NOW + 140 * MIN)
    expect(asked).toEqual([])
    pollSessionsOnce(NOW + 151 * MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('a request that threw before it went out is tried again on the next poll', () => {
    const info = session()
    let fail = true
    ;(transport as any).sendOrQueue = (sid: string) => { if (fail) throw new Error('disk full'); asked.push(sid) }
    pollAt(LATER)
    fail = false
    pollSessionsOnce(LATER + 5 * MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('a full-context request that threw before it went out is tried again on the next poll', () => {
    const info = session({ pct: () => 90, lastActive: LATER - MIN })
    let fail = true
    ;(transport as any).sendOrQueue = (sid: string) => { if (fail) throw new Error('disk full'); asked.push(sid) }
    pollAt(LATER)
    fail = false
    pollSessionsOnce(LATER + 5 * MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('the cache request also answers the full-context case: one ask when both become due together', () => {
    const info = session({ pct: () => 90 })
    pendingPermissions.set('req1', { tool_name: 't', description: 'd', input_preview: 'p', sessionId: info.sessionId })
    pollAt(LATER)
    expect(asked).toEqual([])
    pendingPermissions.clear()
    pollSessionsOnce(LATER + MIN)
    expect(asked).toEqual([info.sessionId])
  })

  test('AUTO_HANDOFF_FULL_PCT moves the full-handoff line', () => {
    process.env.AUTO_HANDOFF_FULL_PCT = '70'
    delete process.env.AUTO_HANDOFF_CACHE
    const at70 = session({ pct: () => 70, lastActive: LATER - MIN })
    session({ pct: () => 69, lastActive: LATER - MIN })
    pollAt(LATER)
    expect(asked).toEqual([at70.sessionId])
  })

  test('an AUTO_HANDOFF_FULL_PCT that is not a whole number 1-99 keeps 85', () => {
    delete process.env.AUTO_HANDOFF_CACHE
    for (const bad of ['abc', '0', '100', '70.5', '0x46', '1e1', '+70', '']) {
      process.env.AUTO_HANDOFF_FULL_PCT = bad
      expect(envPercent('AUTO_HANDOFF_FULL_PCT', 85)).toBe(85)
    }
    process.env.AUTO_HANDOFF_FULL_PCT = ' 70 '
    expect(envPercent('AUTO_HANDOFF_FULL_PCT', 85)).toBe(70)
    process.env.AUTO_HANDOFF_FULL_PCT = 'abc'
    session({ pct: () => 80, lastActive: LATER - MIN })
    pollAt(LATER)
    expect(asked).toEqual([])
  })

  describe('converge nudge', () => {
    const nudges = () => requests.filter(r => r.includes('converg'))
    beforeEach(() => { delete process.env.AUTO_HANDOFF_CACHE; delete process.env.AUTO_HANDOFF_FULL })

    test('off unless AUTO_CONVERGE_PCT is set', () => {
      session({ pct: () => 60, lastActive: LATER - MIN })
      pollAt(LATER)
      expect(requests).toEqual([])
    })

    test('told once per climb, working or not; a drop below re-arms it', () => {
      process.env.AUTO_CONVERGE_PCT = '50'
      let pct = 55
      const info = session({ pct: () => pct, live: 'working', lastActive: LATER - MIN })
      pollAt(LATER)
      pollAt(LATER + MIN)
      expect(asked).toEqual([info.sessionId])
      expect(nudges()[0]).toContain('55% context')
      pct = 40; pollAt(LATER)
      pct = 52; pollAt(LATER)
      expect(asked).toEqual([info.sessionId, info.sessionId])
    })

    test('names the full-handoff line when that handoff is on', () => {
      process.env.AUTO_CONVERGE_PCT = '50'
      process.env.AUTO_HANDOFF_FULL = '1'
      process.env.AUTO_HANDOFF_FULL_PCT = '70'
      session({ pct: () => 55, lastActive: LATER - MIN })
      pollAt(LATER)
      expect(nudges()).toHaveLength(1)
      expect(nudges()[0]).toContain('At 70% hydra asks you to hand off')
    })

    test('not sent to a guest, a session with no bridge, or one already asked to hand off', () => {
      process.env.AUTO_CONVERGE_PCT = '50'
      process.env.AUTO_HANDOFF_FULL = '1'
      session({ pct: () => 60, type: 'thread_guest' })
      session({ pct: () => 60, bridge: false })
      const full = session({ pct: () => 90, lastActive: LATER - MIN })
      pollAt(LATER)
      expect(asked).toEqual([full.sessionId])
      expect(nudges()).toEqual([])
    })

    test('an old handoff ask by a feature that is now off, or by the other feature, does not block a later climb', () => {
      process.env.AUTO_CONVERGE_PCT = '50'
      process.env.AUTO_HANDOFF_FULL = '1'   // cache off: the full ask also marks the cache set, which nothing clears
      let pct = 90
      const info = session({ pct: () => pct, lastActive: LATER - MIN })
      pollAt(LATER)
      expect(asked).toEqual([info.sessionId])
      expect(nudges()).toEqual([])
      pct = 40; pollAt(LATER + MIN)
      pct = 60; pollAt(LATER + 2 * MIN)
      expect(nudges()).toHaveLength(1)
    })

    test('a converge line at or above the full line: the text says the handoff comes when idle, not at a passed line', () => {
      process.env.AUTO_CONVERGE_PCT = '90'
      process.env.AUTO_HANDOFF_FULL = '1'
      session({ pct: () => 92, live: 'working', lastActive: LATER - MIN })  // working: the full ask waits
      pollAt(LATER)
      expect(nudges()).toHaveLength(1)
      expect(nudges()[0]).toContain('the next time you are idle')
      expect(nudges()[0]).not.toContain('At 85%')
    })

    test('a local converge.md replaces the text, with {{pct}} and {{full}} filled', () => {
      process.env.AUTO_CONVERGE_PCT = '50'
      mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
      const file = join(HANDOFF_TEMPLATE_DIR, 'converge.md')
      writeFileSync(file, 'Local: converge now at {{pct}}% (full line: "{{full}}")')
      try {
        session({ pct: () => 61, lastActive: LATER - MIN })
        pollAt(LATER)
        expect(nudges()).toEqual(['Local: converge now at 61% (full line: "")'])
      } finally { rmSync(file) }
    })
  })
})
