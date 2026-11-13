// What a test or probe that really runs `claude` for a scoped session may pass it: HOME, PATH and USER, and nothing else.
// Everything else the session needs (CLAUDE_CONFIG_DIR, DAEMON_SOCK, CLAUDE_CODE_PLUGIN_DIRS, HYDRA_*, ENABLE_CLAUDEAI_MCP_SERVERS)
// is exported by the launch command itself, so a run starts from `env -i HOME PATH USER` and never inherits the live
// daemon's DISCORD_BOT_TOKEN, DAEMON_SOCK or CLAUDE_CODE_PLUGIN_DIRS.

/** The only variables inherited from the parent. */
export const PROBE_INHERITED_ENV = ['HOME', 'PATH', 'USER'] as const

/** The variables a probe may add, each given its own value (never read from the parent): the ones a probe needs and nothing the live daemon holds. */
export const PROBE_ADDABLE_ENV = ['HYDRA_STATE_DIR', 'DAEMON_SOCK', 'CLAUDE_CONFIG_DIR', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_PLUGIN_DIRS'] as const

/** `env -i HOME="$HOME" PATH="$PATH" USER="$USER"` plus the `add`ed variables, as an object. */
export function minimalProbeEnv(from: NodeJS.ProcessEnv = process.env, add: Partial<Record<typeof PROBE_ADDABLE_ENV[number], string>> = {}): Record<string, string> {
  for (const k of Object.keys(add)) if (!(PROBE_ADDABLE_ENV as readonly string[]).includes(k)) throw new Error(`a probe may not add ${k}`)
  const env: Record<string, string> = {}
  for (const k of PROBE_INHERITED_ENV) {
    const v = from[k]
    if (v === undefined) throw new Error(`a probe needs ${k} in the environment it starts from`)
    env[k] = v
  }
  return { ...env, ...(add as Record<string, string>) }
}
