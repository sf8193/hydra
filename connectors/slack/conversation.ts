// A Slack conversation's identity: the app that heard it, the channel, and the thread. A leaf: no daemon, no Bolt.
// The format is documented once, in docs/slack.md ("Conversations and replies, per app").

import { DEFAULT_SLACK_APP } from '../../config/types.js'

/** A thread's ts, or a DM's top level (below). */
export const THREAD_TS = /^\d{1,12}\.\d{1,6}$/

/**
 * A DM's top level, or a `listen = "all"` place's untagged top-level messages, is one conversation, under this ts.
 * Never a real ts: it must not reach a Slack API call or the guard.
 */
export const TOP_LEVEL = '0.000000'

export type ConversationRef = { app?: string; channel: string; threadTs: string }

/** The app an entry or conversation went through; absent is `default`. */
export const appOfEntry = (e: { app?: string }): string => e.app ?? DEFAULT_SLACK_APP

/** The app id, then `sep`, for any app but `default`; nothing for `default`, so its keys are what they always were. */
export const appPrefix = (app: string | undefined, sep: string): string => (app ?? DEFAULT_SLACK_APP) === DEFAULT_SLACK_APP ? '' : `${app}${sep}`

/** A key for something of one app: `channel:ts` for `default`, `app:channel:ts` for any other. The one place that spells it. */
export const scopeKey = (app: string | undefined, ...parts: string[]): string => appPrefix(app, ':') + parts.join(':')

/** `scopeKey` read back: the app (absent for `default`) and the rest. An app id is lowercase and a channel id uppercase, so the first part tells them apart. */
export function unscopeKey(key: string): { app?: string; rest: string } {
  const m = key.match(/^([a-z][a-z0-9_-]{0,34}):(.*)$/s)
  return m ? { app: m[1], rest: m[2] } : { rest: key }
}

/** A conversation's id, as `hydra conversations`, the guard, `reply` and `bind_conversation` name it. */
export const conversationId = (e: ConversationRef): string =>
  `slack:${appPrefix(e.app, ':')}${e.channel}${e.threadTs === TOP_LEVEL ? '' : `:${e.threadTs}`}`

const CONVERSATION_RE = /^slack:(?:([a-z][a-z0-9_-]{0,34}):)?([CGD][A-Z0-9]+)(?::(\d{1,12}\.\d{1,6}))?$/

export const CONVERSATION_FORMAT = 'slack:<channel id>[:<thread ts>], with the app first outside `default` (slack:<app>:<channel id>[:<thread ts>]), e.g. slack:C0ABC:1793732224.093059 or slack:sales:C0ABC:1793732224.093059'

/**
 * A conversation id as `hydra conversations` prints it. `app` is left out for `default`, as a stored entry leaves it out:
 * the old form (no app) and `slack:default:C0ABC` are the same conversation.
 */
export function parseConversation(raw: unknown): { app?: string; channel: string; threadTs: string } {
  const m = typeof raw === 'string' ? raw.trim().match(CONVERSATION_RE) : null
  if (!m) throw new Error(`conversation must look like ${CONVERSATION_FORMAT}, as hydra conversations prints it`)
  const [, app, channel, ts] = m
  if (ts && !THREAD_TS.test(ts)) throw new Error('thread ts must look like 1793732224.093059')
  return { ...(app && app !== DEFAULT_SLACK_APP && { app }), channel, threadTs: ts ?? TOP_LEVEL }
}
