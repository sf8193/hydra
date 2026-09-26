// Dependency-free so raindrop-payload.ts can gate on these sets without pulling
// fs and the projects-root reader into the wire-shaping module.
export const USAGE_PHASES = ['plan', 'execute', 'review', 'report'] as const
export type UsagePhase = typeof USAGE_PHASES[number]

// `tools` means a turn in the READ that produced the row chose the phase;
// `latched` means it was carried and nothing in that read voted. Without the
// split, `plan` rows claim a tool chose them when nextLatch has no branch that can.
export const USAGE_PHASE_SOURCES = ['protocol', 'tools', 'latched'] as const
export type UsagePhaseSource = typeof USAGE_PHASE_SOURCES[number]

// The phases a session can be held in BETWEEN turns. Measured on four real
// transcripts: latching `report` billed runs of up to 135 consecutive Bash turns
// as reporting, 45-83% of spend against the ledger's 17%. `plan` is out for the
// mirror-image reason — letting read-only tools vote it put 98% in one bucket.
export type LatchPhase = Exclude<UsagePhase, 'report'>
export const INITIAL_PHASE: LatchPhase = 'plan'

const DELEGATION_TOOLS = new Set(['Agent', 'Task'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// `edit_message` is excluded: it is documented as an interim update DURING long
// work. The `^` alternative covers a bare name; the bridge exposes both forms.
const REPORT_TOOL = /(?:^|__)(?:reply|send_to_thread|slack_send_message|advance)$/

export function isUsagePhase(v: unknown): v is UsagePhase {
  return typeof v === 'string' && (USAGE_PHASES as readonly string[]).includes(v)
}

export function isLatchPhase(v: unknown): v is LatchPhase {
  return isUsagePhase(v) && v !== 'report'
}

// What this turn's tools actually chose, or undefined if they said nothing.
// Delegating beats editing: the edit is the handoff being prepared.
export function latchVote(names: readonly string[]): LatchPhase | undefined {
  if (names.some(n => DELEGATION_TOOLS.has(n))) return 'review'
  if (names.some(n => EDIT_TOOLS.has(n))) return 'execute'
  return undefined
}

export function nextLatch(current: LatchPhase, names: readonly string[]): LatchPhase {
  return latchVote(names) ?? (isLatchPhase(current) ? current : INITIAL_PHASE)
}

// Momentary, not latched — see LatchPhase. A turn that replies AND does anything
// else is that other thing.
export function isReportTurn(names: readonly string[]): boolean {
  return names.length > 0 && names.every(n => REPORT_TOOL.test(n))
}

export function phaseForTurn(latch: LatchPhase, names: readonly string[]): UsagePhase {
  return isReportTurn(names) ? 'report' : latch
}

// `mcp_tool_use` and `server_tool_use` also carry a name, so the type is
// checked, not assumed — only `tool_use` blocks, and only their `name`.
export function toolNamesFrom(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown }
    if (b?.type === 'tool_use' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}
