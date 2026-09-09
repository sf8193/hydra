import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const MAX_QUEUED_ACTIONS = 20
const queues = new Map<string, TmuxKeyAction[]>()

export type TmuxKeyAction =
  | { target: string; mode: 'raw'; keys: string[] }
  | { target: string; mode: 'literal'; text: string }

export function queueCodexKeys(sessionId: string, action: TmuxKeyAction): number {
  const queue = queues.get(sessionId) ?? []
  if (queue.length >= MAX_QUEUED_ACTIONS) queue.shift()
  queue.push(action)
  queues.set(sessionId, queue)
  return queue.length
}

export async function sendTmuxKeys(action: TmuxKeyAction): Promise<void> {
  if (action.mode === 'raw') {
    await execFileAsync('tmux', ['send-keys', '-t', action.target, ...action.keys], { timeout: 3000 })
    return
  }
  await execFileAsync('tmux', ['send-keys', '-t', action.target, '-l', action.text], { timeout: 3000 })
  await execFileAsync('tmux', ['send-keys', '-t', action.target, 'Enter'], { timeout: 3000 })
}

export function flushCodexKeys(sessionId: string): void {
  const queue = queues.get(sessionId)
  if (!queue?.length) return
  queues.delete(sessionId)

  // Let the TUI finish rendering the completed turn before entering commands.
  setTimeout(() => {
    void (async () => {
      for (const action of queue) {
        try {
          await sendTmuxKeys(action)
        } catch (err) {
          process.stderr.write(`daemon: queued codex keys failed for ${sessionId}: ${err}\n`)
        }
      }
    })()
  }, 250)
}

export function clearCodexKeys(sessionId: string): void {
  queues.delete(sessionId)
}

export function queuedCodexKeyCount(sessionId: string): number {
  return queues.get(sessionId)?.length ?? 0
}

