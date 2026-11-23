// reconnectSession: the app decides how a Codex record comes back. The adapter makes single attempts; the order
// (resume, wait, new thread) and the "history lost" notice are decided here.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { reconnectSession, resumeRetry } from '../../app/codex-runtime.js'
import type { SessionInfo } from '../../sessions/registry.js'

const sent: string[] = []
let spy: ReturnType<typeof spyOn>
const realRetry = resumeRetry.ms
beforeAll(() => {
  spy = spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'm', channelId: _c } }) as any)
  resumeRetry.ms = 1
})
afterAll(() => { spy.mockRestore(); resumeRetry.ms = realRetry })
afterEach(() => { sent.length = 0 })

type Verdicts = { reachable?: boolean; resume?: 'connected' | 'failed' | 'lost'; fresh?: 'connected' | 'dropped' | 'failed' }
function record(v: Verdicts, thread: string | undefined): { info: SessionInfo; calls: string[] } {
  const calls: string[] = []
  const adapter = {
    provider: 'codex',
    reachable: async () => { calls.push('reachable'); return v.reachable ?? true },
    resumeThread: async () => { calls.push('resume'); return v.resume ?? 'connected' },
    connectNewThread: async () => { calls.push('fresh'); return v.fresh ?? 'connected' },
  }
  return { info: { sessionId: 'rc-s', threadId: '1573000000000000009', tmuxName: 'rc-s', codexThreadId: thread, adapter } as any, calls }
}
const tick = () => new Promise(r => setTimeout(r, 5))

describe('reconnectSession', () => {
  test('nothing to reconnect to: no attempt', async () => {
    const { info, calls } = record({ reachable: false }, 'T')
    expect(await reconnectSession(info)).toBe(false)
    expect(calls).toEqual(['reachable'])
  })

  test('a resume that connects is the whole story: no new thread, no notice', async () => {
    const { info, calls } = record({}, 'T')
    expect(await reconnectSession(info)).toBe(true)
    expect(calls).toEqual(['reachable', 'resume'])
    await tick(); expect(sent).toEqual([])
  })

  test('a resume that is lost (replaced, or dropped on connect) stops: no new thread', async () => {
    const { info, calls } = record({ resume: 'lost' }, 'T')
    expect(await reconnectSession(info)).toBe(false)
    expect(calls).toEqual(['reachable', 'resume'])
  })

  test('a failed resume waits, then starts a new thread and tells the thread the history was lost', async () => {
    const { info, calls } = record({ resume: 'failed' }, 'T')
    expect(await reconnectSession(info)).toBe(true)
    expect(calls).toEqual(['reachable', 'resume', 'fresh'])
    await tick(); expect(sent.some(t => t.includes('conversation history was lost'))).toBe(true)
  })

  test('no thread to resume: straight to a new thread, and no history-lost notice', async () => {
    const { info, calls } = record({}, undefined)
    expect(await reconnectSession(info)).toBe(true)
    expect(calls).toEqual(['reachable', 'fresh'])
    await tick(); expect(sent).toEqual([])
  })

  test('a new thread that fails is a failed reconnect, with no notice', async () => {
    const { info } = record({ resume: 'failed', fresh: 'failed' }, 'T')
    expect(await reconnectSession(info)).toBe(false)
    await tick(); expect(sent).toEqual([])
  })

  test('a new thread whose socket drops right after connecting fails, but the thread is still told its history was lost', async () => {
    const { info } = record({ resume: 'failed', fresh: 'dropped' }, 'T')
    expect(await reconnectSession(info)).toBe(false)
    await tick(); expect(sent.some(t => t.includes('conversation history was lost'))).toBe(true)
  })
})
