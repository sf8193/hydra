import { execFile } from 'child_process'
import { promisify } from 'util'

import type { TmuxKeyAction } from './engines/engine-adapter.js'

const execFileAsync = promisify(execFile)
const MAX_QUEUED_ACTIONS = 20
type QueuedAction = { action: TmuxKeyAction; settled?: (error?: Error) => void }
const queues = new Map<string, QueuedAction[]>()
const inFlight = new Map<string, Promise<void>>()

export type { TmuxKeyAction } from './engines/engine-adapter.js'

export function queueCodexKeys(sessionId: string, action: TmuxKeyAction, settled?: (error?: Error) => void): number {
  const queue = queues.get(sessionId) ?? []
  if (queue.length >= MAX_QUEUED_ACTIONS) {
    const evicted = queue.shift()
    evicted?.settled?.(new Error('key action evicted because the queue is full'))
  }
  queue.push({ action, settled })
  queues.set(sessionId, queue)
  return queue.length
}

// Serialize complete actions, including raw controls, so nothing can land between
// literal text and its trailing key. A failed action must not poison the tail.
export function sendTmuxKeys(action: TmuxKeyAction, beforeSend?: (target: string) => Promise<void>): Promise<void> {
  const previous = inFlight.get(action.target) ?? Promise.resolve()
  const sent = previous.then(async () => {
    await sendAction(action, beforeSend)
  })
  const tail = sent.catch(() => {})
  inFlight.set(action.target, tail)
  void tail.then(() => {
    if (inFlight.get(action.target) === tail) inFlight.delete(action.target)
  })
  return sent
}

async function paneIdentity(target: string): Promise<{ id: string; pid: string }> {
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target,
    '#{pane_id} #{pane_pid} #{pane_dead}'], { timeout: 1000 })
  const match = /^(%\d+) (\d+) 0$/.exec(stdout.trim())
  if (!match) throw new Error(`Codex key target is unavailable: ${target}`)
  return { id: match[1], pid: match[2] }
}

async function assertSamePane(pane: { id: string; pid: string }): Promise<void> {
  const current = await paneIdentity(pane.id)
  if (current.id !== pane.id || current.pid !== pane.pid) {
    throw new Error('Codex key target changed during submission; remaining keys were not sent')
  }
}

async function sendAction(action: TmuxKeyAction, beforeSend?: (target: string) => Promise<void>): Promise<void> {
  if (action.mode === 'raw') {
    await execFileAsync('tmux', ['send-keys', '-t', action.target, ...action.keys], { timeout: 3000 })
    return
  }
  // Window names can be reused during surface repair. Pin both the pane and its
  // process so neither replacement nor respawn receives this action's remainder.
  const pane = await paneIdentity(action.target)
  await beforeSend?.(pane.id)
  await assertSamePane(pane)
  await execFileAsync('tmux', ['send-keys', '-t', pane.id, '-l', action.text], { timeout: 3000 })
  // In the installed Codex TUI, immediate Enter can leave text in the composer.
  // A settling interval submitted reliably in the isolated /status probe.
  await Bun.sleep(250)
  await assertSamePane(pane)
  await execFileAsync('tmux', ['send-keys', '-t', pane.id, action.trailingKey ?? 'Enter'], { timeout: 3000 })
}

export function flushCodexKeys(sessionId: string): void {
  const queue = queues.get(sessionId)
  if (!queue?.length) return
  queues.delete(sessionId)

  // Let the TUI finish rendering the completed turn before entering commands.
  setTimeout(() => {
    void (async () => {
      for (const queued of queue) {
        try {
          await sendTmuxKeys(queued.action)
          queued.settled?.()
        } catch (err) {
          process.stderr.write(`daemon: queued codex keys failed for ${sessionId}: ${err}\n`)
          queued.settled?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()
  }, 250)
}

export function clearCodexKeys(sessionId: string): void {
  const queue = queues.get(sessionId)
  queues.delete(sessionId)
  if (!queue) return
  for (const queued of queue) queued.settled?.(new Error('key action cancelled because the session disconnected'))
}

export function queuedCodexKeyCount(sessionId: string): number {
  return queues.get(sessionId)?.length ?? 0
}
