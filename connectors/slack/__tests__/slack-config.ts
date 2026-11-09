// Test helper: a Slack view of a hydra.toml, as the listener would build it once connected.
import { loadHydraConfig } from '../../../config/load.js'
import type { HydraConfig, LoadEnv } from '../../../config/types.js'
import { SLACK_LIMITS, type SlackDirectory, type SlackWatchConfig } from '../watch.js'

export const BOT = 'UBOT'
const env: LoadEnv = { home: '/home/op', isDir: () => true, isCommand: () => true, sessionNames: [] }

export function hydra(text: string): HydraConfig {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return r.config
}

/** The operator and the Slack connector: every config starts with these. */
export const BASE = `
operator = "op"
[connectors.slack]
bot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"
app_token_env = "SLOPBOT_SLACK_APP_TOKEN"
[people.op]
ids = ["slack:UOP"]
`

/** One specialist listening on one channel, open to `allow`. */
export const oneListener = (channel: string, to = 'slopbot', allow = '["anyone"]', extra = '') => `${BASE}
[specialists.${to}]
workdir = "/w/${to}"
listens = ["slack:${channel}"]
allow = ${allow}
${extra}`

export function directory(names: Record<string, string> = {}): SlackDirectory {
  return { nameOf: id => names[id], idOf: name => Object.entries(names).find(([, n]) => n === name)?.[0] }
}

export type ViewOver = Partial<Omit<SlackWatchConfig, 'hydra' | 'directory'>> & { toml?: string; names?: Record<string, string> }
export function view(defaultToml: string, { toml, names, ...over }: ViewOver = {}): SlackWatchConfig {
  return { hydra: hydra(toml ?? defaultToml), botUserId: BOT, workspaceUrl: 'https://x.slack.com', directory: directory(names), ...SLACK_LIMITS, coalesceMs: 5, ...over }
}
