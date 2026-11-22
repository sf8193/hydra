// What hydra keeps in agy's config files: the `hydra` MCP server (the tools reach agy through the stdio server Codex uses, daemon/codex-mcp-server.ts) and the
// `hydra` hooks (daemon/agy-hook.ts: the conversation id, working or idle). agy reads both only from these files, so they are there for the operator's own agy
// runs too (the hook then records nothing; `/mcp` lists `hydra` as failed, harmless). The entries point at the checkout that launched last: run one hydra daemon per user.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { shq } from '../launch-files.js'

const GEMINI_CONFIG = join(homedir(), '.gemini', 'config')
export const AGY_MCP_CONFIG = join(GEMINI_CONFIG, 'mcp_config.json')
export const AGY_HOOKS_CONFIG = join(GEMINI_CONFIG, 'hooks.json')
const TOOL_SERVER = join(import.meta.dir, '..', 'codex-mcp-server.ts')
const HOOK_SCRIPT = join(import.meta.dir, '..', 'agy-hook.ts')

// Rewrites `file` only when `edit` changes something. Throws if the file is not JSON. An empty file counts as `{}`: agy itself leaves a 0-byte mcp_config.json.
function update(file: string, edit: (config: any) => boolean): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  const config = text ? JSON.parse(text) : {}
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
