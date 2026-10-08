import type { SessionRateLimit } from 'claude-code'

// The report_usage tool's input: Claude Code's rate-limit windows in the bridge's snake_case.
// Every kind is passed on; the daemon keeps the ones it alerts on (five_hour, seven_day).
export function usageReport(rateLimits: SessionRateLimit[]) {
  return { rate_limits: rateLimits.map(r => ({ kind: r.kind, percent_used: r.percentUsed, ...(r.resetsAt ? { resets_at: r.resetsAt } : {}) })) }
}
