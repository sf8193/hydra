// Pins the recovery commands in commands/thread.ts (B5, B7–B11, G3, G4, R9):
// the resume tier matrix (resume → fork-from-dead → respawn) for both engines,
// respawn's engine/model selection, and native fork vs continuation. Every
// executor is stubbed through recoveryDeps, so nothing is spawned.

import { engines, codexEngine } from '../engines/instances.js'
import { rmSync } from 'fs'
import { join } from 'path'
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { handleResumeIntercept, handleRespawnIntercept, handleForkIntercept, _setRecoveryDeps, _resetRecoveryDeps } from '../commands/thread.js'
import { RECOVERY_REVERIFY_GUARD } from '../session-lifecycle.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo, ThreadSessionEntry } from '../sessions.js'
import { gateway } from '../config.js'
import type { InboundMessage } from '../../gateway.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { pollSessionsOnce } from '../session-health.js'

const THREAD = 'thread-t8'
const PARENT = 'parent-t8'
const TOPIC = 'the topic'
const URL = 'https://x/thread-t8'

type Call = { fn: string; args: any[] }
let calls: Call[] = []
let sent: string[] = []
let stderr: string[] = []
let seq = 0
const seeded = new Set<string>()
const threads = new Set<string>()
const orig: Record<string, any> = {}

// Outcomes per executor. tryResume mirrors session-lifecycle.ts: no id → null.
let resumeOutcome: 'ok' | 'orphan' | 'null' = 'ok'
let spawnFails: Array<'resume' | 'fork'> = []
let respawnOk = true
let reservedDuringSpawn: boolean[] = []

function stubDeps() {
  _setRecoveryDeps({
    tryResume: async (dead: any) => {
      calls.push({ fn: 'tryResume', args: [dead] })
      if (!dead.claudeSessionId || resumeOutcome === 'null') return null
      return { name: 'resumed-name', sessionId: 's-new', bridgeOrphan: resumeOutcome === 'orphan' } as any
    },
    doSpawnSession: async (topic: string, chatId?: string, messageId?: string, opts?: any) => {
      calls.push({ fn: 'doSpawnSession', args: [topic, chatId, messageId, opts] })
      if (opts?.resumeCodex) reservedDuringSpawn.push(registry.reservedNames.has(opts.resumeCodex.homeName))
      const kind = opts?.resumeCodex ? 'resume' : opts?.forkFrom ? 'fork' : 'fresh'
      if ((spawnFails as string[]).includes(kind)) throw new Error(`${kind} failed`)
      return { name: `${kind}-name`, sessionId: 's-new' } as any
    },
    tryRespawn: async (...args: any[]) => {
      calls.push({ fn: 'tryRespawn', args })
      return respawnOk ? { name: 'respawn-name', sessionId: 's-new' } as any : null
    },
  })
}

beforeAll(() => {
  orig.send = gateway.send; orig.react = gateway.react; orig.edit = gateway.edit
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: `m${sent.length}` } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})

afterAll(() => {
  ;(gateway as any).send = orig.send
  ;(gateway as any).react = orig.react
  ;(gateway as any).edit = orig.edit
  ;(registry as any).persist = orig.persist
  ;(threadRegistry as any).persist = orig.tpersist
})

beforeEach(() => {
  calls = []; sent = []; stderr = []; reservedDuringSpawn = []
  resumeOutcome = 'ok'; spawnFails = []; respawnOk = true
  stubDeps()
  orig.stderr = process.stderr.write
  process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any
})

afterEach(() => {
  process.stderr.write = orig.stderr
  _resetRecoveryDeps()
  for (const id of seeded) registry.delete(id)
  for (const t of threads) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
  seeded.clear(); threads.clear()
})

function msg(content = 'resume', threadId = THREAD): InboundMessage {
  return {
    id: `msg-t8-${++seq}`, channelId: threadId, authorId: 'u1', authorUsername: 'op',
    content, isDM: false, isThread: true, isBot: false,
    parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
    referenceMessageId: null, effectiveThreadId: threadId, attachments: [], createdAt: new Date(),
  }
}

/** A thread whose history ends with `entry`; optionally a (dead, unbound) registry record for it. */
function seedHistory(entry: Partial<ThreadSessionEntry>, info?: Partial<SessionInfo>): ThreadSessionEntry {
  const n = ++seq
  const e = { sessionId: `sess-t8-${n}`, tmuxName: `t8dead${n}`, originType: 'spawn', startedAt: 1, endedAt: 2,
    messageCount: 3, model: 'dead-model', label: 'build', ...entry } as ThreadSessionEntry
  threadRegistry.threads.set(THREAD, {
    threadId: THREAD, topic: TOPIC, threadUrl: URL, respawnCount: 0, createdAt: 1, lastActive: 1,
    totalMessages: 0, sessionHistory: [e],
  })
  threads.add(THREAD)
  if (info) {
    registry.set(e.sessionId, { sessionId: e.sessionId, topic: TOPIC, threadId: THREAD, createdAt: 1, lastActive: 1,
      tmuxName: e.tmuxName, listening: false, sessionType: 'thread_owner', deadAt: 3, adapter: engines[info.engine ?? 'claude'], ...info } as SessionInfo)
    seeded.add(e.sessionId)
  }
  return e
}

const fns = () => calls.map(c => c.fn === 'doSpawnSession'
  ? (c.args[3]?.resumeCodex ? 'spawn:resume' : c.args[3]?.forkFrom ? 'spawn:fork' : 'spawn:fresh') : c.fn)
const opts = (i: number) => calls.filter(c => c.fn === 'doSpawnSession')[i].args[3]
const respawnArgs = () => calls.find(c => c.fn === 'tryRespawn')!.args
const logged = () => stderr.join('')
const TIER1_FAIL = 'resume tier 1 (--resume) failed'
const TIER2_FAIL = 'resume tier 2 (fork-from-dead) failed'

// ---------------------------------------------------------------------------
// handleResumeIntercept — Claude
// ---------------------------------------------------------------------------

describe('resume tier matrix — Claude', () => {
  test('id → tryResume with the dead session\'s id, model and label; announces full context', async () => {
    seedHistory({ claudeSessionId: 'C-1' }, { engine: 'claude' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['tryResume'])
    expect(calls[0].args[0]).toEqual({ topic: TOPIC, threadId: THREAD, claudeSessionId: 'C-1', threadUrl: URL, model: 'dead-model', label: 'build' })
    expect(sent.some(s => s.includes('`resumed-name` resumed — full context restored'))).toBe(true)
    expect(logged()).not.toContain(TIER1_FAIL)
  })

  test('bridgeOrphan → says the bridge is not yet connected', async () => {
    resumeOutcome = 'orphan'
    seedHistory({ claudeSessionId: 'C-1' })
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('resumed — context restored, but bridge not yet connected (may need a moment)'))).toBe(true)
    expect(sent.some(s => s.includes('full context restored'))).toBe(false)
  })

  test('bridgeOrphan whose launch recorded a cause → the announcement names it', async () => {
    resumeOutcome = 'orphan'
    seedHistory({ claudeSessionId: 'C-1' })
    registry.set('s-new', { sessionId: 's-new', threadId: THREAD, tmuxName: 'resumed-name', engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner', channelNote: 'Claude Code had the bridge marked needs-auth (cleared at launch)' } as any)
    seeded.add('s-new')
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('bridge not yet connected (may need a moment). Claude Code had the bridge marked needs-auth (cleared at launch)'))).toBe(true)
  })

  test('tryResume fails → fork-from-dead with the Claude id', async () => {
    resumeOutcome = 'null'
    const e = seedHistory({ claudeSessionId: 'C-1' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['tryResume', 'spawn:fork'])
    const o = opts(0)
    expect(o.existingThreadId).toBe(THREAD)
    expect(o.forkFrom.claudeSessionId).toBe('C-1')
    expect(o.forkFrom.parentName).toBe(e.tmuxName)
    expect(o.forkFrom.codexThreadId).toBeUndefined()
    expect(o).toMatchObject({ engine: 'claude', model: 'dead-model', label: 'build' })
    expect(logged()).toContain(TIER1_FAIL)
    expect(sent.some(s => s.includes('resumed (forked from dead session — transcript preserved)'))).toBe(true)
  })

  test('fork fails → respawn as Claude', async () => {
    resumeOutcome = 'null'; spawnFails = ['fork']
    const e = seedHistory({ claudeSessionId: 'C-1' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['tryResume', 'spawn:fork', 'tryRespawn'])
    expect(respawnArgs()).toEqual([THREAD, TOPIC, e.tmuxName, 'dead-model', { engine: 'claude', label: 'build' }])
    expect(logged()).toContain(TIER2_FAIL)
    expect(sent.some(s => s.includes('respawned (resume unavailable — reading thread history)'))).toBe(true)
  })

  test('no id → straight to respawn, no tier logs', async () => {
    const e = seedHistory({})
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['tryRespawn'])
    expect(respawnArgs()).toEqual([THREAD, TOPIC, e.tmuxName, 'dead-model', { engine: 'claude', label: 'build' }])
    expect(logged()).not.toContain(TIER1_FAIL)
  })

  test('all tiers fail → "all recovery methods failed"', async () => {
    resumeOutcome = 'null'; spawnFails = ['fork']; respawnOk = false
    seedHistory({ claudeSessionId: 'C-1' })
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('`resume` failed: all recovery methods failed'))).toBe(true)
  })

  // Mixed id, Claude side: a Claude record whose history carries only a Codex
  // thread passes the tier gate but has nothing Claude can resume or fork.
  test('Claude record holding only a codexThreadId: both tiers fail, respawns as Claude', async () => {
    seedHistory({ codexThreadId: 'T-x' }, { engine: 'claude' })
    await handleResumeIntercept(msg())
    expect(calls.filter(c => c.fn === 'doSpawnSession')).toEqual([])
    expect(logged()).toContain(TIER1_FAIL)
    expect(logged()).toContain(TIER2_FAIL)
    expect(respawnArgs()[4]).toEqual({ engine: 'claude', label: 'build' })
  })
})

// Z5: resume stamps deadAt on a gone live record before the cascade, for any
// engine. Without it a Claude record stays un-dead after "all recovery methods
// failed", and the health poll then posts a second 💀 telling the user to resume.
describe('resume stamps a gone live record dead (Z5)', () => {
  let tmux: FakeTmux
  beforeEach(() => { tmux = withFakeTmux() })
  afterEach(() => { tmux.restore() })

  function goneLive(engine: 'claude' | 'codex', extra: Partial<SessionInfo>): SessionInfo {
    const e = seedHistory({ ...extra })
    const info = { sessionId: e.sessionId, topic: TOPIC, threadId: THREAD, createdAt: 1, lastActive: 1,
      tmuxName: e.tmuxName, listening: false, sessionType: 'thread_owner', engine, adapter: engines[engine], ...extra } as SessionInfo
    registry.set(info.sessionId, info); registry.setThread(THREAD, info.sessionId); seeded.add(info.sessionId)
    return info
  }
  const skulls = () => sent.filter(s => s.startsWith('💀'))

  test('Claude: all tiers fail → record is dead, no later 💀 from the health poll', async () => {
    resumeOutcome = 'null'; spawnFails = ['fork']; respawnOk = false
    const info = goneLive('claude', { claudeSessionId: 'C-z5' })
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('all recovery methods failed'))).toBe(true)
    expect(info.deadAt).toBeNumber()
    pollSessionsOnce(Date.now())
    expect(skulls()).toEqual([])
  })

  // The poll closed the history entry when it stamped deadAt; resume now stamps
  // first, so it must close the entry the same way or the thread never reaches
  // the completed lists (commands/status.ts, dashboard.ts).
  function openEntry(info: SessionInfo) {
    const e = threadRegistry.get(THREAD)!.sessionHistory.find(h => h.sessionId === info.sessionId)!
    delete (e as any).endedAt
    return e
  }
  const closed = (e: ThreadSessionEntry) => ({ ended: typeof e.endedAt, messageCount: e.messageCount, engine: e.engine })

  test('poll baseline: a gone Claude record gets its history entry closed', () => {
    const info = goneLive('claude', { claudeSessionId: 'C-z5p', messageCount: 7 } as any)
    const e = openEntry(info)
    pollSessionsOnce(Date.now())
    expect(closed(e)).toEqual({ ended: 'number', messageCount: 7, engine: 'claude' })
  })

  test('Claude: all tiers fail → history entry closed as the poll would', async () => {
    resumeOutcome = 'null'; spawnFails = ['fork']; respawnOk = false
    const info = goneLive('claude', { claudeSessionId: 'C-z5h', messageCount: 7 } as any)
    const e = openEntry(info)
    await handleResumeIntercept(msg())
    expect(closed(e)).toEqual({ ended: 'number', messageCount: 7, engine: 'claude' })
  })

  test('Codex: all tiers fail → record is dead (unchanged)', async () => {
    spawnFails = ['resume', 'fork']; respawnOk = false
    const info = goneLive('codex', { codexThreadId: 'T-z5', codexHomeName: `z5-none-${seq}` })
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('all recovery methods failed'))).toBe(true)
    expect(info.deadAt).toBeNumber()
  })

  test('Claude: a reachable record is left alone, not stamped', async () => {
    const info = goneLive('claude', { claudeSessionId: 'C-z5r', createdAt: Date.now() })
    tmux.alive(info.tmuxName)
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('still starting up'))).toBe(true)
    expect(info.deadAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// handleResumeIntercept — Codex
// ---------------------------------------------------------------------------

describe('resume tier matrix — Codex', () => {
  test('thread → spawn with resumeCodex + reverify guard, holding the home reservation', async () => {
    seedHistory({ codexThreadId: 'T-1', codexHomeName: 'home1' }, { engine: 'codex' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['spawn:resume'])
    const [topic, chatId, messageId, o] = calls[0].args
    expect([topic, chatId, messageId]).toEqual([TOPIC, undefined, undefined])
    expect(o).toEqual({ existingThreadId: THREAD, resumeCodex: { threadId: 'T-1', homeName: 'home1' },
      promptPrefix: RECOVERY_REVERIFY_GUARD, model: 'dead-model', engine: 'codex', label: 'build' })
    expect(reservedDuringSpawn).toEqual([true])
    expect(registry.reservedNames.has('home1')).toBe(false)
    expect(sent.some(s => s.includes('`resume-name` resumed — full context restored'))).toBe(true)
  })

  test('history engine inference: no record, history codexThreadId → Codex; home defaults to tmuxName', async () => {
    const e = seedHistory({ codexThreadId: 'T-1' })
    await handleResumeIntercept(msg())
    expect(opts(0).resumeCodex).toEqual({ threadId: 'T-1', homeName: e.tmuxName })
    expect(opts(0).engine).toBe('codex')
  })

  test('thread and home fall back to the registry record', async () => {
    seedHistory({}, { engine: 'codex', codexThreadId: 'T-reg', codexHomeName: 'home-reg' })
    await handleResumeIntercept(msg())
    expect(opts(0).resumeCodex).toEqual({ threadId: 'T-reg', homeName: 'home-reg' })
  })

  test('a resume already in progress on the home → bail, nothing spawned or respawned', async () => {
    seedHistory({ codexThreadId: 'T-1', codexHomeName: 'home-busy' }, { engine: 'codex' })
    registry.reservedNames.add('home-busy')
    try {
      await handleResumeIntercept(msg())
    } finally { registry.reservedNames.delete('home-busy') }
    expect(calls).toEqual([])
    expect(sent.some(s => s.includes('A resume of this session is already in progress.'))).toBe(true)
  })

  test('resume fails → fork with thread and home; reservation released', async () => {
    spawnFails = ['resume']
    const e = seedHistory({ codexThreadId: 'T-1', codexHomeName: 'home1' }, { engine: 'codex' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['spawn:resume', 'spawn:fork'])
    expect(opts(1).forkFrom).toEqual({ codexThreadId: 'T-1', codexHomeName: 'home1', parentName: e.tmuxName })
    expect(opts(1)).toMatchObject({ existingThreadId: THREAD, engine: 'codex', model: 'dead-model', label: 'build' })
    expect(opts(1).resumeCodex).toBeUndefined()
    expect(logged()).toContain('codex resume of T-1 in home home1 failed')
    expect(logged()).toContain(TIER1_FAIL)
    expect(registry.reservedNames.has('home1')).toBe(false)
    expect(sent.some(s => s.includes('forked from dead session'))).toBe(true)
  })

  test('fork fails → respawn as Codex; then "all failed"', async () => {
    spawnFails = ['resume', 'fork']
    const e = seedHistory({ codexThreadId: 'T-1' }, { engine: 'codex' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['spawn:resume', 'spawn:fork', 'tryRespawn'])
    expect(respawnArgs()).toEqual([THREAD, TOPIC, e.tmuxName, 'dead-model', { engine: 'codex', label: 'build' }])
    expect(logged()).toContain(TIER2_FAIL)

    calls = []; sent = []; respawnOk = false
    await handleResumeIntercept(msg())
    expect(sent.some(s => s.includes('all recovery methods failed'))).toBe(true)
  })

  test('never calls tryResume for Codex', async () => {
    spawnFails = ['resume', 'fork']
    seedHistory({ codexThreadId: 'T-1', claudeSessionId: 'C-stray' }, { engine: 'codex' })
    await handleResumeIntercept(msg())
    expect(fns()).not.toContain('tryResume')
  })

  // PINNED R9 (PR-IDENT): a Codex record holding only a Claude id passes the tier
  // gate, logs both tier failures without any executor, then respawns as Codex.
  test('PINNED R9: Codex record with only a claudeSessionId → both tier failures, respawn as Codex', async () => {
    seedHistory({ claudeSessionId: 'C-stray' }, { engine: 'codex', claudeSessionId: 'C-stray' })
    await handleResumeIntercept(msg())
    expect(fns()).toEqual(['tryRespawn'])
    expect(logged()).toContain(TIER1_FAIL)
    expect(logged()).toContain(TIER2_FAIL)
    expect(respawnArgs()[4]).toEqual({ engine: 'codex', label: 'build' })
  })
})

// ---------------------------------------------------------------------------
// handleRespawnIntercept — engine and model reaching tryRespawn
// ---------------------------------------------------------------------------

describe('handleRespawnIntercept', () => {
  test('selection wins over the record for engine and model', async () => {
    const e = seedHistory({ codexThreadId: 'T-1' }, { engine: 'codex' })
    await handleRespawnIntercept(msg('respawn'), undefined, undefined, { model: 'sel-model', engine: 'claude' })
    expect(fns()).toEqual(['tryRespawn'])
    const [threadId, topic, from, model, extra] = respawnArgs()
    expect([threadId, topic, from, model]).toEqual([THREAD, TOPIC, e.tmuxName, 'sel-model'])
    expect(extra).toEqual({ inheritedLabel: 'build', engine: 'claude' })
  })

  test('no selection: record engine, recovered model', async () => {
    seedHistory({ model: 'codex-default', codexThreadId: 'T-1', engine: 'codex' }, { engine: 'codex' })
    await handleRespawnIntercept(msg('respawn'))
    expect(respawnArgs()[3]).toBeUndefined() // placeholder never replayed as a model id
    expect(respawnArgs()[4].engine).toBe('codex')
  })

  test('no selection, no record: history codexThreadId → Codex, else Claude', async () => {
    seedHistory({ codexThreadId: 'T-1' })
    await handleRespawnIntercept(msg('respawn'))
    expect(respawnArgs()[4].engine).toBe('codex')

    calls = []
    seedHistory({ claudeSessionId: 'C-1' })
    await handleRespawnIntercept(msg('respawn'))
    expect(respawnArgs()[4].engine).toBe('claude')
    expect(respawnArgs()[3]).toBe('dead-model')
  })

  test('the record engine beats the history inference', async () => {
    seedHistory({ codexThreadId: 'T-1' }, { engine: 'claude' })
    await handleRespawnIntercept(msg('respawn'))
    expect(respawnArgs()[4].engine).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// handleForkIntercept — native fork vs continuation (G3, G4)
// ---------------------------------------------------------------------------

describe('handleForkIntercept', () => {
  let tmux: FakeTmux
  beforeEach(() => { tmux = withFakeTmux() })
  afterEach(() => { tmux.restore() })

  function live(engine: 'claude' | 'codex', extra: Partial<SessionInfo> = {}): SessionInfo {
    const n = ++seq
    const info = { sessionId: `sess-t8f-${n}`, topic: TOPIC, threadId: `thread-t8f-${n}`, createdAt: 1, lastActive: 1,
      tmuxName: `t8live${n}`, listening: false, engine, sessionType: 'thread_owner', label: 'build',
      sessionMetadata: { model: 'src-model' }, adapter: engines[engine], ...extra } as SessionInfo
    registry.set(info.sessionId, info)
    registry.setThread(info.threadId, info.sessionId)
    seeded.add(info.sessionId); threads.add(info.threadId)
    tmux.alive(info.tmuxName)
    return info
  }
  const forkMsg = (info: SessionInfo) => msg('fork', info.threadId)

  test('Claude→Claude with an id: native fork from the Claude session', async () => {
    const info = live('claude', { claudeSessionId: 'C-src' })
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual(['spawn:fork'])
    const o = opts(0)
    expect(o.forkFrom.claudeSessionId).toBe('C-src')
    expect(o.forkFrom.parentName).toBe(info.tmuxName)
    expect(o).toMatchObject({ engine: 'claude', model: 'src-model', inheritedLabel: 'build' })
    expect(sent.some(s => s.includes(`forked from`) && s.includes(info.tmuxName))).toBe(true)
  })

  test('Codex→Codex with a thread: native fork with thread and home', async () => {
    const info = live('codex', { codexThreadId: 'T-src' })
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual(['spawn:fork'])
    expect(opts(0).forkFrom).toEqual({ codexThreadId: 'T-src', codexHomeName: info.tmuxName, parentName: info.tmuxName })
    expect(opts(0).engine).toBe('codex')

    calls = []
    const homed = live('codex', { codexThreadId: 'T-src2', codexHomeName: 'src-home' })
    await handleForkIntercept(forkMsg(homed))
    expect(opts(0).forkFrom).toEqual({ codexThreadId: 'T-src2', codexHomeName: 'src-home', parentName: homed.tmuxName })
  })

  test('Claude without an id: continuation, not a native fork', async () => {
    const info = live('claude')
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual(['spawn:fresh'])
    expect(opts(0).forkFrom).toBeUndefined()
    expect(sent.some(s => s.includes('session not forkable yet'))).toBe(true)
  })

  test('cross-engine: continuation even with a native id, no model carried', async () => {
    const info = live('claude', { claudeSessionId: 'C-src' })
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'codex' })
    expect(fns()).toEqual(['spawn:fresh'])
    expect(opts(0)).toMatchObject({ engine: 'codex', model: undefined })
    expect(sent.some(s => s.includes('cross-engine continuation'))).toBe(true)

    calls = []; sent = []
    const cx = live('codex', { codexThreadId: 'T-src' })
    await handleForkIntercept(forkMsg(cx), undefined, undefined, { engine: 'claude' })
    expect(fns()).toEqual(['spawn:fresh'])
    expect(sent.some(s => s.includes('cross-engine continuation'))).toBe(true)
  })

  test('PINNED R9: Codex record with only a Claude id → continuation', async () => {
    const info = live('codex', { claudeSessionId: 'C-stray' })
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual(['spawn:fresh'])
    expect(sent.some(s => s.includes('session not forkable yet'))).toBe(true)
  })

  // Z4: the fork guard asks the adapter whether the source is alive. Claude:
  // tmux. Codex: app-server connection, then socket, then tmux.
  const dead = (info: SessionInfo) => rmSync(join(tmux.dir, `alive-${info.tmuxName}`))
  const refused = (info: SessionInfo) => sent.some(s => s.includes(`Cannot fork — **${info.tmuxName}** is no longer running.`))

  test('Z4 Claude with tmux gone → refused, nothing spawned', async () => {
    const info = live('claude', { claudeSessionId: 'C-src' }); dead(info)
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual([])
    expect(refused(info)).toBe(true)
  })

  test('Z4 Codex with connection, socket and tmux all gone → refused, nothing spawned', async () => {
    const info = live('codex', { codexThreadId: 'T-src', codexHomeName: `z4-none-${seq}` }); dead(info)
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual([])
    expect(refused(info)).toBe(true)
  })

  test('Z4 Codex with tmux gone but the app-server connected → still forks', async () => {
    const info = live('codex', { codexThreadId: 'T-src' }); dead(info)
    const orig = codexEngine.isConnected
    codexEngine.isConnected = ((sid: string) => sid === info.sessionId) as any
    try { await handleForkIntercept(forkMsg(info)) } finally { codexEngine.isConnected = orig }
    expect(fns()).toEqual(['spawn:fork'])
    expect(refused(info)).toBe(false)
  })

  test('native fork failure falls back to a fresh spawn reading the thread', async () => {
    spawnFails = ['fork']
    const info = live('claude', { claudeSessionId: 'C-src' })
    await handleForkIntercept(forkMsg(info))
    expect(fns()).toEqual(['spawn:fork', 'spawn:fresh'])
    expect(opts(1)).toMatchObject({ resurrectFrom: info.tmuxName, engine: 'claude' })
  })
})
