import { readFileSync, existsSync, statSync, readdirSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import { STATE_DIR } from '../../daemon/config.js'
import { atomicWriteFileSync } from '../../daemon/util.js'
import type { Address, HydraConfig, Place, PlaceOptions } from '../../config/types.js'
import { route, refusal, identify, currentId, MAIN } from '../../routing/route.js'

/** Where a delivery goes: a specialist (or `main`), and the conversation it is for, so a per-conversation specialist can give it its own session. */
export type RouteTarget = { to: string; conversation?: string }
import { runGuard, type GuardInput, type GuardVerdict } from '../../routing/guard.js'
import type { Guard } from '../../config/types.js'

/**
 * Slack conversations: the Slack connector's side of routing (routing/route.ts).
 *
 * A conversation is a Slack thread, or a DM's top level. It opens when the bot is tagged (or posts the thread's
 * first message, or someone DMs it), and is bound then to the specialist routing picks; from then on every reply is
 * delivered to that specialist, tagged or not, until it goes idle. A config change re-routes only new conversations;
 * `allow` is checked again at delivery. Where `listen = "all"`, an untagged top-level message opens a conversation too:
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

/** What the watcher may do in Slack: react (the ack, and 🚫 on a refused or unrouted mention or DM) and download the files it reads. */
export type SlackActions = {
  download: (url: string, dest: string, maxBytes: number) => Promise<void>
  react: (channel: string, ts: string, name: string) => Promise<void>
}

/** Slack channel names, from conversations.list: id → name (without `#`) and back. Empty without channels:read or groups:read. */
export type SlackDirectory = { nameOf(id: string): string | undefined; idOf(name: string): string | undefined }
export const NO_DIRECTORY: SlackDirectory = { nameOf: () => undefined, idOf: () => undefined }

/**
 * What the watcher reads: `hydra.toml`, plus what the Slack connection learned (its own ids, the workspace, channel names).
 * Read per event, so an edit applies without a restart.
 */
export type SlackWatchConfig = {
  hydra: HydraConfig
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
  maxWatches: number
  /** Tags one person may land in ten minutes before the rest are dropped. */
  maxMentionsPer10Min: number
}

/** The limits hydra.toml has no key for. */
export const SLACK_LIMITS = { idleExpiryMs: 7 * 86_400_000, coalesceMs: 4000, maxWatches: 50, maxMentionsPer10Min: 10 } as const

/**
 * A conversation: a Slack thread (or a DM's top level) and the specialist it is bound to. The binding is fixed when
 * its first message arrives; a config change re-routes only new conversations, and `bind_conversation` moves one.
 */
export type SlackWatchEntry = {
  channel: string
  threadTs: string
  /** The specialist this conversation is bound to. Absent only in a store written before bindings: its next message binds it. */
  specialist?: string
  mentionedBy?: string
  createdAt: number
  /** Last matching event, delivered or not: the idle clock. */
  lastEventAt: number
  /** ts of messages already delivered (recent ones, oldest dropped): the exact dedupe. */
  delivered?: string[]
  /** ts of messages accepted but not yet delivered. Persisted before sending; tells catch-up where to look. */
  owed?: string[]
  /** Opened by untagged chatter where `listen = "all"`: while owed or answered, such conversations take at most half the table; they idle out in a day. */
  ambient?: true
  /** When the guard first said "not now" (exit 75) to an owed ts: `owed_max` counts from here. */
  heldSince?: Record<string, number>
  /** Since when it has waited for a session of its own (its specialist at `max`): its owed messages don't expire meanwhile, and the oldest waiter takes the next freed place. */
  waitingSince?: number
}

/** The fields of a Slack `message` event this module reads. */
export type SlackMessageEvent = {
  channel: string
  ts: string
  threadTs?: string
  user?: string
  botId?: string
  subtype?: string
  text?: string
  files?: SlackFile[]
}

export type DeliverResult =
  | { ok: true; duplicate?: boolean }
  // `permanent`: this message can never be delivered (too large). It is dropped, not retried.
  // `exit` 8: the binding names no such specialist. Kept owed (a fixed config delivers it) and alerted.
  // `wait`: its specialist runs `max` conversation sessions already. Kept owed, and never expires while it waits.
  | { ok: false; error: string; permanent?: boolean; exit?: number; wait?: true }

export type SlackWatchDeps = {
  now: () => number
  deliver: (target: RouteTarget, message: string, idempotencyKey: string) => Promise<DeliverResult>
  /** Read per event so edits apply without a restart. Null: Slack isn't connected, nothing is heard. */
  config: () => SlackWatchConfig | null
  file: string
  log: (line: string) => void
  /** Slack user id to display name (users.info). Optional; deliveries carry the id either way. */
  resolveName?: (userId: string) => Promise<string | undefined>
  /** Where downloaded attachments go: `<dir>/<channel>/<file id>-<name>`. */
  filesDir?: string
  /** Runs the guard. Defaults to the real subprocess; tests pass a fake. */
  guard?: (g: Guard, input: GuardInput) => Promise<GuardVerdict>
  /** A plain message to a person (not a session turn): how a drop is surfaced. `to`: the specialist it concerns, whose home should hear it. */
  alert?: (text: string, to?: string) => void
}

/** `refused`: `allow` does not admit the sender. `unrouted`: a mention or DM no specialist hears. */
export type HandleOutcome = 'mention' | 'follow-up' | 'dm' | 'subscribed' | 'refused' | 'unrouted' | 'ignored'

/** Why an accepted (or would-be accepted) message will never be delivered. */
/** `refused` / `unrouted`: accepted and owed, then `allow` or the config changed so it can no longer go anywhere. `unbound`: owed when its conversation was let go. */
export type DropKind = 'expired' | 'owed-full' | 'too-large' | 'tag-cap' | 'table-full' | 'guard' | 'catch-up-gap' | 'refused' | 'unrouted' | 'unbound'

export type SlackWatchStats = { refused: number; refusedBy: Record<string, number>; unrouted: number; dropped: Partial<Record<DropKind, number>> }

/** The reaction on a refused or unrouted mention or DM. Hydra's notices are reactions, never prose. */
export const REFUSED_REACTION = 'no_entry_sign'

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export const slackWatchesPath = () => join(STATE_DIR, 'slack-watches.json')

/** Slack DM channel ids start with D, in events and in history alike. */
export const isDm = (channel: string): boolean => /^D[A-Z0-9]+$/.test(channel)

/**
 * A DM's top level, or a `listen = "all"` place's untagged top-level messages, is one conversation, under this ts.
 * Never a real ts: it must not reach a Slack API call or the guard.
 */
export const TOP_LEVEL = '0.000000'

/** Every name a Slack channel goes by, most specific first: `slack:C0ABC`, then `slack:#help`. Every DM is `slack:dm`. */
export function placesOf(cfg: Pick<SlackWatchConfig, 'directory'>, channel: string): Place[] {
  if (isDm(channel)) return ['slack:dm']
  const name = cfg.directory.nameOf(channel)
  return [`slack:${channel}`, ...(name ? [`slack:#${name}`] : [])]
}

/** How a place reads to a person: by name when known. */
export const placeName = (cfg: Pick<SlackWatchConfig, 'directory'>, channel: string): Place => placesOf(cfg, channel).at(-1)!

/** A conversation's id, as `hydra conversations`, the guard and `bind_conversation` name it. */
export const conversationId = (e: Pick<SlackWatchEntry, 'channel' | 'threadTs'>): string =>
  e.threadTs === TOP_LEVEL ? `slack:${e.channel}` : `slack:${e.channel}:${e.threadTs}`

/** The Slack channels hydra.toml names, in `listens` and `[[rules]]`, as written. */
function namedChannels(h: HydraConfig): Place[] {
  const all = [...Object.values(h.specialists).flatMap(s => s.listens), ...h.rules.map(r => r.at)]
  return [...new Set(all.filter(p => p.startsWith('slack:') && p !== 'slack:dm'))]
}

const channelIdOf = (cfg: Pick<SlackWatchConfig, 'directory'>, place: Place): string | undefined => {
  const rest = place.slice('slack:'.length)
  return rest.startsWith('#') ? cfg.directory.idOf(rest.slice(1)) : rest
}

/** The channels hydra.toml names, by id: what catch-up scans and the listener holds. A `#name` not yet resolved is left out. */
export function routedChannels(cfg: Pick<SlackWatchConfig, 'hydra' | 'directory'> | null | undefined): string[] {
  if (!cfg) return []
  return [...new Set(namedChannels(cfg.hydra).flatMap(p => channelIdOf(cfg, p) ?? []))]
}

/** `#name` places no channel answers to: the bot isn't in it, it was renamed, or names can't be read (no channels:read). */
export function unresolvedPlaces(cfg: Pick<SlackWatchConfig, 'hydra' | 'directory'>): Place[] {
  return namedChannels(cfg.hydra).filter(p => !channelIdOf(cfg, p))
}

/** Whether DMs are heard: something takes `slack:dm`, or the operator has a Slack address (their DMs reach main). */
export function hearsDms(cfg: Pick<SlackWatchConfig, 'hydra'> | null | undefined): boolean {
  if (!cfg) return false
  const h = cfg.hydra
  if (Object.values(h.specialists).some(s => s.listens.includes('slack:dm')) || h.rules.some(r => r.at === 'slack:dm')) return true
  return !!h.operator && !!h.people[h.operator]?.ids.some(a => a.startsWith('slack:'))
}

/** A Slack user, as hydra.toml addresses them. */
export const addressOf = (user: string | undefined): Address | undefined => user ? `slack:${user}` : undefined

/** The `[places]` options that apply to a channel: the most specific name that has any. */
export function placeOptions(cfg: Pick<SlackWatchConfig, 'hydra' | 'directory'>, channel: string): PlaceOptions | undefined {
  for (const p of placesOf(cfg, channel)) if (cfg.hydra.places[p]) return cfg.hydra.places[p]
  return undefined
}

/** The specialist that would answer a new conversation here, whoever asks: where an alert about this channel goes. */
export function listenerOf(cfg: SlackWatchConfig | null | undefined, channel: string): string | undefined {
  if (!cfg) return undefined
  const d = route(cfg.hydra, { at: placesOf(cfg, channel), addressed: true, ...(cfg.hydra.operator && { from: cfg.hydra.people[cfg.hydra.operator]?.ids[0] }) })
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
const AMBIENT_IDLE_MS = 86_400_000
/** The longest a conversation waits for a session of its own before its messages are dropped, alerted. */
const WAIT_MAX_MS = 3 * 86_400_000
/**
 * Chatter answered by no one: a conversation opened by an untagged message, delivered, nothing owed, no reply under it.
 * It holds no slot in the table (it stays a day only so a late reply follows its binding and a replay is not delivered twice).
 */
const oneOff = (e: SlackWatchEntry): boolean => !!e.ambient && !e.owed?.length && (e.delivered?.length ?? 0) <= 1
/** Whether `id` (after `was` renames) is a specialist hydra.toml declares, or main. */
const declaredIn = (h: HydraConfig, id: string): boolean => { const to = currentId(h, id); return to === MAIN || !!h.specialists[to] }
const OWED_KEEP = 200
const OWED_MAX_AGE_S = 24 * 3600
const MENTION_WINDOW_MS = 10 * 60_000
const NAME_TTL_MS = 24 * 3600_000
const NAME_MISS_TTL_MS = 5 * 60_000
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

const watchKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`
const tagRe = (botUserId: string) => new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`)

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

/** One message. `person`, `roles` and `operator` are who hydra.toml says sent it, filled in at delivery. */
export type Item = {
  ts: string; user?: string; name?: string; person?: string; roles?: string[]; operator?: boolean
  kind: 'mention' | 'follow-up' | 'dm'; text: string; files?: SlackFile[]; saved?: FileRef[]
}

// Invisible and direction-changing characters that let a message look like something it is not
// (controls except newline and tab, NEL, zero-width and direction marks, line/paragraph separators, bidi overrides, BOM).
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0B, 0x1F], [0x7F, 0x7F], [0x85, 0x85], [0x200B, 0x200F],
  [0x2028, 0x2029], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF],
]
const clean = (s: string) => Array.from(s).filter(ch => {
  const c = ch.codePointAt(0)!
  return !HIDDEN_RANGES.some(([lo, hi]) => c >= lo && c <= hi)
}).join('')

export const ITEM_TEXT_MAX_CHARS = 1500
export const BATCH_MAX_BYTES = 8000

const oneLine = (s: string | undefined, max: number) => s ? clean(s).replace(/\s+/g, ' ').trim().slice(0, max) : ''
/** An attribute value: one clean line, quoted, so no value can end its attribute or its line. */
// Quotes, backslashes, `=` and brackets go: a sender's own display name cannot spell out another attribute.
const attr = (s: string) => `"${oneLine(s, 120).replace(/["\\=[\]]/g, '')}"`

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
  ]
  const chars = Array.from(clean(i.text))
  const body = chars.length > ITEM_TEXT_MAX_CHARS
    ? `${chars.slice(0, ITEM_TEXT_MAX_CHARS).join('')} […truncated ${chars.length - ITEM_TEXT_MAX_CHARS} chars; read the thread]`
    : chars.join('')
  // File names are the sender's words too: one line each, cleaned, and never at the start of a line where they could pose as an item.
  const files = (i.saved ?? []).map(f => `  file: ${oneLine(f.name, 120) || '(unnamed)'}${f.size !== undefined ? ` (${formatBytes(f.size)})` : ''}${f.path ? ` → ${f.path}` : `: ${f.note}`}`)
  return [`[${i.kind} ts=${attr(i.ts)} ${who.join(' ')}]`, body.split('\n').map(l => `| ${l}`).join('\n'), ...files].join('\n')
}

const formatBytes = (n: number): string => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/**
 * What the specialist's occupant reads. The Slack text is other people's words, so it sits inside the untrusted
 * envelope: markers carrying a one-off nonce the text cannot forge. Where it was said rides on the opening marker.
 */
export function formatDelivery(
  entry: Pick<SlackWatchEntry, 'channel' | 'threadTs'>,
  items: Item[],
  where: { place: Place; workspaceUrl?: string },
  nonce: string = randomBytes(6).toString('hex'),
): string {
  const dm = isDm(entry.channel)
  const link = where.workspaceUrl ? `${where.workspaceUrl}/archives/${entry.channel}${dm || entry.threadTs === TOP_LEVEL ? '' : `/p${entry.threadTs.replace('.', '')}`}` : undefined
  const attrs = [`place=${attr(where.place)}`, `conversation=${attr(conversationId(entry))}`, ...(link ? [`link=${attr(link)}`] : [])]
  return [
    `<<<SLACK-UNTRUSTED-${nonce} ${attrs.join(' ')}`,
    items.map(renderItem).join('\n\n'),
    `SLACK-UNTRUSTED-${nonce}>>>`,
  ].join('\n')
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

type Store = { entries: SlackWatchEntry[]; channelCursors: Record<string, string> }

export class SlackWatcher {
  private readonly entries = new Map<string, SlackWatchEntry>()
  private channelCursors: Record<string, string> = {}
  private readonly pending = new Map<string, { items: Item[]; timer: ReturnType<typeof setTimeout> }>()
  // Handed to the delivery chain but not yet settled. A replay of one of these (a catch-up pass fires on every reconnect, and a refill can take a while) would otherwise open a second batch and deliver it twice.
  private readonly inflight = new Map<string, Set<string>>()
  private readonly mentionTimes = new Map<string, number[]>()
  private readonly refusalTimes = new Map<string, number[]>()
  private readonly names = new Map<string, { name?: string; at: number }>()
  private readonly nameFlights = new Map<string, Promise<string | undefined>>()
  // Deliveries go out one at a time, in the order they were scheduled.
  private chain: Promise<void> = Promise.resolve()
  // Each thread's flushes run in order, but the work before sending (names, beforeDeliver) runs beside other threads': one slow guard holds back only its own thread.
  private readonly threadRuns = new Map<string, Promise<void>>()
  private dirty = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private botId: string | undefined
  // Channels a catch-up pass has yet to read. Live events never move these cursors: a cursor moved past a gap the pass
  // has not read would leave that gap unread for good. A pass releases each channel as it finishes reading it.
  private readonly held = new Set<string>()
  // Refusals and drops already logged, so a catch-up replay neither logs nor counts them twice. Insertion-ordered; oldest go first.
  // Two sets, so a flood of refusals cannot evict the drops (and re-count them on replay).
  private readonly noted = { refused: new Set<string>(), dropped: new Set<string>() }
  private readonly stats_: SlackWatchStats = { refused: 0, refusedBy: {}, unrouted: 0, dropped: {} }
  private readonly episodeStart = new Map<string, number>()

  private resolveName: SlackWatchDeps['resolveName']
  private slack: SlackActions | undefined
  private readonly downloads = new Map<string, Promise<void>>()

  constructor(private readonly deps: SlackWatchDeps) { this.resolveName = deps.resolveName; this.load() }

  // -- store ---------------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.deps.file)) return
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Store
      for (const e of raw.entries ?? []) this.entries.set(watchKey(e.channel, e.threadTs), e)
      this.channelCursors = raw.channelCursors ?? {}
    } catch (err) {
      this.deps.log(`daemon: slack-watch: load failed: ${err}\n`)
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
      const store: Store = { entries: [...this.entries.values()], channelCursors: this.channelCursors }
      atomicWriteFileSync(this.deps.file, JSON.stringify(store, null, 2) + '\n')
    } catch (err) {
      this.dirty = true
      this.deps.log(`daemon: slack-watch: persist failed: ${err}\n`)
    }
  }

  list(): SlackWatchEntry[] { return [...this.entries.values()] }
  /** Refusals and drops since the daemon started: what `hydra conversations` and `hydra health` count. */
  stats(): SlackWatchStats { return structuredClone(this.stats_) }
  get(channel: string, threadTs: string): SlackWatchEntry | undefined { return this.entries.get(watchKey(channel, threadTs)) }
  setBotId(id: string | undefined): void { this.botId = id }
  /** Supplied once the listener has a Slack client: display names for the senders in deliveries. */
  setNameResolver(fn: SlackWatchDeps['resolveName']): void { this.resolveName = fn }
  /** Supplied once the listener is connected: file downloads and the ack reaction. */
  setSlackActions(actions: SlackActions | undefined): void { this.slack = actions }

  /**
   * Open a conversation bound to `specialist`, or touch the one that exists. Its binding is never changed here: only
   * `bind` moves a conversation. Undefined when the table is full.
   */
  watch(channel: string, threadTs: string, specialist: string, mentionedBy?: string): SlackWatchEntry | undefined {
    const now = this.deps.now()
    const existing = this.get(channel, threadTs)
    if (existing) {
      existing.lastEventAt = now
      existing.specialist ??= specialist // a store written before bindings: its first message since binds it
      this.persist()
      return existing
    }
    const cap = this.deps.config()?.maxWatches ?? SLACK_LIMITS.maxWatches
    if (this.list().filter(e => !oneOff(e)).length >= cap) return undefined
    const entry: SlackWatchEntry = { channel, threadTs, specialist, ...(mentionedBy && { mentionedBy }), createdAt: now, lastEventAt: now }
    this.entries.set(watchKey(channel, threadTs), entry)
    this.persist()
    return entry
  }

  /** `bind_conversation`: bind a conversation to `specialist`, opening it if need be. What is still owed follows the new binding. */
  bind(channel: string, threadTs: string, specialist: string, by?: string): SlackWatchEntry | undefined {
    const entry = this.watch(channel, threadTs, specialist, by)
    if (!entry) return undefined
    if (entry.specialist !== specialist) {
      this.deps.log(`daemon: slack-watch: ${conversationId(entry)} moved from ${entry.specialist} to ${specialist}\n`)
      entry.specialist = specialist
      this.persist()
    }
    return entry
  }

  /** Let go of a conversation. What it still owed will never be delivered now: a drop, surfaced. */
  unwatch(channel: string, threadTs: string): boolean {
    const key = watchKey(channel, threadTs)
    const pending = this.pending.get(key)
    if (pending) { clearTimeout(pending.timer); this.pending.delete(key) }
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.owed?.length) this.drop('unbound', entry, entry.owed, 'its conversation was unbound before they were delivered')
    this.entries.delete(key)
    this.persist()
    return true
  }

  /** Drop entries idle past the expiry and owed ts too old to be worth chasing. Returns how many entries went. */
  sweep(): number {
    // Runs whether or not Slack is connected: what is idle or too old expires either way.
    const cfg = this.deps.config()
    const idleExpiryMs = cfg?.idleExpiryMs ?? SLACK_LIMITS.idleExpiryMs
    const now = this.deps.now()
    const cutoff = now - idleExpiryMs
    // Chatter's conversations are cheap to open again: they go after a day, so a busy place frees its half of the table.
    const ambientCutoff = now - Math.min(idleExpiryMs, AMBIENT_IDLE_MS)
    const owedFloor = `${Math.floor(now / 1000) - OWED_MAX_AGE_S}.000000`
    let n = 0
    for (const [key, e] of this.entries) {
      // An entry still owed messages is not idle: its owed ts expire first (and are alerted), then it goes.
      if (e.lastEventAt < (e.ambient ? ambientCutoff : cutoff) && !this.pending.has(key) && !e.owed?.length) { this.entries.delete(key); n++; continue }
      // Owed to a specialist hydra.toml no longer declares, at a place catch-up no longer reads: no replay will come to
      // route it anew, so it is lost now, not a day from now. (Where catch-up still reads, the replay routes it as its
      // sender: delivered anew, or dropped then.) Not while a batch for it waits in the window: that delivery decides.
      if (e.owed?.length && cfg && e.specialist && !declaredIn(cfg.hydra, e.specialist) && !this.pending.has(key)
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
    if (n) this.persist()
    this.pruneDmCursors(now, idleExpiryMs)
    this.sweepFiles(now)
    return n
  }

  // -- catch-up support (the listener drives this) ---------------------------

  /** Newest ts seen in a channel before the current gap; where a catch-up scan starts. */
  channelCursor(channel: string): string | undefined { return this.channelCursors[channel] }

  /** Where each thread with owed messages needs refetching from. Waiters first, the oldest first: it takes the next freed place. */
  owedHints(): { channel: string; threadTs: string; fromTs: string }[] {
    const order = (e: SlackWatchEntry) => e.waitingSince ?? Infinity
    return this.list().filter(e => e.owed?.length).sort((a, b) => order(a) - order(b)).map(e => ({ channel: e.channel, threadTs: e.threadTs, fromTs: e.owed![0] }))
  }

  /** The conversations waiting for a session of `to` (current id, after renames), the oldest first. */
  waiters(isTo: (specialist: string) => boolean): SlackWatchEntry[] {
    return this.list().filter(e => e.waitingSince !== undefined && e.owed?.length && e.specialist && isTo(e.specialist)).sort((a, b) => a.waitingSince! - b.waitingSince!)
  }

  /** Catch-up can't read the thread (gone, or its channel closed to the bot): what it owed can't be fetched. A drop, surfaced; it waits no more. */
  threadGone(channel: string, threadTs: string, why: string): void {
    const e = this.get(channel, threadTs)
    if (!e?.owed?.length) return
    this.drop('expired', e, e.owed, `its thread can't be read any more (${why}), so they can never be fetched again`)
    delete e.owed
    delete e.waitingSince
    this.persist()
  }

  /** While catching up, live events must not move the cursor past the gap being filled. */
  beginCatchUp(channels: string[]): void { for (const c of channels) this.held.add(c) }
  endCatchUp(channel: string, newestTs?: string): void {
    this.held.delete(channel)
    if (newestTs) this.advance(channel, newestTs)
  }

  /**
   * Catch-up could not read everything since a channel's cursor in one pass: it read `read` messages, the oldest at
   * `oldestRead`, and moved on. What lies between the old cursor and that is not replayed. Counted and alerted like any drop.
   */
  catchUpGap(channel: string, cursor: string, oldestRead: string | undefined, read: number): void {
    const fact = `gap:${cursor}`
    if (!this.firstTime(this.noted.dropped, `${channel}:${fact}`)) return
    this.stats_.dropped['catch-up-gap'] = (this.stats_.dropped['catch-up-gap'] ?? 0) + 1
    const line = `catch-up read the newest ${read} messages in ${channel} since ${cursor} and moved on; anything between ${cursor} and ${oldestRead ?? 'them'} was not replayed, so a tag there was not delivered`
    this.deps.log(`daemon: slack-watch: ${line}\n`)
    const to = listenerOf(this.deps.config(), channel)
    this.alertOnce(`catch-up-gap:${to ?? '-'}`, to, `⚠️ Slack ${line}.`)
  }

  /** A conversation catch-up has read in full and found empty: its cursor can move at once, whatever the rest of the pass does. */
  markRead(channel: string, ts: string): void { this.held.delete(channel); this.advance(channel, ts) }

  private advance(channel: string, ts: string): void {
    const cur = this.channelCursors[channel]
    if (!cur || cmpTs(ts, cur) > 0) { this.channelCursors[channel] = ts; this.persist() }
  }

  // -- events --------------------------------------------------------------

  /**
   * One Slack `message` event. Returns what it meant; delivery, if any, happens
   * after the coalescing window.
   */
  handle(ev: SlackMessageEvent): HandleOutcome {
    const cfg = this.deps.config()
    if (!cfg) return 'ignored'
    if (!TS_RE.test(ev.ts) || (ev.threadTs !== undefined && !TS_RE.test(ev.threadTs))) return 'ignored'
    const outcome = this.classify(ev, cfg)
    // A cursor is kept only where catch-up scans: the channels hydra.toml names, and DM conversations once someone
    // admitted has written in them. A stranger's refused DM must not cost a history read on every pass.
    const scanned = isDm(ev.channel) ? outcome === 'dm' : routedChannels(cfg).includes(ev.channel)
    if (scanned && !this.held.has(ev.channel)) this.advance(ev.channel, ev.ts)
    return outcome
  }

  private classify(ev: SlackMessageEvent, cfg: SlackWatchConfig): HandleOutcome {
    if (!PLAIN_SUBTYPES.has(ev.subtype)) return 'ignored'

    const botId = cfg.botId ?? this.botId
    const own = ev.user === cfg.botUserId || (!!ev.botId && ev.botId === botId)
    if (ev.botId && !own && !placeOptions(cfg, ev.channel)?.bots) return 'ignored' // other bots are not conversation, unless the place says so
    const dm = isDm(ev.channel)
    const isReply = !!ev.threadTs && ev.threadTs !== ev.ts
    const tagged = !own && !!ev.text && tagRe(cfg.botUserId).test(ev.text)
    const at = placesOf(cfg, ev.channel)
    // A DM's top-level messages are one conversation. Anywhere else, a top-level message is its thread's first: the
    // conversation is that thread, bound when this message arrives. A thread inside a DM is a thread like any other.
    const threadTs = dm && !isReply ? TOP_LEVEL : ev.threadTs ?? ev.ts
    if (this.inflight.get(watchKey(ev.channel, threadTs))?.has(ev.ts)) return 'ignored'
    if (dm && own) return 'ignored'
    const existing = this.get(ev.channel, threadTs)

    if (own) {
      // The bot's own top-level post opens a conversation, bound to whoever listens there. Its replies are not echoed back.
      if (isReply) return 'ignored'
      const to = listenerOf(cfg, ev.channel)
      if (!to) return 'ignored'
      const entry = this.watch(ev.channel, threadTs, to)
      if (!entry) {
        this.drop('table-full', { channel: ev.channel, threadTs, specialist: to }, [ev.ts], `the conversation table is full (${cfg.maxWatches}), so the bot's own post opens no conversation and replies to it will not be delivered`)
        return 'ignored'
      }
      entry.delivered = insertTs(entry.delivered, ev.ts, DELIVERED_KEEP) // its own words are never owed to the specialist
      this.persist()
      return 'subscribed'
    }

    // A DM is addressed to the bot by being one, and so is every message in a conversation already open.
    const addressed = dm || tagged || !!existing
    if (existing?.delivered?.includes(ev.ts)) return 'ignored'
    const d = route(cfg.hydra, { from: addressOf(ev.user), at, addressed, ...(existing?.specialist && { bound: existing.specialist }) })
    if (d.fate === 'ignored') return 'ignored'
    // Refused or unrouted before anything is counted, watched or owed: a sender `allow` does not admit costs nothing.
    // Only a mention or a DM gets the 🚫: chatter in a bound thread by someone not allowed is passed over quietly.
    if (d.fate === 'unrouted' || d.fate === 'refused') {
      const why = d.fate === 'refused' ? d.why : 'no specialist hears this place'
      // Accepted earlier and still owed (a replay): losing it now is a drop, settled and surfaced, not a fresh refusal.
      if (existing?.owed?.includes(ev.ts)) {
        this.drop(d.fate, existing, [ev.ts], `it was accepted, but now ${why}`)
        this.settle(watchKey(ev.channel, threadTs), existing, [ev.ts])
        return d.fate
      }
      this.refuse(ev, threadTs, why, d.fate, dm || tagged)
      return d.fate
    }

    // The cap guards against tagging open conversations in a loop. In one already open, the same words untagged would be delivered anyway.
    if (!existing && tagged && !this.allowMention(ev, threadTs, d.to, cfg)) return 'ignored'
    // A conversation opened by untagged chatter may take only half the table: the rest stays free for mentions and DMs.
    const ambient = !existing && !tagged && !dm
    if (ambient && this.list().filter(e => e.ambient && !oneOff(e)).length >= Math.floor(cfg.maxWatches / 2)) {
      this.drop('table-full', { channel: ev.channel, threadTs, specialist: d.to }, [ev.ts], `conversations opened by untagged chatter already hold half the conversation table (${Math.floor(cfg.maxWatches / 2)} of ${cfg.maxWatches}); a tag still opens one`)
      return 'ignored'
    }
    const entry = existing ?? this.watch(ev.channel, threadTs, d.to, ev.user)
    if (!entry) {
      this.drop('table-full', { channel: ev.channel, threadTs, specialist: d.to }, [ev.ts], `the conversation table is full (${cfg.maxWatches}); unbind a conversation`)
      return 'ignored'
    }
    if (ambient) { entry.ambient = true; this.persist() }
    // A new conversation, one whose specialist is gone (routed anew), or a rename through `was`: the binding takes the current id.
    if ((d.bind || d.via === 'binding') && entry.specialist !== d.to) { entry.specialist = d.to; this.persist() }
    entry.lastEventAt = this.deps.now()
    const kind = dm ? 'dm' : tagged ? 'mention' : 'follow-up'
    this.enqueue(entry, { ts: ev.ts, user: ev.user, kind, text: ev.text ?? '', ...(ev.files?.length && { files: ev.files }) }, cfg)
    return kind
  }

  /** The DM conversations the watcher knows of: catch-up scans their history, since no config lists them. */
  dmChannels(): string[] { return [...new Set([...this.list().map(e => e.channel), ...Object.keys(this.channelCursors)].filter(isDm))] }

  /** Downloaded attachments are kept a week: long enough for the session to read them, not forever. */
  private sweepFiles(now: number): void {
    const dir = this.deps.filesDir
    if (!dir || !existsSync(dir)) return
    try {
      for (const ch of readdirSync(dir)) {
        const chDir = join(dir, ch)
        for (const f of readdirSync(chDir)) {
          const p = join(chDir, f)
          if (now - statSync(p).mtimeMs > FILE_KEEP_MS) rmSync(p, { force: true })
        }
        if (!readdirSync(chDir).length) rmSync(chDir, { recursive: true, force: true })
      }
    } catch (err) {
      this.deps.log(`daemon: slack-watch: sweeping ${dir} failed: ${err}\n`)
    }
  }

  /** Forget DM conversations quiet for longer than the idle expiry: catch-up stops scanning them. The next DM brings one back. */
  private pruneDmCursors(now: number, idleMs: number): void {
    const floor = `${Math.floor((now - idleMs) / 1000)}.000000`
    for (const [ch, ts] of Object.entries(this.channelCursors)) {
      if (isDm(ch) && cmpTs(ts, floor) < 0 && !this.list().some(e => e.channel === ch)) { delete this.channelCursors[ch]; this.persist() }
    }
  }

  /** One person tagging in a loop must not be able to keep opening watches and filling the specialist. */
  private allowMention(ev: SlackMessageEvent, threadTs: string, to: string, cfg: SlackWatchConfig): boolean {
    const user = ev.user
    if (!user) return true
    const now = this.deps.now()
    const recent = (this.mentionTimes.get(user) ?? []).filter(t => now - t < MENTION_WINDOW_MS)
    if (recent.length >= cfg.maxMentionsPer10Min) {
      this.mentionTimes.set(user, recent)
      this.drop('tag-cap', { channel: ev.channel, threadTs, specialist: to }, [ev.ts], `${user} tagged the bot ${recent.length} times in 10 minutes outside watched threads (maxMentionsPer10Min)`)
      return false
    }
    recent.push(now)
    this.mentionTimes.set(user, recent)
    return true
  }

  private enqueue(entry: SlackWatchEntry, item: Item, cfg: SlackWatchConfig): void {
    // Owed before anything is sent: a crash inside the window leaves this for catch-up to find.
    const before = entry.owed ?? []
    entry.owed = insertTs([...before], item.ts, OWED_KEEP)
    this.persist()
    const key = watchKey(entry.channel, entry.threadTs)
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

  /** `react`: a mention or a DM, whose sender sees a 🚫. A replay is neither logged, counted nor reacted to twice. */
  private refuse(ev: Pick<SlackMessageEvent, 'channel' | 'ts' | 'user' | 'botId'>, threadTs: string, why: string, fate: 'refused' | 'unrouted', react: boolean): void {
    if (!this.firstTime(this.noted.refused, `${ev.channel}:${ev.ts}`)) return
    const who = ev.user ?? 'unknown sender'
    if (fate === 'unrouted') this.stats_.unrouted++
    else { this.stats_.refused++; this.stats_.refusedBy[who] = (this.stats_.refusedBy[who] ?? 0) + 1 }
    this.deps.log(`daemon: slack-watch: ${fate} ${who} in ${ev.channel}:${threadTs} (ts ${ev.ts}): ${why}\n`)
    // The 🚫 is capped per sender like tags are: past the window, a refusal is logged and counted only.
    const sender = ev.user ?? ev.botId
    if (react && sender) {
      const now = this.deps.now()
      const recent = (this.refusalTimes.get(sender) ?? []).filter(t => now - t < MENTION_WINDOW_MS)
      if (recent.length >= (this.deps.config()?.maxMentionsPer10Min ?? SLACK_LIMITS.maxMentionsPer10Min)) react = false
      else recent.push(now)
      this.refusalTimes.set(sender, recent)
    }
    if (react && this.slack) {
      void this.slack.react(ev.channel, ev.ts, REFUSED_REACTION).catch(err => {
        const e = err instanceof Error ? err.message : String(err)
        if (!/already_reacted/.test(e)) this.deps.log(`daemon: slack-watch: 🚫 on ${ev.channel} ts ${ev.ts} failed: ${e}\n`)
      })
    }
  }

  /** A message that will never be delivered: logged every time, counted, and alerted once per episode of its kind. */
  private drop(kind: DropKind, where: Pick<SlackWatchEntry, 'channel' | 'threadTs' | 'specialist'>, ts: string[], why: string, alert = true): void {
    const fresh = ts.filter(t => this.firstTime(this.noted.dropped, `${where.channel}:${t}`))
    if (!fresh.length) return
    this.stats_.dropped[kind] = (this.stats_.dropped[kind] ?? 0) + fresh.length
    const line = `dropped ${fresh.length} Slack message${fresh.length === 1 ? '' : 's'} in ${where.channel}:${where.threadTs} (${kind}, ts ${fresh.join(', ')}): ${why}`
    this.deps.log(`daemon: slack-watch: ${line}\n`)
    // Keyed by kind and by who hears it: one specialist's trouble does not silence another's.
    const to = where.specialist ?? listenerOf(this.deps.config(), where.channel)
    if (alert) this.alertOnce(`${kind}:${to ?? '-'}`, to, `⚠️ ${line[0].toUpperCase()}${line.slice(1)}. Further ${kind} drops within the hour are logged, not alerted; \`hydra conversations\` counts them.`)
  }

  /**
   * One alert per episode. An episode is named by when it began: alerts with the same key within the hour after
   * that are its own, and are not sent; the first one after the hour starts a new episode. So a steady trickle is
   * still said once an hour, rather than never again.
   */
  private alertOnce(key: string, to: string | undefined, text: string): void {
    const now = this.deps.now()
    const began = this.episodeStart.get(key)
    if (began !== undefined && now - began < ALERT_EPISODE_GAP_MS) return
    this.episodeStart.set(key, now)
    this.deps.alert?.(text, to)
  }

  // -- names ---------------------------------------------------------------

  /** Display name for a user id, cached. A slow or failing lookup yields no name, never a delay. */
  private async nameOf(userId: string): Promise<string | undefined> {
    const resolve = this.resolveName
    if (!resolve) return undefined
    const now = this.deps.now()
    const hit = this.names.get(userId)
    if (hit && now - hit.at < (hit.name ? NAME_TTL_MS : NAME_MISS_TTL_MS)) return hit.name
    let flight = this.nameFlights.get(userId)
    if (!flight) {
      flight = Promise.race([
        resolve(userId).catch(() => undefined),
        new Promise<undefined>(res => { const t = setTimeout(() => res(undefined), NAME_TIMEOUT_MS); (t as { unref?: () => void }).unref?.() }),
      ]).then(name => { this.names.set(userId, { name, at: this.deps.now() }); return name })
        .finally(() => this.nameFlights.delete(userId))
      this.nameFlights.set(userId, flight)
    }
    return flight
  }

  // -- delivery ------------------------------------------------------------

  private flushKey(key: string, cfg: SlackWatchConfig): void {
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
      .catch(err => this.deps.log(`daemon: slack-watch: delivering ${key} failed: ${err instanceof Error ? err.stack ?? err.message : err}\n`))
    this.threadRuns.set(key, run)
    void run.finally(() => { if (this.threadRuns.get(key) === run) this.threadRuns.delete(key) })
  }

  private async deliverItems(key: string, entry: SlackWatchEntry, items: Item[], cfg: SlackWatchConfig): Promise<void> {
    try {
      await this.deliverBatches(key, entry, items, cfg)
    } finally {
      const flying = this.inflight.get(key)
      for (const i of items) flying?.delete(i.ts)
      if (flying && flying.size === 0) this.inflight.delete(key)
    }
  }

  private async deliverBatches(key: string, entry: SlackWatchEntry, items: Item[], enqueuedCfg: SlackWatchConfig): Promise<void> {
    // Where each message goes was fixed when its conversation opened: its binding. Who may reach it is read now, from the current config, so a role taken away refuses at once. Read once for
    // the whole burst, so a split burst lands in one place.
    const cfg = this.deps.config() ?? enqueuedCfg
    const h = cfg.hydra
    const declared = (to: string) => to === MAIN || !!h.specialists[to]
    const homes = new Map(items.map(i => {
      const raw = entry.specialist
      return [i.ts, raw ? currentId(h, raw) : undefined] as const
    }))
    // A specialist hydra.toml no longer declares (removed since this arrived): routed anew, now. If nothing hears the
    // place any more, it is lost: a drop, surfaced. Otherwise it stays owed, and its replay binds to whoever hears it now.
    const homeless = items.filter(i => { const to = homes.get(i.ts); return !to || !declared(to) })
    if (homeless.length) {
      // Routed anew as its sender would be now: their rules, and the operator's DM to main, count.
      const lost = homeless.filter(i => route(h, { from: addressOf(i.user), at: placesOf(cfg, entry.channel), addressed: true }).fate !== 'deliver')
      if (lost.length) {
        this.drop('unrouted', entry, lost.map(i => i.ts), 'it was accepted, but its specialist is gone and nothing that hears this place now takes it from its sender')
        this.settle(key, entry, lost.map(i => i.ts))
      }
      if (lost.length < homeless.length) this.deps.log(`daemon: slack-watch: ${key}: ${homeless.length - lost.length} message(s) were for a specialist hydra.toml no longer declares; they stay owed and are routed anew when catch-up replays them\n`)
      items = items.filter(i => !homeless.includes(i))
    }
    const senders = new Map(items.map(i => [i.ts, identify(h, addressOf(i.user))] as const))
    items = items.filter(i => {
      const why = refusal(h, homes.get(i.ts)!, senders.get(i.ts)!)
      if (!why) return true
      // Accepted, then `allow` changed while it waited: a drop, settled and surfaced.
      this.drop('refused', entry, [i.ts], `it was accepted, but now ${why}`)
      this.settle(key, entry, [i.ts])
      return false
    })
    if (!items.length) return
    // The roster names its people; Slack's display name fills in for strangers.
    const users = [...new Set(items.filter(i => !senders.get(i.ts)!.person).map(i => i.user).filter((u): u is string => !!u))]
    const resolved = new Map(await Promise.all(users.map(async u => [u, await this.nameOf(u)] as const)))
    const named = items.map(i => {
      const who = senders.get(i.ts)!
      // A Slack display name is the sender's own free text: no mentions or special links (<@U…>, <!here>), so it cannot pose as another sender.
      const slackName = i.user ? resolved.get(i.user)?.replace(/<[@!#][^>]*>/g, '') : undefined
      return { ...i, name: who.person?.name ?? slackName, ...(who.person && { person: who.person.id }), roles: who.roles, operator: who.operator }
    })
    const place = placeName(cfg, entry.channel)
    // The guard judges each message from anyone but the operator, and may send it somewhere else. Groups keep the burst's order.
    const g = h.guard
    const verdicts = await mapLimit(named, GUARD_CONCURRENCY, i => g && !i.operator ? this.judge(g, entry, place, homes.get(i.ts)!, i) : Promise.resolve<GuardVerdict>({ fate: 'deliver' }))
    const groups = new Map<string, Item[]>()
    const fallbackOf = new Map<string, string>()
    named.forEach((item, n) => {
      const v = verdicts[n]
      const home = homes.get(item.ts)!
      if (v.fate !== 'later' && entry.heldSince?.[item.ts] !== undefined) { delete entry.heldSince[item.ts]; this.persist() }
      if (v.fate === 'drop') {
        this.drop('guard', entry, [item.ts], 'the guard dropped it (exit 10)', false)
        this.settle(key, entry, [item.ts])
        return
      }
      if (v.fate === 'later') {
        // Kept owed for the next pass, for at most owed_max from the first "not now": then it fails, visibly.
        // Unless the owed list was full and already cut it.
        if (!entry.owed?.includes(item.ts)) { this.drop('owed-full', entry, [item.ts], OWED_FULL_WHY); return }
        const since = entry.heldSince?.[item.ts] ?? this.deps.now()
        if (entry.heldSince?.[item.ts] === undefined) { (entry.heldSince ??= {})[item.ts] = since; this.persist() }
        if (this.deps.now() - since > g!.owedMaxMs) {
          this.drop('expired', entry, [item.ts], `the guard said not now (exit 75) for longer than owed_max (${Math.round(g!.owedMaxMs / 60_000)} min)`)
          this.settle(key, entry, [item.ts])
          return
        }
        this.deps.log(`daemon: slack-watch: the guard said not now (exit 75) for ${key} ts ${item.ts}; it stays owed and the next catch-up pass offers it again\n`)
        return
      }
      if (v.fate === 'open') this.deps.log(`daemon: slack-watch: the guard ${v.why} for ${key} ts ${item.ts}; delivering anyway\n`)
      let to = v.fate === 'deliver' && v.to ? currentId(h, v.to) : home
      if (to !== home) {
        // A redirect does not get around `allow`: the specialist it names must admit the sender too.
        const why = refusal(h, to, senders.get(item.ts)!)
        if (why) {
          this.deps.log(`daemon: slack-watch: the guard redirected ${key} ts ${item.ts} to ${to}, but ${why}; delivering to ${home}\n`)
          // A redirect to a specialist that doesn't exist is the guard misconfigured: said once per episode, or a typo would quietly send everything to the default forever.
          if (!declared(to)) this.alertOnce(`guard-redirect:${to}`, home, `⚠️ The guard redirected a Slack message in ${place} to "${to}", which is no specialist in hydra.toml, so it went to ${home} instead. Fix the guard, or declare [specialists.${to}].`)
          to = home
        } else {
          this.deps.log(`daemon: slack-watch: the guard redirected ${key} ts ${item.ts} from ${home} to ${to}\n`)
          fallbackOf.set(to, home)
        }
      }
      groups.set(to, [...(groups.get(to) ?? []), item])
    })
    // Attachments are fetched only for what will be delivered, two messages at a time, before this thread's turn to send.
    const files = !!placeOptions(cfg, entry.channel)?.files
    for (const [to, group] of groups) groups.set(to, await mapLimit(group, 2, i => i.files?.length ? this.saveFiles(entry, i, files) : Promise.resolve(i)))
    // Only the sending is serialized across threads.
    const send = this.chain.then(async () => {
      for (const [to, group] of groups) await this.deliverGroup(key, entry, { to }, group, cfg, fallbackOf.get(to))
    })
    this.chain = send.catch(() => {})
    await send
  }

  /**
   * A message's attachments, as the session will read them: downloaded at mode 0600 under the state dir when the
   * place says `files`, otherwise listed by name. Too large, failed or not connected: listed, with why. Never a reason to hold the message.
   */
  private async saveFiles(entry: SlackWatchEntry, i: Item, enabled: boolean): Promise<Item> {
    const saved: FileRef[] = []
    for (const f of i.files ?? []) {
      const ref: FileRef = { name: f.name, ...(f.size !== undefined && { size: f.size }) }
      if (!enabled) ref.note = 'not downloaded (files is off for this place)'
      else if (!f.url) ref.note = 'not downloadable (Slack gave no download link: an external, hidden or deleted file)'
      else if (f.size !== undefined && f.size > FILE_MAX_BYTES) ref.note = `not downloaded (over ${FILE_MAX_BYTES / 1024 / 1024} MB)`
      else if (!this.slack || !this.deps.filesDir) ref.note = 'not downloaded (not connected to Slack)'
      else {
        // Keyed by the file's own id, so a file shared in several messages is fetched once.
        const dest = join(this.deps.filesDir, entry.channel, `${f.id.replace(/[^A-Za-z0-9]/g, '')}-${safeFileName(f.name)}`)
        try {
          if (!existsSync(dest)) {
            // One download per file: two messages sharing it wait on the same one, never race on one .part.
            let flight = this.downloads.get(dest)
            if (!flight) {
              flight = this.slack.download(f.url!, dest, FILE_MAX_BYTES).finally(() => this.downloads.delete(dest))
              this.downloads.set(dest, flight)
            }
            await flight
          }
          ref.path = dest
        } catch (err) {
          ref.note = `not downloaded (${err instanceof Error ? err.message : err})`
          this.deps.log(`daemon: slack-watch: downloading ${f.id} from ${entry.channel} ts ${i.ts} failed: ${ref.note}\n`)
        }
      }
      saved.push(ref)
    }
    return { ...i, saved }
  }

  /** One message's verdict from the guard. A guard that throws fails open, like one that crashes. */
  private async judge(g: Guard, entry: SlackWatchEntry, place: Place, to: string, i: Item): Promise<GuardVerdict> {
    const input: GuardInput = {
      person: i.person ?? null, roles: i.roles ?? ['anyone'], place, conversation: conversationId(entry), to,
      ...(g.includeText && { text: i.text }),
    }
    try { return await (this.deps.guard ?? runGuard)(g, input) } catch (err) {
      return { fate: 'open', why: `threw: ${err instanceof Error ? err.message : err}` }
    }
  }

  /** These ts are done with: delivered, or dropped for good. Replays of them deliver nothing. */
  private settle(key: string, entry: SlackWatchEntry, ts: string[]): void {
    if (this.entries.get(key) !== entry) return
    for (const t of ts) entry.delivered = insertTs(entry.delivered, t, Infinity)
    entry.delivered = keepDelivered(entry.delivered!, entry.owed?.filter(t => !ts.includes(t)), entry.threadTs)
    const settled = new Set(ts)
    const owed = (entry.owed ?? []).filter(t => !settled.has(t))
    if (owed.length) entry.owed = owed; else delete entry.owed
    if (entry.heldSince) { for (const t of ts) delete entry.heldSince[t]; if (!Object.keys(entry.heldSince).length) delete entry.heldSince }
    this.persist()
  }

  /** `fallback`: the binding, for a guard redirect whose specialist has no session record. A broken guard never holds a message back. */
  private async deliverGroup(key: string, entry: SlackWatchEntry, target: RouteTarget, items: Item[], cfg: SlackWatchConfig, fallback?: string): Promise<void> {
    for (const batch of packItems(items)) {
      const first = batch[0].ts
      const last = batch[batch.length - 1].ts
      const message = formatDelivery(entry, batch, { place: placeName(cfg, entry.channel), ...(cfg.workspaceUrl && { workspaceUrl: cfg.workspaceUrl }) })
      // The target is part of the key: the same messages re-routed elsewhere are a different send.
      const idempotencyKey = `slack-watch-${entry.channel}-${entry.threadTs}-${first}-${last}-${target.to}`
      let result: DeliverResult
      try { result = await this.deps.deliver({ ...target, conversation: conversationId(entry) }, message, idempotencyKey) } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!result.ok && result.wait) {
        // Not a failure: a turn. Said once an hour while it lasts, so a specialist stuck at max (no idle) is noticed.
        if (entry.waitingSince === undefined) { entry.waitingSince = this.deps.now(); this.persist() }
        this.deps.log(`daemon: slack-watch: ${key} waits: ${result.error}\n`)
        this.alertOnce(`max:${target.to}`, target.to, `⏳ ${result.error}. Its messages stay owed until then.`)
        continue
      }
      if (entry.waitingSince !== undefined) { delete entry.waitingSince; this.persist() }
      if (!result.ok && !result.permanent) {
        // Still owed: it stays in `owed`, so the catch-up pass fetches it again. Unless the owed list was full and cut it.
        this.deps.log(`daemon: slack-watch: delivery to ${target.to} failed for ${key} (${first}..${last}): ${result.error}\n`)
        if (result.exit === 8 && fallback) {
          this.deps.log(`daemon: slack-watch: the guard redirected ${key} (${first}..${last}) to ${target.to}, which has no session record; delivering to ${fallback}\n`)
          this.alertOnce(`guard-redirect:${target.to}`, fallback, `⚠️ The guard redirected a Slack message in ${placeName(cfg, entry.channel)} to "${target.to}", which has no session record (${result.error}), so it went to ${fallback} instead.`)
          await this.deliverGroup(key, entry, { to: fallback }, batch, cfg)
          continue
        }
        if (result.exit === 8) this.alertOnce(`no-such-specialist:${target.to}`, undefined, `⚠️ Slack messages in ${placeName(cfg, entry.channel)} are owed but undeliverable: ${result.error}. The conversation is bound to "${target.to}", which has no session record; check [specialists.${target.to}] in hydra.toml. They stay owed for up to a day.`)
        const cut = batch.map(i => i.ts).filter(ts => !entry.owed?.includes(ts))
        if (cut.length && this.entries.get(key) === entry) this.drop('owed-full', entry, cut, OWED_FULL_WHY)
        continue
      }
      if (!result.ok) this.drop('too-large', entry, batch.map(i => i.ts), `it can never be delivered: ${result.error}`)
      else this.ack(entry, batch, cfg)
      this.settle(key, entry, batch.map(i => i.ts))
    }
  }

  /** The sender sees the message was picked up: the place's `ack` reaction on each delivered message. Best effort, never retried. */
  private ack(entry: SlackWatchEntry, batch: Item[], cfg: SlackWatchConfig): void {
    const name = placeOptions(cfg, entry.channel)?.ack
    const slack = this.slack
    if (!name || !slack) return
    for (const i of batch) {
      void slack.react(entry.channel, i.ts, name).catch(err => {
        const why = err instanceof Error ? err.message : String(err)
        if (!/already_reacted/.test(why)) this.deps.log(`daemon: slack-watch: ack ${name} on ${entry.channel} ts ${i.ts} failed: ${why}\n`)
      })
    }
  }

  /** Deliver everything waiting now and write the store, then resolve once deliveries settle. For shutdown and tests. */
  async flush(): Promise<void> {
    const cfg = this.deps.config()
    if (cfg) for (const key of [...this.pending.keys()]) this.flushKey(key, cfg)
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
