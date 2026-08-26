/**
 * Keeping Claude Code's plugin cache pointed at this repo's bridge.
 *
 * The bridge reaches a session by being an MCP server Claude Code launches,
 * and Claude Code launches it from a directory it owns and manages:
 * `<config>/plugins/cache/claude-plugins-official/discord/<version>/`. Hydra
 * writes four files in there — the bridge source, the socket/platform config,
 * the `.mcp.json` that declares the server, and a plugin manifest.
 *
 * That directory is not ours. Claude Code refreshes it from the marketplace,
 * garbage-collects orphaned versions, and installs new version directories
 * that arrive without any of our files. So this sync runs at daemon boot *and*
 * immediately before every spawn: boot-only leaves a window between the last
 * boot and the next spawn in which the cache can be replaced underneath us,
 * and a session spawned in that window has no bridge for its whole life.
 *
 * Writes are atomic. A spawn reading a half-written `.mcp.json` gets a session
 * with no bridge, which is the failure this module exists to prevent.
 */

import { readdirSync, readFileSync, copyFileSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { CLAUDE_CONFIG, PLATFORM, SOCK_PATH } from './config.js'
import { atomicWriteFileSync } from './util.js'

const PLUGIN_VERSION = '0.0.4'
const FILE_MODE = 0o644

const pluginJson = JSON.stringify({
  name: 'discord',
  description: 'Discord channel for Claude Code — messaging bridge with built-in access control.',
  version: PLUGIN_VERSION,
  keywords: ['discord', 'messaging', 'channel', 'mcp'],
}, null, 2)

function bridgeSourcePath(): string {
  return join(import.meta.dir, '..', 'bridge.ts')
}

function pluginCacheDir(): string {
  return join(CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord')
}

/**
 * `server.ts` is a symlink to the repo's bridge.ts in some setups, which makes
 * source and destination the same file. Copying a file onto itself is not a
 * no-op at the syscall layer — it can truncate — and the file it would
 * truncate is the bridge every future session loads.
 */
/**
 * Only write on drift. Claude Code watches its plugin config, so rewriting an
 * identical file on every spawn would nudge every *other* live session's MCP
 * layer for nothing — a sync meant to protect sessions would become a recurring
 * disturbance to them.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // Missing or unreadable — writing is exactly the point.
  }
  atomicWriteFileSync(path, content, FILE_MODE)
}

function copyBridgeSource(src: string, dest: string): void {
  try {
    if (realpathSync(dest) === realpathSync(src)) return
  } catch {
    // dest doesn't exist yet, or is a broken symlink — copy is correct.
  }
  copyFileSync(src, dest)
}

/**
 * Write hydra's files into every version directory of the plugin cache.
 * Best-effort by design: a spawn with a stale cache is worth attempting, and
 * throwing here would turn a degraded bridge into no session at all.
 */
export function syncPluginCache(context: 'boot' | 'spawn'): void {
  try {
    const cacheDir = pluginCacheDir()
    const daemonConfig = JSON.stringify({ socket: SOCK_PATH, platform: PLATFORM })
    const versionDirs = readdirSync(cacheDir, { withFileTypes: true }).filter(d => d.isDirectory())

    for (const dir of versionDirs) {
      const targetDir = join(cacheDir, dir.name)
      copyBridgeSource(bridgeSourcePath(), join(targetDir, 'server.ts'))
      writeIfChanged(join(targetDir, `daemon-${PLATFORM}.json`), daemonConfig)
      writeIfChanged(join(targetDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          discord: {
            command: 'bun',
            args: ['run', '--cwd', targetDir, '--shell=bun', '--silent', 'start'],
          },
        },
      }, null, 2))
      mkdirSync(join(targetDir, '.claude-plugin'), { recursive: true })
      writeIfChanged(join(targetDir, '.claude-plugin', 'plugin.json'), pluginJson)
    }

    if (context === 'boot') {
      process.stderr.write(`daemon: synced bridge.ts + daemon-${PLATFORM}.json + .mcp.json into ${cacheDir}/*/ (${versionDirs.length} version dir(s))\n`)
    }
  } catch (err) {
    process.stderr.write(`daemon: plugin cache sync skipped at ${context} (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
