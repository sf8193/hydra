// Pins Claude native-id discovery at kill (G1) and fork (G2): a Claude record
// with no claudeSessionId learns it from the running pane; a Codex record (or a
// Claude→Codex fork) never asks tmux for the pane at all.
//
// Runs the real discoverClaudeSessionId through a PATH-shim tmux and a temp
// CLAUDE_CONFIG_DIR (see fake-tmux.ts).

import { engines } from '../engines/instances.js'
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { discoverClaudeSessionId, killSession } from '../session-lifecycle.js'
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleForkIntercept } from '../commands/thread.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../config.js'
import { fakeCodexAdapter } from './test-harness.js'
import type { InboundMessage } from '../../gateway.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const SID = '11111111-2222-4333-8444-555555555555'
const PID = '424242'

let tmux: FakeTmux
let sent: string[] = []
let stderr: string[] = []
let registryPersists = 0
let seq = 0
const seededSessions = new Set<string>()
const seededThreads = new Set<string>()
let orig: Record<string, any> = {}

beforeAll(() => {
  orig = {
    send: gateway.send, react: gateway.react, edit: gateway.edit,
    registryPersist: registry.persist, threadPersist: threadRegistry.persist,
  }
  ;(registry as any).persist = () => { registryPersists++ }
  ;(threadRegistry as any).persist = () => {}
})

afterAll(() => {
  ;(gateway as any).send = orig.send
  ;(gateway as any).react = orig.react
  ;(gateway as any).edit = orig.edit
  ;(registry as any).persist = orig.registryPersist
  ;(threadRegistry as any).persist = orig.threadPersist
})

beforeEach(() => {
  tmux = withFakeTmux()
  sent = []; stderr = []; registryPersists = 0
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm1' } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  orig.stderrWrite = process.stderr.write
  process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any
})

afterEach(() => {
  process.stderr.write = orig.stderrWrite
  tmux.restore()
  for (const id of seededSessions) registry.delete(id)
  for (const t of seededThreads) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
  seededSessions.clear(); seededThreads.clear()
})

function seed(engine: 'claude' | 'codex', extra: Partial<SessionInfo> = {}): SessionInfo {
  const n = ++seq
  const info: SessionInfo = {
    sessionId: `sess-idd-${n}`,
    topic: 'topic',
    threadId: `thread-idd-${n}`,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: `hydra-t3-idd-${n}`,
    listening: false,
    engine,
    adapter: engines[engine],
    sessionType: 'thread_owner',
    ...extra,
  }
  registry.set(info.sessionId, info)
  seededSessions.add(info.sessionId)
  seededThreads.add(info.threadId)
  threadRegistry.recordSpawn(info.threadId, {
    topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName,
    originType: 'spawn', label: undefined,
  })
  // Discovery would succeed for this pane if anyone asked.
  tmux.pid(info.tmuxName, PID)
  tmux.seedClaudeSession(PID, SID)
  return info
}

const listPanes = () => tmux.calls().filter(c => c.startsWith('list-panes'))


describe('G1: killSession discovers a missing Claude id', () => {
  test('Claude record without an id: discovered, logged, and carried into the closed history entry', async () => {
    const info = seed('claude')
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([`list-panes -t ${info.tmuxName} -F #{pane_pid}`])
    const c = tmux.calls()
    expect(c.findIndex(x => x.startsWith('list-panes'))).toBeLessThan(c.findIndex(x => x.startsWith('kill-session')))
    expect(info.claudeSessionId).toBe(SID)
    expect(stderr.join('')).toContain(`daemon: kill ${info.tmuxName}: late-discovered claudeSessionId=${SID}`)
    const entry = threadRegistry.get(info.threadId)!.sessionHistory.find(h => h.sessionId === info.sessionId)!
    expect(entry.endedAt).toBeDefined()
    expect(entry.claudeSessionId).toBe(SID)
  })

  test('Claude record that already has an id: no discovery', async () => {
    const info = seed('claude', { claudeSessionId: 'already-known' })
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBe('already-known')
  })

  test('Codex record: discovery is never attempted', async () => {
    const info = seed('codex', { adapter: fakeCodexAdapter() })
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
    expect(stderr.join('')).not.toContain('late-discovered')
  })
})

describe('G2: handleForkIntercept discovers only for Claude→Claude', () => {
  function forkMsg(info: SessionInfo): InboundMessage {
    registry.setThread(info.threadId, info.sessionId)
    return {
      id: 'msg-idd', channelId: info.threadId, authorId: 'u1', authorUsername: 'operator',
      content: 'fork', isDM: false, isThread: true, isBot: false,
      parentChannelId: 'parent-idd', hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: info.threadId, attachments: [], createdAt: new Date(),
    }
  }

  // The pane is not "alive" to the shim, so each fork stops at "Cannot fork"
  // right after the discovery step — nothing is spawned.
  test('Claude→Claude: discovers the id and persists it', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'claude' })

    expect(listPanes()).toEqual([`list-panes -t ${info.tmuxName} -F #{pane_pid}`])
    expect(info.claudeSessionId).toBe(SID)
    expect(registryPersists).toBe(1)
    expect(sent.some(t => t.includes('Cannot fork'))).toBe(true)
  })

  test('Claude→Claude (engine defaulted from the source): discovers', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info))

    expect(info.claudeSessionId).toBe(SID)
  })

  test('Codex→Claude: no discovery', async () => {
    const info = seed('codex', { adapter: fakeCodexAdapter() })
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'claude' })
    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
  })

  test('Claude→Codex: no discovery', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'codex' })

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
    expect(registryPersists).toBe(0)
    expect(sent.some(t => t.includes('Cannot fork'))).toBe(true)
  })
})

describe('discovery fallback: the status file that names the tmux session', () => {
  const statusFile = (tmuxField: string, pid = process.pid) => {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, status: 'idle', tmux: tmuxField }))
  }
  test('no <panePid>.json (claude is a child of the pane shell): found by its tmux field', () => {
    const name = 'hydra-t3-idd-fallback'
    tmux.pid(name, PID) // pane pid has no session file
    statusFile(`${name}:@1.%2`)
    expect(discoverClaudeSessionId(name)).toBe(SID)
  })
  test('another session\'s status file, or none, is not a match', () => {
    const name = 'hydra-t3-idd-fallback'
    tmux.pid(name, PID)
    expect(discoverClaudeSessionId(name)).toBeNull()
    statusFile('someone-else:@1.%2')
    expect(discoverClaudeSessionId(name)).toBeNull()
  })
})

// contract PR-0 S0.3: discovery is recoveryPlan's opt-in; absent keys stay absent (peer #5).
describe('recoveryPlan { discover }', () => {
  test('Claude without discover never asks tmux; the plan has no learnedId key', () => {
    const info = seed('claude')
    const plan = engines.claude.recoveryPlan(info)
    expect(listPanes()).toEqual([])
    expect('learnedId' in plan).toBe(false)
    expect(plan).toEqual({ generic: true, resume: null, fork: null })
  })

  test('Claude with discover and no id: learns it, writes it on the record, plans from it', () => {
    const info = seed('claude')
    const plan = engines.claude.recoveryPlan(info, { discover: true })
    expect(plan.learnedId).toBe(SID)
    expect(info.claudeSessionId).toBe(SID)
    expect(plan.fork).toEqual({ claudeSessionId: SID, parentName: info.tmuxName })
  })

  test('Claude with discover and an id already: no discovery, no learnedId key', () => {
    const info = seed('claude', { claudeSessionId: 'already-known' })
    const plan = engines.claude.recoveryPlan(info, { discover: true })
    expect(listPanes()).toEqual([])
    expect('learnedId' in plan).toBe(false)
  })

  test('Codex with discover: never discovers, no learnedId key', () => {
    const info = seed('codex', { adapter: fakeCodexAdapter(), codexThreadId: 'T1' })
    const plan = info.adapter.recoveryPlan(info, { discover: true })
    expect(listPanes()).toEqual([])
    expect('learnedId' in plan).toBe(false)
    expect(info.claudeSessionId).toBeUndefined()
  })
})

describe('killSession keepRecord: ended the way a crash leaves it', () => {
  test('the record stays, stamped dead and out of boot recovery, with its thread, launch settings and history closed', async () => {
    const info = seed('claude', { claudeSessionId: SID, launchCwd: '/tmp/fork-cwd', disallowedTools: ['Edit'] })
    registry.setThread(info.threadId, info.sessionId)
    await killSession(info, 'idle 7d, ended', { keepRecord: true })

    expect(tmux.calls().some(c => c.startsWith('kill-session'))).toBe(true)
    const kept = registry.get(info.sessionId)!
    expect(kept).toBe(info)
    expect(kept.deadAt).toBeDefined()
    expect(kept.suppressAutoRecover).toBe(true)
    expect(kept.launchCwd).toBe('/tmp/fork-cwd')
    expect(kept.disallowedTools).toEqual(['Edit'])
    expect(registry.getByThread(info.threadId)).toBe(info.sessionId)
    const entry = threadRegistry.get(info.threadId)!.sessionHistory.find(h => h.sessionId === info.sessionId)!
    expect(entry.endedAt).toBeDefined()
    expect(entry.claudeSessionId).toBe(SID)
    expect(sent).toContain('_idle 7d, ended_')
  })

  test('without it, the record is deleted as before', async () => {
    const info = seed('claude', { claudeSessionId: SID })
    await killSession(info, 'session ended')
    expect(registry.get(info.sessionId)).toBeUndefined()
  })

  // A real repo and worktree. forceWorktreeCleanup makes a plain kill destroy it whatever it holds.
  function worktree(): { repo: string; path: string; branch: string } {
    const root = mkdtempSync(join(tmpdir(), 'keep-record-wt-'))
    const repo = join(root, 'repo'), path = join(root, 'wt'), branch = 'wt/keep-record'
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    mkdirSync(repo)
    git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
    git('worktree', 'add', '-q', '-b', branch, path)
    return { repo, path, branch }
  }

  test('the worktree is kept, even with forceWorktreeCleanup; a plain kill destroys it', async () => {
    const kept = worktree(), gone = worktree()
    try {
      const a = seed('claude', { claudeSessionId: SID, worktreeRepo: kept.repo, worktreePath: kept.path, worktreeBranch: kept.branch, forceWorktreeCleanup: true })
      const b = seed('claude', { claudeSessionId: SID, worktreeRepo: gone.repo, worktreePath: gone.path, worktreeBranch: gone.branch, forceWorktreeCleanup: true })
      await killSession(a, 'idle 7d, ended', { keepRecord: true })
      await killSession(b, 'session ended')
      for (let i = 0; i < 50 && existsSync(gone.path); i++) await Bun.sleep(100)
      expect(existsSync(gone.path)).toBe(false)
      expect(existsSync(kept.path)).toBe(true)
    } finally {
      for (const w of [kept, gone]) rmSync(join(w.repo, '..'), { recursive: true, force: true })
    }
  }, 15_000)

  test('a tmux session that outlives the kill is still caught by the deferred kill, though the kept record has its name', async () => {
    const info = seed('claude', { claudeSessionId: SID })
    tmux.alive(info.tmuxName)  // kill-session "succeeds" but the session stays up
    await killSession(info, 'idle 7d, ended', { keepRecord: true })
    await Bun.sleep(3_300)
    expect(tmux.calls().filter(c => c === `kill-session -t ${info.tmuxName}`).length).toBe(2)
  }, 10_000)
})
