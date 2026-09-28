// Kill cleans up worktrees a session made under its own scratchpad, but only ones
// holding nothing to lose (clean, every commit on a remote).

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanScratchWorktrees, sessionScratchpads } from '../worktree-manager.js'

const root = mkdtempSync(join(tmpdir(), 'scratch-wt-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
// Bun.spawnSync, not child_process: another test file mock.module()s child_process for the whole run.
const run = (...args: string[]) => {
  const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const git = (cwd: string, ...args: string[]) => run('git', '-C', cwd, ...args)

function repoWithRemote(): string {
  const remote = join(root, 'remote.git'), repo = join(root, 'repo')
  run('git', 'init', '-q', '--bare', remote)
  run('git', 'init', '-q', '-b', 'main', repo)
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  return repo
}

describe('scratchpad worktree cleanup', () => {
  test('removes clean pushed worktrees; keeps dirty, untracked and unpushed ones', async () => {
    const repo = repoWithRemote()
    const scratch = join(root, 'proj', 'sess-1', 'scratchpad')
    mkdirSync(join(scratch, 'nested'), { recursive: true })
    const wt = (name: string) => { const p = join(scratch, name); git(repo, 'worktree', 'add', '-q', '--detach', p, 'origin/main'); return p }
    const clean = wt('clean')
    const nested = wt('nested/clean2')
    const dirty = wt('dirty'); writeFileSync(join(dirty, 'new.txt'), 'x')
    const ahead = wt('ahead'); git(ahead, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'local')

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

  test('never follows a symlink out of the scratchpad; keeps a worktree mid-rebase', async () => {
    const repo = join(root, 'repo')
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
