// `usage` and `peek` in the main channel read main's on-demand record (daemon/main-session.ts);
// main has no registry record, and every other channel behaves as before.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
delete process.env.BYTE_SESSION_NAME
const { gateway, DEFAULT_SESSION_CHANNEL, _setDefaultSessionChannel } = await import('../config.js')
const { handleUsageIntercept } = await import('../commands/status.js')
const { handlePeekIntercept } = await import('../commands/thread.js')
const { mainSession } = await import('../main-session.js')
const { withFakeTmux } = await import('./fake-tmux.js')
type FakeTmux = ReturnType<typeof withFakeTmux>

const BYTE = 'discord-byte'
const pane = (pct: number) => `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:${pct}%\n`
const msg = (channelId: string, isThread = false) => ({ id: 'm1', channelId, isThread, content: 'usage' }) as any

describe('main channel usage / peek', () => {
  let tmux: FakeTmux
  let sent: string[]
  let reacted: string[]
  const saved = { send: gateway.send, react: gateway.react }
  const priorChannel = DEFAULT_SESSION_CHANNEL
  beforeEach(() => {
    _setDefaultSessionChannel('main-chan-1')
    tmux = withFakeTmux()
    sent = []; reacted = []
    ;(gateway as any).send = async (_c: string, t: string) => { sent.push(t); return 'x' }
    ;(gateway as any).react = async (_c: string, _m: string, e: string) => { reacted.push(e) }
  })
  afterEach(() => { tmux.restore(); Object.assign(gateway, saved); _setDefaultSessionChannel(priorChannel) })

  test('mainSession is undefined while the byte tmux is down, or no default channel is known', () => {
    expect(mainSession()).toBeUndefined()
    tmux.alive(BYTE)
    expect(mainSession()).toBeDefined()
    _setDefaultSessionChannel('')
    expect(mainSession()).toBeUndefined()
  })

  test('usage in the main channel reports main context', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(42))
    await handleUsageIntercept(msg('main-chan-1'))
    expect(reacted).toContain('📈')
    expect(sent.join('\n')).toContain('main hydra session')
    expect(sent.join('\n')).toContain('42%')
  })

  test('usage in the main channel with the byte down is ❌', async () => {
    await handleUsageIntercept(msg('main-chan-1'))
    expect(reacted).toEqual(['❌'])
  })

  test('usage in any other channel is still ❌ even with the byte up', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(42))
    await handleUsageIntercept(msg('some-other-chan'))
    expect(reacted).toEqual(['❌'])
    await handleUsageIntercept(msg('main-chan-1', true))
    expect(reacted).toEqual(['❌', '❌'])
  })

  test('peek (no arg and by name) in the main channel shows main', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(7))
    await handlePeekIntercept(msg('main-chan-1'))
    await handlePeekIntercept(msg('main-chan-1'), 'main')
    expect(reacted.filter(e => e === '📸').length).toBe(2)
    expect(sent.every(t => t.startsWith('📸 **discord-byte**') && t.includes('7%'))).toBe(true)
  })

  test('peek of the byte name outside the main channel is not found', async () => {
    tmux.alive(BYTE); tmux.pane(BYTE, pane(7))
    await handlePeekIntercept(msg('some-other-chan'), BYTE)
    expect(sent.join('\n')).toContain('No session named')
  })
})
