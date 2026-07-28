import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { atomicWriteFileSync, formatDuration } from './util.js'

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
  sessionId: string
  threadId: string
  lastCheckedAt: string
  lastReviewCommentId: number
  lastIssueCommentId: number
  lastReviewId: number
  lastHeadSha: string
  lastCheckStatus: 'pending' | 'success' | 'failure' | 'unknown'
  createdAt: number
}

export type CheckStatusType = WatchEntry['lastCheckStatus']

export function shouldNotifyCiChange(
  lastStatus: CheckStatusType, lastSha: string,
  newStatus: CheckStatusType, newSha: string,
): boolean {
  const newCommit = newSha !== lastSha
  const statusFlipped = newStatus !== lastStatus
    && newStatus !== 'pending' && newStatus !== 'unknown'
    && !(lastStatus === 'unknown' && newStatus === 'success')
  return (newCommit && newStatus === 'failure') || statusFlipped
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

function loadPersisted(): void {
  try {
    const raw = readFileSync(PERSIST_FILE, 'utf8')
    const data = JSON.parse(raw) as WatchEntry[]
    for (const entry of data) {
      // Backfill new fields from older persisted data
      if (!entry.lastHeadSha) entry.lastHeadSha = ''
      if (!entry.lastCheckStatus) entry.lastCheckStatus = 'unknown'
      if (registry.has(entry.sessionId) || entry.sessionId === 'main') {
        watches.set(entry.prUrl, entry)
      }
    }
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

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (match) {
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3]) }
  }
  return null
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

async function ghApi(endpoint: string): Promise<any> {
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

function maxId(items: any[] | null): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0
  return Math.max(...items.map((i: any) => i.id ?? 0))
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchNewReviewComments(entry: WatchEntry): Promise<PRComment[] | null> {
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}/comments?since=${entry.lastCheckedAt}&per_page=100`)
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

async function fetchNewReviews(entry: WatchEntry): Promise<PRReview[] | null> {
  // Fetch newest-first, small page — most PRs have few reviews
  const data = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}/reviews?per_page=10&sort=created&direction=desc`)
  if (!data || !Array.isArray(data)) return null

  const results: PRReview[] = []
  for (const r of data) {
    if (r.id <= entry.lastReviewId) break
    if (new Date(r.submitted_at) <= new Date(entry.lastCheckedAt)) break
    results.push({
      id: r.id,
      user: r.user?.login ?? 'unknown',
      state: r.state,
      body: r.body ?? '',
      createdAt: r.submitted_at,
    })
  }
  return results
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

type CheckResult = {
  headSha: string
  status: 'pending' | 'success' | 'failure' | 'unknown'
  failed: Array<{ name: string; conclusion: string; url: string }>
}

async function fetchCheckStatus(entry: WatchEntry, prData?: any): Promise<CheckResult | null> {
  const pr = prData ?? await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}`)
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

  if (checks?.check_runs) {
    const runs = checks.check_runs as Array<{ name: string; status: string; conclusion: string | null; html_url: string }>
    hasAnyCheck = hasAnyCheck || runs.length > 0
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
    hasPending = hasPending || statuses.some((s: any) => s.state === 'pending')
    for (const s of statuses) {
      if (s.state === 'failure' || s.state === 'error') {
        failed.push({ name: s.context, conclusion: s.state, url: s.target_url ?? '' })
      }
    }
  }

  if (!hasAnyCheck) return { headSha, status: 'unknown', failed: [] }
  if (hasPending && failed.length === 0) return { headSha, status: 'pending', failed: [] }
  if (failed.length > 0) return { headSha, status: 'failure', failed }
  return { headSha, status: 'success', failed: [] }
}

// ---------------------------------------------------------------------------
// Poll a single PR
// ---------------------------------------------------------------------------

async function pollPr(entry: WatchEntry): Promise<void> {
  const pollTime = new Date().toISOString()

  // Fetch PR state once — reused for merge check and check status
  let prData: any = null
  try {
    prData = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}`)
    if (prData?.merged || prData?.state === 'closed') {
      const reason = prData.merged ? 'merged' : 'closed'
      process.stderr.write(`daemon: pr-watch: #${entry.prNumber} ${reason}, auto-unwatching\n`)
      watches.delete(entry.prUrl)
      persist()
      // Scrub the PR from the session's artifact list so it disappears from the home tab
      const info = registry.get(entry.sessionId)
      if (info?.artifacts?.length) {
        info.artifacts = info.artifacts.filter(u => u !== entry.prUrl)
        registry.persist()
      }
      const { refreshDashboard } = await import('./dashboard.js')
      refreshDashboard()
      return
    }
  } catch {}

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

  // Detect CI status changes
  let ciChanged = false
  let prevCheckStatus = entry.lastCheckStatus
  if (checkResult) {
    ciChanged = shouldNotifyCiChange(entry.lastCheckStatus, entry.lastHeadSha, checkResult.status, checkResult.headSha)
    entry.lastHeadSha = checkResult.headSha
    entry.lastCheckStatus = checkResult.status
  }

  if (reviewComments.length === 0 && issueComments.length === 0 && reviews.length === 0 && !ciChanged) {
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
  const totalItems = allComments.length + reviews.length + (ciChanged ? 1 : 0)

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

  if (ciChanged && checkResult) {
    if (checkResult.status === 'failure') {
      parts.push(`🔴 **CI Failed** (${checkResult.failed.length} check${checkResult.failed.length !== 1 ? 's' : ''})`)
      for (const f of checkResult.failed) {
        parts.push(`  • \`${f.name}\` — ${f.conclusion}${f.url ? ` — ${f.url}` : ''}`)
      }
      parts.push('')
    } else if (checkResult.status === 'success' && prevCheckStatus !== 'unknown') {
      parts.push(`✅ **CI Passed** — all checks green`)
      parts.push('')
    }
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

  // Deliver to the session
  const sessionExists = registry.has(entry.sessionId) || entry.sessionId === 'main'
  if (!sessionExists) {
    process.stderr.write(`daemon: pr-watch: session ${entry.sessionId} gone, removing watch for ${entry.prUrl}\n`)
    watches.delete(entry.prUrl)
    persist()
    return
  }

  transport.sendOrQueue(entry.sessionId, {
    type: 'notification',
    content: parts.join('\n'),
    meta: {
      chat_id: entry.threadId,
      message_id: '',
      user: 'pr-watch',
      user_id: 'system',
      ts: new Date().toISOString(),
    },
  })

  if (watches.get(entry.prUrl) === entry) persist()
  process.stderr.write(`daemon: pr-watch: delivered ${allComments.length} comment(s) + ${reviews.length} review(s) for ${entry.prUrl}\n`)
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollAll(): Promise<void> {
  if (watches.size === 0) return

  for (const entry of watches.values()) {
    try {
      await pollPr(entry)
    } catch (err) {
      process.stderr.write(`daemon: pr-watch: poll failed for ${entry.prUrl}: ${err}\n`)
    }
  }
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

export async function watchPr(prUrl: string, sessionId: string, threadId: string): Promise<string> {
  if (watches.has(prUrl)) {
    const existing = watches.get(prUrl)!
    return `already watching ${prUrl} (session: ${existing.sessionId})`
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
    sessionId,
    threadId,
    lastCheckedAt: new Date().toISOString(),
    lastReviewCommentId: 0,
    lastIssueCommentId: 0,
    lastReviewId: 0,
    lastHeadSha: '',
    lastCheckStatus: 'unknown',
    createdAt: Date.now(),
  }

  // Seed watermarks with max IDs so we only report NEW comments/status
  try {
    const [reviewComments, issueComments, reviews, checkResult, prData] = await Promise.all([
      ghApi(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/comments?per_page=1&sort=created&direction=desc`),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.prNumber}/comments?per_page=1&sort=created_at&direction=desc`),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/reviews?per_page=1&sort=id&direction=desc`),
      fetchCheckStatus(entry),
      ghApi(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`),
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
  process.stderr.write(`daemon: pr-watch: watching ${prUrl} → session ${sessionId}, thread ${threadId}\n`)
  return `watching ${prUrl} — will poll every ${POLL_INTERVAL_MS / 60000} minutes`
}

export function unwatchPr(prUrl: string, callerSessionId?: string): string {
  const entry = watches.get(prUrl)
  if (!entry) {
    return `not watching ${prUrl}`
  }
  if (callerSessionId && callerSessionId !== entry.sessionId && callerSessionId !== 'main') {
    return `cannot unwatch — owned by session ${entry.sessionId}`
  }
  watches.delete(prUrl)
  persist()
  process.stderr.write(`daemon: pr-watch: unwatched ${prUrl}\n`)
  return `stopped watching ${prUrl}`
}

export function unwatchBySession(sessionId: string): number {
  let removed = 0
  for (const [url, entry] of watches) {
    if (entry.sessionId === sessionId) {
      watches.delete(url)
      removed++
    }
  }
  if (removed > 0) persist()
  return removed
}

export function listWatches(): WatchEntry[] {
  return [...watches.values()]
}

export function getWatchesBySession(sessionId: string): WatchEntry[] {
  return [...watches.values()].filter(e => e.sessionId === sessionId)
}

export function formatWatchEntry(e: WatchEntry): string {
  const age = formatDuration(Date.now() - e.createdAt)
  const sessionInfo = registry.get(e.sessionId)
  const name = sessionInfo?.tmuxName ?? e.sessionId
  return `[#${e.prNumber}](${e.prUrl}) → **${name}** (${age})`
}

export async function backfillTitles(): Promise<number> {
  const missing = [...watches.values()].filter(e => !e.title)
  let filled = 0
  for (const entry of missing) {
    try {
      const pr = await ghApi(`repos/${entry.owner}/${entry.repo}/pulls/${entry.prNumber}`)
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
  pollTimer = setInterval(() => {
    void pollAll().catch(err => {
      process.stderr.write(`daemon: pr-watch: poll cycle failed: ${err}\n`)
    })
  }, POLL_INTERVAL_MS)
  process.stderr.write(`daemon: pr-watch: started (interval: ${POLL_INTERVAL_MS / 1000}s)\n`)
}

export function stopPrWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}
