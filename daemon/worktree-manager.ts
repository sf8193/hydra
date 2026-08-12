// Unified worktree create/destroy — extracted from session-lifecycle.ts and build.ts.
// All git operations use async execFile to avoid blocking the event loop.

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { resolve } from 'path'
import { existsSync } from 'fs'

const execAsync = promisify(execFile)

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
  const repoDir = resolve(spawnCwd, repoName)
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

  // Clean up stale worktree/branch from previous runs
  try { await execAsync('git', ['-C', repoDir, 'worktree', 'remove', wtDir, '--force'], { timeout: 10_000 }) } catch {}
  try { await execAsync('git', ['-C', repoDir, 'worktree', 'prune'], { timeout: 5_000 }) } catch {}
  try { await execAsync('git', ['-C', repoDir, 'branch', '-D', branchName], { timeout: 5_000 }) } catch {}

  // Resolve base branch: current branch → origin default → main → master
  const baseBranch = await resolveBaseBranch(repoDir)

  // Create worktree
  try {
    await execAsync('git', ['-C', repoDir, 'worktree', 'add', '-b', branchName, wtDir, baseBranch], { timeout: 15_000 })
    process.stderr.write(`daemon: worktree: created ${wtDir} (branch ${branchName}) from ${baseBranch}\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to create worktree: ${msg}`)
  }

  return { repoDir, worktreePath: wtDir, branch: branchName, baseBranch }
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

/**
 * Destroy a worktree: run cleanup hook, remove worktree, prune, delete branch.
 * Best-effort — logs failures but doesn't throw. Safe to call if already gone.
 */
export async function destroyWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count unpushed commits on a branch. Returns 0 if branch doesn't exist
 * or has no unpushed commits.
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
    return 0
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
