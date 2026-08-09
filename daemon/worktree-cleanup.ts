import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname } from 'path'
import { registry } from './sessions.js'
import { isAlive } from './util.js'

const execFileAsync = promisify(execFile)

// Location of the main repo — worktrees live adjacent to it.
const MAIN_REPO_DIR = join(import.meta.dir, '..')

type CleanupResult = { removed: string[]; failed: string[]; skipped: string[] }

type WorktreeEntry = {
  path: string
  branch: string | null
  head: string | null
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry)
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null }
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
    } else if (line === '') {
      if (current.path) entries.push(current as WorktreeEntry)
      current = {}
    }
  }
  if (current.path) entries.push(current as WorktreeEntry)
  return entries
}

function isActiveSession(worktreePath: string): boolean {
  // Match via SessionInfo.worktreePath
  for (const s of registry.values()) {
    if (s.worktreePath && s.worktreePath === worktreePath && isAlive(s)) return true
  }

  // Match by extracting session name from directory pattern: <repo>-<sessionName>
  // e.g. /path/to/discord-bot-custom-cedar → "cedar"
  const dir = basename(worktreePath)
  const repoBase = basename(MAIN_REPO_DIR)
  const prefix = repoBase + '-'
  if (dir.startsWith(prefix)) {
    const sessionName = dir.slice(prefix.length)
    for (const s of registry.values()) {
      if (s.tmuxName === sessionName && isAlive(s)) return true
    }
  }

  return false
}

export async function scanStaleWorktrees(): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], failed: [], skipped: [] }

  let output: string
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: MAIN_REPO_DIR,
      timeout: 10_000,
    })
    output = stdout
  } catch (err) {
    process.stderr.write(`daemon: worktree-cleanup: failed to list worktrees: ${err}\n`)
    return result
  }

  const entries = parseWorktreeList(output)

  for (const entry of entries) {
    // Skip the main worktree (no branch prefix wt/ or bare/detached without wt/)
    if (entry.path === MAIN_REPO_DIR) continue

    // Only manage worktrees with wt/ branches — those are hydra-managed
    const branch = entry.branch ?? ''
    if (!branch.includes('refs/heads/wt/') && !branch.includes('wt/')) {
      result.skipped.push(entry.path)
      continue
    }

    // Check if any live session claims this worktree
    if (isActiveSession(entry.path)) {
      result.skipped.push(entry.path)
      continue
    }

    // No live session — attempt removal
    process.stderr.write(`daemon: worktree-cleanup: removing stale worktree: ${entry.path}\n`)

    let removed = false

    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', entry.path], {
        cwd: MAIN_REPO_DIR,
        timeout: 15_000,
      })
      removed = true
    } catch (gitErr) {
      process.stderr.write(`daemon: worktree-cleanup: git remove failed for ${entry.path}: ${gitErr}\n`)
    }

    if (!removed) {
      // Fallback: rm -rf + prune
      try {
        await execFileAsync('rm', ['-rf', entry.path], { timeout: 30_000 })
        await execFileAsync('git', ['worktree', 'prune'], { cwd: MAIN_REPO_DIR, timeout: 10_000 })
        removed = true
      } catch (rmErr) {
        process.stderr.write(`daemon: worktree-cleanup: rm -rf fallback failed for ${entry.path}: ${rmErr}\n`)
      }
    }

    if (removed) {
      result.removed.push(entry.path)
      process.stderr.write(`daemon: worktree-cleanup: removed ${entry.path}\n`)
    } else {
      result.failed.push(entry.path)
      process.stderr.write(`daemon: worktree-cleanup: FAILED to remove ${entry.path} — manual cleanup required\n`)
    }
  }

  return result
}

export function startWorktreeCleanupTimer(intervalMs = 30 * 60 * 1000): void {
  // Delay first scan to let daemon boot complete
  setTimeout(() => {
    void runScan()
    setInterval(() => { void runScan() }, intervalMs)
  }, 60_000)
}

async function runScan(): Promise<void> {
  process.stderr.write('daemon: worktree-cleanup: starting stale worktree scan\n')
  try {
    const result = await scanStaleWorktrees()
    const total = result.removed.length + result.failed.length + result.skipped.length
    process.stderr.write(
      `daemon: worktree-cleanup: scan complete — ${total} worktrees examined, ` +
      `${result.removed.length} removed, ${result.failed.length} failed, ${result.skipped.length} skipped\n`,
    )
    if (result.failed.length > 0) {
      process.stderr.write(`daemon: worktree-cleanup: failed removals: ${result.failed.join(', ')}\n`)
    }
  } catch (err) {
    process.stderr.write(`daemon: worktree-cleanup: scan error: ${err}\n`)
  }
}
