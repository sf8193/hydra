import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { doSpawnSession, handOff, handoffIO, predecessorOf } from '../session-lifecycle.js'
import { registry, SessionRegistry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import type { LaunchInput } from '../engines/engine-adapter.js'
import { handleRecoverIntercept } from '../recovery.js'
import { handleResumeIntercept } from '../commands/thread.js'
import { projectDirName } from '../usage.js'
import type { InboundMessage } from '../../gateway.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

const mk = (id: string, name: string, over: Partial<SessionInfo> = {}): SessionInfo => {
  const info = {
    sessionId: id, tmuxName: name, topic: 't', threadId: `${id}-thread`, createdAt: Date.now(), lastActive: Date.now(),
    listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner', ...over,
  } as any as SessionInfo
  registry.set(id, info)
  return info
}

test('handOff: the successor gets the predecessor (engine, fork ids, cwd, model), snapshotted before the kill', async () => {
  const orig = { ...handoffIO }
  const info = mk('fp-1', 'flint', {
    claudeSessionId: 'cl-abc', worktreePath: '/wt/flint',
    sessionMetadata: { model: 'claude-opus-5-5', cwd: '/elsewhere' } as any,
  })
  const order: string[] = []
  let spawned: any
  handoffIO.killSession = (async (i: SessionInfo) => {
    order.push('kill')
    // A kill forgets everything a later snapshot could have read.
    delete i.claudeSessionId; delete i.worktreePath; delete i.sessionMetadata
    registry.delete(i.sessionId)
  }) as any
  handoffIO.doSpawnSession = (async (_t: string, _c?: string, _m?: string, o?: any) => {
    order.push('spawn'); spawned = o
    return { name: 'fresh', sessionId: 'fp-1b', threadId: info.threadId, url: '' }
  }) as any
  try {
    await handOff(info, '/h.md')
    expect(order).toEqual(['kill', 'spawn'])
    expect(spawned.predecessor).toEqual({
      engine: 'claude',
      fork: { claudeSessionId: 'cl-abc', parentName: 'flint' },
      cwd: '/wt/flint',
      model: 'claude-opus-5-5',
    })
  } finally {
    Object.assign(handoffIO, orig)
    registry.delete('fp-1')
  }
})

test('predecessor survives persist and a reload', () => {
  const file = join(STATE_DIR, 'sessions.json')
  const saved = existsSync(file) ? readFileSync(file, 'utf8') : null
  const predecessor = { engine: 'codex' as const, fork: { codexThreadId: 'th-1', codexHomeName: 'ember', parentName: 'ember' }, cwd: '/wt/ember', model: 'gpt-5.6-sol' }
  mk('fp-2', 'pulse', { predecessor })
  try {
    registry.persist()
    expect(new SessionRegistry().get('fp-2')?.predecessor).toEqual(predecessor)
  } finally {
    registry.delete('fp-2')
    if (saved === null) rmSync(file, { force: true }); else writeFileSync(file, saved)
  }
})

test('predecessorOf: a Codex thread gives its thread id and home; no native id gives undefined', () => {
  const codex = mk('fp-3', 'reed', { engine: 'codex', codexThreadId: 'th-9', codexHomeName: 'reed-home', worktreePath: '/wt/reed' })
  const bare = mk('fp-4', 'moss', { engine: 'codex', worktreePath: '/wt/moss' })
  try {
    expect(predecessorOf(codex)).toEqual({
      engine: 'codex',
      fork: { codexThreadId: 'th-9', codexHomeName: 'reed-home', parentName: 'reed' },
      cwd: '/wt/reed',
    })
    expect(predecessorOf(bare)).toBeUndefined()
  } finally {
    registry.delete('fp-3'); registry.delete('fp-4')
  }
})

test('predecessorOf: cwd falls back from the worktree to the session cwd to SPAWN_CWD', () => {
  const savedCwd = process.env.SPAWN_CWD
  const info = mk('fp-5', 'sage', { claudeSessionId: 'cl-5', sessionMetadata: { model: 'm', cwd: '/meta' } as any })
  try {
    expect(predecessorOf(info)?.cwd).toBe('/meta')
    delete info.sessionMetadata
    process.env.SPAWN_CWD = '/spawn'
    expect(predecessorOf(info)?.cwd).toBe('/spawn')
    expect(predecessorOf(info)?.model).toBeUndefined()
  } finally {
    if (savedCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = savedCwd
    registry.delete('fp-5')
  }
})

// ---------------------------------------------------------------------------
// Through the real spawn and recovery paths: fake engines, fake tmux, no daemon I/O.
// ---------------------------------------------------------------------------

describe('predecessor through doSpawnSession and the recovery cascades', () => {
  const THREAD = 'fp-thread'
  const PARENT = 'fp-parent'
  const pred = { engine: 'claude' as const, fork: { claudeSessionId: 'cl-old', parentName: 'elder' }, cwd: '/wt/elder', model: 'm' }
  let fake: FakeTmux
  let seq = 0
  let failResume = false
  let failFork = false
  const launches: LaunchInput[] = []
  const orig: Record<string, any> = {}

  const fakeClaude = {
    provider: 'claude', channel: 'bridge',
    launch: async (input: LaunchInput) => {
      launches.push(input)
      if (input.resumeFrom && failResume) throw new Error('resume failed')
      if (input.forkFrom && failFork) throw new Error('fork failed')
      return { provider: 'claude', model: 'claude-x', identity: { claudeSessionId: input.resumeFrom ?? `new-${launches.length}` } }
    },
    stop: async () => ({ status: 'stopped' }),
    isAlive: () => false,
    surface: () => null,
    recoveryPlan: (s: any, o: any) => orig.claude.recoveryPlan(s, o),
  }

  beforeAll(() => {
    orig.claude = engines.claude
    orig.send = gateway.send; orig.react = gateway.react; orig.edit = gateway.edit
    orig.fetchChannel = gateway.fetchChannel; orig.getThreadUrl = gateway.getThreadUrl
    orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
    orig.persist = registry.persist; orig.tpersist = threadRegistry.persist
    orig.spawnCwd = process.env.SPAWN_CWD
    engines.claude = fakeClaude as any
    ;(gateway as any).send = async (c: string) => ({ id: 'm', channelId: c })
    ;(gateway as any).react = async () => {}
    ;(gateway as any).edit = async () => {}
    ;(gateway as any).fetchChannel = async () => ({ isThread: true, isDM: false, parentId: PARENT })
    ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
    ;(transport as any).has = () => false
    ;(transport as any).sendOrQueue = () => {}
    ;(registry as any).persist = () => {}
    ;(threadRegistry as any).persist = () => {}
    process.env.SPAWN_CWD = process.cwd()
  })

  afterAll(() => {
    engines.claude = orig.claude
    for (const k of ['send', 'react', 'edit', 'fetchChannel', 'getThreadUrl'] as const) (gateway as any)[k] = orig[k]
    ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
    ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
    if (orig.spawnCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.spawnCwd
  })

  beforeEach(() => { fake = withFakeTmux(); failResume = false; failFork = false; launches.length = 0 })
  afterEach(() => {
    for (const s of [...registry.values()]) if (s.threadId === THREAD) registry.delete(s.sessionId)
    registry.deleteThread(THREAD)
    threadRegistry.threads.delete(THREAD)
    fake.restore()
  })

  /** A dead Claude record owning THREAD, with its history entry. */
  function seedDead(extra: Partial<SessionInfo> = {}): SessionInfo {
    const n = ++seq
    const info = {
      sessionId: `fp-dead-${n}`, topic: 'topic', threadId: THREAD, createdAt: Date.now() - 1e6, lastActive: Date.now(),
      tmuxName: `fpdead${n}`, listening: false, engine: 'claude', sessionType: 'thread_owner', anchorChannelId: PARENT,
      deadAt: Date.now(), adapter: fakeClaude, claudeSessionId: `C-${n}`, ...extra,
    } as any as SessionInfo
    registry.set(info.sessionId, info)
    registry.setThread(THREAD, info.sessionId)
    threadRegistry.recordSpawn(THREAD, { topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName, originType: 'spawn', model: 'm', claudeSessionId: info.claudeSessionId } as any)
    return info
  }
  const live = () => registry.get(registry.getByThread(THREAD)!)!

  test('opts.predecessor lands on the new record', async () => {
    seedDead()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, predecessor: pred })
    expect(live().predecessor).toEqual(pred)
  })

  test('a resume into the thread keeps the dead record\'s predecessor; a plain replacement does not', async () => {
    seedDead({ predecessor: pred })
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, resumeFrom: 'C-x' })
    expect(live().predecessor).toEqual(pred)

    live().deadAt = Date.now()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD })
    expect(live().predecessor).toBeUndefined()
  })

  test('recover: tier 2 (fork-from-dead) keeps the predecessor after tier 1 deleted the record', async () => {
    const dead = seedDead({ predecessor: pred })
    failResume = true
    await handleRecoverIntercept({ channelId: 'ch', id: 'm1' } as any, dead.tmuxName)
    expect(launches.map(l => l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other')).toEqual(['resume', 'fork'])
    expect(live().predecessor).toEqual(pred)
  })

  test('manual resume: tiers 2 (fork) and 3 (respawn) keep the predecessor', async () => {
    const msg = (): InboundMessage => ({
      id: `fp-msg-${++seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op', content: 'resume', isDM: false,
      isThread: true, isBot: false, parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
    })
    seedDead({ predecessor: pred })
    failResume = true
    await handleResumeIntercept(msg())
    expect(launches.at(-1)?.forkFrom).toBeDefined()
    expect(live().predecessor).toEqual(pred)

    registry.delete(live().sessionId)
    launches.length = 0
    seedDead({ predecessor: pred })
    failFork = true
    await handleResumeIntercept(msg())
    expect(launches.map(l => l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other')).toEqual(['resume', 'fork', 'other'])
    expect(live().predecessor).toEqual(pred)
  })

  test('predecessorOf: a Claude session with no stored id is discovered from its pane', () => {
    const info = mk('fp-6', 'fpdisc', { worktreePath: '/wt/disc' })
    fake.pid('fpdisc', '4242')
    fake.seedClaudeSession('4242', 'cl-discovered', '/launch/dir')
    try {
      expect(predecessorOf(info)?.fork).toEqual({ claudeSessionId: 'cl-discovered', parentName: 'fpdisc' })
    } finally { registry.delete('fp-6') }
  })

  test('predecessorOf: a session forked into a worktree gets the cwd it was launched from, read off its transcript', () => {
    const projectDir = join(fake.claudeDir, 'projects', projectDirName('/spawn/root'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'cl-forked.jsonl'), [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', cwd: '/spawn/root' }),
      JSON.stringify({ type: 'user', cwd: '/wt/forked' }),  // a later `cd` into the worktree
    ].join('\n') + '\n')
    const info = mk('fp-7', 'fpfork', { claudeSessionId: 'cl-forked', worktreePath: '/wt/forked', sessionMetadata: { model: 'm', cwd: '/wt/forked' } as any })
    const noTranscript = mk('fp-8', 'fpnone', { claudeSessionId: 'cl-missing', worktreePath: '/wt/none' })
    try {
      expect(predecessorOf(info)?.cwd).toBe('/spawn/root')
      expect(predecessorOf(noTranscript)?.cwd).toBe('/wt/none')
    } finally { registry.delete('fp-7'); registry.delete('fp-8') }
  })
})
