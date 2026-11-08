import { cmpTs, type SlackMessageEvent, type SlackWatchConfig, type SlackWatcher } from './slack-watch.js'

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
 *  - on a deep pass, every watched thread since its cursor.
 *
 * Everything goes through `watcher.handle`, which dedupes exactly, so replaying overlap is safe.
 * While a pass runs the channel cursor is held, and a pass that does not finish leaves it held:
 * live events must not move the cursor past a gap that is still open.
 */

export type RawMessage = {
  ts?: string
  thread_ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  reply_count?: number
}

export type Page = { messages: RawMessage[]; next?: string }

export type SlackApi = {
  history(a: { channel: string; oldest: string; cursor?: string }): Promise<Page>
  /** `inclusive`: the message at `oldest` itself is wanted too (an owed message starts a thread read exactly there). */
  replies(a: { channel: string; ts: string; oldest: string; inclusive: boolean; cursor?: string }): Promise<Page>
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
  }
}

const nowTs = (now: number) => `${Math.floor(now / 1000)}.000000`

export const MIN_CALLS = 60
export const MAX_CALLS_CAP = 400

class OutOfBudget extends Error {}

export async function catchUp(watcher: SlackWatcher, api: SlackApi, cfg: SlackWatchConfig, opts: CatchUpOpts): Promise<CatchUpResult> {
  // One call per watched thread on a deep pass, plus the channel scan: the budget grows with the table so a big one can still finish.
  const maxCalls = opts.maxCalls ?? Math.min(MAX_CALLS_CAP, Math.max(MIN_CALLS, 2 * watcher.list().length + 20))
  const maxPages = opts.maxPages ?? 5
  let calls = 0
  let handled = 0
  let accepted = 0
  const spend = () => { if (++calls > maxCalls) throw new OutOfBudget('call budget spent') }

  watcher.beginCatchUp()
  const newest = new Map<string, string>()
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

  try {
    // 1. Owed messages first: they are known to be missing.
    for (const h of watcher.owedHints()) want(h.channel, h.threadTs, h.fromTs, true)

    // 2. The channel since its cursor. No cursor yet means the first run: start from now, no backfill.
    for (const channel of cfg.channels) {
      const cursor = watcher.channelCursor(channel)
      if (!cursor) { newest.set(channel, nowTs(opts.now())); continue }
      let page: string | undefined
      for (let i = 0; i < maxPages; i++) {
        spend()
        const res = await api.history({ channel, oldest: cursor, ...(page && { cursor: page }) })
        for (const m of res.messages) if (m.ts) note(channel, m.ts)
        feed(channel, res.messages)
        for (const m of res.messages) {
          // A thread that began during the gap and has replies may hold a tag, watched or not.
          if (m.ts && (m.reply_count ?? 0) > 0) want(channel, m.thread_ts ?? m.ts, cursor)
        }
        page = res.next
        if (!page) break
        if (i === maxPages - 1) throw new OutOfBudget(`channel ${channel} has more than ${maxPages} pages since its cursor`)
      }
    }

    // 3. A deep pass rereads every watched thread, most recently active first.
    if (opts.deep) {
      for (const e of [...watcher.list()].sort((a, b) => b.lastEventAt - a.lastEventAt)) {
        const cursor = watcher.channelCursor(e.channel)
        if (cursor) want(e.channel, e.threadTs, cursor)
      }
    }

    // 4. Read the threads.
    for (const t of threads.values()) {
      let page: string | undefined
      for (let i = 0; i < maxPages; i++) {
        spend()
        const res = await api.replies({ channel: t.channel, ts: t.threadTs, oldest: t.from, inclusive: t.inclusive, ...(page && { cursor: page }) })
        for (const m of res.messages) if (m.ts) note(t.channel, m.ts)
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

  for (const channel of cfg.channels) watcher.endCatchUp(channel, newest.get(channel))
  return { complete: true, calls, handled, accepted }
}
