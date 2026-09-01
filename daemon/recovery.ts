// Post-reboot / crash recovery engine — extracted from commands/global.ts so the commands
// layer stays a thin orchestration shell and the worktree-manager/pr-watch imports live at the
// lifecycle layer (alongside session-lifecycle) rather than crossing into commands.
//
// Manual `recover [name]` (handleRecoverIntercept, router-dispatched) and automatic post-reboot
// recovery (autoRecoverAfterBoot, boot-wired in daemon.ts) share the recoverOne cascade,
// work-key dedup, and the single-flight guard here.
import { existsSync } from 'fs'
import { gateway, DEFAULT_SESSION_CHANNEL } from './config.js'
import { registry, sessionEmoji, threadRegistry } from './sessions.js'
import type { ThreadMetadata, SessionInfo } from './sessions.js'
import { doSpawnSession, tryResume, tryRespawn, RECOVERY_REVERIFY_GUARD } from './session-lifecycle.js'
import { tmuxHasSession, isAlive, safeSend, baseNameFromBranch } from './util.js'
import { parsePrUrl, getWatchesBySession, restoreWatches, unwatchBySession } from './pr-watch.js'
import type { WatchEntry } from './pr-watch.js'
import { checkUnpushedCommits, reattachWorktree } from './worktree-manager.js'
import { loadAccess } from './access.js'
import type { InboundMessage } from '../gateway.js'

// ---------------------------------------------------------------------------
// Recover — crash recovery via resume or resurrect
// ---------------------------------------------------------------------------

let recoveryInProgress = false
const MAX_CONCURRENT = 2
const STAGGER_MS = 5_000

// Dead, recoverable sessions for the manual `recover` command. Broader than the
// auto-recover filter (which is thread_owner-only + excludes parked/ephemeral/headless):
// a user may deliberately recover any dead non-guest session. Codex is excluded — the
// recoverOne cascade would relaunch it as Claude (codex reconnects via its own path).
function findDeadSessions(): SessionInfo[] {
  return [...registry.values()].filter(info =>
    info.sessionType !== 'thread_guest'
    && info.engine !== 'codex'
    // suppressAutoRecover intentionally NOT checked — it gates only AUTOMATIC boot recovery
    // (parked awaiting_pm / branch-gone); an explicit manual `recover` overrides it.
    && !isAlive(info)
    && threadRegistry.has(info.threadId),
  )
}

// Map a dead SessionInfo to recoverOne's input (thread metadata resolved from the
// registry; guaranteed present since callers filter on threadRegistry.has).
function toRecoverInput(info: SessionInfo, siblingWatches?: WatchEntry[]) {
  return {
    sessionId: info.sessionId,
    thread: threadRegistry.get(info.threadId)!,
    claudeSessionId: info.claudeSessionId,
    lastTmuxName: info.tmuxName,
    model: info.sessionMetadata?.model,
    siblingWatches,
  }
}

async function recoverOne(dead: { sessionId?: string; thread: ThreadMetadata; claudeSessionId?: string; lastTmuxName: string; model?: string; siblingWatches?: WatchEntry[] }): Promise<{ name: string; method: 'resumed' | 'forked' | 'resurrected'; newName: string; threadUrl?: string } | { name: string; method: 'failed'; reason: string; threadUrl?: string }> {
  const { thread, claudeSessionId, lastTmuxName, model } = dead

  // Capture everything off the dead record up front: tier 1's kill deletes it, so the
  // fallback tiers (and post-cascade watch restore) can't read it later. Resolve by the
  // caller's exact sessionId when known (avoids a second, possibly-stale threadId→session
  // map lookup); fall back to getByThread only for callers that don't pass it.
  const deadInfo = (dead.sessionId ? registry.get(dead.sessionId) : undefined)
    ?? registry.get(registry.getByThread(thread.threadId) ?? '')
  const worktree = deadInfo?.worktreeRepo && deadInfo.worktreePath
    ? { repo: deadInfo.worktreeRepo, path: deadInfo.worktreePath, branch: deadInfo.worktreeBranch ?? `wt/${deadInfo.tmuxName}` }
    : undefined
  const carryOver = deadInfo
    ? { artifacts: deadInfo.artifacts, contextLinks: deadInfo.contextLinks, description: deadInfo.description }
    : undefined
  // Snapshot PR watches with their seen-cursors before any kill unwatches them; the
  // cascade recreates the session under a new id, so restore them onto the survivor.
  // siblingWatches: watches from dead sessions deduped away against this winner, so
  // a watch owned by the skipped session isn't stranded on a never-revived record.
  const savedWatches = [...(deadInfo ? getWatchesBySession(deadInfo.sessionId) : []), ...(dead.siblingWatches ?? [])]
  const restoreOnto = (r: { sessionId: string; threadId: string }): void => {
    if (savedWatches.length > 0) {
      const n = restoreWatches(savedWatches, r.sessionId, r.threadId)
      if (n > 0) process.stderr.write(`daemon: recover ${lastTmuxName}: restored ${n} PR watch(es) onto ${r.sessionId}\n`)
    }
  }

  // Resolve worktree availability BEFORE the cascade so a recovered agent is NEVER spawned
  // into the shared main checkout (spawnCwd). If the dir is gone: reattach it; if that's
  // transiently impossible, defer to next boot; if the branch is truly gone, skip and mark
  // so we don't retry every boot. Only proceed to the cascade once the worktree dir exists
  // (or the session never had a worktree).
  if (worktree && !existsSync(worktree.path)) {
    const st = await reattachWorktree(worktree.repo, worktree.path, worktree.branch)
    if (st === 'failed') {
      // Transient (stale registration, lock, FS/repo hiccup) — branch preserved. Leave the
      // dead record untouched (no kill, no spawn) so the next boot retries the reattach.
      process.stderr.write(`daemon: recover ${lastTmuxName}: worktree ${worktree.path} reattach failed transiently — deferring to next boot\n`)
      return { name: lastTmuxName, method: 'failed', reason: `worktree temporarily unavailable (${worktree.branch}) — deferred to next boot`, threadUrl: thread.threadUrl }
    }
    if (st === 'branch-gone' && deadInfo) {
      // Worktree dir AND branch both gone (typically merged + pruned). Don't revive into
      // the main checkout; mark suppressAutoRecover so it isn't retried every boot, and
      // surface it so the operator can manually recover the thread if still needed.
      deadInfo.suppressAutoRecover = true
      // Terminal (branch gone ⇒ never revived): drop its PR watches. They'd otherwise linger
      // frozen forever — pollPr skips dead-owner watches, so they can never self-unwatch on
      // merge. The branch is gone (PR merged/pruned), so the watch is dead weight anyway.
      unwatchBySession(deadInfo.sessionId)
      registry.persist()
      process.stderr.write(`daemon: recover ${lastTmuxName}: worktree + branch ${worktree.branch} gone — skipping auto-recovery (manual recover still available)\n`)
      return { name: lastTmuxName, method: 'failed', reason: `worktree + branch gone (${worktree.branch}, likely merged/pruned) — not auto-revived`, threadUrl: thread.threadUrl }
    }
    // 'attached' → dir now exists; fall through to the cascade.
  }

  const commonOpts = { preserveWorktree: true, reuseWorktree: worktree, carryOver, promptPrefix: RECOVERY_REVERIFY_GUARD }

  // Reserve the predecessor's name for the whole cascade so a concurrent spawn can't grab
  // it (freed when the dead record is killed) and `branch -D` the worktree branch we're
  // preserving. Reserve the branch's BASE name — the exact token pickSessionName derives
  // and createWorktree's stale `branch -D wt/<name>` targets. tmuxName ≠ base after a prior
  // recovery (fresh tmuxName, preserved old worktreeBranch), so reserving tmuxName would
  // protect the wrong token and leave the base pickable; parse the branch to match.
  // finally guarantees release on every exit (success, throw, total-failure); once the
  // survivor's record persists its worktreeBranch, pickSessionName's reservation takes over.
  // `deadInfo!` is safe: `worktree` is only truthy when it was built from
  // `deadInfo.worktreeRepo && deadInfo.worktreePath` above, so a truthy `worktree`
  // guarantees a non-null `deadInfo`.
  const reservedName = worktree
    ? (worktree.branch.startsWith('wt/') ? baseNameFromBranch(worktree.branch) : deadInfo!.tmuxName)
    : undefined
  if (reservedName) registry.reservedNames.add(reservedName)
  try {
    if (claudeSessionId) {
      // Tier 1: full resume
      const result = await tryResume({ topic: thread.topic, threadId: thread.threadId, claudeSessionId, threadUrl: thread.threadUrl, model, worktree, preserveWorktree: true })
      if (result) {
        restoreOnto(result)
        return { name: lastTmuxName, method: 'resumed', newName: result.name, threadUrl: thread.threadUrl }
      }
      process.stderr.write(`daemon: recover ${lastTmuxName}: resume failed, trying fork-from-dead\n`)

      // Tier 2: fork from dead session (best-effort, short timeout)
      try {
        const forkResult = await doSpawnSession(thread.topic, undefined, undefined, {
          ...commonOpts,
          existingThreadId: thread.threadId,
          forkFrom: { claudeSessionId, parentName: lastTmuxName },
          model,
        })
        restoreOnto(forkResult)
        return { name: lastTmuxName, method: 'forked', newName: forkResult.name, threadUrl: thread.threadUrl }
      } catch {
        process.stderr.write(`daemon: recover ${lastTmuxName}: fork failed, falling back to resurrect\n`)
      }
    }

    // Tier 3: respawn
    const result = await tryRespawn(thread.threadId, thread.topic, lastTmuxName, model, commonOpts)
    if (result) {
      restoreOnto(result)
      return { name: lastTmuxName, method: 'resurrected', newName: result.name, threadUrl: thread.threadUrl }
    }

    // Total failure: doSpawnSession deleted the dead record + its watches early (before
    // the spawn failed), and no survivor exists to restore onto. Re-persist the record
    // (still deadAt) + its watches so manual recovery stays possible and the next boot
    // can retry — otherwise a transient boot glitch would permanently erase metadata.
    // Gate on the THREAD having no owner (not the old sessionId): a fallback tier may
    // have created a new record + claimed the thread before throwing — re-persisting
    // then would clobber that live record's routing and orphan it.
    if (deadInfo && registry.getByThread(thread.threadId) === undefined) {
      deadInfo.deadAt = deadInfo.deadAt ?? Date.now()
      registry.set(deadInfo.sessionId, deadInfo)
      registry.setThread(deadInfo.threadId, deadInfo.sessionId)
      if (savedWatches.length > 0) restoreWatches(savedWatches, deadInfo.sessionId, deadInfo.threadId)
      registry.persist()
      process.stderr.write(`daemon: recover ${lastTmuxName}: all tiers failed — restored dead record + ${savedWatches.length} watch(es) for manual retry\n`)
    }
    return { name: lastTmuxName, method: 'failed', reason: 'all recovery methods failed', threadUrl: thread.threadUrl }
  } finally {
    if (reservedName) registry.reservedNames.delete(reservedName)
  }
}

export async function handleRecoverIntercept(msg: InboundMessage, targetName?: string): Promise<void> {
  void gateway.react(msg.channelId, msg.id, '🔮').catch(() => {})

  if (recoveryInProgress) {
    try { await gateway.send(msg.channelId, 'Recovery already in progress.', { replyTo: msg.id }) } catch {}
    return
  }

  const deadSessions = findDeadSessions()
  if (deadSessions.length === 0) {
    try { await gateway.send(msg.channelId, 'No dead sessions found.', { replyTo: msg.id }) } catch {}
    return
  }

  const single = !!targetName && targetName !== 'all'
  let candidates = deadSessions
  if (single) {
    candidates = candidates.filter(d => d.tmuxName === targetName)
    if (candidates.length === 0) {
      try { await gateway.send(msg.channelId, `"${targetName}" not found in dead sessions.`, { replyTo: msg.id }) } catch {}
      return
    }
  }

  recoveryInProgress = true
  const results: Awaited<ReturnType<typeof recoverOne>>[] = []
  let skipped: Array<{ info: SessionInfo; reason: string }> = []
  try {
    // A single explicit `recover <name>` is user-targeted — no dedup. `recover all` (or
    // bare) dedups by work-key so it can't put two sessions on one PR (same guard the
    // auto path uses). dedupForRecovery does git I/O — safe, single-flight is already set.
    let unique: SessionInfo[]
    let siblingWatches: Map<string, WatchEntry[]>
    if (single) {
      unique = candidates
      siblingWatches = new Map()
    } else {
      ({ unique, skipped, siblingWatches } = await dedupForRecovery(candidates))
    }
    // Most-recently-active first (dedupForRecovery already sorts; sort the single/no-dedup case too).
    unique.sort((a, b) => b.lastActive - a.lastActive)

    try {
      const skipNote = skipped.length > 0 ? ` (${skipped.length} deduped)` : ''
      await gateway.send(msg.channelId, `Recovering ${unique.length} session(s)${skipNote}...`, { replyTo: msg.id })
    } catch {}

    for (let i = 0; i < unique.length; i += MAX_CONCURRENT) {
      const wave = unique.slice(i, i + MAX_CONCURRENT)
      const wavePromises = wave.map(async (info, j) => {
        if (j > 0) await new Promise(r => setTimeout(r, STAGGER_MS * j))
        try {
          const r = await recoverOne(toRecoverInput(info, siblingWatches.get(info.sessionId)))
          if (r.method !== 'failed') {
            const e = sessionEmoji(r.newName)
            void gateway.send(info.threadId, `${e} \`${r.newName}\` recovered (${r.method})`).catch(() => {})
          }
          return r
        } catch (err) {
          return { name: info.tmuxName, method: 'failed' as const, reason: String(err) }
        }
      })
      const settled = await Promise.allSettled(wavePromises)
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
      }
    }
  } finally {
    recoveryInProgress = false
  }

  const resumed = results.filter(r => r.method === 'resumed')
  const forked = results.filter(r => r.method === 'forked')
  const resurrected = results.filter(r => r.method === 'resurrected')
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string }>

  const fmtName = (r: { name: string; threadUrl?: string }) =>
    r.threadUrl ? `[\`${r.name}\`](${r.threadUrl})` : `\`${r.name}\``

  const lines = [`**Recovery complete** — ${results.length} session(s)`]
  if (resumed.length > 0) lines.push(`• ${resumed.length} resumed (full context): ${resumed.map(fmtName).join(', ')}`)
  if (forked.length > 0) lines.push(`• ${forked.length} forked (transcript preserved): ${forked.map(fmtName).join(', ')}`)
  if (resurrected.length > 0) lines.push(`• ${resurrected.length} resurrected (thread re-read): ${resurrected.map(fmtName).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `${fmtName(r)} (${r.reason})`).join(', ')}`)
  if (skipped.length > 0) lines.push(`• ${skipped.length} skipped (duplicate work): ${skipped.map(s => `\`${s.info.tmuxName}\` — ${s.reason}`).join(', ')}`)

  try { await gateway.send(msg.channelId, lines.join('\n'), { replyTo: msg.id }) } catch {}
}

// ---------------------------------------------------------------------------
// Auto-recovery — revive dead worker sessions on daemon boot (post-reboot)
// ---------------------------------------------------------------------------

// A PR URL the session posted into its own thread. extractArtifactLinks matches ANY github
// pull URL in a reply (authored or merely referenced), so this is a shared-PR signal, not
// proof of authorship — see workKey's coarseness note.
function prKeyFromArtifacts(info: Partial<Pick<SessionInfo, 'artifacts'>>): string | null {
  for (const url of info.artifacts ?? []) {
    const pr = parsePrUrl(url)
    if (pr) return `pr:${pr.owner}/${pr.repo}#${pr.prNumber}`
  }
  return null
}

// Ticket key only when the token LEADS the topic/description — the house convention
// ("BANK-1750 fix …"). Anchoring to the start (vs a loose \b…\b anywhere) stops the
// common case: a standards token buried mid-text ("fix the UTF-8 bug") no longer keys.
// It does NOT catch a topic that *leads* with such a token ("SHA-256 checksum work" →
// ticket:SHA-256) — that remains the accepted ticket-dedup coarseness documented on
// workKey (bounded, surfaced in the recovery summary, manually recoverable).
// Tradeoff (accepted): the leading anchor also FALSE-NEGATIVES a mid-text ticket
// ("Fix login — BANK-1750" → no key), so it won't dedup against a sibling that DOES lead
// with it — both survive. That's the safe direction (fail toward keeping both sessions,
// which are lossless anyway) vs. the false-positive collapse a loose match would cause.
function ticketKey(info: Partial<Pick<SessionInfo, 'topic' | 'description'>>): string | null {
  for (const field of [info.topic, info.description]) {
    const m = field?.trim().match(/^[A-Z]{2,}-\d+\b/)
    if (m) return `ticket:${m[0]}`
  }
  return null
}

// Dedup dead sessions by shared work, not per-thread: two dead threads can point at the same
// PR/ticket, and a naive per-thread respawn puts two live sessions on one PR (has bitten
// before). Key precedence: a PR URL the session posted → its leading ticket; null = unique.
// Both keys are coarse heuristics, NOT ownership proofs — a posted PR URL may be one the
// session only referenced (a reviewer posting the author's PR), and a ticket token can be
// shared by stacked PRs — so two distinct sessions can collapse and one won't auto-revive.
// Acceptable because the collapse is LOSSLESS: the loser is never killed — its record,
// worktree/branch, and watches are preserved and surfaced in the summary for manual recovery.
// PR WATCHES are excluded as a key for the same reason writ larger (an even broader,
// non-owning signal: a session watches PRs it never touched). Exported for unit testing.
export function workKey(info: Partial<Pick<SessionInfo, 'artifacts' | 'topic' | 'description'>>): string | null {
  return prKeyFromArtifacts(info) ?? ticketKey(info)
}

// A deduped-away session is never revived and never killed — its worktree/branch just
// lingers. If it holds unpushed commits, fold the count into the skip reason so the
// operator doesn't `kill` it and discard unmerged work unaware.
async function skipReason(info: SessionInfo, base: string): Promise<string> {
  if (info.worktreeRepo && info.worktreePath) {
    const branch = info.worktreeBranch ?? `wt/${info.tmuxName}`
    try {
      const n = await checkUnpushedCommits(info.worktreeRepo, branch)
      if (n > 0) return `${base} — ⚠️ ${n} unpushed commit(s) on ${branch}, inspect before kill`
      if (n < 0) return `${base} — ⚠️ couldn't verify unpushed commits on ${branch} (transient git error), inspect before kill`
    } catch (err) {
      // checkUnpushedCommits already maps expected git failures to -1 (handled above), so a throw
      // here is truly unexpected (OOM, TypeError, …) — log it rather than swallow, but keep the
      // fall-through to the base reason (an unpushed-commit annotation is best-effort).
      process.stderr.write(`daemon: recover: skipReason unpushed-commit check errored for ${branch}: ${err instanceof Error ? err.message : err}\n`)
    }
  }
  return base
}

// Shared dedup for BOTH auto-recovery and manual `recover all`: collapse candidates to
// one session per real work-key (PR/ticket), so a batch never puts two sessions on one
// PR. Reserves keys owned by ALREADY-LIVE sessions (tmux-alive, incl. an awaiting_pm
// factory builder a restart left alive — a real competitor); a full reboot kills that
// builder's tmux so it won't reserve (and the auto filter separately excludes it). Watches
// of a skipped session are handed to the surviving owner (live → in place; dead winner →
// via siblingWatches) so PR feedback is never stranded on a never-revived record. Null
// work-key → always unique (no shared identity to collapse).
export async function dedupForRecovery(candidates: SessionInfo[]): Promise<{
  unique: SessionInfo[]
  skipped: Array<{ info: SessionInfo; reason: string }>
  siblingWatches: Map<string, WatchEntry[]>
}> {
  // Reserve keys owned by tmux-alive sessions that are NOT themselves being recovered.
  // Excluding candidates is essential: the manual path's candidate filter is `!isAlive`,
  // so a deadAt-set-but-tmux-alive session is a candidate yet also tmux-alive — without
  // this it would reserve its own key and skip itself ("already live as <its own name>").
  const candidateIds = new Set(candidates.map(c => c.sessionId))
  const liveKeys = new Map<string, SessionInfo>()  // workKey → live owner (a real competitor, not a candidate)
  for (const info of registry.values()) {
    if (info.sessionType === 'thread_guest' || !tmuxHasSession(info.tmuxName)) continue
    if (candidateIds.has(info.sessionId)) continue
    const key = workKey(info)
    if (key && !liveKeys.has(key)) liveKeys.set(key, info)
  }

  // No permanent "duplicate" marking needed: work-keys (posted PR / leading ticket) are
  // stable per record, so a loser skipped this boot re-collapses against the same winner
  // next boot (byKey if the winner is also dead, liveKeys if it's alive), and correctly
  // becomes recoverable once no competitor remains.
  const byKey = new Map<string, SessionInfo>()
  const unique: SessionInfo[] = []
  const skipped: Array<{ info: SessionInfo; reason: string }> = []
  const siblingWatches = new Map<string, WatchEntry[]>()  // winner sessionId → watches from skipped siblings
  for (const info of [...candidates].sort((a, b) => b.lastActive - a.lastActive)) {
    const key = workKey(info)
    if (!key) { unique.push(info); continue }
    const liveOwner = liveKeys.get(key)
    if (liveOwner) {
      const w = getWatchesBySession(info.sessionId)
      if (w.length > 0) restoreWatches(w, liveOwner.sessionId, liveOwner.threadId)
      skipped.push({ info, reason: await skipReason(info, `already live as ${liveOwner.tmuxName} (${key})`) })
      continue
    }
    const winner = byKey.get(key)
    if (winner) {
      const w = getWatchesBySession(info.sessionId)
      if (w.length > 0) siblingWatches.set(winner.sessionId, [...(siblingWatches.get(winner.sessionId) ?? []), ...w])
      skipped.push({ info, reason: await skipReason(info, `same work as ${winner.tmuxName} (${key})`) })
      continue
    }
    byKey.set(key, info)
    unique.push(info)
  }
  return { unique, skipped, siblingWatches }
}

async function postAutoRecoverySummary(
  results: Awaited<ReturnType<typeof recoverOne>>[],
  skipped: Array<{ info: SessionInfo; reason: string }>,
): Promise<void> {
  const recovered = results.filter(r => r.method !== 'failed')
  const failed = results.filter(r => r.method === 'failed') as Array<{ name: string; method: 'failed'; reason: string }>

  const lines = [`🔮 **Auto-recovery after reboot** — ${recovered.length} session(s) recovered`]
  if (recovered.length > 0) lines.push(`• Recovered: ${recovered.map(r => `\`${(r as { newName: string }).newName}\` (${r.method})`).join(', ')}`)
  if (skipped.length > 0) lines.push(`• Skipped ${skipped.length} likely duplicate(s): ${skipped.map(s => `\`${s.info.tmuxName}\` — ${s.reason}`).join(', ')}`)
  if (failed.length > 0) lines.push(`• ${failed.length} failed: ${failed.map(r => `\`${r.name}\` (${r.reason})`).join(', ')}`)
  lines.push('_Review for duplicates — `kill <name>` any you don\'t want. Recovered sessions were told to re-verify state before writing._')

  await notifyOperator(lines.join('\n'))
}

// Surface an auto-recovery message to the operator: DM the access allowlist if set,
// else fall back to the default channel so the run is visible. Awaits all sends
// (Promise.all; each send self-catches) so a caller's `await` genuinely means the sends
// were attempted, while a single failing recipient never rejects or blocks the others.
async function notifyOperator(text: string): Promise<void> {
  const access = loadAccess()
  if (access.allowFrom.length > 0) {
    // Each send has its own .catch (logs + swallows), so no element ever rejects —
    // Promise.all suffices; it still awaits all sends without one failure blocking others.
    await Promise.all(access.allowFrom.map(userId =>
      gateway.sendDM(userId, text).catch(e =>
        process.stderr.write(`daemon: auto-recovery notify DM failed: ${e}\n`),
      ),
    ))
  } else if (DEFAULT_SESSION_CHANNEL) {
    await safeSend(DEFAULT_SESSION_CHANNEL, text).catch(() => {})
  }
}

// Opt-in via HYDRA_AUTO_RECOVER=1. Runs once at daemon startup: reads persisted
// dead workers (loadPersisted keeps them with deadAt set), dedups by PR/ticket,
// then revives each via the same resume→fork→respawn cascade as manual `recover`
// (which now preserves worktrees + carries artifacts/description + injects the
// re-verify guard). Idempotent — a session whose tmux is already live is skipped.
export async function autoRecoverAfterBoot(): Promise<void> {
  if ((process.env.HYDRA_AUTO_RECOVER || '') !== '1') return
  if (recoveryInProgress) return

  // Precondition: a systemic boot glitch (e.g. SPAWN_CWD unset) would fail every tier
  // for every session, and each doSpawnSession deletes the dead record before it fails.
  // Bail before touching anything so a broken boot can't erase the whole dead fleet.
  if (!process.env.SPAWN_CWD) {
    process.stderr.write('daemon: auto-recover: SPAWN_CWD unset — skipping to avoid destroying dead records on a broken boot\n')
    // Alert the operator: a silent stderr-only skip could go unnoticed for hours while dead
    // workers sit unrecovered. Every other outcome posts a summary; the broken-boot skip should too.
    await notifyOperator('⚠️ **Auto-recovery skipped** — `SPAWN_CWD` is unset, so the daemon booted without a sessions working dir. Dead worker sessions were left untouched (not lost). Set `SPAWN_CWD` and restart to recover them.')
    return
  }

  const deadInfos = [...registry.values()].filter(info =>
    // deadAt reliably catches hard-reboot survivors: loadPersisted (sessions.ts, in the registry
    // constructor — runs before this) stamps deadAt on EVERY tmux-gone non-guest session at boot,
    // so a session that was alive at crash time (never gracefully stamped) is already deadAt here.
    !!info.deadAt
    && info.sessionType === 'thread_owner'  // only plain workers — excludes thread_guest, factory PMs (master_orchestrator), and factory_builders (recovered by their own subsystem)
    && !info.suppressAutoRecover  // e.g. awaiting_pm builder preserved by sweepOrphanedBuilders for PM peek/kill
    && !info.ephemeral
    && !info.headless
    && info.engine !== 'codex'  // codex reconnects via reconnectCodexSessions() at boot; recoverOne would relaunch it as Claude
    && !tmuxHasSession(info.tmuxName)
    && threadRegistry.has(info.threadId),
  )
  if (deadInfos.length === 0) return

  // Set the single-flight flag BEFORE the first await (dedupForRecovery does git I/O),
  // so a manual `recover` can't interleave between the guard check above and here.
  recoveryInProgress = true
  const results: Awaited<ReturnType<typeof recoverOne>>[] = []
  try {
    const { unique, skipped, siblingWatches } = await dedupForRecovery(deadInfos)
    process.stderr.write(`daemon: auto-recover: ${unique.length} dead session(s) to revive, ${skipped.length} deduped\n`)

    for (let i = 0; i < unique.length; i += MAX_CONCURRENT) {
      const wave = unique.slice(i, i + MAX_CONCURRENT)
      const settled = await Promise.allSettled(wave.map(async (info, j) => {
        if (j > 0) await new Promise(r => setTimeout(r, STAGGER_MS * j))
        return recoverOne(toRecoverInput(info, siblingWatches.get(info.sessionId)))
      }))
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
        else results.push({ name: '(unknown)', method: 'failed', reason: String(s.reason) })
      }
    }
    await postAutoRecoverySummary(results, skipped)
  } finally {
    recoveryInProgress = false
  }
}
