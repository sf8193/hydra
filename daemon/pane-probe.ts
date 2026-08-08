// Pane probe: detect CC sessions stuck on interactive prompts (plan mode,
// login required) by periodically capturing tmux pane text and pattern
// matching against the pane TAIL (where the active prompt renders).
//
// CC-specific — coupled to Claude Code's terminal UI strings. When a
// second harness arrives, introduce a HarnessProbe interface.
//
// Injectable seams: capturePaneTail, getWindowActivity, sendKeys, readFile
// are replaceable for testing.

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { registry } from './sessions.js'
import type { SessionInfo } from './sessions.js'
import { gateway, PLATFORM, DEFAULT_SESSION_CHANNEL } from './config.js'
import { loadAccess } from './access.js'
import { safeSend } from './util.js'

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

// ---------------------------------------------------------------------------
// Injectable seams (tests replace these)
// ---------------------------------------------------------------------------

export type PaneProbeIO = {
  capturePaneTail: (tmuxName: string, lines: number) => string | null
  getWindowActivity: (tmuxName: string) => number | null
  sendKeys: (tmuxName: string, ...keys: string[]) => boolean
  readFile: (path: string) => string | null
  now: () => number
}

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

const defaultIO: PaneProbeIO = {
  capturePaneTail(tmuxName, lines) {
    try {
      return execSync(
        `tmux capture-pane -t ${shq(tmuxName)} -p -S -${lines}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      ).trimEnd()
    } catch { return null }
  },

  getWindowActivity(tmuxName) {
    try {
      const raw = execSync(
        `tmux display -t ${shq(tmuxName)} -p '#{window_activity}'`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 },
      ).trim()
      return parseInt(raw, 10) || null
    } catch { return null }
  },

  sendKeys(tmuxName, ...keys) {
    try {
      execSync(['tmux', 'send-keys', '-t', tmuxName, ...keys].map(shq).join(' '), {
        stdio: 'pipe', timeout: 3000,
      })
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
  const resumeOptionCount = [RESUME_OPTION_A, RESUME_OPTION_B, RESUME_OPTION_C]
    .filter(re => re.test(tailText)).length
  if (resumeOptionCount >= 2) {
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

function confirmAndApprovePlan(tmuxName: string): boolean {
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isPlanModeOnScreen(tail)) return false
  return io.sendKeys(tmuxName, 'Enter')
}

function confirmAndRejectPlan(tmuxName: string): boolean {
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isPlanModeOnScreen(tail)) return false
  return io.sendKeys(tmuxName, 'Down', 'Down', 'Enter')
}

function autoLoginEnabled(): boolean {
  const v = process.env.HYDRA_AUTO_LOGIN?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'claude'
}

function confirmAndSendLogin(tmuxName: string): boolean {
  if (!autoLoginEnabled()) return false
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail) return false
  const blocked = LOGIN_BLOCKED_PATTERNS.some(p => p.test(tail))
  const expired = LOGIN_EXPIRED_RE.test(tail)
  const expiring = LOGIN_EXPIRING_PATTERNS.some(p => p.test(tail))
  if (!blocked && !expired && !expiring) return false
  return io.sendKeys(tmuxName, '/login', 'Enter')
}

function confirmAndDismissLoginSuccess(tmuxName: string): boolean {
  if (!autoLoginEnabled()) return false
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail) return false
  if (!LOGIN_SUCCESS_RE.test(tail)) return false
  return io.sendKeys(tmuxName, 'Enter')
}

function isResumePromptOnScreen(tail: string): boolean {
  return [RESUME_OPTION_A, RESUME_OPTION_B, RESUME_OPTION_C]
    .filter(re => re.test(tail)).length >= 2
}

function confirmAndDismissResumePrompt(tmuxName: string): boolean {
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES)
  if (!tail || !isResumePromptOnScreen(tail)) return false
  return io.sendKeys(tmuxName, 'Enter')
}

function extractOauthUrl(tmuxName: string): string | null {
  const tail = io.capturePaneTail(tmuxName, PANE_TAIL_LINES * 4)
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
          const ok = confirmAndApprovePlan(name)
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
          const ok = confirmAndRejectPlan(name)
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
      const dismissed = confirmAndDismissLoginSuccess(name)
      lines = [
        `> ✅ **${name}** — login successful.`,
        dismissed
          ? `> Dismissed automatically. Session resuming.`
          : `> Press Enter in the session to continue: \`tmux attach -t ${name}\``,
      ]
    } else if (stage === 'oauth_url') {
      // OAuth URL is showing — extract and post it
      const url = entry.state.oauthUrl ?? extractOauthUrl(name)
      lines = [
        `> 🔗 ${mention}**${name}** — authenticate here:`,
        url ? `> ${url}` : `> _Could not extract URL. Run: \`tmux attach -t ${name}\`_`,
      ]
    } else if (stage === 'expiring') {
      const loginSent = confirmAndSendLogin(name)
      lines = [
        `> 🔑 ${mention}**${name}** — login expiring soon.`,
        loginSent
          ? `> Sent \`/login\` to renew. If a browser auth URL appears, click it.`
          : `> Run: \`tmux attach -t ${name}\` then type \`/login\``,
      ]
    } else {
      // blocked — "Select login method:" prompt
      const loginSent = confirmAndSendLogin(name)
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

    const dismissed = confirmAndDismissResumePrompt(name)

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

export function probeAllSessions(now?: number): void {
  const t = now ?? io.now()
  const nowSec = Math.floor(t / 1000)

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
    const lastActivitySec = io.getWindowActivity(target.tmuxName)
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
    const tailText = io.capturePaneTail(target.tmuxName, PANE_TAIL_LINES)
    if (!tailText) {
      clearState(key, 0) // capture failed — force-clear
      continue
    }

    const detected = detectBlockingState(tailText)

    if (!detected) {
      clearState(key, t) // no detection — grace period for pending intercepts
      continue
    }

    const existing = probeEntries.get(key)
    if (existing && existing.state.kind === detected.kind) {
      // Login stage progression — notify immediately without debounce
      const stageChanged = detected.kind === 'login_required' &&
        existing.state.loginStage !== detected.loginStage
      if (stageChanged) {
        existing.state = detected
        existing.notifiedAt = null // reset cooldown for new stage
        void notifyLoginRequired(existing, t)
        continue
      }

      existing.consecutive++

      if (existing.consecutive >= CONFIRM_PROBES) {
        const cooldownElapsed = !existing.notifiedAt || (t - existing.notifiedAt) >= NOTIFY_COOLDOWN_MS
        const underLimit = existing.notifyCount < MAX_NOTIFICATIONS

        if (cooldownElapsed && underLimit) {
          if (detected.kind === 'plan_mode') {
            void notifyPlanMode(existing, t)
          } else if (detected.kind === 'resume_prompt') {
            void notifyResumePrompt(existing, t)
          } else {
            void notifyLoginRequired(existing, t)
          }
        } else if (!underLimit && existing.notifyCount === MAX_NOTIFICATIONS) {
          existing.notifyCount++
          process.stderr.write(`daemon: pane-probe: ${key} still stuck after ${MAX_NOTIFICATIONS} notifications, giving up\n`)
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
}

export const _CONFIRM_PROBES = CONFIRM_PROBES
export const _NOTIFY_COOLDOWN_MS = NOTIFY_COOLDOWN_MS
export const _MAX_NOTIFICATIONS = MAX_NOTIFICATIONS
export const _MIN_IDLE_BEFORE_PROBE_S = MIN_IDLE_BEFORE_PROBE_S
export const _PANE_TAIL_LINES = PANE_TAIL_LINES
export const _INTERCEPT_GRACE_MS = INTERCEPT_GRACE_MS
