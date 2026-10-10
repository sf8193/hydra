// Pins what `usage` and `peek` say for a thread session, so the main-session work can't change them.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { handleUsageIntercept } from '../commands/status.js'
import { handlePeekIntercept } from '../commands/thread.js'
import { fakeAdapter } from './test-harness.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

let tmux: FakeTmux
let sent: string[]; let reacted: string[]
const saved = { send: gateway.send, react: gateway.react }

beforeEach(() => {
  tmux = withFakeTmux(); tmux.alive('ptn'); tmux.pane('ptn', 'hello\n')
  sent = []; reacted = []
  ;(gateway as any).send = async (_c: string, t: string) => { sent.push(t); return { id: 'x' } }
  ;(gateway as any).react = async (_c: string, _m: string, e: string) => { reacted.push(e) }
  registry.set('ptn-1', {
    sessionId: 'ptn-1', tmuxName: 'ptn', topic: 't', threadId: 'ptn-thread', createdAt: Date.now() - 90_000, lastActive: Date.now(),
    listening: false, engine: 'claude', sessionType: 'thread_owner', messageCount: 5, description: 'my topic',
    sessionMetadata: { role: 'worker', tools: [], model: 'claude-test', cwd: '', platform: 'discord' },
    adapter: fakeAdapter({ usage: () => ({ usedTokens: 0, contextWindow: 0, percent: 33 }), surface: () => 'ptn' }),
  } as any)
  registry.setThread('ptn-thread', 'ptn-1')
})
afterEach(() => { registry.delete('ptn-1'); tmux.restore(); Object.assign(gateway, saved) })

const msg = { id: 'm1', channelId: 'ptn-thread', isThread: true, content: 'x' } as any

test('usage in a thread: description, context, message count, duration, connection', async () => {
  await handleUsageIntercept(msg)
  expect(reacted).toEqual(['📈'])
  expect(sent[0]).toMatch(/`ptn` — my topic\n {4}◦ 33% · 5 msgs · \S+ · (dis)?connected$/)
})

test('peek in a thread: header with model, context, message count, duration', async () => {
  await handlePeekIntercept(msg)
  expect(reacted).toEqual(['📸'])
  expect(sent[0]).toMatch(/^📸 \*\*ptn\*\* · `claude-test` · 33% · 5 msgs · \S+/)
})
