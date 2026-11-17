/**
 * An operator's message in a specialist's own thread while no session is home there.
 *
 * The specialist hands something to the operator in its thread; the operator answers; the session has ended. The
 * answer is the specialist's, so it never goes to main. It waits here, the specialist is started by the rule
 * (ensureSpecialist: the one fill every delivery to a specialist uses, with its lock and its back-off), and the
 * message is delivered to the new session as an ordinary message in its thread.
 *
 * Held means: written to `<state>/held-for-specialist.json` before anything is tried, and retried while the specialist
 * cannot start (booting, busy, backing off after failed starts). A daemon restart keeps what is held: the daemon
 * restores it at boot (`restoreHeld`) and starts the specialist again, and the retry and the expiry run from the stored
 * times. A message is removed only once it is delivered or said to be undelivered: a start that can never succeed, or
 * one that has not succeeded after MAX_HOLD_MS, is said in the thread with what to do. A message that was delivered
 * when the daemon went down, before its removal was written, is delivered once more.
 *
 * What the operator ends ends: an explicit kill of the specialist (`session:death` with `deliberate`) drops the messages
 * waiting for its thread and says so once. A crash, a handoff, a refill, a respawn and a resumable idle end keep them.
 */
import { copyFileSync, existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { InboundMessage } from '../gateways/gateway.js'
import type { SessionInfo } from './sessions.js'
import { STATE_DIR } from './config.js'
import { ensureSpecialist, SpecialistError } from '../specialists/specialist-deliver.js'
import { specialistForThread } from '../specialists/specialists.js'
import { atomicWriteFileSync, safeSend } from './util.js'
import { on } from './event-bus.js'

export const RETRY_MS = 30_000
export const MAX_HOLD_MS = 60 * 60_000

const file = () => join(STATE_DIR, 'held-for-specialist.json')

/** Test seams: the start, the clock and the timer. */
export const specialistThreadDeps = {
  ensure: (name: string, initiator: string): Promise<SessionInfo> => ensureSpecialist(name, initiator).then(r => r.info),
  now: () => Date.now(),
  after: (ms: number, fn: () => void): void => { setTimeout(fn, ms).unref?.() },
  say: (threadId: string, text: string, replyTo?: string): Promise<unknown> => safeSend(threadId, text, replyTo ? { replyTo } : undefined),
}

type Held = { msg: InboundMessage; at: number }
/** `waiting`: a retry is scheduled (one at a time); `lastError`: why the last start failed. Only `specialist`, `items`, `told` and `lastError` are stored. */
type Hold = { specialist: string; items: Held[]; draining: boolean; waiting: boolean; told: boolean; lastError: string }

let holds = new Map<string, Hold>()
let deliver: ((msg: InboundMessage, info: SessionInfo) => Promise<void>) | undefined

/** The router says how a message lands in a started session (its ordinary thread path); restored messages land the same way. */
export function setHeldDelivery(fn: (msg: InboundMessage, info: SessionInfo) => Promise<void>): void { deliver = fn }

/** The specialist an answer is being held for in this thread, while any is (a thread's messages keep their order). */
export function holdingFor(threadId: string): string | undefined { return holds.get(threadId)?.specialist }

/** How many messages wait in this thread for its specialist to start (tests read it). */
export function heldCount(threadId: string): number { return holds.get(threadId)?.items.length ?? 0 }

/** Test seam: forget everything held, in memory and on disk. */
export function _resetHeld(): void { holds = new Map(); persist() }

/** Test seam: the daemon went down. Memory is gone; the file stays. */
export function _forgetMemory(): void { holds = new Map() }

function persist(): void {
  try {
    const out: Record<string, { specialist: string; told: boolean; lastError: string; items: Held[] }> = {}
    for (const [threadId, h] of holds) if (h.items.length) out[threadId] = { specialist: h.specialist, told: h.told, lastError: h.lastError, items: h.items }
    atomicWriteFileSync(file(), JSON.stringify(out, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: could not write the messages waiting for specialists (${file()}): ${err}\n`)
  }
}

/**
 * Boot: read what was held when the daemon last stopped and start each specialist again. Run once the gateway is up
 * (a start and a post need it). What is already held in memory is kept.
 */
export function restoreHeld(): number {
  if (!existsSync(file())) return 0
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
  } catch (err) {
    // Unreadable: set it aside before anything writes over it, and say so. Boot goes on.
    const aside = file() + '.corrupt'
    try { renameSync(file(), aside) } catch {}
    process.stderr.write(`daemon: the messages waiting for specialists could not be read (${err}); the file is kept as ${aside}, and those messages are not delivered\n`)
    return 0
  }
  let n = 0
  let bad = 0
  for (const [threadId, r] of Object.entries(raw)) {
    try {
      const e = r as { specialist: string; told: boolean; lastError: string; items: { msg: InboundMessage; at: number }[] }
      if (holds.has(threadId)) continue
      if (typeof e.specialist !== 'string' || !Array.isArray(e.items)) throw new Error('no specialist or items')
      const items = e.items.map(i => {
        const createdAt = new Date(i.msg.createdAt)
        if (typeof i.msg.id !== 'string' || typeof i.msg.channelId !== 'string' || typeof i.at !== 'number' || Number.isNaN(createdAt.getTime())) throw new Error('a message is malformed')
        return { at: i.at, msg: { ...i.msg, createdAt } }
      })
      if (!items.length) continue
      const hold: Hold = { specialist: e.specialist, items, draining: false, waiting: false, told: !!e.told, lastError: String(e.lastError ?? 'not started yet') }
      holds.set(threadId, hold)
      n += items.length
      process.stderr.write(`daemon: restored ${items.length} message(s) for specialist ${e.specialist} in thread ${threadId}\n`)
      void drain(threadId, hold)
    } catch (err) {
      bad++
      process.stderr.write(`daemon: skipped a malformed entry for thread ${threadId} in the messages waiting for specialists: ${err}\n`)
    }
  }
  // The next write replaces the file: keep the original when any entry was skipped.
  if (bad) {
    const aside = file() + '.corrupt'
    try { copyFileSync(file(), aside); process.stderr.write(`daemon: the original file is kept as ${aside}\n`) } catch {}
  }
  return n
}

/**
 * Hold `msg` for `specialist` (the one whose thread `threadId` is), start it, and deliver it to its session.
 * Messages in one thread are delivered in the order they arrived. Returns at once; the start and the delivery follow.
 */
export function holdForSpecialist(threadId: string, specialist: string, msg: InboundMessage): void {
  const hold = holds.get(threadId) ?? { specialist, items: [], draining: false, waiting: false, told: false, lastError: 'not started yet' }
  holds.set(threadId, hold)
  hold.items.push({ msg, at: specialistThreadDeps.now() })
  persist()
  // While a retry is pending the message waits for it: one retry chain per thread, one start at a time.
  if (!hold.draining && !hold.waiting) void drain(threadId, hold)
}

async function drain(threadId: string, hold: Hold): Promise<void> {
  hold.draining = true
  try {
    expire(threadId, hold)
    if (!hold.items.length) { holds.delete(threadId); persist(); return }
    // The thread may belong to another specialist now, or to none (hydra.toml changed while the messages waited).
    const owner = specialistForThread(threadId)
    if (!owner) {
      const dropped = hold.items.length
      hold.items = []
      holds.delete(threadId)
      persist()
      await tell(threadId, hold, `⚠️ This thread is no longer ${hold.specialist}'s. ${count(dropped)} not delivered. Check \`hydra specialist list\`, then send ${dropped === 1 ? 'it' : 'them'} to whoever answers here now.`)
      return
    }
    hold.specialist = owner
    let info: SessionInfo
    try {
      info = await specialistThreadDeps.ensure(hold.specialist, `thread:${threadId}`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      hold.lastError = reason
      process.stderr.write(`daemon: specialist ${hold.specialist}: could not start for a message in its thread ${threadId}: ${reason}\n`)
      // 3: refused outright (no channel to open a thread in, another session holds its name); 8: no such specialist. Waiting changes nothing.
      if (err instanceof SpecialistError && (err.exitCode === 3 || err.exitCode === 8)) {
        // Cleared before telling: a message that arrives meanwhile starts a hold of its own.
        const dropped = hold.items.length
        hold.items = []
        holds.delete(threadId)
        persist()
        await tell(threadId, hold, `⚠️ ${reason}. ${count(dropped)} not delivered. Check \`hydra specialist show ${hold.specialist}\`, then send ${dropped === 1 ? 'it' : 'them'} again.`)
        return
      }
      const first = !hold.told
      hold.told = true
      persist()
      if (first) {
        await tell(threadId, hold, `⏳ ${hold.specialist} is not running and could not be started yet: ${reason}. Messages sent here wait for it. I retry every ${RETRY_MS / 1000}s for up to ${MAX_HOLD_MS / 60_000} minutes, then say so here.`)
      }
      hold.waiting = true
      specialistThreadDeps.after(RETRY_MS, () => {
        hold.waiting = false
        if (holds.get(threadId) === hold && !hold.draining) void drain(threadId, hold)
      })
      return
    }
    // Started. What arrives while this runs joins the loop, in order. An item leaves the file only once delivered.
    while (hold.items.length) {
      const item = hold.items[0]
      try {
        if (!deliver) throw new Error('no delivery is set')
        await deliver(item.msg, info)
      } catch (err) {
        process.stderr.write(`daemon: specialist ${hold.specialist}: could not deliver a waiting message to ${info.tmuxName}: ${err}\n`)
        await tell(threadId, hold, `⚠️ ${hold.specialist} started, but your message could not be delivered to it: ${err instanceof Error ? err.message : err}. Send it again.`, item.msg.id)
      }
      hold.items.shift()
      persist()
    }
    holds.delete(threadId)
    persist()
  } finally {
    hold.draining = false
  }
}

/** An explicit kill of the session in this thread: the messages waiting for its specialist are dropped, once, and the thread is told. */
function dropOnKill(threadId: string): void {
  const hold = holds.get(threadId)
  if (!hold) return
  const dropped = hold.items.length
  hold.items = []
  holds.delete(threadId)   // an attempt already running finds nothing to deliver, and no retry is left
  persist()
  if (dropped) void tell(threadId, hold, `⚠️ ${hold.specialist} was ended on purpose, so ${count(dropped)} waiting for it not delivered. Send ${dropped === 1 ? 'it' : 'them'} again to start it, or run \`hydra spawn --specialist ${hold.specialist}\`.`)
}
on('session:death', ({ threadId, deliberate }) => { if (deliberate) dropOnKill(threadId) }, 'specialist-thread: drop the messages waiting for a specialist that was killed on purpose')

function expire(threadId: string, hold: Hold): void {
  const cutoff = specialistThreadDeps.now() - MAX_HOLD_MS
  const gone = hold.items.filter(i => i.at < cutoff)
  if (!gone.length) return
  hold.items = hold.items.filter(i => i.at >= cutoff)
  persist()
  void tell(threadId, hold, `⚠️ ${hold.specialist} did not start within ${MAX_HOLD_MS / 60_000} minutes (last error: ${hold.lastError}). ${count(gone.length)} not delivered. Fix why it will not start (\`hydra specialist show ${hold.specialist}\`), then send ${gone.length === 1 ? 'it' : 'them'} again.`)
}

const count = (n: number): string => `${n} message${n === 1 ? ' was' : 's were'}`

async function tell(threadId: string, hold: Hold, text: string, replyTo?: string): Promise<void> {
  try { await specialistThreadDeps.say(threadId, text, replyTo) } catch (err) {
    process.stderr.write(`daemon: specialist ${hold.specialist}: could not tell thread ${threadId}: ${err}\n`)
  }
}
