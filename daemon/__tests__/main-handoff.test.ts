// Handoff for main: the command asks main for a letter; the tool call runs the pre-handoff hook, then once
// main is idle `/clear` is typed, and when Claude's session id changes the successor's prompt goes over the
// bridge. Main has no registry record; keys go to a fake tmux and Claude's status file is written by the test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { noteMainChannel } from '../main-session.js'
import { executeTool } from '../bridge-dispatch.js'
import { handleMainHandoffIntercept, _resetMainHandoff, _timing } from '../main-handoff.js'
import { PRE_HANDOFF_HOOK_PATH } from '../session-lifecycle.js'
import { HANDOFF_TEMPLATE_DIR } from '../handoff-templates.js'
import { isToolAllowed } from '../tool-surface.js'
import { waitFor } from './handoff-thread.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

const BYTE = 'discord-byte'
const idlePane = `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:60%\n`
const cmd = (content = 'handoff') => ({ id: 'cmd1', channelId: 'main-chan-h', isThread: false, content, authorUsername: 'sam' }) as any
const savedTiming = { ..._timing }

describe('main handoff', () => {
  let tmux: FakeTmux
  let delivered: any[]; let sent: string[]; let sentTo: string[]; let reacted: string[]
  let dir: string
  let orig: Record<string, any>
  let watcher: ReturnType<typeof setInterval> | undefined
  const keys = () => tmux.calls().filter(c => c.startsWith('send-keys'))
  const statusFile = () => join(tmux.claudeDir, 'sessions', '4242.json')
  const setStatus = (sessionId: string, status: string) => {
    mkdirSync(dirname(statusFile()), { recursive: true })
    writeFileSync(statusFile(), JSON.stringify({ pid: process.pid, sessionId, status, tmux: `${BYTE}:@1.%1`, cwd: dir }))
  }
  /** Stands in for Claude: a typed /clear starts a new session id, as the real one does. */
  const claudeClearsOnCommand = () => {
    watcher = setInterval(() => { if (keys().some(c => c.includes('/clear'))) { setStatus('sess-2', 'idle'); clearInterval(watcher) } }, 2)
  }
  const letterFor = () => delivered[0].content.match(/path="([^"]+)"/)![1] as string
  const done = (re: RegExp) => waitFor(() => sent.some(t => re.test(t)), 3000)
  const doneOk = () => done(/main cleared its context/)
  const successor = () => delivered.filter(m => String(m.content).startsWith('[system] You handed off'))

  beforeEach(() => {
    Object.assign(_timing, { settleMs: 5, pollMs: 5, idleMs: 400, unreadableMs: 60, clearMs: 300 })
    _resetMainHandoff(); noteMainChannel('main-chan-h')
    tmux = withFakeTmux(); tmux.alive(BYTE); tmux.pane(BYTE, idlePane)
    dir = mkdtempSync(join(tmpdir(), 'main-handoff-'))
    setStatus('sess-1', 'idle')
    delivered = []; sent = []; sentTo = []; reacted = []
    orig = { sendOrQueue: transport.sendOrQueue, send: gateway.send, react: gateway.react }
    ;(transport as any).sendOrQueue = (_id: string, m: any) => { delivered.push({ _id, ...m }) }
    ;(gateway as any).send = async (c: string, t: string) => { sentTo.push(c); sent.push(t); return { id: 'm' } }
    ;(gateway as any).react = async (_c: string, _m: string, e: string) => { reacted.push(e) }
  })
  afterEach(() => {
    clearInterval(watcher)
    Object.assign(_timing, savedTiming)
    Object.assign(transport, { sendOrQueue: orig.sendOrQueue }); Object.assign(gateway, { send: orig.send, react: orig.react })
    rmSync(PRE_HANDOFF_HOOK_PATH, { force: true }); rmSync(join(HANDOFF_TEMPLATE_DIR, 'arriving.md'), { force: true }); rmSync(join(HANDOFF_TEMPLATE_DIR, 'notice.md'), { force: true })
    tmux.restore(); rmSync(dir, { recursive: true, force: true })
    _resetMainHandoff(); noteMainChannel('')
  })

  const writeHook = (body: string) => { mkdirSync(dirname(PRE_HANDOFF_HOOK_PATH), { recursive: true }); writeFileSync(PRE_HANDOFF_HOOK_PATH, `#!/bin/sh\n${body}\n`); chmodSync(PRE_HANDOFF_HOOK_PATH, 0o755) }

  test('only main may call the handoff tool: a registry orchestrator (factory PM) may not', () => {
    expect(isToolAllowed('main', 'handoff')).toBe(true)
    registry.set('pm-1', { sessionId: 'pm-1', tmuxName: 'pm', topic: 't', threadId: 'pm-thread', createdAt: 1, lastActive: 1, listening: false, engine: 'claude', adapter: {} as any, sessionType: 'master_orchestrator' } as any)
    try { expect(isToolAllowed('pm-1', 'handoff')).toBe(false) } finally { registry.delete('pm-1') }
  })

  test('the command asks main for a letter under STATE_DIR/handoffs, carrying the note, and says so', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'ship the alert tests' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]._id).toBe('main')
    expect(letterFor().startsWith(join(STATE_DIR, 'handoffs', 'main-'))).toBe(true)
    expect(delivered[0].content).toContain('ship the alert tests')
    expect(reacted).toContain('🤝')
    expect(sent.join('\n')).toContain('Asked main to write')
  })

  test('notice.md replaces the built-in notice', async () => {
    mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
    writeFileSync(join(HANDOFF_TEMPLATE_DIR, 'notice.md'), 'custom notice for {{session}}')
    await handleMainHandoffIntercept(cmd(), {})
    expect(sent[0]).toBe('custom notice for discord-byte')
  })

  test('a model argument is refused: main hands off on its own model', async () => {
    await handleMainHandoffIntercept(cmd('handoff sonnet'), { model: 'sonnet' })
    expect(delivered).toHaveLength(0)
    expect(reacted).toEqual(['❌'])
  })

  test('a new command replaces a pending one: main is asked again, with the newest note', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'alpha-note' })
    await handleMainHandoffIntercept(cmd(), { note: 'beta-note' })
    expect(delivered).toHaveLength(2)
    const path = delivered[1].content.match(/path="([^"]+)"/)![1]
    writeFileSync(path, 'x'); claudeClearsOnCommand()
    await executeTool('handoff', { path }, 'main')
    await doneOk()
    expect(successor()[0].content).toContain('beta-note'); expect(successor()[0].content).not.toContain('alpha-note')
  })

  test('the command with the byte down is refused and asks nothing', async () => {
    tmux.restore(); tmux = withFakeTmux()
    await handleMainHandoffIntercept(cmd(), {})
    expect(delivered).toHaveLength(0)
    expect(reacted).toEqual(['❌'])
  })

  test('the tool refuses a relative, missing or empty letter and types nothing', async () => {
    const empty = join(dir, 'empty.md'); writeFileSync(empty, '')
    for (const path of ['package.json', join(dir, 'nope.md'), empty]) {
      expect((await executeTool('handoff', { path }, 'main')).isError).toBe(true)
    }
    expect(keys()).toEqual([])
  })

  test('happy path: answers first, types only /clear, then delivers the successor prompt over the bridge', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'line one\nline two @x' })
    const doc = letterFor(); writeFileSync(doc, '# Next action\ndo x\n'); claudeClearsOnCommand()
    const res = await executeTool('handoff', { path: doc }, 'main')
    expect(res.isError).toBeFalsy()
    expect(keys()).toEqual([])  // the tool result goes out first
    await doneOk()
    expect(keys()).toHaveLength(2)  // /clear and its Enter — nothing else is typed
    expect(keys()[0]).toContain('-l /clear')
    expect(successor()).toHaveLength(1)
    expect(successor()[0]._id).toBe('main')
    expect(successor()[0].content).toContain(`Read ${doc}`)
    expect(successor()[0].content).toContain('Note from the user: line one\nline two @x')  // multi-line is fine over the bridge
    expect(sent.some(t => t.includes('Your note was passed on'))).toBe(true)
    expect(sentTo[sentTo.length - 1]).toBe('main-chan-h')
  })

  test('the arriving template is added to the successor prompt', async () => {
    mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
    writeFileSync(join(HANDOFF_TEMPLATE_DIR, 'arriving.md'), 'Re-read the notes; delete {{artifact}}; was {{from_session}}')
    await handleMainHandoffIntercept(cmd(), {})
    const doc = letterFor(); writeFileSync(doc, 'x'); claudeClearsOnCommand()
    await executeTool('handoff', { path: doc }, 'main'); await doneOk()
    expect(successor()[0].content).toContain(`Re-read the notes; delete ${doc}; was sess-1`)
  })

  test('nothing is typed while main is busy; /clear waits for idle', async () => {
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    setStatus('sess-1', 'busy'); claudeClearsOnCommand()
    await executeTool('handoff', { path: doc }, 'main')
    await new Promise(r => setTimeout(r, 80))
    expect(keys()).toEqual([])
    setStatus('sess-1', 'idle')
    await doneOk()
    expect(keys()[0]).toContain('/clear')
  })

  test('main never goes idle: nothing typed, the failure names the letter, and a retry is allowed', async () => {
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    setStatus('sess-1', 'busy')
    await executeTool('handoff', { path: doc }, 'main')
    await done(/main handoff failed: main did not go idle/)
    expect(keys()).toEqual([]); expect(successor()).toHaveLength(0)
    expect(sent.join('\n')).toContain(doc)
    setStatus('sess-1', 'idle'); claudeClearsOnCommand()
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await doneOk()
  })

  test('/clear typed but the session id never changes: not reported as cleared, no prompt delivered, lock released', async () => {
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    await executeTool('handoff', { path: doc }, 'main')
    await done(/main handoff failed: \/clear was typed but/)
    expect(successor()).toHaveLength(0)
    expect(sent.some(t => t.includes('main cleared its context'))).toBe(false)
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await waitFor(() => sent.filter(t => t.includes('main handoff failed')).length === 2, 3000)  // the retry ran its full course
  })

  test('a second tool call, and a command, while one is running are refused', async () => {
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x'); claudeClearsOnCommand()
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBe(true)
    await handleMainHandoffIntercept(cmd(), {})
    expect(reacted).toContain('❌')
    await doneOk()
  })

  test('a refusing pre-handoff hook stops main: tool fails, nothing typed, hook saw main\'s name, session id and directory', async () => {
    const out = join(dir, 'hook-env.txt')
    writeHook(`echo "$HYDRA_SESSION_NAME|$HYDRA_SESSION_ID|[$HYDRA_THREAD_ID]|$HYDRA_CLAUDE_SESSION_ID|$HYDRA_CWD" > "${out}"; echo "no cleanup" ; exit 1`)
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    const res = await executeTool('handoff', { path: doc }, 'main')
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).toContain('no cleanup')
    expect(keys()).toEqual([])
    expect((await Bun.file(out).text()).trim()).toBe(`discord-byte|main|[]|sess-1|${dir}`)
    // a retry runs the hook again (the lock was released); with the hook gone it proceeds
    rmSync(PRE_HANDOFF_HOOK_PATH); claudeClearsOnCommand()
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await doneOk()
  })

  test('a note on a different letter is not passed on, and the message says so', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'secret note' })
    const other = join(dir, 'other.md'); writeFileSync(other, 'x'); claudeClearsOnCommand()
    await executeTool('handoff', { path: other }, 'main')
    await doneOk()
    expect(successor()[0].content).not.toContain('secret note')
    expect(sent.join('\n')).toContain('Your note was **not** passed on')
    expect(sentTo[sentTo.length - 1]).toBe('main-chan-h')
  })

  test('main at a blocking prompt: nothing is typed and the failure names the letter', async () => {
    tmux.pane(BYTE, 'Select login method:\n  1. Claude account\n')
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await done(/main handoff failed/)
    expect(keys()).toEqual([])
    expect(sent.join('\n')).toContain(doc)
  })

  test('status file unreadable: nothing is typed, nothing is claimed, and it says why', async () => {
    rmSync(statusFile())
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    await executeTool('handoff', { path: doc }, 'main')
    await done(/main handoff failed: main's Claude status file is unreadable/)
    expect(keys()).toEqual([]); expect(successor()).toHaveLength(0)
    expect(sent.some(t => t.includes('main cleared its context'))).toBe(false)
  })

  test('a failed attempt keeps the request: a retry on the same letter still carries the note', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'keep me' })
    const doc = letterFor(); writeFileSync(doc, 'x')
    setStatus('sess-1', 'busy')
    await executeTool('handoff', { path: doc }, 'main')
    await done(/main handoff failed: main did not go idle/)
    setStatus('sess-1', 'idle'); claudeClearsOnCommand()
    await executeTool('handoff', { path: doc }, 'main')
    await doneOk()
    expect(successor()[0].content).toContain('Note from the user: keep me')
  })
})
