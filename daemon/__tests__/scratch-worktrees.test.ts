// Kill cleans up worktrees a session made under its own scratchpad, but only ones
// holding nothing to lose (clean, every commit on a remote).

import { describe, test, expect, afterAll, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cleanScratchWorktrees, createWorktree, destroyWorktree, sessionScratchpads } from '../worktree-manager.js'
import * as worktreeManager from '../worktree-manager.js'
import { scratchSessionIds, splitOwnFromHistory, killSession } from '../session-lifecycle.js'
import type { SessionInfo } from '../sessions.js'
import { threadRegistry } from '../sessions.js'
import { fixtureRoot, git, gitCommit, gitInit } from './git-fixture.js'

const { path: root, cleanup } = fixtureRoot('scratch-wt')
afterAll(cleanup)

function repoWithOrigin(base: string, name: string): string {
  const remote = join(base, `${name}-remote.git`), repo = join(base, name)
  gitInit(remote, '--bare')
  gitInit(repo, '-b', 'main')
  gitCommit(repo, 'init', '--allow-empty')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  return repo
}

const repoWithRemote = (): string => repoWithOrigin(mkdtempSync(join(root, 'rwr-')), 'repo')

describe('scratchpad worktree cleanup', () => {
  test('removes clean pushed worktrees; keeps dirty, untracked and unpushed ones', async () => {
    const repo = repoWithRemote()
    const scratch = join(root, 'proj', 'sess-1', 'scratchpad')
    mkdirSync(join(scratch, 'nested'), { recursive: true })
    const wt = (name: string) => { const p = join(scratch, name); git(repo, 'worktree', 'add', '-q', '--detach', p, 'origin/main'); return p }
    const clean = wt('clean')
    const nested = wt('nested/clean2')
    const dirty = wt('dirty'); writeFileSync(join(dirty, 'new.txt'), 'x')
    const ahead = wt('ahead'); gitCommit(ahead, 'local', '--allow-empty')

    expect(sessionScratchpads('sess-1', root)).toEqual([scratch])
    const r = await cleanScratchWorktrees(sessionScratchpads('sess-1', root))

    expect(r.removed.sort()).toEqual([clean, nested].sort())
    expect(existsSync(clean)).toBe(false)
    expect(r.kept).toEqual(expect.arrayContaining([
      { path: dirty, reason: 'uncommitted changes' },
      { path: ahead, reason: '1 unpushed commit(s)' },
    ]))
    expect(existsSync(dirty) && existsSync(ahead)).toBe(true)
    expect(git(repo, 'worktree', 'list')).not.toContain(clean)
  })

  test('force=true removes a dirty/unpushed scratch worktree that would otherwise be kept', async () => {
    const repo = repoWithRemote()
    const scratch = join(root, 'proj', 'sess-force', 'scratchpad')
    mkdirSync(scratch, { recursive: true })
    const wt = (name: string) => { const p = join(scratch, name); git(repo, 'worktree', 'add', '-q', '--detach', p, 'origin/main'); return p }
    const dirty = wt('dirty'); writeFileSync(join(dirty, 'new.txt'), 'x')

    const unforced = await cleanScratchWorktrees(sessionScratchpads('sess-force', root))
    expect(unforced.kept).toEqual([{ path: dirty, reason: 'uncommitted changes' }])
    expect(existsSync(dirty)).toBe(true)

    const forced = await cleanScratchWorktrees(sessionScratchpads('sess-force', root), true)
    expect(forced.removed).toEqual([dirty])
    expect(forced.kept).toEqual([])
    expect(existsSync(dirty)).toBe(false)
  })

  test('never follows a symlink out of the scratchpad; keeps a worktree mid-rebase', async () => {
    const repo = repoWithRemote()
    const outside = join(root, 'outside-wt')
    git(repo, 'worktree', 'add', '-q', '--detach', outside, 'origin/main')
    const scratch = join(root, 'proj', 'sess-3', 'scratchpad')
    mkdirSync(scratch, { recursive: true })
    symlinkSync(outside, join(scratch, 'link-to-wt'))
    symlinkSync(root, join(scratch, 'link-to-parent'))
    const rebasing = join(scratch, 'rebasing')
    git(repo, 'worktree', 'add', '-q', '--detach', rebasing, 'origin/main')
    mkdirSync(join(git(rebasing, 'rev-parse', '--absolute-git-dir'), 'rebase-merge'))

    const r = await cleanScratchWorktrees(sessionScratchpads('sess-3', root))
    expect(r.removed).toEqual([])
    expect(existsSync(outside)).toBe(true)
    expect(r.kept).toEqual([{ path: rebasing, reason: 'operation in progress (rebase-merge)' }])
  })

  test('another session\'s scratchpad is never touched', () => {
    mkdirSync(join(root, 'proj', 'other', 'scratchpad'), { recursive: true })
    expect(sessionScratchpads('sess-2', root)).toEqual([])
  })
})

describe('whose scratchpads a kill cleans', () => {
  const rec = (over: Record<string, unknown>) => ({ sessionId: 'x', tmuxName: 'x', threadId: 't', sessionType: 'thread_owner', ...over }) as any
  const history = [{ claudeSessionId: 'pred-1' }, {}, { claudeSessionId: 'pred-2' }, { claudeSessionId: 'me' }]

  test('a thread owner: itself plus its handoff predecessors', () => {
    const me = rec({ claudeSessionId: 'me' })
    expect(scratchSessionIds(me, [me], history).sort()).toEqual(['me', 'pred-1', 'pred-2'])
  })

  test('never a live session\'s scratchpad (e.g. a still-running predecessor id)', () => {
    const me = rec({ claudeSessionId: 'me' }), other = rec({ sessionId: 'y', claudeSessionId: 'pred-2' })
    expect(scratchSessionIds(me, [me, other], history).sort()).toEqual(['me', 'pred-1'])
  })

  test('a guest: only its own', () => {
    const guest = rec({ claudeSessionId: 'g', sessionType: 'thread_guest' })
    expect(scratchSessionIds(guest, [guest], history)).toEqual(['g'])
  })

  test('splitOwnFromHistory: force-cleanup opt-in must scope to only the killed session\'s own id, never a handoff predecessor\'s', () => {
    const me = rec({ claudeSessionId: 'me' })
    const all = scratchSessionIds(me, [me], history) // ['me', 'pred-1', 'pred-2']
    const { own, history: hist } = splitOwnFromHistory(all, me.claudeSessionId)
    expect(own).toEqual(['me'])
    expect(hist.sort()).toEqual(['pred-1', 'pred-2'])
  })

  test('splitOwnFromHistory: no own id (killed before discovery) — everything falls into history, nothing is forced', () => {
    const { own, history: hist } = splitOwnFromHistory(['pred-1', 'pred-2'], undefined)
    expect(own).toEqual([])
    expect(hist.sort()).toEqual(['pred-1', 'pred-2'])
  })
})

describe('Hydra worktrees: kept work is never destroyed later', () => {
  function workspace() {
    const base = mkdtempSync(join(root, 'ws-'))
    return { base, repo: repoWithOrigin(base, 'app') }
  }

  test('a name reused after its worktree was kept: the new one steps aside, the commit survives', async () => {
    const { base, repo } = workspace()
    const cfg = { repoName: 'app', spawnCwd: base, branchName: 'wt/vale', dirSuffix: 'app-vale' }
    const first = await createWorktree(cfg)
    gitCommit(first.worktreePath, 'unpushed work', '--allow-empty')
    const sha = git(first.worktreePath, 'rev-parse', 'HEAD')
    expect(await destroyWorktree(repo, first.worktreePath, cfg.branchName)).toContain('unpushed')
    const second = await createWorktree(cfg)
    expect(second.worktreePath).toBe(first.worktreePath + '-2')
    expect(second.branch).toBe('wt/vale-2')
    expect(git(repo, 'rev-parse', cfg.branchName)).toBe(sha)
    expect(existsSync(first.worktreePath)).toBe(true)
  })

  test('all five names hold kept work → createWorktree throws, touching none of them', async () => {
    const { base, repo } = workspace()
    const cfg = { repoName: 'app', spawnCwd: base, branchName: 'wt/full', dirSuffix: 'app-full' }
    // Seed the five kept worktrees with plain git, where createWorktree would put them. Building
    // them through createWorktree re-checked 1+2+3+4+5 names (~80 git processes), which ran past
    // bun's 5s test timeout under suite load; only the sixth call is under test.
    const branches = ['wt/full', 'wt/full-2', 'wt/full-3', 'wt/full-4', 'wt/full-5']
    const shas = branches.map((b, i) => {
      const path = join(base, '.worktrees', `app-full${i ? `-${i + 1}` : ''}`)
      git(repo, 'worktree', 'add', '-q', '-b', b, path, 'main')
      gitCommit(path, `kept ${i}`, '--allow-empty')
      return git(path, 'rev-parse', 'HEAD')
    })
    await expect(createWorktree(cfg)).rejects.toThrow(/all hold kept work/)
    expect(branches.map(b => git(repo, 'rev-parse', b))).toEqual(shas)
  })

  test('destroyWorktree keeps uncommitted changes and work on a branch the session switched to', async () => {
    const { base, repo } = workspace()
    const dirty = await createWorktree({ repoName: 'app', spawnCwd: base, branchName: 'wt/d', dirSuffix: 'app-d' })
    writeFileSync(join(dirty.worktreePath, 'wip.txt'), 'x')
    expect(await destroyWorktree(repo, dirty.worktreePath, 'wt/d')).toBe('uncommitted changes')
    expect(existsSync(dirty.worktreePath)).toBe(true)

    const switched = await createWorktree({ repoName: 'app', spawnCwd: base, branchName: 'wt/s', dirSuffix: 'app-s' })
    git(switched.worktreePath, 'switch', '-q', '-c', 'feature')
    gitCommit(switched.worktreePath, 'on another branch', '--allow-empty')
    expect(await destroyWorktree(repo, switched.worktreePath, 'wt/s')).toBe('1 unpushed commit(s)')

    const clean = await createWorktree({ repoName: 'app', spawnCwd: base, branchName: 'wt/c', dirSuffix: 'app-c' })
    expect(await destroyWorktree(repo, clean.worktreePath, 'wt/c')).toBeNull()
    expect(existsSync(clean.worktreePath)).toBe(false)
  })

  test('destroyWorktree with force=true removes uncommitted/unpushed work instead of keeping it', async () => {
    const { base, repo } = workspace()
    const dirty = await createWorktree({ repoName: 'app', spawnCwd: base, branchName: 'wt/fd', dirSuffix: 'app-fd' })
    writeFileSync(join(dirty.worktreePath, 'wip.txt'), 'x')
    expect(await destroyWorktree(repo, dirty.worktreePath, 'wt/fd', true)).toBeNull()
    expect(existsSync(dirty.worktreePath)).toBe(false)

    const unpushed = await createWorktree({ repoName: 'app', spawnCwd: base, branchName: 'wt/fu', dirSuffix: 'app-fu' })
    gitCommit(unpushed.worktreePath, 'unpushed work', '--allow-empty')
    expect(await destroyWorktree(repo, unpushed.worktreePath, 'wt/fu', true)).toBeNull()
    expect(existsSync(unpushed.worktreePath)).toBe(false)
  })
})

describe('killSession: forceWorktreeCleanup wiring', () => {
  const tick = () => new Promise(r => setTimeout(r, 0))

  test('reaches destroyWorktree, and the own scratch pass, but never the handoff-predecessor scratch pass', async () => {
    const destroyCalls: Array<{ force: boolean | undefined }> = []
    const scratchCalls: Array<{ ids: string[]; force: boolean | undefined }> = []
    const destroySpy = spyOn(worktreeManager, 'destroyWorktree').mockImplementation((async (_repo: string, _path: string, _branch: string, force?: boolean) => {
      destroyCalls.push({ force }); return null
    }) as any)
    const cleanSpy = spyOn(worktreeManager, 'cleanScratchWorktrees').mockImplementation((async (dirs: string[], force?: boolean) => {
      scratchCalls.push({ ids: dirs, force }); return { removed: [], kept: [] }
    }) as any)

    const threadId = 'kfc-thread'
    threadRegistry.set(threadId, {
      threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: 'pred', tmuxName: 'pred', originType: 'spawn', startedAt: 1, messageCount: 0, claudeSessionId: 'pred-1' }],
    } as any)

    const info = {
      sessionId: 'kfc-me', tmuxName: 'kfc', threadId, createdAt: Date.now(), lastActive: Date.now(),
      listening: false, engine: 'claude', sessionType: 'thread_owner', ephemeral: true,
      adapter: { stop: async () => {} }, claudeSessionId: 'me-2',
      worktreeRepo: '/fake/repo', worktreePath: '/fake/repo/../.worktrees/kfc', worktreeBranch: 'wt/kfc',
      forceWorktreeCleanup: true,
    } as unknown as SessionInfo

    try {
      await killSession(info, 'test')
      await tick(); await tick()

      expect(destroyCalls).toEqual([{ force: true }])
      // killSession invokes cleanScratchWorktrees(own, force) then cleanScratchWorktrees(history)
      // in that array-literal order — Promise.all preserves it, so index pins own vs. history.
      expect(scratchCalls.length).toBe(2)
      expect(scratchCalls[0].force).toBe(true)   // own (info.claudeSessionId): forced
      expect(scratchCalls[1].force).toBeUndefined() // history (the handoff predecessor): never forced
    } finally {
      destroySpy.mockRestore()
      cleanSpy.mockRestore()
      threadRegistry.threads.delete(threadId)
    }
  })
})
