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

/** Where a managed (organization-delivered) MCP config lives, per platform. Absent is the usual case. */
export const MANAGED_MCP_FILES = ['/Library/Application Support/ClaudeCode/managed-mcp.json', '/etc/claude-code/managed-mcp.json']

/**
 * The files an operator's own MCP servers are declared in, which Claude Code reads for the session: its user config (`~/.claude.json` and the one in
 * CLAUDE_CONFIG_DIR, each with the entries for the workdir's project), a `.mcp.json` in the workdir or in any folder above it (Claude Code walks up from
 * its working directory), and the managed file. Plugins' servers carry a `plugin:` key and cannot share a plain name.
 */
export function operatorMcpFiles(env: { home: string; claudeConfigDir: string; realpath?: (p: string) => string }, workdir: string): { file: string; projects: string[] }[] {
  const real = env.realpath ?? ((p: string) => p)
  const dirs = [...new Set([trim(workdir), trim(real(trim(workdir)))])]
  const files: { file: string; projects: string[] }[] = [`${trim(env.home)}/.claude.json`, `${trim(env.claudeConfigDir)}/.claude.json`].map(file => ({ file, projects: dirs }))
  const up = new Set<string>()
  for (const d of dirs) for (let p = d; ; p = p.slice(0, p.lastIndexOf('/')) || '/') { up.add(`${p === '/' ? '' : p}/.mcp.json`); if (p === '/') break }
  return [...files, ...[...up].map(file => ({ file, projects: [] as string[] })), ...MANAGED_MCP_FILES.map(file => ({ file, projects: [] as string[] }))]
}

/**
 * The listed servers whose name an operator's own MCP config also declares, with the file, and the files that could not be read. Claude Code's allowlist
 * matches by name and its log shows names only, so such a server of the operator's would be admitted too, and could take the place of the one hydra
 * starts with its own profile. A file that exists and cannot be read or parsed is reported, never treated as empty.
 */
export function operatorMcpNameClashes(env: { home: string; claudeConfigDir: string; realpath?: (p: string) => string; mcpNamesIn(path: string, projects?: readonly string[]): string[] }, workdir: string, listed: readonly string[]): { clashes: { name: string; file: string }[]; unreadable: { file: string; why: string }[] } {
  const clashes: { name: string; file: string }[] = [], unreadable: { file: string; why: string }[] = []
  for (const { file, projects } of operatorMcpFiles(env, workdir)) {
    let here: string[]
    try { here = env.mcpNamesIn(file, projects) } catch (err) { unreadable.push({ file, why: err instanceof Error ? err.message : String(err) }); continue }
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
  `can reach the operator's account: Bash and Edit/Write writes are confined to ${workdir}, and Claude Code's tools and shell cannot read the credential folders (~/.ssh, ~/.aws and the like), hydra's state folder or other specialists' workdirs; ~/Library/Keychains is one of those folders, so \`security\` and git's keychain helper fail in its shell (shown with a throwaway keychain; login keychain: not proven live; the git helper cannot be told apart on the real one without writing an item; a store the keychain service holds without a file is not separately blocked); the browser and MCP servers can read them; the daemon attaches, for it, only a file in its folder or temp folder that is in none of those places, and it holds no tool that reaches another session (spawn, list, peek, kill, send_to_thread, handoff, watch, bind) and uses its reading and reply tools only in its own conversation; and other reads, network, MCP servers' own writes and credentials are not confined; it sees only the MCP servers it lists (hydra's bridge aside), and a listed server that declares a profile folder uses its own profile in ${workdir} while one that declares none keeps its default; attachments sent to it are unreadable (the shared inbox is denied). Credential separation (run_as) is planned, not built.`

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
