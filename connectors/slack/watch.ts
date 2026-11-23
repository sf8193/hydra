import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import { STATE_DIR } from '../../infra/config.js'
import { atomicWriteFileSync } from '../../infra/util.js'
import { recordEvent } from '../../infra/events.js'
import { HYDRA_ACTOR, type BindReason, type UnbindReason } from '../../shared/events.js'
import { DEFAULT_SLACK_APP, isChannelName, isDmPlace, optionsAt, optionsOf, placeCovers, placeKey, placeOf, type Address, type HydraConfig, type Place, type PlaceOptions, type SlackApp } from '../../config/types.js'
import { appKey, appName, type Apps } from './app.js'
import { attr, fence, oneLine, quoteBody, UNTRUSTED_TEXT_MAX_CHARS } from '../../shared/untrusted-text.js'
import { archiveUrl, conversationId, appOfEntry, appPrefix, scopeKey, unscopeKey, TOP_LEVEL } from '../../shared/slack-conversation.js'
import { hearsApp } from '../../config/hears.js'
import { reachableBy, route, owningApp, refusal, notServedBy, identify, currentId, isLive, isSessionThread, withoutFallbacks, routerOf, MAIN } from '../../routing/route.js'

export { conversationId, appOfEntry, TOP_LEVEL }

/** Where a delivery goes: a specialist (or `main`), and the conversation it is for, so a per-conversation specialist can give it its own session. */
export type RouteTarget = { to: string; conversation?: string }
import { runGuard, type GuardInput, type GuardVerdict } from '../../routing/guard.js'
import type { Guard } from '../../config/types.js'
import type { DeliverOutcome } from '../../app/targets.js'
import { spelledBare } from '../../shared/target-kind.js'
import { receivedLine, type LinePoster } from './lines.js'

/**
 * Slack conversations: the Slack connector's side of routing (routing/route.ts).
 *
 * A conversation is a Slack thread, or a DM's top level. It opens when the bot is tagged (or posts the thread's
 * first message, or someone DMs it), and is bound then to the specialist routing picks; from then on every reply is
 * delivered to that specialist, tagged or not, until it goes idle. A config change re-routes only new conversations;
 * `reachable_by` is checked again at delivery. Where `messages = "all"`, an untagged top-level message opens a conversation too:
 * its own thread, bound to wherever that one message routed.
 *
 * This file is the matcher and the store. It never talks to Slack: events come in
 * through `handle`, and deliveries go out through `deps.deliver`.
 *
 * Nothing is lost silently. A message is `owed` from the moment it is accepted until
 * a delivery lands, and owed is persisted before anything is sent, so a crash inside
 * the coalescing window leaves a trail the catch-up pass can follow. What was
 * `delivered` is remembered exactly, so replaying history never delivers twice.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An attachment as an event carries it. */
export type SlackFile = { id: string; name: string; size?: number; url?: string }
/** An attachment as the session reads it: where it was saved, or why it was not. */
export type FileRef = { name: string; size?: number; path?: string; note?: string }

/** What the watcher may do in Slack, through one app: react (the ack, and 🚫 on a refused or unrouted mention or DM) and download the files it reads. */
export type SlackActions = {
  download: (url: string, dest: string, maxBytes: number) => Promise<void>
  react: (channel: string, ts: string, name: string) => Promise<void>
}

/** Who is on the other end of a DM channel: the bot, or a Slack user. */
export type DmOtherParty = 'bot' | { user: string }

/**
 * Slack channel names, from conversations.list: id → name (without `#`) and back. Empty without channels:read or groups:read.
 * The DM questions are asked only of an app with the operator's user token, which hears DMs between the operator and others:
 * `otherPartyOf` is who a DM channel is with (undefined: not known, so the DM names no place), and `isGroupDm` whether a channel
 * is a group DM (its id looks like a channel's; the event said so). Without `otherPartyOf`, every DM is the bot's.
 */
export type SlackDirectory = {
  nameOf(id: string): string | undefined
  idOf(name: string): string | undefined
  otherPartyOf?(dm: string): DmOtherParty | undefined
  isGroupDm?(channel: string): boolean
}
export const NO_DIRECTORY: SlackDirectory = { nameOf: () => undefined, idOf: () => undefined }

/**
 * What the watcher reads for one app: `hydra.toml`, plus what that app's Slack connection learned (its own ids, the
 * workspace, channel names). Read per event, so an edit applies without a restart.
 */
export type ConversationConfig = {
  hydra: HydraConfig
  /** The app this connection is. Absent: the app named `default`. */
  app?: string
  /** Every connected app's bot ids, by app id (each connection's auth.test): `<@id>` of any of them in a text is a tag of that app. Absent: only this app. */
  identities?: Record<string, { botUserId: string; botId?: string }>
  /** The apps whose bot is in this channel (this one included), read from a cache the connections share; Absent: only this app. */
  heardBy?: (channel: string) => string[]
  /** Of these apps, the ones whose membership in this channel was never read. Absent: none. */
  unread?: (channel: string, apps: string[]) => string[]
  /** The apps with a live connection. A tagged app with none will catch the message up itself, so no other answers it. Absent: all. */
  connected?: () => string[]
  /** The owning app of a message, fixed by whichever connection asks first, so the other connections' copies agree. Absent (one app): decided on the spot. */
  decideOwningApp?: (channel: string, ts: string, decide: () => string) => string
  /** The bot's Slack user id: `<@id>` in a message text is a tag. From auth.test. */
  botUserId: string
  /** Its bot id (`B…`), for message events that carry no `user`. From auth.test. */
  botId?: string
  /** `https://<workspace>.slack.com`, for permalinks in deliveries. From auth.test. */
  workspaceUrl?: string
  directory: SlackDirectory
  idleExpiryMs: number
  /** Replies arriving within this window of each other are delivered as one message. */
  coalesceMs: number
  /** Upper bound on conversations: a tag from anyone creates one. */
  maxConversations: number
  /** Tags one person may land in ten minutes before the rest are dropped. */
  maxMentionsPer10Min: number
  /** Reactions one person may land in ten minutes before the rest are dropped. */
  maxReactionsPer10Min: number
}

/** The limits hydra.toml has no key for. */
export const SLACK_LIMITS = { idleExpiryMs: 7 * 86_400_000, coalesceMs: 4000, maxConversations: 50, maxMentionsPer10Min: 10, maxReactionsPer10Min: 30 } as const

/**
 * A conversation: a Slack thread (or a DM's top level) and the specialist it is bound to. The binding is fixed when
 * its first message arrives; a config change re-routes only new conversations, and `bind_conversation` moves one.
 */
export type ConversationEntry = {
  /** The app that heard it, so every reply, reaction and reread goes through that app. Absent: the app named `default` (every entry stored before apps existed). */
  app?: string
  channel: string
  threadTs: string
  /** Where this conversation is bound: a specialist, main, or a session's own thread id. Absent only in a store written before bindings: its next message binds it. */
  specialist?: string
  /** Who opened it: the tagger's user id, `tool`, `home`, `cli` or `router` when a bind opened it, nothing for the bot's own post. Never changes. */
  mentionedBy?: string
  createdAt: number
  /** Last matching event, delivered or not: the idle clock. */
  lastEventAt: number
  /** ts of messages already delivered (recent ones, oldest dropped): the exact dedupe. */
  delivered?: string[]
  /** ts of messages accepted but not yet delivered. Persisted before sending; tells catch-up where to look. */
  owed?: string[]
  /** Opened by untagged chatter where `messages = "all"`: while owed or answered, such conversations take at most half the table; they idle out in a day. */
  ambient?: true
  /** Who holds it by hand (`BOUND_BY`): a session's tool, a reply's thread, the operator's CLI, a router's hand-off. Every bind by hand
   *  overwrites it; a binding moved by routing (a tag taking a thread from a session) clears it. Absent: routing's alone. Held: never evicted,
   *  and a session's (`tool`, `home`) counts toward its `TOOL_BIND_MAX` (`heldBySession`). */
  boundBy?: BoundBy
  /** When the last message delivered to its specialist went, while no reply has followed (`touch` clears it): within `REPLY_WAIT_MS` the conversation is busy, not quiet, and is not let go. Not kept for chatter, which a specialist may rightly leave unanswered. */
  unansweredAt?: number
  /** When the guard first said deferred (exit 75) to an owed ts: `owed_max` counts from here. */
  deferredSince?: Record<string, number>
  /** `deferredSince`'s two older names, in a store written before the rename: read by `readOldNames`, never written. */
  heldSince?: Record<string, number>
  notNowSince?: Record<string, number>
  /** Since when it has waited for a session of its own (its specialist at `max_sessions`): its owed messages don't expire meanwhile, and the oldest waiter takes the next freed place. */
  waitingSince?: number
  /** Since when no session has been in the session thread this is bound to (see `VACANT_RELEASE_MS`). Set once, kept across restarts, cleared when a session is there again; a conversation bound to an empty thread starts its clock at the next reconcile (a session's death, or the hourly sweep). */
  vacantSince?: number
  /** Read with the operator's user token, because the bot is not in the channel: heard live through the app's events as the operator, and reread by every deep catch-up. Absent: the bot reads it. */
  via?: 'user'
  /** `<message ts>:<reaction>:<user>` of the reactions already delivered (recent ones, oldest dropped): the exact dedupe, so Slack sending an event again, or a person adding it twice, delivers once. Never in `delivered`: that is built from messages, and a catch-up cursor follows it. */
  reacted?: string[]
  /** ts of the bot's own messages in this conversation (recent ones, oldest dropped), kept only where the place hears reactions: Slack's reaction event names the message, not its thread, so this is how a reaction on the bot's reply is found. */
  ours?: string[]
}

/** The fields of a Slack `reaction_added` event this module reads. */
export type SlackReactionEvent = {
  /** The app whose connection delivered it. Absent: `default`. */
  app?: string
  channel: string
  /** The message reacted to. */
  itemTs: string
  /** Who wrote that message, when Slack says. */
  itemUser?: string
  /** The emoji's name, as Slack gives it (`white_check_mark`). */
  reaction: string
  /** Who reacted. */
  user: string
  /** When they reacted: unique per reaction, and ordered with messages. */
  eventTs: string
}

/** `accepted`: it will be delivered to the conversation's session. `ignored`: it is nobody's, silently. */
export type ReactionOutcome = 'accepted' | 'ignored'

/** The fields of a Slack `message` event this module reads. */
export type SlackMessageEvent = {
  /** The app whose connection delivered it. Absent: `default`. */
  app?: string
  channel: string
  ts: string
  threadTs?: string
  user?: string
  botId?: string
  subtype?: string
  text?: string
  files?: SlackFile[]
}

export type ConversationDeps = {
  now: () => number
  /**
   * The delivery's outcome as targets.ts gives it. A refusal that is `permanent` (it can never be delivered: too large) is dropped,
   * never retried. Exit 8 (the binding names no such specialist, or, `malformed`, a target hydra cannot read) is kept owed, since a
   * fixed config delivers it, and alerted. `wait` (its specialist runs `max_sessions` conversation sessions already) is kept owed,
   * and never expires while it waits.
   */
  deliver: (target: RouteTarget, message: string, idempotencyKey: string) => Promise<DeliverOutcome>
  /** One app's view, read per event so edits apply without a restart. Null: that app isn't connected, nothing is heard through it. Absent `app`: `default`. */
  config: (app?: string) => ConversationConfig | null
  /** Every app hydra.toml declares now, to name one in a message. Absent: each is named by its id. */
  apps?: () => Apps
  file: string
  log: (line: string) => void
  /** Slack user id to display name (users.info). Optional; deliveries carry the id either way. */
  resolveName?: (userId: string) => Promise<string | undefined>
  /** Where downloaded attachments go: `<dir>/<channel>/<file id>-<name>` for the app `default`, `<dir>/<app>/<channel>/<file id>-<name>` for any other. */
  filesDir?: string
  /**
   * For a file downloaded for the specialist `to`: when `to` reads only its own folder (a write-confined specialist: the state folder, where `filesDir` is, is denied to it),
   * copies the downloaded `src` into its inbox and returns the new path, which the delivery then carries instead. Returns undefined for any other specialist (the download's path stands);
   * throws when the inbox refuses the file (a link in its place, full), and the file is listed with why.
   */
  placeFile?: (to: string, src: string, name: string) => string | undefined
  /** Runs the guard. Defaults to the real subprocess; tests pass a fake. */
  guard?: (g: Guard, input: GuardInput) => Promise<GuardVerdict>
  /** A plain message to a person (not a session turn): how a drop is surfaced. `to`: the specialist it concerns, whose `home_place` should hear it. */
  alert?: (text: string, to?: string, app?: string) => void
  hosted?: (threadId: string) => boolean
  /** Whether the session in this thread may speak in a conversation bound to it (a plain session). Absent, or no session there: it only listens. */
  speaksIn?: (threadId: string) => boolean
  /** Shows a line in a session's own thread (connectors/slack/lines.ts). Absent: no lines. Given the thread of a session that hosts the conversation. */
  line?: LinePoster
}

/** `refused`: `reachable_by` does not admit the sender. `unrouted`: a mention or DM no specialist hears. */
export type HandleOutcome = 'mention' | 'follow-up' | 'dm' | 'subscribed' | 'refused' | 'unrouted' | 'ignored'

/** Why an accepted (or would-be accepted) message will never be delivered. */
/** `refused` / `unrouted`: accepted and owed, then `reachable_by` or the config changed so it can no longer go anywhere. `unbound`: owed when its conversation was let go. */
export type DropKind = 'reaction-cap' | 'expired' | 'owed-full' | 'too-large' | 'tag-cap' | 'table-full' | 'guard' | 'catch-up-gap' | 'refused' | 'unrouted' | 'unbound'

/** An owed message that has waited past the health threshold: the conversation, who it is for, how many, how long, and why (with what to do). */
export type LateOwed = { conversation: string; to?: string; count: number; oldestAgeMin: number; cause: string }
export type ConversationStats = { refused: number; refusedBy: Record<string, number>; unrouted: number; dropped: Partial<Record<DropKind, number>> }

/** The reaction on a refused or unrouted mention or DM. Hydra's notices are reactions, never prose. */
export const REFUSED_REACTION = 'no_entry_sign'
/** The reaction on a tag that reaches the router: seen at once, before the router (a session that may have to start) has read it. */
export const ROUTED_REACTION = 'eyes'

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export const slackWatchesPath = () => join(STATE_DIR, 'slack-watches.json')

/** Slack DM channel ids start with D, in events and in history alike. */
export const isDm = (channel: string): boolean => /^D[A-Z0-9]+$/.test(channel)

/**
 * Every name a Slack channel goes by, most specific first, and the one place that turns a channel into places:
 *  - a channel: `slack:C0ABC`, then `slack:#help` once its name is known;
 *  - a DM with this app's bot: `slack:app-dm:<app>`;
 *  - a DM with a person in `[people]`: `slack:person-dm:<person>`;
 *  - a group DM: `slack:C0ABC` (and its name), then `slack:group-dm:<id>`.
 * A rule or `[places]` entry written with `*` (`slack:app-dm:*`, `slack:group-dm:*`) names every place of its kind, so it matches these (`placeCovers`).
 * A DM with someone not in `[people]`, or one whose other party is not known yet, goes by no name: nothing can name it, so it is dropped.
 */
export function placesOf(cfg: Pick<ConversationConfig, 'hydra' | 'directory' | 'app'>, channel: string): Place[] {
  const d = cfg.directory
  if (isDm(channel)) {
    const other: DmOtherParty | undefined = d.otherPartyOf ? d.otherPartyOf(channel) : 'bot'
    if (other === 'bot') return [placeOf('slack', 'app-dm', cfg.app ?? DEFAULT_SLACK_APP)]
    const who = other && Object.values(cfg.hydra.people).find(p => p.addresses.includes(`slack:${other.user}`))
    return who ? [placeOf('slack', 'person-dm', who.id)] : []
  }
  const name = d.nameOf(channel)
  return [placeOf('slack', 'channel', channel), ...(name ? [placeOf('slack', 'channel', `#${name}`)] : []), ...(d.isGroupDm?.(channel) ? [placeOf('slack', 'group-dm', channel)] : [])]
}

/** How a place reads to a person (the string hydra.toml writes it as): by name when known. */
export const placeName = (cfg: Pick<ConversationConfig, 'hydra' | 'directory' | 'app'>, channel: string): string => placeKey(placesOf(cfg, channel).at(-1) ?? placeOf('slack', 'channel', channel))

/**
 * The Slack channels hydra.toml names in `[[rules]]` (those with a `place`), as written: channels only, to be read by id
 * (not DMs, and not `namedPlace`, which asks whether one event's place is named at all). For one `app`: only those it
 * can deliver to (`reachableBy`), so an app is not asked to read a channel it has nothing to do in.
 */
export function namedChannels(h: HydraConfig, app?: string): Place[] {
  const r = reachableBy(h, app)
  return [...new Map(r.rules.flatMap(x => x.place && x.place.platform === 'slack' && x.place.kind === 'channel' ? [[placeKey(x.place), x.place] as const] : [])).values()]
}

const channelIdOf = (cfg: Pick<ConversationConfig, 'directory'>, place: Place): string | undefined =>
  isChannelName(place) ? cfg.directory.idOf(place.ref.slice(1)) : place.ref

/** The channels hydra.toml names that this config's app can reach, by id: what catch-up scans and the listener holds. A `#name` not yet resolved is left out. */
export function routedChannels(cfg: Pick<ConversationConfig, 'hydra' | 'directory' | 'app'> | null | undefined): string[] {
  if (!cfg) return []
  return [...new Set(namedChannels(cfg.hydra, cfg.app).flatMap(p => channelIdOf(cfg, p) ?? []))]
}

/** `#name` places no channel answers to: the bot isn't in it, it was renamed, or names can't be read (no channels:read). */
export function unresolvedPlaces(cfg: Pick<ConversationConfig, 'hydra' | 'directory' | 'app'>): Place[] {
  return namedChannels(cfg.hydra, cfg.app).filter(p => !channelIdOf(cfg, p))
}

/** Whether a rule that app (none: the app named `default`) serves names a DM with its bot (`slack:app-dm:<app>` or `slack:app-dm:*`): DMs someone declared they want, as opposed to the operator's own. */
export function dmsDeclared(cfg: Pick<ConversationConfig, 'hydra' | 'app'>): boolean {
  const r = reachableBy(cfg.hydra, cfg.app)
  const mine = placeOf('slack', 'app-dm', cfg.app ?? DEFAULT_SLACK_APP)
  return r.rules.some(x => x.place !== undefined && placeCovers(x.place, mine))
}

/**
 * Whether one event's places (`placesOf`) are named: by a rule this app delivers to, or by a `[places]` entry
 * (an option set for the place is a name too, wider than `namedChannels`). The early gate asks it of every kind of place.
 */
export function namedPlace(cfg: Pick<ConversationConfig, 'hydra' | 'app'>, at: Place[], app?: string): boolean {
  const r = reachableBy(cfg.hydra, app ?? cfg.app)
  return at.some(p => optionsOf(cfg.hydra.places, p) !== undefined || r.rules.some(x => x.place !== undefined && placeCovers(x.place, p)))
}

/**
 * Whether DMs are heard: some specialist or rule names a DM with the bot (`dmsDeclared`), or the operator has a Slack address (their DMs
 * reach `main` through any app: pins don't bind `main`).
 */
export function hearsDms(cfg: Pick<ConversationConfig, 'hydra' | 'app'> | null | undefined): boolean {
  if (!cfg) return false
  const h = cfg.hydra
  return dmsDeclared({ hydra: h, app: cfg.app }) || (!!h.operator && !!h.people[h.operator]?.addresses.some(a => a.startsWith('slack:')))
}

/** A Slack user, as hydra.toml addresses them. */
export const addressOf = (user: string | undefined): Address | undefined => user ? `slack:${user}` : undefined

/** The `[places]` options that apply to a channel: a specific entry before one with `*`, then the most specific name that has any. */
export function placeOptions(cfg: Pick<ConversationConfig, 'hydra' | 'directory' | 'app'>, channel: string): PlaceOptions | undefined {
  return optionsAt(cfg.hydra.places, placesOf(cfg, channel))
}

/** Slack's answer when the bot is not in a channel: the operator's token may still read it. */
export const NOT_A_MEMBER = /not_in_channel|channel_not_found/

/**
 * Why a thread can't be heard, and what to do: one sentence, so the bind's refusal and the later alert say the same.
 * Only the operator can act on it; a session can only pass it on.
 */
export function cantRead(apps: Readonly<Record<string, SlackApp>>, appId: string, place: string, why: string, botUserId?: string, then: 'bind' | 'tag' = 'bind'): string {
  const app = Object.hasOwn(apps, appId) ? apps[appId] : undefined
  if (!NOT_A_MEMBER.test(why)) return `it can't be read (${why})`
  const bot = botUserId ? `the bot (<@${botUserId}>)` : 'the bot'
  // A session binds again; a specialist's conversation opens again on a tag.
  const after = then === 'bind' ? 'then bind again' : 'then a tag in the thread opens it again'
  return app?.operatorTokenEnv
    ? `neither ${bot} nor the operator is in ${place} (${why}). Ask the operator to invite the bot or join ${place}, ${after}`
    : `${bot} isn't in ${place} (${why}). Ask the operator to invite it, or to set the ${appKey(apps, appId, 'operator_token_env')}, ${after}`
}

/** How a refused operator token is said, so catch-up can tell it from a thread that is gone. */
export const OPERATOR_TOKEN_REFUSED = "the operator's Slack token was refused"

/** Slack's answers that close a whole channel, not one thread. */
const CHANNEL_GONE = /not_in_channel|channel_not_found|is_archived/

/** The specialist that would answer a new conversation here, whoever asks: where an alert about this channel goes. */
export function listenerOf(cfg: ConversationConfig | null | undefined, channel: string): string | undefined {
  if (!cfg) return undefined
  const d = route(cfg.hydra, { at: placesOf(cfg, channel), addressed: true, app: appOfEntry(cfg), ...(cfg.hydra.operator && { from: cfg.hydra.people[cfg.hydra.operator]?.addresses[0] }) })
  return d.fate === 'deliver' || d.fate === 'refused' ? d.to : undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TS_RE = /^\d{1,12}\.\d{1,6}$/

/** Slack ts ("1793732224.093059") as a comparable integer. Floats lose the microseconds. */
function tsValue(ts: string): bigint {
  const [sec, frac = ''] = ts.split('.')
  return BigInt(sec || '0') * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6) || '0')
}
/** When a Slack message was sent, in ms. */
const tsMs = (ts: string): number => Number(tsValue(ts) / 1000n)
export const cmpTs = (a: string, b: string): number => { const d = tsValue(a) - tsValue(b); return d < 0n ? -1 : d > 0n ? 1 : 0 }

const DELIVERED_KEEP = 300
/** A reaction's name as Slack gives it: an emoji, and for a skin tone `+1::skin-tone-3`. */
const REACTION_NAME = /^[A-Za-z0-9_+'-]{1,100}(::skin-tone-[2-6])?$/
/** How many delivered reactions, and how many of its own messages, a conversation remembers. */
const REACTED_KEEP = 300
const OURS_KEEP = 300
const AMBIENT_IDLE_MS = 86_400_000
/** How long a conversation must be quiet before a full table lets it go for a new one. */
const EVICT_QUIET_MS = 3600_000
/** How long a message delivered and not yet answered keeps its conversation from being let go: a session may work on one for hours. Bounded, so a specialist that never answers does not hold a place for the week. */
const REPLY_WAIT_MS = 24 * 3600_000
/** Who binds by hand, not by routing: a session's tool, a reply's thread (`home`: a post to its `home_place`), the operator's CLI, a router's hand-off. */
export const BOUND_BY = ['tool', 'home', 'cli', 'router'] as const
export type BoundBy = typeof BOUND_BY[number]
const isBoundBy = (x: unknown): x is BoundBy => (BOUND_BY as readonly unknown[]).includes(x)
/** Opened by a bind (`mentionedBy` names who), not by a message: its history starts at the bind. */
export const openedByBind = (e: ConversationEntry): boolean => isBoundBy(e.mentionedBy)
/** A conversation a session holds by its own hand: what `TOOL_BIND_MAX` counts. */
export const heldBySession = (e: ConversationEntry): boolean => e.boundBy === 'tool' || e.boundBy === 'home'
/** Who changed a binding, for the event: a person or session (`by`, and the `why` they gave), or hydra itself (`by` is `hydra`, with a `reason`). */
export type BindingEvent = { by: string; why?: string; reason?: BindReason }
/** Who let a conversation go, for the event. */
export type Removal = { by: string; reason?: UnbindReason }
/** The time of a tag in a store that kept none: older than any. */
const UNKNOWN_TS = '0.000000'
/** How many channels no rule names catch-up reads for an app, the ones it was tagged in most recently: the bound on the extra history reads. */
export const TAGGED_CHANNELS_MAX = 20
/** The longest a conversation waits for a session of its own before its messages are dropped, alerted. */
const WAIT_MAX_MS = 3 * 86_400_000
/**
 * Chatter answered by no one: a conversation opened by an untagged message, delivered, nothing owed, no reply under it.
 * It holds no slot in the table (it stays a day only so a late reply follows its binding and a replay is not delivered twice).
 */
const oneOff = (e: ConversationEntry): boolean => !!e.ambient && !e.owed?.length && (e.delivered?.length ?? 0) <= 1
const OWED_KEEP = 200
const OWED_MAX_AGE_S = 24 * 3600
/**
 * How long a session thread keeps its bound conversations with no session in it. Counted from when the thread became vacant, not from the last
 * Slack message: a busy conversation nobody is home to hear would otherwise never be let go, and what it owes already expires after
 * OWED_MAX_AGE_S. Occupied threads are unchanged (idle `idleExpiryMs`, any message resets it). A specialist's own thread is out of scope: its
 * conversations are bound to the specialist, not to a thread, and it is refilled rather than let go.
 */
export const VACANT_RELEASE_MS = 24 * 3600_000
const MENTION_WINDOW_MS = 10 * 60_000
const NAME_TTL_MS = 24 * 3600_000
const NAME_MISS_TTL_MS = 5 * 60_000
const NAMES_PRUNE_AT = 5000

/** Whether a Slack-derived name reads as `operator` or as a rostered person's id. */
const isDisguise = (h: HydraConfig, name: string): boolean => {
  const n = name.replace(/\s+/g, ' ').trim().toLowerCase()
  return n === 'operator' || Object.keys(h.people).some(id => id.toLowerCase() === n)
}
const NAME_TIMEOUT_MS = 3000
const PERSIST_DEBOUNCE_MS = 200
/** Alerts of one kind closer together than this are one episode: alerted once. */
const ALERT_EPISODE_GAP_MS = 60 * 60_000
const NOTED_KEEP = 10_000
export const FILE_MAX_BYTES = 20 * 1024 * 1024
export const FILE_KEEP_MS = 7 * 86_400_000
const safeFileName = (name: string): string => (basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 100)) || 'file'
const GUARD_CONCURRENCY = 4

/** `fn` over `xs`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) { const n = next++; out[n] = await fn(xs[n]) }
  }))
  return out
}
const OWED_FULL_WHY = `more than ${OWED_KEEP} messages were owed in one thread, so the oldest is no longer retried`

/** A conversation's key in memory, and a channel's in a cursor, a hold or a noted fact: as they always were for `default`, the app first for any other. */
const watchKey = (app: string | undefined, channel: string, threadTs: string) => scopeKey(app, channel, threadTs)
const keyOf = (e: Pick<ConversationEntry, 'app' | 'channel' | 'threadTs'>) => watchKey(e.app, e.channel, e.threadTs)

/** A store written before `boundBy` was the one record of who holds a conversation: a conversation opened by a bind, or bound to a session's thread, is held by the opener. Once: the marker (`Store.holds`) is written with the next save, so a hold released since is not given back. */
function holdsFromOpener(e: ConversationEntry): void {
  if (e.boundBy !== undefined) return
  if (isBoundBy(e.mentionedBy)) e.boundBy = e.mentionedBy
  else if (e.specialist && isSessionThread(e.specialist)) e.boundBy = 'tool'
}

/** A store written under an older name of `deferredSince` (`heldSince`, then `notNowSince`) loads under the new name, so a message held by the guard keeps its `owed_max` clock. The next write carries only the new name.
 *  More than one name can be present when a build that predates a rename wrote the store after one that did not: each ts then takes the latest of them. */
function readOldNames(e: ConversationEntry): void {
  const merged = { ...e.deferredSince }
  for (const old of [e.heldSince, e.notNowSince]) for (const [ts, at] of Object.entries(old ?? {})) merged[ts] = Math.max(at, merged[ts] ?? at)
  if (Object.keys(merged).length) e.deferredSince = merged
  delete e.heldSince
  delete e.notNowSince
}
/** How long an app's bot that was told it is not in a channel is left alone before a reaction is tried there again. */
const NO_REACTION_RETRY_MS = 10 * 60_000
/** A span in the unit a person reads it in: `a day`, `7 days`, `6 hours`. */
const spanText = (ms: number): string => {
  const h = Math.round(ms / 3_600_000)
  if (h < 24) return h === 1 ? 'an hour' : `${h} hours`
  const d = Math.round(h / 24)
  return d === 1 ? 'a day' : `${d} days`
}
/** How many channels an app's bot is remembered as not being in, for reactions. */
const NO_REACTION_KEEP = 500
const scoped = (app: string | undefined, channel: string) => scopeKey(app, channel)

/** The apps whose bot a text tags, first tag first. `identities` is every known app's bot ids. */
export function mentionedApps(identities: Record<string, { botUserId: string }>, text: string | undefined): string[] {
  if (!text) return []
  return Object.entries(identities).flatMap(([a, i]) => { const m = tagRe(i.botUserId).exec(text); return m ? [{ a, at: m.index }] : [] }).sort((x, y) => x.at - y.at).map(x => x.a)
}
export const tagRe = (botUserId: string) => new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`)

/**
 * The delivered list is the exact dedupe, capped at DELIVERED_KEEP. Catch-up rereads a thread from its oldest owed
 * message, and Slack returns the thread's parent with every read, so neither those messages nor the parent are ever
 * trimmed away: a delivered ts trimmed there would be delivered again.
 */
function keepDelivered(delivered: string[], owed: string[] | undefined, parent: string): string[] {
  if (delivered.length <= DELIVERED_KEEP) return delivered
  const floor = owed?.length ? [...owed].sort(cmpTs)[0] : undefined
  const cut = delivered.length - DELIVERED_KEEP
  const reread = floor ? delivered.findIndex(t => cmpTs(t, floor) >= 0) : -1
  const firstKept = reread === -1 ? cut : Math.min(cut, reread)
  const kept = delivered.slice(firstKept)
  return delivered.includes(parent) && !kept.includes(parent) ? [parent, ...kept] : kept
}

const insertTs = (list: string[] | undefined, ts: string, keep: number): string[] => {
  const out = list ?? []
  if (out.includes(ts)) return out
  out.push(ts)
  out.sort(cmpTs)
  return out.length > keep ? out.slice(out.length - keep) : out
}

// Event subtypes that are ordinary messages. Edits, deletes, joins and the rest are not.
const PLAIN_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'bot_message'])

/**
 * Who sent a message in a thread bound to a session's thread, as that session weighs it: the operator, someone declared in hydra.toml's `[people]` (approved),
 * or anyone else.
 */
export type SenderStanding = 'operator' | 'approved' | 'other'

/**
 * One message. `person`, `roles` and `operator` are who hydra.toml says sent it, filled in at delivery. `tagged` and `from` are set only on a
 * delivery to the session the conversation is bound to (`boundSessionFacts`).
 */
export type Item = {
  ts: string; user?: string; name?: string; person?: string; roles?: string[]; operator?: boolean
  kind: 'mention' | 'follow-up' | 'dm' | 'reaction'; text: string; files?: SlackFile[]; saved?: FileRef[]
  tagged?: boolean; from?: SenderStanding
  /** How routing took it, kept for the event written when its delivery settles: `via` is what chose the place, `tagged` whether the text tags the bot. */
  routed?: { via: string; tagged: boolean }
}

export const ITEM_TEXT_MAX_CHARS = UNTRUSTED_TEXT_MAX_CHARS
export const BATCH_MAX_BYTES = 8000

/**
 * One message, as the specialist reads it. Who sent it rides as attributes on its header line, never as prose, and the
 * words are quoted line by line so they cannot pose as a header.
 */
export function renderItem(i: Item): string {
  const name = oneLine(i.name, 60)
  const who = [
    `person=${i.person ? attr(i.person) : 'null'}`,
    `roles=${attr((i.roles ?? ['anyone']).join(','))}`,
    `operator=${i.operator ? 'true' : 'false'}`,
    ...(i.user ? [`address=${attr(`slack:${i.user}`)}`] : []),
    ...(name ? [`name=${attr(name)}`] : []),
    ...(i.from ? [`tagged=${i.tagged ? 'true' : 'false'}`, `from=${i.from}`] : []),
  ]
  // File names are the sender's words too: one line each, cleaned, and never at the start of a line where they could pose as an item.
  const files = (i.saved ?? []).map(f => `  file: ${oneLine(f.name, 120) || '(unnamed)'}${f.size !== undefined ? ` (${formatBytes(f.size)})` : ''}${f.path ? ` → ${f.path}` : `: ${f.note}`}`)
  return [`[${i.kind} ts=${attr(i.ts)} ${who.join(' ')}]`, quoteBody(i.text), ...files].join('\n')
}

const formatBytes = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/**
 * hydra's line in every delivery from a Slack conversation: its audience is outside hydra, so what a session says there is about their ask and
 * nothing of hydra's own. Fixed text: no sender line can change or imitate it (it sits outside the quoted words).
 */
export const EXTERNAL_AUDIENCE_NOTE = "hydra: this conversation's audience is outside hydra. Reply only about their ask, and never post links to Discord, hydra or private Slack conversations, or internal session names."

/**
 * What the specialist's occupant reads. The Slack text is other people's words, so it sits inside the untrusted
 * envelope: markers carrying a one-off nonce the text cannot forge. Where it was said rides on the opening marker.
 */
export function formatDelivery(
  entry: Pick<ConversationEntry, 'channel' | 'threadTs'>,
  items: Item[],
  where: { place: string; workspaceUrl?: string; note?: string },
  nonce: string = randomBytes(6).toString('hex'),
): string {
  const dm = isDm(entry.channel)
  const link = where.workspaceUrl ? archiveUrl(where.workspaceUrl, entry.channel, dm || entry.threadTs === TOP_LEVEL ? undefined : entry.threadTs) : undefined
  const attrs = [`place=${attr(where.place)}`, `conversation=${attr(conversationId(entry))}`, ...(link ? [`link=${attr(link)}`] : [])]
  // hydra's own line, unquoted, ahead of the items: every line of a sender's words is quoted, so none can pose as it.
  return fence('SLACK-UNTRUSTED', nonce, attrs, [EXTERNAL_AUDIENCE_NOTE, ...(where.note ? [where.note] : []), items.map(renderItem).join('\n\n')])
}

/**
 * What main is told with the first messages of a channel thread new to it: main answers it, or hands it to a session. The bind sends
 * the notice to that session's own thread, never into the Slack thread.
 */
export const NEW_TO_MAIN_NOTE = 'hydra: this Slack thread is new to main. Answer it (reply with the conversation above as chat_id), or hand it to a session: '
  + 'one already on this work, or one you spawn for it, with `hydra conversations bind <conversation> thread:<thread id> --why "<one line>"`. '
  + 'The bind posts nothing in the Slack thread: the notice (which session took it, a link to its thread, and the reason) goes to that session\'s own thread. Later messages in the Slack thread go to that session, which answers there about the ask.'

/**
 * A delivery's items as the session the conversation is bound to reads them: whether the app that heard the thread was tagged in each (the connector's
 * own tag detection, `kind`), and who sent it. Approved is declared in `[people]`, the roster: the default a specialist's `reachable_by` admits.
 */
export const boundSessionFacts = (items: Item[]): Item[] => items.map(i => ({ ...i, tagged: i.kind === 'mention', from: i.operator ? 'operator' : i.person ? 'approved' : 'other' }))

/** Whether a message likely asks the session its conversation is bound to: the app was tagged in it by the operator or an approved person. */
export const asksBoundSession = (i: Item): boolean => i.tagged === true && (i.from === 'operator' || i.from === 'approved')

/** How many asking messages the line names; past that it counts them, so the line stays within the room packing leaves for it. */
const ASKED_NAMED_MAX = 5
/** Room a delivery to a session's thread keeps for the line and the facts it adds beyond what `packItems` counts. */
const BOUND_NOTE_ROOM = 700 + EXTERNAL_AUDIENCE_NOTE.length

/**
 * The hydra line the session a conversation is bound to reads with each delivery: the default its items' facts suggest, which the session applies with
 * judgment. A tag from the operator or an approved person likely asks something; anything else is for listening. A session that may not speak
 * there (restricted or write-confined: `speaks` false) is told it only listens.
 */
export function boundSessionNote(items: Item[], app: string, speaks: boolean): string {
  if (!speaks) return 'hydra: this Slack thread is bound to you to listen to: this session does not speak in Slack here (reply would be refused), so take it in and stay quiet.'
  const asking = items.filter(asksBoundSession).map(i => `ts=${i.ts}`)
  const asked = asking.length > ASKED_NAMED_MAX ? [...asking.slice(0, ASKED_NAMED_MAX), `${asking.length - ASKED_NAMED_MAX} more`] : asking
  if (!asked.length) return `hydra: this Slack thread is bound to you, and you are listening: nothing here tags ${app} from the operator or an approved person (from=operator or from=approved). Stay quiet in Slack.`
  return `hydra: this Slack thread is bound to you, and the operator or an approved person tagged ${app} in ${asked.join(', ')}: you are likely being asked. `
    + 'Answer in the thread (reply with the conversation above as chat_id) if it asks or needs something from you; a pure cc needs no reply.'
    + (asking.length < items.length ? ' The other messages here are for listening.' : '')
}

/** Split a burst into deliveries that each fit under the cap. */
export function packItems(items: Item[], maxBytes: number = BATCH_MAX_BYTES): Item[][] {
  const overhead = 700 // header, permalink, markers
  const batches: Item[][] = []
  let current: Item[] = []
  let size = overhead
  for (const item of items) {
    const bytes = Buffer.byteLength(renderItem(item)) + 2
    if (current.length && size + bytes > maxBytes) { batches.push(current); current = []; size = overhead }
    current.push(item)
    size += bytes
  }
  if (current.length) batches.push(current)
  return batches
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/**
 * `taggedIn`: the scoped keys (as `channelCursors`) of channels where an app was tagged, each with the ts of the last tag. An older store wrote the keys alone, as an array: their time is unknown.
 * `holds`: the store's entries carry `boundBy` as the one record of who holds a conversation. A store without it is read once under the older shape (`holdsFromOpener`).
 */
type Store = { entries: ConversationEntry[]; channelCursors: Record<string, string>; taggedIn?: Record<string, string> | string[]; holds?: true }

export class ConversationTable {
  private readonly entries = new Map<string, ConversationEntry>()
  private channelCursors: Record<string, string> = {}
  /** Scoped channel key to the ts of the last tag of the app there. Not the channel cursor, which means "last read": a quiet channel read in full moves it to now. */
  private taggedIn = new Map<string, string>()
  private readonly pending = new Map<string, { items: Item[]; timer: ReturnType<typeof setTimeout> }>()
  // Handed to the delivery chain but not yet settled. A replay of one of these (a catch-up pass fires on every reconnect, and a refill can take a while) would otherwise open a second batch and deliver it twice.
  private readonly inflight = new Map<string, Set<string>>()
  private readonly mentionTimes = new Map<string, number[]>()
  private readonly reactionTimes = new Map<string, number[]>()
  private readonly refusalTimes = new Map<string, number[]>()
  private readonly names = new Map<string, { name?: string; at: number }>()   // by `<app>:<user id>`: a user id belongs to one app's workspace
  private readonly nameFlights = new Map<string, Promise<string | undefined>>()
  // Deliveries go out one at a time, in the order they were scheduled.
  private chain: Promise<void> = Promise.resolve()
  // Each thread's flushes run in order, but the work before sending (names, beforeDeliver) runs beside other threads': one slow guard holds back only its own thread.
  private readonly threadRuns = new Map<string, Promise<void>>()
  private dirty = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private readonly botIds = new Map<string, string>()
  // Channels a catch-up pass has yet to read. Live events never move these cursors: a cursor moved past a gap the pass
  // has not read would leave that gap unread for good. A pass releases each channel as it finishes reading it.
  private readonly held = new Set<string>()
  // Refusals and drops already logged, so a catch-up replay neither logs nor counts them twice. Insertion-ordered; oldest go first.
  // Two sets, so a flood of refusals cannot evict the drops (and re-count them on replay).
  private readonly noted = { refused: new Set<string>(), dropped: new Set<string>(), guessed: new Set<string>() }
  // Channels where an app's bot answered a reaction with "not in channel", by app and channel: no reaction is tried there again until the time here has passed.
  private readonly cannotReact = new Map<string, number>()
  private readonly stats_: ConversationStats = { refused: 0, refusedBy: {}, unrouted: 0, dropped: {} }
  private readonly episodeStart = new Map<string, number>()
  // Why each conversation's last delivery failed, until one lands or nothing is owed: what `lateOwed` says. Pruned in `sweep`.
  private readonly failing = new Map<string, string>()

  // What each app's connection offered: its display names, and its reactions and downloads. Keyed by app id.
  private readonly resolvers = new Map<string, NonNullable<ConversationDeps['resolveName']>>()
  private readonly actions = new Map<string, SlackActions>()
  private readonly downloads = new Map<string, Promise<void>>()

  constructor(private readonly deps: ConversationDeps) { if (deps.resolveName) this.resolvers.set(DEFAULT_SLACK_APP, deps.resolveName); this.load() }

  // -- store ---------------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.deps.file)) return
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Store
      // An entry with no `app` is the app named `default`'s: every store written before apps existed loads as it is, and is not rewritten.
      for (const e of raw.entries ?? []) { readOldNames(e); if (!raw.holds) holdsFromOpener(e); this.entries.set(keyOf(e), e) }
      if (!raw.holds && this.entries.size) this.dirty = true
      this.channelCursors = raw.channelCursors ?? {}
      // A store from before the times were kept holds keys alone; a damaged one holds neither shape: what cannot be read is left out, the rest loads.
      const t: unknown = raw.taggedIn
      if (Array.isArray(t)) for (const k of t) { if (typeof k === "string") this.taggedIn.set(k, UNKNOWN_TS) }
      else if (t && typeof t === "object") for (const [k, v] of Object.entries(t)) if (typeof v === "string" && TS_RE.test(v)) this.taggedIn.set(k, v)
    } catch (err) {
      this.deps.log(`daemon: slack connector: load failed: ${err}\n`)
    }
  }

  /** Writes are batched: a burst of events is one write. `persistNow` runs at flush and shutdown. */
  private persist(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS)
    ;(this.persistTimer as { unref?: () => void }).unref?.()
  }

  private persistNow(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined }
    if (!this.dirty) return
    this.dirty = false
    try {
      const store: Store = { entries: [...this.entries.values()], channelCursors: this.channelCursors, taggedIn: Object.fromEntries(this.taggedIn), holds: true }
      atomicWriteFileSync(this.deps.file, JSON.stringify(store, null, 2) + '\n')
    } catch (err) {
      this.dirty = true
      this.deps.log(`daemon: slack connector: persist failed: ${err}\n`)
    }
  }

  list(): ConversationEntry[] { return [...this.entries.values()] }
  /** Refusals and drops since the daemon started: what `hydra conversations` and `hydra health` count. */
  stats(): ConversationStats { return structuredClone(this.stats_) }
  /**
   * For `hydra health`: each conversation whose oldest owed message is older than `olderThanMs`, with the cause and what to do.
   * Never throws: health must work when the watcher does not.
   */
  lateOwed(olderThanMs: number, now = this.deps.now()): LateOwed[] {
    const out: LateOwed[] = []
    try {
      for (const [key, e] of this.entries) {
        const oldest = e.owed?.length ? [...e.owed].sort(cmpTs)[0] : undefined
        if (!oldest) continue
        const ageMs = now - parseFloat(oldest) * 1000
        if (ageMs < olderThanMs) continue
        const h = this.deps.config(e.app)?.hydra
        const cause = !h ? `its app (${this.appName(e.app)}) has no live connection, so nothing goes through it: see its line`
          : e.waitingSince !== undefined ? `waiting for a session: its specialist is at max_sessions; end one, or raise max_sessions`
          : e.deferredSince && Object.keys(e.deferredSince).length ? 'the guard keeps saying deferred (exit 75): check the guard'
          : e.specialist && !isLive(h, e.specialist) ? `its specialist ${e.specialist} is not declared in hydra.toml: declare it, or bind the conversation elsewhere`
          : this.failing.has(key) ? `delivery failing: ${this.failing.get(key)}`
          : 'not delivered yet and no failure recorded: the next catch-up pass replays it';
        out.push({ conversation: conversationId(e), ...(e.specialist && { to: spelledBare(e.specialist) }), count: e.owed!.length, oldestAgeMin: Math.round(ageMs / 60_000), cause })
      }
    } catch (err) { this.deps.log(`daemon: slack connector: listing late owed messages failed: ${err}\n`) }
    return out.sort((a, b) => b.oldestAgeMin - a.oldestAgeMin)
  }
  get(channel: string, threadTs: string, app?: string): ConversationEntry | undefined { return this.entries.get(watchKey(app, channel, threadTs)) }

  /**
   * Whether this Slack thread is a hydra session's own (on the Slack gateway, a thread hydra itself talks in). No new conversation may be bound to it,
   * whatever the target: a specialist bound there would post where the operator reads hydra. `watch` refuses it, and every way a conversation opens
   * passes through `watch`; an inbound tag also asks first, so it is not routed there. Callers ask this only to say why instead of "the table is full".
   * A binding made before the session arrived is not undone here: a session's is let go at its next message (`releasedByHost`), a specialist's is kept.
   */
  isHosted(channel: string, threadTs: string): boolean { return !!this.deps.hosted?.(`${channel}:${threadTs}`) }

  /** What a message calls an app. */
  private appName(app: string | undefined): string { return appName(this.deps.apps?.() ?? {}, appOfEntry({ app })) }

  setBotId(id: string | undefined, app?: string): void { if (id) this.botIds.set(appOfEntry({ app }), id); else this.botIds.delete(appOfEntry({ app })) }
  /** Supplied once an app's listener has a Slack client: display names for the senders in its deliveries. */
  setNameResolver(fn: ConversationDeps['resolveName'], app?: string): void { if (fn) this.resolvers.set(appOfEntry({ app }), fn); else this.resolvers.delete(appOfEntry({ app })) }
  /** Supplied once an app's listener is connected: file downloads and the ack reaction, through that app. */
  setSlackActions(actions: SlackActions | undefined, app?: string): void { if (actions) this.actions.set(appOfEntry({ app }), actions); else this.actions.delete(appOfEntry({ app })) }
  /** One app's side of the watcher: the same calls with the app filled in, which is what its listener and its catch-up pass use. */
  forApp(app: string): AppConversations { return new AppConversations(this, app) }

  /**
   * Open a conversation bound to `specialist`, or touch the one that exists. Its binding is never changed here: only
   * `bind` moves a conversation. Undefined when the table is full, or the thread is a session's own (`isHosted`). `evict`: a full table first lets go of the routed conversation
   * quiet the longest (`evict`), which only an inbound message asks for; `bind` never does, so a deliberate bind into a full table is refused.
   * `'ambient'`: untagged chatter opening one may let go only of another opened by chatter, so the half kept for tags and DMs stays theirs.
   * `ambientCap`: the most conversations chatter may hold at once (the half of the table kept for tags and DMs); a second capacity beside the table's, let go of the same way.
   */
  watch(channel: string, threadTs: string, specialist: string, mentionedBy?: string, app?: string, evict: false | 'any' | 'ambient' = false, ambientCap?: number): ConversationEntry | undefined {
    if (this.isHosted(channel, threadTs)) return undefined
    const now = this.deps.now()
    const existing = this.get(channel, threadTs, app)
    if (existing) {
      existing.lastEventAt = now
      if (!existing.specialist) this.setBinding(existing, specialist, undefined, { by: HYDRA_ACTOR, reason: 'rerouted' }) // a store written before bindings: its first message since binds it
      this.persist()
      return existing
    }
    const cap = this.deps.config(app)?.maxConversations ?? SLACK_LIMITS.maxConversations
    const held = this.list().filter(e => !oneOff(e))
    const overTable = held.length - cap + 1
    const overChatter = ambientCap === undefined ? 0 : held.filter(e => e.ambient).length - ambientCap + 1
    if (overTable > 0 || overChatter > 0) {
      const limit = overChatter >= overTable ? `conversations opened by untagged chatter already hold half the conversation table (${ambientCap} of ${cap})` : `the conversation table is full (${cap})`
      if (!(evict && this.evict(held, Math.max(overTable, overChatter), limit, now, conversationId({ app, channel, threadTs }), evict === 'ambient'))) return undefined
    }
    const entry: ConversationEntry = { ...(appOfEntry({ app }) !== DEFAULT_SLACK_APP && { app }), channel, threadTs, specialist, ...(mentionedBy && { mentionedBy }), createdAt: now, lastEventAt: now }
    this.entries.set(keyOf(entry), entry)
    this.persist()
    this.tellSessionsTaken(entry)
    return entry
  }

  /**
   * A full table makes room for a new conversation by letting go of the `n` quiet the longest, as idle expiry would. Only one routing opened:
   * never one held by hand (`boundBy`: a session, the operator, a reply or a router bound it, whoever opened it); for an opener of untagged chatter or the bot's own post (`onlyAmbient`), only one chatter opened.
   * Quiet counts from the last message in or the specialist's last reply (`touch`), and a message delivered but not yet answered keeps the
   * conversation busy for `REPLY_WAIT_MS`: a session still working on it is not let go, so its reply is not refused. Once let go, only a tag or a DM there
   * (or any message, where the place hears every message) opens it again: an untagged reply is not heard. And only with nothing owed, nothing
   * waiting in the window or in flight, no wait for a session, and quiet `EVICT_QUIET_MS`: a session handed its last message may still be
   * answering, and its reply needs the binding. Each is logged; its specialist is alerted once per episode. False, and nothing let go, when
   * fewer than `n` qualify.
   */
  private evict(held: ConversationEntry[], n: number, limit: string, now: number, opening: string, onlyAmbient: boolean): boolean {
    const victims = held.filter(e => {
      const key = keyOf(e)
      return !e.boundBy && (!onlyAmbient || !!e.ambient)
        && !e.owed?.length && e.waitingSince === undefined && !this.pending.has(key) && !this.inflight.get(key)?.size && now - e.lastEventAt >= EVICT_QUIET_MS
        && !(e.unansweredAt !== undefined && now - e.unansweredAt < REPLY_WAIT_MS)
    }).sort((a, b) => a.lastEventAt - b.lastEventAt).slice(0, n)
    if (victims.length < n) return false
    for (const e of victims) {
      this.remove(e, { by: HYDRA_ACTOR, reason: 'evicted' })
      const quiet = spanText(now - e.lastEventAt)
      this.deps.log(`daemon: slack connector: ${limit}, so ${conversationId(e)}${e.specialist ? ` (bound to ${spelledBare(e.specialist)})` : ''}, quiet the longest (${quiet}), was let go to open ${opening}\n`)
      const to = e.specialist ?? listenerOf(this.deps.config(e.app), e.channel)
      this.alertOnce(`evicted:${to ?? '-'}`, to, `ℹ️ ${limit[0].toUpperCase()}${limit.slice(1)}, so hydra let go of ${conversationId(e)}, quiet the longest (${quiet}), to open ${opening}. Only a tag or a DM there opens it again (any message, where the place hears every message); an untagged reply in it is not heard until then. Further ones within the hour are logged, not alerted.`, appOfEntry(e))
    }
    this.persist()
    return true
  }

  /**
   * The one place a conversation's binding changes to a specialist (it opens bound, is first bound, or is moved): a session listening to
   * the same thread through another app is told then. `hand` is who holds it by hand after the change: the binder, or nothing when routing moved it.
   */
  private setBinding(entry: ConversationEntry, to: string, hand: BoundBy | undefined, event?: BindingEvent): void {
    const from = entry.specialist
    if (from !== to) delete entry.unansweredAt   // what the old specialist was sent is not the new one's to answer
    entry.specialist = to
    if (hand) entry.boundBy = hand; else delete entry.boundBy
    delete entry.vacantSince   // a vacancy belongs to the thread the conversation was bound to; the next reconcile starts the new one's
    if (event && from !== to) this.recordBinding(entry, from, event)
    this.tellSessionsTaken(entry)
  }

  /** The event for a binding that changed: by whoever bound it, or by hydra itself with a reason. The one place a `bind` event is written. */
  private recordBinding(entry: ConversationEntry, from: string | undefined, event: BindingEvent): void {
    recordEvent({ kind: 'bind', conversation: conversationId(entry), ...(from && { from }), to: entry.specialist!, ...(event.why && { why: event.why }), by: event.by, ...(event.reason && { reason: event.reason }) })
  }

  /** A conversation leaves the table: the one place an `unbind` event is written, by whoever let it go or by hydra with a reason. */
  private remove(entry: ConversationEntry, who: Removal): void {
    this.entries.delete(keyOf(entry))
    recordEvent({ kind: 'unbind', conversation: conversationId(entry), ...(entry.specialist && { from: entry.specialist }), by: who.by, ...(who.reason && { reason: who.reason }) })
  }

  /**
   * The conversation id names the app, so a session listening to the same thread through another app holds a different conversation,
   * now quiet. Told when a specialist takes the thread, once per takeover.
   */
  private tellSessionsTaken(taken: ConversationEntry): void {
    if (!taken.specialist || isSessionThread(taken.specialist)) return
    for (const held of this.list()) {
      if (held.channel !== taken.channel || held.threadTs !== taken.threadTs) continue
      if (!held.specialist || !isSessionThread(held.specialist)) continue
      this.deps.log(`daemon: slack connector: ${taken.specialist} took the thread that ${conversationId(held)} listens to, through ${this.appName(taken.app)}; the session listening there was told\n`)
      this.deps.alert?.(`ℹ️ ${taken.specialist} now answers this thread through ${this.appName(taken.app)} (${conversationId(taken)}), so this session no longer hears ${conversationId(held)}. Bind it again with \`bind_conversation\` to listen (then untagged messages in the thread come to this session, not the specialist), or \`unbind_conversation\` to let it go.`, held.specialist, appOfEntry(held))
    }
  }

  /**
   * `bind_conversation`: bind a conversation to `specialist`, opening it if need be. What is still owed follows the new binding.
   * A conversation opened by a binder that has seen its parent (a session reading the thread, a specialist posting it) counts
   * the parent as seen: Slack returns it with every thread read, and it would be delivered as a follow-up. The operator's CLI
   * has not necessarily seen it, so it stays undelivered: a request the live stream missed is still delivered.
   */
  bind(channel: string, threadTs: string, specialist: string, by: BoundBy = 'cli', app?: string, who: { by: string; why?: string } = { by }): ConversationEntry | undefined {
    const opened = !this.get(channel, threadTs, app)
    const seenParent = opened && (by === 'tool' || by === 'home')
    const entry = this.watch(channel, threadTs, specialist, by, app)
    if (!entry) return undefined
    if (seenParent && threadTs !== TOP_LEVEL) { entry.delivered = insertTs(entry.delivered, threadTs, DELIVERED_KEEP); this.persist() }
    if (entry.specialist !== specialist) {
      this.deps.log(`daemon: slack connector: ${conversationId(entry)} moved from ${entry.specialist} to ${specialist}\n`)
      this.setBinding(entry, specialist, by, who)
    } else entry.boundBy = by   // the latest binder holds it: a move by the operator is the operator's, not the session's it came from
    if (opened) this.recordBinding(entry, undefined, who)
    this.persist()
    return entry
  }

  /** The specialist answered in it: its quiet clock restarts, so a conversation it is still speaking in is not the one let go first. */
  touch(channel: string, threadTs: string, app?: string): void {
    const e = this.get(channel, threadTs, app)
    if (!e) return
    e.lastEventAt = this.deps.now()
    delete e.unansweredAt
    this.persist()
  }

  /** Unbind a conversation. What it still owed will never be delivered now: a drop, surfaced (`quiet`: counted and logged only, for a caller that says it itself). */
  unwatch(channel: string, threadTs: string, app?: string, quiet = false, who: Removal = { by: 'operator' }): boolean {
    const key = watchKey(app, channel, threadTs)
    const pending = this.pending.get(key)
    if (pending) { clearTimeout(pending.timer); this.pending.delete(key) }
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.owed?.length) this.drop('unbound', entry, entry.owed, 'its conversation was unbound before they were delivered', !quiet)
    this.remove(entry, who)
    this.persist()
    return true
  }

  /**
 * Drop entries idle past the expiry and owed ts too old to be worth chasing. Returns how many entries went.
 * `vacancy` false: no vacant session thread is let go (the boot sweep, which runs before recovery has revived the sessions that are about to register).
 */
  sweep(vacancy = true): number {
    // Runs whether or not Slack is connected: what is idle or too old expires either way.
    const now = this.deps.now()
    const idleExpiryMs = this.deps.config()?.idleExpiryMs ?? SLACK_LIMITS.idleExpiryMs
    const owedFloor = `${Math.floor(now / 1000) - OWED_MAX_AGE_S}.000000`
    let n = 0
    // A session thread that let conversations go says so once (per app, per reason), after the loop.
    const letGo = new Map<string, { thread: string; app: string; why: 'vacant' | 'idle'; idleMs: number; names: string[]; owed: number }>()
    const note = (e: ConversationEntry, why: 'vacant' | 'idle', idleMs: number, owed: number): void => {
      if (!e.specialist || !isSessionThread(e.specialist)) return
      const k = `${e.specialist}|${appOfEntry(e)}|${why}`
      const g = letGo.get(k) ?? { thread: e.specialist, app: appOfEntry(e), why, idleMs, names: [], owed: 0 }
      g.names.push(conversationId(e)); g.owed += owed
      letGo.set(k, g)
    }
    for (const [key, e] of this.entries) {
      const cfg = this.deps.config(e.app)   // the app that heard it: null while that app is not connected
      const idle = cfg?.idleExpiryMs ?? idleExpiryMs
      const cutoff = now - idle
      // Chatter's conversations are cheap to open again: they go after a day, so a busy place frees its half of the table.
      const ambientCutoff = now - Math.min(idle, AMBIENT_IDLE_MS)
      // A session thread nobody has been in for VACANT_RELEASE_MS lets go of its conversations, and what they owed.
      if (vacancy && e.vacantSince !== undefined && e.specialist && isSessionThread(e.specialist) && now - e.vacantSince >= VACANT_RELEASE_MS && !this.pending.has(key)) {
        note(e, 'vacant', idle, e.owed?.length ?? 0)
        this.unwatch(e.channel, e.threadTs, e.app, true, { by: HYDRA_ACTOR, reason: 'vacant' })
        n++
        continue
      }
      // An entry still owed messages is not idle: its owed ts expire first (and are alerted), then it goes.
      if (e.lastEventAt < (e.ambient ? ambientCutoff : cutoff) && !this.pending.has(key) && !e.owed?.length) { note(e, 'idle', idle, 0); this.remove(e, { by: HYDRA_ACTOR, reason: 'idle' }); n++; continue }
      // Owed to a specialist hydra.toml no longer declares, at a place catch-up no longer reads: no replay will come to
      // route it anew, so it is lost now, not a day from now. (Where catch-up still reads, the replay routes it as its
      // sender: delivered anew, or dropped then.) Not while a batch for it waits in the window: that delivery decides.
      if (e.owed?.length && cfg && e.specialist && !isLive(cfg.hydra, e.specialist) && !this.pending.has(key)
        && (isDm(e.channel) ? !hearsDms(cfg) : !routedChannels(cfg).includes(e.channel))) {
        this.drop('unrouted', e, e.owed, 'it was accepted, but its specialist is gone and no specialist hears this place now')
        delete e.owed
        this.persist()
        continue
      }
      // A wait has an end too: past WAIT_MAX_MS nothing has freed a place, and something is wrong that a person must see.
      if (e.owed?.length && e.waitingSince !== undefined && now - e.waitingSince > WAIT_MAX_MS) {
        this.drop('expired', e, e.owed, `waited ${Math.round(WAIT_MAX_MS / 86_400_000)} days for a session of its own (its specialist stayed at max)`)
        delete e.owed
        delete e.waitingSince
        this.persist()
        continue
      }
      if (e.owed?.length && e.waitingSince === undefined) {
        const kept = e.owed.filter(ts => cmpTs(ts, owedFloor) >= 0 || this.pending.get(key)?.items.some(i => i.ts === ts))
        if (kept.length !== e.owed.length) {
          this.drop('expired', e, e.owed.filter(ts => !kept.includes(ts)), `still undelivered after ${OWED_MAX_AGE_S / 3600}h`)
          if (kept.length) e.owed = kept; else delete e.owed
          this.persist()
        }
      }
    }
    for (const k of [...this.failing.keys()]) if (!this.entries.get(k)?.owed?.length) this.failing.delete(k)
    if (n) this.persist()
    for (const g of letGo.values()) {
      const list = g.names.join(', ')
      const lost = g.owed ? ` (${g.owed} owed message${g.owed === 1 ? '' : 's'} dropped)` : ''
      const text = g.why === 'vacant'
        ? `ℹ️ No session has been in this thread for ${spanText(VACANT_RELEASE_MS)}, so hydra let go of ${list}${lost}. Bind again with \`bind_conversation\` to listen.`
        : `ℹ️ ${list} had no message for ${spanText(g.idleMs)}, so hydra let go of it. Bind again with \`bind_conversation\` to listen.`
      this.deps.alert?.(text, g.thread, g.app)
    }
    this.pruneDmCursors(now, idleExpiryMs)
    this.pruneTaggedCursors()
    this.sweepFiles(now)
    return n
  }

  /** No session is in `threadId`: the conversations bound to it start their vacancy clock now. A clock already running is kept. */
  vacate(threadId: string): void {
    if (!isSessionThread(threadId)) return
    const now = this.deps.now()
    let changed = false
    for (const e of this.entries.values()) if (e.specialist === threadId && e.vacantSince === undefined) { e.vacantSince = now; changed = true }
    if (changed) this.persist()
  }

  /** A session is in `threadId` again: the vacancy clock of its conversations stops. */
  occupy(threadId: string): void {
    let changed = false
    for (const e of this.entries.values()) if (e.specialist === threadId && e.vacantSince !== undefined) { delete e.vacantSince; changed = true }
    if (changed) this.persist()
  }

  // -- catch-up support (the listener drives this) ---------------------------

  /** Newest ts seen in a channel before the current gap; where a catch-up scan starts. */
  channelCursor(channel: string, app?: string): string | undefined { return this.channelCursors[scoped(app, channel)] }

  /** Where each thread with owed messages needs refetching from. Waiters first, the oldest first: it takes the next freed place. Of one app's, when given. */
  owedHints(app?: string): { channel: string; threadTs: string; fromTs: string }[] {
    const order = (e: ConversationEntry) => e.waitingSince ?? Infinity
    return this.list().filter(e => e.owed?.length && (app === undefined || appOfEntry(e) === app)).sort((a, b) => order(a) - order(b)).map(e => ({ channel: e.channel, threadTs: e.threadTs, fromTs: e.owed![0] }))
  }

  /** The conversations waiting for a session of `to` (current id, after renames), the oldest first. */
  waiters(isTo: (specialist: string) => boolean): ConversationEntry[] {
    return this.list().filter(e => e.waitingSince !== undefined && e.owed?.length && e.specialist && isTo(e.specialist)).sort((a, b) => a.waitingSince! - b.waitingSince!)
  }

  /** Which token last read a thread: the bot's, or the operator's. Updated each time catch-up reads it, so an invite moves it to the bot. */
  setVia(channel: string, threadTs: string, via: 'bot' | 'user', app?: string): void {
    const e = this.get(channel, threadTs, app)
    if (!e || (e.via ?? 'bot') === via) return
    if (via === 'user') e.via = 'user'; else delete e.via
    this.deps.log(`daemon: slack connector: ${conversationId(e)} is now read ${via === 'user' ? 'as the operator' : 'by the bot'}\n`)
    this.persist()
  }

  /**
   * Catch-up can't read the thread: gone, or its channel closed to every token hydra has. No pass will ever read it, so
   * it is let go, whoever holds it: what it owed is dropped, and the holder is told what was lost and what to do.
   * A session hears every one. A specialist hears once an hour per channel and kind (the channel, or one thread), and
   * a deleted thread it only followed, with nothing lost, is no news.
   */
  threadGone(channel: string, threadTs: string, why: string, app?: string): void {
    const e = this.get(channel, threadTs, app)
    if (!e) return
    const lost = e.owed?.length ?? 0
    // Said once, in the alert below; an entry with no holder has its drop alerted where its channel is heard.
    if (lost) this.drop('expired', e, e.owed!, `its thread can't be read any more (${why})`, !e.specialist)
    delete e.owed
    this.unwatch(channel, threadTs, app, false, { by: HYDRA_ACTOR, reason: 'thread-gone' })
    if (!e.specialist) return
    const session = isSessionThread(e.specialist)
    const channelWide = CHANNEL_GONE.test(why)
    if (!session && !channelWide && !lost) return
    const cfg = this.deps.config(app)
    const place = cfg ? placeName(cfg, channel) : channel
    const others = !session && channelWide ? ` and any other conversations of yours in ${place}` : ''
    const lostText = lost ? `; ${lost} undelivered message${lost === 1 ? ' is' : 's are'} lost` : ''
    const text = `⚠️ Let go of ${conversationId(e)}${others}${lostText}: ${cantRead(cfg?.hydra.slackApps ?? {}, appOfEntry({ app }), place, why, cfg?.botUserId, session ? 'bind' : 'tag')}.`
    if (session) this.deps.alert?.(text, e.specialist, appOfEntry({ app }))
    else this.alertOnce(`thread-gone:${e.specialist}:${channel}:${channelWide ? 'channel' : 'thread'}`, e.specialist, text, appOfEntry({ app }))
  }

  /** The operator's token was refused: the threads read with it are kept, unread until it is replaced. Said once an hour. */
  operatorTokenRefused(why: string, app?: string): void {
    const id = appOfEntry({ app })
    this.alertOnce('operator-token', undefined, `⚠️ ${why[0].toUpperCase()}${why.slice(1)}: threads read as the operator are not being read. Put a valid operator token in the variable the ${appKey(this.deps.apps?.() ?? {}, id, 'operator_token_env')} names (in \`.env\`), and restart the daemon.`, id)
  }

  /** While catching up, live events must not move the cursor past the gap being filled. */
  beginCatchUp(channels: string[], app?: string): void { for (const c of channels) this.held.add(scoped(app, c)) }
  endCatchUp(channel: string, newestTs?: string, app?: string): void {
    this.held.delete(scoped(app, channel))
    if (newestTs) this.advance(channel, newestTs, app)
  }

  /**
   * Catch-up could not read everything since a channel's cursor in one pass: it read `read` messages, the oldest at
   * `oldestRead`, and moved on. What lies between the old cursor and that is not replayed. Counted and alerted like any drop.
   */
  catchUpGap(channel: string, cursor: string, oldestRead: string | undefined, read: number, app?: string): void {
    const fact = `gap:${cursor}`
    if (!this.firstTime(this.noted.dropped, `${scoped(app, channel)}:${fact}`)) return
    this.stats_.dropped['catch-up-gap'] = (this.stats_.dropped['catch-up-gap'] ?? 0) + 1
    const line = `catch-up read the newest ${read} messages in ${channel} since ${cursor} and moved on; anything between ${cursor} and ${oldestRead ?? 'them'} was not replayed, so a tag there was not delivered`
    this.deps.log(`daemon: slack connector: ${line}\n`)
    const to = listenerOf(this.deps.config(app), channel)
    this.alertOnce(`catch-up-gap:${to ?? '-'}`, to, `⚠️ Slack ${line}.`, appOfEntry({ app }))
  }

  /** A conversation catch-up has read in full and found empty: its cursor can move at once, whatever the rest of the pass does. */
  markRead(channel: string, ts: string, app?: string): void { this.held.delete(scoped(app, channel)); this.advance(channel, ts, app) }

  /** Cursors are kept per app: the app `default`'s under the bare channel id, as they always were, any other's under `<app>:<channel>`. */
  private advance(channel: string, ts: string, app?: string): void {
    const key = scoped(app, channel)
    const cur = this.channelCursors[key]
    if (!cur || cmpTs(ts, cur) > 0) { this.channelCursors[key] = ts; this.persist() }
  }

  // -- events --------------------------------------------------------------

  /**
   * One Slack `message` event. Returns what it meant; delivery, if any, happens
   * after the coalescing window.
   */
  handle(ev: SlackMessageEvent): HandleOutcome {
    const cfg = this.deps.config(ev.app)
    // Said for a DM only (see `classify`'s `skip`): no view means the app has no connection to route with yet.
    const lost = (why: () => string): HandleOutcome => { if (isDm(ev.channel)) this.deps.log(`daemon: slack connector: dropped ${ev.channel} ${ev.ts} from ${ev.user ?? ev.botId ?? 'unknown'} (${this.appName(ev.app)}): ${why()}\n`); return 'ignored' }
    if (!cfg) return lost(() => 'the app has no live view of hydra.toml (not connected, or no longer declared)')
    if (!TS_RE.test(ev.ts) || (ev.threadTs !== undefined && !TS_RE.test(ev.threadTs))) return lost(() => `its timestamp ${ev.ts} is not one Slack writes`)
    const outcome = this.classify(ev, cfg)
    // A cursor is kept only where catch-up scans: the channels hydra.toml names, and DM conversations once someone
    // admitted has written in them. A stranger's refused DM must not cost a history read on every pass.
    // A tag of this app in a channel no rule names keeps one too (`taggedChannels`): a tag missed there while the app was down is then caught up.
    const tagHeard = outcome !== 'ignored' && !isDm(ev.channel) && !cfg.directory.isGroupDm?.(ev.channel) && ev.user !== cfg.botUserId && !!ev.text && tagRe(cfg.botUserId).test(ev.text)
    const scanned = isDm(ev.channel) ? outcome === 'dm' && placesOf(cfg, ev.channel).some(isDmPlace) : tagHeard || routedChannels(cfg).includes(ev.channel)
    if (tagHeard) {
      const key = scoped(ev.app, ev.channel)
      const last = this.taggedIn.get(key)
      if (!last || cmpTs(ev.ts, last) > 0) { this.taggedIn.set(key, ev.ts); this.persist() }
    }
    if (scanned && !this.held.has(scoped(ev.app, ev.channel))) this.advance(ev.channel, ev.ts, ev.app)
    return outcome
  }

  /**
   * A person's reaction to a message in a conversation hydra holds, delivered to the session that owns the conversation, as one item
   * in the form a message takes. The place's `reactions` option lets it in, and past that it is a message from that person
   * to that conversation: the same rules decide whether they may be heard (`route`, `reachable_by`, the guard), a stranger is passed over
   * silently (no 🚫, nothing counted), and a reaction never opens a conversation. The bot's own reactions (its `ack`) and its sibling apps' are
   * never heard. Slack's event names the message but not its thread, so a reaction finds its conversation by the message: a thread's first
   * message, or one this conversation delivered.
   */
  handleReaction(ev: SlackReactionEvent): ReactionOutcome {
    const cfg = this.deps.config(ev.app)
    if (!cfg || !TS_RE.test(ev.itemTs) || !TS_RE.test(ev.eventTs) || !REACTION_NAME.test(ev.reaction)) return 'ignored'
    const mode = placeOptions(cfg, ev.channel)?.reactions ?? 'off'
    if (mode === 'off' || (mode === 'bot-messages' && ev.itemUser !== cfg.botUserId)) return 'ignored'
    const app = appOfEntry(cfg)
    if (ev.user === cfg.botUserId || Object.entries(cfg.identities ?? {}).some(([a, i]) => a !== app && i.botUserId === ev.user)) return 'ignored'
    const entry = this.get(ev.channel, ev.itemTs, app) ?? this.list().find(e => appOfEntry(e) === app && e.channel === ev.channel && (e.delivered?.includes(ev.itemTs) || e.ours?.includes(ev.itemTs)))
    // A conversation read with the operator's token is one the bot is not in: Slack sends the app no reactions there, and none is taken from a stand-in.
    if (!entry?.specialist || entry.via === 'user') return 'ignored'
    // Several apps in a thread: the one it is bound through keeps it, as with its untagged follow-ups.
    if (!isDm(ev.channel) && (this.boundThrough(cfg, ev.channel, entry.threadTs)[0] ?? app) !== app) return 'ignored'
    const d = route(cfg.hydra, { from: addressOf(ev.user), at: placesOf(cfg, ev.channel), addressed: true, app, bound: entry.specialist })
    if (d.fate !== 'deliver') return 'ignored'
    const mark = `${ev.itemTs}:${ev.reaction}:${ev.user}`
    if (entry.reacted?.includes(mark)) return 'ignored'
    // Past a person's cap in ten minutes a reaction is counted and logged, not delivered: as with tags, one person cannot flood a session.
    const now = this.deps.now()
    const recent = (this.reactionTimes.get(ev.user) ?? []).filter(t => now - t < MENTION_WINDOW_MS)
    this.reactionTimes.set(ev.user, recent)
    if (recent.length >= cfg.maxReactionsPer10Min) {
      this.drop('reaction-cap', entry, [ev.eventTs], `${ev.user} reacted ${recent.length} times in 10 minutes (maxReactionsPer10Min)`, false)
      return 'ignored'
    }
    recent.push(now)
    entry.reacted = [...(entry.reacted ?? []), mark].slice(-REACTED_KEEP)
    this.persist()
    const link = cfg.workspaceUrl ? archiveUrl(cfg.workspaceUrl, ev.channel, ev.itemTs, entry.threadTs !== TOP_LEVEL && entry.threadTs !== ev.itemTs ? entry.threadTs : undefined) : `message ${ev.itemTs} in ${placeName(cfg, ev.channel)}`
    const [emoji, tone] = ev.reaction.split('::skin-tone-')
    const item: Item = { ts: ev.eventTs, user: ev.user, kind: 'reaction', text: `reacted :${emoji}:${tone ? ` (skin tone ${tone})` : ''} to ${link}` }
    const key = keyOf(entry)
    const run = (this.threadRuns.get(key) ?? Promise.resolve())
      .then(() => this.deliverReaction(key, entry, item, mark, cfg))
      .catch(err => { this.undo(entry, mark); this.deps.log(`daemon: slack connector: delivering a reaction in ${key} failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`) })
    this.threadRuns.set(key, run)
    void run.finally(() => { if (this.threadRuns.get(key) === run) this.threadRuns.delete(key) })
    return 'accepted'
  }

  /** The bot's own message in a conversation, noted where its place hears reactions, so a reaction on it finds the conversation. */
  private noteOwn(cfg: ConversationConfig, ev: SlackMessageEvent, threadTs: string, app: string): void {
    if ((placeOptions(cfg, ev.channel)?.reactions ?? 'off') === 'off') return
    const entry = this.get(ev.channel, threadTs, app)
    if (!entry || entry.ours?.includes(ev.ts)) return
    entry.ours = [...(entry.ours ?? []), ev.ts].slice(-OURS_KEEP)
    this.persist()
  }

  /** A reaction that did not land is forgotten, so Slack sending it again (or the person adding it again) delivers it. */
  private undo(entry: ConversationEntry, mark: string): void {
    if (this.entries.get(keyOf(entry)) !== entry || !entry.reacted?.includes(mark)) return
    entry.reacted = entry.reacted.filter(m => m !== mark)
    if (!entry.reacted.length) delete entry.reacted
    this.persist()
  }

  private releasedByHost(key: string, entry: ConversationEntry): boolean {
    const host = `${entry.channel}:${entry.threadTs}`
    if (!entry.specialist || !isSessionThread(entry.specialist) || !this.deps.hosted?.(host)) return false
    if (this.entries.get(key) !== entry) return true
    const owed = entry.owed?.length ?? 0
    this.unwatch(entry.channel, entry.threadTs, entry.app, true, { by: HYDRA_ACTOR, reason: 'hosted' })
    this.deps.alert?.(`ℹ️ ${conversationId(entry)} is now a hydra session's own thread, so this session stopped listening to it${owed ? ` (${owed} owed dropped)` : ''}.`, entry.specialist, appOfEntry(entry))
    return true
  }

  /**
   * One reaction, sent as a message would be: to the conversation's binding, if it still admits the person, after the guard, named as the
   * roster names them. It is never owed: Slack does not replay it, and a message's retry (catch-up reading the thread again) would not find it.
   */
  private async deliverReaction(key: string, entry: ConversationEntry, item: Item, mark: string, enqueuedCfg: ConversationConfig): Promise<void> {
    if (this.releasedByHost(key, entry)) return
    const cfg = this.deps.config(entry.app) ?? enqueuedCfg
    const to = entry.specialist ? currentId(cfg.hydra, entry.specialist) : undefined
    if (!to || !isLive(cfg.hydra, to)) return this.undo(entry, mark)
    const { named, verdicts } = await this.admit(entry, cfg, [item], () => to)
    // Refused now (a role taken away), or the guard says drop or deferred: nothing is sent, and the same reaction may come again. A redirect is not followed: it goes to the binding.
    if (!named.length || verdicts[0].verdict === 'drop' || verdicts[0].verdict === 'deferred') return this.undo(entry, mark)
    const send = this.chain.then(async () => {
      const result = await this.post(entry, { to }, named, cfg)
      if (result.ok) this.deps.log(`daemon: slack connector: delivered a reaction in ${key} (to ${item.ts}) to ${spelledBare(to)}${result.duplicate ? ' (already delivered)' : ''}\n`)
      else { this.undo(entry, mark); this.deps.log(`daemon: slack connector: delivering a reaction in ${key} to ${spelledBare(to)} failed: ${result.reason}\n`) }
    })
    this.chain = send.catch(() => {})
    await send
  }

  /**
   * The apps this thread is bound through, the one most recently active in it first (hydra.toml order breaks a tie): each opened a
   * conversation in it, so each is in the channel whatever the membership cache says, and the first is `boundApp`, which keeps the
   * thread's untagged follow-ups.
   */
  private boundThrough(cfg: ConversationConfig, channel: string, threadTs: string): string[] {
    const order = Object.keys(cfg.hydra.slackApps)
    return order.filter(a => this.get(channel, threadTs, a)).sort((a, b) => this.get(channel, threadTs, b)!.lastEventAt - this.get(channel, threadTs, a)!.lastEventAt || order.indexOf(a) - order.indexOf(b))
  }

  private classify(ev: SlackMessageEvent, cfg: ConversationConfig): HandleOutcome {
    // A message dropped before anything is counted or logged is said for a DM, and where `say`, where silence reads as a lost message (channels carry far too many to name).
    const skip = (why: () => string, say = false): HandleOutcome => { if (say || isDm(ev.channel) || cfg.directory.isGroupDm?.(ev.channel)) this.deps.log(`daemon: slack connector: dropped ${ev.channel} ${ev.ts} from ${ev.user ?? ev.botId ?? 'unknown'} (${this.appName(ev.app)}): ${why()}\n`); return 'ignored' }
    if (!PLAIN_SUBTYPES.has(ev.subtype)) return skip(() => `the message has subtype ${ev.subtype}, which is not heard`)

    const app = appOfEntry(cfg)
    const botId = cfg.botId ?? this.botIds.get(app)
    const own = ev.user === cfg.botUserId || (!!ev.botId && ev.botId === botId)
    // A sibling hydra app is never heard, declared or not: two of ours answering each other would loop. Its own events may carry only a user, so its ids are known too.
    const others = Object.entries(cfg.identities ?? {}).filter(([a]) => a !== app).map(([, i]) => i)
    const sibling = !own && others.some(i => i.botUserId === ev.user || (!!ev.botId && i.botId === ev.botId))
    if (sibling) return skip(() => `it is from another hydra app's bot`)
    // A DM is one conversation per channel, whoever is in it; a group DM is treated alike, though its id looks like a channel's.
    const dm = isDm(ev.channel) || !!cfg.directory.isGroupDm?.(ev.channel)
    const isReply = !!ev.threadTs && ev.threadTs !== ev.ts
    // A DM's top-level messages are one conversation. Anywhere else, a top-level message is its thread's first: the
    // conversation is that thread, bound when this message arrives. A thread inside a DM is a thread like any other.
    const threadTs = dm && !isReply ? TOP_LEVEL : ev.threadTs ?? ev.ts
    // Another app's bot is heard when hydra.toml declares it as a person, and then as that person; an undeclared one is not, in a thread bound to a session
    // too. Said when it tags us, so its sender is not left to silence.
    const unheardApp = !own && !!ev.botId && !hearsApp(cfg.hydra.people, cfg.hydra.operator, addressOf(ev.user))
    if (unheardApp) {
      // Accepted before (declared then, or under the rule this replaced) and replayed: let go, settled and said, as a refused one is.
      const held = this.get(ev.channel, threadTs, app)
      if (held?.owed?.includes(ev.ts)) {
        this.drop('refused', held, [ev.ts], `it is from another app, accepted before, that hydra.toml no longer declares`)
        this.settle(keyOf(held), held, [ev.ts])
        return 'refused'
      }
      return skip(() => `it is from another app that hydra.toml does not declare`, (!!held || (!!ev.text && tagRe(cfg.botUserId).test(ev.text))) && this.firstTime(this.noted.dropped, `app:${scoped(app, ev.channel)}:${ev.ts}`))
    }
    const tagged = !own && !!ev.text && tagRe(cfg.botUserId).test(ev.text)
    // The apps the text tags, first tag first: what decides which of several apps in a channel answers.
    const mentioned = own ? [] : mentionedApps({ [app]: { botUserId: cfg.botUserId }, ...cfg.identities }, ev.text)
    // A DM is this app's alone. In a channel, the apps whose bot is in it (a cache the connections share).
    // An app this thread is already bound through is in the channel too: it keeps its untagged follow-ups (`boundApp`), even while its connection is down.
    // A tagged app with no connection is taken to hear its tag: it is the owning app and catches it up, so no other app answers in its place.
    const through = dm ? [] : this.boundThrough(cfg, ev.channel, ev.threadTs ?? ev.ts)
    const connected = cfg.connected?.()
    const unreachable = connected ? mentioned.filter(m => m !== app && !connected.includes(m)) : []
    // A tagged app with the operator's token hears every channel the operator is in, its bot a member or not: its tag reaches it.
    const viaOperator = dm ? [] : mentioned.filter(m => m !== app && !!cfg.hydra.slackApps[m]?.operatorTokenEnv)
    const heardBy = dm ? [app] : [...new Set([app, ...(cfg.heardBy?.(ev.channel) ?? []), ...through, ...unreachable, ...viaOperator])]
    // A tagged app whose membership was never read may or may not receive the message. It is the owning app only when no tagged app is known to
    // hear it: a tag then reaches it rather than vanishing (rule 1: a tag goes to the tagged app, in a bound thread too), and a known hearer
    // is never outranked by a guess. Only a tag makes a guess, so an untagged follow-up still goes to the app the thread is bound through.
    const unread = dm || own ? [] : (cfg.unread?.(ev.channel, mentioned.filter(m => m !== app)) ?? [])
    const guessed = mentioned.some(m => heardBy.includes(m)) ? [] : unread
    heardBy.push(...guessed)
    // Tagged apps known unable to hear it: bot read as not in the channel, and no operator token.
    const unheard = dm || own ? [] : mentioned.filter(m => m !== app && !heardBy.includes(m) && !unread.includes(m))
    const at = placesOf(cfg, ev.channel)
    // A DM with a person, or a group DM: the bot is not (or only) a member, and nothing has said it should answer there.
    const inNoBotDm = dm && !at.some(isDmPlace)
    // An ask of the bot: a tag, or a DM with it. One turned away is recorded (`noRoute`) and gets the 🚫; chatter, and anything in a DM the bot is not part of, is neither.
    const asksBot = (tagged || dm) && !inNoBotDm
    if (this.inflight.get(watchKey(app, ev.channel, threadTs))?.has(ev.ts)) return skip(() => `it is in flight already`)
    if (own) this.noteOwn(cfg, ev, threadTs, app)
    if (dm && own) return skip(() => `it is the bot's own message in a DM`)
    const existing = this.get(ev.channel, threadTs, app)
    // A hydra session's own thread opens no conversation. Before routing: it is no one's to refuse, tag-cap or answer.
    const hosted = this.isHosted(ev.channel, threadTs)
    if (hosted && !existing) return skip(() => `it is in a hydra session's own thread`)
    const boundApp = through[0]
    // With the operator's token the app hears every channel, DM and group DM the operator is in. Hearing is not delivering: a place no
    // rule, `[places]` entry or open conversation names is nobody's, passed over before it opens, counts, reacts to or owes
    // anything. The bot's own DM is the one place that needs no name (the operator's goes to `main`). A tag in a channel still gets its
    // answer, as it would without the token; a DM with a person or a group DM never does, since nothing there asked the bot.
    if (!existing && !at.some(isDmPlace) && !namedPlace(cfg, at, app) && (inNoBotDm || (!tagged && cfg.hydra.slackApps[app]?.operatorTokenEnv))) return skip(() => `no rule, [places] entry or open conversation names this place, and it is not a DM with the bot`)

    if (own) {
      // The bot's own top-level post opens a conversation, bound to whoever hears there. Its replies are not echoed back.
      if (isReply) return skip(() => `it is a reply by the bot itself`)
      // Already recorded: a deep pass rereads the thread and Slack always returns its parent. Seen before, so not missed.
      if (existing?.delivered?.includes(ev.ts)) return skip(() => `it was already delivered`)
      const to = listenerOf(cfg, ev.channel)
      if (!to) return skip(() => `no one listens where the bot posted`)
      const entry = this.watch(ev.channel, threadTs, to, undefined, app, 'ambient')   // a scheduled post never pushes out a person's thread
      if (!entry) {
        this.drop('table-full', { app, channel: ev.channel, threadTs, specialist: to }, [ev.ts], `the conversation table is full (${cfg.maxConversations}), so the bot's own post opens no conversation and replies to it will not be delivered`)
        return 'ignored'
      }
      entry.delivered = insertTs(entry.delivered, ev.ts, DELIVERED_KEEP) // its own words are never owed to the specialist
      this.persist()
      return 'subscribed'
    }

    // A DM is addressed to the bot by being one, and so is every message in a conversation whose binding still holds (route decides that).
    const addressed = dm || tagged || (!!existing && !existing.specialist)
    if (existing?.delivered?.includes(ev.ts)) return skip(() => `it was already delivered`)
    // A person's tag in a thread bound to a session is for whoever answers a fresh one here, when someone does: they take the thread, and the session is told.
    // Another app's tag does not: it is delivered to the session like any message in the thread, so two apps cannot trade a thread between sessions by tagging.
    // A catch-all and a router take only what nothing is bound to, so neither takes a thread from a session: the fresh route is read without them.
    // Not in a thread that has since become a session's own: the listener is let go at delivery (`releasedByHost`), and no specialist takes it.
    if (tagged && !ev.botId && !hosted && existing?.specialist && isSessionThread(existing.specialist)) {
      const fresh = route(withoutFallbacks(cfg.hydra), { from: addressOf(ev.user), at, addressed: true, app })
      if (fresh.fate === 'deliver') {
        const from = existing.specialist
        this.setBinding(existing, fresh.to, undefined, { by: HYDRA_ACTOR, reason: 'taken' })   // the session's hold goes with its binding: the specialist's own binds count it, and it can be let go
        this.persist()
        this.deps.log(`daemon: slack connector: ${conversationId(existing)} was tagged; ${fresh.to} answers here, so it takes the thread from the session listening in ${from}\n`)
        this.deps.alert?.(`ℹ️ Someone tagged the bot in ${conversationId(existing)}, so ${fresh.to} took it, since it answers there. This session no longer hears it.`, from)
      }
    }
    // Several apps heard it: one is the owning app, fixed by whichever connection decides first, so every copy of the message agrees.
    // Past that the message is this app's alone, and routes as if no other app had heard it.
    const decide = () => owningApp(cfg.hydra, { app, heardBy, mentioned, ...(boundApp && { boundApp }), at })?.app ?? app
    const owning = dm ? app : cfg.decideOwningApp ? cfg.decideOwningApp(ev.channel, ev.ts, decide) : decide()
    // Standing down for a tagged app that was only guessed to hear it: if its bot is not in the channel, nobody answers. Said once per app and channel.
    if (owning !== app && guessed.includes(owning) && this.firstTime(this.noted.guessed, `${scoped(owning, ev.channel)}`)) this.deps.log(`daemon: slack connector: a tag of ${this.appName(owning)} in ${ev.channel} is left to it, but whether its bot is in the channel could not be read; if it is not, nobody answers. Add channels:read and groups:read to that app and reinstall it\n`)
    if (owning !== app) return skip(() => `another app is the owning app`)
    const d = route(cfg.hydra, { from: addressOf(ev.user), at, addressed, ...(tagged && !dm && { tagged }), app, ...(existing?.specialist && { bound: existing.specialist }) })
    if (d.fate === 'ignored') {
      // A tag of an app that can't hear it, with nothing here to answer it instead: counted, logged and reacted to, never silent.
      if (unheard.length) this.noRoute(ev, app, threadTs)
      if (unheard.length) this.refuse({ ...ev, app }, threadTs, `it tags ${unheard.map(a => this.appName(a)).join(', ')}, whose bot is not in this channel and which has no operator token, so no app can take it: invite that bot to the channel`, 'unrouted', true)
      return skip(() => `routing ignored it: ${d.trace.filter(t => !t.matched).map(t => t.why).join('; ') || 'no reason given'}`)
    }
    // Refused or unrouted before anything is counted, watched or owed: a sender `reachable_by` does not admit costs nothing.
    // Only a mention or a DM gets the 🚫: chatter in a bound thread by someone not allowed is passed over quietly.
    if (d.fate === 'unrouted' || d.fate === 'refused') {
      const why = d.fate === 'refused' ? d.why : 'no specialist hears this place'
      // Accepted earlier and still owed (a replay): losing it now is a drop, settled and surfaced, not a fresh refusal.
      if (existing?.owed?.includes(ev.ts)) {
        this.drop(d.fate, existing, [ev.ts], `it was accepted, but now ${why}`)
        this.settle(keyOf(existing), existing, [ev.ts])
        return d.fate
      }
      if (asksBot) this.noRoute(ev, app, threadTs, 'none', tagged)
      // The 🚫 is for the bot's own DMs and for tags in channels. A DM with a person or a group DM is logged and counted, never reacted to: the bot is not part of it.
      this.refuse({ ...ev, app }, threadTs, why, d.fate, !inNoBotDm && (d.fate === 'refused' ? dm || tagged : tagged && !dm))
      return d.fate
    }

    // The cap guards against tagging open conversations in a loop. In one already open, the same words untagged would be delivered anyway.
    if (!existing && tagged && !this.allowMention({ ...ev, app }, threadTs, d.to, cfg, !inNoBotDm)) return 'ignored'
    // A conversation opened by untagged chatter may take only half the table: the rest stays free for mentions and DMs.
    const ambient = !existing && !tagged && !dm
    const half = Math.floor(cfg.maxConversations / 2)
    const entry = existing ?? this.watch(ev.channel, threadTs, d.to, ev.user, app, ambient ? 'ambient' : 'any', ambient ? half : undefined)
    if (!entry) {
      const chatterFull = ambient && this.list().filter(e => e.ambient && !oneOff(e)).length >= half
      const why = chatterFull ? `conversations opened by untagged chatter already hold half the conversation table (${half} of ${cfg.maxConversations}) and none has been quiet an hour with nothing owed; a tag still opens one`
        : `the conversation table is full (${cfg.maxConversations}) and none in it has been quiet an hour with nothing owed; unbind a conversation`
      // A tag or a DM with the bot gets the 🚫, as a refused one does; untagged chatter, a DM with a person or a group DM never does.
      if (this.drop('table-full', { app, channel: ev.channel, threadTs, specialist: d.to }, [ev.ts], why) && asksBot) { this.noRoute(ev, app, threadTs, 'table-full', tagged); this.turnedAway({ ...ev, app }) }
      return 'ignored'
    }
    if (ambient) { entry.ambient = true; this.persist() }
    // A new conversation, one whose specialist is gone (routed anew), or a rename through `renamed_from`: the binding takes the current id.
    // A rename keeps whoever holds it by hand; a specialist that is gone took its hold with it.
    if ((d.bind || d.via === 'binding') && entry.specialist !== d.to) { this.setBinding(entry, d.to, d.bind ? undefined : entry.boundBy, { by: HYDRA_ACTOR, reason: d.bind ? 'rerouted' : 'renamed' }); this.persist() }
    entry.lastEventAt = this.deps.now()
    const kind = dm ? 'dm' : tagged ? 'mention' : 'follow-up'
    // A tag the app's router takes is answered at once with a 👀 from the app that heard it, whatever the place's `ack` says: the router (a session
    // that may have to start) takes a while. Also a tag in a thread still bound to a router specialist; `main` is not told apart from main.
    if (d.via === 'router') this.deps.log(`daemon: slack connector: → router ${spelledBare(d.to)} for ${keyOf(entry)} (ts ${ev.ts})\n`)
    if (kind === 'mention' && (d.via === 'router' || (d.to !== MAIN && d.to === routerOf(cfg.hydra, app)))) {
      const slack = this.actions.get(appOfEntry(entry))
      if (slack) this.reactAs(slack, entry.app, entry.channel, ev.ts, ROUTED_REACTION)
    }
    this.enqueue(entry, { ts: ev.ts, user: ev.user, kind, text: ev.text ?? '', ...(ev.files?.length && { files: ev.files }), routed: { via: d.via, tagged } }, cfg)
    return kind
  }

  /** The DM conversations an app knows of: catch-up scans their history, since no config lists them. A DM channel belongs to one app's bot. A DM with a person is not one: its history is not the bot's to read. */
  dmChannels(app?: string): string[] {
    const id = appOfEntry({ app })
    const cursors = Object.keys(this.channelCursors).flatMap(k => { const u = unscopeKey(k); return appOfEntry(u) === id ? [u.rest] : [] })
    const cfg = this.deps.config(app)
    const bots = (c: string) => !cfg?.directory.otherPartyOf || cfg.directory.otherPartyOf(c) === 'bot'
    return [...new Set([...this.list().filter(e => appOfEntry(e) === id).map(e => e.channel), ...cursors].filter(c => isDm(c) && bots(c)))]
  }

  /**
   * The channels no rule names where this app was tagged, the most recent `TAGGED_CHANNELS_MAX`: catch-up reads them too, so a tag of
   * the app missed while it was down gets the fate a live one would. A channel is known only by a tag heard in it: one never heard live is not read.
   */
  taggedChannels(app?: string): string[] {
    const id = appOfEntry({ app })
    const routed = new Set(routedChannels(this.deps.config(app)))
    return [...this.taggedIn]
      .flatMap(([k, ts]) => { const u = unscopeKey(k); return appOfEntry(u) === id && !routed.has(u.rest) ? [{ channel: u.rest, ts }] : [] })
      .sort((a, b) => cmpTs(b.ts, a.ts)).slice(0, TAGGED_CHANNELS_MAX).map(x => x.channel)
  }

  /** Downloaded attachments are kept a week: long enough for the session to read them, not forever. Walks `<dir>/<channel>` and each other app's `<dir>/<app>/<channel>`. */
  private sweepFiles(now: number): void {
    const dir = this.deps.filesDir
    if (!dir || !existsSync(dir)) return
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) { walk(p); if (!readdirSync(p).length) rmSync(p, { recursive: true, force: true }) }
        else if (now - statSync(p).mtimeMs > FILE_KEEP_MS) rmSync(p, { force: true })
      }
    }
    try { walk(dir) } catch (err) {
      this.deps.log(`daemon: slack connector: sweeping ${dir} failed: ${err}\n`)
    }
  }

  /** Forget DM conversations quiet for longer than the idle expiry: catch-up stops scanning them. The next DM brings one back. */
  private pruneDmCursors(now: number, idleMs: number): void {
    const floor = `${Math.floor((now - idleMs) / 1000)}.000000`
    for (const [key, ts] of Object.entries(this.channelCursors)) {
      const { app, rest: ch } = unscopeKey(key)
      if (isDm(ch) && cmpTs(ts, floor) < 0 && !this.list().some(e => e.channel === ch && appOfEntry(e) === appOfEntry({ app }))) { delete this.channelCursors[key]; this.persist() }
    }
  }

  /** Forget the channels no rule names beyond the newest `TAGGED_CHANNELS_MAX` per app, and their cursors, so the store stays bounded. An app not connected is left alone: its routed channels cannot be told apart now. */
  private pruneTaggedCursors(): void {
    for (const key of [...this.taggedIn.keys()]) {
      const { app, rest: ch } = unscopeKey(key)
      const cfg = this.deps.config(app)
      if (!cfg || routedChannels(cfg).includes(ch) || this.taggedChannels(app).includes(ch)) continue
      this.taggedIn.delete(key)
      delete this.channelCursors[key]
      this.persist()
    }
  }

  /** One person tagging in a loop must not be able to keep opening watches and filling the specialist. `react`: false in a DM with a
   *  person or a group DM, where the bot is not part of it and a dropped tag is logged and counted, never reacted to. */
  private allowMention(ev: SlackMessageEvent, threadTs: string, to: string, cfg: ConversationConfig, react: boolean): boolean {
    const user = ev.user
    if (!user) return true
    const now = this.deps.now()
    const recent = (this.mentionTimes.get(user) ?? []).filter(t => now - t < MENTION_WINDOW_MS)
    if (recent.length >= cfg.maxMentionsPer10Min) {
      this.mentionTimes.set(user, recent)
      if (this.drop('tag-cap', { app: ev.app, channel: ev.channel, threadTs, specialist: to }, [ev.ts], `${user} tagged the bot ${recent.length} times in 10 minutes outside watched threads (maxMentionsPer10Min)`) && react) { this.noRoute(ev, appOfEntry(ev), threadTs, 'tag-cap'); this.turnedAway(ev) }
      return false
    }
    recent.push(now)
    this.mentionTimes.set(user, recent)
    return true
  }

  private enqueue(entry: ConversationEntry, item: Item, cfg: ConversationConfig): void {
    // Owed before anything is sent: a crash inside the window leaves this for catch-up to find.
    const before = entry.owed ?? []
    entry.owed = insertTs([...before], item.ts, OWED_KEEP)
    this.persist()
    const key = keyOf(entry)
    const batch = this.pending.get(key)
    if (batch) {
      if (!batch.items.some(i => i.ts === item.ts)) batch.items.push(item)
    } else {
      const timer = setTimeout(() => this.flushKey(key, cfg), cfg.coalesceMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(key, { items: [item], timer })
    }
    // Cut from owed but still in the window or in flight: that delivery may yet land, and a failure there is counted then.
    const live = new Set([...(this.pending.get(key)?.items.map(i => i.ts) ?? []), ...(this.inflight.get(key) ?? [])])
    const lost = [...before, item.ts].filter(ts => !entry.owed!.includes(ts) && !live.has(ts))
    if (lost.length) this.drop('owed-full', entry, lost, OWED_FULL_WHY)
  }

  // -- refusals and drops ----------------------------------------------------

  /** True the first time a fact is seen: a replay of the same message is neither logged nor counted again. */
  private firstTime(set: Set<string>, fact: string): boolean {
    if (set.has(fact)) return false
    set.add(fact)
    if (set.size > NOTED_KEEP) set.delete(set.values().next().value!)
    return true
  }

  /** An ask of the bot no one took (a tag, or a DM with the bot) is a route event with no `to`, once per message: `via` says which step stopped it (`none`: no step took it, because its sender was refused, no place hears it, or it tags an app that cannot hear it; `tag-cap`; `table-full`), and `tagged` whether it was a tag. Chatter nobody takes, and anything in a DM the bot is not part of, are not recorded. */
  private noRoute(ev: Pick<SlackMessageEvent, 'channel' | 'ts' | 'user'>, app: string, threadTs: string, via: 'none' | 'tag-cap' | 'table-full' = 'none', tagged = true): void {
    if (!this.firstTime(this.noted.refused, `route:${scoped(app, ev.channel)}:${ev.ts}`)) return
    recordEvent({ kind: 'route', app, conversation: conversationId({ app, channel: ev.channel, threadTs }), by: addressOf(ev.user), tagged, via })
  }

  /** `react`: a mention (refused or unrouted) or a refused DM, whose sender sees a 🚫; an unrouted DM is logged and counted, and gets no reply. A replay is neither logged, counted nor reacted to twice. */
  private refuse(ev: Pick<SlackMessageEvent, 'app' | 'channel' | 'ts' | 'user' | 'botId'>, threadTs: string, why: string, fate: 'refused' | 'unrouted', react: boolean): void {
    if (!this.firstTime(this.noted.refused, `${scoped(ev.app, ev.channel)}:${ev.ts}`)) {
      if (isDm(ev.channel)) this.deps.log(`daemon: slack connector: dropped ${ev.channel} ${ev.ts} from ${ev.user ?? ev.botId ?? 'unknown'} (${this.appName(ev.app)}): ${fate} again, already said\n`)
      return
    }
    const who = ev.user ?? 'unknown sender'
    if (fate === 'unrouted') this.stats_.unrouted++
    else { this.stats_.refused++; this.stats_.refusedBy[who] = (this.stats_.refusedBy[who] ?? 0) + 1 }
    this.deps.log(`daemon: slack connector: ${fate} ${who} in ${watchKey(ev.app, ev.channel, threadTs)} (ts ${ev.ts}): ${why}\n`)
    if (react) this.turnedAway(ev)
  }

  /**
   * The 🚫 on a message hydra will not take (refused, unrouted, or dropped by the tag cap or a full table), so its sender sees it went nowhere.
   * Capped per sender like tags are: past the window, it is logged and counted only. Callers react once per message (a replay is not new).
   */
  private turnedAway(ev: Pick<SlackMessageEvent, 'app' | 'channel' | 'ts' | 'user' | 'botId'>): void {
    const sender = ev.user ?? ev.botId
    if (sender) {
      const now = this.deps.now()
      const recent = (this.refusalTimes.get(sender) ?? []).filter(t => now - t < MENTION_WINDOW_MS)
      const over = recent.length >= (this.deps.config(ev.app)?.maxMentionsPer10Min ?? SLACK_LIMITS.maxMentionsPer10Min)
      if (!over) recent.push(now)
      this.refusalTimes.set(sender, recent)
      if (over) return
    }
    const slack = this.actions.get(appOfEntry(ev))
    if (slack) this.reactAs(slack, ev.app, ev.channel, ev.ts, REFUSED_REACTION)
  }

  /** A bot joined (or left) a channel: its reactions there are tried again at the next message, whoever it was. */
  reactionsMayWork(channel: string): void {
    for (const k of [...this.cannotReact.keys()]) if (unscopeKey(k).rest === channel) this.cannotReact.delete(k)
  }

  /**
   * A reaction through the app that heard the message, best effort. An app can hear a channel its bot is not in (with the operator's token), and there Slack
   * answers "not in channel": that is said once, and no reaction is tried there again for a while (the bot may be invited).
   */
  private reactAs(slack: SlackActions, app: string | undefined, channel: string, ts: string, name: string): void {
    const where = scoped(app, channel)
    if ((this.cannotReact.get(where) ?? 0) > this.deps.now()) return
    void slack.react(channel, ts, name).catch(err => {
      const why = err instanceof Error ? err.message : String(err)
      if (/already_reacted/.test(why)) return
      if (/channel_not_found|not_in_channel/.test(why)) {
        this.cannotReact.delete(where)   // re-added last: the map is kept in the order of telling, so the oldest go first
        this.cannotReact.set(where, this.deps.now() + NO_REACTION_RETRY_MS)
        if (this.cannotReact.size > NO_REACTION_KEEP) this.cannotReact.delete(this.cannotReact.keys().next().value!)
        this.deps.log(`daemon: slack connector: the bot of ${this.appName(app)} is not in ${channel}, so it adds no reactions there (invite it to the channel to have them)\n`)
        return
      }
      this.deps.log(`daemon: slack connector: ${name} on ${channel} ts ${ts} failed: ${why}\n`)
    })
  }

  /** A message that will never be delivered: logged every time, counted, and alerted once per episode of its kind. False for a replay already dropped. */
  private drop(kind: DropKind, where: Pick<ConversationEntry, 'app' | 'channel' | 'threadTs' | 'specialist'>, ts: string[], why: string, alert = true): boolean {
    const fresh = ts.filter(t => this.firstTime(this.noted.dropped, `${scoped(where.app, where.channel)}:${t}`))
    if (!fresh.length) return false
    this.stats_.dropped[kind] = (this.stats_.dropped[kind] ?? 0) + fresh.length
    // A session thread's owed messages go undelivered when no session is in it: say what to do.
    const vacantAdvice = where.specialist && isSessionThread(where.specialist) && (kind === 'expired' || kind === 'owed-full') ? '. These never reached a session: if none is running in this thread, resume one; or `unbind_conversation` to let the conversation go' : ''
    const line = `dropped ${fresh.length} Slack message${fresh.length === 1 ? '' : 's'} in ${keyOf(where)} (${kind}, ts ${fresh.join(', ')}): ${why}${vacantAdvice}`
    this.deps.log(`daemon: slack connector: ${line}\n`)
    // Keyed by kind and by who hears it: one specialist's trouble does not silence another's.
    const to = where.specialist ?? listenerOf(this.deps.config(where.app), where.channel)
    if (alert) this.alertOnce(`${kind}:${to ?? '-'}`, to, `⚠️ ${line[0].toUpperCase()}${line.slice(1)}. Further ${kind} drops within the hour are logged, not alerted; \`hydra conversations\` counts them.`, appOfEntry(where))
    return true
  }

  /**
   * One alert per episode. An episode is named by when it began: alerts with the same key within the hour after
   * that are its own, and are not sent; the first one after the hour starts a new episode. So a steady trickle is
   * still said once an hour, rather than never again.
   */
  private alertOnce(key: string, to: string | undefined, text: string, app?: string): void {
    // One episode per app: an app's trouble neither silences nor repeats another's.
    key = `${appOfEntry({ app })}|${key}`
    const now = this.deps.now()
    const began = this.episodeStart.get(key)
    if (began !== undefined && now - began < ALERT_EPISODE_GAP_MS) return
    this.episodeStart.set(key, now)
    this.deps.alert?.(text, to, app)
  }

  // -- names ---------------------------------------------------------------

  /** Display name for a user id, cached. A slow or failing lookup yields no name, never a delay. */
  private async nameOf(userId: string, app: string): Promise<string | undefined> {
    const resolve = this.resolvers.get(app)
    if (!resolve) return undefined
    const now = this.deps.now()
    const id = scopeKey(app, userId)
    const hit = this.names.get(id)
    if (hit && now - hit.at < (hit.name ? NAME_TTL_MS : NAME_MISS_TTL_MS)) return hit.name
    let flight = this.nameFlights.get(id)
    if (!flight) {
      flight = Promise.race([
        resolve(userId).catch(() => undefined),
        new Promise<undefined>(res => { const t = setTimeout(() => res(undefined), NAME_TIMEOUT_MS); (t as { unref?: () => void }).unref?.() }),
      ]).then(name => {
        const at = this.deps.now()
        this.names.set(id, { name, at })
        // Entries are only checked on a hit: when the map grows past a bound, drop the expired ones.
        if (this.names.size > NAMES_PRUNE_AT) for (const [k, v] of this.names) if (at - v.at >= (v.name ? NAME_TTL_MS : NAME_MISS_TTL_MS)) this.names.delete(k)
        return name
      })
        .finally(() => this.nameFlights.delete(id))
      this.nameFlights.set(id, flight)
    }
    return flight
  }

  // -- delivery ------------------------------------------------------------

  private flushKey(key: string, cfg: ConversationConfig): void {
    const batch = this.pending.get(key)
    if (!batch) return
    clearTimeout(batch.timer)
    this.pending.delete(key)
    const entry = this.entries.get(key)
    if (!entry) return
    const items = [...batch.items].sort((a, b) => cmpTs(a.ts, b.ts))
    const flying = this.inflight.get(key) ?? new Set<string>()
    for (const i of items) flying.add(i.ts)
    this.inflight.set(key, flying)
    const run = (this.threadRuns.get(key) ?? Promise.resolve())
      .then(() => this.deliverItems(key, entry, items, cfg))
      .catch(err => this.deps.log(`daemon: slack connector: delivering ${key} failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`))
    this.threadRuns.set(key, run)
    void run.finally(() => { if (this.threadRuns.get(key) === run) this.threadRuns.delete(key) })
  }

  private async deliverItems(key: string, entry: ConversationEntry, items: Item[], cfg: ConversationConfig): Promise<void> {
    try {
      await this.deliverBatches(key, entry, items, cfg)
    } finally {
      const flying = this.inflight.get(key)
      for (const i of items) flying?.delete(i.ts)
      if (flying && flying.size === 0) this.inflight.delete(key)
    }
  }

  private async deliverBatches(key: string, entry: ConversationEntry, items: Item[], enqueuedCfg: ConversationConfig): Promise<void> {
    if (this.releasedByHost(key, entry)) return
    // Where each message goes was fixed when its conversation opened: its binding. Who may reach it is read now, from the current config, so a role taken away refuses at once. Read once for
    // the whole burst, so a split burst lands in one place.
    const app = appOfEntry(entry)
    const cfg = this.deps.config(entry.app) ?? enqueuedCfg
    const h = cfg.hydra
    const homes = new Map(items.map(i => {
      const raw = entry.specialist
      return [i.ts, raw ? currentId(h, raw) : undefined] as const
    }))
    // A specialist hydra.toml no longer declares (removed since this arrived): routed anew, now. If nothing hears the
    // place any more, it is lost: a drop, surfaced. Otherwise it stays owed, and its replay binds to whoever hears it now.
    const homeless = items.filter(i => { const to = homes.get(i.ts); return !to || !isLive(h, to) })
    if (homeless.length) {
      // Routed anew as its sender would be now: their rules, and the operator's DM to main, count.
      const lost = homeless.filter(i => route(h, { from: addressOf(i.user), at: placesOf(cfg, entry.channel), addressed: true, app }).fate !== 'deliver')
      if (lost.length) {
        this.drop('unrouted', entry, lost.map(i => i.ts), 'it was accepted, but its specialist is gone and nothing that hears this place now takes it from its sender')
        this.settle(key, entry, lost.map(i => i.ts))
      }
      if (lost.length < homeless.length) this.deps.log(`daemon: slack connector: ${key}: ${homeless.length - lost.length} message(s) were for a specialist hydra.toml no longer declares; they stay owed and are routed anew when catch-up replays them\n`)
      items = items.filter(i => !homeless.includes(i))
    }
    const place = placeName(cfg, entry.channel)
    const g = h.guard
    const { named, verdicts, senders, refused } = await this.admit(entry, cfg, items, i => homes.get(i.ts)!)
    for (const { item, why } of refused) {
      // Accepted, then `reachable_by` changed while it waited: a drop, settled and surfaced.
      this.drop('refused', entry, [item.ts], `it was accepted, but now ${why}`)
      this.settle(key, entry, [item.ts])
    }
    if (!named.length) return
    const groups = new Map<string, Item[]>()
    const fallbackOf = new Map<string, string>()
    named.forEach((item, n) => {
      const v = verdicts[n]
      const home = homes.get(item.ts)!
      if (v.verdict !== 'deferred' && entry.deferredSince?.[item.ts] !== undefined) { delete entry.deferredSince[item.ts]; this.persist() }
      if (v.verdict === 'drop') {
        this.drop('guard', entry, [item.ts], 'the guard dropped it (exit 10)', false)
        if (item.routed?.tagged) recordEvent({ kind: 'route', app, conversation: conversationId(entry), by: addressOf(item.user), tagged: true, via: 'guard' })
        this.settle(key, entry, [item.ts])
        return
      }
      if (v.verdict === 'deferred') {
        // Kept owed for the next pass, for at most owed_max from the first deferred: then it fails, visibly.
        // Unless the owed list was full and already cut it.
        if (!entry.owed?.includes(item.ts)) { this.drop('owed-full', entry, [item.ts], OWED_FULL_WHY); return }
        const since = entry.deferredSince?.[item.ts] ?? this.deps.now()
        if (entry.deferredSince?.[item.ts] === undefined) { (entry.deferredSince ??= {})[item.ts] = since; this.persist() }
        if (this.deps.now() - since > g!.owedMaxMs) {
          this.drop('expired', entry, [item.ts], `the guard said deferred (exit 75) for longer than owed_max (${Math.round(g!.owedMaxMs / 60_000)} min)`)
          this.settle(key, entry, [item.ts])
          return
        }
        this.deps.log(`daemon: slack connector: the guard said deferred (exit 75) for ${key} ts ${item.ts}; it stays owed and the next catch-up pass offers it again\n`)
        return
      }
      if (v.verdict === 'open') this.deps.log(`daemon: slack connector: the guard ${v.why} for ${key} ts ${item.ts}; delivering anyway\n`)
      let to = v.verdict === 'deliver' && v.target ? currentId(h, v.target) : home
      if (to !== home && isSessionThread(to)) {
        // A session's thread is held only by that session's own bind: a guard can't send a conversation's message there.
        this.deps.log(`daemon: slack connector: the guard redirected ${key} ts ${item.ts} to the session thread ${to}, which only that session's bind may hold; delivering to ${home}\n`)
        this.alertOnce(`guard-redirect:${to}`, home, `⚠️ The guard redirected a Slack message in ${place} to the session thread ${to}, so it went to ${home} instead: a guard redirects only to a specialist (or main).`, app)
        to = home
      }
      if (to !== home) {
        // A redirect does not get around `reachable_by`: the specialist it names must admit the sender too.
        // The app that heard the conversation is the one this message came through.
        const why = refusal(h, to, senders.get(item.ts)!, { app })
        if (why) {
          this.deps.log(`daemon: slack connector: the guard redirected ${key} ts ${item.ts} to ${to}, but ${why}; delivering to ${home}\n`)
          // A redirect to a specialist that doesn't exist, or that this app cannot be served by, is the guard misconfigured: said once per episode, or a typo would quietly send everything to the default forever.
          const apart = notServedBy(h, to, app)
          if (apart) this.alertOnce(`guard-redirect:${to}`, home, `⚠️ The guard redirected a Slack message in ${place} to "${to}", but ${apart}, so it went to ${home} instead. Fix the guard, or change which apps "${to}" is pinned to in hydra.toml.`, app)
          else if (!isLive(h, to)) this.alertOnce(`guard-redirect:${to}`, home, `⚠️ The guard redirected a Slack message in ${place} to "${to}", which is no specialist in hydra.toml, so it went to ${home} instead. Fix the guard, or declare [specialists.${to}].`, app)
          to = home
        } else {
          this.deps.log(`daemon: slack connector: the guard redirected ${key} ts ${item.ts} from ${home} to ${to}\n`)
          fallbackOf.set(to, home)
        }
      }
      groups.set(to, [...(groups.get(to) ?? []), item])
    })
    // Attachments are fetched only for what will be delivered, two messages at a time, before this thread's turn to send.
    const files = !!placeOptions(cfg, entry.channel)?.files
    for (const [to, group] of groups) groups.set(to, await mapLimit(group, 2, i => i.files?.length ? this.saveFiles(entry, i, files, to) : Promise.resolve(i)))
    // Only the sending is serialized across threads.
    const send = this.chain.then(async () => {
      for (const [to, group] of groups) await this.deliverGroup(key, entry, { to }, group, cfg, fallbackOf.get(to))
    })
    this.chain = send.catch(() => {})
    await send
  }

  /**
   * A message's attachments, as the session will read them: downloaded at mode 0600 under the state dir when the
   * place says `files` (then copied into the recipient's own inbox when it reads only its own folder: `placeFile`), otherwise listed by name. Too large, failed or not connected: listed, with why. Never a reason to hold the message.
   */
  private async saveFiles(entry: ConversationEntry, i: Item, enabled: boolean, to: string): Promise<Item> {
    const saved: FileRef[] = []
    for (const f of i.files ?? []) {
      const ref: FileRef = { name: f.name, ...(f.size !== undefined && { size: f.size }) }
      if (!enabled) ref.note = 'not downloaded (files is off for this place)'
      else if (!f.url) ref.note = 'not downloadable (Slack gave no download link: an external, hidden or deleted file)'
      else if (f.size !== undefined && f.size > FILE_MAX_BYTES) ref.note = `not downloaded (over ${FILE_MAX_BYTES / 1024 / 1024} MB)`
      else if (!this.actions.get(appOfEntry(entry)) || !this.deps.filesDir) ref.note = 'not downloaded (not connected to Slack)'
      // Files are fetched only with the bot's token, and only where the bot is: the operator's token reads text, never files.
      else if (entry.via === 'user') ref.note = "not downloaded (the bot isn't in this channel; the thread is read as the operator)"
      else {
        // Keyed by the file's own id, so a file shared in several messages is fetched once.
        const dest = join(this.deps.filesDir, ...(appOfEntry(entry) === DEFAULT_SLACK_APP ? [] : [appOfEntry(entry)]), entry.channel, `${f.id.replace(/[^A-Za-z0-9]/g, '')}-${safeFileName(f.name)}`)
        try {
          if (!existsSync(dest)) {
            // One download per file: two messages sharing it wait on the same one, never race on one .part.
            let flight = this.downloads.get(dest)
            if (!flight) {
              flight = this.actions.get(appOfEntry(entry))!.download(f.url!, dest, FILE_MAX_BYTES).finally(() => this.downloads.delete(dest))
              this.downloads.set(dest, flight)
            }
            await flight
          }
          // A recipient that reads only its own folder is handed a copy there: the download stays where the state folder keeps it, for the next recipient and the sweep.
          try { ref.path = this.deps.placeFile?.(to, dest, f.name) ?? dest } catch (err) {
            ref.note = `not saved in its inbox (${err instanceof Error ? err.message : err})`
            this.deps.log(`daemon: slack connector: saving ${f.id} for ${to} in its inbox failed: ${ref.note}\n`)
          }
        } catch (err) {
          ref.note = `not downloaded (${err instanceof Error ? err.message : err})`
          this.deps.log(`daemon: slack connector: downloading ${f.id} from ${entry.channel} ts ${i.ts} failed: ${ref.note}\n`)
        }
      }
      saved.push(ref)
    }
    return { ...i, saved }
  }

  /**
   * The gates every item passes on its way to a session, a message or a reaction alike, so a gate added here covers both: `reachable_by`
   * read now (a role taken away stops it: `refused`, left for the caller to settle), the sender's name (the roster's `name` wins; else Slack's
   * display name, cleaned; else the person's id), and the guard, which judges everyone but the operator. `named` and `verdicts` run together.
   */
  private async admit(entry: ConversationEntry, cfg: ConversationConfig, items: Item[], homeOf: (i: Item) => string): Promise<{ named: Item[]; verdicts: GuardVerdict[]; senders: Map<string, ReturnType<typeof identify>>; refused: { item: Item; why: string }[] }> {
    const h = cfg.hydra
    const app = appOfEntry(entry)
    const senders = new Map(items.map(i => [i.ts, identify(h, addressOf(i.user))] as const))
    const refused: { item: Item; why: string }[] = []
    items = items.filter(i => {
      const why = refusal(h, homeOf(i), senders.get(i.ts)!, { app })
      if (why) refused.push({ item: i, why })
      return !why
    })
    // The one place a sender gets a name: the roster's `name` wins; else Slack's display name (a stranger, or a person declared without a `name`),
    // else the person's id.
    const users = [...new Set(items.filter(i => !senders.get(i.ts)!.person?.name).map(i => i.user).filter((u): u is string => !!u))]
    const resolved = new Map(await Promise.all(users.map(async u => [u, await this.nameOf(u, app)] as const)))
    const named = items.map(i => {
      const who = senders.get(i.ts)!
      // A Slack display name is the sender's own free text: no mentions or special links (<@U…>, <!here>), so it cannot pose as another sender.
      const cleaned = (i.user ? resolved.get(i.user) : undefined)?.replace(/<[@!#][^>]*>/g, '')
      // A display name that reads as a rostered person or as `operator` is a disguise next to person="carol" operator=false: the sender's own id stands instead.
      const slackName = cleaned && isDisguise(h, cleaned) ? who.person?.id ?? i.user : cleaned
      return { ...i, name: who.person?.name ?? slackName ?? who.person?.id, ...(who.person && { person: who.person.id }), roles: who.roles, operator: who.operator }
    })
    // The guard judges each item from anyone but the operator, and may send it somewhere else. Groups keep the burst's order.
    const g = h.guard
    const place = placeName(cfg, entry.channel)
    const verdicts = await mapLimit(named, GUARD_CONCURRENCY, i => g && !i.operator ? this.judge(g, entry, place, homeOf(i), i) : Promise.resolve<GuardVerdict>({ verdict: 'deliver' }))
    return { named, verdicts, senders, refused }
  }

  /** One send: the items as the session reads them, to `target`. The target is part of the key: the same items re-routed elsewhere are a different send. */
  private async post(entry: ConversationEntry, target: RouteTarget, batch: Item[], cfg: ConversationConfig): Promise<DeliverOutcome> {
    // A channel thread main hears for the first time: main is told what it may do with it. A DM or a group DM is main's to answer, and has no session to hand it to.
    const fresh = target.to === MAIN && !isDm(entry.channel) && !cfg.directory.isGroupDm?.(entry.channel) && entry.threadTs !== TOP_LEVEL && !entry.delivered?.length
    // The session the conversation is bound to reads, with each message (a reaction too), whether the app was tagged and by whom, and one line on
    // what that likely means. deliverGroup added the facts already, to pack with them: adding them again changes nothing.
    const toSession = isSessionThread(target.to)
    const items = toSession ? boundSessionFacts(batch) : batch
    const note = fresh ? NEW_TO_MAIN_NOTE : toSession ? boundSessionNote(items, appName(cfg.hydra.slackApps, appOfEntry(entry)), !!this.deps.speaksIn?.(target.to)) : undefined
    const message = formatDelivery(entry, items, { place: placeName(cfg, entry.channel), ...(cfg.workspaceUrl && { workspaceUrl: cfg.workspaceUrl }), ...(note && { note }) })
    const idempotencyKey = `slack-watch-${appPrefix(entry.app, '-')}${entry.channel}-${entry.threadTs}-${batch[0].ts}-${batch[batch.length - 1].ts}-${target.to}`
    try { return await this.deps.deliver({ ...target, conversation: conversationId(entry) }, message, idempotencyKey) } catch (err) {
      // A deliver that threw: exit 6 (failed), as targets.ts's `deliverVia` answers a throw.
      return { ok: false, exit: 6, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** One message's verdict from the guard. A guard that throws fails open, like one that crashes. */
  private async judge(g: Guard, entry: ConversationEntry, place: string, to: string, i: Item): Promise<GuardVerdict> {
    const input: GuardInput = {
      person: i.person ?? null, roles: i.roles ?? ['anyone'], place, conversation: conversationId(entry), target: spelledBare(to),
      ...(g.includeText && { text: i.text }),
    }
    try { return await (this.deps.guard ?? runGuard)(g, input) } catch (err) {
      return { verdict: 'open', why: `threw: ${err instanceof Error ? err.message : err}` }
    }
  }

  /** These ts are done with: delivered, or dropped for good. Replays of them deliver nothing. */
  private settle(key: string, entry: ConversationEntry, ts: string[]): void {
    if (this.entries.get(key) !== entry) return
    for (const t of ts) entry.delivered = insertTs(entry.delivered, t, Infinity)
    entry.delivered = keepDelivered(entry.delivered!, entry.owed?.filter(t => !ts.includes(t)), entry.threadTs)
    const settled = new Set(ts)
    const owed = (entry.owed ?? []).filter(t => !settled.has(t))
    if (owed.length) entry.owed = owed; else delete entry.owed
    if (entry.deferredSince) { for (const t of ts) delete entry.deferredSince[t]; if (!Object.keys(entry.deferredSince).length) delete entry.deferredSince }
    this.persist()
  }

  /** `fallback`: the binding, for a guard redirect whose specialist has no session record. A broken guard never holds a message back. */
  private async deliverGroup(key: string, entry: ConversationEntry, target: RouteTarget, items: Item[], cfg: ConversationConfig, fallback?: string): Promise<void> {
    // To a session's thread, each message says whether the app was tagged and by whom: added before packing, with room kept for the line, so no batch outgrows the cap.
    const toSession = isSessionThread(target.to)
    for (const batch of toSession ? packItems(boundSessionFacts(items), BATCH_MAX_BYTES - BOUND_NOTE_ROOM) : packItems(items, BATCH_MAX_BYTES - EXTERNAL_AUDIENCE_NOTE.length)) {
      const first = batch[0].ts
      const last = batch[batch.length - 1].ts
      const result = await this.post(entry, target, batch, cfg)
      if (!result.ok && result.wait) {
        // Not a failure: a turn. Said once an hour while it lasts, so a specialist stuck at max (no idle) is noticed.
        if (entry.waitingSince === undefined) { entry.waitingSince = this.deps.now(); this.persist() }
        this.deps.log(`daemon: slack connector: ${key} waits: ${result.reason}\n`)
        this.alertOnce(`max:${target.to}`, target.to, `⏳ ${result.reason}. Its messages stay owed until then.`, appOfEntry(entry))
        continue
      }
      if (entry.waitingSince !== undefined) { delete entry.waitingSince; this.persist() }
      if (!result.ok && !result.permanent) {
        // Still owed: it stays in `owed`, so the catch-up pass fetches it again. Unless the owed list was full and cut it.
        this.deps.log(`daemon: slack connector: delivery to ${spelledBare(target.to)} failed for ${key} (${first}..${last}): ${result.reason}\n`)
        this.failing.set(key, oneLine(result.reason, 200))
        if (result.exit === 8 && fallback) {
          this.deps.log(`daemon: slack connector: the guard redirected ${key} (${first}..${last}) to ${target.to}, which has no session record; delivering to ${fallback}\n`)
          this.alertOnce(`guard-redirect:${target.to}`, fallback, `⚠️ The guard redirected a Slack message in ${placeName(cfg, entry.channel)} to "${target.to}", which has no session record (${result.reason}), so it went to ${fallback} instead.`, appOfEntry(entry))
          await this.deliverGroup(key, entry, { to: fallback }, batch, cfg)
          continue
        }
        if (result.exit === 8) this.alertOnce(`no-such-specialist:${target.to}`, undefined, `⚠️ Slack messages in ${placeName(cfg, entry.channel)} are owed but undeliverable: ${result.reason}. The conversation is bound to "${target.to}", ${result.malformed ? 'which hydra cannot read as a target' : `which has no session record; check [specialists.${target.to}] in hydra.toml`}. They stay owed for up to a day.`, appOfEntry(entry))
        const cut = batch.map(i => i.ts).filter(ts => !entry.owed?.includes(ts))
        if (cut.length && this.entries.get(key) === entry) this.drop('owed-full', entry, cut, OWED_FULL_WHY)
        continue
      }
      if (!result.ok) this.drop('too-large', entry, batch.map(i => i.ts), `it can never be delivered: ${result.reason}`)
      else {
        this.failing.delete(key)
        // Every landed delivery names its target, whoever it is (main, a specialist, a thread).
        this.deps.log(`daemon: slack connector: delivered ${key} (${first}..${last}) to ${spelledBare(target.to)}${result.duplicate ? ' (already delivered)' : ''}\n`)
        this.ack(entry, batch, cfg)
        if (!result.duplicate) this.recordRoutes(entry, batch, target.to, cfg)   // a duplicate is a replay of a delivery whose event was written when it first landed
        if (!entry.ambient && !result.duplicate) entry.unansweredAt = this.deps.now()
      }
      this.settle(key, entry, batch.map(i => i.ts))
    }
  }

  /**
   * Where each message went, written when its delivery settles (after the guard may have redirected it), once per message: a replay of one already delivered does not reach here.
   * The same point shows the session's own thread a line for each tag by someone in [people], so the line and the event cannot disagree about what was delivered.
   */
  private recordRoutes(entry: ConversationEntry, batch: Item[], to: string, cfg: ConversationConfig): void {
    for (const i of batch) {
      if (!i.routed) continue
      recordEvent({ kind: 'route', app: appOfEntry(entry), conversation: conversationId(entry), by: addressOf(i.user), tagged: i.routed.tagged, via: i.routed.via, to })
      this.showReceived(entry, i, to, cfg)
    }
  }

  /** 📨 in the thread of the session a message was delivered to: only a tag (untagged chatter would bury the thread), only by someone in [people] (a stranger's tag is the router's to refuse, not the session's to be shown). */
  private showReceived(entry: ConversationEntry, i: Item, to: string, cfg: ConversationConfig): void {
    if (!i.routed?.tagged || !i.user || !isSessionThread(to)) return
    const person = Object.values(cfg.hydra.people).find(p => p.addresses.includes(`slack:${i.user}`))
    if (!person) return
    const inThread = entry.threadTs !== TOP_LEVEL && entry.threadTs !== i.ts
    const link = cfg.workspaceUrl ? archiveUrl(cfg.workspaceUrl, entry.channel, i.ts, inThread ? entry.threadTs : undefined) : undefined
    this.deps.line?.(to, emoji => receivedLine(emoji, person.name ?? person.id, link, i.text))
  }

  /** The sender sees the message was picked up: the place's `ack` reaction on each delivered message. Best effort, never retried. */
  private ack(entry: ConversationEntry, batch: Item[], cfg: ConversationConfig): void {
    const name = placeOptions(cfg, entry.channel)?.ack
    const slack = this.actions.get(appOfEntry(entry))   // the reaction goes through the app that heard the message
    if (!name || !slack) return
    for (const i of batch) {
      this.reactAs(slack, entry.app, entry.channel, i.ts, name)
    }
  }

  /** Deliver everything waiting now and write the store, then resolve once deliveries settle. For shutdown and tests. */
  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) { const cfg = this.deps.config(this.entries.get(key)?.app); if (cfg) this.flushKey(key, cfg) }
    while (this.threadRuns.size) await Promise.all([...this.threadRuns.values()])
    await this.chain
    this.persistNow()
  }

  /** Stop timers without delivering: what is waiting stays owed in the store. */
  close(): void {
    for (const b of this.pending.values()) clearTimeout(b.timer)
    this.pending.clear()
    this.persistNow()
  }
}

/**
 * One app's side of the watcher: the calls its listener and its catch-up pass make, with the app filled in. What it lists,
 * holds, reads from and hands events to is that app's alone; the table, the guard and the alerts stay the watcher's.
 */
export class AppConversations {
  constructor(private readonly w: ConversationTable, readonly app: string) {}
  handle(ev: SlackMessageEvent): HandleOutcome { return this.w.handle({ ...ev, app: this.app }) }
  handleReaction(ev: SlackReactionEvent): ReactionOutcome { return this.w.handleReaction({ ...ev, app: this.app }) }
  list(): ConversationEntry[] { return this.w.list().filter(e => appOfEntry(e) === this.app) }
  channelCursor(channel: string): string | undefined { return this.w.channelCursor(channel, this.app) }
  owedHints(): { channel: string; threadTs: string; fromTs: string }[] { return this.w.owedHints(this.app) }
  dmChannels(): string[] { return this.w.dmChannels(this.app) }
  taggedChannels(): string[] { return this.w.taggedChannels(this.app) }
  beginCatchUp(channels: string[]): void { this.w.beginCatchUp(channels, this.app) }
  endCatchUp(channel: string, newestTs?: string): void { this.w.endCatchUp(channel, newestTs, this.app) }
  markRead(channel: string, ts: string): void { this.w.markRead(channel, ts, this.app) }
  catchUpGap(channel: string, cursor: string, oldestRead: string | undefined, read: number): void { this.w.catchUpGap(channel, cursor, oldestRead, read, this.app) }
  setVia(channel: string, threadTs: string, via: 'bot' | 'user'): void { this.w.setVia(channel, threadTs, via, this.app) }
  threadGone(channel: string, threadTs: string, why: string): void { this.w.threadGone(channel, threadTs, why, this.app) }
  operatorTokenRefused(why: string): void { this.w.operatorTokenRefused(why, this.app) }
  setBotId(id: string | undefined): void { this.w.setBotId(id, this.app) }
  setNameResolver(fn: ConversationDeps['resolveName']): void { this.w.setNameResolver(fn, this.app) }
  setSlackActions(actions: SlackActions | undefined): void { this.w.setSlackActions(actions, this.app) }
  reactionsMayWork(channel: string): void { this.w.reactionsMayWork(channel) }
}

/** What a catch-up pass needs of the watcher: the whole watcher (the app `default`), or one app's side of it. */
export type CatchUpConversations = Pick<ConversationTable, 'handle' | 'list' | 'channelCursor' | 'owedHints' | 'dmChannels' | 'taggedChannels' | 'beginCatchUp' | 'endCatchUp' | 'markRead' | 'catchUpGap' | 'setVia' | 'threadGone' | 'operatorTokenRefused'>
