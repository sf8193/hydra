/**
 * What hydra writes into Claude Code's plugin cache to declare the bridge.
 *
 * The bridge reaches a session by being an MCP server Claude Code launches, and
 * hydra arranges that by writing files into a directory Claude Code owns. Both
 * declarations below say the same thing; they exist separately because Claude
 * Code has two ways of finding it, and only one of them is reliable.
 */

const PLUGIN_VERSION = '0.0.4'

/**
 * How Claude Code is told to launch the bridge.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code to the directory the plugin
 * was loaded from, so one spec is correct in every version directory and in the
 * repo's own manifest. Writing the resolved path instead would bind each copy to
 * where it was written, which is wrong the moment Claude Code loads it elsewhere.
 */
const BRIDGE_SERVER = {
  command: 'bun',
  args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start'],
}

/**
 * The bridge is declared in the manifest, not only in `.mcp.json`.
 *
 * Claude Code reads a plugin's `.mcp.json` through a storage backend keyed by
 * (marketplace, plugin, version, path) rather than off the filesystem, and a
 * miss there returns "this plugin has no MCP servers" with no error and no log
 * line. Hydra writes that file into the plugin directory directly, so whenever
 * that read path is the one taken, the bridge is invisible: the plugin still
 * loads — its skills appear — but the session has no channel back to the daemon
 * for its whole life. `mcpServers` in the manifest is merged inline, with no
 * file read to miss, and the manifest is already being read for the plugin to
 * load at all.
 *
 * `.mcp.json` is still written. The two declare the same server under the same
 * key, so whichever Claude Code consults, the bridge is named identically —
 * `plugin:discord:discord`, which the channel flag and the preflight check both
 * depend on.
 */
export const PLUGIN_MANIFEST = JSON.stringify({
  name: 'discord',
  description: 'Discord channel for Claude Code — messaging bridge with built-in access control.',
  version: PLUGIN_VERSION,
  keywords: ['discord', 'messaging', 'channel', 'mcp'],
  mcpServers: { discord: BRIDGE_SERVER },
}, null, 2)

export const MCP_CONFIG = JSON.stringify({ mcpServers: { discord: BRIDGE_SERVER } }, null, 2)
