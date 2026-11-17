// Test helper: a Slack view of a hydra.toml, as the listener would build it once connected.
import { loadHydraConfig } from '../../../config/load.js'
import type { HydraConfig, LoadEnv } from '../../../config/types.js'
import { SLACK_LIMITS, type SlackDirectory, type SlackWatchConfig } from '../watch.js'
import { testLoadEnv } from '../../../config/__tests__/load-env.js'

export const BOT = 'UBOT'
const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })

export function hydra(text: string): HydraConfig {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return r.config
}

/** The operator and the Slack connector: every config starts with these. */
export const BASE = `
operator = "op"
[slack.apps.default]
bot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"
socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"
[people.op]
addresses = ["slack:UOP"]
`

/** The second app's bot user id. The first (`default`) is `BOT`. */
export const SALES_BOT = 'USALES'

/** Two Slack apps: `default` (from BASE's `[slack.apps.default]`) and `sales`. */
export const TWO_APPS = `${BASE}
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
socket_token_env = "SALES_SLACK_APP_TOKEN"
`

/**
 * Two apps in one channel: `crm` (unpinned, so it answers the app `default`) and `deals` (pinned to `sales`) are both
 * sent it, which is allowed because no app reaches both.
 */
export const sharedChannel = (channel: string, place = '') => `${TWO_APPS}
[specialists.crm]
workdir = "/w/crm"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:${channel}"
target = "specialist:crm"
[specialists.deals]
workdir = "/w/deals"
pinned_to = ["app:sales"]
reachable_by = ["role:anyone"]
${place}
[[rules]]
place = "slack:${channel}"
target = "specialist:deals"
`

/** The same file, with more rules: each place sent to `to`, after the rules already there. */
export const alsoHeard = (toml: string, to: string, ...places: string[]) => `${toml.replace(/\n*$/, '\n')}${places.map(p => `[[rules]]\nplace = "${p}"\ntarget = "specialist:${to}"\n`).join('')}`

/** One specialist sent one channel, open to `allow`. */
export const oneListener = (channel: string, to = 'helper', reachableBy = '["role:anyone"]', extra = '') => {
  // A rule written in `extra` is the file's own: it goes before the rule that sends the channel to `to`, so that a rule for a person is reached.
  const own = extra.match(/\[\[rules\]\]\n(?:[^\[\n][^\n]*\n)*/g) ?? []
  const rest = own.reduce((e, r) => e.replace(r, ''), extra)
  return `${BASE}\n${own.join('')}[specialists.${to}]\nworkdir = "/w/${to}"\nreachable_by = ${reachableBy}\n${rest}\n[[rules]]\nplace = "slack:${channel}"\ntarget = "specialist:${to}"\n`
}

/** The same file with rules written first: the rules for a person or an app, which must come before the rule for everyone at a place. */
export const firstRules = (toml: string, rules: string) => { const i = toml.indexOf('[specialists.'); return i < 0 ? `${toml}${rules}` : `${toml.slice(0, i)}${rules}${toml.slice(i)}` }

/** `dms`: who each DM channel is with (a Slack user id, or 'bot'); given, the directory knows DMs, as an app with the operator's user token does. `groupDms`: channels that are group DMs. */
export function directory(names: Record<string, string> = {}, dms?: Record<string, string>, groupDms: string[] = []): SlackDirectory {
  return {
    nameOf: id => names[id], idOf: name => Object.entries(names).find(([, n]) => n === name)?.[0],
    isGroupDm: c => groupDms.includes(c),
    ...(dms && { otherPartyOf: (dm: string) => dms[dm] === undefined ? undefined : dms[dm] === 'bot' ? 'bot' as const : { user: dms[dm] } }),
  }
}

export type ViewOver = Partial<Omit<SlackWatchConfig, 'hydra' | 'directory'>> & { toml?: string; names?: Record<string, string>; dms?: Record<string, string>; groupDms?: string[] }
export function view(defaultToml: string, { toml, names, dms, groupDms, ...over }: ViewOver = {}): SlackWatchConfig {
  return { hydra: hydra(toml ?? defaultToml), botUserId: BOT, workspaceUrl: 'https://x.slack.com', directory: directory(names, dms, groupDms), ...SLACK_LIMITS, coalesceMs: 5, ...over }
}
