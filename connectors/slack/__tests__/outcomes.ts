import type { DeliverOutcome } from '../../../specialists/targets.js'

/** A delivery that landed, as targets.ts answers one: for a test whose connector only needs the message to go. */
export const LANDED: Extract<DeliverOutcome, { ok: true }> = { ok: true, status: 'delivered', sessionId: 's-1', sessionName: 'session', threadId: 'thread-1', revived: false }

/** A refusal, as targets.ts answers one. Exit 6 (failed) unless the test needs another. */
export const refused = (reason: string, exit: 3 | 4 | 5 | 6 | 7 | 8 = 6): DeliverOutcome => ({ ok: false, exit, reason })
