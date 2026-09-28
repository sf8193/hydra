// Unified worktree create/destroy — extracted from session-lifecycle.ts and build.ts.
// All git operations use async execFile to avoid blocking the event loop.

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { dirname, join, resolve } from 'path'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs'

const execAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Per-repo serialization — `git worktree add`/`remove`/`prune` all take the repo's
// worktree admin lock, so concurrent ops on the same repo (e.g. two same-repo sessions
// revived in one recovery wave) race and one fails with a lock error. Chain per-repoDir
// so they run one-at-a-time; different repos still run concurrently.
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>()

function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoDir) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  repoLocks.set(repoDir, tail)
  // Drop the entry once this op settles, but only if nothing newer chained onto it — otherwise
  // the map would pin the last op's closed-over values per repo forever. If a later op already
  // replaced the tail, leave it (that op owns cleanup).
  void tail.then(() => { if (repoLocks.get(repoDir) === tail) repoLocks.delete(repoDir) })
  return run
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorktreeConfig = {
  repoName: string      // e.g. "options_bot"
  spawnCwd: string      // e.g. "/Users/sam/trading"
  branchName: string    // e.g. "wt/vale" or "sf/build-topic"
  dirSuffix: string     // e.g. "options_bot-vale" or "options_bot-build-abc123"
}

export type WorktreeResult = {
  repoDir: string       // absolute path to the repo
  worktreePath: string  // absolute path to the worktree dir
  branch: string        // the branch name created
  baseBranch: string    // the branch it was created from
}

// ---------------------------------------------------------------------------
// Validation — shared by factory_build (sync pre-check) and createWorktree
// ---------------------------------------------------------------------------

/**
 * Resolve a worktree target to an absolute repo path and verify it contains a
 * git repo. Single source of truth so factory_build's early check and
 * createWorktree's actual creation can never disagree on resolution.
 */
export function resolveAndValidateRepo(repoName: string, spawnCwd: string): string {
  const base = resolve(spawnCwd)
  const repoDir = resolve(base, repoName)
  // Mirror validateWorktreeTarget's bounds check: the target must be strictly
  // nested under SPAWN_CWD, else createWorktree's resolve(repoDir, '..', '.worktrees')
  // escapes above/outside the sandbox. This is the true sink — guard here protects
  // every caller (factory_build, spawn_session), not just the factory pre-check.
  if (repoDir === base || !repoDir.startsWith(base + '/')) {
    throw new Error(`worktree target "${repoName}" resolves to ${repoDir}, not a repo nested under SPAWN_CWD (${base}) — the root repo cannot be isolated and out-of-bounds paths are refused`)
  }
  try {
    execFileSync('git', ['-C', repoDir, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
  } catch {
    throw new Error(`worktree target "${repoName}" is not a git repo at ${repoDir}`)
  }
  return repoDir
}

// ---------------------------------------------------------------------------
// The one "nothing to lose" guard — every path that deletes a worktree or branch
// asks it first: no uncommitted/untracked changes, no rebase/merge/cherry-pick/
// revert/bisect in progress, HEAD and the named branch fully on a remote.
// Gitignored files (node_modules, build output) are disposable. Returns why the
// work is at risk (unverifiable counts as at risk), or null when it's safe to delete.
// ---------------------------------------------------------------------------

export async function workAtRisk(repoDir: string, worktreePath: string, branch?: string): Promise<string | null> {
  try {
    if (existsSync(worktreePath)) {
      const git = (...args: string[]) => execAsync('git', ['-C', worktreePath, ...args], { timeout: 10_000 }).then(r => r.stdout.trim())
      if (await git('status', '--porcelain')) return 'uncommitted changes'
      const gitDir = await git('rev-parse', '--absolute-git-dir') // all these markers are per-worktree
      const midOp = ['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'].filter(f => existsSync(join(gitDir, f)))
      if (midOp.length) return `operation in progress (${midOp.join(', ')})`
      const unpushed = Number(await git('rev-list', '--count', 'HEAD', '--not', '--remotes'))
      if (unpushed > 0) return `${unpushed} unpushed commit(s)`
    }
    if (branch) {
      const n = await checkUnpushedCommits(repoDir, branch)
      if (n > 0) return `${n} unpushed commit(s) on ${branch}`
      if (n < 0) return `could not verify ${branch}`
    }
    return null
  } catch (err) {
    return `could not verify (${err instanceof Error ? err.message.split('\n')[0] : err})`
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create an isolated git worktree. Cleans up stale worktree/branch from
 * previous runs, resolves the base branch, and creates a new worktree.
 * Throws on failure (caller should handle).
 */
export async function createWorktree(config: WorktreeConfig): Promise<WorktreeResult> {
  const { repoName, spawnCwd, branchName, dirSuffix } = config
  const repoDir = resolveAndValidateRepo(repoName, spawnCwd)

  const wtDir = resolve(repoDir, '..', '.worktrees', dirSuffix)

  // Serialize per-repo so concurrent spawns/recoveries on the same repo don't race the
  // worktree admin lock.
  const baseBranch = await withRepoLock(repoDir, async () => {
    // Clean up stale worktree/branch from previous runs — unless they hold work (a
    // killed session's worktree is kept then, and its name may be reused).
    const risk = await workAtRisk(repoDir, wtDir, branchName)
    if (risk) throw new Error(`worktree ${wtDir} / branch ${branchName} was kept from an earlier session (${risk}) — remove it or spawn under another name`)
    try { await execAsync('git', ['-C', repoDir, 'worktree', 'remove', wtDir, '--force'], { timeout: 10_000 }) } catch {}
    try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}
    try { await execAsync('git', ['-C', repoDir, 'branch', '-D', branchName], { timeout: 5_000 }) } catch {}

    // Resolve base branch: current branch → origin default → main → master
    const base = await resolveBaseBranch(repoDir)

    // Create worktree
    try {
      await execAsync('git', ['-C', repoDir, 'worktree', 'add', '-b', branchName, wtDir, base], { timeout: 15_000 })
      process.stderr.write(`daemon: worktree: created ${wtDir} (branch ${branchName}) from ${base}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to create worktree: ${msg}`)
    }
    return base
  })

  return { repoDir, worktreePath: wtDir, branch: branchName, baseBranch }
}

// 'attached' = worktree now materialized at the path; 'branch-gone' = the branch no
// longer exists (nothing to preserve); 'failed' = the branch DOES exist but `worktree
// add` failed (stale registration, lock, FS hiccup) — transient/retryable, and the
// caller must keep the worktree metadata so the branch isn't orphaned + later reaped.
export type ReattachResult = 'attached' | 'branch-gone' | 'failed'

/**
 * Recovery: re-materialize a worktree dir for an EXISTING branch when the dir was
 * removed while the session was dead but the branch (and its unpushed commits) may
 * still exist. Uses `worktree add <path> <branch>` (no -b) to attach to the existing
 * branch, preserving its commits — never creates a fresh branch.
 */
export async function reattachWorktree(repoDir: string, worktreePath: string, branch: string): Promise<ReattachResult> {
  // Do BOTH the branch-exists check and the `worktree add` under the same per-repo lock, so no
  // concurrent daemon worktree op (createWorktree / destroyWorktree — both lock-serialized) can
  // delete the branch between the check and the add. This closes the daemon-internal TOCTOU; an
  // EXTERNAL `git branch -D` (outside the daemon's lock) is still possible and is classified
  // correctly by the post-add re-verify below.
  return withRepoLock(repoDir, async () => {
    // Branch must exist to reattach — otherwise there's nothing to preserve.
    try {
      await execAsync('git', ['-C', repoDir, 'rev-parse', '--verify', branch], { timeout: 5_000 })
    } catch {
      // rev-parse failed — distinguish "branch genuinely absent" (terminal → branch-gone) from
      // "repo itself unreachable" (dir/volume not ready at boot, lock, timeout → transient
      // 'failed', retryable; don't forget the branch). A false branch-gone is non-destructive:
      // the caller suppresses + skips (branch/worktree stay on disk, manual `recover` works),
      // dropping only the session's re-addable PR watches — never code.
      try { await execAsync('git', ['-C', repoDir, 'rev-parse', '--git-dir'], { timeout: 5_000 }) } catch { return 'failed' }
      return 'branch-gone'
    }
    try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}
    try {
      await execAsync('git', ['-C', repoDir, 'worktree', 'add', worktreePath, branch], { timeout: 15_000 })
      process.stderr.write(`daemon: worktree: reattached ${worktreePath} → existing branch ${branch}\n`)
      return 'attached'
    } catch (err) {
      // Add failed though the branch verified moments ago under this same lock. No daemon op
      // could have removed it (lock held), so this is either an EXTERNAL `git branch -D` (→ the
      // re-verify sees it gone → branch-gone) or a transient add failure with the branch still
      // present (→ failed, retryable). Re-verify to tell them apart.
      try {
        await execAsync('git', ['-C', repoDir, 'rev-parse', '--verify', branch], { timeout: 5_000 })
      } catch {
        try { await execAsync('git', ['-C', repoDir, 'rev-parse', '--git-dir'], { timeout: 5_000 }) } catch { return 'failed' }
        process.stderr.write(`daemon: worktree: reattach ${worktreePath} — branch ${branch} vanished during add — treating as branch-gone\n`)
        return 'branch-gone'
      }
      // Branch still exists — transient add failure. Retryable.
      process.stderr.write(`daemon: worktree: reattach add failed for ${worktreePath} (${branch} still present, retryable): ${err instanceof Error ? err.message : err}\n`)
      return 'failed'
    }
  })
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

/**
 * Destroy a worktree: run cleanup hook, remove worktree, prune, delete branch.
 * Best-effort — logs failures but doesn't throw. Safe to call if already gone.
 * Work at risk (see workAtRisk) is kept, not destroyed: returns why, else null.
 */
export async function destroyWorktree(repoDir: string, worktreePath: string, branch: string): Promise<string | null> {
  // Serialize per-repo so a destroy can't race a concurrent add/reattach on the same repo.
  return withRepoLock(repoDir, async () => {
    const risk = await workAtRisk(repoDir, worktreePath, branch)
    if (risk) {
      process.stderr.write(`daemon: worktree: kept ${worktreePath} (${branch}): ${risk}\n`)
      return risk
    }
    // Skip if worktree dir is already gone
    if (!existsSync(worktreePath)) {
      process.stderr.write(`daemon: worktree: ${worktreePath} already gone, skipping destroy\n`)
      // Still try to prune + delete branch (may be orphaned)
      try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}
      try { await execAsync('git', ['-C', repoDir, 'branch', '-D', branch], { timeout: 5_000 }) } catch {}
      return null
    }

    // Run cleanup hook if present
    const cleanupScript = `${worktreePath}/bin/dev/on-worktree-remove.sh`
    if (existsSync(cleanupScript)) {
      try {
        await execAsync(cleanupScript, [branch.split('/').pop() ?? branch], { timeout: 10_000 })
        process.stderr.write(`daemon: worktree: ran cleanup hook for ${worktreePath}\n`)
      } catch (err) {
        process.stderr.write(`daemon: worktree: cleanup hook failed: ${err instanceof Error ? err.message : err}\n`)
      }
    }

    // Remove worktree
    try {
      await execAsync('git', ['-C', repoDir, 'worktree', 'remove', worktreePath, '--force'], { timeout: 10_000 })
      process.stderr.write(`daemon: worktree: removed ${worktreePath}\n`)
    } catch {
      // Fallback: rm -rf if git remove fails (only for paths inside .worktrees/)
      if (worktreePath.includes('/.worktrees/') && existsSync(worktreePath)) {
        try {
          await execAsync('rm', ['-rf', worktreePath], { timeout: 10_000 })
          process.stderr.write(`daemon: worktree: rm -rf ${worktreePath} (git remove failed)\n`)
        } catch (err) {
          process.stderr.write(`daemon: worktree: rm -rf also failed: ${err instanceof Error ? err.message : err}\n`)
        }
      }
    }

    // Prune stale worktree metadata
    try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}

    // Delete branch
    try {
      await execAsync('git', ['-C', repoDir, 'branch', '-D', branch], { timeout: 5_000 })
      process.stderr.write(`daemon: worktree: deleted branch ${branch}\n`)
    } catch {}
    return null
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count unpushed commits on a branch. Returns 0 if the branch has no unpushed commits
 * OR genuinely doesn't exist; returns -1 if the count couldn't be determined (transient
 * git/repo error while the branch DOES exist) so callers can warn conservatively rather
 * than silently treat "unknown" as "safe to delete".
 */
export async function checkUnpushedCommits(repoDir: string, branch: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      'git', ['-C', repoDir, 'log', branch, '--not', '--remotes', '--oneline'],
      { timeout: 5_000 },
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    return lines.length
  } catch {
    // Distinguish "branch absent → 0, nothing to lose" from "branch present but the count
    // failed → -1, unknown". If even rev-parse fails, treat as absent (0).
    try {
      await execAsync('git', ['-C', repoDir, 'rev-parse', '--verify', branch], { timeout: 5_000 })
      return -1
    } catch {
      return 0
    }
  }
}

/**
 * Resolve the base branch: current branch → origin default → main → master.
 * Falls back to 'main' if everything fails.
 */
async function resolveBaseBranch(repoDir: string): Promise<string> {
  // Try current branch first (preserves feature-branch context for forks)
  try {
    const { stdout } = await execAsync('git', ['-C', repoDir, 'branch', '--show-current'], { timeout: 5_000 })
    const current = stdout.trim()
    if (current) return current
  } catch {}

  // Try origin default
  try {
    const { stdout } = await execAsync('git', ['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5_000 })
    const ref = stdout.trim().replace('refs/remotes/origin/', '')
    if (ref) return ref
  } catch {}

  // Try main, fall back to master
  try {
    await execAsync('git', ['-C', repoDir, 'rev-parse', '--verify', 'main'], { timeout: 5_000 })
    return 'main'
  } catch {
    return 'master'
  }
}

// ---------------------------------------------------------------------------
// Session scratchpad worktrees — `git worktree add`s a Claude session made on its
// own under its scratchpad (<tmp>/claude-<uid>/<project>/<session id>/scratchpad).
// Hydra never recorded them, so without this they outlive the session forever.
// ---------------------------------------------------------------------------

export function sessionScratchpads(claudeSessionId: string, root = `/private/tmp/claude-${process.getuid?.() ?? 0}`): string[] {
  try {
    return readdirSync(root).map(p => join(root, p, claudeSessionId, 'scratchpad')).filter(d => existsSync(d))
  } catch { return [] }
}

// Linked worktrees (a `.git` FILE) directly in dir or one level below. Symlinks are
// never followed, and every hit must really live inside dir: nothing outside the
// session's scratchpad can be reached.
function worktreesIn(dir: string): string[] {
  const found: string[] = []
  let base: string
  try { base = realpathSync(dir) + '/' } catch { return found }
  const visit = (d: string, depth: number) => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      try { const st = lstatSync(p); if (st.isSymbolicLink() || !st.isDirectory() || !realpathSync(p).startsWith(base)) continue } catch { continue }
      try { if (statSync(join(p, '.git')).isFile()) { found.push(p); continue } } catch {}
      if (depth < 1) visit(p, depth + 1)
    }
  }
  visit(dir, 0)
  return found
}

/**
 * Remove the worktrees under dirs that hold nothing to lose: no uncommitted or
 * untracked changes, no rebase/merge/cherry-pick/revert/bisect in progress, and every
 * commit on HEAD is on a remote. Anything else is kept and reported. Branches are left
 * alone. Gitignored files (node_modules, build output) are treated as disposable.
 */
export async function cleanScratchWorktrees(dirs: string[]): Promise<{ removed: string[]; kept: Array<{ path: string; reason: string }> }> {
  const removed: string[] = []
  const kept: Array<{ path: string; reason: string }> = []
  for (const wt of dirs.flatMap(worktreesIn)) {
    try {
      const risk = await workAtRisk(wt, wt)
      if (risk) { if (existsSync(wt)) kept.push({ path: wt, reason: risk }); continue } // gone meanwhile: another kill got it
      const commonDir = (await execAsync('git', ['-C', wt, 'rev-parse', '--git-common-dir'], { timeout: 10_000 })).stdout.trim()
      const repo = dirname(resolve(wt, commonDir))
      await withRepoLock(repo, () => execAsync('git', ['-C', repo, 'worktree', 'remove', wt], { timeout: 10_000 }))
      removed.push(wt)
    } catch (err) {
      if (existsSync(wt)) kept.push({ path: wt, reason: `could not verify (${err instanceof Error ? err.message.split('\n')[0] : err})` })
    }
  }
  return { removed, kept }
}
