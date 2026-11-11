import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../daemon/config.js'
import { registry, type SessionInfo } from '../../daemon/sessions.js'
import { atomicWriteFileSync, formatDuration, safeSend } from '../../daemon/util.js'
import { specialistForThread } from '../../specialists/specialists.js'
import { DELIVER_MAX_MESSAGE_BYTES } from '../../shared/constants.js'
import type { DeliverOpts, DeliverOutcome } from '../../specialists/targets.js'
import { timed } from '../../shared/loop-watch.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PRComment = {
  id: number
  user: string
  body: string
  path?: string
  line?: number
  createdAt: string
  url: string
}

type PRReview = {
  id: number
  user: string
  state: string // APPROVED, CHANGES_REQUESTED, COMMENTED
  body: string
  createdAt: string
}

export type WatchEntry = {
  prUrl: string
  owner: string
  repo: string
  prNumber: number
  title?: string
  // Where updates go: `main`, a specialist, or a thread id with `revive`, resolved at each delivery (targets.ts), so
  // a dead owner heals instead of stranding the watch. Derived once from the watcher; the target outlives its sessions.
  to: string
  revive?: true
  threadId: string  // where the pin and the green notice are posted
  lastCheckedAt: string
  lastReviewCommentId: number
  lastIssueCommentId: number
  lastReviewId: number
  lastHeadSha: string
  lastCheckStatus: 'pending' | 'success' | 'failure' | 'unknown'
  createdAt: number
  pinMessageId?: string
  // Opt-in: post a visible "CI green" message in the thread (not a session turn)
  // once per head commit. greenAnnouncedSha is the head that was announced, so a
  // restart never re-announces and a new push that goes green announces again.
  notifyGreen?: boolean
  greenAnnouncedSha?: string
  // Last seen merge-conflict state (GitHub mergeable === false). Alert only on the flip to true.
  lastConflict?: boolean
}

// GitHub computes `mergeable` lazily: null right after a push, so keep the last value then.
export function conflictChange(last: boolean | undefined, mergeable: boolean | null | undefined) {
  const conflict = typeof mergeable === 'boolean' ? !mergeable : !!last
  return { conflict, newConflict: conflict && !last }
}

export type CheckStatusType = WatchEntry['lastCheckStatus']

/** Test seams: GitHub, and delivery to a watch's target (targets.ts, loaded late: it reaches recovery, which imports this module). */
export const prWatchDeps = {
  api: (endpoint: string): Promise<any> => ghApiFetch(endpoint),
  deliver: async (t: { to: string; revive?: true }, text: string, opts: DeliverOpts): Promise<DeliverOutcome> =>
    (await import('../../specialists/targets.js')).deliverToTarget(t, text, opts),
}

/** The target a session's watches deliver to: `main`, its thread's specialist, or its thread, revived when dead. */
export function targetOf(sessionId: string, threadId: string): { to: string; revive?: true } {
  if (sessionId === 'main') return { to: 'main' }
  const specialist = specialistForThread(threadId)
  return specialist ? { to: specialist } : { to: threadId, revive: true }
}

type Watcher = Pick<SessionInfo, 'sessionId' | 'threadId'>

/** A session's watches: those whose target is its thread (or its thread's specialist), or `main`'s. */
function watchedBy(e: WatchEntry, who: Watcher | undefined): boolean {
  if (!who) return false
  if (who.sessionId === 'main') return e.to === 'main'
  return e.to === who.threadId || e.to === specialistForThread(who.threadId)
}

const watcher = (sessionId: string): Watcher | undefined => sessionId === 'main' ? { sessionId, threadId: '' } : registry.get(sessionId)

export function shouldNotifyCiChange(
  lastStatus: CheckStatusType, lastSha: string,
  newStatus: CheckStatusType, newSha: string,
): boolean {
  // Failures only — a success/pending flip is not worth a codex turn (each
  // delivery is a full context-window turn for codex; success is silent).
  if (newStatus !== 'failure') return false
  return newStatus !== lastStatus || newSha !== lastSha
}

// Edge trigger for the opt-in green post. Level-checked against the announced
// head rather than edge-checked against lastCheckStatus, so opting in while the
// PR is already green announces once on the next poll. null = the CI fetch
// failed (or was partial): hold, never announce from missing data.
export function shouldNotifyGreen(
  entry: Pick<WatchEntry, 'notifyGreen' | 'greenAnnouncedSha'>,
  check: { status: CheckStatusType; headSha: string } | null,
): boolean {
  if (!entry.notifyGreen || !check) return false
  if (check.status !== 'success' || !check.headSha) return false
  return entry.greenAnnouncedSha !== check.headSha
}

export function formatGreenNotice(entry: WatchEntry, check: { headSha: string; total: number }): string {
  const title = entry.title ? ` ${entry.title.replace(/[[\]\\]/g, '')}` : ''
  return `✅ CI green · [#${entry.prNumber}${title}](${entry.prUrl}) · \`${check.headSha.slice(0, 7)}\` · ${check.total} check${check.total !== 1 ? 's' : ''} passed`
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const watches = new Map<string, WatchEntry>()
const PERSIST_FILE = join(STATE_DIR, 'pr-watches.json')
const POLL_INTERVAL_MS = 3 * 60 * 1000
let pollTimer: ReturnType<typeof setInterval> | undefined
let ghToken: string | null = null
let rateLimitWarned = false

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(): void {
  try {
    atomicWriteFileSync(PERSIST_FILE, JSON.stringify([...watches.values()], null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: persist failed: ${err}\n`)
  }
}

// Best-effort: a pin is a convenience, never worth failing a watch over.
async function pinWatch(entry: WatchEntry): Promise<void> {
  if (!gateway?.pin) return
  try {
    const sent = await gateway.send(entry.threadId, `[#${entry.prNumber}](${entry.prUrl})${entry.title ? ` ${entry.title}` : ''}`)
    await gateway.pin(entry.threadId, sent.id)
    entry.pinMessageId = sent.id
    if (watches.get(entry.prUrl) === entry) persist()
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: pin failed for ${entry.prUrl}: ${err}\n`)
  }
}

function unpinWatch(entry: WatchEntry): void {
  if (!entry.pinMessageId || !gateway?.unpin) return
  gateway.unpin(entry.threadId, entry.pinMessageId).catch(err =>
    process.stderr.write(`daemon: pr-watch: unpin failed for ${entry.prUrl}: ${err}\n`))
}

// Backfill fields older persisted data lacks. notifyGreen/greenAnnouncedSha are
// optional: absent reads as opted out / nothing announced.
// A watch persisted before targets names its owner session instead: its target is that session's. One whose
// owner record is gone was ended with it (the old rule), so it is dropped rather than revived.
export function parsePersistedWatches(raw: string): WatchEntry[] {
  const data = JSON.parse(raw) as Array<WatchEntry & { sessionId?: string }>
  const kept: WatchEntry[] = []
  for (const entry of data) {
    if (!entry.lastHeadSha) entry.lastHeadSha = ''
    if (!entry.lastCheckStatus) entry.lastCheckStatus = 'unknown'
    if (!entry.to) {
      const owner = entry.sessionId === 'main' ? { sessionId: 'main', threadId: '' } : entry.sessionId ? registry.get(entry.sessionId) : undefined
      if (!owner) continue
      Object.assign(entry, targetOf(owner.sessionId, owner.threadId))
    }
    delete entry.sessionId
    kept.push(entry)
  }
  return kept
}

function loadPersisted(): void {
  try {
    const raw = readFileSync(PERSIST_FILE, 'utf8')
    for (const entry of parsePersistedWatches(raw)) watches.set(entry.prUrl, entry)
    if (watches.size > 0) {
      process.stderr.write(`daemon: pr-watch: restored ${watches.size} watch(es)\n`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`daemon: pr-watch: load failed: ${err}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Parse PR URL → owner/repo/number
// ---------------------------------------------------------------------------

export function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (match) {
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3]) }
  }
  return null
}

export async function fetchPrTitle(url: string): Promise<string | null> {
  const parsed = parsePrUrl(url)
  if (!parsed) return null
  const data = await fetchPr(parsed)
  return data?.title ?? null
}

// ---------------------------------------------------------------------------
// GitHub API via fetch (non-blocking, rate-limit aware)
// ---------------------------------------------------------------------------

function loadGhToken(): string | null {
  if (ghToken) return ghToken
  try {
    ghToken = execSync('gh auth token 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim()
    return ghToken
  } catch {
    process.stderr.write('daemon: pr-watch: failed to get gh auth token\n')
    return null
  }
}

const ghApi = (endpoint: string): Promise<any> => prWatchDeps.api(endpoint)

async function ghApiFetch(endpoint: string): Promise<any> {
  const token = loadGhToken()
  if (!token) return null

  try {
    const resp = await fetch(`https://api.github.com/${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })

    // Rate-limit awareness
    const remaining = resp.headers.get('X-RateLimit-Remaining')
    if (remaining !== null) {
      const rem = parseInt(remaining)
      if (rem < 100 && !rateLimitWarned) {
        rateLimitWarned = true
        process.stderr.write(`daemon: pr-watch: rate limit low (${rem} remaining) — consider reducing watch count\n`)
      } else if (rem >= 500) {
        rateLimitWarned = false
      }
      if (rem === 0) {
        const resetAt = resp.headers.get('X-RateLimit-Reset')
        const resetIn = resetAt ? Math.max(0, parseInt(resetAt) - Math.floor(Date.now() / 1000)) : '?'
        process.stderr.write(`daemon: pr-watch: rate limited — resets in ${resetIn}s, skipping poll cycle\n`)
        return null
      }
    }

    if (!resp.ok) {
      process.stderr.write(`daemon: pr-watch: gh api ${resp.status} for ${endpoint}: ${(await resp.text()).slice(0, 200)}\n`)
      return null
    }

    return await resp.json()
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: gh api failed for ${endpoint}: ${err instanceof Error ? err.message : err}\n`)
    return null
  }
}

// Both WatchEntry and a parsed PR URL carry these three fields.
type PrRef = { owner: string; repo: string; prNumber: number }
const prPath = (r: PrRef) => `repos/${r.owner}/${r.repo}/pulls/${r.prNumber}`
const fetchPr = (r: PrRef) => ghApi(prPath(r))

export function maxId(items: any[] | null): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0
  return Math.max(...items.map((i: any) => i.id ?? 0))
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchNewReviewComments(entry: WatchEntry): Promise<PRComment[] | null> {
  const data = await ghApi(`${prPath(entry)}/comments?since=${entry.lastCheckedAt}&per_page=100`)
  if (!data || !Array.isArray(data)) return null

  if (data.length >= 100) {
    process.stderr.write(`daemon: pr-watch: ${entry.prUrl} hit 100 review comments in one poll — some may be missed\n`)
  }

  return data
    .filter((c: any) => c.id > entry.lastReviewCommentId)
    .map((c: any) => ({
      id: c.id,
      user: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      path: c.path,
      line: c.original_line ?? c.line,
      createdAt: c.created_at,
      url: c.html_url,
    }))
}

// GitHub's /reviews endpoint ignores sort/direction and returns oldest-first, so take the
// whole page (max 100) and filter; never stop at the first old review.
export function selectNewReviews(data: any[], entry: Pick<WatchEntry, 'lastReviewId' | 'lastCheckedAt'>): PRReview[] {
  return data
    .filter((r: any) => r.id > entry.lastReviewId && new Date(r.submitted_at) > new Date(entry.lastCheckedAt))
    .map((r: any) => ({
      id: r.id,
      user: r.user?.login ?? 'unknown',
      state: r.state,
      body: r.body ?? '',
      createdAt: r.submitted_at,
    }))
}

async function fetchNewReviews(entry: WatchEntry): Promise<PRReview[] | null> {
  const data = await ghApi(`${prPath(entry)}/reviews?per_page=100`)
  if (!data || !Array.isArray(data)) return null
  return selectNewReviews(data, entry)
}

async function fetchNewIssueComments(entry: WatchEntry): Promise<PRComment[] | null> {
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/issues/${entry.prNumber}/comments?since=${entry.lastCheckedAt}&per_page=100`)
  if (!data || !Array.isArray(data)) return null

  if (data.length >= 100) {
    process.stderr.write(`daemon: pr-watch: ${entry.prUrl} hit 100 issue comments in one poll — some may be missed\n`)
  }

  return data
    .filter((c: any) => c.id > entry.lastIssueCommentId)
    .map((c: any) => ({
      id: c.id,
      user: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at,
      url: c.html_url,
    }))
}

// ---------------------------------------------------------------------------
// CI status
// ---------------------------------------------------------------------------

export type CheckResult = {
  headSha: string
  status: 'pending' | 'success' | 'failure' | 'unknown'
  failed: Array<{ name: string; conclusion: string; url: string }>
  total: number // check runs + commit statuses on headSha
}

async function fetchCheckStatus(entry: WatchEntry, prData?: any): Promise<CheckResult | null> {
  const pr = prData ?? await fetchPr(entry)
  if (!pr?.head?.sha) return null

  const headSha = pr.head.sha as string

  const [checks, combinedStatus] = await Promise.all([
    ghApi(`repos/${entry.owner}/${entry.repo}/commits/${headSha}/check-runs?per_page=100`),
    ghApi(`repos/${entry.owner}/${entry.repo}/commits/${headSha}/status`),
  ])

  // null = API failure. If either endpoint failed, return null so pollPr
  // holds lastCheckStatus — computing status from partial data causes
  // false greens (same pattern as the comment-fetch null-vs-empty guard).
  if (checks === null || combinedStatus === null) {
    process.stderr.write(`daemon: pr-watch: partial CI fetch failure (check-runs: ${checks !== null}, statuses: ${combinedStatus !== null}) — holding state\n`)
    return null
  }

  const failed: Array<{ name: string; conclusion: string; url: string }> = []
  let hasPending = false
  let hasAnyCheck = false
  let total = 0

  if (checks?.check_runs) {
    const runs = checks.check_runs as Array<{ name: string; status: string; conclusion: string | null; html_url: string }>
    hasAnyCheck = hasAnyCheck || runs.length > 0
    total += runs.length
    hasPending = hasPending || runs.some((r: any) => r.status !== 'completed')
    for (const r of runs) {
      if (r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure' || r.conclusion === 'action_required') {
        failed.push({ name: r.name, conclusion: r.conclusion!, url: r.html_url })
      }
    }
  }

  if (combinedStatus?.statuses) {
    const statuses = combinedStatus.statuses as Array<{ context: string; state: string; target_url: string }>
    if (statuses.length >= 100) {
      process.stderr.write(`daemon: pr-watch: ${entry.prUrl} hit 100 commit statuses — some may be missed\n`)
    }
    hasAnyCheck = hasAnyCheck || statuses.length > 0
    total += statuses.length
    hasPending = hasPending || statuses.some((s: any) => s.state === 'pending')
    for (const s of statuses) {
      if (s.state === 'failure' || s.state === 'error') {
        failed.push({ name: s.context, conclusion: s.state, url: s.target_url ?? '' })
      }
    }
  }

  if (!hasAnyCheck) return { headSha, status: 'unknown', failed: [], total }
  if (hasPending && failed.length === 0) return { headSha, status: 'pending', failed: [], total }
  if (failed.length > 0) return { headSha, status: 'failure', failed, total }
  return { headSha, status: 'success', failed: [], total }
}

// Fold one poll's CI result into the entry. Returns whether the failure path
// should notify the session (unchanged behavior). The opt-in green notice is a
// visible thread post, never a session delivery: no model turn, no Codex cost.
// greenAnnouncedSha is claimed before the send and released if it fails, so a
// failed send retries on the next poll.
export async function applyCheckResult(entry: WatchEntry, check: CheckResult | null): Promise<boolean> {
  if (!check) return false
  const ciChanged = shouldNotifyCiChange(entry.lastCheckStatus, entry.lastHeadSha, check.status, check.headSha)
  const announceGreen = shouldNotifyGreen(entry, check)
  entry.lastHeadSha = check.headSha
  entry.lastCheckStatus = check.status
  if (announceGreen) {
    // Claim the SHA before the await: poll cycles can overlap, and the second must not post too.
    entry.greenAnnouncedSha = check.headSha
    const sent = await safeSend(entry.threadId, formatGreenNotice(entry, check), { unfurl: false })
    if (sent.length === 0 && entry.greenAnnouncedSha === check.headSha) entry.greenAnnouncedSha = undefined
  }
  return ciChanged
}

// ---------------------------------------------------------------------------
// Poll a single PR
// ---------------------------------------------------------------------------

async function pollPr(entry: WatchEntry): Promise<void> {
  const pollTime = new Date().toISOString()

  // Nothing counts as seen until the update lands: an update that does not land is owed, and the next poll
  // fetches it again from the same read position.
  const held = readPosition(entry)

  // Fetch PR state once — reused for merge check and check status
  let prData: any = null
  try {
    prData = await fetchPr(entry)
    if (prData?.merged || prData?.state === 'closed') {
      const reason = prData.merged ? 'merged' : 'closed'
      process.stderr.write(`daemon: pr-watch: #${entry.prNumber} ${reason}, auto-unwatching\n`)
      watches.delete(entry.prUrl)
      persist()
      unpinWatch(entry)
      // Scrub the PR from the artifact lists so it disappears from the home tab
      for (const info of registry.values()) {
        if (!info.artifacts?.includes(entry.prUrl)) continue
        info.artifacts = info.artifacts.filter(u => u !== entry.prUrl)
        registry.persist()
      }
      const { refreshDashboard } = await import('../../daemon/dashboard.js')
      refreshDashboard()
      return
    }
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: pollPr #${entry.prNumber} fetch failed: ${err}\n`)
  }

  const [reviewCommentsRaw, reviewsRaw, issueCommentsRaw, checkResult] = await Promise.all([
    fetchNewReviewComments(entry),
    fetchNewReviews(entry),
    fetchNewIssueComments(entry),
    fetchCheckStatus(entry, prData),
  ])

  // Only advance timestamp when all comment fetches succeeded.
  // null = API failure; [] = success with no new items. If we advance
  // on failure, the next poll's ?since= skips comments permanently.
  const commentFetchesOk = reviewCommentsRaw !== null && reviewsRaw !== null && issueCommentsRaw !== null
  if (commentFetchesOk) {
    entry.lastCheckedAt = pollTime
  } else {
    process.stderr.write(`daemon: pr-watch: ${entry.prUrl} — one or more fetches failed, holding lastCheckedAt\n`)
  }

  const reviewComments = reviewCommentsRaw ?? []
  const reviews = reviewsRaw ?? []
  const issueComments = issueCommentsRaw ?? []

  // Detect CI status changes (and post the opt-in green notice)
  const ciChanged = await applyCheckResult(entry, checkResult)

  const { conflict, newConflict } = conflictChange(entry.lastConflict, prData?.mergeable)
  entry.lastConflict = conflict

  if (reviewComments.length === 0 && issueComments.length === 0 && reviews.length === 0 && !ciChanged && !newConflict) {
    if (watches.get(entry.prUrl) === entry) persist()
    return
  }

  // Update watermarks
  for (const c of reviewComments) {
    if (c.id > entry.lastReviewCommentId) entry.lastReviewCommentId = c.id
  }
  for (const c of issueComments) {
    if (c.id > entry.lastIssueCommentId) entry.lastIssueCommentId = c.id
  }
  for (const r of reviews) {
    if (r.id > entry.lastReviewId) entry.lastReviewId = r.id
  }

  const allComments = [...reviewComments, ...issueComments]
  const totalItems = allComments.length + reviews.length + (ciChanged ? 1 : 0) + (newConflict ? 1 : 0)

  const parts: string[] = []
  parts.push(`[PR Feedback] **${entry.owner}/${entry.repo}#${entry.prNumber}** — ${totalItems} new item(s)`)
  parts.push('')

  for (const r of reviews) {
    const icon = r.state === 'APPROVED' ? '✅' : r.state === 'CHANGES_REQUESTED' ? '🔴' : '💬'
    parts.push(`${icon} **Review from @${r.user}** — ${r.state}`)
    if (r.body) parts.push(`> ${r.body.slice(0, 500)}`)
    parts.push('')
  }

  for (const c of allComments) {
    const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : '(general)'
    parts.push(`💬 **@${c.user}** ${location}`)
    parts.push(`> ${c.body.slice(0, 500)}`)
    if (c.url) parts.push(`> ${c.url}`)
    parts.push('')
  }

  if (ciChanged && checkResult?.status === 'failure') {
    parts.push(`🔴 **CI Failed** (${checkResult.failed.length} check${checkResult.failed.length !== 1 ? 's' : ''})`)
    for (const f of checkResult.failed) {
      parts.push(`  • \`${f.name}\` — ${f.conclusion}${f.url ? ` — ${f.url}` : ''}`)
    }
    parts.push('')
  }

  if (newConflict) {
    parts.push('⚠️ **Merge conflict** — this PR no longer merges cleanly into its base. Rebase it and resolve the conflicts.')
    parts.push('')
  }

  parts.push('---')
  const hasReviewFeedback = allComments.length > 0 || reviews.length > 0
  if (hasReviewFeedback && ciChanged && checkResult?.status === 'failure') {
    parts.push('CI is failing. Categorize the review feedback into: **real bugs to fix**, **valid suggestions**, **false positives/noise**, **nits**. Then investigate and fix the CI failures. Lead with a TL;DR of what needs action.')
  } else if (ciChanged && checkResult?.status === 'failure') {
    parts.push('CI is failing. Investigate the failed checks, identify the root cause, and fix the issue.')
  } else if (hasReviewFeedback) {
    parts.push('Categorize the above into: **real bugs to fix**, **valid suggestions**, **false positives/noise**, **nits**. Lead with a TL;DR of what actually needs action.')
  }

  const content = fitToCap(parts, entry.prUrl)
  // Keyed by what it says: resent after a lost answer, it lands once; a new failure of the same head carries new job URLs.
  const key = `prwatch:${entry.prUrl}:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`
  // Killed or unwatched while this poll fetched: the thread was ended on purpose, so nothing may revive it.
  if (watches.get(entry.prUrl) !== entry) { Object.assign(entry, held); return }
  // Low priority: an engine where every delivery is a priced turn (Codex) may hold it for the next turn.
  const r = await prWatchDeps.deliver({ to: entry.to, ...(entry.revive && { revive: true }) }, content, {
    initiator: 'pr-watch', source: 'pr-watch', idempotencyKey: key, queue: true, lowPriority: true,
    wanted: () => watches.get(entry.prUrl) === entry,
  })
  if (!r.ok) {
    Object.assign(entry, held)
    if (r.exit === 8) {
      process.stderr.write(`daemon: pr-watch: ${entry.prUrl} → ${entry.to}: ${r.reason} — unwatching\n`)
      dropWatch(entry)
      void safeSend(entry.threadId, `⚠️ Stopped watching [#${entry.prNumber}](${entry.prUrl}): ${r.reason}`, { unfurl: false })
      return
    }
    process.stderr.write(`daemon: pr-watch: ${entry.prUrl} → ${entry.to} not delivered (exit ${r.exit}: ${r.reason}) — owed, retried next poll\n`)
    return
  }
  if (watches.get(entry.prUrl) === entry) persist()
  process.stderr.write(`daemon: pr-watch: delivered ${allComments.length} comment(s) + ${reviews.length} review(s) for ${entry.prUrl} → ${r.sessionName}${r.revived ? ' (revived)' : ''}\n`)
}

/** A burst of feedback can outgrow one delivery: keep the lines that fit, and the closing instruction, and point at the PR. */
function fitToCap(parts: string[], prUrl: string): string {
  const text = parts.join('\n')
  if (Buffer.byteLength(text) <= DELIVER_MAX_MESSAGE_BYTES) return text
  const cut = parts.lastIndexOf('---')
  const tail = [`_…more on the PR: ${prUrl}_`, '', ...parts.slice(cut)].join('\n')
  let budget = DELIVER_MAX_MESSAGE_BYTES - Buffer.byteLength(tail) - 1
  const head: string[] = []
  for (const line of parts.slice(0, cut)) {
    budget -= Buffer.byteLength(line) + 1
    if (budget < 0) break
    head.push(line)
  }
  return [...head, tail].join('\n')
}

type ReadPosition = Pick<WatchEntry, 'lastCheckedAt' | 'lastReviewCommentId' | 'lastIssueCommentId' | 'lastReviewId' | 'lastHeadSha' | 'lastCheckStatus' | 'lastConflict'>

function readPosition(e: WatchEntry): ReadPosition {
  const { lastCheckedAt, lastReviewCommentId, lastIssueCommentId, lastReviewId, lastHeadSha, lastCheckStatus, lastConflict } = e
  return { lastCheckedAt, lastReviewCommentId, lastIssueCommentId, lastReviewId, lastHeadSha, lastCheckStatus, lastConflict }
}

function dropWatch(entry: WatchEntry): void {
  if (watches.get(entry.prUrl) !== entry) return
  watches.delete(entry.prUrl)
  unpinWatch(entry)
  persist()
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

let polling = false

// One cycle at a time: a delivery may revive its target, which can outlast the poll interval.
async function pollAll(): Promise<void> {
  if (watches.size === 0 || polling) return
  polling = true
  try {
    for (const entry of [...watches.values()]) {
      try {
        await pollPr(entry)
      } catch (err) {
        process.stderr.write(`daemon: pr-watch: poll failed for ${entry.prUrl}: ${err}\n`)
      }
    }
  } finally { polling = false }
}

// ---------------------------------------------------------------------------
// PR detection — auto-detect PR URL from a working directory
// ---------------------------------------------------------------------------

export const WATCH_ERRORS = {
  NO_SESSION: 'bare `watch` only works in a session thread — provide a PR URL',
  NO_CWD: 'no URL provided and could not determine session cwd — provide a PR URL',
  NO_PR: 'no open PR found on current branch — provide a PR URL',
  PR_CLOSED: (url: string, state: string) => `PR ${url} is ${state} — provide a URL for the current PR`,
  INVALID_URL: (url: string) => `detected URL from current branch but it doesn't look like a GitHub PR: ${url}`,
} as const

export type DetectResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

export async function detectPrUrl(cwd: string): Promise<DetectResult> {
  process.stderr.write(`daemon: pr-watch: detecting PR from cwd=${cwd}\n`)
  try {
    const proc = Bun.spawn(['gh', 'pr', 'view', '--json', 'url,state', '-q', '[.url, .state] | join("\\t")'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const result = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        return { stdout, exitCode }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => { proc.kill(); reject(new Error('timeout')) }, 15_000)
      ),
    ])
    if (result.exitCode !== 0) return { ok: false, reason: WATCH_ERRORS.NO_PR }

    const [url, state] = result.stdout.trim().split('\t')
    if (!url || !url.startsWith('https://')) return { ok: false, reason: WATCH_ERRORS.NO_PR }

    if (!parsePrUrl(url)) return { ok: false, reason: WATCH_ERRORS.INVALID_URL(url) }

    if (state && state.toLowerCase() !== 'open') {
      return { ok: false, reason: WATCH_ERRORS.PR_CLOSED(url, state) }
    }

    return { ok: true, url }
  } catch {
    return { ok: false, reason: WATCH_ERRORS.NO_PR }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type WatchOpts = { notifyGreen?: boolean }

export async function watchPr(prUrl: string, sessionId: string, threadId: string, opts: WatchOpts = {}): Promise<string> {
  const existing = watches.get(prUrl)
  if (existing) {
    // Opting in to green notices upgrades the existing watch in place (its owner
    // and thread are kept). Plain re-watches stay a no-op; nothing downgrades.
    if (opts.notifyGreen && !existing.notifyGreen) {
      existing.notifyGreen = true
      persist()
      process.stderr.write(`daemon: pr-watch: ${prUrl} upgraded to notify-green\n`)
      return `already watching ${prUrl} (→ ${targetName(existing)}) — will now post when CI goes green`
    }
    return `already watching ${prUrl} (→ ${targetName(existing)})`
  }

  const parsed = parsePrUrl(prUrl)
  if (!parsed) {
    throw new Error(`invalid PR URL: ${prUrl} — expected https://github.com/owner/repo/pull/123`)
  }

  const entry: WatchEntry = {
    prUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    ...targetOf(sessionId, threadId),
    threadId,
    lastCheckedAt: new Date().toISOString(),
    lastReviewCommentId: 0,
    lastIssueCommentId: 0,
    lastReviewId: 0,
    lastHeadSha: '',
    lastCheckStatus: 'unknown',
    createdAt: Date.now(),
    ...(opts.notifyGreen ? { notifyGreen: true } : {}),
  }

  // Seed watermarks with max IDs so we only report NEW comments/status
  try {
    const [reviewComments, issueComments, reviews, checkResult, prData] = await Promise.all([
      ghApi(`${prPath(parsed)}/comments?per_page=1&sort=created&direction=desc`),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.prNumber}/comments?per_page=1&sort=created_at&direction=desc`),
      ghApi(`${prPath(parsed)}/reviews?per_page=100`),
      fetchCheckStatus(entry),
      fetchPr(parsed),
    ])
    entry.lastReviewCommentId = maxId(reviewComments)
    entry.lastIssueCommentId = maxId(issueComments)
    entry.lastReviewId = maxId(reviews)
    if (prData?.title) entry.title = prData.title
    if (checkResult) {
      entry.lastHeadSha = checkResult.headSha
      entry.lastCheckStatus = checkResult.status
    }
  } catch (err) {
    process.stderr.write(`daemon: pr-watch: failed to seed watermarks for ${prUrl}: ${err}\n`)
  }

  watches.set(prUrl, entry)
  persist()
  void pinWatch(entry)
  process.stderr.write(`daemon: pr-watch: watching ${prUrl} → ${entry.to}, thread ${threadId}${entry.notifyGreen ? ' (notify-green)' : ''}\n`)
  return `watching ${prUrl} — will poll every ${POLL_INTERVAL_MS / 60000} minutes${entry.notifyGreen ? ' and post when CI goes green' : ''}`
}

export function unwatchPr(prUrl: string, callerSessionId?: string): string {
  const entry = watches.get(prUrl)
  if (!entry) {
    return `not watching ${prUrl}`
  }
  if (callerSessionId && callerSessionId !== 'main' && !watchedBy(entry, watcher(callerSessionId))) {
    return `cannot unwatch — it delivers to ${targetName(entry)}`
  }
  watches.delete(prUrl)
  persist()
  unpinWatch(entry)
  process.stderr.write(`daemon: pr-watch: unwatched ${prUrl}\n`)
  return `stopped watching ${prUrl}`
}

/**
 * A deliberate end of the session (kill, `[done]`, a deleted thread): its thread's watches end with it. A
 * specialist's watches do not: the specialist outlives its sessions, and ends with `specialist rm` (exit 8).
 */
export function unwatchBySession(who: Watcher): number {
  let removed = 0
  for (const [url, entry] of watches) {
    if (watchedBy(entry, who) && (entry.to === 'main' || entry.to === who.threadId)) {
      watches.delete(url)
      unpinWatch(entry)
      removed++
    }
  }
  if (removed > 0) persist()
  return removed
}

/**
 * Recovery dedup: a skipped session's watches deliver to the session that does the same work. The read position
 * moves with them, so nothing is re-sent or missed; the pin moves to the new thread.
 */
export function retargetWatches(from: Watcher, to: Watcher): number {
  let moved = 0
  // In place: a poll in flight holds this object, and its read position must stay the one it restores.
  for (const entry of [...watches.values()].filter(e => watchedBy(e, from))) {
    unpinWatch(entry)
    delete entry.revive
    Object.assign(entry, targetOf(to.sessionId, to.threadId), { threadId: to.threadId, pinMessageId: undefined })
    void pinWatch(entry)
    moved++
  }
  if (moved > 0) persist()
  return moved
}

export function listWatches(): WatchEntry[] {
  return [...watches.values()]
}

export function getWatchesBySession(sessionId: string): WatchEntry[] {
  const who = watcher(sessionId)
  return [...watches.values()].filter(e => watchedBy(e, who))
}

/** Who a watch delivers to now: a specialist's name, `main`, or its thread's session name. */
function targetName(e: WatchEntry): string {
  if (e.to === 'main' || !e.revive) return e.to
  const id = registry.getByThread(e.to)
  return (id && registry.get(id)?.tmuxName) || `thread ${e.to}`
}

export function formatWatchEntry(e: WatchEntry): string {
  const age = formatDuration(Date.now() - e.createdAt)
  return `[#${e.prNumber}](${e.prUrl})${e.notifyGreen ? ' 🟢' : ''} → **${targetName(e)}** (${age})`
}

export async function backfillTitles(): Promise<number> {
  const missing = [...watches.values()].filter(e => !e.title)
  let filled = 0
  for (const entry of missing) {
    try {
      const pr = await fetchPr(entry)
      if (pr?.title) {
        entry.title = pr.title
        filled++
      }
    } catch (err) {
      process.stderr.write(`daemon: pr-watch: backfill title failed for #${entry.prNumber}: ${err}\n`)
    }
  }
  if (filled > 0) persist()
  return filled
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startPrWatcher(): void {
  loadPersisted()
  loadGhToken()
  pollTimer = setInterval(() => timed('pr-watch', () => {
    void pollAll().catch(err => {
      process.stderr.write(`daemon: pr-watch: poll cycle failed: ${err}\n`)
    })
  }), POLL_INTERVAL_MS)
  process.stderr.write(`daemon: pr-watch: started (interval: ${POLL_INTERVAL_MS / 1000}s)\n`)
}

export function stopPrWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

export const _pollForTesting = (entry: WatchEntry): Promise<void> => pollPr(entry)
export const _pollAllForTesting = (): Promise<void> => pollAll()
export function _setWatchForTesting(entry: WatchEntry): void { watches.set(entry.prUrl, entry) }
