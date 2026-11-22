// What a write-confined specialist's launch writes and checks (`can_only_write_to = "workdir"`): Claude Code's own controls, set in the launch's
// settings, and nothing hydra built itself. The policy is `LaunchPolicy.canOnlyWriteTo` (engines/launch-policy.ts); the one place it turns into a launch is
// `launchSession` in engines/claude-engine.ts, which every start passes (fresh, respawn, handoff successor, resume, fork).
//
//   sandbox.*                                     Claude Code's sandboxed Bash (Seatbelt): writes limited to the working directory and Claude Code's own per-user $TMPDIR (a shared /tmp is not writable; Claude Code's default, hydra sets neither).
//   permissions.blockWritesOutsideWorkingDirectories   Edit, Write and NotebookEdit refuse paths outside it, in every permission mode.
//   permissions.deny                              the operator's optional command deny list.
//   mcp config                                    the listed servers, started with their own browser profile and download folders.
//
// What it does not do is said in config/write-confinement.ts (the warning) and in docs/slack.md: reads, network, MCP servers' own writes and the
// operator's credentials stay open. MCP servers and the browser run outside Claude Code's sandbox.

import { spawnSync } from 'child_process'
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'fs'
import { basename, join } from 'path'
import { browserDownloadDir, browserProfileDir, fileRefusal, fileSendDecision, fillProfile, readDenyRule } from '../config/write-confinement.js'
import { CONFINED_TOOLS } from '../shared/constants.js'
import { UNIVERSAL_TOOLS } from '../shared/tool-definitions.js'
import { STATE_DIR } from '../infra/config.js'
import { MAX_ATTACHMENT_BYTES } from '../shared/constants.js'
import { expectedServerNames } from './claude-verify.js'
import { bridgeCommand } from '../infra/plugin-manifest.js'
import { readdirSync, readFileSync } from 'fs'
import { PolicyRefusal, missingTokenRefusal, remedy, serverToolRule, type ConfinementPolicy, type ConfinementServer, type LaunchPolicy } from './launch-policy.js'

/** The first Claude Code with `permissions.blockWritesOutsideWorkingDirectories`: an older one ignores the key, which would leave Edit/Write unconfined. */
export const MIN_CLAUDE_VERSION = [2, 1, 314] as const

/** The settings a write-confined launch passes with `--settings` (they sit above the user's, project and local files; only managed settings are above them). */
/** The rule that lets the sandbox's proxy reach any host: `sandbox.network.allowedDomains` refuses a bare `*` as too broad, but a `WebFetch(domain:*)` allow rule feeds the same allowlist (Claude Code 2.1.186+) and matches every host. */
export const NETWORK_ALLOW_RULE = 'WebFetch(domain:*)'

/** The MCP servers the session may see: hydra's bridge (its one way to the thread) and the servers its policy lists. Nothing else: not the operator's own, a plugin's, a project's or a claude.ai connector. */
export const confinementServers = (policy: Pick<ConfinementPolicy, 'servers'>): string[] => expectedServerNames(policy.servers)

/** The command Claude Code runs for a listed server, as the MCP config (`confinementMcp`) and the allowlist (`confinementSettings`) both say it: the one place its profile and download folders are filled in. */
export const confinementServerCommand = (policy: Pick<ConfinementPolicy, 'workdir' | 'browserProfile'>, s: Pick<ConfinementServer, 'command' | 'profileArgs'>): string[] =>
  [s.command, ...s.profileArgs.map(a => fillProfile(a, policy.workdir, policy.browserProfile))]

export function confinementSettings(policy: Pick<ConfinementPolicy, 'denyCommands' | 'cannotRead'> & ({ servers?: undefined } | Pick<ConfinementPolicy, 'servers' | 'workdir' | 'browserProfile'>) & { bridgeCommands?: readonly string[][] }): object {
  return {
    // Claude Code's own allowlist, which governs user/project/local config, --mcp-config, plugins and claude.ai connectors alike (not --strict-mcp-config: shown against the real Claude Code to drop a plugin's server, and the bridge is one; write-confinement-mcp.live.test.ts).
    // Every server by the exact command it runs: the listed ones with their folders filled in, the bridge once per plugin folder. Not by `serverName`: once any `serverCommand` entry exists (the bridge's), Claude Code 2.1.326 matches a stdio server by its full command only and a `serverName` entry no longer admits it (the server is dropped as "blocked by enterprise policy"; write-confinement-mcp.live.test.ts, Claude Code 2.1.326, #772). A name entry would also be dead weight. All servers here are stdio (`confinementMcp`), so there is no `serverUrl` case.
    allowedMcpServers: [...(policy.servers ?? []).map(s => ({ serverCommand: confinementServerCommand(policy as Pick<ConfinementPolicy, 'workdir' | 'browserProfile'>, s) })), ...(policy.bridgeCommands ?? []).map(serverCommand => ({ serverCommand: [...serverCommand] }))],
    // Honored from any settings source; the environment variable at launch says the same, and the start check wants its debug line.
    disableClaudeAiConnectors: true,
    sandbox: {
      enabled: true,
      // Without it a machine where the sandbox cannot start runs every command unsandboxed, silently.
      failIfUnavailable: true,
      // A command the sandbox blocked may be retried outside it (`dangerouslyDisableSandbox`) unless this says no.
      allowUnsandboxedCommands: false,
      // No command runs outside the sandbox by name, and the filesystem boundary stays on. (The user's own settings can still add to excludedCommands: lists merge.)
      excludedCommands: [],
      // The shell cannot read the credential places or other specialists' workdirs (Seatbelt). The browser and MCP servers run outside it and are not held to this.
      filesystem: { disabled: false, denyRead: [...policy.cannotRead] },
      enableWeakerNestedSandbox: false,
      // The confined Bash is a normal one: it should not stop at a prompt nobody is there to answer.
      autoAllowBashIfSandboxed: true,
    },
    permissions: {
      blockWritesOutsideWorkingDirectories: true,
      // The network is meant to stay open (not proven live; the guarantee is about writes and credentials): without an allowlist entry, a host is asked about, and nobody is there to answer.
      allow: [NETWORK_ALLOW_RULE],
      // Read, Grep and Glob (best effort for the last two, by Claude Code's docs) and the file commands it recognizes in Bash: the same places, as Read rules.
      deny: [...policy.cannotRead.map(readDenyRule), ...policy.denyCommands.map(c => `Bash(${c})`), ...(policy.servers ?? []).flatMap(s => (s.denyTools ?? []).map(t => serverToolRule(s.name, t)))],
    },
  }
}

/** The permission rules the settings carry, as the start check expects to see Claude Code apply them. */
export function confinementRules(policy: Pick<ConfinementPolicy, 'denyCommands' | 'cannotRead'> & ({ servers?: undefined } | Pick<ConfinementPolicy, 'servers' | 'workdir' | 'browserProfile'>)): { allow: string[]; deny: string[] } {
  const p = (confinementSettings(policy) as { permissions: { allow: string[]; deny: string[] } }).permissions
  return { allow: p.allow, deny: p.deny }
}

/** The MCP config a write-confined launch passes: the listed servers, each with its own browser folders, the `token_env` variables, and nothing else of the daemon's environment. */
export function confinementMcp(policy: ConfinementPolicy, sessionName: string, env: NodeJS.ProcessEnv, held: Readonly<Record<string, string>>, envFile: string): object {
  return {
    mcpServers: Object.fromEntries(policy.servers.map(s => [s.name, {
      type: 'stdio',
      command: s.command,
      args: confinementServerCommand(policy, s).slice(1),
      env: {
        ...Object.fromEntries(s.tokenEnv.map(v => {
          const value = env[v] ?? held[v]
          if (value === undefined) throw new PolicyRefusal(missingTokenRefusal({ specialist: policy.specialist, servers: [s] }, envFile, sessionName, env, held)!)
          return [v, value]
        })),
        ...Object.fromEntries(Object.entries(s.profileEnv).map(([k, v]) => [k, fillProfile(v, policy.workdir, policy.browserProfile)])),
      },
    }])),
  }
}

/** Makes the browser's own folders inside the workdir (mode 0700). A profile is the specialist's to keep across sessions: nothing here removes it. */
export function makeBrowserDirs(workdir: string, named?: string): void {
  // mkdir's mode applies to a folder it makes; one that was already there (adopted) is brought to 0700 too: a profile holds logins, so no other user reads it.
  for (const dir of [browserProfileDir(workdir, named), browserDownloadDir(workdir, named)]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700) }
}

/** `claude --version`'s answer, read once per daemon process. A test seam: `claudeVersion.read`. */
export const claudeVersion = {
  cache: undefined as string | undefined,
  read(): string | undefined {
    if (this.cache !== undefined) return this.cache
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    const v = /\d+\.\d+\.\d+/.exec(r.stdout ?? '')?.[0]
    if (v) this.cache = v
    return v
  },
}

const atLeast = (v: string, min: readonly number[]): boolean => {
  const parts = v.split('.').map(Number)
  for (let i = 0; i < min.length; i++) if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]
  return true
}

/** Why this machine's Claude Code cannot confine writes, as a refusal's text, or undefined. */
export function claudeVersionRefusal(policy: Pick<ConfinementPolicy, 'specialist'>, sessionName: string, read: () => string | undefined = () => claudeVersion.read()): string | undefined {
  const min = MIN_CLAUDE_VERSION.join('.')
  const v = read()
  if (v === undefined) return `specialist ${policy.specialist}: hydra could not read \`claude --version\`, so it cannot know the Claude Code on this machine confines writes (can_only_write_to needs ${min} or newer). No session starts. ${remedy(sessionName)}`
  if (!atLeast(v, MIN_CLAUDE_VERSION)) return `specialist ${policy.specialist}: Claude Code ${v} is older than ${min}, the first that can stop Edit and Write outside the working directory; an older one would ignore that setting, so no session starts. Update Claude Code, then ${remedy(sessionName)}`
  return undefined
}

export const confinementLogLine = (tmuxName: string, p: ConfinementPolicy): string =>
  `daemon: write-confined launch ${tmuxName}: specialist ${p.specialist}, writes only in ${p.workdir}, servers ${p.servers.map(s => s.name).join(',') || 'none'}, deny ${p.denyCommands.join(' | ') || 'none'}; browser profile ${browserProfileDir(p.workdir, p.browserProfile)}`

/**
 * The bridge tools a write-confined session holds that take a `files` argument, derived from the tool schemas and its tool set (CONFINED_TOOLS), so a
 * tool that gains `files` is checked without anyone remembering to list it. Each takes the same check, once, in `executeTool`.
 */
export const fileArgTools = (): string[] => UNIVERSAL_TOOLS.filter(t => CONFINED_TOOLS.has(t.name) && 'files' in ((t.inputSchema as { properties?: object }).properties ?? {})).map(t => t.name)

/**
 * The temp folder a write-confined session's Bash is given and may write: Claude Code's sandbox sets TMPDIR to `/tmp/claude-<uid>` (measured with the
 * real `claude` in write-confinement-socket.live.test.ts) and allows writes nowhere else in temp. Not the daemon's own tmpdir(), which is another folder.
 * A test seam: `confinedTemp.dir`.
 */
export const confinedTemp = { dir: (): string => `/tmp/claude-${process.getuid?.() ?? 0}` }

/** A test seam: runs between the daemon's decision on a path and its open of it, where a session's backgrounded shell would swap the file for a link. */
export const snapshotHooks = { beforeOpen: (_path: string): void => {}, /** Between the size check and the copy: where a growing file grows. */ afterStat: (): void => {} }

/** Copies the open file to a new 0600 file in 64 KB steps, and stops (false) once it has read more than `max` bytes: a file that grows while it is read cannot fill the inbox or hold the daemon. */
function copyBounded(fd: number, to: string, max: number): boolean {
  const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    const buf = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) return true
      total += n
      if (total > max) return false
      writeSync(out, buf, 0, n)
    }
  } finally { closeSync(out) }
}

export type ConfinedFiles = { files: string[]; cleanup: () => void } | { refusal: string }

/**
 * The `files` a write-confined session may attach, as daemon-owned copies to send, or the refusal's text. Each path is decided on (config/write-confinement.ts
 * `fileSendDecision`), opened once without following a link at the end (O_NOFOLLOW; non-blocking, so a pipe cannot hold the daemon) and required to be a plain
 * file, then decided on again and compared by device and inode with the open file: a file swapped for a link between the decision and the open, or a folder in
 * the path swapped, no longer leads to the file that was opened. The open file's bytes are copied into a folder of the daemon's own (the inbox, which the
 * session cannot read), and the copy is what the gateway opens: it never re-opens the session's path. `cleanup` removes the copies once the send has settled.
 * A file over the attachment limit (access.ts MAX_ATTACHMENT_BYTES) is refused on its size before any byte is read, and the copy is bounded by the same limit for a file that grows.
 * A file with more than one name (st_nlink > 1) is refused: a hardlink in the workdir to a file outside it cannot be told from the file by its path. The sandboxed shell cannot make one to a place it may not read (`ln` is denied, shown live in write-confinement-escape.live.test.ts), but a browser, an MCP server or an earlier write could.
 * Not covered: a shell that swaps a folder of the path outward before the open, back before the second decision, and outward again before the comparison (three swaps, microseconds apart; a race-free check needs the open file's own path, F_GETPATH, which Node and Bun do not expose without a native call).
 */
export function snapshotConfinedFiles(w: NonNullable<LaunchPolicy['canOnlyWriteTo']>, files: readonly unknown[]): ConfinedFiles {
  const env = { workdir: w.workdir, tmpDir: confinedTemp.dir(), deny: w.cannotRead, realpath: realpathSync }
  let dir: string | undefined
  const cleanup = () => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined }
  const refuse = (f: unknown): { refusal: string } => { cleanup(); return { refusal: fileRefusal(String(f)) } }
  const out: string[] = []
  for (const f of files) {
    if (typeof f !== 'string' || !f) return refuse(f)
    const d = fileSendDecision(f, env)
    if (d.path === undefined) return refuse(f)
    snapshotHooks.beforeOpen(d.path)
    let fd: number | undefined
    try {
      fd = openSync(d.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const open = fstatSync(fd)
      const again = fileSendDecision(f, env)
      // More than one name: another name (a hardlink made where the session cannot, by a browser or MCP server, or earlier) may lead to a place it may not read, and a path check cannot see that.
      if (!open.isFile() || open.nlink > 1 || again.path !== d.path) return refuse(f)
      const there = statSync(d.path)
      if (there.ino !== open.ino || there.dev !== open.dev) return refuse(f)
      if (!dir) { const root = join(STATE_DIR, 'inbox'); mkdirSync(root, { recursive: true, mode: 0o700 }); dir = mkdtempSync(join(root, 'confined-send-')) }
      if (open.size > MAX_ATTACHMENT_BYTES) return refuse(f)
      snapshotHooks.afterStat()
      const copy = join(dir, `${out.length}-${basename(d.path)}`)
      out.push(copy)
      if (!copyBounded(fd, copy, MAX_ATTACHMENT_BYTES)) return refuse(f)
    } catch { return refuse(f) } finally { if (fd !== undefined) closeSync(fd) }
  }
  return { files: out, cleanup }
}

/** The plugin id and marketplace of the bridge (infra/plugin-manifest.ts BRIDGE_PLUGIN_ID). */
const BRIDGE_MARKETPLACE_DIR = 'claude-plugins-official'
const BRIDGE_PLUGIN_NAME = 'discord'

export type BridgeDirDeps = { read: (path: string) => string; list: (dir: string) => string[]; exists: (path: string) => boolean; real: (path: string) => string }
const realBridgeDirDeps: BridgeDirDeps = {
  read: p => readFileSync(p, 'utf8'),
  list: d => readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name),
  exists: p => { try { statSync(p); return true } catch { return false } },
  real: p => { try { return realpathSync(p) } catch { return p } },
}

/**
 * Where Claude Code may run the bridge from, which is what `${CLAUDE_PLUGIN_ROOT}` becomes in its command: the install path `installed_plugins.json` records for the plugin (the one
 * rule; when the file names none, every version folder of the plugin cache, which the daemon syncs at boot), and the plugin's source folder in its marketplace (a plugin whose
 * cache folder Claude Code did not make is run from there: seen in the real Claude Code with a hand-made cache). Each as written and as resolved.
 */
export function bridgePluginDirs(claudeConfigDir: string, deps: BridgeDirDeps = realBridgeDirDeps): string[] {
  const cfg = claudeConfigDir.replace(/\/+$/, '')
  const cache = `${cfg}/plugins/cache/${BRIDGE_MARKETPLACE_DIR}/${BRIDGE_PLUGIN_NAME}`
  let dirs: string[] = []
  try {
    const installed = JSON.parse(deps.read(`${cfg}/plugins/installed_plugins.json`))?.plugins?.[`${BRIDGE_PLUGIN_NAME}@${BRIDGE_MARKETPLACE_DIR}`]
    if (Array.isArray(installed)) dirs = installed.map((e: { installPath?: unknown }) => e?.installPath).filter((p): p is string => typeof p === 'string' && p.startsWith('/') && deps.exists(p))
  } catch { /* no record: the folders below */ }
  if (dirs.length === 0) { try { dirs = deps.list(cache).sort().map(n => `${cache}/${n}`) } catch { dirs = [] } }
  const market = `${cfg}/plugins/marketplaces/${BRIDGE_MARKETPLACE_DIR}`
  let source = './external_plugins/discord'
  try { const e = JSON.parse(deps.read(`${market}/.claude-plugin/marketplace.json`))?.plugins?.find((x: { name?: string }) => x?.name === BRIDGE_PLUGIN_NAME)?.source; if (typeof e === 'string') source = e } catch { /* the default */ }
  const sourceDir = `${market}/${source.replace(/^\.\//, '')}`.replace(/\/+$/, '')
  if (deps.exists(sourceDir)) dirs.push(sourceDir)
  return [...new Set(dirs.flatMap(d => [d, deps.real(d)]))]
}

/** The commands the bridge runs from each of those folders: the manifest's own command string (`bun`, never a resolved path: Claude Code's match is exact, shown against the real one), arguments filled in. */
export const bridgeServerCommands = (claudeConfigDir: string, deps: BridgeDirDeps = realBridgeDirDeps): string[][] => bridgePluginDirs(claudeConfigDir, deps).map(bridgeCommand)

/** What Claude Code rejects in an `allowedMcpServers` entry (from its own schema): such an entry makes it stop at an interactive "Settings Warning" and never start the session. */
export function claudeSettingsProblems(settings: { allowedMcpServers?: unknown }): string[] {
  const out: string[] = []
  const list = settings.allowedMcpServers
  if (list === undefined) return out
  if (!Array.isArray(list)) return ['allowedMcpServers is not a list']
  list.forEach((e: any, i) => {
    if (e?.serverName !== undefined && !(typeof e.serverName === 'string' && /^[a-zA-Z0-9_-]+$/.test(e.serverName))) out.push(`allowedMcpServers[${i}]: server name ${JSON.stringify(e.serverName)} can only contain letters, numbers, hyphens and underscores`)
    if (e?.serverCommand !== undefined && !(Array.isArray(e.serverCommand) && e.serverCommand.length >= 1 && e.serverCommand.every((x: unknown) => typeof x === 'string'))) out.push(`allowedMcpServers[${i}]: serverCommand must be a non-empty list of strings`)
    if (e?.serverName === undefined && e?.serverCommand === undefined && e?.serverUrl === undefined) out.push(`allowedMcpServers[${i}]: names no server`)
  })
  return out
}
