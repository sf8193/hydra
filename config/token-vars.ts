// The environment variables hydra.toml names as token variables, found without validating the file, so the daemon can
// keep them from every session it starts even when the file does not load. Names only: no token passes through here.
// A token variable is one hydra holds for its own use: a Slack app's tokens, the Discord gateway's bot token, and each
// [mcp_servers.*] `token_env` (held for the server hydra starts, which gets its own and nothing else's).

import { readFileSync } from 'fs'
import type { HydraConfig } from './types.js'
import { ENV_NAME_RE, registerSpawnVars, type SpawnVarRefusal } from '../shared/spawn-env.js'

const SLACK_KEYS = ['bot_token_env', 'socket_token_env', 'operator_token_env']
const SLACK_TABLE = /^slack\.apps\.[^.\s]+$/
const DISCORD_TABLE = /^gateways\.discord$/
const SERVER_TABLE = /^mcp_servers\.[^.\s]+$/

/** Every variable a loaded config reads a token from: its Slack apps', the Discord gateway's, and its servers'. */
export function tokenEnvNames(config: Pick<HydraConfig, 'slackApps' | 'gateways' | 'mcpServers'>): string[] {
  const names = [
    ...Object.values(config.slackApps).flatMap(a => [a.botTokenEnv, a.socketTokenEnv, a.operatorTokenEnv]),
    config.gateways?.discord?.botTokenEnv,
    ...Object.values(config.mcpServers ?? {}).flatMap(s => s.tokenEnv),
  ]
  return [...new Set(names.filter((v): v is string => !!v))]
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The token variables the file names, valid or not: read from the parsed TOML, or, when the file is not valid TOML, line
 * by line under their `[slack.apps.<id>]`, `[gateways.discord]` and `[mcp_servers.<name>]` headers. Names of the wrong
 * shape are left out here (the loader reports them).
 */
export function scanTokenEnvNames(text: string): string[] {
  const found = new Set<string>()
  const take = (v: unknown) => { if (typeof v === 'string' && ENV_NAME_RE.test(v)) found.add(v) }
  try {
    const doc = Bun.TOML.parse(text) as Record<string, unknown>
    if (isTable(doc.slack) && isTable(doc.slack.apps)) for (const t of Object.values(doc.slack.apps)) if (isTable(t)) for (const k of SLACK_KEYS) take(t[k])
    if (isTable(doc.gateways) && isTable(doc.gateways.discord)) take(doc.gateways.discord.bot_token_env)
    if (isTable(doc.mcp_servers)) for (const t of Object.values(doc.mcp_servers)) if (isTable(t) && Array.isArray(t.token_env)) t.token_env.forEach(take)
  } catch {
    let table: 'slack' | 'discord' | 'server' | undefined
    let inList = false   // inside a `token_env = [` that has not closed yet
    for (const line of text.split('\n')) {
      const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)
      if (header) {
        const name = header[1].trim()
        table = SLACK_TABLE.test(name) ? 'slack' : DISCORD_TABLE.test(name) ? 'discord' : SERVER_TABLE.test(name) ? 'server' : undefined
        inList = false
        continue
      }
      if (!table) continue
      const body = line.replace(/#.*$/, '')
      const kv = /^\s*([a-z_]+)\s*=\s*(.*)$/.exec(body)
      if (kv && !inList) {
        if (table === 'server' && kv[1] === 'token_env') { inList = !kv[2].includes(']'); for (const m of kv[2].matchAll(/"([^"]*)"/g)) take(m[1]) }
        else if ((table === 'slack' && SLACK_KEYS.includes(kv[1])) || (table === 'discord' && kv[1] === 'bot_token_env')) take(/^"([^"]*)"/.exec(kv[2])?.[1])
      } else if (inList) {
        for (const m of body.matchAll(/"([^"]*)"/g)) take(m[1])
        if (body.includes(']')) inList = false
      }
    }
  }
  return [...found]
}

/** Keeps the token variables a hydra.toml's text names from every session this process starts, whether or not it loads. */
export function scrubTokenVarsNamedIn(text: string): SpawnVarRefusal[] {
  return registerSpawnVars(scanTokenEnvNames(text)).refused
}

/** The same, for the file at `path`; a missing or unreadable file names nothing. */
export function scrubTokenVarsInFile(path: string): SpawnVarRefusal[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  return scrubTokenVarsNamedIn(text)
}
