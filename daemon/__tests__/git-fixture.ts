import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { TEST_STATE_DIR } from '../../test-setup.js'

function run(...args: string[]): string {
  const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
  const out = r.stdout.toString().trim()
  if (r.exitCode !== 0) {
    throw new Error(`${args.join(' ')} exited ${r.exitCode}: ${r.stderr.toString().trim() || out}`)
  }
  return out
}

export const git = (cwd: string, ...args: string[]): string => run('git', '-C', cwd, ...args)

export const gitInit = (dir: string, ...args: string[]): string => run('git', 'init', '-q', ...args, dir)

export const gitCommit = (cwd: string, message: string, ...args: string[]): string =>
  git(cwd, 'commit', '-q', '-m', message, ...args)

export function fixtureRoot(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(TEST_STATE_DIR, `${prefix}-`))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
