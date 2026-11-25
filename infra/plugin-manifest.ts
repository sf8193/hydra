/**
 * What hydra writes into Claude Code's plugin cache to declare the bridge.
 *
 * The bridge reaches a session by being an MCP server Claude Code launches, and
 * hydra arranges that by writing files into a directory Claude Code owns. Both
 * declarations below say the same thing; they exist separately because Claude
 * Code has two ways of finding it, and only one of them is reliable.
 */

import { execFile } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
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
 * A restricted or write-confined launch turns these off: its policy lists every server it may start, and the
 * launch check refuses any other (claude-verify.ts), so one left on stops every restricted session from starting.
 * `cc-plugin-easel` arrived with Claude Code 2.1.327 (18 Nov 2026) and serves `mcp__easel__chart`.
 */
export const BUILTIN_TOOL_PLUGIN_IDS = ['cc-plugin-easel@builtin'] as const
/**
 * Claude Code's built-ins seen to serve no tool server (Claude Code 2.1.332, 25 Nov 2026): a policy launch leaves these as the user has them.
 * Every other built-in Claude Code lists is turned off (`builtinPluginsOff`), so one a Claude Code update adds arrives off in a restricted or
 * write-confined launch instead of starting a server the launch check refuses (2.1.332 brought easel into write-confined launches, which never
 * turned it off: three write-confined specialists could not start for ~17 min). Add one here only once it is known to serve no tools.
 * Only what Claude Code lists can be turned off this way: 2.1.331 lists no built-in, and 2.1.332 lists them per config folder (claudeBuiltins).
 */
export const NO_TOOL_BUILTIN_PLUGIN_IDS: readonly string[] = [
  'cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin', 'cc-plugin-privacy@builtin', 'cc-plugin-telemetry@builtin', 'cc-plugin-you-should-know@builtin',
]
/** The `enabledPlugins` entries that turn built-ins off in a policy launch: the known tool servers always, and every listed built-in not known to serve no tools. */
export function builtinPluginsOff(listed: readonly string[] = []): Record<string, false> {
  const off = new Set<string>([...BUILTIN_TOOL_PLUGIN_IDS, ...listed.filter(id => id.endsWith('@builtin') && !NO_TOOL_BUILTIN_PLUGIN_IDS.includes(id))])
  return Object.fromEntries([...off].map(id => [id, false as const]))
}
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
 * owns making that directory correct; it runs at boot and before each spawn
 * (`syncBridgePlugin`), not inside the bridge's start.
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
 * Async and bounded (BRIDGE_INSTALL_TIMEOUT_MS). Boot does not wait on it; a
 * spawn and the byte start do, so the bridge they start never installs into the
 * same node_modules at the same time. The start script is lifted only after a
 * complete install (marker present), so a failed or partial install leaves the
 * published install-on-spawn script in place and is retried on the next sync. Only `scripts.start` is rewritten; the rest of
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

/**
 * Point `serverTs` at `bridgeSrc`, replacing whatever is there in one rename: no moment
 * without a server.ts, and no EEXIST when the daemon and a CLI byte start relink at once.
 */
function linkAtomically(bridgeSrc: string, serverTs: string): void {
  const tmp = `${serverTs}.hydra-link-${process.pid}-${Math.random().toString(36).slice(2)}`
  symlinkSync(bridgeSrc, tmp)
  try { renameSync(tmp, serverTs) } catch (err) { try { unlinkSync(tmp) } catch {} ; throw err }
}

/** How a dir is made ready; a seam so tests can hold or count it. */
export const bridgeReadiness = { run: (dir: string): Promise<boolean> => ensureBridgeReady(dir) }

/** One ensureBridgeReady per dir at a time, shared by every caller that asks while it runs. */
const readyInFlight = new Map<string, Promise<void>>()

export interface BridgeSyncResult {
  /** Every plugin version dir found. */
  dirs: string[]
  /** Dirs whose server.ts was not a link to the bridge and now is. */
  relinked: string[]
  /** Dirs the sync could not finish, with why (the others are still synced). */
  failed: { dir: string; error: string }[]
  /** Settles when every dir's ensureBridgeReady has; never rejects (failures are logged). */
  ready: Promise<void>
}

/**
 * Make every plugin version directory launch this repo's bridge.
 *
 * `server.ts` is a symlink to `bridge.ts`, never a copy: bridge.ts imports
 * `./shared/*`, which a copy in the cache cannot find, so every bridge started
 * from a copy dies at load and its session has no channel.
 *
 * Claude Code can add or refill a version directory at any time (plugin
 * auto-update), so the daemon runs this at boot and before every Claude spawn,
 * and the byte start runs it too. Idempotent; writes only what differs. Each
 * dir succeeds or fails alone.
 */
export function syncBridgePlugin(o: {
  bridgeSrc: string
  cacheDir: string
  platform: string
  daemonConfig: string
  log?: (line: string) => void
}): BridgeSyncResult {
  const log = o.log ?? (() => {})
  const result: BridgeSyncResult = { dirs: [], relinked: [], failed: [], ready: Promise.resolve() }
  const readies: Promise<void>[] = []
  for (const d of readdirSync(o.cacheDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const targetDir = join(o.cacheDir, d.name)
    result.dirs.push(targetDir)
    try {
      const serverTs = join(targetDir, 'server.ts')
      if (!isLinkedTo(serverTs, o.bridgeSrc)) {
        linkAtomically(o.bridgeSrc, serverTs)
        result.relinked.push(targetDir)
      }
      writeIfChanged(join(targetDir, `daemon-${o.platform}.json`), o.daemonConfig)
      writeIfChanged(join(targetDir, '.mcp.json'), MCP_CONFIG)
      mkdirSync(join(targetDir, '.claude-plugin'), { recursive: true })
      writeIfChanged(join(targetDir, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result.failed.push({ dir: targetDir, error })
      log(`bridge sync failed in ${targetDir}: ${error}`)
      continue
    }
    let ready = readyInFlight.get(targetDir)
    if (!ready) {
      ready = bridgeReadiness.run(targetDir).then(
        installed => { if (installed) log(`installed bridge deps + lifted start script in ${targetDir}`) },
        err => log(`bridge deps install failed in ${targetDir} (its start script keeps installing): ${err instanceof Error ? err.message : String(err)}`),
      ).finally(() => readyInFlight.delete(targetDir))
      readyInFlight.set(targetDir, ready)
    }
    readies.push(ready)
  }
  result.ready = Promise.all(readies).then(() => {})
  return result
}

/** syncBridgePlugin for a hydra checkout: its bridge.ts, the config dir's plugin cache, and this daemon's socket. */
export function syncHydraBridge(o: { claudeConfig: string; hydraDir: string; platform: string; sockPath: string; log?: (line: string) => void }): BridgeSyncResult {
  return syncBridgePlugin({
    bridgeSrc: join(o.hydraDir, 'bridge.ts'),
    cacheDir: bridgePluginCache(o.claudeConfig),
    platform: o.platform,
    daemonConfig: JSON.stringify({ socket: o.sockPath, platform: o.platform }),
    log: o.log,
  })
}
