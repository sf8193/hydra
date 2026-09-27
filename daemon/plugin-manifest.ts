/**
 * What hydra writes into Claude Code's plugin cache to declare the bridge.
 *
 * The bridge reaches a session by being an MCP server Claude Code launches, and
 * hydra arranges that by writing files into a directory Claude Code owns. Both
 * declarations below say the same thing; they exist separately because Claude
 * Code has two ways of finding it, and only one of them is reliable.
 */

import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

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

/**
 * The bridge start script, with its dependency install removed.
 *
 * The published plugin's `start` is `bun install --no-summary && bun server.ts`,
 * so every session spawn reaches the npm registry before the bridge can speak
 * MCP. A slow or unreachable registry burns the 30s connect timeout, and Claude
 * Code then caches that failure for 15 minutes — so one bad start leaves every
 * session spawned in that window bridgeless, with no attempt logged. Dependency
 * installation is a setup concern, and the daemon's plugin-cache sync already
 * owns making that directory correct; it runs once at boot instead.
 *
 * The script is rewritten rather than replaced because the entry file differs by
 * layout — `server.ts` in the plugin cache, `bridge.ts` in this repo — and the
 * rest of the published `package.json` (name, deps, bin) stays upstream's.
 */
export function startWithoutInstall(start: string): string {
  return start.replace(/^\s*bun\s+install\b[^&|;]*&&\s*/, '')
}

export type InstallRunner = (cwd: string) => Promise<void>

/** Marker inside node_modules: written only after a complete install, deleted with it. */
export const DEPS_MARKER = join('node_modules', '.hydra-deps-ok')
export const BRIDGE_INSTALL_TIMEOUT_MS = 120_000

const bunInstall: InstallRunner = cwd => new Promise((resolve, reject) => {
  execFile('bun', ['install', '--no-summary'], { cwd, timeout: BRIDGE_INSTALL_TIMEOUT_MS }, (err, _stdout, stderr) => {
    if (err) reject(new Error(`${err.message}${stderr ? `\n${String(stderr).trim()}` : ''}`))
    else resolve()
  })
})

/**
 * Make a plugin-cache dir launch its bridge without installing on every spawn.
 *
 * Async and bounded, so a slow registry never blocks daemon boot. The start
 * script is lifted only after a complete install (marker present), so a failed
 * or partial install leaves the published install-on-spawn script in place and
 * is retried on the next boot. Only `scripts.start` is rewritten; the rest of
 * package.json stays upstream's.
 */
export async function ensureBridgeReady(targetDir: string, install: InstallRunner = bunInstall): Promise<'ready' | 'installed' | 'skipped'> {
  const pkgPath = join(targetDir, 'package.json')
  if (!existsSync(pkgPath)) return 'skipped'
  const marker = join(targetDir, DEPS_MARKER)
  let outcome: 'ready' | 'installed' = 'ready'
  if (!existsSync(marker)) {
    await install(targetDir)
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    outcome = 'installed'
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const start = pkg.scripts?.start
  if (typeof start === 'string') {
    const lifted = startWithoutInstall(start)
    if (lifted !== start) {
      pkg.scripts.start = lifted
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }
  }
  return outcome
}
