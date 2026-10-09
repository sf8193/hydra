// Handoff for main: the command asks main for a letter, the tool call then clears main in place
// (/clear) and seeds it to read the letter. Main has no registry record; the real keys go to a fake tmux.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { transport } from '../bridge-transport.js'
import { registry } from '../sessions.js'
import { noteMainChannel } from '../main-session.js'
import { executeTool } from '../bridge-dispatch.js'
import { handleMainHandoffIntercept, _resetMainHandoff } from '../main-handoff.js'
import { isToolAllowed } from '../tool-surface.js'
import { waitFor } from './handoff-thread.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

const BYTE = 'discord-byte'
const idlePane = `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:60%\n`
const cmd = (content = 'handoff') => ({ id: 'cmd1', channelId: 'main-chan-h', isThread: false, content, authorUsername: 'sam' }) as any

describe('main handoff', () => {
  let tmux: FakeTmux
  let delivered: any[]; let sent: string[]; let sentTo: string[]; let reacted: string[]
  let dir: string
  let orig: Record<string, any>
  const keys = () => tmux.calls().filter(c => c.startsWith('send-keys'))

  beforeEach(() => {
    _resetMainHandoff(); noteMainChannel('main-chan-h')
    tmux = withFakeTmux(); tmux.alive(BYTE); tmux.pane(BYTE, idlePane)
    dir = mkdtempSync(join(tmpdir(), 'main-handoff-'))
    delivered = []; sent = []; sentTo = []; reacted = []
    orig = { sendOrQueue: transport.sendOrQueue, send: gateway.send, react: gateway.react }
    ;(transport as any).sendOrQueue = (_id: string, m: any) => { delivered.push({ _id, ...m }) }
    ;(gateway as any).send = async (c: string, t: string) => { sentTo.push(c); sent.push(t); return { id: 'm' } }
    ;(gateway as any).react = async (_c: string, _m: string, e: string) => { reacted.push(e) }
  })
  afterEach(() => {
    Object.assign(transport, { sendOrQueue: orig.sendOrQueue }); Object.assign(gateway, { send: orig.send, react: orig.react })
    tmux.restore(); rmSync(dir, { recursive: true, force: true })
    _resetMainHandoff(); noteMainChannel('')
  })

  test('only main may call the handoff tool: a registry orchestrator (factory PM) may not', () => {
    expect(isToolAllowed('main', 'handoff')).toBe(true)
    registry.set('pm-1', { sessionId: 'pm-1', tmuxName: 'pm', topic: 't', threadId: 'pm-thread', createdAt: 1, lastActive: 1, listening: false, engine: 'claude', adapter: {} as any, sessionType: 'master_orchestrator' } as any)
    try { expect(isToolAllowed('pm-1', 'handoff')).toBe(false) } finally { registry.delete('pm-1') }
  })

  test('the command asks main for a letter under STATE_DIR/handoffs, carrying the note', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'ship the alert tests' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]._id).toBe('main')
    const path = delivered[0].content.match(/path="([^"]+)"/)?.[1]
    expect(path?.startsWith(join(STATE_DIR, 'handoffs', 'main-'))).toBe(true)
    expect(delivered[0].content).toContain('ship the alert tests')
    expect(reacted).toContain('🤝')
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
    writeFileSync(path, 'x')
    await executeTool('handoff', { path }, 'main')
    await waitFor(() => sent.some(t => t.includes('main cleared its context')), 5000)
    const seed = keys().find(c => c.includes('Read '))!
    expect(seed).toContain('beta-note'); expect(seed).not.toContain('alpha-note')
  })

  test('the note rides only with the requested letter; any other letter goes without it', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'secret note' })
    const other = join(dir, 'other.md'); writeFileSync(other, 'x')
    await executeTool('handoff', { path: other }, 'main')
    await waitFor(() => sent.some(t => t.includes('main cleared its context')), 5000)
    expect(keys().some(c => c.includes('secret note'))).toBe(false)
  })

  test('a second tool call while one is running is refused, and a command during it too', async () => {
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await handleMainHandoffIntercept(cmd(), {})
    expect(reacted).toContain('❌')
    await waitFor(() => sent.some(t => t.includes('main cleared its context')), 5000)
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

  test('the tool answers first, then types /clear and a one-line seed naming the letter and note', async () => {
    await handleMainHandoffIntercept(cmd(), { note: 'line one\nline two @x' })
    noteMainChannel('some-later-chan')  // main was messaged elsewhere since: the status still goes where the command was typed
    const doc = delivered[0].content.match(/path="([^"]+)"/)![1]; writeFileSync(doc, '# Next action\ndo x\n')
    const res = await executeTool('handoff', { path: doc }, 'main')
    expect(res.isError).toBeFalsy()
    expect(keys()).toEqual([])  // the tool result goes out first; keys follow
    await waitFor(() => sent.some(t => t.includes('main cleared its context')), 5000)
    const typed = keys()
    expect(typed[0]).toContain('/clear')
    expect(typed.some(c => c.includes(`Read ${doc}`) && c.includes('Note from the user: line one line two @\u200bx'))).toBe(true)
    expect(typed.findIndex(c => c.includes('/clear'))).toBeLessThan(typed.findIndex(c => c.includes(`Read ${doc}`)))
    expect(sent.some(t => t.includes('Your note was passed on'))).toBe(true)
    expect(sentTo[sentTo.length - 1]).toBe('main-chan-h')  // the channel the command was typed in
  })

  test('main at a blocking prompt: nothing is typed and the failure names the letter', async () => {
    tmux.pane(BYTE, 'Select login method:\n  1. Claude account\n')
    const doc = join(dir, 'letter.md'); writeFileSync(doc, 'x')
    expect((await executeTool('handoff', { path: doc }, 'main')).isError).toBeFalsy()
    await waitFor(() => sent.some(t => t.includes('main handoff failed')), 5000)
    expect(keys()).toEqual([])
    expect(sent.join('\n')).toContain(doc)
  })
})
