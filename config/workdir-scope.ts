// What an `access = "workdir"` specialist's folder may not be. Run when hydra.toml loads (so `hydra config check` and the
// daemon agree) and again at every scoped launch (the folder can change after the load).

import { dirname, join, resolve, sep } from 'path'
import type { LoadEnv } from './types.js'

/** Folders under the home folder that never belong to a scoped specialist: credentials and Claude's own account state. */
const PRIVATE_HOME_DIRS = ['.claude', '.ssh', '.config']

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/**
 * Why `workdir` can't be a scoped specialist's folder: one sentence each, without the path of the key it came from.
 * Empty: it can. `privateRoots` are the operator's own (`[defaults] private_roots`).
 */
export function workdirScopeIssues(env: LoadEnv, workdir: string, privateRoots: readonly string[]): string[] {
  const real = (p: string) => env.realpath(p)
  const dir = real(resolve(workdir))
  if (dir === real(resolve(env.home))) return [`${workdir} is your whole home folder: a scoped specialist's folder must be its own`]
  const roots: [string, string][] = [
    ...PRIVATE_HOME_DIRS.map((d): [string, string] => [`~/${d}`, join(env.home, d)]),
    [`${env.claudeConfigDir} (Claude's config folder, CLAUDE_CONFIG_DIR)`, env.claudeConfigDir],
    [`the state folder ${env.stateDir}`, env.stateDir],
    [join(env.stateDir, 'hydra.toml'), join(env.stateDir, 'hydra.toml')],
    [`${join(env.stateDir, '.env')} (its token file)`, join(env.stateDir, '.env')],
    ...privateRoots.map((r): [string, string] => [`${r} (a private root in [defaults])`, r]),
  ]
  for (const [label, root] of roots) {
    const r = real(resolve(root))
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
