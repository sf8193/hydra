import { describe, expect, test } from 'bun:test'
import { runHomeStatusAction } from '../home-actions.js'
import type { SessionInfo } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'

type Deps = NonNullable<Parameters<typeof runHomeStatusAction>[2]>

function fakeDeps(opts: { connected?: boolean; daemonWarm?: boolean; stuck?: BlockingState; sessionType?: string; sentIds?: string[] } = {}) {
  const calls: string[] = []
  const deps: Deps = {
    session: (id: string) => (id === 's1' ? { sessionId: 's1', tmuxName: 'vale', threadId: 'C1:111.1', sessionType: opts.sessionType ?? 'thread_owner' } as unknown as SessionInfo : undefined),
    connected: () => opts.connected ?? false,
    daemonWarm: () => opts.daemonWarm ?? true,
    stuck: () => opts.stuck ?? null,
    send: async (channelId, text) => { calls.push(`send ${channelId} ${text}`); return opts.sentIds ?? ['222.2'] },
    resume: async (anchor) => { calls.push(`resume ${JSON.stringify(anchor)}`) },
    resolveStuck: async (tmuxName, kind) => { calls.push(`stuck ${tmuxName} ${kind}`) },
    refresh: () => { calls.push('refresh') },
  }
  return { deps, calls }
}

describe('runHomeStatusAction', () => {
  test('disconnected: posts a request note in the thread, then runs resume anchored on it', async () => {
    const { deps, calls } = fakeDeps()
    await runHomeStatusAction('s1', 'disconnected', deps)
    expect(calls).toEqual([
      'send C1:111.1 > ⏯️ Recover requested for **vale** from the Home tab.',
      `resume ${JSON.stringify({ id: '222.2', channelId: 'C1:111.1', isThread: true, effectiveThreadId: 'C1:111.1' })}`,
      'refresh',
    ])
  })

  test.each([
    ['reconnected by click time', { connected: true }],
    ['the daemon restarted under a minute and a half ago, so bridges may still be reconnecting', { daemonWarm: false }],
    ['a guest in another session\'s thread', { sessionType: 'thread_guest' }],
    ['the request note failed to post', { sentIds: [] }],
    ['the probe sees a stuck screen, which has its own fix', { stuck: { kind: 'resume_prompt' as const, planPath: null, loginStage: null, oauthUrl: null } }],
  ])('disconnected but %s: no resume', async (_name, opts) => {
    const { deps, calls } = fakeDeps(opts)
    await runHomeStatusAction('s1', 'disconnected', deps)
    expect(calls.some(c => c.startsWith('resume'))).toBe(false)
    expect(calls.at(-1)).toBe('refresh')
  })

  test.each(['plan_mode', 'login_required', 'resume_prompt', 'usage_limit', 'unknown_dialog'])('%s goes to the stuck-screen handler', async (kind) => {
    const { deps, calls } = fakeDeps()
    await runHomeStatusAction('s1', kind, deps)
    expect(calls).toEqual([`stuck vale ${kind}`, 'refresh'])
  })

  test('any other value only refreshes the Home tab', async () => {
    const { deps, calls } = fakeDeps()
    await runHomeStatusAction('s1', 'working', deps)
    expect(calls).toEqual(['refresh'])
  })

  test('an unknown session only refreshes the Home tab', async () => {
    const { deps, calls } = fakeDeps()
    await runHomeStatusAction('nope', 'plan_mode', deps)
    expect(calls).toEqual(['refresh'])
  })
})
