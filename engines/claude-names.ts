// Claude Code's own names for things a launch and its check both say: the permission rule for an MCP tool, and the one mod a restricted session loads.

/** The one mod a restricted session loads: the tracked hydra mod, never the operator's `mods.local`. */
export const HYDRA_MOD = 'hydra'
export const RESTRICTED_MODS = [HYDRA_MOD] as const

/** The permission rule that allows one tool of one MCP server: Claude Code's `mcp__<server>__<tool>`. The launch's settings and the start's check both say it this way. */
export const serverToolRule = (server: string, tool: string): string => `mcp__${server}__${tool}`
