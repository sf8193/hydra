// Unified worktree create/destroy — extracted from session-lifecycle.ts and build.ts.
// All git operations use async execFile to avoid blocking the event loop.

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { resolve } from 'path'
import { existsSync } from 'fs'

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
    // Clean up stale worktree/branch from previous runs
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
 */
export async function destroyWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void> {
  // Serialize per-repo so a destroy can't race a concurrent add/reattach on the same repo.
  await withRepoLock(repoDir, async () => {
    // Skip if worktree dir is already gone
    if (!existsSync(worktreePath)) {
      process.stderr.write(`daemon: worktree: ${worktreePath} already gone, skipping destroy\n`)
      // Still try to prune + delete branch (may be orphaned)
      try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}
      try { await execAsync('git', ['-C', repoDir, 'branch', '-D', branch], { timeout: 5_000 }) } catch {}
      return
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
