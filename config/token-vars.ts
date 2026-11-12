// The environment variables hydra.toml names as Slack token variables, found without validating the file, so the daemon
// can keep them from every session it starts even when the file does not load. Names only: no token passes through here.

import { readFileSync } from 'fs'
import type { HydraConfig } from './types.js'
import { ENV_NAME_RE, registerSpawnVars, type SpawnVarRefusal } from '../shared/spawn-env.js'

const KEYS = ['bot_token_env', 'app_token_env', 'user_token_env']
const SLACK_TABLE = /^(connectors\.slack|slack\.apps\.[^.\s]+)$/

/** Every variable a loaded config's Slack apps read tokens from. */
export function slackEnvNames(config: Pick<HydraConfig, 'slackApps'>): string[] {
  return Object.values(config.slackApps).flatMap(a => [a.botTokenEnv, a.appTokenEnv, a.userTokenEnv].filter((v): v is string => !!v))
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The token variables the file's Slack tables name, valid or not: read from the parsed TOML, or, when the file is not
 * valid TOML, line by line under their `[connectors.slack]` and `[slack.apps.<id>]` headers. Names of the wrong shape
 * are left out here (the loader reports them).
 */
export function scanSlackEnvNames(text: string): string[] {
  const found = new Set<string>()
  const take = (v: unknown) => { if (typeof v === 'string' && ENV_NAME_RE.test(v)) found.add(v) }
  try {
    const doc = Bun.TOML.parse(text) as Record<string, unknown>
    const conns = isTable(doc.connectors) ? doc.connectors : {}
    const tables = [conns.slack, ...(isTable(doc.slack) && isTable(doc.slack.apps) ? Object.values(doc.slack.apps) : [])]
    for (const t of tables) if (isTable(t)) for (const k of KEYS) take(t[k])
  } catch {
    let inSlack = false
    for (const line of text.split('\n')) {
      const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)
      if (header) { inSlack = SLACK_TABLE.test(header[1].trim()); continue }
      const kv = /^\s*([a-z_]+)\s*=\s*"([^"]*)"/.exec(line)
      if (inSlack && kv && KEYS.includes(kv[1])) take(kv[2])
    }
  }
  return [...found]
}

/** Keeps the token variables a hydra.toml's text names from every session this process starts, whether or not it loads. */
export function scrubTokenVarsNamedIn(text: string): SpawnVarRefusal[] {
  return registerSpawnVars(scanSlackEnvNames(text)).refused
}

/** The same, for the file at `path`; a missing or unreadable file names nothing. */
export function scrubTokenVarsInFile(path: string): SpawnVarRefusal[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  return scrubTokenVarsNamedIn(text)
}
