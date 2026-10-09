// Pins one session-health pass (pollSessionsOnce): crash detection, orphan
// alert (+ Claude id discovery, C4) and the context alert. Real tmux checks
// and discovery run against a PATH-shim tmux (see fake-tmux.ts).
//
// The alert sets are module-level and keyed by sessionId, so every case uses
// fresh ids. Only messages to this file's threads are asserted — the registry
// is a process-wide singleton.

import { engines } from '../engines/instances.js'
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { pollSessionsOnce } from '../session-health.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import { ORPHAN_GRACE_MS } from '../session-reachability.js'
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
    expect(to(hot, 'context')[0].text).toBe(`**${hot.tmuxName}** is at **70%** context. Consider a \`handoff\` to a fresh session (\`handoff - <note>\` passes a note to it).`)
    expect(to(cool, 'context')).toHaveLength(0)
  })

  test('50% then 70% each fire once; a jump past both fires once', () => {
    let pct = 50
    const climbing = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: pct }) }) })
    const jumping = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 85 }) }) })

    pollSessionsOnce(NOW)
    pollSessionsOnce(NOW + 1000)
    expect(to(climbing, 'context')).toHaveLength(1)
    expect(to(climbing, 'context')[0].text).toBe(`**${climbing.tmuxName}** is at **50%** context. Consider a \`handoff\` to a fresh session (\`handoff - <note>\` passes a note to it).`)
    pct = 70
    pollSessionsOnce(NOW + 2000)
    pollSessionsOnce(NOW + 3000)
    expect(to(climbing, 'context')).toHaveLength(2)
    expect(to(jumping, 'context')).toHaveLength(1)
  })

  test('unknown usage ("?") never alerts', () => {
    const info = seed({ ageMs: 1000, adapter: fakeAdapter({ usage: () => null }) })
    pollSessionsOnce(NOW)
    expect(to(info, 'context')).toHaveLength(0)
  })
})
