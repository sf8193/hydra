/**
 * Duplicate-'main' guard (secondary defense).
 *
 * Primary defense: bridge.ts requires HYDRA_ROLE=main to claim the 'main'
 * session id. Unconfigured bridges get a random ephemeral id instead of
 * defaulting to 'main'. This eliminates the terminal-session ping-pong.
 *
 * This guard remains as a secondary defense for the residual case: two byte
 * processes both declaring HYDRA_ROLE=main (e.g. a stale byte surviving a
 * restart). 'main' is exempt from the flap circuit breaker (we must never
 * tmux-kill the control session), so without this guard two declared bytes
 * would still evict each other unboundedly.
 *
 * Pure so it can be unit-tested without the socket layer.
 */
export function shouldHoldIncumbentMain(opts: {
  /** A different live socket already holds 'main'. */
  hasOtherIncumbent: boolean
  /** Registration rate for 'main' just crossed the flap threshold. */
  flapping: boolean
  /** Current time (ms). */
  now: number
  /** Refuse newcomers until this time (set when a flap was last detected). */
  cooldownUntil: number
}): boolean {
  if (!opts.hasOtherIncumbent) return false
  return opts.flapping || opts.now < opts.cooldownUntil
}
