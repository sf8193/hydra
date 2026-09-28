import { execFile } from 'child_process'
import { promisify } from 'util'

import type { TmuxKeyAction } from './engines/engine-adapter.js'

const execFileAsync = promisify(execFile)
const inFlight = new Map<string, Promise<void>>()
// Tests shorten this; production uses the default.
export const keyTiming = { settleMs: 250 }

export type { TmuxKeyAction } from './engines/engine-adapter.js'

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
  await Bun.sleep(keyTiming.settleMs)
  await assertSamePane(pane)
  await execFileAsync('tmux', ['send-keys', '-t', pane.id, action.trailingKey ?? 'Enter'], { timeout: 3000 })
}
