import { mkdirSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from './config.js'
import { transport } from './bridge-transport.js'
import { handoffRequest } from './commands/thread.js'
import { readHandoffTemplate } from './handoff-templates.js'
import { claudeEngine } from './engines/instances.js'
import { readClaudeStatus } from './engines/claude-status.js'
import { runPreHandoffHook, type HookSubject } from './session-lifecycle.js'
import { transcriptPathFor } from './usage.js'
import { mainAlive, mainChannel, mainSubject, mainTmux } from './main-session.js'
import { reportError, safeSend } from './util.js'
import type { InboundMessage } from '../gateway.js'

// Handoff for main: the claude process, its bridge and the 'main' id stay. Main writes a letter and
// calls the handoff tool; the pre-handoff hook may refuse. Then, once main is idle, only `/clear` is typed
// (typed text would submit early and can hit a dialog). When Claude's session id has changed the clear is
// confirmed, and the successor's prompt (the arriving template, or the built-in line, plus the note)
// is delivered over the bridge, which survives /clear.

// Overridable by tests.
export const _timing = { settleMs: 500, pollMs: 500, idleMs: 120_000, unreadableMs: 5_000, clearMs: 15_000 }

type Request = { artifact: string; note?: string; channelId: string }
let requested: Request | undefined
let running = false

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function handleMainHandoffIntercept(msg: InboundMessage, cmd: { model?: string; note?: string }): Promise<void> {
  const { note } = cmd
  if (cmd.model) return reportError(msg.channelId, msg.id, 'handoff', 'main hands off in place, on its own model', 'Use `handoff` or `handoff - <note>`.')
  if (!mainAlive()) return reportError(msg.channelId, msg.id, 'handoff', 'main is not running')
  if (running) return reportError(msg.channelId, msg.id, 'handoff', 'main is already handing off')
  const artifact = join(STATE_DIR, 'handoffs', `main-${Date.now()}.md`)
  mkdirSync(join(STATE_DIR, 'handoffs'), { recursive: true })
  requested = { artifact, note, channelId: msg.channelId }  // a new command replaces a pending one
  const requester = msg.authorUsername || 'the user'
  const vars = { artifact, session: mainTmux(), requester, model: '', note: note ?? '', cwd: hookSubject().sessionMetadata?.cwd ?? '', worktree: '', branch: '', label: '' }
  transport.sendOrQueue('main', {
    type: 'notification',
    content: readHandoffTemplate('departing', vars) ?? handoffRequest(artifact, requester, note),
    meta: { chat_id: msg.channelId, message_id: msg.id, user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
  void gateway.react(msg.channelId, msg.id, '🤝').catch(() => {})
  const notice = readHandoffTemplate('notice', vars)
    ?? `_Asked main to write \`${artifact}\` and hand off. Its context clears once it calls the handoff tool._`
  const confirmed = note ? `${notice}\n> Note to pass on: ${note.replace(/@/g, '@​').replace(/\n/g, '\n> ')}` : notice
  void safeSend(msg.channelId, confirmed, { replyTo: msg.id })
}

/** What the hooks know about main: it has no thread, no worktree, and works where its status file says. */
function hookSubject(): HookSubject {
  const status = readClaudeStatus(mainTmux())
  return { sessionId: 'main', tmuxName: mainTmux(), engine: 'claude', claudeSessionId: status?.sessionId, sessionType: 'master_orchestrator', sessionMetadata: { cwd: status?.cwd ?? '' } }
}

/**
 * Called by the handoff tool when main is the caller. Runs the pre-handoff hook (a refusal throws, and
 * the tool call fails), then clears main in the background after the tool call has been answered.
 */
export async function beginMainHandoff(path: string): Promise<void> {
  if (running) throw new Error('main is already handing off')
  running = true
  try {
    const check = await runPreHandoffHook(hookSubject(), path)
    if (!check.ok) throw new Error(`handoff refused by hooks/pre-handoff:\n${check.output}`)
  } catch (err) { running = false; throw err }
  const asked = requested
  requested = undefined
  setTimeout(() => void finish(path, asked), _timing.settleMs)
}

async function finish(path: string, asked?: Request): Promise<void> {
  // The note rides only with the letter that was asked for; a note on another letter is reported, not passed.
  const req = asked?.artifact === path ? asked : undefined
  const channel = (asked?.channelId) || mainChannel()
  const say = (text: string) => { if (channel) void gateway.send(channel, text).catch(() => {}) }
  try {
    const before = await waitIdle()
    const main = mainSubject()
    const blocked = claudeEngine.detectBlockingState(main, claudeEngine.peek(main, 40))
    if (blocked) throw new Error(`main is at a ${blocked.kind} prompt, so keys would go into it`)
    await claudeEngine.sendKeys(main, '/clear')
    await waitCleared(before)
    transport.sendOrQueue('main', {
      type: 'notification',
      content: successorPrompt(path, req?.note, before),
      meta: { chat_id: channel, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
    const noteLine = req?.note ? '\nYour note was passed on.'
      : asked?.note ? `\n⚠️ Your note was **not** passed on: main wrote \`${path}\`, not the letter that request asked for (\`${asked.artifact}\`). Tell main the note yourself.`
      : ''
    say(`🤝 main cleared its context and will continue from \`${path}\`${noteLine}`)
  } catch (err) {
    if (!requested) requested = asked  // a retry on the same letter keeps its note
    say(`⚠️ main handoff failed: ${err instanceof Error ? err.message : err}\nRecover: tell main to read \`${path}\` and continue from its Next action.`)
  } finally { running = false }
}

/** Waits for main's turn (the one that called the tool) to end; returns Claude's session id at that moment. */
async function waitIdle(): Promise<string> {
  const start = Date.now()
  for (;;) {
    const s = readClaudeStatus(mainTmux())
    if (s?.status === 'idle') return s.sessionId
    const waited = Date.now() - start
    if (!s && waited >= _timing.unreadableMs) throw new Error("main's Claude status file is unreadable, so its state is unknown and nothing was typed")
    if (waited >= _timing.idleMs) throw new Error(`main did not go idle within ${Math.round(_timing.idleMs / 1000)}s (status ${s?.status ?? 'unreadable'})`)
    await sleep(_timing.pollMs)
  }
}

/** Waits for Claude's session id to change: the proof /clear ran (Claude rewrites it within a second). */
async function waitCleared(before: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < _timing.clearMs) {
    const now = readClaudeStatus(mainTmux())?.sessionId
    if (now && now !== before) return
    await sleep(_timing.pollMs)
  }
  throw new Error(`/clear was typed but main's session id did not change within ${Math.round(_timing.clearMs / 1000)}s; if main was busy it may still clear when its turn ends`)
}

/** The successor's prompt: the built-in line, the note, and the arriving template when there is one. */
function successorPrompt(path: string, note: string | undefined, fromSession: string | undefined): string {
  const arriving = readHandoffTemplate('arriving', {
    from: mainTmux(), session: mainTmux(), cwd: hookSubject().sessionMetadata?.cwd ?? '', worktree: '', branch: '',
    artifact: path, note: note ?? '', from_session: fromSession ?? '', from_transcript: transcriptPathFor(fromSession) ?? '',
  })
  return [
    `[system] You handed off and your context was cleared. Read ${path} and continue from its Next action.`,
    ...(note ? [`Note from the user: ${note}`] : []),
    ...(arriving ? [arriving] : []),
  ].join('\n')
}

export function _resetMainHandoff(): void { requested = undefined; running = false }
