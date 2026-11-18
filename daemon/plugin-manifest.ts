/**
 * What hydra writes into Claude Code's plugin cache to declare the bridge.
 *
 * The bridge reaches a session by being an MCP server Claude Code launches, and
 * hydra arranges that by writing files into a directory Claude Code owns. Both
 * declarations below say the same thing; they exist separately because Claude
 * Code has two ways of finding it, and only one of them is reliable.
 */

import { execFile } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

const PLUGIN_VERSION = '0.0.4'

/**
 * The bridge's names, as Claude Code derives them. The plugin is called `discord`
 * on every platform (historical; the bridge is platform-agnostic), so a Slack
 * daemon's sessions load the same plugin and see the same server key.
 *
 * - `--channels` takes `plugin:<plugin>@<marketplace>`.
 * - Claude Code keys a plugin's MCP server `plugin:<plugin>:<server>` — in its
 *   config, its debug log, and its needs-auth cache (engines/claude-needs-auth.ts).
 */
const BRIDGE_PLUGIN = 'discord'
const BRIDGE_MARKETPLACE = 'claude-plugins-official'
const BRIDGE_SERVER_NAME = 'discord'
export const BRIDGE_CHANNEL_FLAG = `plugin:${BRIDGE_PLUGIN}@${BRIDGE_MARKETPLACE}`
export const BRIDGE_MCP_SERVER_KEY = `plugin:${BRIDGE_PLUGIN}:${BRIDGE_SERVER_NAME}`
/** The plugin as `enabledPlugins` names it. */
export const BRIDGE_PLUGIN_ID = `${BRIDGE_PLUGIN}@${BRIDGE_MARKETPLACE}`
/**
 * Claude Code's built-in plugins that serve tools of their own, as an MCP server the session connects to.
 * A restricted specialist's launch turns these off: its policy lists every server it may start, and the
 * launch check refuses any other (claude-verify.ts), so one left on stops every restricted session from starting.
 * `cc-plugin-easel` arrived with Claude Code 2.1.327 (18 Nov 2026) and serves `mcp__easel__chart`.
 */
export const BUILTIN_TOOL_PLUGIN_IDS = ['cc-plugin-easel@builtin'] as const
/** The permission rule that allows the bridge's tools: Claude Code names them `mcp__<server key with ':' as '_'>__<tool>`. */
export const BRIDGE_TOOLS_PERMISSION = `mcp__${BRIDGE_MCP_SERVER_KEY.replaceAll(':', '_')}__*`

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

/** The bridge's launch command with `${CLAUDE_PLUGIN_ROOT}` replaced by a plugin directory: what Claude Code runs, and what a server allowlist's `serverCommand` entry must match exactly. */
export const bridgeCommand = (pluginDir: string): string[] => [BRIDGE_SERVER.command, ...BRIDGE_SERVER.args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginDir))]

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
  name: BRIDGE_PLUGIN,
  description: 'Discord channel for Claude Code — messaging bridge with built-in access control.',
  version: PLUGIN_VERSION,
  keywords: ['discord', 'messaging', 'channel', 'mcp'],
  mcpServers: { [BRIDGE_SERVER_NAME]: BRIDGE_SERVER },
}, null, 2)

export const MCP_CONFIG = JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: BRIDGE_SERVER } }, null, 2)

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
const BRIDGE_INSTALL_TIMEOUT_MS = 120_000

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
 * package.json stays upstream's. Resolves true only when this call ran the install.
 */
export async function ensureBridgeReady(targetDir: string, install: InstallRunner = bunInstall): Promise<boolean> {
  const pkgPath = join(targetDir, 'package.json')
  if (!existsSync(pkgPath)) return false
  const marker = join(targetDir, DEPS_MARKER)
  let installed = false
  if (!existsSync(marker)) {
    await install(targetDir)
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    installed = true
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
  return installed
}

/** The plugin cache directory that holds one folder per installed bridge plugin version. */
export const bridgePluginCache = (claudeConfig: string): string => join(claudeConfig, 'plugins', 'cache', BRIDGE_MARKETPLACE, BRIDGE_PLUGIN)

/** True when `serverTs` is a symlink to `bridgeSrc`. */
export function isLinkedTo(serverTs: string, bridgeSrc: string): boolean {
  try { return lstatSync(serverTs).isSymbolicLink() && readlinkSync(serverTs) === bridgeSrc } catch { return false }
}

function writeIfChanged(path: string, content: string): void {
  try { if (readFileSync(path, 'utf8') === content) return } catch {}
  writeFileSync(path, content)
}

const readyInFlight = new Set<string>()

/**
 * Make every plugin version directory launch this repo's bridge.
 *
 * `server.ts` is a symlink to `bridge.ts`, never a copy: bridge.ts imports
 * `./shared/*`, which a copy in the cache cannot find, so every bridge started
 * from a copy dies at load and its session has no channel (Nov 18: the plugin
 * auto-updated 0.0.4 → 0.0.5, the next sync copied, every new spawn was bridgeless).
 *
 * Claude Code can add a version directory at any time (plugin auto-update), so
 * this runs before each spawn as well as at boot. It is idempotent and only
 * writes what differs. Returns the version dirs whose server.ts it (re)linked.
 */
export function syncBridgePlugin(o: {
  bridgeSrc: string
  cacheDir: string
  platform: string
  daemonConfig: string
  ready?: (dir: string) => Promise<boolean>
  log?: (line: string) => void
}): string[] {
  const log = o.log ?? (() => {})
  const ready = o.ready ?? (dir => ensureBridgeReady(dir))
  const relinked: string[] = []
  const versionDirs = readdirSync(o.cacheDir, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const d of versionDirs) {
    const targetDir = join(o.cacheDir, d.name)
    const serverTs = join(targetDir, 'server.ts')
    if (!isLinkedTo(serverTs, o.bridgeSrc)) {
      try { unlinkSync(serverTs) } catch {}
      symlinkSync(o.bridgeSrc, serverTs)
      relinked.push(targetDir)
    }
    writeIfChanged(join(targetDir, `daemon-${o.platform}.json`), o.daemonConfig)
    writeIfChanged(join(targetDir, '.mcp.json'), MCP_CONFIG)
    mkdirSync(join(targetDir, '.claude-plugin'), { recursive: true })
    writeIfChanged(join(targetDir, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST)
    // Not awaited: neither boot nor a spawn waits on the registry. One ensureBridgeReady per dir at a time (it is a cheap read once deps are in).
    if (!readyInFlight.has(targetDir)) {
      readyInFlight.add(targetDir)
      void ready(targetDir).then(
        installed => { if (installed) log(`installed bridge deps + lifted start script in ${targetDir}`) },
        err => log(`bridge deps install failed in ${targetDir} (spawns keep installing): ${err instanceof Error ? err.message : String(err)}`),
      ).finally(() => readyInFlight.delete(targetDir))
    }
  }
  return relinked
}
