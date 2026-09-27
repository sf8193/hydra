/**
 * Per-session FIFO for routed user messages. A slot is reserved synchronously
 * at routing time, so slow payload enrichment (attachment download,
 * transcription) on message A cannot let a later message B overtake it.
 */

const tails = new Map<string, Promise<void>>()

// ponytail: a hung predecessor only delays the next message this long, then
// ordering degrades to best-effort rather than wedging the session. Sized above
// the 60s default transcription timeout plus download/thread-fetch time.
export const INGRESS_WAIT_CAP_MS = 180_000

/**
 * `before` (a `!` interrupt) is awaited inside the slot, so the message is
 * admitted only after it settles; its failure is logged, never fatal.
 */
export function reserveUserIngress(
  sessionId: string,
  task: () => Promise<void>,
  opts: { before?: Promise<unknown>; capMs?: number } = {},
): Promise<void> {
  const { before, capMs = INGRESS_WAIT_CAP_MS } = opts
  // Handle an early rejection now; the slot still observes it below.
  before?.catch(() => {})
  const previous = tails.get(sessionId) ?? Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const capped = Promise.race([
    previous,
    new Promise<void>(resolve => { timer = setTimeout(resolve, capMs) }),
  ]).finally(() => clearTimeout(timer))
  const run = capped.then(async () => {
    if (before) {
      try { await before } catch (err) {
        process.stderr.write(`daemon: interrupt failed for ${sessionId}: ${err instanceof Error ? err.message : err}\n`)
      }
    }
    await task()
  })
  const tail = run.catch(err => {
    process.stderr.write(`daemon: user ingress task failed for ${sessionId}: ${err}\n`)
  })
  tails.set(sessionId, tail)
  void tail.finally(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId) })
  return run
}
