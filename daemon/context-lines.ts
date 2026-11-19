// The context percents hydra acts on, in one place: the push (session-health.ts) and the automatic handoffs
// (auto-handoff.ts) read these, and docs/handoff.md "Context lines" lists them (a test pins that it does).
// Each is a percent of the session's context window, as `usage` and `hydra list` show it.

/** Always on: the operator is told once per climb past each line. */
export const CONTEXT_ALERT_LINES: readonly number[] = [50, 70]

/** AUTO_HANDOFF_CACHE=1: an idle session at or past this hands off while its prompt cache is warm. */
export const CACHE_HANDOFF_LINE = 50

/** AUTO_HANDOFF_FULL=1: an idle session at or past this is asked to hand off; AUTO_HANDOFF_FULL_PCT or a specialist's handoff_at_pct moves it. */
export const FULL_HANDOFF_DEFAULT_LINE = 85
