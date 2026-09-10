import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const MAX_QUEUED_ACTIONS = 20
type QueuedAction = { action: TmuxKeyAction; settled?: (error?: Error) => void }
const queues = new Map<string, QueuedAction[]>()

export type TmuxKeyAction =
  | { target: string; mode: 'raw'; keys: string[] }
  | { target: string; mode: 'literal'; text: string; trailingKey?: string }

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

export async function sendTmuxKeys(action: TmuxKeyAction): Promise<void> {
  if (action.mode === 'raw') {
    await execFileAsync('tmux', ['send-keys', '-t', action.target, ...action.keys], { timeout: 3000 })
    return
  }
  await execFileAsync('tmux', ['send-keys', '-t', action.target, '-l', action.text], { timeout: 3000 })
  await execFileAsync('tmux', ['send-keys', '-t', action.target, action.trailingKey ?? 'Enter'], { timeout: 3000 })
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
