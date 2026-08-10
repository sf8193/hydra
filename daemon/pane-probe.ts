// Pane probe: detect CC sessions stuck on interactive prompts (plan mode,
// login required) by periodically capturing tmux pane text and pattern
// matching against the pane TAIL (where the active prompt renders).
//
// CC-specific — coupled to Claude Code's terminal UI strings. When a
// second harness arrives, introduce a HarnessProbe interface.
//
// Injectable seams: capturePaneTail, getWindowActivity, sendKeys, readFile
// are replaceable for testing.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL } from './config.js'
import { loadAccess } from './access.js'
import { safeSend } from './util.js'
import { transport } from './bridge-transport.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlockingKind = 'plan_mode' | 'login_required' | 'resume_prompt'

export type LoginStage = 'expiring' | 'blocked' | 'oauth_url' | 'success'

export type BlockingState = {
  kind: BlockingKind
  planPath: string | null
  loginStage: LoginStage | null
  oauthUrl: string | null
}

type ProbeEntry = {
  tmuxName: string
  threadId: string
  isMain: boolean
  firstSeen: number
  consecutive: number
  state: BlockingState
  notifiedAt: number | null
  notifyCount: number
  notifying: boolean // in-flight notification guard
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIRM_PROBES = 2
const NOTIFY_COOLDOWN_MS = 10 * 60_000
const MAX_NOTIFICATIONS = 3
const PANE_TAIL_LINES = 8
const MIN_IDLE_BEFORE_PROBE_S = 30
const INTERCEPT_GRACE_MS = 5 * 60_000
const BUILDER_IDLE_NUDGE_S = 90
const BUILDER_MAX_NUDGES = 3

// ---------------------------------------------------------------------------
// Injectable seams (tests replace these)
// ---------------------------------------------------------------------------

export type PaneProbeIO = {
  capturePaneTail: (tmuxName: string, lines: number) => Promise<string | null>
  getWindowActivity: (tmuxName: string) => Promise<number | null>
  sendKeys: (tmuxName: string, ...keys: string[]) => Promise<boolean>
  readFile: (path: string) => string | null
  now: () => number
}

const defaultIO: PaneProbeIO = {
  async capturePaneTail(tmuxName, lines) {
    try {
      const { stdout } = await execFileAsync(
        'tmux', ['capture-pane', '-t', tmuxName, '-p', '-S', `-${lines}`],
        { timeout: 5000 },
      )
      return stdout.trimEnd()
    } catch { return null }
  },

  async getWindowActivity(tmuxName) {
    try {
      const { stdout } = await execFileAsync(
        'tmux', ['display', '-t', tmuxName, '-p', '#{window_activity}'],
        { timeout: 2000 },
      )
      return parseInt(stdout.trim(), 10) || null
    } catch { return null }
  },

  async sendKeys(tmuxName, ...keys) {
    try {
      await execFileAsync('tmux', ['send-keys', '-t', tmuxName, ...keys], { timeout: 3000 })
      return true
    } catch { return false }
  },

  readFile(path) {
    try { return readFileSync(path, 'utf8') } catch { return null }
  },

  now: () => Date.now(),
}

let io: PaneProbeIO = defaultIO

export function _setIO(custom: PaneProbeIO): void { io = custom }
export function _resetIO(): void { io = defaultIO }

// ---------------------------------------------------------------------------
// Detection patterns — anchored to the pane TAIL where the prompt renders.
// Only the last PANE_TAIL_LINES are examined, so scrollback history
// (which may contain "/login" in prose or "Entered plan mode" from a
// previous state) does not trigger detection.
//
// COUPLING: These regexes are derived from Claude Code's terminal UI strings
// (CC ~2.1.x, verified 2026-08-06/08). CC can change these at any release.
// Failure mode is graceful: missed detection → no action → session stays
// stuck until a human notices. Keys are never sent without re-verifying the
// screen state. Review these patterns after any CC major version upgrade.
// ---------------------------------------------------------------------------

// Plan mode: CC renders a multi-line dialog. On long plans, "Entered plan mode"
// scrolls above the tail — only the options menu is visible. The three-option
// menu is unique to plan mode, so we require at least two of the three options
// to co-occur (guards against a single phrase appearing in prose).
const PLAN_OPTION_A = /Yes, and bypass permissions/
const PLAN_OPTION_B = /Yes, manually approve edits/
const PLAN_OPTION_C = /Tell Claude what to change/
const PLAN_PATH_RE = /\.claude\/plans\/([^\s·/][^\s·]*\.md)/

// Login: CC renders specific prompts at each stage. Patterns derived from
// actual CC screenshots (2026-08-06).
//
// Stage 1 — expiry warning (session still works):
//   "⚠️ Your login expires in 1 day · run /login to renew"
const LOGIN_EXPIRING_PATTERNS = [
  /Your login expires in/,
  /run \/login to renew/,
]
// Stage 2 — hard block (session frozen):
//   "Login" heading + "Select login method:" menu
const LOGIN_BLOCKED_PATTERNS = [
  /^  +Login$/m,
  /Select login method:/,
]
// Stage 3 — mid-flow: browser didn't open, OAuth URL shown:
//   "Browser didn't open? Use the url below to sign in"
const LOGIN_URL_RE = /Browser didn't open/
const OAUTH_URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\S+/
// Stage 4 — success, needs Enter to dismiss:
//   "Login successful. Press Enter to continue…"
const LOGIN_SUCCESS_RE = /Login successful/
// Stage 5 — expired (past tense, session was resumed after expiry):
//   "● Login expired · Please run /login"
const LOGIN_EXPIRED_RE = /Login expired/

// Resume prompt: CC shows this when a session is resumed and the conversation
// is large enough to warrant a choice. The three-option menu is unique.
const RESUME_OPTION_A = /Resume from summary/
const RESUME_OPTION_B = /Resume full session/
const RESUME_OPTION_C = /Don't ask me again/

// ---------------------------------------------------------------------------
// Detection (pure — operates on tail text only)
// ---------------------------------------------------------------------------

export function detectBlockingState(tailText: string): BlockingState | null {
  const planOptionCount = [PLAN_OPTION_A, PLAN_OPTION_B, PLAN_OPTION_C]
    .filter(re => re.test(tailText)).length
  if (planOptionCount >= 2) {
    const pathMatch = tailText.match(PLAN_PATH_RE)
    return { kind: 'plan_mode', planPath: pathMatch?.[1] ?? null, loginStage: null, oauthUrl: null }
  }
  // Resume prompt: CC's session resume dialog blocks the session. Detect before
  // login — the resume prompt fills the tail and pushes login messages out of view.
  if (isResumePromptOnScreen(tailText)) {
    return { kind: 'resume_prompt', planPath: null, loginStage: null, oauthUrl: null }
  }
  // Login stages in priority order — later stages take precedence (the flow progresses)
  if (LOGIN_SUCCESS_RE.test(tailText)) {
    return { kind: 'login_required', planPath: null, loginStage: 'success', oauthUrl: null }
  }
  if (LOGIN_URL_RE.test(tailText)) {
    const urlMatch = tailText.match(OAUTH_URL_RE)
    return { kind: 'login_required', planPath: null, loginStage: 'oauth_url', oauthUrl: urlMatch?.[0] ?? null }
  }
  if (LOGIN_BLOCKED_PATTERNS.some(p => p.test(tailText))) {
    return { kind: 'login_required', planPath: null, loginStage: 'blocked', oauthUrl: null }
  }
  // "Login expired" is functionally identical to "blocked" — session can't proceed.
  // No separate LoginStage variant needed; the remediation path is the same.
  if (LOGIN_EXPIRED_RE.test(tailText)) {
    return { kind: 'login_required', planPath: null, loginStage: 'blocked', oauthUrl: null }
  }
  if (LOGIN_EXPIRING_PATTERNS.some(p => p.test(tailText))) {
    return { kind: 'login_required', planPath: null, loginStage: 'expiring', oauthUrl: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const probeEntries = new Map<string, ProbeEntry>()

const threadIntercepts = new Map<string, {
  tmuxName: string
  kind: BlockingKind
  handler: (content: string, channelId: string, messageId: string) => Promise<void>
}>()

export function getThreadIntercept(threadId: string) {
  return threadIntercepts.get(threadId)
}

export function clearInterceptsForSession(tmuxName: string): void {
  const entry = probeEntries.get(tmuxName)
  if (entry) {
    threadIntercepts.delete(entry.threadId)
    probeEntries.delete(tmuxName)
  }
  // Also scan by tmuxName in case the entry was already removed
  for (const [threadId, intercept] of threadIntercepts) {
    if (intercept.tmuxName === tmuxName) threadIntercepts.delete(threadId)
  }
}

// ---------------------------------------------------------------------------
// Plan file reading
// ---------------------------------------------------------------------------

function readPlanSummary(planPath: string | null): string | null {
  if (!planPath) return null
  if (planPath.includes('..')) return null
  const root = join(homedir(), '.claude', 'plans')
  const fullPath = join(root, planPath)
  if (!fullPath.startsWith(root + '/')) return null
  const content = io.readFile(fullPath)
  if (!content) return null
  const titleMatch = content.match(/^#\s+(.+)/m)
  const title = titleMatch?.[1] ?? planPath
  const body = content.replace(/^#\s+.+\n+/, '').trim()
  const preview = body.length > 500 ? body.slice(0, 497) + '...' : body
  return `**${title}**\n${preview}`
}

// ---------------------------------------------------------------------------
// Remediation — re-confirms prompt is still on screen before sending keys
// ---------------------------------------------------------------------------

function isPlanModeOnScreen(tail: string): boolean {
  return [PLAN_OPTION_A, PLAN_OPTION_B, PLAN_OPTION_C]
    .filter(re => re.test(tail)).length >= 2
}

async function confirmAndApprovePlan(tmuxName: string): Promise<boolean> {
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isPlanModeOnScreen(tail)) return false
  return io.sendKeys(tmuxName, 'Enter')
}

async function confirmAndRejectPlan(tmuxName: string): Promise<boolean> {
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isPlanModeOnScreen(tail)) return false
  return io.sendKeys(tmuxName, 'Down', 'Down', 'Enter')
}

function autoLoginEnabled(): boolean {
  const v = process.env.HYDRA_AUTO_LOGIN?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'claude'
}

async function confirmAndSendLogin(tmuxName: string): Promise<boolean> {
  if (!autoLoginEnabled()) return false
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail) return false
  if (isResumePromptOnScreen(tail)) return false
  const blocked = LOGIN_BLOCKED_PATTERNS.some(p => p.test(tail))
  const expired = LOGIN_EXPIRED_RE.test(tail)
  const expiring = LOGIN_EXPIRING_PATTERNS.some(p => p.test(tail))
  if (!blocked && !expired && !expiring) return false
  return io.sendKeys(tmuxName, '/login', 'Enter')
}

async function confirmAndDismissLoginSuccess(tmuxName: string): Promise<boolean> {
  if (!autoLoginEnabled()) return false
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail) return false
  if (!LOGIN_SUCCESS_RE.test(tail)) return false
  return io.sendKeys(tmuxName, 'Enter')
}

function isResumePromptOnScreen(tail: string): boolean {
  return [RESUME_OPTION_A, RESUME_OPTION_B, RESUME_OPTION_C]
    .filter(re => re.test(tail)).length >= 2
}

async function confirmAndDismissResumePrompt(tmuxName: string): Promise<boolean> {
  if (!autoLoginEnabled()) return false
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isResumePromptOnScreen(tail)) return false
  // CC pre-selects option 1 ("Resume from summary"). Enter confirms it.
  return io.sendKeys(tmuxName, 'Enter')
}

async function extractOauthUrl(tmuxName: string): Promise<string | null> {
  const tail = await io.capturePaneTail(tmuxName, PANE_TAIL_LINES * 4)
  if (!tail) return null
  const match = tail.match(OAUTH_URL_RE)
  return match?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Notification + intercept registration
// ---------------------------------------------------------------------------

async function notifyPlanMode(entry: ProbeEntry, now: number): Promise<void> {
  if (entry.notifying) return
  entry.notifying = true

  try {
    const planSummary = readPlanSummary(entry.state.planPath)
    const name = entry.tmuxName
    const channelId = entry.threadId

    if (!channelId) {
      process.stderr.write(`daemon: pane-probe: ${name} in plan mode but no channel\n`)
      return
    }

    const lines = [
      `> ⏸️ **${name}** is waiting for plan approval.`,
    ]
    if (planSummary) {
      lines.push(`> ${planSummary.split('\n').join('\n> ')}`)
    }
    lines.push(`> Type **approve** to proceed or **reject** to cancel.`)

    await safeSend(channelId, lines.join('\n'))
    entry.notifiedAt = now
    entry.notifyCount++

    threadIntercepts.set(entry.threadId, {
      tmuxName: name,
      kind: 'plan_mode',
      handler: async (content, replyChannelId, messageId) => {
        const lower = content.trim().toLowerCase()
        if (lower === 'approve') {
          const ok = await confirmAndApprovePlan(name)
          void gateway.react(replyChannelId, messageId, ok ? '✅' : '❌').catch(() => {})
          if (ok) {
            void safeSend(channelId, `> ▶️ **${name}** — plan approved, resuming.`)
            threadIntercepts.delete(entry.threadId)
            probeEntries.delete(name)
          } else {
            void safeSend(channelId, `> ❌ **${name}** — plan prompt no longer on screen. May have already resumed.`)
            threadIntercepts.delete(entry.threadId)
            // Keep probeEntry as a notifyCount tombstone — the intercept is gone so
            // no commands are swallowed, but the count survives so a re-detection
            // on the next probe cycle respects MAX_NOTIFICATIONS.
          }
        } else if (lower === 'reject') {
          const ok = await confirmAndRejectPlan(name)
          void gateway.react(replyChannelId, messageId, ok ? '✅' : '❌').catch(() => {})
          if (ok) {
            void safeSend(channelId, `> ⏹️ **${name}** — plan rejected.`)
          }
          threadIntercepts.delete(entry.threadId)
          probeEntries.delete(name)
        }
      },
    })

    process.stderr.write(`daemon: pane-probe: ${name} in plan mode, notified in ${channelId}\n`)
  } finally {
    entry.notifying = false
  }
}

async function notifyLoginRequired(entry: ProbeEntry, now: number): Promise<void> {
  if (entry.notifying) return
  entry.notifying = true

  try {
    const name = entry.tmuxName
    const stage = entry.state.loginStage
    const access = loadAccess()
    const adminUserId = access.allowFrom[0]

    let channelId: string
    let mention = ''

    if (entry.isMain) {
      channelId = DEFAULT_SESSION_CHANNEL
      if (adminUserId) mention = `<@${adminUserId}> `
    } else {
      channelId = entry.threadId
    }

    if (!channelId) {
      process.stderr.write(`daemon: pane-probe: ${name} needs login but no channel\n`)
      return
    }

    let lines: string[]

    if (stage === 'success') {
      // Login succeeded — dismiss with Enter
      const dismissed = await confirmAndDismissLoginSuccess(name)
      lines = [
        `> ✅ **${name}** — login successful.`,
        dismissed
          ? `> Dismissed automatically. Session resuming.`
          : `> Press Enter in the session to continue: \`tmux attach -t ${name}\``,
      ]
    } else if (stage === 'oauth_url') {
      // OAuth URL is showing — extract and post it
      const url = entry.state.oauthUrl ?? await extractOauthUrl(name)
      lines = [
        `> 🔗 ${mention}**${name}** — authenticate here:`,
        url ? `> ${url}` : `> _Could not extract URL. Run: \`tmux attach -t ${name}\`_`,
      ]
    } else if (stage === 'expiring') {
      const loginSent = await confirmAndSendLogin(name)
      lines = [
        `> 🔑 ${mention}**${name}** — login expiring soon.`,
        loginSent
          ? `> Sent \`/login\` to renew. If a browser auth URL appears, click it.`
          : `> Run: \`tmux attach -t ${name}\` then type \`/login\``,
      ]
    } else {
      // blocked — "Select login method:" prompt
      const loginSent = await confirmAndSendLogin(name)
      lines = [
        `> ⚠️ ${mention}**${name}** needs authentication${entry.isMain ? ' — all message processing is paused' : ''}.`,
        loginSent
          ? `> Sent \`/login\` automatically. If a browser auth URL appears, click it to authenticate.`
          : `> Run: \`tmux attach -t ${name}\` then type \`/login\``,
      ]
    }

    await safeSend(channelId, lines.join('\n'))
    entry.notifiedAt = now
    entry.notifyCount++

    process.stderr.write(`daemon: pane-probe: ${name} login stage=${stage}, notified\n`)
  } finally {
    entry.notifying = false
  }
}

async function notifyResumePrompt(entry: ProbeEntry, now: number): Promise<void> {
  if (entry.notifying) return
  entry.notifying = true

  try {
    const name = entry.tmuxName
    const channelId = entry.isMain ? DEFAULT_SESSION_CHANNEL : entry.threadId

    if (!channelId) {
      process.stderr.write(`daemon: pane-probe: ${name} stuck on resume prompt but no channel\n`)
      return
    }

    const dismissed = await confirmAndDismissResumePrompt(name)

    const lines = dismissed
      ? [
          `> ▶️ **${name}** — auto-dismissed resume prompt (resuming from summary).`,
        ]
      : [
          `> ⏸️ **${name}** is stuck on a resume prompt.`,
          `> Run: \`tmux attach -t ${name}\` and choose a resume option.`,
        ]

    await safeSend(channelId, lines.join('\n'))
    entry.notifiedAt = now
    entry.notifyCount++

    process.stderr.write(`daemon: pane-probe: ${name} resume prompt, dismissed=${dismissed}\n`)
  } finally {
    entry.notifying = false
  }
}

// ---------------------------------------------------------------------------
// Main probe loop — called from daemon.ts setInterval
// ---------------------------------------------------------------------------

function byteTmuxName(): string {
  return process.env.BYTE_SESSION_NAME ?? `${PLATFORM}-byte`
}

// ---------------------------------------------------------------------------
// Idle builder nudge — detect factory builders that go idle without calling
// factory_done. Sends a bridge notification (not sendKeys) so CC processes
// it as input on its next turn.
// ---------------------------------------------------------------------------

const builderNudges = new Map<string, { count: number; lastNudge: number }>()

const BUILDER_BRIDGELESS_ABORT_S = 120

function nudgeIdleBuilder(info: SessionInfo, idleSec: number, now: number): void {
  const key = info.sessionId
  const connected = transport.has(info.sessionId)

  if (!connected && idleSec >= BUILDER_BRIDGELESS_ABORT_S) {
    process.stderr.write(`daemon: pane-probe: builder ${info.tmuxName} idle ${idleSec}s with no bridge — notifying PM thread\n`)
    void safeSend(info.factoryPmThreadId ?? info.threadId, [
      `> ⚠️ **${info.tmuxName}** — factory builder lost its bridge connection (idle ${idleSec}s, no MCP tools).`,
      `> The builder cannot work without tools. Use \`factory_abandon("${info.factoryTicket}")\` to abort, or wait for it to reconnect.`,
    ].join('\n'))
    builderNudges.set(key, { count: BUILDER_MAX_NUDGES, lastNudge: now })
    return
  }

  const entry = builderNudges.get(key) ?? { count: 0, lastNudge: 0 }
  if (entry.count >= BUILDER_MAX_NUDGES) return
  if (now - entry.lastNudge < NOTIFY_COOLDOWN_MS) return

  entry.count++
  entry.lastNudge = now
  builderNudges.set(key, entry)

  transport.sendOrQueue(info.sessionId, {
    type: 'notification',
    content: `[system] You appear idle (${idleSec}s). You are a factory builder — your task is not complete until you call factory_done with your results. Continue working on the spec and call factory_done when done.`,
    meta: { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  process.stderr.write(`daemon: pane-probe: nudged idle builder ${info.tmuxName} (${entry.count}/${BUILDER_MAX_NUDGES}, idle ${idleSec}s)\n`)
}

export function clearBuilderNudge(sessionId: string): void {
  builderNudges.delete(sessionId)
}

// Heartbeat: periodic log so total silence is distinguishable from "nothing stuck"
let _probeCount = 0
let _detectCount = 0
let _lastHeartbeat = 0
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60_000 // 6 hours

export async function probeAllSessions(now?: number): Promise<void> {
  const t = now ?? io.now()
  const nowSec = Math.floor(t / 1000)
  _probeCount++

  if (_lastHeartbeat === 0) _lastHeartbeat = t
  if (t - _lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    process.stderr.write(`daemon: pane-probe heartbeat: ${_probeCount} probes, ${_detectCount} detections, ${probeEntries.size} active entries\n`)
    _probeCount = 0
    _detectCount = 0
    _lastHeartbeat = t
  }

  const targets: Array<{ tmuxName: string; threadId: string; isMain: boolean }> = []
  targets.push({ tmuxName: byteTmuxName(), threadId: DEFAULT_SESSION_CHANNEL, isMain: true })

  for (const info of registry.values()) {
    if (info.deadAt) continue
    if (info.engine === 'codex') continue
    targets.push({ tmuxName: info.tmuxName, threadId: info.threadId, isMain: false })
  }

  for (const target of targets) {
    const key = target.tmuxName

    // Idle gate: only probe sessions that have been idle for MIN_IDLE_BEFORE_PROBE_S.
    // Active sessions aren't stuck on a prompt — the scrollback may contain
    // historical plan-mode text but the session has moved on.
    const lastActivitySec = await io.getWindowActivity(target.tmuxName)
    if (lastActivitySec === null) {
      clearState(key, 0) // tmux gone — force-clear, no grace
      continue
    }
    const idleSec = nowSec - lastActivitySec
    if (idleSec < MIN_IDLE_BEFORE_PROBE_S) {
      clearState(key, t) // active — grace period for pending intercepts
      continue
    }

    // Capture only the tail — where the active prompt renders
    const tailText = await io.capturePaneTail(target.tmuxName, PANE_TAIL_LINES)
    if (!tailText) {
      clearState(key, 0) // capture failed — force-clear
      continue
    }

    const detected = detectBlockingState(tailText)

    if (!detected) {
      clearState(key, t) // no detection — grace period for pending intercepts
      // Idle builder nudge: session is idle, no blocking prompt, but it's a
      // factory builder that hasn't completed. Nudge via bridge notification.
      if (idleSec >= BUILDER_IDLE_NUDGE_S) {
        const info = [...registry.values()].find(s => s.tmuxName === target.tmuxName && !s.deadAt)
        if (info?.isFactoryBuilder && info.factoryPhase === 'building') {
          nudgeIdleBuilder(info, idleSec, t)
        }
      }
      continue
    }
    _detectCount++

    const existing = probeEntries.get(key)
    if (existing && existing.state.kind === detected.kind) {
      // Login stage progression — notify immediately without debounce
      const stageChanged = detected.kind === 'login_required' &&
        existing.state.loginStage !== detected.loginStage
      if (stageChanged) {
        existing.state = detected
        existing.notifiedAt = null
        existing.notifyCount = 0
        void notifyLoginRequired(existing, t)
        continue
      }

      existing.consecutive++

      if (existing.consecutive >= CONFIRM_PROBES) {
        const cooldownElapsed = !existing.notifiedAt || (t - existing.notifiedAt) >= NOTIFY_COOLDOWN_MS
        const effectiveMax = (detected.kind === 'login_required' && detected.loginStage === 'success') ? 1 : MAX_NOTIFICATIONS
        const underLimit = existing.notifyCount < effectiveMax

        if (cooldownElapsed && underLimit) {
          if (detected.kind === 'plan_mode') {
            void notifyPlanMode(existing, t)
          } else if (detected.kind === 'resume_prompt') {
            void notifyResumePrompt(existing, t)
          } else {
            void notifyLoginRequired(existing, t)
          }
        } else if (!underLimit && existing.notifyCount === effectiveMax) {
          existing.notifyCount++
          process.stderr.write(`daemon: pane-probe: ${key} still stuck after ${effectiveMax} notifications, giving up\n`)
        }
      }
    } else {
      probeEntries.set(key, {
        tmuxName: target.tmuxName,
        threadId: target.threadId,
        isMain: target.isMain,
        firstSeen: t,
        consecutive: 1,
        state: detected,
        notifiedAt: null,
        notifyCount: 0,
        notifying: false,
      })
    }
  }
}

function clearState(key: string, now: number): void {
  const existing = probeEntries.get(key)
  if (!existing) return

  // If we notified the user and registered an intercept, keep it alive for
  // INTERCEPT_GRACE_MS after detection clears — the user may not have typed
  // "approve" yet. Force-clear (now=0) skips the grace period.
  if (now > 0 && existing.notifiedAt && threadIntercepts.has(existing.threadId)) {
    const elapsed = now - existing.notifiedAt
    if (elapsed < INTERCEPT_GRACE_MS) return
  }

  threadIntercepts.delete(existing.threadId)
  probeEntries.delete(key)
  if (existing.notifyCount > 0) {
    process.stderr.write(`daemon: pane-probe: ${key} cleared\n`)
  }
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  probeEntries.clear()
  threadIntercepts.clear()
  builderNudges.clear()
}

export const _CONFIRM_PROBES = CONFIRM_PROBES
export const _NOTIFY_COOLDOWN_MS = NOTIFY_COOLDOWN_MS
export const _MAX_NOTIFICATIONS = MAX_NOTIFICATIONS
export const _MIN_IDLE_BEFORE_PROBE_S = MIN_IDLE_BEFORE_PROBE_S
export const _PANE_TAIL_LINES = PANE_TAIL_LINES
export const _INTERCEPT_GRACE_MS = INTERCEPT_GRACE_MS
