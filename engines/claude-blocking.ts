// Claude Code's blocking screens (plan mode, login, resume prompt, usage limit, unknown dialog) read off the pane tail: pure text matching, no I/O.
// CC-specific and coupled to its terminal strings; app/pane-probe.ts probes the panes and acts on what this finds.

import type { BlockingKind, BlockingState, LoginStage } from './engine-adapter.js'

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
export const PLAN_OPTION_A = /Yes, and bypass permissions/
export const PLAN_OPTION_B = /Yes, manually approve edits/
export const PLAN_OPTION_C = /Tell Claude what to change/
// Plans live under Claude's config dir, which may not be ~/.claude; readPlanSummary confines the read.
const PLAN_PATH_RE = /\/plans\/([^\s·/][^\s·]*\.md)/

// Login: CC renders specific prompts at each stage. Patterns derived from
// actual CC screenshots (2026-08-06).
//
// Stage 1 — expiry warning (session still works):
//   "⚠️ Your login expires in 1 day · run /login to renew"
export const LOGIN_EXPIRING_PATTERNS = [
  /Your login expires in/,
  /run \/login to renew/,
]
// Stage 2 — hard block (session frozen):
//   "Login" heading + "Select login method:" menu
export const LOGIN_BLOCKED_PATTERNS = [
  /^  +Login$/m,
  /Select login method:/,
]
// Stage 3 — mid-flow: browser didn't open, OAuth URL shown:
//   "Browser didn't open? Use the url below to sign in"
const LOGIN_URL_RE = /Browser didn't open/
export const OAUTH_URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\S+/
// Stage 4 — success, needs Enter to dismiss:
//   "Login successful. Press Enter to continue…"
// Require the full prompt, not bare "Login successful" — the short phrase
// lingers in scrollback after the session resumes and matched forever.
export const LOGIN_SUCCESS_RE = /Login successful\.? Press Enter to continue/
// Stage 5 — expired (past tense, session was resumed after expiry):
//   "● Login expired · Please run /login"
export const LOGIN_EXPIRED_RE = /Login expired/

// A live CC REPL renders a bare prompt caret alone on a line and a "ctx: N%"
// footer line. Either alone means the session is at a working input prompt, so a
// login banner in the tail is stale scrollback ABOVE it — not the active screen.
// Both markers are line-anchored and REPL-specific; no login/blocking screen
// renders either. OR (not AND) on purpose: the tail is only PANE_TAIL_LINES and
// a multi-line draft makes the caret line non-bare, so requiring both would miss
// a truncated-but-live tail and let the flap back in.
const WORKING_PROMPT_RE = /^\s*❯\s*$/m
const CTX_FOOTER_RE = /^\s*ctx:\s*\d+%/m

export function hasLiveReplPrompt(tail: string): boolean {
  return WORKING_PROMPT_RE.test(tail) || CTX_FOOTER_RE.test(tail)
}

// Resume prompt: CC shows this when a session is resumed and the conversation
// is large enough to warrant a choice. The three-option menu is unique.
// Usage-limit dialog (/rate-limit-options): blocks all input until dismissed, even after the limit resets.
// Footers vary by dialog ("Enter to confirm · Esc to cancel", "Esc to cancel · Tab to amend",
// "Enter to select · ↑/↓ to navigate · Esc to cancel"); the Esc hint is what they share.
const DIALOG_FOOTER_RE = /Esc to cancel/
// Startup gates (workspace trust, the bypass-permissions warning) offer "No, exit": cancelling one
// exits Claude, so Esc would end the session.
const ESC_ENDS_SESSION_RE = /No, exit/
export const USAGE_OPTION_A = /Stop and wait for limit to reset/
export const USAGE_OPTION_B = /Add funds to continue with extra usage/
export const USAGE_OPTION_C = /Upgrade your plan/
export const USAGE_OPTION_WAIT = /Wait here, then continue automatically/
export const USAGE_RESUME_AT_RE = /continue automatically at ([^\n│]+?)\s*(?:│|$)/m
export const USAGE_LIMIT_NAME_RE = /You've hit your ([^\n│·]*?limit)/
export const RESUME_OPTION_A = /Resume from summary/
export const RESUME_OPTION_B = /Resume full session/
export const RESUME_OPTION_C = /Don't ask me again/

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
  const liveRepl = hasLiveReplPrompt(tailText)
  // Dialogs replace the prompt; a bare live `❯` means this is stale scrollback (same gate as login below).
  if (!liveRepl && isUsageLimitOnScreen(tailText)) {
    return { kind: 'usage_limit', planPath: null, loginStage: null, oauthUrl: null }
  }
  // Full-screen login stages fill the pane — a live REPL prompt in the tail
  // means the banner is stale scrollback, not the active screen. Gate them so
  // a resumed session at a working `❯` prompt doesn't re-trigger every cycle.
  // Login stages in priority order — later stages take precedence (the flow progresses)
  if (!liveRepl && LOGIN_SUCCESS_RE.test(tailText)) {
    return { kind: 'login_required', planPath: null, loginStage: 'success', oauthUrl: null }
  }
  if (!liveRepl && LOGIN_URL_RE.test(tailText)) {
    const urlMatch = tailText.match(OAUTH_URL_RE)
    return { kind: 'login_required', planPath: null, loginStage: 'oauth_url', oauthUrl: urlMatch?.[0] ?? null }
  }
  if (!liveRepl && LOGIN_BLOCKED_PATTERNS.some(p => p.test(tailText))) {
    return { kind: 'login_required', planPath: null, loginStage: 'login-blocked', oauthUrl: null }
  }
  // "Login expired" is functionally identical to "login-blocked" — session can't proceed.
  // No separate LoginStage variant needed; the remediation path is the same.
  // Gated on liveRepl too: a genuine expiry freezes the pane (no working prompt);
  // the banner above a live `❯` is stale scrollback from a resumed session.
  if (!liveRepl && LOGIN_EXPIRED_RE.test(tailText)) {
    return { kind: 'login_required', planPath: null, loginStage: 'login-blocked', oauthUrl: null }
  }
  // Expiring is a footer warning that co-renders WITH the working prompt, so it
  // is intentionally not gated on liveRepl — the latch below bounds its spam.
  if (LOGIN_EXPIRING_PATTERNS.some(p => p.test(tailText))) {
    return { kind: 'login_required', planPath: null, loginStage: 'expiring', oauthUrl: null }
  }
  // Fallback: every CC selection dialog ends with this footer. Known kinds above
  // get specific handling; anything else is surfaced so a new dialog can't block silently.
  if (!liveRepl && DIALOG_FOOTER_RE.test(tailText)) {
    return { kind: 'unknown_dialog', planPath: null, loginStage: null, oauthUrl: null, escEndsSession: ESC_ENDS_SESSION_RE.test(tailText) }
  }
  return null
}

export function isUsageLimitOnScreen(tail: string): boolean {
  return [USAGE_OPTION_A, USAGE_OPTION_B, USAGE_OPTION_C, USAGE_OPTION_WAIT].filter(re => re.test(tail)).length >= 2
}

export function isResumePromptOnScreen(tail: string): boolean {
  return [RESUME_OPTION_A, RESUME_OPTION_B, RESUME_OPTION_C]
    .filter(re => re.test(tail)).length >= 2
}
