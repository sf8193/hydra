import { route } from '../routing/route.js'
import { cmpTs, routedChannels, hearsDms, addressOf, TOP_LEVEL, type SlackFile, type SlackMessageEvent, type SlackWatchConfig, type SlackWatcher } from './slack-watch.js'

/**
 * The catch-up pass: replays into the watcher what Slack did not push while the listener
 * was down, because Socket Mode never replays. It needs only two read calls, injected as
 * `SlackApi`, so it is tested without Slack.
 *
 * What it replays, in order of importance:
 *  - the channel since its cursor, for tags that started no watch yet (the case no thread
 *    state can recover);
 *  - threads with messages still owed (a delivery failed, or a crash hit the coalescing window);
 *  - threads the channel scan shows have replies, if they are watched;
 *  - on a deep pass, every watched thread since its cursor;
 *  - DM conversations: those already known, and (with im:read) ones opened while disconnected.
 *
 * Everything goes through `watcher.handle`, which dedupes exactly, so replaying overlap is safe.
 * While a pass runs, each channel's cursor is held until the pass has read that channel. A pass that does not
 * finish leaves them held, and a DM the budget did not reach stays held: live events must not move a cursor
 * past a gap that is still open.
 */

export type RawMessage = {
  ts?: string
  thread_ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  reply_count?: number
  files?: { id?: string; name?: string; size?: number; url_private_download?: string }[]
}

export type Page = { messages: RawMessage[]; next?: string }

export type SlackApi = {
  history(a: { channel: string; oldest: string; cursor?: string }): Promise<Page>
  /** `inclusive`: the message at `oldest` itself is wanted too (an owed message starts a thread read exactly there). */
  replies(a: { channel: string; ts: string; oldest: string; inclusive: boolean; cursor?: string }): Promise<Page>
  /** The bot's DM conversations and who is on the other end (users.conversations, types=im). Optional: without it, only DMs already seen are scanned. */
  dms?(): Promise<{ channel: string; user?: string }[]>
}

/** `accepted`: messages the watcher took that it had not already handled, i.e. what the live stream did not deliver. */
export type CatchUpResult = { complete: boolean; calls: number; handled: number; accepted: number; reason?: string }

export type CatchUpOpts = {
  /** Also reread every watched thread, not just those with owed or newly active messages. */
  deep: boolean
  now: () => number
  /** API calls allowed in one pass (Slack's history and replies limits can be as low as 1 per minute). */
  maxCalls?: number
  /** Pages read for one channel scan or one thread. */
  maxPages?: number
  log: (line: string) => void
}

/** A Slack API message as the watcher's event; null when it has no usable timestamp. */
export function toEvent(channel: string, m: RawMessage): SlackMessageEvent | null {
  if (!m.ts) return null
  return {
    channel, ts: m.ts,
    ...(m.thread_ts && { threadTs: m.thread_ts }),
    ...(m.user && { user: m.user }),
    ...(m.bot_id && { botId: m.bot_id }),
    ...(m.subtype && { subtype: m.subtype }),
    ...(m.text !== undefined && { text: m.text }),
    ...(files(m).length && { files: files(m) }),
  }
}

// Every attachment is carried, even one Slack gives no download link for (external, hidden, deleted): it is listed with why.
const files = (m: RawMessage): SlackFile[] => (m.files ?? []).flatMap(f => f.id || f.name
  ? [{ id: f.id || f.name!, name: f.name || f.id!, ...(f.url_private_download && { url: f.url_private_download }), ...(typeof f.size === 'number' && { size: f.size }) }]
  : [])

/** The ts just before this one: `history`'s `oldest` is exclusive, and an owed DM message is wanted itself. */
function justBefore(ts: string): string {
  const [sec, frac = '0'] = ts.split('.')
  const v = BigInt(sec) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6)) - 1n
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`
}

let dmListFailLoggedAt = -Infinity
/** For tests: forget when the DM-listing failure was last logged. */
export function _resetCatchUpLogs(): void { dmListFailLoggedAt = -Infinity }

const nowTs = (now: number) => `${Math.floor(now / 1000)}.000000`

/** Slack's answers for a thread that doesn't exist. Anything else (a rate limit, auth) still fails the pass. */
const GONE_THREAD = /thread_not_found|message_not_found|not_in_channel|channel_not_found|is_archived/

export const MIN_CALLS = 60
/** On top of one call per wanted thread, what DM scans leave for threads the channel scans turn up. */
const THREAD_SLACK = 10
export const MAX_CALLS_CAP = 400

class OutOfBudget extends Error {}

export async function catchUp(watcher: SlackWatcher, api: SlackApi, cfg: SlackWatchConfig, opts: CatchUpOpts): Promise<CatchUpResult> {
  // One call per watched thread on a deep pass, plus the channel scan: the budget grows with the table so a big one can still finish.
  let maxCalls = opts.maxCalls ?? Math.min(MAX_CALLS_CAP, Math.max(MIN_CALLS, 2 * watcher.list().length + watcher.dmChannels().length + 20))
  const maxPages = opts.maxPages ?? 5
  let calls = 0
  let handled = 0
  let accepted = 0
  const spend = () => { if (++calls > maxCalls) throw new OutOfBudget('call budget spent') }

  const newest = new Map<string, string>()
  const newDm = new Map<string, string>()
  const note = (channel: string, ts: string) => { const cur = newest.get(channel); if (!cur || cmpTs(ts, cur) > 0) newest.set(channel, ts) }
  const feed = (channel: string, msgs: RawMessage[]) => {
    for (const m of [...msgs].sort((a, b) => cmpTs(a.ts ?? '0.0', b.ts ?? '0.0'))) {
      const ev = toEvent(channel, m)
      if (!ev) continue
      const outcome = watcher.handle(ev)
      if (outcome !== 'ignored' && outcome !== 'refused') accepted++
      handled++
    }
  }

  // Threads to reread, with where each starts. A later request for the same thread keeps the earliest start.
  const threads = new Map<string, { channel: string; threadTs: string; from: string; inclusive: boolean }>()
  const want = (channel: string, threadTs: string, from: string, inclusive = false) => {
    const key = `${channel}:${threadTs}`
    const cur = threads.get(key)
    if (!cur) { threads.set(key, { channel, threadTs, from, inclusive }); return }
    if (cmpTs(from, cur.from) < 0) { cur.from = from; cur.inclusive = inclusive } else if (cmpTs(from, cur.from) === 0) cur.inclusive ||= inclusive
  }

  const dms = hearsDms(cfg)
  const scanned = [...routedChannels(cfg), ...(dms ? watcher.dmChannels() : [])]
  watcher.beginCatchUp(scanned)
  const skipped = new Set<string>()
  const readTs: string[] = []
  try {
    // 0. DM conversations this daemon has not seen yet (one opened while it was down), with someone whose DMs are heard.
    if (dms && api.dms) {
      spend()
      const known = new Set(scanned)
      // Without im:read this fails; the DMs already seen are still scanned, so it costs a log line, not the pass.
      const listed = await api.dms().catch(err => {
        // Once an hour, not every pass: the cause (a missing im:read) does not change between passes.
        if (opts.now() - dmListFailLoggedAt >= 60 * 60_000) {
          dmListFailLoggedAt = opts.now()
          opts.log(`daemon: slack catch-up: listing DM conversations failed, scanning only those already seen: ${err instanceof Error ? err.message : err}\n`)
        }
        return []
      })
      for (const d of listed) {
        if (known.has(d.channel) || route(cfg.hydra, { from: addressOf(d.user), at: ['slack:dm'], addressed: true }).fate !== 'deliver') continue
        // A new conversation has no cursor: read it back a day, the furthest an owed message is chased.
        scanned.push(d.channel)
        watcher.beginCatchUp([d.channel])
        known.add(d.channel)
        newDm.set(d.channel, `${Math.floor(opts.now() / 1000) - 24 * 3600}.000000`)
      }
      // Each new conversation costs a read: the budget grows with them, as it does with the watch table.
      if (opts.maxCalls === undefined) maxCalls = Math.min(MAX_CALLS_CAP, maxCalls + newDm.size)
    }

    // 1. Owed messages first: they are known to be missing.
    // Owed messages follow their conversation's binding, so they are fetched wherever they are.
    // A DM conversation is one watch with no thread of its own to read: its owed messages are refetched by its history scan.
    const dmFrom = new Map<string, string>()
    for (const h of watcher.owedHints()) {
      if (h.threadTs === TOP_LEVEL) { dmFrom.set(h.channel, justBefore(h.fromTs)); continue }
      want(h.channel, h.threadTs, h.fromTs, true)
    }

    // 2. A deep pass rereads every watched thread, most recently active first. Listed before the scans so the calls
    // they need are known, and kept back from the DM scans below.
    if (opts.deep) {
      for (const e of [...watcher.list()].filter(e => e.threadTs !== TOP_LEVEL).sort((a, b) => b.lastEventAt - a.lastEventAt)) {
        const cursor = watcher.channelCursor(e.channel)
        if (cursor) want(e.channel, e.threadTs, cursor)
      }
    }

    // 3. The channel since its cursor. No cursor yet means the first run: start from now, no backfill.
    // DM conversations are not listed in the config: the ones the watcher knows of are scanned like channels. A first DM sent while disconnected cannot be found.
    // Channels first. DM conversations take what the budget has left, least recently read first: a pass that runs
    // short skips the rest (their cursors stay put, so nothing is lost) instead of failing, and the next pass starts with them.
    const routed = new Set(routedChannels(cfg))
    const order = [...scanned].sort((a, b) => {
      if (routed.has(a) !== routed.has(b)) return routed.has(a) ? -1 : 1
      const ca = watcher.channelCursor(a) ?? newDm.get(a) ?? '0.0'
      const cb = watcher.channelCursor(b) ?? newDm.get(b) ?? '0.0'
      return cmpTs(ca, cb)
    })
    for (const channel of order) {
      // Each wanted thread needs a call; a few more cover threads the channel scans turn up.
      if (!routed.has(channel) && calls >= maxCalls - threads.size - THREAD_SLACK) { skipped.add(channel); continue }
      const held = watcher.channelCursor(channel) ?? newDm.get(channel)
      const owedFrom = dmFrom.get(channel)
      const cursor = held && owedFrom ? (cmpTs(owedFrom, held) < 0 ? owedFrom : held) : held ?? owedFrom
      if (!cursor) { newest.set(channel, nowTs(opts.now())); continue }
      let page: string | undefined
      for (let i = 0; i < maxPages; i++) {
        spend()
        const res = await api.history({ channel, oldest: cursor, ...(page && { cursor: page }) })
        for (const m of res.messages) if (m.ts) { note(channel, m.ts); readTs.push(m.ts) }
        // A DM read in full and found empty moves its cursor to now, even if this pass is cut short later: there is
        // nothing in it to replay. Without that, a new one would be read back a day on every pass, and a quiet known
        // one would stay first in line and starve the rest.
        if (!routed.has(channel) && i === 0 && !res.messages.length && !res.next) { watcher.markRead(channel, nowTs(opts.now())); newDm.delete(channel) }
        feed(channel, res.messages)
        for (const m of res.messages) {
          // A thread that began during the gap and has replies may hold a tag, watched or not.
          if (m.ts && (m.reply_count ?? 0) > 0) want(channel, m.thread_ts ?? m.ts, cursor)
        }
        page = res.next
        if (!page) break
        if (i === maxPages - 1) {
          // Too much since the cursor to read in one pass. Failing the pass would hold this channel and every other
          // one forever while the gap grows, so the cursor moves to the newest message read and what was not read
          // is surfaced as a drop. (Slack returns history newest first, so the unread part is the oldest.)
          const seen = [...new Set(readTs)].sort(cmpTs)
          watcher.catchUpGap(channel, cursor, seen[0], seen.length)
          break
        }
      }
      readTs.length = 0
    }

    if (skipped.size) opts.log(`daemon: slack catch-up: ${skipped.size} DM conversation(s) left for the next pass (call budget); their cursors stay held until one reads them\n`)

    // 4. Read the threads (owed, deep, and those the scans found).
    for (const t of threads.values()) {
      let page: string | undefined
      for (let i = 0; i < maxPages; i++) {
        spend()
        let res: Page
        try {
          res = await api.replies({ channel: t.channel, ts: t.threadTs, oldest: t.from, inclusive: t.inclusive, ...(page && { cursor: page }) })
        } catch (err) {
          // One thread Slack says isn't there (a made-up or deleted ts) must not cost every other thread its pass.
          if (!GONE_THREAD.test(err instanceof Error ? err.message : String(err))) throw err
          const why = err instanceof Error ? err.message : String(err)
          opts.log(`daemon: slack catch-up: thread ${t.channel}:${t.threadTs} can't be read (${why}); skipped\n`)
          watcher.threadGone(t.channel, t.threadTs, why)
          break
        }
        // A reply's ts never moves the channel cursor: only history does. A top-level message posted after the
        // history read, and missed live, would otherwise be passed over for good.
        feed(t.channel, res.messages)
        page = res.next
        if (!page) break
        if (i === maxPages - 1) throw new OutOfBudget(`thread ${t.channel}:${t.threadTs} has more than ${maxPages} pages`)
      }
    }
  } catch (err) {
    // The cursor stays held where it was, so the next pass starts from the same place.
    const reason = err instanceof Error ? err.message : String(err)
    opts.log(`daemon: slack catch-up incomplete after ${calls} call(s): ${reason}\n`)
    return { complete: false, calls: Math.min(calls, maxCalls), handled, accepted, reason }
  }

  // A skipped DM stays held: a live event must not move its cursor past the gap no pass has read yet.
  for (const channel of scanned) if (!skipped.has(channel)) watcher.endCatchUp(channel, newest.get(channel))
  return { complete: true, calls, handled, accepted }
}
