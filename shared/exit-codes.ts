// The exit codes hydra's own tools speak, and the one word each means. README "Exit codes and result words" is the
// reader's table; this file is where the code reads it.
//
// The word is the schedule `Result` vocabulary (shared/jobs.ts): `deferred` is "try again later, nothing is wrong".

import type { Result } from './jobs.js'

/** deferred for the scripts an operator writes: a guard's verdict and a schedule `check`'s result. `jobs run` exits with it too. */
export const EX_TEMPFAIL = 75

/** What `hydra deliver` reports, as a word. */
export type DeliverWord = Extract<Result, 'done' | 'failed' | 'deferred'>

/** `hydra deliver`'s exit codes (0-8), each with the word it means. 2 is a duplicate key: the message already landed. 5 and 7 are deferred. */
export const DELIVER_WORD = {
  0: 'done',
  1: 'failed',
  2: 'done',
  3: 'failed',
  4: 'failed',
  5: 'deferred',
  6: 'failed',
  7: 'deferred',
  8: 'failed',
} as const satisfies Record<number, DeliverWord>

/** How a deliver refusal says its session is stuck on a dialog: exit 5, but it does not clear by waiting, so it is `failed`. */
export const STUCK_PREFIX = 'stuck:'

/** The word for a deliver exit code. A code outside 0-8 is `failed`. `error` is the refusal's text (only a stuck session's changes the word). */
export function deliverWord(exit: number, error?: string): DeliverWord {
  if (exit === 5 && error?.startsWith(STUCK_PREFIX)) return 'failed'
  return (DELIVER_WORD as Record<number, DeliverWord>)[exit] ?? 'failed'
}
