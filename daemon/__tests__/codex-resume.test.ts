// `resume` for Codex (B8 / R16): tier 1 must resume the ORIGINAL Codex thread in
// its ORIGINAL CODEX_HOME via `connectAndResume` — never start a fresh thread and
// then announce "full context restored". Two layers:
//   1. the adapter's launch, with a fake engine + fake process helpers;
//   2. handleResumeIntercept end to end, with fake engine adapters, pinning the
//      Codex and Claude cascades.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { codexSocketPath } from '../codex-engine.js'
import { codexHomeDir } from '../codex-process.js'
import { engines } from '../engines/instances.js'
import { handleResumeIntercept } from '../commands/thread.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../config.js'
import { transport } from '../bridge-transport.js'
import type { LaunchInput } from '../engines/engine-adapter.js'
import type { InboundMessage } from '../../gateway.js'
import * as childProcess from 'child_process'

// cli/__tests__/peek.test.ts mock.module()s child_process for the whole process
// with an execFileSync that never throws — so, in a full run, every
// `tmux has-session` "succeeds" and doSpawnSession refuses the thread as live.
// When that leaked mock is present, make tmux calls fail (no such session) for
// this file, then put peek's default back.
const leakedExecFileSync = (childProcess.execFileSync as any).mock ? childProcess.execFileSync as any : null

// ---------------------------------------------------------------------------
// 1. Adapter launch
// ---------------------------------------------------------------------------

function fakeEngine() {
  const calls: string[] = []
  const engine = {
    calls,
    queueTurn: (sid: string, text: string) => { calls.push(`queue ${sid} ${text}`); return true },
    connect: async (sid: string, sock: string) => { calls.push(`connect ${sid} ${sock}`); return { threadId: 'fresh-thread', model: 'm' } },
    connectAndResume: async (sid: string, sock: string, tid: string) => { calls.push(`resume ${sid} ${sock} ${tid}`); return { model: 'm' } },
    connectAndFork: async (sid: string, sock: string, tid: string) => { calls.push(`fork ${sid} ${sock} ${tid}`); return { threadId: 'forked', model: 'm' } },
    disconnect: () => {},
  }
  return engine
}

function fakeProc() {
  const calls: string[] = []
  return {
    calls,
    registerMcp: (homeDir: string, sid: string) => { calls.push(`mcp ${homeDir} ${sid}`) },
    start: (o: { homeName: string }) => { calls.push(`start ${o.homeName}`); return 1 },
    stop: (home: string) => { calls.push(`stop ${home}`); return true },
  }
}

const baseInput = { sessionId: 'new-sid', tmuxName: 'newname', cwd: '/tmp', originalCwd: '/tmp', model: 'gpt', prompt: 'P0' }

describe('CodexEngineAdapter.launch', () => {
  test('resumeCodex: resumes the original thread in the original home', async () => {
    const engine = fakeEngine(), proc = fakeProc()
    const adapter = new CodexEngineAdapter(engine as any, proc as any)
    const r = await adapter.launch({ ...baseInput, resumeCodex: { threadId: 'T-orig', homeName: 'oldhome' } })

    expect(engine.calls).toEqual([
      'queue new-sid P0', // #374: launch prompt is FIFO item zero, queued before the thread is attached
      `resume new-sid ${codexSocketPath('oldhome')} T-orig`,
    ])
    // MCP re-registered for the NEW session id in the OLD home, then the app-server
    // (re)started there so the sidecar carries the new id.
    expect(proc.calls).toEqual([`mcp ${codexHomeDir('oldhome')} new-sid`, 'start oldhome'])
    expect(r.identity.codexThreadId).toBe('T-orig')
    expect(r.identity.codexHomeName).toBe('oldhome')
  })

  test('resumeCodex: the launch-time surface attaches the TUI to the original home', async () => {
    const engine = fakeEngine(), proc = fakeProc()
    const adapter = new CodexEngineAdapter(engine as any, proc as any) as any
    const seen: any[] = []
    adapter.surface = (info: any) => { seen.push({ home: info.codexHomeName ?? info.tmuxName, thread: info.codexThreadId }); return `${info.tmuxName}:hydra-chat` }
    await adapter.launch({ ...baseInput, resumeCodex: { threadId: 'T-orig', homeName: 'oldhome' } })
    expect(seen).toEqual([{ home: 'oldhome', thread: 'T-orig' }])
  })

  test('plain spawn still starts a fresh thread in its own home', async () => {
    const engine = fakeEngine(), proc = fakeProc()
    const adapter = new CodexEngineAdapter(engine as any, proc as any)
    const r = await adapter.launch(baseInput)

    expect(engine.calls).toEqual(['queue new-sid P0', `connect new-sid ${codexSocketPath('newname')}`])
    expect(proc.calls).toEqual([`mcp ${codexHomeDir('newname')} new-sid`, 'start newname'])
    expect(r.identity.codexThreadId).toBe('fresh-thread')
    expect('codexHomeName' in r.identity).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. handleResumeIntercept
// ---------------------------------------------------------------------------

const THREAD = 'thread-r16'
const PARENT = 'parent-r16'
let seq = 0
const seeded = new Set<string>()
let sent: string[] = []
let launches: Array<{ provider: string; input: LaunchInput }> = []
let stops: Array<{ tmuxName: string; home?: string }> = []
let homeStops: string[] = []            // app-server homes the REAL CodexEngineAdapter.stop tore down
let pickedDuringLaunch: string | undefined
const stopProc = { ...fakeProc(), stop: (home: string) => { homeStops.push(home); return true } }
const realStopAdapter = new CodexEngineAdapter(fakeEngine() as any, stopProc as any)
let failCodexResume = false
let failClaudeResume = false
let claudeLearnsNoId = false
const connected = new Set<string>()

const orig: Record<string, any> = {}

function fakeAdapter(provider: 'claude' | 'codex') {
  return {
    provider,
    launch: async (input: LaunchInput) => {
      launches.push({ provider, input })
      // Inside the kill→launch→persist window: the dead record is gone, the new one not yet set.
      pickedDuringLaunch = registry.pickSessionName()
      if (provider === 'codex' && input.resumeCodex && failCodexResume) throw new Error('no rollout found for thread id (code -32600)')
      if (provider === 'claude' && input.resumeFrom && failClaudeResume) throw new Error('resume failed')
      connected.add(input.sessionId)
      if (provider === 'codex') {
        return {
          provider, model: 'gpt',
          identity: {
            codexThreadId: input.resumeCodex?.threadId ?? (input.forkFrom?.codexThreadId ? 'forked-thread' : 'fresh-thread'),
            ...(input.resumeCodex ? { codexHomeName: input.resumeCodex.homeName } : {}),
          },
        }
      }
      return { provider, model: 'claude-x', identity: claudeLearnsNoId ? {} : { claudeSessionId: input.resumeFrom ?? 'new-claude' } }
    },
    stop: async (info: SessionInfo) => {
      stops.push({ tmuxName: info.tmuxName, home: info.codexHomeName })
      return provider === 'codex' ? realStopAdapter.stop(info) : { status: 'stopped' }
    },
    isAlive: async () => false,
    surface: () => null,
    recoveryPlan: (s: any, o: any) => orig[provider].recoveryPlan(s, o),
  }
}

beforeAll(() => {
  orig.codex = engines.codex
  orig.claude = engines.claude
  orig.send = gateway.send
  orig.react = gateway.react
  orig.edit = gateway.edit
  orig.fetchChannel = gateway.fetchChannel
  orig.getThreadUrl = gateway.getThreadUrl
  orig.has = transport.has
  orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist
  orig.tpersist = threadRegistry.persist
  orig.spawnCwd = process.env.SPAWN_CWD
  engines.codex = fakeAdapter('codex') as any
  engines.claude = fakeAdapter('claude') as any
  ;(gateway as any).send = async (c: string, text: string) => { sent.push(text); return { id: `m${sent.length}`, channelId: c } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  ;(gateway as any).fetchChannel = async () => ({ isThread: true, isDM: false, parentId: PARENT })
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  ;(transport as any).has = (id: string) => connected.has(id)
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = process.cwd()
  leakedExecFileSync?.mockImplementation((cmd: string) => { if (cmd === 'tmux') throw new Error('no tmux session'); return '' })
})

afterAll(() => {
  engines.codex = orig.codex
  engines.claude = orig.claude
  ;(gateway as any).send = orig.send
  ;(gateway as any).react = orig.react
  ;(gateway as any).edit = orig.edit
  ;(gateway as any).fetchChannel = orig.fetchChannel
  ;(gateway as any).getThreadUrl = orig.getThreadUrl
  ;(transport as any).has = orig.has
  ;(transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist
  ;(threadRegistry as any).persist = orig.tpersist
  if (orig.spawnCwd === undefined) delete process.env.SPAWN_CWD
  else process.env.SPAWN_CWD = orig.spawnCwd
  leakedExecFileSync?.mockImplementation(() => '')
})

let origStderr: typeof process.stderr.write
beforeEach(() => {
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  sent = []; launches = []; stops = []; homeStops = []; pickedDuringLaunch = undefined
  failCodexResume = false; failClaudeResume = false; claudeLearnsNoId = false
})

afterEach(() => {
  for (const s of [...registry.values()]) if (s.threadId === THREAD || seeded.has(s.sessionId)) registry.delete(s.sessionId)
  seeded.clear()
  registry.deleteThread(THREAD)
  threadRegistry.threads.delete(THREAD)
  process.stderr.write = origStderr
})

function msg(): InboundMessage {
  return {
    id: `msg-r16-${seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op',
    content: 'resume', isDM: false, isThread: true, isBot: false,
    parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
    referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
  }
}

/** A dead record owning THREAD, plus its history entry. Names never exist in tmux. */
function seedDead(engine: 'claude' | 'codex', extra: Partial<SessionInfo> = {}): SessionInfo {
  const n = ++seq
  const info: SessionInfo = {
    sessionId: `sess-r16-${n}`, topic: 'topic', threadId: THREAD, createdAt: Date.now() - 1e6, lastActive: Date.now(),
    tmuxName: `r16dead${n}`, listening: false, engine, sessionType: 'thread_owner', anchorChannelId: PARENT,
    deadAt: Date.now(), adapter: engines[engine],
    ...(engine === 'codex' ? { codexThreadId: `T-${n}` } : { claudeSessionId: `C-${n}` }),
    ...extra,
  } as SessionInfo
  registry.set(info.sessionId, info)
  registry.setThread(THREAD, info.sessionId)
  seeded.add(info.sessionId)
  threadRegistry.recordSpawn(THREAD, { topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName, originType: 'spawn', model: 'm', claudeSessionId: info.claudeSessionId } as any)
  return info
}

const announced = () => sent.find(s => s.includes('resumed') || s.includes('respawned')) ?? ''

describe('handleResumeIntercept — Codex', () => {
  test('tier 1 resumes the original thread in the original home and says so', async () => {
    const dead = seedDead('codex', { codexHomeName: 'r16home' })
    await handleResumeIntercept(msg())

    expect(launches).toHaveLength(1)
    expect(launches[0].input.resumeCodex).toEqual({ threadId: dead.codexThreadId!, homeName: 'r16home' })
    const live = registry.get(registry.getByThread(THREAD)!)!
    expect(live.codexThreadId).toBe(dead.codexThreadId!)
    expect(live.codexHomeName).toBe('r16home') // stop/isAlive/reconnect/resume keep targeting the adopted home
    expect(announced()).toContain('resumed — full context restored')
    expect(registry.reservedNames.has('r16home')).toBe(false) // reservation released
  })

  test('two concurrent resumes of the same thread launch once; the second is told one is in progress', async () => {
    seedDead('codex', { codexHomeName: 'r16race' })
    await Promise.all([handleResumeIntercept(msg()), handleResumeIntercept(msg())])
    expect(launches).toHaveLength(1)
    expect(sent.some(s => s.includes('already in progress'))).toBe(true)
    expect(registry.reservedNames.has('r16race')).toBe(false)
  })

  test('home defaults to the dead tmuxName when no codexHomeName was recorded', async () => {
    const dead = seedDead('codex')
    await handleResumeIntercept(msg())
    expect(launches[0].input.resumeCodex).toEqual({ threadId: dead.codexThreadId!, homeName: dead.tmuxName })
  })

  test('tier 1 failure falls to fork (tier 2) and never claims full context', async () => {
    failCodexResume = true
    const dead = seedDead('codex', { codexHomeName: 'r16home' })
    await handleResumeIntercept(msg())

    expect(launches.map(l => l.input.resumeCodex ? 'resume' : l.input.forkFrom ? 'fork' : 'fresh')).toEqual(['resume', 'fork'])
    expect(launches[1].input.forkFrom?.codexThreadId).toBe(dead.codexThreadId!)
    expect(announced()).toContain('forked from dead session')
    expect(announced()).not.toContain('full context restored')
    expect(registry.reservedNames.has('r16home')).toBe(false)
  })

  test('refuses to resume into a home another session owns', async () => {
    const other = { sessionId: 'sess-r16-other', topic: 't', threadId: 'other-thread', createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: 'r16owner', listening: false, engine: 'codex', adapter: engines.codex, sessionType: 'thread_owner', codexThreadId: 'T-other' } as SessionInfo
    registry.set(other.sessionId, other)
    seeded.add(other.sessionId)
    seedDead('codex', { codexHomeName: 'r16owner' })

    await handleResumeIntercept(msg())

    // The owner-guard throws before launch, so tier 1 never reaches the adapter.
    expect(launches.some(l => l.input.resumeCodex)).toBe(false)
    // Tier 2 still kills the dead record (whose home names r16owner): its stop
    // must not tear down the app-server the live owner holds.
    expect(stops.map(s => s.home ?? s.tmuxName)).toContain('r16owner')
    expect(homeStops).not.toContain('r16owner')
    expect(announced()).not.toContain('full context restored')
  })

  test('the home stays reserved across the kill→persist window', async () => {
    const next = registry.pickSessionName() // the name a concurrent spawn would take
    seedDead('codex', { codexHomeName: next })
    await handleResumeIntercept(msg())
    expect(launches[0].input.resumeCodex?.homeName).toBe(next)
    expect(pickedDuringLaunch).toBeDefined()
    expect(pickedDuringLaunch).not.toBe(next)
  })

  test('killing a record whose home nobody else claims still stops its app-server', async () => {
    const dead = seedDead('codex', { codexHomeName: 'r16solo' })
    await realStopAdapter.stop(dead)
    expect(homeStops).toEqual(['r16solo'])
  })

  test('a DEAD record naming the same home does not block stopping the live owner', async () => {
    seedDead('codex', { codexHomeName: 'r16shared' })                       // lingering dead record
    const live = seedDead('codex', { codexHomeName: 'r16shared' })
    delete live.deadAt
    await realStopAdapter.stop(live)
    expect(homeStops).toEqual(['r16shared'])
  })

  test('a resumed session reserves its adopted home against new spawns', () => {
    const next = registry.pickSessionName()
    seedDead('codex', { codexHomeName: next, deadAt: undefined })
    expect(registry.pickSessionName()).not.toBe(next)
  })
})

describe('handleResumeIntercept — Claude (pinned, unchanged)', () => {
  test('tier 1 resumes with --resume <claudeSessionId>', async () => {
    const dead = seedDead('claude')
    await handleResumeIntercept(msg())

    expect(launches).toHaveLength(1)
    expect(launches[0].provider).toBe('claude')
    expect(launches[0].input.resumeFrom).toBe(dead.claudeSessionId!)
    expect(launches[0].input.resumeCodex).toBeUndefined()
    expect(announced()).toContain('resumed — full context restored')
  })

  // The spawn record spreads identity and recordSpawn takes identity.claudeSessionId:
  // an assigned id lands on both; an unlearned one is absent from both (as persisted).
  for (const learns of [true, false]) {
    test(`spawn record and history entry ${learns ? 'carry' : 'omit'} claudeSessionId`, async () => {
      claudeLearnsNoId = !learns
      const dead = seedDead('claude')
      await handleResumeIntercept(msg())
      const liveId = registry.getByThread(THREAD)!
      expect(liveId).not.toBe(dead.sessionId)
      const live = registry.get(liveId)!
      const entry = JSON.parse(JSON.stringify(threadRegistry.get(THREAD)!.sessionHistory.find(e => e.sessionId === liveId)))
      if (learns) {
        expect(live.claudeSessionId).toBe(dead.claudeSessionId!)
        expect(entry.claudeSessionId).toBe(dead.claudeSessionId!)
      } else {
        expect('claudeSessionId' in live).toBe(false)
        expect('claudeSessionId' in entry).toBe(false)
      }
    })
  }

  test('tier 1 failure falls to fork-from-dead', async () => {
    failClaudeResume = true
    const dead = seedDead('claude')
    await handleResumeIntercept(msg())

    expect(launches.map(l => l.input.resumeFrom ? 'resume' : l.input.forkFrom ? 'fork' : 'fresh')).toEqual(['resume', 'fork'])
    expect(launches[1].input.forkFrom?.claudeSessionId).toBe(dead.claudeSessionId!)
    expect(announced()).toContain('forked from dead session')
  })
})

// ---------------------------------------------------------------------------
// 3. Stale reconnect must not land on a successor's home (invariant 10)
// ---------------------------------------------------------------------------

describe('stale Codex reconnect', () => {
  function seedLive(id: string, home: string): SessionInfo {
    const info = { sessionId: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: `r16-${id}`, codexHomeName: home, listening: false, engine: 'codex', sessionType: 'thread_owner',
      codexThreadId: `T-${id}`, deadAt: 1 } as SessionInfo
    registry.set(id, info)
    seeded.add(id)
    return info
  }

  test('adapter.reconnect: record replaced during the failed-resume backoff → no connect on the new owner\'s socket', async () => {
    const engine = { ...fakeEngine(), isSocketLive: async () => true, disconnected: 0 } as any
    engine.disconnect = () => { engine.disconnected++ }
    const A = seedLive('r16-A', 'r16shared')
    engine.connectAndResume = async () => {
      // B adopts the home while A is mid-reconnect; A's record is gone.
      registry.delete(A.sessionId)
      seedLive('r16-B', 'r16shared')
      throw new Error('thread not loaded')
    }
    const adapter = new CodexEngineAdapter(engine, fakeProc() as any)

    expect(await adapter.reconnect(A)).toBe(false)
    expect(engine.calls.filter((c: string) => c.startsWith('connect '))).toEqual([])
    expect(A.codexThreadId).toBe('T-r16-A')
  })

  test('adapter.reconnect: record replaced while probing the socket → nothing attempted', async () => {
    const A = seedLive('r16-C', 'r16shared2')
    const engine = { ...fakeEngine(), isSocketLive: async () => { registry.delete(A.sessionId); return true } } as any
    const adapter = new CodexEngineAdapter(engine, fakeProc() as any)
    expect(await adapter.reconnect(A)).toBe(false)
    expect(engine.calls).toEqual([])
  })

  test('reconnectCodexAfterDisconnect: replaced record is not revived or given a surface', async () => {
    const { reconnectCodexAfterDisconnect } = await import('../engines/codex-runtime.js')
    let current: any
    let ensured = 0, persisted = 0, failed = 0
    const A: any = { sessionId: 'sid', engine: 'codex', tmuxName: 'r16a', codexThreadId: 'T', deadAt: 1,
      adapter: { reconnect: async () => { current = { ...A, deadAt: 2 }; return true }, surface: () => { ensured++; return 'r16a:hydra-chat' } } }
    current = A
    const ok = await reconnectCodexAfterDisconnect('sid', {
      get: () => current, wait: async () => {}, persist: () => { persisted++ }, failed: () => { failed++; return true },
    })
    expect(ok).toBe(false)
    expect(A.deadAt).toBe(1)
    expect(ensured).toBe(0)
    expect(persisted).toBe(0)
  })
})
