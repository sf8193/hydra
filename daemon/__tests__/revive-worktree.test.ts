// Pins where a revived or handed-off session works when it had a worktree (#916): the worktree, put back if its folder was
// pruned, and never the main checkout. `resume` and boot recovery decide it in one place (resolveWorktree in reviveThread),
// and a handoff whose new session fails to start puts the old record back, so `respawn` still lands in the worktree.
// The executors are stubbed (nothing is spawned); git is real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway } from '../../infra/config.js'
import { migrateWorktree, registry, threadRegistry, type SessionInfo, type ThreadSessionEntry } from '../../sessions/registry.js'
import { engines } from '../../sessions/engine-instances.js'
import { autoRecoverAfterBoot, handleRecoverIntercept, reviveThread, _resetRecoveryDeps, _setRecoveryDeps } from '../../app/recovery.js'
import { handleResumeIntercept, handleRespawnIntercept } from '../../app/commands/thread.js'
import { handOff, handoffIO, killsInProgress } from '../../app/session-lifecycle.js'
import type { InboundMessage } from '../../gateways/gateway.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const THREAD = 'thread-rw'
let root = '', repo = '', wtPath = ''
let fake: FakeTmux
let sent: string[] = []
let calls: Array<{ fn: string; opts: any }> = []
let others: SessionInfo[] = []
let seq = 0
const orig = { send: gateway.send, react: gateway.react, edit: gateway.edit, persist: registry.persist, tpersist: threadRegistry.persist, handoff: { ...handoffIO } }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim()

beforeAll(() => {
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: `m${sent.length}` } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})
afterAll(() => {
  Object.assign(gateway, { send: orig.send, react: orig.react, edit: orig.edit })
  ;(registry as any).persist = orig.persist
  ;(threadRegistry as any).persist = orig.tpersist
})

beforeEach(() => {
  fake = withFakeTmux()
  others = [...registry.values()]
  for (const i of others) registry.delete(i.sessionId)
  sent = []; calls = []
  root = mkdtempSync(join(tmpdir(), 'revive-wt-'))
  repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
  wtPath = join(root, '.worktrees', 'repo-rw')
  git(repo, 'worktree', 'add', '-q', '-b', 'wt/rw-old', wtPath, 'main')
  _setRecoveryDeps({
    tryResume: async (dead: any) => { calls.push({ fn: 'tryResume', opts: dead }); return { name: 'resumed', sessionId: 's-new', threadId: THREAD, url: '' } as any },
    doSpawnSession: async (_t: string, _c?: string, _m?: string, opts?: any) => { calls.push({ fn: 'doSpawnSession', opts }); return { name: 'spawned', sessionId: 's-new', threadId: THREAD, url: '' } as any },
    tryRespawn: async (_th: string, _p: string, _n: any, _m: any, opts?: any) => { calls.push({ fn: 'tryRespawn', opts }); return { name: 'respawned', sessionId: 's-new', threadId: THREAD, url: '' } as any },
  })
})

afterEach(() => {
  _resetRecoveryDeps()
  Object.assign(handoffIO, orig.handoff)
  for (const i of [...registry.values()]) registry.delete(i.sessionId)
  registry.deleteThread(THREAD)
  threadRegistry.threads.delete(THREAD)
  for (const i of others) registry.set(i.sessionId, i)
  fake.restore()
  rmSync(root, { recursive: true, force: true })
})

function msg(content: string): InboundMessage {
  return {
    id: `msg-rw-${++seq}`, channelId: THREAD, authorId: 'u1', authorUsername: 'op', content, isDM: false, isThread: true, isBot: false,
    parentChannelId: 'parent-rw', hasExistingThread: false, existingThreadId: null, referenceMessageId: null, effectiveThreadId: THREAD,
    attachments: [], createdAt: new Date(),
  }
}

/** A dead session in THREAD that worked in the worktree; its tmux name differs from the branch's (it was revived once before). */
function seedDead(): SessionInfo {
  const entry = { sessionId: 'sess-rw', tmuxName: 'rw-now', originType: 'resurrect', startedAt: 1, endedAt: 2, messageCount: 3, claudeSessionId: 'C-rw' } as ThreadSessionEntry
  threadRegistry.threads.set(THREAD, { threadId: THREAD, topic: 'the topic', threadUrl: 'https://x/rw', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [entry] })
  const info = {
    sessionId: 'sess-rw', topic: 'the topic', threadId: THREAD, createdAt: 1, lastActive: 1, tmuxName: 'rw-now', listening: false,
    sessionType: 'thread_owner', engine: 'claude', adapter: engines.claude, deadAt: 3, claudeSessionId: 'C-rw',
    worktree: { repo, path: wtPath, branch: 'wt/rw-old' },
  } as SessionInfo
  registry.set(info.sessionId, info)
  registry.setThread(THREAD, info.sessionId)
  return info
}

/** The folder is pruned while the session is dead; `branchToo` deletes its branch as well (merged and cleaned up). */
function prune(branchToo = false): void {
  rmSync(wtPath, { recursive: true, force: true })
  git(repo, 'worktree', 'prune')
  if (branchToo) git(repo, 'branch', '-D', 'wt/rw-old')
}

/** Every directory a stubbed start was told to work in. */
const placesStarted = () => calls.map(c => c.opts?.worktree?.path ?? c.opts?.reuseWorktree?.path ?? 'NO WORKTREE (main checkout)')

describe('a revive of a session whose worktree folder was pruned', () => {
  test('resume: the folder is put back on its branch, and the session resumes there', async () => {
    seedDead(); prune()
    await handleResumeIntercept(msg('resume'))
    expect(existsSync(wtPath)).toBe(true)
    expect(git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/rw-old')
    expect(calls.map(c => c.fn)).toEqual(['tryResume'])
    expect(placesStarted()).toEqual([wtPath])
  })

  test('resume with the branch gone too: refused, nothing started, the record kept as it was and the thread told why', async () => {
    const info = seedDead(); prune(true)
    await handleResumeIntercept(msg('resume'))
    expect(calls).toEqual([])
    expect(registry.get(info.sessionId)).toBe(info)
    expect(info.suppressAutoRecover).toBeUndefined()   // by hand it only refuses
    expect(sent.join('\n')).toContain('`resume` failed: the session\'s worktree')
    expect(sent.join('\n')).toContain('never restarted in the main checkout')
  })

  test('respawn with the branch gone and no folder named for a fresh start: refused the same way', async () => {
    seedDead(); prune(true)
    await handleRespawnIntercept(msg('respawn'))
    expect(calls).toEqual([])
    expect(sent.join('\n')).toContain('never restarted in the main checkout')
  })

  test('the branch gone, and the caller names a folder (a specialist\'s workdir): a fresh start there, no resume, no worktree', async () => {
    seedDead(); prune(true)
    const workdir = join(root, 'workdir'); mkdirSync(workdir)
    const outcome = await reviveThread({ thread: threadRegistry.get(THREAD)!, cwd: workdir })
    expect(outcome.ok).toBe(true)
    expect(calls.map(c => c.fn)).toEqual(['tryRespawn'])
    expect(calls[0].opts.cwd).toBe(workdir)
    expect(calls[0].opts.reuseWorktree).toBeUndefined()
  })

  test('the folder cannot be put back just now (its branch is there): refused, nothing torn down, try again', async () => {
    const info = seedDead(); prune()
    rmSync(join(root, '.worktrees'), { recursive: true, force: true })
    writeFileSync(join(root, '.worktrees'), 'not a folder')   // `git worktree add` fails; the branch is still there
    await handleResumeIntercept(msg('resume'))
    expect(calls).toEqual([])
    expect(registry.get(info.sessionId)).toBe(info)
    expect(git(repo, 'rev-parse', '--verify', '-q', 'wt/rw-old')).not.toBe('')
    expect(sent.join('\n')).toContain('could not be put back just now')
  })

  test('`recover` and resume agree: the same reattach, the same refusal; recover also stops boot retries', async () => {
    seedDead(); prune()
    await handleRecoverIntercept(msg('recover rw-now'), 'rw-now')
    expect(existsSync(wtPath)).toBe(true)
    expect(placesStarted()).toEqual([wtPath])

    for (const i of [...registry.values()]) registry.delete(i.sessionId)
    calls = []; sent = []
    rmSync(wtPath, { recursive: true, force: true }); git(repo, 'worktree', 'prune')
    const info = seedDead(); git(repo, 'branch', '-D', 'wt/rw-old')
    await handleRecoverIntercept(msg('recover rw-now'), 'rw-now')
    expect(calls).toEqual([])
    expect(info.suppressAutoRecover).toBe(true)
    expect(sent.join('\n')).toContain('never restarted in the main checkout')
  })

  test('the automatic recovery at boot: reattached, and started in the worktree', async () => {
    const env = { a: process.env.HYDRA_AUTO_RECOVER, s: process.env.SPAWN_CWD }
    process.env.HYDRA_AUTO_RECOVER = '1'; process.env.SPAWN_CWD = root
    try {
      seedDead(); prune()
      await autoRecoverAfterBoot()
      expect(existsSync(wtPath)).toBe(true)
      expect(placesStarted()).toEqual([wtPath])
    } finally {
      for (const [k, v] of [['HYDRA_AUTO_RECOVER', env.a], ['SPAWN_CWD', env.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })
})

describe('a handoff whose new session fails to start', () => {
  test('the old record is put back, and `respawn` then starts in its worktree', async () => {
    const info = seedDead()
    delete info.deadAt
    // As the real kill: the record goes, and its guard stays set until the deferred kill runs.
    handoffIO.killSession = (async (i: SessionInfo) => { killsInProgress.add(i.sessionId); registry.delete(i.sessionId); registry.deleteThread(i.threadId) }) as any
    handoffIO.doSpawnSession = (async () => { throw new Error('launch failed') }) as any
    await expect(handOff(info, '/tmp/letter.md')).rejects.toThrow('launch failed')

    const back = registry.get(info.sessionId)
    expect(back?.worktree).toEqual({ repo, path: wtPath, branch: 'wt/rw-old' })
    expect(back?.deadAt).toBeNumber()
    expect(registry.getByThread(THREAD)).toBe(info.sessionId)
    expect(killsInProgress.has(info.sessionId)).toBe(false)   // a `respawn` that replaces it kills it for real

    await handleRespawnIntercept(msg('respawn'))
    expect(calls.map(c => c.fn)).toEqual(['tryRespawn'])
    expect(placesStarted()).toEqual([wtPath])
  })
})

describe('the persisted shape', () => {
  test('a record from before `worktree` loads with its three fields as one value', () => {
    const raw = { tmuxName: 'n', worktreeRepo: '/r', worktreePath: '/p', worktreeBranch: 'wt/b' } as any
    expect(migrateWorktree(raw)).toEqual({ tmuxName: 'n', worktree: { repo: '/r', path: '/p', branch: 'wt/b' } })
  })

  test('a record from before stored branches gets the one branch name hydra then made', () => {
    expect(migrateWorktree({ tmuxName: 'n', worktreeRepo: '/r', worktreePath: '/p' } as any).worktree).toEqual({ repo: '/r', path: '/p', branch: 'wt/n' })
  })

  test('half a worktree is no worktree; a record without one is unchanged', () => {
    expect(migrateWorktree({ tmuxName: 'n', worktreePath: '/p' } as any)).toEqual({ tmuxName: 'n' })
    expect(migrateWorktree({ tmuxName: 'n' } as any)).toEqual({ tmuxName: 'n' })
  })
})
