import { appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, basename, resolve, sep } from 'path'
import { homedir } from 'os'
import { STATE_DIR, PLATFORM, RAINDROP_ENV, RAINDROP_DRYRUN_FILE } from './config.js'
import { loadAccess } from './access.js'
import { registry } from './sessions.js'
import { on } from './event-bus.js'
import { byteTmuxName, sentimentForReaction } from '../shared/constants.js'
import { setSweepFailureHandler } from '../shared/spawn-env.js'
import { isUnder } from '../shared/path-containment.js'
import { drainUsage, latestCwd, newCursor, projectDirNames, subtractTotals, totalsChanged, transcriptPathFor, type TokenTotals, type UsageCursor } from './usage.js'
import {
  buildEvent,
  buildSignal,
  EVENT_ENDPOINT,
  SIGNAL_ENDPOINT,
  type EventBody,
  type EventInput,
  type SignalBody,
  type SessionFacts,
} from './raindrop-payload.js'

export type RaindropMode = 'off' | 'dryrun' | 'live'

// Both endpoints take an array.
type WireBody = EventBody[] | SignalBody[]

const POST_TIMEOUT_MS = 5_000
const MODEL_FLAG = /--model[=\s]+['"]?([^'"\s]+)/
const HEADER_SAFE = /^[\x21-\x7E]+$/
const MODE_SHAPE = /^[a-z][a-z-]{0,11}$/
const MAIN_MODEL_TTL_MS = 10 * 60_000
const MAIN_MODEL_RETRY_MS = 60_000
const TRACKED_SWEEP_MS = 60_000
const USAGE_TICK_MS = 60_000
export const _TRACKED_MESSAGE_CAP = 1000

type TrackedMessage = { eventId: string; delivered: Promise<boolean>; signalled: Set<string> }

function rawWriteKey(): string {
  return (deps.env().RAINDROP_WRITE_KEY || '').trim()
}

function writeKey(): string {
  const raw = rawWriteKey()
  return HEADER_SAFE.test(raw) ? raw : ''
}

function rawMode(): string {
  return (deps.env().RAINDROP_MODE || '').trim().toLowerCase() || 'off'
}

type OmitRepoSetting = 'off' | 'on' | 'unrecognized'

function omitRepoSetting(): OmitRepoSetting {
  const raw = (deps.env().RAINDROP_OMIT_REPO || '').trim()
  if (raw === '') return 'off'
  return raw === '1' ? 'on' : 'unrecognized'
}

type RaindropState = { active: RaindropMode; reason?: string }

export function raindropState(): RaindropState {
  const raw = rawMode()
  const keyOnDisk = rawWriteKey() ? ', and RAINDROP_WRITE_KEY is still on disk' : ''
  if (raw === 'dryrun') return { active: 'dryrun' }
  if (raw === 'live') {
    if (writeKey()) return { active: 'live' }
    return {
      active: 'off',
      reason: rawWriteKey()
        ? 'RAINDROP_MODE=live but RAINDROP_WRITE_KEY has characters that cannot go in an HTTP header'
        : 'RAINDROP_MODE=live but RAINDROP_WRITE_KEY is unset',
    }
  }
  if (raw === 'off') {
    return {
      active: 'off',
      reason: keyOnDisk ? `RAINDROP_MODE is off or unset${keyOnDisk} — nothing is sent` : undefined,
    }
  }
  // Never echo an unrecognized value that could be a misplaced write key.
  return {
    active: 'off',
    reason: MODE_SHAPE.test(raw)
      ? `unrecognized RAINDROP_MODE='${raw}' (expected off|dryrun|live)${keyOnDisk}`
      : `unrecognized RAINDROP_MODE (expected off|dryrun|live)${keyOnDisk}`,
  }
}

type Drivers = Set<string> | 'unbounded'

export function drivableBy(access: { allowFrom?: string[]; groups?: Record<string, { allowFrom?: string[] }> }): Drivers {
  const users = new Set(access.allowFrom ?? [])
  for (const policy of Object.values(access.groups ?? {})) {
    const group = policy.allowFrom ?? []
    if (group.length === 0) return 'unbounded'
    for (const id of group) users.add(id)
  }
  return users
}

export function resolveUserId(drivers: Drivers): string {
  const explicit = (deps.env().RAINDROP_USER_ID || '').trim()
  if (explicit) return explicit
  if (drivers === 'unbounded') return ''
  return drivers.size === 1 ? drivers.values().next().value! : ''
}

export function parseModelFlag(paneCommand: string): string | undefined {
  return paneCommand.match(MODEL_FLAG)?.[1]
}

export function bytePaneArgv(): string[] {
  return ['list-panes', '-s', '-t', byteTmuxName(PLATFORM), '-F', '#{pane_start_command}']
}

// Strictly longer than the usage tick, or `stale`'s >= comparison re-runs the
// git lookup every tick and the negative cache never hits at all.
const REPO_NAME_RETRY_MS = 5 * 60_000

type Cached<T> = { value: T; ok: boolean; at: number }

function stale<T>(entry: Cached<T> | undefined, now: number, okMs: number, failMs: number): boolean {
  return !entry || now - entry.at >= (entry.ok ? okMs : failMs)
}

const projectNames = new Map<string, Cached<string | undefined>>()
export type SessionUsage = { totals: TokenTotals; delta: TokenTotals; claudeSessionId: string; coldStart: boolean }

// Dashboard contract: LAST cumulative* per claudeSessionId for lifetime spend,
// SUM delta* for a window. Spawned sessions only; see the PR for the caveats.
export function usageExtra(u: SessionUsage): Record<string, string | number> {
  return {
    cumulativeInputTokens: u.totals.inputTokens,
    cumulativeOutputTokens: u.totals.outputTokens,
    cumulativeCacheCreateTokens: u.totals.cacheCreateTokens,
    cumulativeCacheReadTokens: u.totals.cacheReadTokens,
    deltaInputTokens: u.delta.inputTokens,
    deltaOutputTokens: u.delta.outputTokens,
    deltaCacheCreateTokens: u.delta.cacheCreateTokens,
    deltaCacheReadTokens: u.delta.cacheReadTokens,
    // The delta is suppressed to 0 on a first sighting, so a window that spans
    // one cannot be summed blind. Emitted rather than documented.
    coldStart: u.coldStart ? 1 : 0,
    claudeSessionId: u.claudeSessionId,
  }
}

const usageCursors = new Map<string, UsageCursor>()
// How far the wire has actually accepted, which is not how far the reader got.
const deliveredTotals = new Map<string, TokenTotals>()
// A death mid-POST would otherwise read a baseline the in-flight event is about
// to advance, and report the same window twice.
const pendingEmits = new Map<string, Promise<unknown>>()
// A set, not a counter: reset and increment would straddle the usageFor seam.
const unresolved = new Set<string>()


function readProjectName(repoPath: string): string | undefined {
  const now = deps.now()
  const cached = projectNames.get(repoPath)
  if (!stale(cached, now, Infinity, REPO_NAME_RETRY_MS)) return cached!.value
  const value = deps.projectFor(repoPath)
  projectNames.set(repoPath, { value, ok: value !== undefined, at: now })
  return value
}

export function projectFromGitDir(common: string): string | undefined {
  const parts = common.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return undefined
  if (last === '.git') return parts[parts.length - 2]
  return last.endsWith('.git') ? last.slice(0, -4) : last
}

export function defaultProjectFor(repoPath: string): string | undefined {
  // Bun.spawnSync throws rather than returning a code when git is absent, and
  // this runs inside register(), whose throw would leave the daemon half-booted.
  try {
    const proc = Bun.spawnSync(
      ['git', '-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { stdout: 'pipe', stderr: 'ignore', timeout: 2000 },
    )
    if (proc.exitCode !== 0) return undefined
    const common = proc.stdout.toString().trim()
    return common ? projectFromGitDir(common) : undefined
  } catch { return undefined }
}

function readBytePaneCommand(): string {
  try {
    return execFileSync('tmux', bytePaneArgv(), { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
  } catch { return '' }
}

let mainModelCache: Cached<string | undefined> | undefined

export type RaindropDeps = {
  factsFor: (sessionId: string) => SessionFacts | undefined
  bytePaneCommand: () => string
  liveSessionIds: () => string[]
  knownSessionIds: () => string[]
  postEvent: (endpoint: string, body: WireBody) => Promise<void>
  recordDryRun: (endpoint: string, body: WireBody) => void
  allowedUsers: () => Drivers
  projectFor: (repoPath: string) => string | undefined
  usageFor: (sessionId: string, claudeSessionId?: string) => SessionUsage | undefined
  env: () => Record<string, string | undefined>
  now: () => number
}

export function factsForMain(now: number): SessionFacts {
  if (stale(mainModelCache, now, MAIN_MODEL_TTL_MS, MAIN_MODEL_RETRY_MS)) {
    const paneCommand = deps.bytePaneCommand()
    mainModelCache = paneCommand
      ? { value: parseModelFlag(paneCommand), ok: true, at: now }
      : { value: mainModelCache?.value, ok: false, at: now }
  }
  return {
    threadId: '',
    createdAt: 0,
    tmuxName: 'main',
    engine: 'claude',
    model: mainModelCache?.value,
    sessionType: 'master_orchestrator',
    platform: PLATFORM,
  }
}

export const UNATTRIBUTED_REPO = 'none'

// A transcript cwd is wherever the session wandered to, which may be a private
// checkout nobody chose to publish.
// restart-daemon.sh, watchdog.sh and cli/helpers.ts all default SPAWN_CWD to
// $HOME when it is unset, and "every repo under your home" is not a bound.
export function spawnRootIsBounded(root: string | undefined): root is string {
  if (!root) return false
  const resolved = resolve(root)
  return resolved !== resolve(homedir()) && resolved !== sep
}

export function underSpawnRoot(cwd: string, root = process.env.SPAWN_CWD): boolean {
  // Both sides realpathed: either can be spelled through a symlink, and only
  // resolving one of them makes the check wrong in both directions.
  return spawnRootIsBounded(root) && isUnder(cwd, root, { realpath: true })
}

function sessionProject(info: { worktreeRepo?: string; claudeSessionId?: string }): string {
  const fromWorktree = info.worktreeRepo && readProjectName(info.worktreeRepo)
  if (fromWorktree) return fromWorktree
  const transcript = transcriptPathFor(info.claudeSessionId)
  const cwd = transcript && latestCwd(transcript)
  if (!cwd || !underSpawnRoot(cwd)) return UNATTRIBUTED_REPO
  return readProjectName(cwd) || UNATTRIBUTED_REPO
}

export function factsFromRegistry(sessionId: string): SessionFacts | undefined {
  const info = registry.get(sessionId)
  if (!info || info.headless) return undefined
  return {
    threadId: info.threadId,
    createdAt: info.createdAt,
    tmuxName: info.tmuxName,
    engine: info.engine,
    model: info.sessionMetadata?.model,
    sessionType: info.sessionType,
    label: info.label,
    originType: info.originType,
    platform: PLATFORM,
    ...(omitRepoSetting() === 'off' ? { project: sessionProject(info) } : {}),
  }
}

export async function post(endpoint: string, body: WireBody): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${writeKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`raindrop: ${endpoint} returned ${res.status} ${res.statusText}`)
}

export function defaultLiveSessionIds(): string[] {
  return [...registry.values()].filter(s => !s.deadAt).map(s => s.sessionId)
}

export function defaultAllowedUsers(): Drivers {
  // Empty, not 'unbounded': a malformed group must not read as "admits everyone".
  try { return drivableBy(loadAccess()) } catch { return new Set() }
}

// Reads only the four token counters out of the transcript; see daemon/usage.ts.
export function defaultUsageFor(sessionId: string, hintedClaudeSessionId?: string): SessionUsage | undefined {
  const info = registry.get(sessionId)
  const stored = usageCursors.get(sessionId)
  // killSession clears the registry entry first, so the id rides the event.
  const claudeSessionId = info?.claudeSessionId ?? hintedClaudeSessionId
  const reportable = !!info && info.engine !== 'codex'
  if (!claudeSessionId) {
    if (reportable) unresolved.add(sessionId)
    return undefined
  }
  const transcript = transcriptPathFor(claudeSessionId)
  if (!transcript) {
    if (reportable) unresolved.add(sessionId)
    return undefined
  }
  unresolved.delete(sessionId)
  const prev = stored ?? newCursor()
  const next = drainUsage(transcript, prev)
  usageCursors.set(sessionId, next)

  // Measured from what was last DELIVERED, not last read: a dropped POST used
  // to take its window with it. At-least-once, so a committed-but-timed-out
  // POST lands twice under a fresh event id.
  // A first sighting, and a transcript that restarted, both have no delivered
  // baseline to subtract — that is what coldStart marks.
  // Dropped, not skipped: restartedFromZero is true for one read only, so a
  // baseline that outlives it is subtracted from a different transcript.
  if (next.restartedFromZero === true) deliveredTotals.delete(sessionId)
  const sent = deliveredTotals.get(sessionId)
  const coldStart = sent === undefined
  const base = sent ?? next.totals
  if (!totalsChanged(prev.totals, next.totals) && !totalsChanged(base, next.totals)) return undefined
  return {
    totals: { ...next.totals },
    delta: subtractTotals(base, next.totals),
    claudeSessionId,
    coldStart,
  }
}

const defaultDeps: RaindropDeps = {
  factsFor: factsFromRegistry,
  bytePaneCommand: readBytePaneCommand,
  liveSessionIds: defaultLiveSessionIds,
  knownSessionIds: () => [...registry.values()].map(s => s.sessionId),
  postEvent: post,
  recordDryRun: (endpoint: string, body: WireBody) => {
    appendFileSync(RAINDROP_DRYRUN_FILE, `${JSON.stringify({ endpoint, body })}\n`, { mode: 0o600 })
  },
  allowedUsers: defaultAllowedUsers,
  projectFor: defaultProjectFor,
  usageFor: defaultUsageFor,
  env: () => RAINDROP_ENV,
  now: () => Date.now(),
}

let deps: RaindropDeps = defaultDeps

export function _setDeps(custom: Partial<RaindropDeps>): void { deps = { ...defaultDeps, ...custom } }
export function _resetDeps(): void { deps = defaultDeps }

const tracked = new Map<string, SessionFacts>()
const messageEvents = new Map<string, TrackedMessage>()

export function _trackedSizeForTesting(): number { return tracked.size }

export function _usageCursorCountForTesting(): number { return usageCursors.size }

export function _deliveredCountForTesting(): number { return deliveredTotals.size }

export function _resetStateForTesting(): void {
  projectNames.clear()
  tracked.clear()
  usageCursors.clear()
  deliveredTotals.clear()
  pendingEmits.clear()
  unresolved.clear()
  messageEvents.clear()
  mainModelCache = undefined
  counters = zeroCounters()
}

function rememberMessages(ids: string[], entry: TrackedMessage): void {
  for (const id of ids) messageEvents.set(id, entry)
  while (messageEvents.size > _TRACKED_MESSAGE_CAP) {
    messageEvents.delete(messageEvents.keys().next().value!)
  }
}

type Counters = {
  sent: number; lastSentAt: number
  failures: number; lastFailureAt: number
  sweepFailures: number; lastSweepFailureAt: number
  rootFailures: number; lastRootFailureAt: number
  usageFailures: number; lastUsageFailureAt: number
}
const zeroCounters = (): Counters => ({
  sent: 0, lastSentAt: 0, failures: 0, lastFailureAt: 0, sweepFailures: 0, lastSweepFailureAt: 0,
  rootFailures: 0, lastRootFailureAt: 0,
  usageFailures: 0, lastUsageFailureAt: 0,
})
let counters = zeroCounters()

function ago(at: number): string { return `${Math.round((deps.now() - at) / 60_000)}m ago` }

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
// `||`, not `??`: a Bun fetch abort is an Error whose stack is the empty
// string, and `??` kept it — so a POST timeout logged its reason as nothing.
export const errText = (err: unknown): string =>
  (err instanceof Error ? (err.stack || err.message || err.name) : String(err))

function failureVerb(active: RaindropMode): { short: string; long: string } {
  return active === 'live'
    ? { short: 'send', long: 'send failure' }
    : { short: 'write', long: 'write error' }
}

export function raindropStatusLine(surface: 'cli' | 'chat'): string | undefined {
  const { active, reason } = raindropState()
  if (active === 'off') return reason && `disabled — ${reason}`
  const where = active === 'live' ? 'api.raindrop.ai'
    : surface === 'cli' ? RAINDROP_DRYRUN_FILE : basename(RAINDROP_DRYRUN_FILE)
  const verb = failureVerb(active).long
  const drivers = deps.allowedUsers()
  const detail: string[] = []
  const omit = omitRepoSetting()
  if (omit === 'on') detail.push('repo omitted')
  if (omit === 'unrecognized') detail.push('RAINDROP_OMIT_REPO not understood — expected literal 1, repo omitted anyway')
  const user = resolveUserId(drivers)
  if (!user) {
    detail.push(drivers !== 'unbounded' && drivers.size === 0
      ? 'no allowlisted user — nobody is paired, or access.json was reset'
      : 'no attributable user — set RAINDROP_USER_ID')
  } else if (drivers !== 'unbounded' && !drivers.has(user)) {
    detail.push(`RAINDROP_USER_ID=${user} is not an allowlisted user — events are attributed to nobody real and no reaction of yours becomes a signal`)
  }
  const { sent, lastSentAt, failures, lastFailureAt, sweepFailures, lastSweepFailureAt, usageFailures, lastUsageFailureAt, rootFailures, lastRootFailureAt } = counters
  const usageUnresolved = unresolved.size
  detail.push(sent === 0 ? 'nothing recorded yet' : `${sent} recorded, last ${ago(lastSentAt)}`)
  if (failures > 0) detail.push(`${plural(failures, verb)}, last ${ago(lastFailureAt)}`)
  if (sweepFailures > 0) {
    detail.push(`${plural(sweepFailures, 'tmux env sweep failure')} — a pane may hold the write key, last ${ago(lastSweepFailureAt)}`)
  }
  if (usageFailures > 0) {
    detail.push(`${plural(usageFailures, 'transcript read failure')}, last ${ago(lastUsageFailureAt)}`)
  }
  if (!spawnRootIsBounded(process.env.SPAWN_CWD)) {
    detail.push('SPAWN_CWD unset or unbounded — repo attribution is off')
  }
  if (rootFailures > 0) {
    detail.push(`projects root unreadable — check CLAUDE_CONFIG_DIR, last ${ago(lastRootFailureAt)}`)
  }
  if (usageUnresolved > 0) {
    detail.push(`${plural(usageUnresolved, 'session')} with no transcript yet — a new session, or check CLAUDE_CONFIG_DIR`)
  }
  return `${active} → ${where} (${detail.join('; ')})`
}

export function register(): () => void {
  const { active } = raindropState()
  const line = raindropStatusLine('cli')
  if (line) process.stderr.write(`daemon: raindrop: ${line}\n`)
  if (active === 'off') return () => {}
  const live = active === 'live'

  const onError = (err: unknown) => {
    counters.failures++
    counters.lastFailureAt = deps.now()
    const verb = failureVerb(active).short
    process.stderr.write(`daemon: raindrop: ${verb} failed (${counters.failures}): ${errText(err)}\n`)
  }

  const emitUsage = async (facts: SessionFacts, eventId: string, at: number, usage: SessionUsage) => track({
    event: 'hydra.session.usage', eventId, facts, threadId: facts.threadId, at, extra: usageExtra(usage),
  })

  // A local read failure is not a delivery failure. Named for the path rather
  // than the cause: the same catch covers facts and usage.
  // Separate from usageError: this fires once per tick for one condition, so
  // counting it as a per-file failure buries the thing it is meant to surface.
  const rootError = (err: unknown) => {
    const first = counters.rootFailures === 0
    counters.rootFailures++
    counters.lastRootFailureAt = deps.now()
    if (first) process.stderr.write(`daemon: raindrop: projects root unreadable — check CLAUDE_CONFIG_DIR: ${errText(err)}\n`)
  }

  const usageError = (err: unknown) => {
    counters.usageFailures++
    counters.lastUsageFailureAt = deps.now()
    process.stderr.write(`daemon: raindrop: usage read failed (${counters.usageFailures}): ${errText(err)}\n`)
  }

  // The registry outlives the daemon; this map does not.
  for (const sessionId of deps.liveSessionIds()) {
    try {
      const facts = deps.factsFor(sessionId)
      if (facts) tracked.set(sessionId, facts)
    } catch (err) { usageError(err) }
  }

  const dispatch = async (endpoint: string, wire: WireBody): Promise<boolean> => {
    try {
      if (live) await deps.postEvent(endpoint, wire)
      else deps.recordDryRun(endpoint, wire)
      counters.sent += wire.length
      counters.lastSentAt = deps.now()
      return true
    } catch (err) { onError(err); return false }
  }

  const buildTracked = (input: Omit<EventInput, 'userId' | 'omitRepo'>): EventBody | undefined => {
    const user = resolveUserId(deps.allowedUsers())
    if (!user) return undefined
    const body = buildEvent({ ...input, userId: user, omitRepo: omitRepoSetting() !== 'off' })
    if (!body) onError(new Error(`refused to build ${input.event}: event_id or user_id failed its shape gate`))
    return body
  }

  const track = async (input: Omit<EventInput, 'userId' | 'omitRepo'>): Promise<boolean> => {
    const body = buildTracked(input)
    return body ? dispatch(EVENT_ENDPOINT, [body]) : false
  }

  setSweepFailureHandler((reason) => {
    counters.sweepFailures++
    counters.lastSweepFailureAt = deps.now()
    void track({
      event: 'hydra.env.sweep_failed',
      eventId: `sweep:${deps.now()}`,
      facts: { threadId: '', createdAt: deps.now(), platform: PLATFORM },
      threadId: '',
      at: deps.now(),
      extra: { reason },
    })
  })

  const usageTick = setInterval(() => {
    const at = deps.now()
    // One fleet-wide condition, reported once — the sessions themselves still
    // land in `unresolved`, which is what names CLAUDE_CONFIG_DIR to the operator.
    try { projectDirNames() } catch (err) { rootError(err) }
    const batch: Array<{ sessionId: string; totals: TokenTotals; body: EventBody }> = []
    for (const sessionId of deps.liveSessionIds()) {
      // Facts first: a headless session would advance its cursor past spend nobody reports.
      let usage: SessionUsage | undefined
      let facts: SessionFacts | undefined
      try {
        facts = deps.factsFor(sessionId)
        if (facts) usage = deps.usageFor(sessionId)
      } catch (err) { usageError(err) }
      if (!facts || !usage) continue
      const body = buildTracked({
        event: 'hydra.session.usage', eventId: `${sessionId}:usage:${at}`, facts,
        // Centred: the tokens were burned across the interval, not at its end.
        threadId: facts.threadId, at: at - USAGE_TICK_MS / 2, extra: usageExtra(usage),
      })
      if (body) batch.push({ sessionId, totals: usage.totals, body })
    }
    if (batch.length === 0) return
    // All or nothing, which is what makes the retry sound: a failed batch
    // advances no baseline, so every window in it is re-sent next tick.
    const inFlight = dispatch(EVENT_ENDPOINT, batch.map(b => b.body))
      .then(ok => { if (ok) for (const b of batch) deliveredTotals.set(b.sessionId, b.totals) })
      .catch(usageError)
      .finally(() => {
        for (const b of batch) if (pendingEmits.get(b.sessionId) === inFlight) pendingEmits.delete(b.sessionId)
      })
    for (const b of batch) pendingEmits.set(b.sessionId, inFlight)
  }, USAGE_TICK_MS)
  usageTick.unref()

  const sweep = setInterval(() => {
    // Membership: a crashed record stays in the registry, so its facts and
    // cursor survive for a death event that only a later kill or destroy emits.
    const known = new Set(deps.knownSessionIds())
    for (const id of [...tracked.keys()]) if (!known.has(id)) tracked.delete(id)
    for (const id of [...usageCursors.keys()]) if (!known.has(id)) usageCursors.delete(id)
    for (const id of [...deliveredTotals.keys()]) if (!known.has(id)) deliveredTotals.delete(id)
    for (const id of [...pendingEmits.keys()]) if (!known.has(id)) pendingEmits.delete(id)
    // Liveness: nothing later reads this one, so a crashed record would pin its
    // entry — and the count it feeds is the only alarm for a wrong config dir.
    const live = new Set(deps.liveSessionIds())
    for (const id of [...unresolved]) if (!live.has(id)) unresolved.delete(id)
  }, TRACKED_SWEEP_MS)
  sweep.unref()

  const unsubs = [
    on('session:bridge-registered', async ({ sessionId }) => {
      const facts = deps.factsFor(sessionId)
      if (!facts) return
      const firstSeen = !tracked.has(sessionId)
      tracked.set(sessionId, facts)
      if (!firstSeen) return
      await track({
        event: 'hydra.session.spawn', eventId: sessionId, facts,
        threadId: facts.threadId, at: facts.createdAt,
      })
    }, 'raindrop:spawn', { onError }),

    on('reply', async ({ sessionId, text, chatId, sentIds }) => {
      const facts = sessionId === 'main' ? factsForMain(deps.now()) : deps.factsFor(sessionId)
      if (!facts) return
      if (sessionId !== 'main') tracked.set(sessionId, facts)
      const threadId = sessionId === 'main' ? chatId : facts.threadId
      const eventId = sentIds[sentIds.length - 1] ?? `${sessionId}:${deps.now()}`
      const delivered = track({
        event: 'hydra.session.reply', eventId, facts, threadId,
        at: deps.now(), replyChars: text.length,
      })
      rememberMessages(sentIds, { eventId, delivered, signalled: new Set() })
      await delivered
    }, 'raindrop:reply', { onError }),

    on('session:death', async ({ sessionId, deadAt, claudeSessionId }) => {
      const facts = tracked.get(sessionId)
      tracked.delete(sessionId)
      await pendingEmits.get(sessionId)
      let final: SessionUsage | undefined
      try { final = deps.usageFor(sessionId, claudeSessionId) } catch (err) { usageError(err) }
      // Before the early return — a session that never registered a bridge has no facts.
      usageCursors.delete(sessionId)
      deliveredTotals.delete(sessionId)
      pendingEmits.delete(sessionId)
      if (!facts) return
      if (final) {
        // Not centred: this one happened at the instant of death.
        await emitUsage(facts, `${sessionId}:usage:final`, deadAt ?? deps.now(), final)
      }
      await track({
        event: 'hydra.session.death', eventId: `${sessionId}:death`, facts,
        threadId: facts.threadId, at: deadAt ?? deps.now(),
      })
    }, 'raindrop:death', { onError }),

    on('reaction', async ({ messageId, userId: reactorId, emoji }) => {
      const signal = sentimentForReaction(emoji)
      if (!signal) return
      const entry = messageEvents.get(messageId)
      if (!entry) return
      // Membership is not identity: a second driver is not the attributed user.
      const user = resolveUserId(deps.allowedUsers())
      if (!user || reactorId !== user) return
      if (entry.signalled.has(signal.name)) return
      entry.signalled.add(signal.name)
      if (!await entry.delivered) return
      const body = buildSignal(entry.eventId, signal.name, signal.sentiment)
      const ok = body ? await dispatch(SIGNAL_ENDPOINT, [body]) : false
      if (!ok) entry.signalled.delete(signal.name)
    }, 'raindrop:reaction-signal', { onError }),
  ]

  return () => { setSweepFailureHandler(null); clearInterval(usageTick); clearInterval(sweep); for (const unsub of unsubs) unsub() }
}
