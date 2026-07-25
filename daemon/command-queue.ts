// Command queue — executes chained commands sequentially per-thread.
// Usage: "review: correctness && review codex: readability && push"
// Each command runs after the previous protocol (review/build/design) completes.

import type { InboundMessage } from '../gateway.js'
import { gateway } from './config.js'

export type QueuedCommand = {
  rawText: string
  originalMsg: InboundMessage
}

type ThreadQueue = {
  commands: QueuedCommand[]
  threadId: string
}

const queues = new Map<string, ThreadQueue>()

let routeMessageFn: ((msg: InboundMessage) => void) | null = null

export function registerRouter(fn: (msg: InboundMessage) => void): void {
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
  void gateway.send(threadId, `_⏭ Next: \`${next.rawText.trim()}\`${queueNote}_`).catch(() => {})

  const syntheticMsg: InboundMessage = {
    ...next.originalMsg,
    content: next.rawText.trim(),
    channelId: threadId,
    isThread: true,
  }

  try {
    routeMessageFn(syntheticMsg)
  } catch (err) {
    process.stderr.write(`daemon: command-queue: dispatch failed: ${err}\n`)
    const dropped = clearQueue(threadId)
    if (dropped > 0) {
      void gateway.send(threadId, `_⚠️ Queue aborted — command dispatch failed (${dropped} command${dropped !== 1 ? 's' : ''} dropped)_`).catch(() => {})
    }
  }
}

// Split a raw message on && and return [first, ...rest]
export function splitChain(text: string): string[] {
  return text.split(/\s*&&\s*/).map(s => s.trim()).filter(s => s.length > 0)
}

export function _resetForTesting(): void {
  queues.clear()
  routeMessageFn = null
}
