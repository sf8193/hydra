/**
 * Where a message goes, and how it lands: one vocabulary for the CLI, jobs, Slack and PR watch.
 *
 * A target names an address (a specialist, `main`, a thread, or one conversation's own session of a specialist) or
 * a recipe (a fresh session each time). Each resolves to a session, and every delivery lands through `deliverToSession`: occupancy decides
 * dead (3), orphaned (4) and booting (5), a session stuck on a dialog is "not now" (5), and the engine's adapter
 * carries the message. Healing a dead session is the specialist's rule (specialist-deliver.ts) or, for a thread
 * id, an explicit `revive`.
 */
import { registry, threadRegistry, type SessionInfo } from '../daemon/sessions.js'
import { transport } from '../daemon/bridge-transport.js'
import { gateway } from '../daemon/config.js'
import { occupancy, occupied, ORPHAN_GRACE_MS, bridgeWaitMs } from '../daemon/session-reachability.js'
import { confirmedStuckState } from '../daemon/pane-probe.js'
import { deliveryOutcome } from '../daemon/delivery-outcome.js'
import { checkIdempotency, clearIdempotency, registerIdempotency, DELIVER_IDEMPOTENCY_TTL_MS } from '../daemon/idempotency.js'
import { DELIVER_MAX_MESSAGE_BYTES, parseIdleTtl } from '../shared/constants.js'
import { getSpecialist, specialistForThread, withTargetLock, type Specialist } from './specialists.js'
import { currentHydraConfig } from '../daemon/hydra-config.js'
import { ensureSpecialist, SpecialistError } from './specialist-deliver.js'
import { currentRecoveryDeps, reviveThreadForDelivery } from '../daemon/recovery.js'
import type { DeliveryResult } from '../daemon/engines/engine-adapter.js'
import { isSessionThread } from '../shared/specialist-name.js'

export type Recipe = { channel: string; kickoff?: string; kickoffFile?: string; model?: string; idle?: string }
export type Target =
  | { to: string; revive?: boolean }   // a specialist name, "main", or a thread id
  | { spawn: Recipe }
  /**
   * `sessions = "per-conversation"`: the conversation's own session, made from the specialist's recipe and never stored,
   * at most hydra.toml's `max` at once (past that: exit 5 with `atMax`).
   */
  | { perConversation: string; conversation: string }
export type DeliverOutcome =
  /** `duplicate`: this idempotency key already landed; a sender counts it as sent (the CLI's exit 2). */
  | { ok: true; sessionName: string; threadId: string; revived: boolean; sessionId: string; status: 'delivered' | 'queued'; proof?: string; duplicate?: true; specialist?: string }
  /** 3 gone/refused, 4 orphaned, 5 not now (booting, busy, or stuck), 6 backing off or failed, 7 a delivery with this key
   *  is still in flight, 8 no such specialist. `permanent`: this message can never be delivered (too large); drop it,
   *  alert, never retry. */
  /** `atMax`: a per-conversation specialist already runs `max` sessions; this conversation waits its turn (exit 5). */
  | { ok: false; exit: 3 | 4 | 5 | 6 | 7 | 8; reason: string; permanent?: true; atMax?: true }

/** `lowPriority`: an engine where every delivery is a priced turn (Codex) may hold it for the next turn. `wanted`: a sender
 *  that can withdraw (a PR watch ended by a kill), asked under the thread's lock just before a revive; false is exit 3. */
export type DeliverOpts = { initiator: string; idempotencyKey?: string; idempotencyTtlMs?: number; queue?: boolean; source?: string; lowPriority?: boolean; wanted?: () => boolean }

/** Test seam: pane-probe's verdict that a session sits on a dialog or prompt. */
export const targetDeps = { stuckState: confirmedStuckState }

/** `to` resolves in this order: `main`, a declared specialist, an all-digit thread id; anything else is no such specialist. */
export function resolveTo(to: string): { kind: 'main' } | { kind: 'specialist'; name: string } | { kind: 'thread'; threadId: string } | { kind: 'unknown' } {
  if (to === 'main') return { kind: 'main' }
  if (getSpecialist(to)) return { kind: 'specialist', name: to }
  if (isSessionThread(to)) return { kind: 'thread', threadId: to }
  return { kind: 'unknown' }
}

/**
 * A conversation's own session: `<specialist>_<conversation>`, lowercased (`crm` + `slack:C0X:17.01` → `crm_c0x-17-01`).
 * The `_` is a character no specialist name may hold, so no such name is ever a specialist's, and every one of a
 * specialist's conversation sessions starts with `<specialist>_`.
 */
export function conversationSessionName(specialist: string, conversation: string): string {
  return `${specialist}_${conversation.replace(/^slack:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function parseRecipe(raw: unknown, where: string): Recipe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: a recipe is a table: { channel, kickoff | kickoffFile, model, idle }`)
  const r = raw as Record<string, unknown>
  const known = new Set(['channel', 'kickoff', 'kickoffFile', 'model', 'idle'])
  for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`${where}: unknown recipe field "${k}"`)
  if (typeof r.channel !== 'string' || !r.channel) throw new Error(`${where}: channel is required`)
  for (const k of ['kickoff', 'kickoffFile', 'model', 'idle'] as const) {
    if (r[k] !== undefined && typeof r[k] !== 'string') throw new Error(`${where}: ${k} must be a string`)
  }
  if (!r.kickoff && !r.kickoffFile) throw new Error(`${where}: kickoff or kickoffFile is required`)
  if (r.idle !== undefined && parseIdleTtl(r.idle as string) === null) throw new Error(`${where}: idle "${r.idle}" is not a duration like 30m, 4h or 1d (at most 7d)`)
  return r as Recipe
}

/** Exactly one of `to`, `spawn`. Throws a message naming `where`. A conversation's own session is routing's to name, never a config's. */
export function parseTarget(raw: unknown, where: string): Target {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: a target is { to } or { spawn }`)
  const r = raw as Record<string, unknown>
  const kinds = (['to', 'spawn'] as const).filter(k => r[k] !== undefined)
  if (kinds.length !== 1) throw new Error(`${where}: give exactly one of to, spawn (got ${kinds.length ? kinds.join(', ') : 'none'})`)
  if (kinds[0] === 'to') {
    if (typeof r.to !== 'string' || !r.to.trim()) throw new Error(`${where}: to must be a specialist name, "main" or a thread id`)
    if (r.revive !== undefined && typeof r.revive !== 'boolean') throw new Error(`${where}: revive must be true or false`)
    return { to: r.to.trim(), ...(r.revive === true && { revive: true }) }
  }
  if (r.revive !== undefined) throw new Error(`${where}: revive goes with to`)
  return { spawn: parseRecipe(r.spawn, `${where}.spawn`) }
}

/**
 * Land one message on a session. The occupancy exits apply unless `queue` (a revived or booting session's bridge
 * flushes the queue when it connects); a session stuck on a dialog or prompt is never a landing.
 */
export async function deliverToSession(info: SessionInfo, text: string, opts: { initiator?: string; queue?: boolean; source?: string; meta?: Record<string, string>; lowPriority?: boolean }): Promise<
  | { ok: true; status: 'delivered' | 'queued'; proof?: string }
  | { ok: false; exit: 3 | 4 | 5 | 6; reason: string }
> {
  const occ = occupancy(info)
  if (occ === 'dead' || occ === 'none') return { ok: false, exit: 3, reason: `${info.tmuxName} is gone — revive it (deliver --revive, or resume in its thread)` }
  if (occ === 'orphaned' && !opts.queue) return { ok: false, exit: 4, reason: `${info.tmuxName} is orphaned (running, bridge not connected) — resume it in its thread, or kill it to restart` }
  if (occ === 'starting' && !opts.queue) return { ok: false, exit: 5, reason: `${info.tmuxName} is still booting — retry in ~${Math.max(1, Math.ceil((ORPHAN_GRACE_MS - bridgeWaitMs(info.createdAt)) / 1000))}s` }
  if (occ === 'reachable') {
    const stuck = targetDeps.stuckState(info.tmuxName)
    if (stuck) return { ok: false, exit: 5, reason: `stuck: ${stuck.kind}` }
  }

  const notification = {
    type: 'notification' as const, content: text,
    meta: { source: opts.source ?? 'cli-deliver', ...(opts.initiator && { initiator: opts.initiator }), ...opts.meta },
    ...(opts.lowPriority && { lowPriority: true }),
  }
  let result: DeliveryResult
  try {
    result = await info.adapter.deliver(info, notification)
  } catch (err) {
    result = { status: 'unknown', reason: String(err) }
  }
  const outcome = deliveryOutcome(result, !!opts.queue)
  if (!outcome.ok) return { ok: false, exit: outcome.exitCode === 6 ? 6 : 3, reason: outcome.error }
  // Queued behind a session that died after it was chosen: nobody will drain that queue.
  if (outcome.status === 'queued' && occupancy(info) === 'dead') return { ok: false, exit: 6, reason: `${info.tmuxName} died during delivery` }
  return { ok: true, status: outcome.status, proof: outcome.proof }
}

/** Deliver to a target, healing it by its rule. */
export function deliverToTarget(t: Target, text: string, opts: DeliverOpts): Promise<DeliverOutcome> {
  return deliverVia(() => route(t, text, opts), text, opts)
}

/**
 * The size cap and the idempotency key around one delivery: the key is reserved while in flight and kept only on a
 * landing. `land` resolves the address and lands the message.
 */
export async function deliverVia(land: () => Promise<DeliverOutcome>, text: string, opts: DeliverOpts): Promise<DeliverOutcome> {
  const bytes = Buffer.byteLength(text)
  if (bytes > DELIVER_MAX_MESSAGE_BYTES) return { ok: false, exit: 3, reason: `message too large (${bytes} bytes, max ${DELIVER_MAX_MESSAGE_BYTES})`, permanent: true }

  const key = opts.idempotencyKey
  const ttl = opts.idempotencyTtlMs ?? DELIVER_IDEMPOTENCY_TTL_MS
  if (key) {
    const check = checkIdempotency(key)
    if (check.blocked && check.entry.status === 'pending') return { ok: false, exit: 7, reason: `delivery with key "${key}" still in flight — retry shortly` }
    if (check.blocked) {
      const s = registry.get(check.entry.sessionId)
      return { ok: true, duplicate: true, status: 'delivered', revived: false, sessionId: check.entry.sessionId, sessionName: s?.tmuxName ?? check.entry.sessionId, threadId: s?.threadId ?? '' }
    }
    // Reserved without a session id, so a death's bookkeeping can't claim an in-flight key. Never shorter than the
    // default: a short TTL that lapsed mid-delivery would let a retry deliver a second time.
    registerIdempotency(key, '', Math.max(ttl, DELIVER_IDEMPOTENCY_TTL_MS), 'pending')
  }
  const r = await land().catch((err): DeliverOutcome => ({
    ok: false, exit: err instanceof SpecialistError && isExit(err.exitCode) ? err.exitCode : 6, reason: err instanceof Error ? err.message : String(err),
  }))
  if (key) {
    if (r.ok) registerIdempotency(key, r.sessionId, ttl, 'completed')
    else clearIdempotency(key)
  }
  return r
}

const isExit = (n: unknown): n is 3 | 4 | 5 | 6 | 8 => n === 3 || n === 4 || n === 5 || n === 6 || n === 8

async function route(t: Target, text: string, opts: DeliverOpts): Promise<DeliverOutcome> {
  if ('spawn' in t) {
    const info = await spawnFresh(t.spawn, opts.initiator)
    return land(info, text, { ...opts, queue: true }, true)
  }
  if ('perConversation' in t) return toConversation(t.perConversation, t.conversation, text, opts)

  const to = resolveTo(t.to)
  switch (to.kind) {
    case 'main': return toMain(text, opts)
    case 'specialist': return toSpecialist(to.name, text, opts)
    case 'unknown': return { ok: false, exit: 8, reason: `no such specialist: ${t.to}` }
    case 'thread': return toThread(to.threadId, text, opts, !!t.revive)
  }
}

/** A thread id: whoever is in it. `revive` heals it first (a specialist's thread as that specialist), and always queues. */
export async function toThread(threadId: string, text: string, opts: DeliverOpts, revive: boolean): Promise<DeliverOutcome> {
  // A specialist's thread revives as the specialist: its name, its kickoff for a fresh start, its back-off.
  const owner = revive ? specialistForThread(threadId) : undefined
  if (owner) return toSpecialist(owner, text, opts)
  let revived = false
  if (revive) {
    const r = await reviveThreadForDelivery(threadId, opts.initiator, opts.wanted)
    if (!r.ok) return { ok: false, exit: r.exitCode, reason: r.reason }
    revived = r.revived
  }
  const info = occupantOf(threadId)
  if (!info) return { ok: false, exit: 3, reason: threadRegistry.get(threadId) ? `thread ${threadId}'s session is gone — deliver --revive to restart it` : `thread ${threadId} not found` }
  return land(info, text, { ...opts, queue: opts.queue || revive }, revived)
}

/** A session by name or id (`deliver --session`): never healed. */
export async function toSession(info: SessionInfo, text: string, opts: DeliverOpts): Promise<DeliverOutcome> {
  return land(info, text, opts, false)
}

async function land(info: SessionInfo, text: string, opts: DeliverOpts, revived: boolean, specialist?: string): Promise<DeliverOutcome> {
  const r = await deliverToSession(info, text, { ...opts, ...(specialist && { meta: { specialist } }) })
  if (!r.ok) return r
  return { ok: true, status: r.status, ...(r.proof && { proof: r.proof }), sessionId: info.sessionId, sessionName: info.tmuxName, threadId: info.threadId, revived, ...(specialist && { specialist }) }
}

/** `main` (the platform's byte) has no registry record, is reached by its bridge id, and is never revived: `hydra up` owns it.
 *  Its queue is in memory and does not survive a daemon restart. */
function toMain(text: string, opts: DeliverOpts): DeliverOutcome {
  const connected = transport.has('main')
  if (!connected && !opts.queue) return { ok: false, exit: 4, reason: 'main not connected — use --queue to queue for later' }
  transport.sendOrQueue('main', { type: 'notification', content: text, meta: { source: opts.source ?? 'cli-deliver', ...(opts.initiator && { initiator: opts.initiator }) } })
  return { ok: true, status: connected ? 'delivered' : 'queued', sessionId: 'main', sessionName: 'main', threadId: '', revived: false }
}

/** A live session under this name, the live one first: a dead predecessor's record may still be listed before it. */
const liveNamed = (name: string): SessionInfo | undefined => [...registry.values()].find(i => i.tmuxName === name && occupied(occupancy(i)))

/** The names a conversation's session may run under: the specialist's current id, then its old ones (`was`). */
function conversationNames(to: string, conversation: string): string[] {
  return [to, ...(currentHydraConfig().specialists[to]?.was ?? [])].map(id => conversationSessionName(id, conversation))
}

/** Whether this conversation's own session is running now (under the current id or an old one). */
export const conversationSessionRunning = (to: string, conversation: string): boolean => conversationNames(to, conversation).some(n => !!liveNamed(n))

/** A conversation's running session gets the message, as a specialist's would: queued, unless it is orphaned (exit 4). */
function landRunning(info: SessionInfo, text: string, opts: DeliverOpts): Promise<DeliverOutcome> | DeliverOutcome {
  if (occupancy(info) === 'orphaned') return { ok: false, exit: 4, reason: `${info.tmuxName} is orphaned (running, bridge not connected) — hydra kill ${info.tmuxName} to restart it` }
  return land(info, text, { ...opts, queue: true }, false, info.tmuxName)
}

/** How many more conversation sessions `to` may start now: `max` less those running and those starting. Infinity without a max. */
export function placesFree(to: string): number {
  const s = currentHydraConfig().specialists[to]
  if (!s) return Infinity
  const prefixes = [to, ...s.was].map(id => `${id}_`)
  const live = new Set([...registry.values()].filter(i => prefixes.some(p => i.tmuxName.startsWith(p)) && occupied(occupancy(i))).map(i => i.tmuxName))
  const starting = [...(reserved.get(to)?.keys() ?? [])].filter(n => !live.has(n)).length
  return Math.max(0, s.max - live.size - starting)
}

/** Cold spawns decided but not yet settled, per specialist: they count against `max` like a running session. */
const reserved = new Map<string, Map<string, number>>()
const reserve = (to: string, name: string, by: 1 | -1) => {
  const r = reserved.get(to) ?? new Map<string, number>()
  const n = (r.get(name) ?? 0) + by
  if (n > 0) r.set(name, n); else r.delete(name)
  if (r.size) reserved.set(to, r); else reserved.delete(to)
}

/**
 * A conversation's own session of a per-conversation specialist, healed by the rule under its own name: the specialist's
 * recipe (kickoff, model, channel or its thread's channel, its idle else hydra.toml's), a fresh thread, never stored.
 * At most `max` run at once, counted from the sessions running under the specialist's names (`<id>_…`, and an old id's
 * through `was`) plus the cold spawns already decided. Only that decision takes the specialist's lock: a conversation
 * whose session runs goes straight to it, and the spawn and the landing happen outside, so one slow start holds up no one else.
 */
async function toConversation(to: string, conversation: string, text: string, opts: DeliverOpts): Promise<DeliverOutcome> {
  const base = getSpecialist(to)
  if (!base) return { ok: false, exit: 8, reason: `no such specialist: ${to}` }
  const s = currentHydraConfig().specialists[to]
  const names = conversationNames(to, conversation)
  const { threadId: shared, ...recipe } = base
  // A specialist declared by its thread alone opens its conversations' threads beside it, in that thread's channel.
  if (!recipe.channel && shared) recipe.channel = await gateway.fetchChannel(shared).then(c => c.parentId ?? undefined, () => undefined)
  if (!recipe.idle && s?.idleMs) recipe.idle = `${Math.max(1, Math.round(s.idleMs / 60_000))}m`
  // Running already: straight to that very session (a name lookup could find a dead predecessor's record first).
  const live = names.map(liveNamed).find(Boolean)
  if (live) return landRunning(live, text, opts)

  const decided = await withTargetLock(`max:${to}`, async (): Promise<{ name: string } | { live: SessionInfo } | DeliverOutcome> => {
    const now = names.map(liveNamed).find(Boolean)
    if (now) return { live: now }
    if (s) {
      const prefixes = [to, ...s.was].map(id => `${id}_`)
      const live = [...registry.values()].filter(i => prefixes.some(p => i.tmuxName.startsWith(p)) && occupied(occupancy(i))).map(i => i.tmuxName)
      const pending = [...(reserved.get(to)?.keys() ?? [])].filter(n => n !== names[0] && !live.includes(n))
      const n = new Set(live).size + pending.length
      if (n >= s.max) {
        return { ok: false, exit: 5, atMax: true, reason: `${to} already runs ${n} conversation session${n === 1 ? '' : 's'} (max ${s.max}); ${conversation} waits for one to end${s.idleMs ? '' : ', and none ends on its own: give the specialist an idle'}` }
      }
    }
    reserve(to, names[0], 1)
    return { name: names[0] }
  })
  if ('ok' in decided) return decided
  if ('live' in decided) return landRunning(decided.live, text, opts)
  try {
    return await toSpecialist(decided.name, text, opts, recipe)
  } finally {
    reserve(to, decided.name, -1)
  }
}

/** A specialist always queues: whoever is home (or is filled now, by the rule) gets it once its bridge is up. */
async function toSpecialist(name: string, text: string, opts: DeliverOpts, unstored?: Specialist): Promise<DeliverOutcome> {
  const { info, spawned } = await ensureSpecialist(name, opts.initiator, unstored)
  if (!spawned && occupancy(info) === 'orphaned') {
    return { ok: false, exit: 4, reason: `specialist "${name}": ${info.tmuxName} is orphaned (running, bridge not connected) — hydra kill ${name} to restart it` }
  }
  return land(info, text, { ...opts, queue: true }, spawned, name)
}

function occupantOf(threadId: string): SessionInfo | undefined {
  const id = registry.getByThread(threadId)
  return id ? registry.get(id) : undefined
}

async function spawnFresh(r: Recipe, initiator: string): Promise<SessionInfo> {
  const kickoff = r.kickoffFile ? (await Bun.file(r.kickoffFile).text()).trim() : r.kickoff!
  const idle = r.idle ? parseIdleTtl(r.idle) : null
  const result = await currentRecoveryDeps().doSpawnSession(kickoff, r.channel, undefined, {
    initiator, ...(r.model && { model: r.model }), ...(idle && { ephemeral: true, idleTtlMs: idle }),
  })
  const info = registry.get(result.sessionId)
  if (!info) throw new Error(`spawned session ${result.sessionId} is gone before delivery`)
  return info
}

/**
 * The session a verb (`status`, `kill`, `peek`, `attach`) names: a session name or id (a live one first), a
 * specialist's name (whoever is in its thread), or a thread id (whoever is in it).
 */
export function sessionByName(raw: string): SessionInfo | undefined {
  const named = [...registry.values()].filter(s => s.tmuxName === raw || s.sessionId === raw)
  const live = named.find(s => occupancy(s) !== 'dead')
  if (live ?? named[0]) return live ?? named[0]
  const s = getSpecialist(raw)
  if (s?.threadId) return occupantOf(s.threadId)
  return occupantOf(raw)
}
