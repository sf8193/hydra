// What an `access = "workdir"` specialist's folder may not be. Run when hydra.toml loads (so `hydra config check` and the
// daemon agree) and again at every scoped launch (the folder can change after the load).

import { dirname, join, resolve, sep } from 'path'
import type { LoadEnv } from './types.js'

/**
 * Places under the home folder that never belong to a scoped specialist: credential folders and files, and Claude's own account
 * state. A floor, not a complete inventory: what is known to hold secrets. Any other place (another browser, an app's data) is for the
 * operator to add to `[defaults] private_roots`.
 */
const PRIVATE_HOME_DIRS = ['.claude', '.claude.json', '.ssh', '.config', '.aws', '.kube', '.gnupg', 'Library/Keychains', '.netrc', '.npmrc', '.docker', '.git-credentials', '.pgpass', '.zsh_history', '.bash_history', 'Library/Cookies', 'Library/Safari', 'Library/Application Support/Google', 'Library/Application Support/Firefox']

/** A place a scoped specialist must not know: `label` says what it is in a refusal, `path` is where. */
export type PrivateRoot = { label: string; path: string }

/**
 * The one list of places a scoped specialist must not know: home credentials, Claude's config folder, the state folder and the
 * files in it that hold secrets, and the operator's own `[defaults] private_roots`. The workdir check refuses a folder in or
 * around any of them, and the sandbox a listed server runs under (server-sandbox.ts) denies the same paths.
 */
export function offLimitRoots(env: Pick<LoadEnv, 'home' | 'stateDir' | 'claudeConfigDir'>, operatorRoots: readonly string[]): PrivateRoot[] {
  return [
    ...PRIVATE_HOME_DIRS.map((d): PrivateRoot => ({ label: `~/${d}`, path: join(env.home, d) })),
    { label: `${env.claudeConfigDir} (Claude's config folder, CLAUDE_CONFIG_DIR)`, path: env.claudeConfigDir },
    { label: `the state folder ${env.stateDir}`, path: env.stateDir },
    { label: join(env.stateDir, 'hydra.toml'), path: join(env.stateDir, 'hydra.toml') },
    { label: `${join(env.stateDir, '.env')} (its token file)`, path: join(env.stateDir, '.env') },
    ...operatorRoots.map((r): PrivateRoot => ({ label: `${r} (a private root in [defaults])`, path: r })),
  ]
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/**
 * Why `workdir` can't be a scoped specialist's folder: one sentence each, without the path of the key it came from.
 * Empty: it can. `operatorRoots` are the operator's own (`[defaults] private_roots`).
 */
export function workdirScopeIssues(env: LoadEnv, workdir: string, operatorRoots: readonly string[]): string[] {
  const real = (p: string) => env.realpath(p)
  const dir = real(resolve(workdir))
  if (dir === real(resolve(env.home))) return [`${workdir} is your whole home folder: a scoped specialist's folder must be its own`]
  for (const { label, path } of offLimitRoots(env, operatorRoots)) {
    const r = real(resolve(path))
    if (within(dir, r)) return [`${workdir} is inside ${label}, which holds what a scoped specialist must not know`]
    if (within(r, dir)) return [`${workdir} contains ${label}, which holds what a scoped specialist must not know`]
  }
  const issues: string[] = []
  if (env.isGitWorkTree(dir)) issues.push(`${workdir} is a git work tree: its history and every branch are in reach of anyone who can talk to it; give the specialist a folder of its own, outside any repository`)
  const scan = env.scanWorkdir(dir)
  if (scan.nestedGit.length) issues.push(`${workdir} holds a git repository (${scan.nestedGit[0]}${scan.nestedGit.length > 1 ? ` and ${scan.nestedGit.length - 1} more` : ''}): its history is in reach of anyone who can talk to this specialist; remove it, or give the specialist a folder with no repository in it`)
  if (env.exists(join(dir, '.mcp.json'))) issues.push(`${workdir} holds a .mcp.json, which would declare servers the specialist did not list: remove it, or declare the server in [mcp.*] and list it`)
  // Claude Code reads a .mcp.json from the folders above the one it starts in; --restricted ignores them today, which is a flag's behaviour, not a promise.
  for (let up = dirname(dir); ; up = dirname(up)) {
    if (env.exists(join(up, '.mcp.json'))) { issues.push(`${workdir} sits under a .mcp.json (${join(up, '.mcp.json')}): Claude Code reads that file for sessions started below it, and --restricted only happens to ignore it; move the folder, or remove the file`); break }
    if (dirname(up) === up) break
  }
  if (scan.escapingSymlinks.length) issues.push(`${scan.escapingSymlinks[0]}${scan.escapingSymlinks.length > 1 ? ` (and ${scan.escapingSymlinks.length - 1} more)` : ''} is a symlink that resolves outside ${workdir}: a scoped specialist's folder must not lead anywhere else`)
  // A scan that stopped at its cap has not seen the rest: that is a refusal, not a pass.
  if (scan.truncated) issues.push(`${workdir} has more entries than can be checked for symlinks that leave it: use a smaller folder`)
  return issues
}
