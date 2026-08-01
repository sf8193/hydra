/**
 * tmux panes inherit RLIMIT_NOFILE from the tmux *server*, not from whoever ran
 * `new-session`. A server started by launchd carries the macOS default of 256
 * and holds it for its entire lifetime, so a shell with a high limit still
 * spawns constrained panes.
 *
 * Headroom is the lesser reason to raise it. The greater one is diagnostic:
 * bun attributes unrelated startup failures to "possibly due to low max file
 * descriptors", quoting whatever ceiling is in effect. Under a low ceiling that
 * message is emitted for faults with no descriptor involvement at all — a
 * permission denial on the working directory reads identically to exhaustion.
 * Raising the limit removes the false attribution along with the constraint.
 *
 * Separated by `;` rather than `&&`, with stderr discarded, so a shell that
 * rejects the call still runs the command.
 */
export const TMUX_PANE_FD_LIMIT = 65536

export function withRaisedFdLimit(command: string): string {
  return `ulimit -n ${TMUX_PANE_FD_LIMIT} 2>/dev/null; ${command}`
}
