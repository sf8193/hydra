// The hydra tools (reply, react, send_to_thread, ...) reach an agy session through the same stdio MCP server Codex uses
// (daemon/codex-mcp-server.ts): agy starts it with the session's environment, so DAEMON_SOCK and HYDRA_SESSION_ID are the session's own.
// agy reads MCP servers from this one file (no per-session or per-launch setting takes them), so each launch makes sure the entry is there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export const AGY_MCP_CONFIG = join(homedir(), '.gemini', 'config', 'mcp_config.json')
const TOOL_SERVER = join(import.meta.dir, '..', 'codex-mcp-server.ts')

/** Make `hydra` an MCP server in agy's config, pointing at this checkout's tool server. Everything else in the file is kept. Throws if the file is not JSON. */
export function registerHydraTools(file = AGY_MCP_CONFIG): void {
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const have = config.mcpServers?.hydra
  if (have?.command === process.execPath && have.args?.length === 1 && have.args[0] === TOOL_SERVER) return
  config.mcpServers = { ...config.mcpServers, hydra: { ...have, command: process.execPath, args: [TOOL_SERVER] } }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}
