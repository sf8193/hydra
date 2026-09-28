// The ownership gates decide liveness with util.executionAlive, not raw tmux: for Codex
// the engine socket (or a reconnect in progress) is the truth, and a `hydra-anchor` tmux
// window that outlives a dead app-server must not count. Each gate gets two cases:
//   (a) Codex dead:  engine disconnected, anchor tmux alive → NOT live
//   (b) Codex live:  engine connected, tmux gone            → live
// Put `tmuxHasSession(x.tmuxName)` back at any gate and one of these fails.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { registry } from '../sessions.js'
import { gateway } from '../config.js'
import { handleSpawnIntercept } from '../commands/global.js'
import { doSpawnSession } from '../session-lifecycle.js'
import { dedupForRecovery } from '../recovery.js'
import { restoreWatches, getWatchesBySession, unwatchBySession, type WatchEntry } from '../pr-watch.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const codex = (connected: boolean) => {
  const a = new CodexEngineAdapter({ isConnected: () => connected } as any) as any
  a.stop = async () => ({})  // killSession of a replaced record must not touch a real app-server
  return a
}

let fake: FakeTmux
let n = 0
const ids: string[] = []
const threads: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeEach(() => { fake = withFakeTmux() })
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  for (const id of ids.splice(0)) registry.delete(id)
  for (const t of threads.splice(0)) registry.deleteThread(t)
  fake.restore()
})

// A registered record. `adapter` undefined → no adapter (tmux decides, the Claude path).
function rec(adapter: any, extra: Record<string, unknown> = {}): any {
  const sessionId = `lg-${++n}-${Date.now()}`
  const info = {
    sessionId, tmuxName: `lg_${n}_${Date.now()}`, threadId: `lg-thread-${n}-${Date.now()}`,
    topic: '', createdAt: 0, lastActive: 0, sessionType: 'thread_owner', ephemeral: true,
    ...(adapter && { adapter, engine: adapter.provider }), ...extra,
  }
  registry.set(sessionId, info as any); ids.push(sessionId)
  registry.setThread(info.threadId, sessionId); threads.push(info.threadId)
  return info
}
const codexDead = (extra?: Record<string, unknown>) => { const r = rec(codex(false), extra); fake.alive(r.tmuxName); return r }
const codexLive = (extra?: Record<string, unknown>) => rec(codex(true), extra)

// ---------------------------------------------------------------------------
// 1. global.ts resolveSpawnTarget (via handleSpawnIntercept)
// ---------------------------------------------------------------------------

describe('gate 1: spawn in a thread with an existing session', () => {
  let sent: string[]
  let savedCwd: string | undefined
  beforeEach(() => {
    sent = []
    // SPAWN_CWD unset → doSpawnSession throws before launching anything.
    savedCwd = process.env.SPAWN_CWD; delete process.env.SPAWN_CWD
    spies.push(
      spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }) as any),
      spyOn(gateway, 'react').mockImplementation((async () => {}) as any),
      spyOn(gateway, 'fetchChannel').mockImplementation((async () => { throw new Error('offline') }) as any),
      spyOn(gateway, 'createThread').mockImplementation((async () => ({ id: `lg-new-${++n}` })) as any),
    )
  })
  afterEach(() => { if (savedCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = savedCwd })

  const spawnIn = (threadId: string) => handleSpawnIntercept(
    { id: 'msg-1', channelId: 'lg-chan', effectiveThreadId: threadId, isThread: true, authorUsername: 'u' } as any,
    'topic', {} as any)
  const redirected = () => sent.some(t => t.includes('Thread already has a live session'))

  test('(a) Codex dead with anchor tmux → not live, no redirect', async () => {
    await spawnIn(codexDead().threadId)
    expect(redirected()).toBe(false)
  })

  test('(b) Codex connected, no tmux → live, redirect to a new thread', async () => {
    await spawnIn(codexLive().threadId)
    expect(redirected()).toBe(true)
  })

  test('Claude: tmux decides', async () => {
    const r = rec(undefined); fake.alive(r.tmuxName)
    await spawnIn(r.threadId)
    expect(redirected()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. session-lifecycle.ts doSpawnSession "thread has a live session"
// ---------------------------------------------------------------------------

describe('gate 2: doSpawnSession into an occupied thread', () => {
  let savedCwd: string | undefined
  beforeEach(() => {
    savedCwd = process.env.SPAWN_CWD; delete process.env.SPAWN_CWD
    spies.push(
      spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'm' })) as any),
      spyOn(gateway, 'fetchChannel').mockImplementation((async () => { throw new Error('offline') }) as any),
    )
  })
  afterEach(() => { if (savedCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = savedCwd })

  test('(a) Codex dead with anchor tmux → replaced (gets past the gate to SPAWN_CWD)', async () => {
    const r = codexDead()
    await expect(doSpawnSession('t', undefined, undefined, { existingThreadId: r.threadId } as any))
      .rejects.toThrow('SPAWN_CWD')
    expect(registry.has(r.sessionId)).toBe(false)
  })

  test('(b) Codex connected, no tmux → refused as live', async () => {
    const r = codexLive()
    await expect(doSpawnSession('t', undefined, undefined, { existingThreadId: r.threadId } as any))
      .rejects.toThrow('thread has a live session')
    expect(registry.has(r.sessionId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2b. session-lifecycle.ts doSpawnSession channel-lookup "clean up dead session in
//     this thread" (no existingThreadId; fetchChannel resolves chatId to a thread)
// ---------------------------------------------------------------------------
// A dead record missed here is still killed by gate 2 a few lines later, so (a) pins
// WHICH gate replaced it: gate 2 inherits the record's anchor ids and skips the anchor
// backfill; after a gate-2b kill, gate 2 sees no record and the backfill fetch runs.

describe('gate 2b: doSpawnSession channel lookup onto an occupied thread', () => {
  let savedCwd: string | undefined
  let fetches: string[]
  beforeEach(() => {
    fetches = []
    savedCwd = process.env.SPAWN_CWD; delete process.env.SPAWN_CWD
    spies.push(
      spyOn(gateway, 'send').mockImplementation((async () => ({ id: 'm' })) as any),
      spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => {
        fetches.push(id)
        return { id, isThread: true, parentId: 'lg-parent' }
      }) as any),
    )
  })
  afterEach(() => { if (savedCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = savedCwd })

  test('(a) Codex dead with anchor tmux → replaced at the channel-lookup gate', async () => {
    const r = codexDead({ anchorMessageId: 'lg-anchor', anchorChannelId: 'lg-anchor-chan' })
    await expect(doSpawnSession('t', r.threadId)).rejects.toThrow('SPAWN_CWD')
    expect(registry.has(r.sessionId)).toBe(false)
    // [0] resolveSpawnChannel's lookup, [1] the anchor backfill (absent if gate 2 did the kill).
    expect(fetches).toEqual([r.threadId, r.threadId])
  })

  test('(b) Codex connected, no tmux → not killed (refused as live)', async () => {
    const r = codexLive()
    await expect(doSpawnSession('t', r.threadId)).rejects.toThrow('thread has a live session')
    expect(registry.has(r.sessionId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. recovery.ts dedupForRecovery liveKeys reservation
// ---------------------------------------------------------------------------

describe('gate 3: recovery dedupe reserves work keys only for live owners', () => {
  const pr = () => `https://github.com/testorg/testrepo/pull/${80000 + ++n}`

  test('(a) Codex dead with anchor tmux → does not reserve; the candidate recovers', async () => {
    const url = pr()
    codexDead({ artifacts: [url] })
    const cand = rec(undefined, { artifacts: [url] })
    const { unique, skipped } = await dedupForRecovery([cand])
    expect(unique.map(u => u.sessionId)).toEqual([cand.sessionId])
    expect(skipped).toEqual([])
  })

  test('(b) Codex connected, no tmux → reserves; the candidate is skipped', async () => {
    const url = pr()
    const owner = codexLive({ artifacts: [url] })
    const cand = rec(undefined, { artifacts: [url] })
    const { unique, skipped } = await dedupForRecovery([cand])
    expect(unique).toEqual([])
    expect(skipped[0].reason).toContain(`already live as ${owner.tmuxName}`)
  })
})

// ---------------------------------------------------------------------------
// 4. pr-watch.ts restoreWatches never steals from a live owner
// ---------------------------------------------------------------------------

describe('gate 4: restoreWatches', () => {
  const entry = (owner: any): WatchEntry => {
    const num = 90000 + ++n
    return {
      prUrl: `https://github.com/testorg/testrepo/pull/${num}`, owner: 'testorg', repo: 'testrepo', prNumber: num,
      sessionId: owner.sessionId, threadId: owner.threadId, createdAt: 0,
    } as WatchEntry
  }
  const cleanup = (...sids: string[]) => { for (const s of sids) unwatchBySession(s) }

  test('(a) Codex dead with anchor tmux → watch is transferred', () => {
    const owner = codexDead(), e = entry(owner)
    try {
      restoreWatches([e], owner.sessionId, owner.threadId)
      expect(restoreWatches([e], 'lg-new', 'lg-new-t')).toBe(1)
      expect(getWatchesBySession('lg-new').map(w => w.prUrl)).toEqual([e.prUrl])
    } finally { cleanup(owner.sessionId, 'lg-new') }
  })

  test('(b) Codex connected, no tmux → watch stays with the live owner', () => {
    const owner = codexLive(), e = entry(owner)
    try {
      restoreWatches([e], owner.sessionId, owner.threadId)
      expect(restoreWatches([e], 'lg-new', 'lg-new-t')).toBe(0)
      expect(getWatchesBySession(owner.sessionId).map(w => w.prUrl)).toEqual([e.prUrl])
    } finally { cleanup(owner.sessionId, 'lg-new') }
  })
})

// ---------------------------------------------------------------------------
// 5. dashboard.ts rows only for live sessions
// ---------------------------------------------------------------------------
// The dashboard publishes only when PLATFORM === 'slack', a module-load const, so it
// runs in a child bun with CHAT_PLATFORM=slack and its own state dir, sharing the fake
// tmux PATH. The child prints the tmuxNames that made it into the published blocks.

describe('gate 5: dashboard rows', () => {
  const root = resolve(import.meta.dir, '..', '..')
  function dashboardNames(recs: Array<{ tmuxName: string; kind: 'codex-up' | 'codex-down' | 'plain' }>): string[] {
    const state = mkdtempSync(join(tmpdir(), 'hydra-test-dash-'))
    try {
      writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: ['U1'], groups: {}, pending: {} }))
      const script = join(state, 'dash.ts')
      writeFileSync(script, `
        const { registry } = await import(${JSON.stringify(join(root, 'daemon/sessions.ts'))})
        const { gateway } = await import(${JSON.stringify(join(root, 'daemon/config.ts'))})
        const { CodexEngineAdapter } = await import(${JSON.stringify(join(root, 'daemon/engines/codex-engine-adapter.ts'))})
        const { refreshDashboardNow } = await import(${JSON.stringify(join(root, 'daemon/dashboard.ts'))})
        const recs = ${JSON.stringify(recs)}
        const names = recs.map(r => r.tmuxName)
        for (const [i, r] of recs.entries()) {
          const adapter = r.kind === 'plain' ? undefined : new CodexEngineAdapter({ isConnected: () => r.kind === 'codex-up' })
          registry.set('s' + i, { sessionId: 's' + i, tmuxName: r.tmuxName, threadId: 't' + i, topic: r.tmuxName, createdAt: Date.now(), lastActive: Date.now(), sessionType: 'thread_owner', ...(adapter && { adapter, engine: 'codex' }) })
        }
        gateway.publishHomeTab = async (_u, blocks) => {
          const text = JSON.stringify(blocks)
          console.log('NAMES=' + JSON.stringify(names.filter(x => text.includes(x))))
          process.exit(0)
        }
        refreshDashboardNow()
        setTimeout(() => { console.log('NO-PUBLISH'); process.exit(1) }, 5000)
      `)
      const env = { ...process.env, CHAT_PLATFORM: 'slack', SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x', HYDRA_STATE_DIR: state, CLAUDE_CONFIG_DIR: join(state, 'claude') } as Record<string, string>
      const r = Bun.spawnSync(['bun', script], { env, cwd: root })
      const out = r.stdout.toString()
      const m = out.match(/NAMES=(.*)/)
      if (!m) throw new Error(`dashboard child did not publish: ${out}\n${r.stderr.toString()}`)
      return JSON.parse(m[1])
    } finally { rmSync(state, { recursive: true, force: true }) }
  }

  test('(a) Codex dead with anchor tmux hidden; (b) Codex connected without tmux shown; plain record by tmux', () => {
    const t = Date.now()
    const dead = `lgdashdead${t}`, live = `lgdashlive${t}`, plainUp = `lgdashplainup${t}`, plainDown = `lgdashplaindown${t}`
    fake.alive(dead); fake.alive(plainUp)
    const names = dashboardNames([
      { tmuxName: dead, kind: 'codex-down' },
      { tmuxName: live, kind: 'codex-up' },
      { tmuxName: plainUp, kind: 'plain' },
      { tmuxName: plainDown, kind: 'plain' },
    ])
    expect(names.sort()).toEqual([live, plainUp].sort())
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 6. CodexEngineAdapter.surface never recreates tmux around a dead engine
// ---------------------------------------------------------------------------

describe('surface guard', () => {
  test('disconnected engine, no tmux, a codexThreadId → null, and no new-session', () => {
    const a = codex(false)
    const info = { sessionId: 'lg-surf', tmuxName: `lgsurf${Date.now()}`, codexThreadId: 'T' } as any
    expect(a.surface(info)).toBeNull()
    expect(fake.calls().some(c => c.startsWith('new-session'))).toBe(false)
  })
})
