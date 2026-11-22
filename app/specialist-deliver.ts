import { registry, repointChildren, threadRegistry } from '../sessions/registry.js'
import type { SessionInfo } from '../sessions/registry.js'
import { transport } from '../sessions/bridge-transport.js'
import { backoffRefusal, reviveDeps, reviveThread, threadStub } from './recovery.js'
import { backoffClock, getBackoff } from '../infra/recovery-backoff.js'
import { occupancy, occupied } from '../sessions/session-reachability.js'
import { pushToolSurface } from '../sessions/tool-surface.js'
import { resumeIdleLimit } from '../sessions/idle-limit.js'
import { parseIdleTtl } from '../shared/constants.js'
import { conversationSpecialistOf, getSpecialist, setSpecialistThread, readKickoff, declaredInToml, specialistOf, declaredEngineOf, withTargetLock, type Specialist } from '../sessions/specialists.js'
import { safeSend } from '../infra/util.js'
import { endForFreshStart } from './session-lifecycle.js'
import { currentHydraConfig } from '../infra/hydra-config.js'
import { declaredSpecialist } from '../config/types.js'
import { gateway } from '../infra/config.js'

/** A refusal that carries the CLI exit code a caller should see. Nothing was started. */
export class SpecialistError extends Error {
  constructor(message: string, readonly exit?: number) { super(message) }
}

/** Test seam: the thread check (recovery.ts's). The spawn is `_setRecoveryDeps`, the clock recovery-backoff.ts's. */
export const specialistDeps = reviveDeps

function liveOccupant(threadId: string | undefined): SessionInfo | undefined {
  const id = threadId ? registry.getByThread(threadId) : undefined
  const info = id ? registry.get(id) : undefined
  return info && occupied(occupancy(info)) ? info : undefined
}

/**
 * `hydra spawn --specialist <name>`: start the specialist's session by hand. The same lock and the same
 * fill as a delivery's refill, but a spawn that finds the specialist already filled refuses (exit 3) instead of
 * doing nothing, and an operator's spawn is not held back by the refill back-off meant for message storms.
 */
export async function spawnSpecialist(name: string, initiator: string): Promise<{ info: SessionInfo; url: string }> {
  if (!getSpecialist(name)) throw new SpecialistError(`no such specialist: ${name}`, 8)
  return withTargetLock(name, async () => {
    const specialist = getSpecialist(name)
    if (!specialist) throw new SpecialistError(`no such specialist: ${name}`, 8)
    const live = liveOccupant(specialist.threadId)
    if (live) throw new SpecialistError(`specialist "${name}" is already filled by ${live.tmuxName} (thread ${live.threadId}); kill it first to replace it`, 3)
    return fill(name, specialist, initiator, { ignoreBackoff: true })
  })
}

/**
 * Fill a vacant specialist by the rule (reviveThread): in its thread while the platform still has it, so the
 * session resumes the conversation or reads the history; in a new thread in its channel when it is gone.
 * The kickoff is the respawn tier's prompt only, and a conversation born under another kickoff skips the resume and fork tiers
 * (reviveThread). Runs under the specialist's lock, which `set` and `rm` take too,
 * so the record read here is the one the new thread is written to. An unstored specialist (a conversation's own session)
 * is never written.
 */
async function fill(name: string, specialist: Specialist, initiator: string | undefined, opts: { ignoreBackoff?: boolean; unstored?: boolean; key?: string } = {}): Promise<{ info: SessionInfo; url: string }> {
  const key = opts.key ?? name
  // Only the specialist claims its name, but a session started under it before that rule (or left by a pointer write
  // that failed) may still hold it elsewhere. The claim would refuse on every tier: say so once, with the fix, and do
  // not count it as a failed start.
  const holder = [...registry.values()].find(i => i.tmuxName === name && i.threadId !== specialist.threadId && occupied(occupancy(i)))
  if (holder) throw new SpecialistError(`specialist "${name}": a session named ${name} is running in thread ${holder.threadId}, not the specialist's thread${specialist.threadId ? ` (${specialist.threadId})` : ''}; kill it, or point the specialist at it with 'hydra specialist set ${name} --thread ${holder.threadId}'`, 3)
  if (!opts.ignoreBackoff) {
    const refusal = backoffRefusal(key)
    if (refusal) throw new SpecialistError(`specialist "${name}": ${refusal.reason}`, 6)
  }
  const onPlatform = !!specialist.threadId && await specialistDeps.threadExists(specialist.threadId)
  if (!onPlatform && !specialist.channel) {
    throw new SpecialistError(specialist.threadId
      ? `specialist "${name}": thread ${specialist.threadId} is gone and the specialist has no channel to open a new one in`
      : `specialist "${name}" has no thread and no channel to open one in`, 3)
  }
  const thread = (specialist.threadId && threadRegistry.get(specialist.threadId)) || threadStub(specialist.threadId ?? '', name)
  const outcome = await reviveThread({
    thread,
    ...(!onPlatform && { newThreadIn: specialist.channel }),
    respawnTopic: () => {
      const kickoff = readKickoff(specialist)
      if (!kickoff) throw new Error(`the specialist has no kickoff: ${declaredInToml() ? `give [specialists.${name}] a kickoff or kickoff_file in hydra.toml` : `set one with \`hydra specialist set ${name} --kickoff-file <file>\``}`)
      return kickoff
    },
    name, model: specialist.model, declaredEngine: declaredEngineOf(specialist), ...(specialist.workdir && { cwd: specialist.workdir }),
    // Whose account the session runs under comes from this id (a conversation's own session is named `<id>_…`).
    specialist: conversationSpecialistOf(name) ?? name,
    initiator: initiator ?? `specialist:${name}`, trigger: `specialist:${name}`,
    backoffKey: key, ignoreBackoff: opts.ignoreBackoff,
  })
  if (!outcome.ok) throw new SpecialistError(`specialist "${name}": ${outcome.reason}`, outcome.busy ? 5 : 6)
  const result = outcome.result

  if (!opts.unstored && result.threadId !== specialist.threadId) {
    // The session is already running in the new thread; a failed write must not fail this delivery.
    try { setSpecialistThread(name, result.threadId) } catch (err) {
      process.stderr.write(`daemon: specialist ${name}: could not record its new thread ${result.threadId}: ${err}\n`)
    }
  }
  const info = registry.get(result.sessionId)
  if (!info) throw new Error(`specialist "${name}": spawned session ${result.sessionId} is gone before delivery`)
  const idle = specialist.idle ? parseIdleTtl(specialist.idle) : null
  if (idle) {
    // A quiet session ends: nudged, then reaped once it has been idle this long (idle-limit.ts).
    info.ephemeral = true
    info.idleTtlMs = idle
    registry.persist()
    resumeIdleLimit(info.sessionId)
  }
  // The occupant's tools depend on the specialist it now fills (see tool-surface.ts).
  if (info.adapter.channel === 'bridge') pushToolSurface(info.sessionId)
  return { info, url: result.url }
}

/**
 * `handoff_protocol = "kill_and_respawn"`: replace a specialist's live session with a fresh one in its thread, started from the kickoff,
 * with no letter. The session's conversation is marked `restartedFresh` before the kill, so no revive (this one, a refill, `resume`, boot
 * recovery, one after a daemon restart mid-swap) resumes or forks it. The fresh session is the specialist's own refill (`fill`), with
 * everything a refill gives it (its name, workdir, model, idle and tools); a per-conversation session is refilled from its specialist's
 * recipe, in its own thread. The specialist's lock is held from the kill to the spawn, as a letter handoff holds it: a delivery waits on
 * it, and an operator's message in a shared specialist's thread is held for the specialist, then lands in the fresh session. Throws
 * NotReplaced when it refuses before ending anything.
 */
/** killAndRespawn refused before ending anything: the session it was asked to replace is untouched (or already replaced). */
export class NotReplaced extends SpecialistError {}

export async function killAndRespawn(info: SessionInfo): Promise<SessionInfo> {
  const conversationOf = conversationSpecialistOf(info.tmuxName)
  const id = conversationOf ?? info.policy?.specialist ?? specialistOf(info)
  const declared = id !== undefined ? declaredSpecialist(currentHydraConfig(), id) : undefined
  if (!declared) throw new NotReplaced(`${info.tmuxName} fills no declared specialist, so it has no kickoff to restart fresh from`, 8)
  // A conversation's own session keeps its own name, and is keyed by its thread, as ensureSpecialist keys it.
  const name = conversationOf ? info.tmuxName : declared.id
  const recipe = conversationOf ? await conversationRecipe(declared.id) : undefined
  const key = conversationOf ? info.threadId : name
  return withTargetLock(key, async () => {
    if (registry.get(info.sessionId) !== info) throw new NotReplaced(`${info.tmuxName} is already being replaced (or gone)`, 5)
    const specialist = recipe ? { ...recipe, threadId: info.threadId } : getSpecialist(name)
    if (!specialist) throw new NotReplaced(`no such specialist: ${name}`, 8)
    if (!await endForFreshStart(info)) throw new NotReplaced(`${info.tmuxName} has no history entry in its thread to mark as restarted fresh, so it was left running`)
    const { info: next } = await fill(name, specialist, `specialist:${declared.id}`, { ignoreBackoff: true, unstored: !!recipe, key })
    repointChildren(info, next.sessionId)
    return next
  })
}

/**
 * Make sure the specialist has a live session now, under its lock: a live occupant is returned untouched
 * (`spawned: false`); a vacant specialist is filled once, however many callers arrive together. `unstored` is a
 * specialist that exists only as a recipe (a conversation's own session); it is never written to specialists.json.
 */
export async function ensureSpecialist(name: string, initiator?: string, unstored?: Specialist): Promise<{ info: SessionInfo; spawned: boolean }> {
  if (!unstored && !getSpecialist(name)) throw new SpecialistError(`no such specialist: ${name}`, 8)
  // An unstored specialist has no record to name its lock, so once it has a thread it is keyed by that thread: the
  // same lock and back-off a resume or handoff typed there takes.
  const lastThread = unstored ? lastThreadOf(name) : undefined
  const key = lastThread ?? name
  return withTargetLock(key, async () => {
    // Read inside the lock: an earlier caller may have moved the specialist to a fresh thread while this one waited.
    const specialist = unstored ? { ...unstored, threadId: lastThreadOf(name) ?? unstored.threadId } : getSpecialist(name)
    if (!specialist) throw new SpecialistError(`no such specialist: ${name}`, 8)
    const live = liveOccupant(specialist.threadId)
    if (live) return { info: live, spawned: false }
    const { info } = await fill(name, specialist, initiator, { unstored: !!unstored, key })
    return { info, spawned: true }
  })
}

/** The thread a session of this name lives in, or last lived in (its record is gone once it is killed or reaped). */
function lastThreadOf(name: string): string | undefined {
  const rec = registry.findByName(name)
  if (rec) return rec.threadId
  let last: { threadId: string; at: number } | undefined
  for (const t of threadRegistry.threads.values()) {
    for (const h of t.sessionHistory) {
      const at = h.endedAt ?? h.startedAt
      if (h.tmuxName === name && (!last || at > last.at)) last = { threadId: t.threadId, at }
    }
  }
  return last?.threadId
}

/** What `hydra specialist show|list` adds to the stored fields: who fills it now, and whether refills are backing off. */
export function specialistStatus(name: string): { occupant?: { session: string; connected: boolean }; refillBackoff?: { failures: number; retryInSec: number; lastError: string } } {
  const s = getSpecialist(name)
  const live = s ? liveOccupant(s.threadId) : undefined
  const b = getBackoff(name)
  const wait = b ? Math.ceil((b.nextAt - backoffClock.now()) / 1000) : 0
  return {
    ...(live && { occupant: { session: live.tmuxName, connected: transport.has(live.sessionId) } }),
    ...(b && wait > 0 && { refillBackoff: { failures: b.failures, retryInSec: wait, lastError: b.lastError } }),
  }
}

/**
 * What a per-conversation specialist's conversation sessions are made from: the specialist without its own thread (its channel, or its
 * thread's channel; its kickoff, model, and `idle`, else hydra.toml's). Undefined when no such specialist is declared.
 */
export async function conversationRecipe(to: string): Promise<Specialist | undefined> {
  const base = getSpecialist(to)
  if (!base) return undefined
  const s = currentHydraConfig().specialists[to]
  const { threadId: shared, ...recipe } = base
  // A specialist declared by its thread alone opens its conversations' threads beside it, in that thread's channel.
  if (!recipe.channel && shared) recipe.channel = await gateway.fetchChannel(shared).then(c => c.parentId ?? undefined, () => undefined)
  if (!recipe.idle && s?.idleMs) recipe.idle = `${Math.max(1, Math.round(s.idleMs / 60_000))}m`
  return recipe
}
