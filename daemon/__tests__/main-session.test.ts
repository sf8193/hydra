// `usage` and `peek` in the main channel read main's on-demand record (daemon/main-session.ts);
// main has no registry record, and every other channel behaves as before.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
delete process.env.BYTE_SESSION_NAME
const { gateway, STATE_DIR } = await import('../config.js')
const { writeMainRecord } = await import('../../shared/main-record.js')
const { handleUsageIntercept } = await import('../commands/status.js')
const { handlePeekIntercept } = await import('../commands/thread.js')
const { mainAlive, mainContext } = await import('../main-session.js')
const { withFakeTmux } = await import('./fake-tmux.js')
const { projectDirName, projectsRoot } = await import('../usage.js')
type FakeTmux = ReturnType<typeof withFakeTmux>

const BYTE = 'discord-byte'
const pane = (pct: number) => `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:${pct}%\n`
const msg = (channelId: string, isThread = false) => ({ id: 'm1', channelId, isThread, content: 'usage' }) as any

describe('main channel usage / peek', () => {
  let tmux: FakeTmux
  let sent: string[]
  let reacted: string[]
  const saved = { send: gateway.send, react: gateway.react }
  beforeEach(() => {
    tmux = withFakeTmux()
    sent = []; reacted = []
    ;(gateway as any).send = async (_c: string, t: string) => { sent.push(t); return 'x' }
    ;(gateway as any).react = async (_c: string, _m: string, e: string) => { reacted.push(e) }
  })
  afterEach(() => { tmux.restore(); Object.assign(gateway, saved); rmSync(join(STATE_DIR, 'main.json'), { force: true }) })

  test('main is alive only while the byte tmux is up; its context comes from the pane footer', () => {
    expect(mainAlive()).toBe(false)
    tmux.alive(BYTE); tmux.pane(BYTE, pane(42))
    expect(mainAlive()).toBe(true)
    expect(mainContext()).toBe('42%')
    tmux.pane(BYTE, 'no footer here')
    expect(mainContext()).toBeNull()
  })

  // The byte as `hydra up` leaves it: Claude Code's status file names its session, whose last turn is at
  // 600k tokens. The pane's GSD bar rescales (100% = auto-compact), so it reads higher.
  const byteRunning = () => {
    mkdirSync(join(tmux.claudeDir, 'sessions'), { recursive: true })
    writeFileSync(join(tmux.claudeDir, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'byte-sid', status: 'idle', tmux: `${BYTE}:@1.%1` }))
    const project = join(projectsRoot(), projectDirName('/tmp/byte-cwd'))
    mkdirSync(project, { recursive: true })
    appendFileSync(join(project, 'byte-sid.jsonl'), JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 600_000 } } }) + '\n')
    tmux.alive(BYTE); tmux.pane(BYTE, `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  Sonnet 5 │ hydra ███████░░░ 72%\n`)
  }

  test('main\'s context comes from its transcript, over the window of the model hydra up recorded launching it with', () => {
    byteRunning()
    writeMainRecord(STATE_DIR, { model: 'claude-sonnet-5[1m]' })
    expect(mainContext()).toBe('60%')
  })

  test('with no main record (a byte launched before it existed, or by start-byte.sh), the pane footer answers', () => {
    byteRunning()
    expect(mainContext()).toBe('72%')
  })

  test('usage with no readable footer still answers, with ?', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, 'no footer here')
    await handleUsageIntercept(msg('chan-a'))
    expect(reacted).toEqual(['📈'])
    expect(sent.join('\n')).toContain('?')
  })

  test('usage in the main channel reports main context', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(42))
    await handleUsageIntercept(msg('chan-a'))
    expect(reacted).toContain('📈')
    expect(sent.join('\n')).toContain('main hydra session')
    expect(sent.join('\n')).toContain('42%')
  })

  test('usage in the main channel with the byte down is ❌', async () => {
    await handleUsageIntercept(msg('chan-a'))
    expect(reacted).toEqual(['❌'])
  })

  test('usage works in any channel outside a thread (main is every non-thread message), not in a thread with no session', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(42))
    await handleUsageIntercept(msg('chan-a'))
    await handleUsageIntercept(msg('chan-b'))
    expect(reacted).toEqual(['📈', '📈'])
    await handleUsageIntercept(msg('thread-x', true))
    expect(reacted).toEqual(['📈', '📈', '❌'])
  })

  test('peek (no arg and by name) outside a thread shows main', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(7))
    await handlePeekIntercept(msg('chan-a'))
    await handlePeekIntercept(msg('chan-b'), 'main')
    expect(reacted.filter(e => e === '📸').length).toBe(2)
    expect(sent.every(t => /^📸 \*\*discord-byte\*\* · main · 7% · \S+/.test(t))).toBe(true)
  })

  test('peek with the byte down says the surface is unavailable', async () => {
    await handlePeekIntercept(msg('chan-a'))
    expect(reacted).toEqual(['❌'])
    expect(sent.join('\n')).toContain('interactive surface unavailable')
  })

  test('peek of the byte name from inside a thread is not found', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(7))
    await handlePeekIntercept(msg('thread-x', true), BYTE)
    expect(sent.join('\n')).toContain('No session named')
  })
})
