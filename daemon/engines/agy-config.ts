// What hydra keeps in agy's config files so that agy sessions work. agy reads MCP servers and hooks only from these two files (no per-session or
// per-launch setting takes them), so both entries are there for the operator's own agy runs too. The hook writes only where HYDRA_AGY_STATE points, so it does
// nothing there; the tool server needs the session's environment and exits without it, so in an agy run outside hydra `/mcp` lists `hydra` as failed (harmless).
// Each launch makes sure its entry is right. The entries point at the checkout that launched last, so run one hydra daemon per user: a second one
// (staging, a worktree) would repoint a running session's hook at its own checkout.
//  - `hydra` MCP server: the hydra tools (reply, react, send_to_thread, ...) reach an agy session through the stdio MCP server Codex uses
//    (daemon/codex-mcp-server.ts); agy starts it with the session's environment, so DAEMON_SOCK and HYDRA_SESSION_ID are the session's own.
//  - `hydra` hooks (daemon/agy-hook.ts): agy tells them the conversation id and when it is working or idle.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const GEMINI_CONFIG = join(homedir(), '.gemini', 'config')
export const AGY_MCP_CONFIG = join(GEMINI_CONFIG, 'mcp_config.json')
export const AGY_HOOKS_CONFIG = join(GEMINI_CONFIG, 'hooks.json')
const TOOL_SERVER = join(import.meta.dir, '..', 'codex-mcp-server.ts')
const HOOK_SCRIPT = join(import.meta.dir, '..', 'agy-hook.ts')
const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

// Rewrites `file` only when `edit` changes something. Throws if the file is not JSON.
function update(file: string, edit: (config: any) => boolean): void {
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  if (!edit(config)) return
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`   // a reader never sees a half-written file
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n')
  renameSync(temp, file)
}

/** Make `hydra` an MCP server in agy's config, pointing at this checkout's tool server. Everything else in the file is kept. Throws if the file is not JSON. */
export function registerHydraTools(file = AGY_MCP_CONFIG): void {
  update(file, config => {
    const have = config.mcpServers?.hydra
    if (have?.command === process.execPath && have.args?.length === 1 && have.args[0] === TOOL_SERVER) return false
    config.mcpServers = { ...config.mcpServers, hydra: { ...have, command: process.execPath, args: [TOOL_SERVER] } }
    return true
  })
}

const HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'Stop'] as const

/** Make `hydra` a hook group in agy's hooks file: this checkout's hook script on the session start, before each model call and at each stop. Everything else is kept. Throws if the file is not JSON. */
export function registerHydraHooks(file = AGY_HOOKS_CONFIG): void {
  const want = Object.fromEntries(HOOK_EVENTS.map(e => [e, [{ type: 'command', command: `${shq(process.execPath)} ${shq(HOOK_SCRIPT)} ${e}`, timeout: 10 }]]))
  update(file, config => {
    if (JSON.stringify(config.hydra) === JSON.stringify(want)) return false
    config.hydra = want
    return true
  })
}
