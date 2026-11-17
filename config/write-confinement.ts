// `can_only_write_to` and `cannot_read`: a specialist that runs the operator's tools and account, but whose Bash and Edit/Write writes are
// confined to its own folder (Claude Code's sandboxed Bash and its write block, set in the launch's settings). The words and
// the small rules both the loader and the launch share live here, so `hydra config check` and the launch say the same thing.

/** The one place name `can_only_write_to` takes. A place, not a level: more may follow (a list of folders), so the key holds the place. */
export const CAN_ONLY_WRITE_TO_VALUES = ['workdir'] as const
export type CanOnlyWriteTo = typeof CAN_ONLY_WRITE_TO_VALUES[number]

/** The two folders a write-confined specialist's browser gets, inside its workdir. */
export const BROWSER_DIR = '.browser'
/** The profile folder a specialist's browser server gets: the one it names (`browser_profile`, resolved), else `<workdir>/.browser/profile`. */
export const browserProfileDir = (workdir: string, named?: string): string => named ?? `${workdir.replace(/\/+$/, '')}/${BROWSER_DIR}/profile`
/** Its download folder: `<workdir>/.browser/downloads` by default; beside a named profile, `<profile>-downloads` (never inside it: a profile is the browser's to rewrite). */
export const browserDownloadDir = (workdir: string, named?: string): string => named ? `${named.replace(/\/+$/, '')}-downloads` : `${workdir.replace(/\/+$/, '')}/${BROWSER_DIR}/downloads`

/**
 * The folder, inside a write-confined specialist's workdir, where the files people send it are saved (the shared inbox under the state folder is denied to it).
 * The daemon makes it (0700) and writes to it; the specialist can write there too, so nothing found in it is trusted (shared/confined-inbox.ts).
 */
export const INBOX_DIR_NAME = '.inbox'
/**
 * What one specialist's inbox may hold. The file size is the attachment limit (daemon/access.ts MAX_ATTACHMENT_BYTES, pinned equal by a test); a full folder
 * refuses the next file and says so. The daemon never deletes inside it by age: it is the specialist's own folder, and a folder swapped for a link would turn a sweep into a delete.
 */
export const INBOX_LIMITS = { maxFileBytes: 25 * 1024 * 1024, maxFiles: 200, maxTotalBytes: 500 * 1024 * 1024 } as const
export type InboxLimits = { maxFileBytes: number; maxFiles: number; maxTotalBytes: number }

/** What `[mcp_servers.<name>] profile_args` and `profile_env` may name. */
export const PROFILE_PLACEHOLDERS = ['{profile_dir}', '{download_dir}'] as const

/** `text` with each placeholder replaced by the specialist's folder for it. */
export const fillProfile = (text: string, workdir: string, named?: string): string => {
  // One pass: a folder whose name happens to hold `{download_dir}` is not substituted a second time. (`unquotablePath` refuses only control characters, so braces are allowed in a name.)
  const profile = browserProfileDir(workdir, named), downloads = browserDownloadDir(workdir, named)
  return text.replace(/\{(profile_dir|download_dir)\}/g, (_m, k: string) => (k === 'profile_dir' ? profile : downloads))
}

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

/** Where a managed (organization-delivered) MCP config lives, per platform. Absent is the usual case. */
export const MANAGED_MCP_FILES = ['/Library/Application Support/ClaudeCode/managed-mcp.json', '/etc/claude-code/managed-mcp.json']

/**
 * The listed servers whose name a managed MCP config (`managed-mcp.json`) also declares, with the file, and the files that could not be read. This is the one place a
 * same-named server can stand in for the listed one: Claude Code admits a managed file's entries without listing them and lets the file take exclusive control of MCP
 * servers, and its log shows names only, so the start check would pass a server of the right name running another command. (Not proven live: the file sits in a
 * root-owned folder.) The operator's own config (`~/.claude.json`, a `.mcp.json`) is not here: the allowlist admits a stdio server by its exact command, so a same-named
 * server with another command does not start and cannot take the listed one's place (write-confinement-mcp.live.test.ts, #774). A file that exists and cannot be read or
 * parsed is reported, never treated as empty.
 */
export function managedMcpNameClashes(env: { mcpNamesIn(path: string): string[] }, listed: readonly string[]): { clashes: { name: string; file: string }[]; unreadable: { file: string; why: string }[] } {
  const clashes: { name: string; file: string }[] = [], unreadable: { file: string; why: string }[] = []
  for (const file of MANAGED_MCP_FILES) {
    let here: string[]
    try { here = env.mcpNamesIn(file) } catch (err) { unreadable.push({ file, why: err instanceof Error ? err.message : String(err) }); continue }
    for (const name of listed) if (here.includes(name)) clashes.push({ name, file })
  }
  return { clashes, unreadable }
}

/** The built-in tools Claude Code has that a `tools` list may name (checked by `hydra config check`: a name outside this list is warned about, because a typo would leave the session without the tool it meant). */
export const KNOWN_BUILTIN_TOOLS = ['Agent', 'Artifact', 'ArtifactComments', 'ArtifactData', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit', 'EndConversation', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'ListMcpResourcesTool', 'LSP', 'Monitor', 'NotebookEdit', 'PowerShell', 'PublishPlugin', 'PushNotification', 'Read', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendFeedback', 'SendMessage', 'ShareOnboardingGuide', 'Skill', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Workflow', 'Write'] as const

/** Claude Code's rule for reading a path: `Read(//abs/path/**)`. */
export const readDenyRule = (root: string): string => `Read(/${root}/**)`

/**
 * What a write-confined specialist can still reach, said at the level it has: the guarantee (writes by Bash and by Edit/Write stay
 * in the folder) and, in the same breath, what it does not give. Never the word "safe". The `hydra config check` warning for a
 * write-confined specialist someone else can reach.
 */
export const confinementWarning = (workdir: string): string =>
  `can reach the operator's account: Bash and Edit/Write writes are confined to ${workdir}, and Claude Code's tools and shell cannot read the credential folders (~/.ssh, ~/.aws and the like), hydra's state folder or other specialists' workdirs; ~/Library/Keychains is one of those folders, so \`security\` and git's keychain helper fail in its shell (shown with a throwaway keychain; login keychain: not proven live; the git helper cannot be told apart on the real one without writing an item; a store the keychain service holds without a file is not separately blocked); the browser and MCP servers can read them; the daemon attaches, for it, only a file in its folder or temp folder that is in none of those places, and it holds no tool that reaches another session (spawn, list, peek, kill, send_to_thread, handoff, watch, bind) and uses its reading and reply tools only in its own conversation; and other reads, network, MCP servers' own writes and credentials are not confined; it sees only the MCP servers it lists (hydra's bridge aside), and a listed server that declares a profile folder uses its own profile in the folder browser_profile names, else ${workdir}/.browser/profile, while one that declares none keeps its default; files people send it are saved in ${workdir}/.inbox, a folder the daemon makes (0700) in its own folder, and the message names the path (the shared inbox is denied to it). Credential separation (run_as) is planned, not built.`

/** What a bridge tool's `files` check needs: the session's folder and temp folder, the places its tools are denied, and how a path resolves. */
export type FileSendEnv = { workdir: string; tmpDir: string; deny: readonly string[]; realpath: (p: string) => string }

/** The one refusal, whatever the cause (absent, outside, denied, a link that leads out): it must not tell the session which of them it was, or where a link leads. */
export const fileRefusal = (path: string): string =>
  `${path} is not attached: a write-confined session attaches only a file in its own folder or temp folder that it can read`

/**
 * Whether a write-confined session may attach `path` with a bridge tool. The bridge posts with the daemon's own file access, outside the sandbox
 * that holds the session's shell and Read tool, so the daemon asks what the session could read itself: the file, as it resolves (symlinks followed,
 * a relative path being its folder's, `~` not expanded), lies in the session's folder or temp folder and in none of the places `readDenyRoots`
 * denies. Returns the resolved path, or the refusal's text (one text for every cause).
 * This is the decision on a string; the daemon opens what it decides on once and sends a copy (daemon/write-confinement.ts `snapshotConfinedFiles`).
 */
export function fileSendDecision(path: string, env: FileSendEnv): { path: string; refusal?: undefined } | { path?: undefined; refusal: string } {
  const abs = path.startsWith('/') ? path : `${trim(env.workdir)}/${path}`
  let real: string
  try { real = trim(env.realpath(abs)) } catch { return { refusal: fileRefusal(path) } }
  if (env.deny.some(d => within(real, trim(d)))) return { refusal: fileRefusal(path) }
  const homes = [env.workdir, env.tmpDir].map(p => { try { return trim(env.realpath(trim(p))) } catch { return trim(p) } })
  if (!homes.some(h => within(real, h))) return { refusal: fileRefusal(path) }
  return { path: real }
}

/**
 * Why a `browser_profile` cannot be this specialist's profile folder, or undefined. It must lie inside the workdir (resolved): the folder holds the
 * specialist's logins, and the layer's promise is that what it keeps is in its own folder; a browser server runs outside the sandbox and could write
 * anywhere the operator can, so this key names the folder, it does not confine the browser. It may not be the workdir itself, nor hold or sit in the
 * default `.browser` folder, nor in a place the layer denies reading (the session's own tools could not read what its browser wrote there).
 */
export function browserProfileProblem(workdir: string, profile: string, realpath: (p: string) => string, denied: readonly string[]): string | undefined {
  const dir = trim(realpath(trim(profile))), root = trim(realpath(trim(workdir)))
  if (dir === root) return `${profile} is the workdir itself: a browser profile is rewritten wholesale, so it needs a folder of its own inside it`
  if (!within(dir, root)) return `${profile} is not inside the workdir ${workdir}: a profile outside it would keep the specialist's logins outside its own folder`
  if (within(dir.toLowerCase(), `${root}/${BROWSER_DIR}`.toLowerCase()) || within(`${root}/${BROWSER_DIR}`.toLowerCase(), dir.toLowerCase())) return `${profile} is, holds or sits in ${root}/${BROWSER_DIR}, the folder of the default profile and downloads: name another`
  const hit = unreadableWorkdir(dir, denied, realpath)
  if (hit) return `${profile} is, or holds, ${hit}, which the layer denies reading`
  return undefined
}

/** A folder as a filesystem sees it for comparing: resolved, and case-folded (APFS and most Macs are case-insensitive: `Chrome` and `chrome` are one folder). */
export const canonicalFolder = (p: string, realpath: (p: string) => string): string => trim(realpath(trim(p))).toLowerCase()

/** Two folders that are, hold or sit in one another would share what a browser locks (compared as `canonicalFolder`). */
export const browserProfilesOverlap = (a: string, b: string, realpath: (p: string) => string = p => p): boolean => {
  const x = canonicalFolder(a, realpath), y = canonicalFolder(b, realpath)
  return within(x, y) || within(y, x)
}
