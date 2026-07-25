// Command queue — executes chained commands sequentially per-thread.
// Usage: "review: correctness && review codex: readability && push"
// Each command runs after the previous protocol (review/build/design) completes.

import type { InboundMessage } from '../gateway.js'
import { safeSend } from './util.js'

export type QueuedCommand = {
  rawText: string
  originalMsg: InboundMessage
}

type ThreadQueue = {
  commands: QueuedCommand[]
  threadId: string
}

const queues = new Map<string, ThreadQueue>()

// Pending fork handoffs: sessionId → threadId. When the forked session's bridge
// registers, we dispatch the next queued command. This prevents racing the review
// against the fork's boot sequence.
const pendingForkHandoffs = new Map<string, string>()

let routeMessageFn: ((msg: InboundMessage) => Promise<void>) | null = null

export function registerRouter(fn: (msg: InboundMessage) => Promise<void>): void {
  routeMessageFn = fn
}

export function enqueue(threadId: string, commands: QueuedCommand[]): void {
  if (commands.length === 0) return
  const existing = queues.get(threadId)
  if (existing) {
    existing.commands.push(...commands)
  } else {
    queues.set(threadId, { commands: [...commands], threadId })
  }
  process.stderr.write(`daemon: command-queue: enqueued ${commands.length} command(s) for thread ${threadId} (total: ${queues.get(threadId)!.commands.length})\n`)
}

export function clearQueue(threadId: string): number {
  const q = queues.get(threadId)
  if (!q) return 0
  const count = q.commands.length
  queues.delete(threadId)
  process.stderr.write(`daemon: command-queue: cleared ${count} command(s) for thread ${threadId}\n`)
  return count
}

export function peekQueue(threadId: string): QueuedCommand | undefined {
  return queues.get(threadId)?.commands[0]
}

export function queueLength(threadId: string): number {
  return queues.get(threadId)?.commands.length ?? 0
}

export function hasQueue(threadId: string): boolean {
  return (queues.get(threadId)?.commands.length ?? 0) > 0
}

/** Move all queued commands from one thread to another (used by fork to re-target chains). */
export function migrateQueue(fromThreadId: string, toThreadId: string): number {
  const q = queues.get(fromThreadId)
  if (!q || q.commands.length === 0) return 0
  const count = q.commands.length
  queues.delete(fromThreadId)
  const existing = queues.get(toThreadId)
  if (existing) {
    existing.commands.push(...q.commands)
  } else {
    queues.set(toThreadId, { commands: q.commands, threadId: toThreadId })
  }
  process.stderr.write(`daemon: command-queue: migrated ${count} command(s) from ${fromThreadId} → ${toThreadId}\n`)
  return count
}

export function onProtocolComplete(threadId: string): void {
  const q = queues.get(threadId)
  if (!q || q.commands.length === 0) {
    queues.delete(threadId)
    return
  }

  const next = q.commands.shift()!
  if (q.commands.length === 0) queues.delete(threadId)

  process.stderr.write(`daemon: command-queue: dispatching next command for ${threadId}: "${next.rawText.slice(0, 80)}"\n`)

  if (!routeMessageFn) {
    process.stderr.write(`daemon: command-queue: router not registered, dropping command\n`)
    return
  }

  const remaining = queueLength(threadId)
  const queueNote = remaining > 0 ? ` (${remaining} remaining)` : ''
  void safeSend(threadId, `_⏭ Next: \`${next.rawText.trim()}\`${queueNote}_`)

  const syntheticMsg: InboundMessage = {
    ...next.originalMsg,
    content: next.rawText.trim(),
    channelId: threadId,
    effectiveThreadId: threadId,
    isThread: true,
  }

  routeMessageFn(syntheticMsg).catch(err => {
    process.stderr.write(`daemon: command-queue: dispatch failed: ${err}\n`)
    const dropped = clearQueue(threadId)
    void safeSend(threadId, `_⚠️ Queue aborted — \`${next.rawText.trim()}\` failed to dispatch${dropped > 0 ? ` (${dropped} more command${dropped !== 1 ? 's' : ''} dropped)` : ''}_`)
  })
}

// Split a raw message on && and return [first, ...rest]
export function splitChain(text: string): string[] {
  return text.split(/\s*&&\s*/).map(s => s.trim()).filter(s => s.length > 0)
}

/** Schedule a chain dispatch for when the forked session's bridge connects. */
export function scheduleForkHandoff(sessionId: string, threadId: string): void {
  pendingForkHandoffs.set(sessionId, threadId)
  process.stderr.write(`daemon: command-queue: fork handoff pending for session ${sessionId} → thread ${threadId}\n`)
  // Safety timeout: if bridge never connects, dispatch anyway after 30s
  setTimeout(() => {
    if (pendingForkHandoffs.delete(sessionId)) {
      process.stderr.write(`daemon: command-queue: fork handoff timeout for session ${sessionId}, dispatching anyway\n`)
      onProtocolComplete(threadId)
    }
  }, 30_000)
}

/** Called from bridge-server when a session's bridge registers. Fires pending fork handoffs. */
export function onBridgeReady(sessionId: string): void {
  const threadId = pendingForkHandoffs.get(sessionId)
  if (!threadId) return
  pendingForkHandoffs.delete(sessionId)
  process.stderr.write(`daemon: command-queue: fork handoff firing for session ${sessionId} (bridge ready)\n`)
  onProtocolComplete(threadId)
}

export function _resetForTesting(): void {
  queues.clear()
  pendingForkHandoffs.clear()
  routeMessageFn = null
}
