// What a write-confined specialist's launch writes and checks (`can_only_write_to = "workdir"`): Claude Code's own controls, set in the launch's
// settings, and nothing hydra built itself. The policy is `LaunchPolicy.canOnlyWriteTo` (restricted.ts); the one place it turns into a launch is
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
import { mkdirSync } from 'fs'
import { join } from 'path'
import { browserDownloadDir, browserProfileDir, fillProfile, readDenyRule } from '../config/write-confinement.js'
import { expectedServerNames } from './engines/claude-verify.js'
import { PolicyRefusal, missingTokenRefusal, remedy, type ConfinementPolicy } from './restricted.js'

/** The first Claude Code with `permissions.blockWritesOutsideWorkingDirectories`: an older one ignores the key, which would leave Edit/Write unconfined. */
export const MIN_CLAUDE_VERSION = [2, 1, 314] as const

/** The settings a write-confined launch passes with `--settings` (they sit above the user's, project and local files; only managed settings are above them). */
/** The rule that lets the sandbox's proxy reach any host: `sandbox.network.allowedDomains` refuses a bare `*` as too broad, but a `WebFetch(domain:*)` allow rule feeds the same allowlist (Claude Code 2.1.186+) and matches every host. */
export const NETWORK_ALLOW_RULE = 'WebFetch(domain:*)'

/** The MCP servers the session may see: hydra's bridge (its one way to the thread) and the servers its policy lists. Nothing else: not the operator's own, a plugin's, a project's or a claude.ai connector. */
export const confinementServers = (policy: Pick<ConfinementPolicy, 'servers'>): string[] => expectedServerNames(policy.servers)

export function confinementSettings(policy: Pick<ConfinementPolicy, 'denyCommands' | 'cannotRead'> & Partial<Pick<ConfinementPolicy, 'servers'>>): object {
  return {
    // Claude Code's own allowlist, which governs user/project/local config, --mcp-config, plugins and claude.ai connectors alike (not --strict-mcp-config: that drops plugin servers, and the bridge is one).
    allowedMcpServers: confinementServers({ servers: policy.servers ?? [] }).map(serverName => ({ serverName })),
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
      deny: [...policy.cannotRead.map(readDenyRule), ...policy.denyCommands.map(c => `Bash(${c})`)],
    },
  }
}

/** The permission rules the settings carry, as the start check expects to see Claude Code apply them. */
export function confinementRules(policy: Pick<ConfinementPolicy, 'denyCommands' | 'cannotRead'>): { allow: string[]; deny: string[] } {
  const p = (confinementSettings(policy) as { permissions: { allow: string[]; deny: string[] } }).permissions
  return { allow: p.allow, deny: p.deny }
}

/** The MCP config a write-confined launch passes: the listed servers, each with its own browser folders, the `token_env` variables, and nothing else of the daemon's environment. */
export function confinementMcp(policy: ConfinementPolicy, sessionName: string, env: NodeJS.ProcessEnv, held: Readonly<Record<string, string>>, envFile: string): object {
  return {
    mcpServers: Object.fromEntries(policy.servers.map(s => [s.name, {
      type: 'stdio',
      command: s.command,
      args: s.profileArgs.map(a => fillProfile(a, policy.workdir)),
      env: {
        ...Object.fromEntries(s.tokenEnv.map(v => {
          const value = env[v] ?? held[v]
          if (value === undefined) throw new PolicyRefusal(missingTokenRefusal({ specialist: policy.specialist, servers: [s] }, envFile, sessionName, env, held)!)
          return [v, value]
        })),
        ...Object.fromEntries(Object.entries(s.profileEnv).map(([k, v]) => [k, fillProfile(v, policy.workdir)])),
      },
    }])),
  }
}

/** Makes the browser's own folders inside the workdir (mode 0700). A profile is the specialist's to keep across sessions: nothing here removes it. */
export function makeBrowserDirs(workdir: string): void {
  for (const dir of [browserProfileDir(workdir), browserDownloadDir(workdir)]) mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  `daemon: write-confined launch ${tmuxName}: specialist ${p.specialist}, writes only in ${p.workdir}, servers ${p.servers.map(s => s.name).join(',') || 'none'}, deny ${p.denyCommands.join(' | ') || 'none'}; browser folders ${join(p.workdir, '.browser')}`
