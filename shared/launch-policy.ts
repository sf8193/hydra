// The shape of a specialist's launch policy, and the two things every layer says about a refused start: its error type and the one remedy text.
// The shape is here because the session record (sessions/registry.ts) holds it and the engines read it. What decides a policy, compares it,
// gates a start or a delivery, or words a refusal of its own is app/restricted.ts.

export type PolicyServer = { name: string; command: string; tokenEnv: string[]; tools: string[] }

/** A server a write-confined session starts with its own browser folders: its command, the variables that reach it, and how it takes the folders (config/write-confinement.ts placeholders). */
export type ConfinementServer = { name: string; command: string; tokenEnv: string[]; profileArgs: string[]; profileEnv: Record<string, string>; /** Tools of the server its session may not call (`mcp__<server>__<tool>` deny rules); absent: none. */ denyTools?: string[] }

/**
 * `can_only_write_to = "workdir"`: the operator's account and tools, with Bash and Edit/Write writes confined to `workdir` (engines/write-confinement.ts).
 * It sits on a policy that is not restricted: the account is the operator's.
 */
export type ConfinementPolicy = { specialist: string; workdir: string; denyCommands: string[]; /** Every place Claude Code's tools and shell may not read, as worked out at birth (config/write-confinement.ts `readDenyRoots`). */ cannotRead: string[]; /** The built-in tools it may use (`--tools`); absent: all, as for any unrestricted session. */ tools?: string[]; /** The folder its listed servers get as `{profile_dir}`, resolved and inside `workdir`; absent: `<workdir>/.browser/profile`. */ browserProfile?: string; servers: ConfinementServer[] }

/** `restricted = true`: the one folder it runs in, its built-in tools and its MCP servers. `restricted = false`: the operator's account, its writes confined when `canOnlyWriteTo` is there. Never a mix. */
export type LaunchPolicy = {
  /** The specialist's id when the session was born. */
  specialist: string
  /** Changes whenever `restricted`, the workdir, a tool or a server (or its tools) does, and with nothing else. */
  id: string
} & (
  | { restricted: true; /** The only folder the session runs in. */ workdir: string; /** Built-in tools, `--tools`. */ tools: string[]; /** The MCP servers it may use, each with the tools it may call. */ servers: PolicyServer[]; canOnlyWriteTo?: never }
  | { restricted: false; /** `can_only_write_to`: present when its writes are confined; absent: writes anywhere. */ canOnlyWriteTo?: Omit<ConfinementPolicy, 'specialist'> }
)

/** A `restricted = true` policy. */
export type RestrictedPolicy = Extract<LaunchPolicy, { restricted: true }>

/** The one remedy, said the same everywhere: what to run, what happens next, and that hydra.toml is read again. `sessionName` is the record's own. */
export const remedy = (sessionName: string): string => `Run \`hydra kill ${sessionName}\`; the next message to the specialist starts a new session that re-reads hydra.toml.`

/** A start that must not happen, said with its cause and its fix. Posted in the thread by whoever catches it. */
export class PolicyRefusal extends Error {}
