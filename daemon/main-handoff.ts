import { mkdirSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from './config.js'
import { transport } from './bridge-transport.js'
import { handoffRequest } from './commands/thread.js'
import { readHandoffTemplate } from './handoff-templates.js'
import { mainSession } from './main-session.js'
import { reportError, safeSend } from './util.js'
import type { InboundMessage } from '../gateway.js'

// Handoff for main: the claude process, its bridge and the 'main' id stay. Main writes a letter,
// its context is cleared in place with /clear, and it is seeded to read the letter. Typed keys
// queue behind a running turn, so the clear lands after the turn that called the handoff tool.

let requested: { artifact: string; note?: string } | undefined
let running = false

export async function handleMainHandoffIntercept(msg: InboundMessage, cmd: { model?: string; note?: string }): Promise<void> {
  const { note } = cmd
  if (cmd.model) return reportError(msg.channelId, msg.id, 'handoff', 'main hands off in place, on its own model', 'Use `handoff` or `handoff - <note>`.')
  const info = mainSession()
  if (!info) return reportError(msg.channelId, msg.id, 'handoff', 'main is not running')
  if (running) return reportError(msg.channelId, msg.id, 'handoff', 'main is already handing off')
  const artifact = join(STATE_DIR, 'handoffs', `main-${Date.now()}.md`)
  mkdirSync(join(STATE_DIR, 'handoffs'), { recursive: true })
  requested = { artifact, note }  // a new command replaces a pending one
  const requester = msg.authorUsername || 'the user'
  const vars = { artifact, session: info.tmuxName, requester, model: '', note: note ?? '', cwd: '', worktree: '', branch: '', label: '' }
  transport.sendOrQueue('main', {
    type: 'notification',
    content: readHandoffTemplate('departing', vars) ?? handoffRequest(artifact, requester, note),
    meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})
  const noteEcho = note ? `\n> Note to pass on: ${note.replace(/@/g, '@​').replace(/\n/g, '\n> ')}` : ''
  void safeSend(msg.channelId, `_Asked main to write \`${artifact}\` and hand off. Its context clears once it calls the handoff tool._${noteEcho}`, { replyTo: msg.id })
}

/** Called by the handoff tool when main is the caller. Throws if a handoff is already running. */
export function startMainHandoff(path: string): void {
  if (running) throw new Error('main is already handing off')
  running = true
  // The note rides only with the letter that was asked for.
  const note = requested?.artifact === path ? requested.note : undefined
  requested = undefined
  const channel = mainSession()?.threadId
  const say = (text: string) => { if (channel) void gateway.send(channel, text).catch(() => {}) }
  // Same 500ms the other handoffs wait, so the tool result reaches main before any key is typed.
  new Promise(r => setTimeout(r, 500)).then(() => clearAndSeed(path, note)).then(
    () => say(`🤝 main cleared its context and will continue from \`${path}\`${note ? '\nYour note was passed on.' : ''}`),
    err => say(`⚠️ main handoff failed: ${err instanceof Error ? err.message : err}\nRecover: tell main to read \`${path}\` and continue from its Next action.`),
  ).finally(() => { running = false })
}

async function clearAndSeed(path: string, note?: string): Promise<void> {
  const info = mainSession()
  if (!info) throw new Error('main is not running')
  const blocked = info.adapter.detectBlockingState(info, info.adapter.peek(info, 40))
  if (blocked) throw new Error(`main is at a ${blocked.kind} prompt, so keys would go into it`)
  await info.adapter.sendKeys(info, '/clear')
  await new Promise(r => setTimeout(r, 1500))
  // One line: a newline in typed text would submit early.
  const seed = `[system] You handed off and your context was cleared. Read ${path} and continue from its Next action.${note ? ` Note from the user: ${note.replace(/\s+/g, ' ').replace(/@/g, '@\u200b')}` : ''}`
  await info.adapter.sendKeys(info, seed)
}

export function _resetMainHandoff(): void { requested = undefined; running = false }
