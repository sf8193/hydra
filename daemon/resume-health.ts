/**
 * Discriminates two causes of a bridge timeout after resume:
 *
 * (a) Claude never started or already exited — nothing valuable exists.
 *     Kill is correct; the cascade should proceed to the next tier.
 *
 * (b) Claude is running with restored context but the bridge hasn't
 *     connected — an orphan worth preserving. Killing discards recovered
 *     context; cascading spawns a duplicate.
 *
 * The exit-marker file is written by the spawn wrapper when Claude exits
 * (session-lifecycle.ts). Its presence is authoritative: Claude is done.
 * tmux liveness without an exit marker means Claude is still running —
 * but only when the exit file path was configured. When pane capture
 * failed and no path exists, we cannot distinguish "exited" from
 * "running", so we default to kill (absence of evidence is not evidence
 * of liveness).
 *
 * See also: daemon/session-health.ts periodic orphan detector, which checks
 * the same condition (tmux-alive + bridge-absent) for long-running sessions.
 * Both paths must preserve — if this predicate kills and that one preserves,
 * or vice versa, the incoherence is itself a bug.
 *
 * Pure so it can be unit-tested without the process layer.
 */
export function classifyResumeFailure(opts: {
  /** CC process inside the pane is alive (pane_dead=0). */
  processAlive: boolean
  /** The spawn wrapper's exit-marker file exists on disk. */
  hasExitMarker: boolean
  /** Whether an exit-marker path was configured for this session. */
  hasExitFilePath: boolean
}): 'kill' | 'orphan' {
  if (opts.hasExitMarker || !opts.processAlive) return 'kill'
  if (!opts.hasExitFilePath) return 'kill'
  return 'orphan'
}
