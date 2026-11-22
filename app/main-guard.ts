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

export type SessionFlapAction = 'accept' | 'refuse' | 'hold' | 'kill'

/**
 * A registration for a spawned (non-'main') session id. The flap circuit breaker used to kill
 * the session whenever its id re-registered 10+ times in a minute. But a second process that
 * inherited the same HYDRA_SESSION_ID (a probe or child claude run from the session's own
 * shell) makes the two bridges evict each other, and the kill lands on the legitimate session
 * (Sep 28 2026). So: while another live bridge holds the id, hold it and refuse newcomers;
 * kill only when a single bridge flaps with no incumbent (a genuine reconnect loop).
 *
 * `held` = a hold set by an earlier flap is still in force for the current incumbent.
 * Pure so it can be unit-tested without the socket layer.
 */
export function sessionFlapAction(opts: {
  /** A different live socket already holds this session id. */
  hasOtherIncumbent: boolean
  /** A hold from an earlier flap still applies to the current incumbent. */
  held: boolean
  /** Registration rate for this id just crossed the flap threshold (never evaluated while held). */
  flapping: boolean
}): SessionFlapAction {
  if (opts.held) return 'refuse'
  if (!opts.flapping) return 'accept'
  return opts.hasOtherIncumbent ? 'hold' : 'kill'
}
