import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'

// Suppress stderr noise from imports
process.stderr.write = (() => true) as any

import {
  listGitRepos,
  validateWorktreeTarget,
  suggestWorktreeFromCwd,
  factoryBuild,
  _setGitIO,
  _resetGitIO,
  type FactoryGitIO,
} from '../factory.js'

// A SPAWN_CWD-like root with a nested git repo at "Documents/hydra" — the exact
// shape that keeps biting the factory (bare "hydra" vs nested "Documents/hydra").
//
// Fixtures are built with plain fs (mkdir of a ".git" marker), NOT `git init`,
// and git behaviour is supplied by a fake that reads this real temp tree. This
// keeps the tests deterministic and immune to other suites globally mocking
// child_process (cli/__tests__/peek.test.ts does exactly that, and bun leaks
// mock.module across files).
let root: string
let nestedRepo: string      // <root>/Documents/hydra (a "repo": has a .git marker)
let plainDir: string        // <root>/Documents (not a repo)

/** Mark a directory as a git repo the way listGitRepos/the fake detect it. */
function markRepo(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
}

// Faithful fake git: reads the real temp filesystem, mirrors the two git
// invocations these functions make, and returns realpaths for --show-toplevel
// exactly as real git does (so the symlink handling is genuinely exercised).
const fakeGit: FactoryGitIO = {
  git(args: string[]): string {
    const ci = args.indexOf('-C')
    const dir = ci >= 0 ? args[ci + 1] : process.cwd()
    if (args.includes('rev-parse') && args.includes('--git-dir')) {
      if (existsSync(join(dir, '.git'))) return '.git'
      throw new Error(`not a git repository: ${dir}`)
    }
    if (args.includes('rev-parse') && args.includes('--show-toplevel')) {
      let d = dir
      // walk up to the nearest ancestor holding a .git marker
      for (;;) {
        if (existsSync(join(d, '.git'))) return realpathSync(d)
        const parent = dirname(d)
        if (parent === d) break
        d = parent
      }
      throw new Error(`not a git repository: ${dir}`)
    }
    throw new Error(`fakeGit: unexpected args ${args.join(' ')}`)
  },
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-safety-'))
  plainDir = join(root, 'Documents')
  nestedRepo = join(plainDir, 'hydra')
  markRepo(nestedRepo)
  markRepo(join(root, 'venture'))  // a second repo directly under root
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  _resetGitIO()
})

describe('listGitRepos (pure fs — no git)', () => {
  test('finds a nested repo at depth 2 and one at depth 1', () => {
    const repos = listGitRepos(root)
    expect(repos).toContain('Documents/hydra')
    expect(repos).toContain('venture')
  })

  test('returns repo paths relative to the scan root, never a bare name', () => {
    const repos = listGitRepos(root)
    expect(repos.every(r => !r.startsWith('/'))).toBe(true)
    expect(repos).not.toContain('hydra')
  })

  test('does not descend into a repo once found', () => {
    mkdirSync(join(nestedRepo, 'daemon'), { recursive: true })
    expect(listGitRepos(root)).not.toContain('Documents/hydra/daemon')
  })

  test('empty for a directory with no repos', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wt-empty-'))
    try {
      expect(listGitRepos(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('validateWorktreeTarget', () => {
  test('accepts a valid nested repo path', () => {
    _setGitIO(fakeGit)
    expect(validateWorktreeTarget('Documents/hydra', root)).toEqual({ ok: true })
  })

  test('rejects a bare name that resolves to a non-repo, listing available repos', () => {
    _setGitIO(fakeGit)
    const result = validateWorktreeTarget('hydra', root)
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('is not a git repo')
      expect(result.error).toContain('Documents/hydra')  // the correct target is surfaced
      expect(result.error).toContain('venture')
    }
  })

  test('rejects a fully nonexistent path', () => {
    _setGitIO(fakeGit)
    expect('error' in validateWorktreeTarget('does/not/exist', root)).toBe(true)
  })
})

describe('suggestWorktreeFromCwd', () => {
  test('suggests the nested path when the PM cwd is inside the repo', () => {
    _setGitIO(fakeGit)
    const deep = join(nestedRepo, 'daemon')
    mkdirSync(deep, { recursive: true })
    expect(suggestWorktreeFromCwd(deep, root)).toBe('Documents/hydra')
  })

  test('suggests from the repo root itself', () => {
    _setGitIO(fakeGit)
    expect(suggestWorktreeFromCwd(nestedRepo, root)).toBe('Documents/hydra')
  })

  test('returns undefined when the repo IS SPAWN_CWD — the root repo is not isolatable', () => {
    // createWorktree places the worktree at resolve(repoDir, '..', '.worktrees').
    // For a repo that IS spawnCwd, "." would put it ABOVE spawnCwd (e.g.
    // /Users/.worktrees, SIP-protected) — so suggest nothing rather than a
    // target that createWorktree can't build.
    _setGitIO(fakeGit)
    const repoRoot = mkdtempSync(join(tmpdir(), 'wt-selfroot-'))
    markRepo(repoRoot)
    try {
      expect(suggestWorktreeFromCwd(repoRoot, repoRoot)).toBeUndefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('returns undefined when the PM cwd is not a git repo', () => {
    _setGitIO(fakeGit)
    expect(suggestWorktreeFromCwd(plainDir, root)).toBeUndefined()
  })

  test('returns undefined when the repo is not under SPAWN_CWD', () => {
    _setGitIO(fakeGit)
    const foreign = mkdtempSync(join(tmpdir(), 'wt-foreign-'))
    try {
      expect(suggestWorktreeFromCwd(nestedRepo, foreign)).toBeUndefined()
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })
})

describe('factoryBuild worktree validation (sync, pre-spawn)', () => {
  test('returns a sync error for an invalid worktree — no ticket, no spawn', () => {
    const saved = process.env.SPAWN_CWD
    process.env.SPAWN_CWD = root
    _setGitIO(fakeGit)
    try {
      // fresh=true bypasses the fork/claudeSessionId requirement, so we reach
      // the worktree validation without populating the registry.
      const result = factoryBuild({
        pmThreadId: 'thread-x',
        pmSessionId: 'sess-x',
        spec: 'noop',
        worktree: 'hydra',        // the classic bare-name mistake
        fresh: true,
      })
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('is not a git repo')
        expect(result.error).toContain('Documents/hydra')
      }
    } finally {
      if (saved === undefined) delete process.env.SPAWN_CWD
      else process.env.SPAWN_CWD = saved
    }
  })

  test('errors when SPAWN_CWD is unset', () => {
    const saved = process.env.SPAWN_CWD
    delete process.env.SPAWN_CWD
    try {
      const result = factoryBuild({
        pmThreadId: 'thread-x',
        pmSessionId: 'sess-x',
        spec: 'noop',
        worktree: 'hydra',
        fresh: true,
      })
      expect('error' in result).toBe(true)
      if ('error' in result) expect(result.error).toContain('SPAWN_CWD not set')
    } finally {
      if (saved !== undefined) process.env.SPAWN_CWD = saved
    }
  })
})
