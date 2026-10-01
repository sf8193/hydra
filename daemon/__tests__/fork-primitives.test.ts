import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { doSpawnSession, handOff, handoffIO, predecessorOf } from '../session-lifecycle.js'
import { isParentOf, registry, SessionRegistry, threadRegistry } from '../sessions.js'
import type { SessionInfo, ThreadSessionEntry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { executeTool } from '../bridge-dispatch.js'
import type { LaunchInput } from '../engines/engine-adapter.js'
import { handleRecoverIntercept } from '../recovery.js'
import { handleResumeIntercept } from '../commands/thread.js'
import { projectDirName } from '../usage.js'
import { buildForkPrompt, buildHandoffPrompt } from '../prompts/session.js'
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
  const fake = withFakeTmux()  // transcript lookups read its temp CLAUDE_CONFIG_DIR, not ~/.claude
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
    fake.restore()
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
  const fake = withFakeTmux()
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
    fake.restore()
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

  // A read_only fork's launch options: a real dir that is not SPAWN_CWD, and the blocked tools.
  const kept = { launchCwd: tmpdir(), disallowedTools: ['Edit', 'Write', 'NotebookEdit'] }
  const keptBy = (l: LaunchInput | undefined) => ({ launchCwd: l?.cwd, disallowedTools: l?.disallowedTools })

  test('a resume into the thread keeps the dead record\'s predecessor and launch options; a plain replacement does not', async () => {
    seedDead({ predecessor: pred, ...kept })
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, resumeFrom: 'C-x' })
    expect(live().predecessor).toEqual(pred)
    expect(keptBy(launches[0])).toEqual(kept)
    expect({ launchCwd: live().launchCwd, disallowedTools: live().disallowedTools }).toEqual(kept)

    live().deadAt = Date.now()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD })
    expect(live().predecessor).toBeUndefined()
    expect(keptBy(launches[1])).toEqual({ launchCwd: process.cwd(), disallowedTools: undefined })
  })

  test('recover: tier 2 (fork-from-dead) keeps the predecessor after tier 1 deleted the record', async () => {
    const dead = seedDead({ predecessor: pred, ...kept })
    failResume = true
    await handleRecoverIntercept({ channelId: 'ch', id: 'm1' } as any, dead.tmuxName)
    expect(launches.map(l => l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other')).toEqual(['resume', 'fork'])
    expect(live().predecessor).toEqual(pred)
    expect(launches.map(keptBy)).toEqual([kept, kept])
  })

  test('manual resume: tiers 2 (fork) and 3 (respawn) keep the predecessor', async () => {
    const msg = (): InboundMessage => ({
      id: `fp-msg-${++seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op', content: 'resume', isDM: false,
      isThread: true, isBot: false, parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
    })
    seedDead({ predecessor: pred, ...kept })
    failResume = true
    await handleResumeIntercept(msg())
    expect(launches.at(-1)?.forkFrom).toBeDefined()
    expect(live().predecessor).toEqual(pred)
    expect(launches.map(keptBy)).toEqual([kept, kept])

    registry.delete(live().sessionId)
    launches.length = 0
    seedDead({ predecessor: pred, ...kept })
    failFork = true
    await handleResumeIntercept(msg())
    expect(launches.map(l => l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other')).toEqual(['resume', 'fork', 'other'])
    expect(live().predecessor).toEqual(pred)
    // The respawn is a fresh conversation: SPAWN_CWD, still read-only.
    expect(launches.map(keptBy)).toEqual([kept, kept, { launchCwd: process.cwd(), disallowedTools: kept.disallowedTools }])
    expect(live().launchCwd).toBeUndefined()
  })

  describe('authority passes through handoff and recovery, by session id', () => {
    const sent: { channel: string; text: string }[] = []
    let savedSend: typeof gateway.send
    beforeEach(() => {
      sent.length = 0
      savedSend = gateway.send
      ;(gateway as any).send = async (channel: string, text: string) => { sent.push({ channel, text }); return { id: 'm', channelId: channel } }
    })
    afterEach(() => {
      (gateway as any).send = savedSend
      for (const id of ['au-parent', 'au-child', 'au-legacy', 'au-recycled']) registry.delete(id)
    })
    const old = { createdAt: Date.now() - 2e6 }
    const errText = (r: any) => r.content[0].text as string
    const deathNotices = () => sent.filter(m => m.text.includes('died')).map(m => m.channel)
    const parentAndKids = (pred: SessionInfo) => {
      mk('au-parent', 'auparent', { ...old, adapter: fakeClaude } as any)
      const child = mk('au-child', 'auchild', { parentId: pred.sessionId, adapter: fakeClaude } as any)
      const legacy = mk('au-legacy', 'aulegacy', { initiator: pred.tmuxName, adapter: fakeClaude } as any)  // pre-parentId record
      return { child, legacy }
    }
    const resumeMsg = (): InboundMessage => ({
      id: `fp-msg-${++seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op', content: 'resume', isDM: false,
      isThread: true, isBot: false, parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
    })

    test('handoff: the successor answers to the predecessor\'s parent, takes over its children, and a recycled name gets nothing', async () => {
      const pred = seedDead({ deadAt: undefined, parentId: 'au-parent', initiator: 'auparent' } as any)
      const { child, legacy } = parentAndKids(pred)
      const origKill = handoffIO.killSession
      handoffIO.killSession = (async (i: SessionInfo) => { registry.delete(i.sessionId) }) as any
      try {
        await handOff(pred, '/h.md')
      } finally { handoffIO.killSession = origKill }
      const succ = live()
      expect(succ.originFrom).toBe(pred.tmuxName)  // lineage only
      expect(succ.parentId).toBe('au-parent')
      expect(succ.initiator).toBe('auparent')
      expect(child.parentId).toBe(succ.sessionId)
      expect(legacy.parentId).toBe(succ.sessionId)

      // A new, unrelated session reusing the dead predecessor's name holds no authority.
      mk('au-recycled', pred.tmuxName, { createdAt: Date.now() + 1000, adapter: fakeClaude } as any)
      expect(errText(await executeTool('kill_session', { session_id: child.sessionId }, 'au-recycled'))).toContain('cannot kill')
      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, 'au-recycled'))).toContain('peek denied')
      expect(errText(await executeTool('kill_session', { session_id: succ.sessionId }, 'au-recycled'))).toContain('cannot kill')

      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, succ.sessionId))).not.toContain('peek denied')
      expect((await executeTool('kill_session', { session_id: child.sessionId }, succ.sessionId)).isError).toBeFalsy()
      expect((await executeTool('kill_session', { session_id: succ.sessionId }, 'au-parent')).isError).toBeFalsy()
      expect(deathNotices()).toContain('au-parent-thread')
    })

    test('recover tier 1 (resume) and tier 2 (fork) keep the parent and take over the children', async () => {
      for (const failTier1 of [false, true]) {
        failResume = failTier1
        const dead = seedDead({ parentId: 'au-parent', initiator: 'auparent' } as any)
        const { child } = parentAndKids(dead)
        const savedHas = transport.has
        ;(transport as any).has = () => !failTier1  // tier 1 waits for the resumed bridge
        try {
          await handleRecoverIntercept({ channelId: 'ch', id: `m-${seq}` } as any, dead.tmuxName)
        } finally { (transport as any).has = savedHas }
        expect(launches.at(-1)?.[failTier1 ? 'forkFrom' : 'resumeFrom']).toBeDefined()
        expect(live().parentId).toBe('au-parent')
        expect(live().initiator).toBe('auparent')
        expect(child.parentId).toBe(live().sessionId)
        registry.delete(live().sessionId)
        for (const id of ['au-parent', 'au-child', 'au-legacy']) registry.delete(id)
      }
    })

    test('manual resume tier 3 (respawn) keeps the parent and takes over the children', async () => {
      const dead = seedDead({ parentId: 'au-parent', initiator: 'auparent' } as any)
      const { child } = parentAndKids(dead)
      failResume = true; failFork = true
      await handleResumeIntercept(resumeMsg())
      expect(launches.map(l => l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other')).toEqual(['resume', 'fork', 'other'])
      expect(live().parentId).toBe('au-parent')
      expect(child.parentId).toBe(live().sessionId)
    })

    test('a plain replacement spawn into the thread inherits no parent', async () => {
      seedDead({ parentId: 'au-parent' } as any)
      await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD })
      expect(live().parentId).toBeNull()
    })
  })

  test('manual resume of a fork whose launch dir is gone: resume and fork refuse, the respawn starts in SPAWN_CWD', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'fp-gone-'))
    rmSync(gone, { recursive: true })
    seedDead({ launchCwd: gone, disallowedTools: kept.disallowedTools })
    await handleResumeIntercept({
      id: `fp-msg-${++seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op', content: 'resume', isDM: false,
      isThread: true, isBot: false, parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
    })
    expect(launches.map(l => [l.resumeFrom ? 'resume' : l.forkFrom ? 'fork' : 'other', l.cwd])).toEqual([['other', process.cwd()]])
    expect(live().deadAt).toBeUndefined()
    expect(live().launchCwd).toBeUndefined()
    expect(live().disallowedTools).toEqual(kept.disallowedTools)
  })

  test('prompts: a headless fork answers its spawner instead of greeting; a threaded fork keeps buildForkPrompt', async () => {
    seedDead()
    await doSpawnSession('q?', undefined, undefined, { forkFrom: { claudeSessionId: 'cl-f', parentName: 'elder' }, headless: true, initiator: 'asker', disallowedTools: kept.disallowedTools })
    const headless = launches[0].prompt
    expect(headless).toContain('a headless read-only fork of elder')
    expect(headless).toContain('Question: q?')
    expect(headless).toContain('send_to_thread(target="parent", type="result"')
    expect(headless).not.toContain('Greet')

    await doSpawnSession('q2', undefined, undefined, { existingThreadId: THREAD, forkFrom: { claudeSessionId: 'cl-f', parentName: 'elder' } })
    const l = launches[1]
    expect(l.prompt).toBe(buildForkPrompt({ sessionId: l.sessionId, tmuxName: l.tmuxName, threadId: THREAD, topic: 'q2', originFrom: 'elder' }))
  })

  test('prompts: a handoff successor with a predecessor gets the fork recipe; without one the prompt is unchanged', async () => {
    const base = (l: LaunchInput) => ({ sessionId: l.sessionId, tmuxName: l.tmuxName, threadId: THREAD, topic: 't', originFrom: 'elder', artifact: '/h.md' })
    seedDead()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, handedOffFrom: 'elder', artifact: '/h.md' })
    expect(launches[0].prompt).toBe(buildHandoffPrompt(base(launches[0])))
    expect(launches[0].prompt).not.toContain('fork_from')

    live().deadAt = Date.now()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, handedOffFrom: 'elder', artifact: '/h.md', predecessor: pred })
    expect(launches[1].prompt).toContain('spawn_session(fork_from="predecessor", headless=true, read_only=true, phase_budget="5m", topic="<question>")')
    expect(launches[1].prompt).toBe(buildHandoffPrompt({ ...base(launches[1]), hasPredecessor: true }))

    // A Codex predecessor can't be forked yet, so its successor gets no recipe.
    live().deadAt = Date.now()
    await doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, handedOffFrom: 'elder', artifact: '/h.md', predecessor: { engine: 'codex', fork: { codexThreadId: 'th-1', codexHomeName: 'elder', parentName: 'elder' }, cwd: '/src/dir' } })
    expect(launches[2].prompt).toBe(buildHandoffPrompt(base(launches[2])))
    expect(launches[2].prompt).not.toContain('fork_from')
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

  test('predecessorOf: a first cwd from another project is skipped for the one matching the transcript\'s dir', () => {
    const projectDir = join(fake.claudeDir, 'projects', projectDirName('/spawn/root'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'cl-moved.jsonl'), [
      JSON.stringify({ type: 'user', cwd: '/other/project' }),
      JSON.stringify({ type: 'user', cwd: '/spawn/root' }),
    ].join('\n') + '\n')
    const info = mk('fp-9', 'fpmoved', { claudeSessionId: 'cl-moved', worktreePath: '/wt/moved' })
    try {
      expect(predecessorOf(info)?.cwd).toBe('/spawn/root')
    } finally { registry.delete('fp-9') }
  })
})

// ---------------------------------------------------------------------------
// spawn_session fork_from / read_only, through dispatch.
// ---------------------------------------------------------------------------

describe('spawn_session fork_from and read_only', () => {
  let fake: FakeTmux
  let dir: string
  const launches: LaunchInput[] = []
  const orig: Record<string, any> = {}
  const fakeClaude = {
    provider: 'claude', channel: 'bridge',
    launch: async (input: LaunchInput) => { launches.push(input); return { provider: 'claude', model: input.model, identity: { claudeSessionId: `new-${launches.length}` } } },
    stop: async () => ({ status: 'stopped' }),
    isAlive: () => false,
    surface: () => null,
    recoveryPlan: (s: any, o: any) => orig.claude.recoveryPlan(s, o),
  }

  beforeAll(() => {
    orig.claude = engines.claude
    orig.persist = registry.persist; orig.tpersist = threadRegistry.persist
    orig.spawnCwd = process.env.SPAWN_CWD
    engines.claude = fakeClaude as any
    ;(registry as any).persist = () => {}
    ;(threadRegistry as any).persist = () => {}
    process.env.SPAWN_CWD = process.cwd()
  })
  afterAll(() => {
    engines.claude = orig.claude
    ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
    if (orig.spawnCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.spawnCwd
  })
  beforeEach(() => { fake = withFakeTmux(); dir = mkdtempSync(join(tmpdir(), 'fp-src-')); launches.length = 0 })
  afterEach(() => {
    for (const s of [...registry.values()]) if (s.sessionId.startsWith('fs-') || s.initiator?.startsWith('fs')) registry.delete(s.sessionId)
    rmSync(dir, { recursive: true, force: true })
    fake.restore()
  })

  const spawn = (args: Record<string, unknown>, caller = 'fs-caller') =>
    executeTool('spawn_session', { topic: 'q — answer via send_to_thread(type=result)', headless: true, ...args }, caller)
  const errorOf = async (args: Record<string, unknown>, caller?: string) => {
    const r = await spawn(args, caller)
    expect(r.isError).toBe(true)
    return (r.content[0] as { text: string }).text
  }

  test('a session name resolves to its fork plan, launched in its cwd on its model', async () => {
    mk('fs-caller', 'fscaller')
    mk('fs-src', 'fssrc', { claudeSessionId: 'cl-src', worktreePath: dir, sessionMetadata: { model: 'claude-src-model', cwd: dir } as any })
    expect((await spawn({ fork_from: 'fssrc' })).isError).toBeFalsy()
    expect(launches).toHaveLength(1)
    expect(launches[0].forkFrom as object).toEqual({ claudeSessionId: 'cl-src', parentName: 'fssrc' })
    expect(launches[0].cwd).toBe(dir)
    expect(launches[0].model).toBe('claude-src-model')
    expect(launches[0].worktreePath).toBeUndefined()
    expect(launches[0].disallowedTools).toBeUndefined()
  })

  test('"predecessor" resolves to the caller\'s predecessor; an explicit model wins; read_only blocks the editing tools', async () => {
    mk('fs-caller', 'fscaller', { predecessor: { engine: 'claude', fork: { claudeSessionId: 'cl-gone', parentName: 'elder' }, cwd: dir, model: 'claude-old' } })
    expect((await spawn({ fork_from: 'predecessor', model: 'claude-explicit', read_only: true })).isError).toBeFalsy()
    expect(launches[0].forkFrom as object).toEqual({ claudeSessionId: 'cl-gone', parentName: 'elder' })
    expect(launches[0].cwd).toBe(dir)
    expect(launches[0].model).toBe('claude-explicit')
    expect(launches[0].disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
    // Persisted, so a later resume keeps both.
    const child = registry.get(launches[0].sessionId)!
    expect({ launchCwd: child.launchCwd, disallowedTools: child.disallowedTools }).toEqual({ launchCwd: dir, disallowedTools: ['Edit', 'Write', 'NotebookEdit'] })
  })

  // A history entry for name in its own thread; its transcript says it launched from dir.
  const historyOnly = (name: string, claudeSessionId: string, threadId: string, extra: Partial<ThreadSessionEntry>[] = []) => {
    const projectDir = join(fake.claudeDir, 'projects', projectDirName(dir))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${claudeSessionId}.jsonl`), JSON.stringify({ type: 'user', cwd: dir }) + '\n')
    threadRegistry.threads.set(threadId, {
      threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: `${name}-sid`, tmuxName: name, originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 0, claudeSessionId, model: 'claude-hist' }, ...extra as ThreadSessionEntry[]],
    } as any)
  }

  test('a dead record still in the registry is forked by its name', async () => {
    mk('fs-caller', 'fscaller')
    mk('fs-dead', 'fsdead', { claudeSessionId: 'cl-dead', worktreePath: dir, deadAt: Date.now() })
    expect((await spawn({ fork_from: 'fsdead' })).isError).toBeFalsy()
    expect(launches[0].forkFrom as object).toEqual({ claudeSessionId: 'cl-dead', parentName: 'fsdead' })
  })

  test('a name known only from thread history is forked from its transcript\'s directory', async () => {
    mk('fs-caller', 'fscaller')
    historyOnly('fshist', 'cl-hist', 'fs-hist-thread')
    try {
      expect((await spawn({ fork_from: 'fshist' })).isError).toBeFalsy()
      expect(launches[0].forkFrom as object).toEqual({ claudeSessionId: 'cl-hist', parentName: 'fshist' })
      expect(launches[0].cwd).toBe(dir)
      expect(launches[0].model).toBe('claude-hist')
    } finally { threadRegistry.threads.delete('fs-hist-thread') }
  })

  test('a handed-off name forks the session that ran under it, not its live successor', async () => {
    mk('fs-caller', 'fscaller')
    historyOnly('fsold', 'cl-old', 'fs-ho-thread', [{ sessionId: 'fs-new', tmuxName: 'fsnew', originType: 'handoff', originFrom: 'fsold', startedAt: 3, messageCount: 0 }])
    mk('fs-new', 'fsnew', { threadId: 'fs-ho-thread', claudeSessionId: 'cl-new', worktreePath: dir })
    registry.setThread('fs-ho-thread', 'fs-new')
    try {
      expect((await spawn({ fork_from: 'fsold' })).isError).toBeFalsy()
      expect(launches[0].forkFrom as object).toEqual({ claudeSessionId: 'cl-old', parentName: 'fsold' })
    } finally { threadRegistry.threads.delete('fs-ho-thread'); registry.deleteThread('fs-ho-thread') }
  })

  test('errors: unknown name, no conversation id, no predecessor, Codex source, worktree, gone directory', async () => {
    mk('fs-caller', 'fscaller')
    mk('fs-bare', 'fsbare', { engine: 'codex' })
    mk('fs-codex', 'fscodex', { engine: 'codex', codexThreadId: 'th-1', worktreePath: dir })
    mk('fs-gone', 'fsgone', { claudeSessionId: 'cl-g', worktreePath: join(dir, 'removed') })
    expect(await errorOf({ fork_from: 'nobody-here' })).toContain('no session named "nobody-here"')
    expect(await errorOf({ fork_from: 'fsbare' })).toContain('fsbare has no conversation id to fork')
    expect(await errorOf({ fork_from: 'predecessor' })).toContain('fscaller has no predecessor')
    expect(await errorOf({ fork_from: 'fscodex' })).toContain('fscodex is a Codex session')
    expect(await errorOf({ fork_from: 'fscodex', worktree: 'hydra' })).toContain('cannot be combined with worktree')
    expect(await errorOf({ fork_from: 'fsgone' })).toContain(`launch directory ${join(dir, 'removed')} no longer exists`)
    expect(launches).toEqual([])
  })

  test('a Codex predecessor is refused the same way', async () => {
    mk('fs-caller', 'fscaller', { predecessor: { engine: 'codex', fork: { codexThreadId: 'th-2', codexHomeName: 'h', parentName: 'cxold' }, cwd: dir } })
    expect(await errorOf({ fork_from: 'predecessor' })).toContain('cxold is a Codex session')
  })

  test('a threaded fork whose source dir is gone fails before a thread exists', async () => {
    const calls: string[] = []
    const saved = { createThread: gateway.createThread, send: gateway.send }
    ;(gateway as any).createThread = async () => { calls.push('createThread'); return { id: 'fs-orphan' } }
    ;(gateway as any).send = async (c: string) => { calls.push(`send:${c}`); return { id: 'm', channelId: c } }
    try {
      mk('fs-caller', 'fscaller')
      mk('fs-gone', 'fsgone', { claudeSessionId: 'cl-g', worktreePath: join(dir, 'removed') })
      expect(await errorOf({ fork_from: 'fsgone', headless: false, chat_id: 'fs-chan' })).toContain(`launch directory ${join(dir, 'removed')} no longer exists`)
      expect(calls).toEqual([])
      expect(launches).toEqual([])
    } finally { Object.assign(gateway, saved) }
  })

  describe('authority over a fork belongs to its spawner', () => {
    const sent: { channel: string; text: string }[] = []
    const delivered: string[] = []
    let savedSend: typeof gateway.send
    let savedSendOrQueue: typeof transport.sendOrQueue
    beforeEach(() => {
      sent.length = 0; delivered.length = 0
      savedSend = gateway.send; savedSendOrQueue = transport.sendOrQueue
      ;(gateway as any).send = async (channel: string, text: string) => { sent.push({ channel, text }); return { id: 'm', channelId: channel } }
      ;(transport as any).sendOrQueue = (sessionId: string) => { delivered.push(sessionId) }
    })
    afterEach(() => { (gateway as any).send = savedSend; (transport as any).sendOrQueue = savedSendOrQueue })

    const deathNotices = () => sent.filter(m => m.text.includes('died')).map(m => m.channel)
    const errText = (r: { content: { text: string }[] }) => r.content[0].text
    // Authorized peeks get past the check and fail later: these sessions have no tmux.
    const PEEK_ALLOWED = 'tmux not running'
    const privateSend = (from: string, target: string) => executeTool('send_to_thread', { target, type: 'result', text: 'r', visibility: 'private' }, from)
    const old = { createdAt: Date.now() - 60_000 }

    test('a live source can neither kill nor peek its fork; the spawner can, and gets the death notice', async () => {
      mk('fs-caller', 'fscaller', old)
      mk('fs-src', 'fssrc', { ...old, claudeSessionId: 'cl-src', worktreePath: dir })
      expect((await spawn({ fork_from: 'fssrc' })).isError).toBeFalsy()
      const child = registry.get(launches[0].sessionId)!
      expect(child.originFrom).toBe('fssrc')  // lineage stays the source

      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, 'fs-src') as any)).toContain('peek denied')
      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, 'fs-caller') as any)).toContain(PEEK_ALLOWED)
      expect(errText(await executeTool('kill_session', { session_id: child.sessionId }, 'fs-src') as any)).toContain(`cannot kill ${child.tmuxName}`)
      expect(errText(await privateSend(child.sessionId, 'fssrc') as any)).toContain('"fssrc" is not your parent session')
      expect((await privateSend(child.sessionId, 'fscaller')).isError).toBeFalsy()
      expect(delivered).toEqual(['fs-caller'])

      expect((await executeTool('kill_session', { session_id: child.sessionId }, 'fs-caller')).isError).toBeFalsy()
      expect(deathNotices()).toEqual(['fs-caller-thread'])
    })

    test('fork_from="predecessor": the source is dead, and the spawner still gets the death notice', async () => {
      mk('fs-caller', 'fscaller', { ...old, predecessor: { engine: 'claude', fork: { claudeSessionId: 'cl-gone', parentName: 'fselder' }, cwd: dir } })
      expect((await spawn({ fork_from: 'predecessor' })).isError).toBeFalsy()
      const child = registry.get(launches[0].sessionId)!
      expect(child.originFrom).toBe('fselder')
      expect((await executeTool('kill_session', { session_id: child.sessionId }, 'fs-caller')).isError).toBeFalsy()
      expect(deathNotices()).toEqual(['fs-caller-thread'])
    })

    test('the headless spawn line goes to the spawner by id, never to a session that took its name', async () => {
      mk('fs-caller', 'fscaller', old)
      mk('fs-imposter', 'fsimposter', old)  // holds the name the spawn's initiator string carries
      await doSpawnSession('t', undefined, undefined, { headless: true, parentId: 'fs-caller', initiator: 'fsimposter' })
      const announced = sent.filter(m => m.text.includes('headless worker')).map(m => m.channel)
      expect(announced).toEqual(['fs-caller-thread'])
    })

    test('the headless spawn line is skipped for a headless parent and still posted for a threaded one', async () => {
      mk('fs-caller', 'fscaller', old)
      mk('fs-ghost', 'fsghost', { ...old, headless: true })
      await doSpawnSession('t', undefined, undefined, { headless: true, parentId: 'fs-ghost', initiator: 'fsghost' })
      await doSpawnSession('t', undefined, undefined, { headless: true, parentId: 'fs-caller', initiator: 'fscaller' })
      expect(sent.filter(m => m.text.includes('headless worker')).map(m => m.channel)).toEqual(['fs-caller-thread'])
    })

    test('only a headless fork_from spawn is answer-once', async () => {
      mk('fs-caller', 'fscaller', old)
      mk('fs-src', 'fssrc', { ...old, claudeSessionId: 'cl-src', worktreePath: dir })
      expect((await spawn({ fork_from: 'fssrc' })).isError).toBeFalsy()
      expect((await spawn({})).isError).toBeFalsy()
      const flags = launches.map(l => registry.get(l.sessionId)?.answerOnce ?? false)
      expect(flags).toEqual([true, false])
      expect(launches[0].prompt).toContain('you are ended once it is delivered')
      expect(launches[1].prompt).not.toContain('you are ended once it is delivered')
    })

    test('a human fork (no spawner) still answers to its source', async () => {
      mk('fs-src', 'fssrc', old)
      mk('fs-other', 'fsother', old)
      // The fork command names the source as parent (commands/thread.ts handleForkIntercept).
      await doSpawnSession('t', undefined, undefined, { forkFrom: { claudeSessionId: 'cl-src', parentName: 'fssrc' }, parentId: 'fs-src', headless: true })
      const child = registry.get(launches[0].sessionId)!
      expect(child.initiator).toBeUndefined()

      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, 'fs-other') as any)).toContain('peek denied')
      expect(errText(await executeTool('peek_session', { name: child.tmuxName }, 'fs-src') as any)).toContain(PEEK_ALLOWED)
      expect(errText(await executeTool('kill_session', { session_id: child.sessionId }, 'fs-other') as any)).toContain(`cannot kill ${child.tmuxName}`)
      expect((await executeTool('kill_session', { session_id: child.sessionId }, 'fs-src')).isError).toBeFalsy()
      expect(deathNotices()).toEqual(['fs-src-thread'])
    })
  })

  test('read_only without fork_from reaches the launch too', async () => {
    mk('fs-caller', 'fscaller')
    expect((await spawn({ read_only: true })).isError).toBeFalsy()
    expect(launches[0].forkFrom).toBeUndefined()
    expect(launches[0].disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
  })
})

describe('Claude fork argv', () => {
  let fake: FakeTmux
  beforeEach(() => { fake = withFakeTmux() })
  afterEach(() => fake.restore())

  const launchFork = async (disallowedTools?: string[]) => {
    const name = `fpargv${Math.random().toString(36).slice(2, 8)}`
    await new ClaudeEngine(transport).launch({
      sessionId: `sid-${name}`, tmuxName: name, cwd: '/src/dir', originalCwd: '/spawn', model: 'm', prompt: 'P',
      forkFrom: { claudeSessionId: 'cl-argv' }, ...(disallowedTools ? { disallowedTools } : {}),
    })
    return fake.calls().find(c => c.startsWith('new-session') && c.includes(name)) ?? ''
  }

  test('a resumed read_only fork keeps --disallowedTools and starts in its launch dir', async () => {
    const name = `fpresume${Math.random().toString(36).slice(2, 8)}`
    await new ClaudeEngine(transport).launch({
      sessionId: `sid-${name}`, tmuxName: name, cwd: '/src/dir', originalCwd: '/spawn', model: 'm', prompt: 'P',
      resumeFrom: 'cl-forked', disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })
    const line = fake.calls().find(c => c.startsWith('new-session') && c.includes(name)) ?? ''
    expect(line).toContain("--resume 'cl-forked'")
    expect(line).toContain("--disallowedTools 'Edit,Write,NotebookEdit'")
    expect(line).toContain("cd '/src/dir'")
  })

  test('read_only puts --disallowedTools on the fork launch; without it there is none', async () => {
    const restricted = await launchFork(['Edit', 'Write', 'NotebookEdit'])
    expect(restricted).toContain("--resume 'cl-argv' --fork-session")
    expect(restricted).toContain("--disallowedTools 'Edit,Write,NotebookEdit'")
    expect(restricted).toContain("cd '/src/dir'")
    expect(await launchFork()).not.toContain('--disallowedTools')
  })
})

test('isParentOf: by session id when set; legacy records by name, guarded against recycled names, lineage only for forks', () => {
  const t = 1_000_000
  const p = { sessionId: 'p1', tmuxName: 'pa', createdAt: t }
  expect(isParentOf(p, { parentId: 'p1', createdAt: t + 1 })).toBe(true)
  expect(isParentOf(p, { parentId: 'p2', initiator: 'pa', createdAt: t + 1 })).toBe(false)  // id wins over name
  expect(isParentOf(p, { parentId: null, initiator: 'pa', createdAt: t + 1 })).toBe(false)  // explicit: no parent
  // Legacy (no parentId):
  expect(isParentOf(p, { initiator: 'pa', createdAt: t + 1 })).toBe(true)
  expect(isParentOf({ ...p, createdAt: t + 2 }, { initiator: 'pa', createdAt: t + 1 })).toBe(false)  // recycled name, born later
  expect(isParentOf(p, { originType: 'fork', originFrom: 'pa', createdAt: t + 1 })).toBe(true)
  expect(isParentOf(p, { originType: 'handoff', originFrom: 'pa', createdAt: t + 1 })).toBe(false)
  expect(isParentOf(p, { originType: 'resurrect', originFrom: 'pa', createdAt: t + 1 })).toBe(false)
})

test('parentId survives persist and a reload, null included', () => {
  const file = join(STATE_DIR, 'sessions.json')
  const saved = existsSync(file) ? readFileSync(file, 'utf8') : null
  mk('fp-pid-1', 'pidone', { parentId: 'someone' })
  mk('fp-pid-2', 'pidtwo', { parentId: null })
  try {
    registry.persist()
    const reloaded = new SessionRegistry()
    expect(reloaded.get('fp-pid-1')?.parentId).toBe('someone')
    expect(reloaded.get('fp-pid-2')?.parentId).toBeNull()
  } finally {
    registry.delete('fp-pid-1'); registry.delete('fp-pid-2')
    if (saved === null) rmSync(file, { force: true }); else writeFileSync(file, saved)
  }
})
