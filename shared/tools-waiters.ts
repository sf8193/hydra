/**
 * The set of tools/list requests waiting on one daemon reply.
 *
 * Claude Code issues tools/list concurrently — every `tools/list_changed`
 * notification triggers a fresh one, and a notification storm makes several
 * overlap. Holding the waiters in a single mutable slot lets a later request
 * overwrite an earlier one; the overwritten promise then never settles, so that
 * request hangs until Claude Code times it out, and repeated timeouts make it
 * drop the bridge for the whole life of the session.
 *
 * `request_tools` takes no arguments, so one reply answers every waiter. The
 * invariant this type exists to hold: every registered waiter settles exactly
 * once, whether by the daemon replying or by its own timeout.
 */
export type ToolsWaiter<T> = (tools: T | null) => void

export class ToolsWaiterSet<T> {
  private readonly waiters = new Set<ToolsWaiter<T>>()

  get size(): number {
    return this.waiters.size
  }

  add(waiter: ToolsWaiter<T>): void {
    this.waiters.add(waiter)
  }

  /** Settles one waiter. Returns false when it was already settled. */
  timeout(waiter: ToolsWaiter<T>): boolean {
    if (!this.waiters.delete(waiter)) return false
    waiter(null)
    return true
  }

  /** Settles every waiter with the daemon's reply. */
  settleAll(tools: T): void {
    if (this.waiters.size === 0) return
    const pending = [...this.waiters]
    this.waiters.clear()
    for (const waiter of pending) waiter(tools)
  }
}
