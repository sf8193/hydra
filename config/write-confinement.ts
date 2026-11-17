// `can_only_write_to` and `cannot_read`: a specialist that runs the operator's tools and account, but whose Bash and Edit/Write writes are
// confined to its own folder (Claude Code's sandboxed Bash and its write block, set in the launch's settings). The words and
// the small rules both the loader and the launch share live here, so `hydra config check` and the launch say the same thing.

/** The one place name `can_only_write_to` takes. A place, not a level: more may follow (a list of folders), so the key holds the place. */
export const CAN_ONLY_WRITE_TO_VALUES = ['workdir'] as const
export type CanOnlyWriteTo = typeof CAN_ONLY_WRITE_TO_VALUES[number]

/** The two folders a write-confined specialist's browser gets, inside its workdir. */
export const BROWSER_DIR = '.browser'
export const browserProfileDir = (workdir: string): string => `${workdir.replace(/\/+$/, '')}/${BROWSER_DIR}/profile`
export const browserDownloadDir = (workdir: string): string => `${workdir.replace(/\/+$/, '')}/${BROWSER_DIR}/downloads`

/** What `[mcp_servers.<name>] profile_args` and `profile_env` may name. */
export const PROFILE_PLACEHOLDERS = ['{profile_dir}', '{download_dir}'] as const

/** `text` with each placeholder replaced by the specialist's folder for it. */
export const fillProfile = (text: string, workdir: string): string =>
  text.replaceAll('{profile_dir}', browserProfileDir(workdir)).replaceAll('{download_dir}', browserDownloadDir(workdir))

/** The placeholder-looking words in `text` that are not one of the two (`{nope}`), or []. */
export const unknownPlaceholders = (text: string): string[] =>
  (text.match(/\{[^{}]*\}/g) ?? []).filter(p => !(PROFILE_PLACEHOLDERS as readonly string[]).includes(p))

export const hasPlaceholder = (text: string): boolean => (PROFILE_PLACEHOLDERS as readonly string[]).some(p => text.includes(p))

/**
 * The operator's credential places under the home folder that Claude Code's tools and shell are denied for a specialist with `can_only_write_to`:
 * ssh, cloud and registry credentials, the GitHub CLI's token, the keychain, gpg, and the browsers' own profiles (logins, cookies, saved passwords).
 * Not the same list as a restricted specialist's (restricted-workdir.ts): that one is a floor for a stranger and denies all of `~/.config` and Claude's
 * own folder, which an operator's own tools need.
 */
export const CREDENTIAL_HOME_DIRS = ['.ssh', '.aws', '.config/gh', '.config/gcloud', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', 'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge']

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')
const trim = (p: string): string => p.length > 1 ? p.replace(/\/+$/, '') : p

/** What the layer needs to know of the machine: the home and state folders, and how a path resolves (a symlink counts as the place it leads to). */
export type DenyEnv = { home: string; stateDir: string; realpath: (p: string) => string }

/**
 * Every place the layer denies reading, absolute and in a fixed order: the built-in credential places, hydra's whole state folder (its token
 * file, config, every session's generated MCP config with the token values in it, queued messages, Claude's account state when it sits there),
 * the operator's `cannot_read` additions, and the workdirs of the other specialists (a workdir that holds, or sits in, this specialist's own
 * is left out: it could not be denied without denying the specialist its own folder). Each is listed as written and as it resolves, because
 * the sandbox matches resolved paths.
 */
export function readDenyRoots(env: DenyEnv, workdir: string, otherWorkdirs: readonly string[], extra: readonly string[]): string[] {
  const own = trim(env.realpath(trim(workdir)))
  const others = otherWorkdirs.map(trim).filter(w => { const r = env.realpath(w); return r !== own && !within(own, r) && !within(r, own) })
  const written = [...CREDENTIAL_HOME_DIRS.map(d => `${trim(env.home)}/${d}`), trim(env.stateDir), ...extra.map(trim), ...others]
  return [...new Set(written.flatMap(p => [p, env.realpath(p)]))]
}

/** The root a folder sits in or around that cannot be denied (a specialist cannot be denied its own folder), or undefined. Compared as resolved. */
export function unreadableWorkdir(workdir: string, roots: readonly string[], realpath: (p: string) => string = p => p): string | undefined {
  const dir = trim(realpath(trim(workdir)))
  return roots.find(r => within(dir, trim(realpath(r))) || within(trim(realpath(r)), dir))
}

/** Claude Code's rule for reading a path: `Read(//abs/path/**)`. */
export const readDenyRule = (root: string): string => `Read(/${root}/**)`

/**
 * What a write-confined specialist can still reach, said at the level it has: the guarantee (writes by Bash and by Edit/Write stay
 * in the folder) and, in the same breath, what it does not give. Never the word "safe". The `hydra config check` warning for a
 * write-confined specialist someone else can reach.
 */
export const confinementWarning = (workdir: string): string =>
  `can reach the operator's account: Bash and Edit/Write writes are confined to ${workdir}, and Claude Code's tools and shell cannot read the credential folders (~/.ssh, ~/.aws and the like), hydra's state folder or other specialists' workdirs; the browser and MCP servers can, and other reads, network, MCP servers' own writes and credentials are not confined; only a listed server that declares a profile folder uses its own profile in ${workdir}, and servers from the operator's ~/.claude.json or plugins still load and keep theirs; attachments sent to it are unreadable (the shared inbox is denied). Credential separation (run_as) is planned, not built.`
