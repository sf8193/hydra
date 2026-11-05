import { describe, expect, test } from 'bun:test'
import { homeStatus, homeStatusAccessory, parseHomeStatusClick, markUserMessaged, markYourTurn, type HomeStatus, type HomeStatusInputs } from '../home-status.js'
import { __test as dashboardTest } from '../dashboard.js'
import { HOME_STATUS_ACTION_PREFIX } from '../../shared/constants.js'

const idle: HomeStatusInputs = { connected: true, live: 'idle', working: false, stuck: null }

describe('homeStatus', () => {
  test('idle with nothing waiting on you', () => {
    expect(homeStatus(idle)).toBe('idle')
  })

  test('your turn: the last reply is newer than your last message', () => {
    expect(homeStatus({ ...idle, lastReplyAt: 200, lastUserMessageAt: 100 })).toBe('your_turn')
    expect(homeStatus({ ...idle, lastReplyAt: 200 })).toBe('your_turn')
  })

  test('your reply clears your turn', () => {
    expect(homeStatus({ ...idle, lastReplyAt: 100, lastUserMessageAt: 200 })).toBe('idle')
    expect(homeStatus({ ...idle, lastReplyAt: 100, lastUserMessageAt: 100 })).toBe('idle')
  })

  test('working beats your turn: a session mid-turn is not waiting on you', () => {
    expect(homeStatus({ ...idle, live: 'working', working: true, lastReplyAt: 200, lastUserMessageAt: 100 })).toBe('working')
  })

  test('blocked comes from the provider status and beats your turn', () => {
    expect(homeStatus({ ...idle, live: 'blocked', lastReplyAt: 200 })).toBe('blocked')
  })

  test('disconnected beats everything', () => {
    expect(homeStatus({ ...idle, connected: false, working: true, live: 'blocked', stuck: 'usage_limit', lastReplyAt: 200 })).toBe('disconnected')
  })

  test('a stuck screen beats working, blocked and your turn', () => {
    expect(homeStatus({ ...idle, live: 'working', working: true, stuck: 'login_required', lastReplyAt: 200 })).toBe('login_required')
    expect(homeStatus({ ...idle, live: 'blocked', stuck: 'plan_mode' })).toBe('plan_mode')
  })
})

describe('homeStatusAccessory', () => {
  test.each(['disconnected', 'plan_mode', 'resume_prompt', 'unknown_dialog', 'usage_limit', 'login_required'] as const)(
    '%s is an action: no link, a confirm dialog, and the shown state as its value', (status) => {
      const button = homeStatusAccessory(status, 's1', 'https://slack/p1') as { url?: string; value?: string; confirm?: { title: { text: string }; text: { text: string } } }
      expect(button.url).toBeUndefined()
      expect(button.value).toBe(status)
      expect(button.confirm?.title.text.length).toBeLessThanOrEqual(100)
      expect(button.confirm?.text.text.length).toBeLessThanOrEqual(300)
    })

  test('a state the server cannot act on is a plain link', () => {
    const button = homeStatusAccessory('login_required', 's1', 'https://claude.com/oauth', false) as { url?: string; value?: string; confirm?: object }
    expect(button.url).toBe('https://claude.com/oauth')
    expect(button.value).toBeUndefined()
    expect(button.confirm).toBeUndefined()
  })

  test.each(['working', 'blocked', 'your_turn', 'idle'] as const)('%s stays a link to the thread with no value', (status) => {
    const button = homeStatusAccessory(status, 's1', 'https://slack/p1') as { url?: string; value?: string }
    expect(button.url).toBe('https://slack/p1')
    expect(button.value).toBeUndefined()
  })

  test('a link button to the last message, with an action id unique to the session', () => {
    expect(homeStatusAccessory('your_turn', 's1', 'https://slack/p1')).toEqual({
      type: 'button',
      action_id: `${HOME_STATUS_ACTION_PREFIX}s1`,
      text: { type: 'plain_text', text: `●${String.fromCharCode(0x2002)}Your turn`, emoji: true },
      style: 'primary',
      url: 'https://slack/p1',
    })
  })

  test('green for your turn, red for blocked and disconnected, plain otherwise', () => {
    const style = (s: Parameters<typeof homeStatusAccessory>[0]) => (homeStatusAccessory(s, 's1', '') as { style?: string }).style
    expect(style('your_turn')).toBe('primary')
    expect(style('blocked')).toBe('danger')
    expect(style('disconnected')).toBe('danger')
    expect(style('working')).toBeUndefined()
    expect(style('idle')).toBeUndefined()
  })

  test.each([
    ['your_turn', '●'], ['blocked', '■'], ['disconnected', '◌'], ['working', '◑'], ['idle', '○'],
  ] as const)('%s leads with %s and a label', (status, glyph) => {
    const text = (homeStatusAccessory(status, 's1', '') as { text: { text: string } }).text.text
    expect(text.startsWith(glyph + String.fromCharCode(0x2002))).toBe(true)
    expect(text.length).toBeGreaterThan(2)
  })

  test.each([
    ['login_required', 'Login needed'], ['usage_limit', 'Usage limit'], ['plan_mode', 'Plan approval'],
    ['resume_prompt', 'Resume prompt'], ['unknown_dialog', 'Dialog open'],
  ] as const)('stuck on %s shows a red ■ %s', (status, label) => {
    const button = homeStatusAccessory(status, 's1', '') as { text: { text: string }; style?: string }
    expect(button.text.text).toBe(`■${String.fromCharCode(0x2002)}${label}`)
    expect(button.style).toBe('danger')
  })

  test('no url: the button still shows the state but carries no link', () => {
    expect(homeStatusAccessory('working', 's1', '')).not.toHaveProperty('url')
  })
})

describe('Home tab change detection', () => {
  const row = (sessionId: string, status: HomeStatus | null, actionable = false, buttonUrl = '') => ({ sessionId, status, actionable, buttonUrl }) as Parameters<NonNullable<typeof dashboardTest>['statusKey']>[0][number]

  test('a status change on any shown row changes the key, and row order does not', () => {
    const { statusKey } = dashboardTest!
    const base = statusKey([row('a', 'idle'), row('b', 'working')])
    expect(statusKey([row('a', 'your_turn'), row('b', 'working')])).not.toBe(base)
    expect(statusKey([row('b', 'working'), row('a', 'idle')])).toBe(base)
  })

  test('a button turning from action to link, or changing link, changes the key', () => {
    const { statusKey } = dashboardTest!
    const base = statusKey([row('a', 'login_required', true)])
    expect(statusKey([row('a', 'login_required', false)])).not.toBe(base)
    expect(statusKey([row('a', 'login_required', false, 'https://claude.com/oauth')])).not.toBe(base)
    expect(statusKey([row('a', 'login_required', false, 'https://claude.com/oauth2')])).not.toBe(statusKey([row('a', 'login_required', false, 'https://claude.com/oauth')]))
  })
})

describe('your-turn marker', () => {
  test('a reply in the session thread marks your turn; one elsewhere does not', () => {
    const info: { threadId: string; lastReplyAt?: number } = { threadId: 't1' }
    expect(markYourTurn(info, 'other', 100)).toBe(false)
    expect(info.lastReplyAt).toBeUndefined()
    expect(markYourTurn(info, 't1', 200)).toBe(true)
    expect(info.lastReplyAt).toBe(200)
  })

  test('your message clears your turn', () => {
    const info: { threadId: string; lastReplyAt?: number; lastUserMessageAt?: number } = { threadId: 't1', lastReplyAt: 100 }
    markUserMessaged(info, 200)
    expect(homeStatus({ ...idle, lastReplyAt: info.lastReplyAt, lastUserMessageAt: info.lastUserMessageAt })).toBe('idle')
  })
})

describe('dashboard publish coalescing', () => {
  const setup = () => {
    const runs: boolean[] = []
    const gates: (() => void)[] = []
    const request = dashboardTest!.coalesced(onlyIfStatusChanged => {
      runs.push(onlyIfStatusChanged)
      return new Promise<void>(resolve => gates.push(resolve))
    })
    const finishNext = async () => { gates.shift()!(); await Promise.resolve(); await Promise.resolve() }
    return { runs, request, finishNext }
  }

  test('a full refresh asked for during a status-only publish runs once it ends', async () => {
    const { runs, request, finishNext } = setup()
    const first = request(true)
    void request(false)
    void request(false)
    await finishNext()
    await finishNext()
    await first
    expect(runs).toEqual([true, false])
  })

  test('a status tick during a publish is dropped', async () => {
    const { runs, request, finishNext } = setup()
    const first = request(false)
    void request(true)
    await finishNext()
    await first
    expect(runs).toEqual([false])
  })

  test('a failed publish does not wedge later requests', async () => {
    let calls = 0
    const request = dashboardTest!.coalesced(async () => { calls++; if (calls === 1) throw new Error('boom') })
    const saved = process.stderr.write
    process.stderr.write = (() => true) as any
    try {
      await request(false)
      await request(false)
    } finally { process.stderr.write = saved }
    expect(calls).toBe(2)
  })
})

describe('parseHomeStatusClick', () => {
  const id = `${HOME_STATUS_ACTION_PREFIX}s1`
  test('an allowed user clicking an action button', () => {
    expect(parseHomeStatusClick(id, 'plan_mode', 'U1', ['U1'])).toEqual({ sessionId: 's1', shown: 'plan_mode' })
  })
  test.each([
    ['a link button (no value)', id, undefined, 'U1'],
    ['a user not in allowFrom', id, 'plan_mode', 'U2'],
    ['no user', id, 'plan_mode', undefined],
    ['another action id', 'home:spawn', 'plan_mode', 'U1'],
  ])('ignores %s', (_name, actionId, value, userId) => {
    expect(parseHomeStatusClick(actionId, value, userId, ['U1'])).toBeNull()
  })
})

describe('dashboard buttonTarget', () => {
  const target = (...args: Parameters<NonNullable<typeof dashboardTest>['buttonTarget']>) => dashboardTest!.buttonTarget(...args)
  const login = (loginStage: 'blocked' | 'oauth_url', oauthUrl: string | null = null) => ({ kind: 'login_required' as const, planPath: null, loginStage, oauthUrl })
  test('Recover is offered for a thread owner but not a guest', () => {
    expect(target('disconnected', null, 'thread_owner', true).actionable).toBe(true)
    expect(target('disconnected', null, 'thread_guest', true).actionable).toBe(false)
  })
  test('Recover is not offered while the probe sees a stuck screen: that screen has its own fix', () => {
    const resume = { kind: 'resume_prompt' as const, planPath: null, loginStage: null, oauthUrl: null }
    expect(target('disconnected', resume, 'thread_owner', true).actionable).toBe(false)
  })
  test('Recover is not offered right after a daemon restart: bridges are still reconnecting', () => {
    expect(target('disconnected', null, 'thread_owner', false).actionable).toBe(false)
  })
  test('login: blocked is an action, the OAuth URL stage links to the URL', () => {
    expect(target('login_required', login('blocked'), 'thread_owner', true)).toEqual({ actionable: true, oauthUrl: null })
    expect(target('login_required', login('oauth_url', 'https://claude.com/oauth'), 'thread_owner', true)).toEqual({ actionable: false, oauthUrl: 'https://claude.com/oauth' })
  })
  test('a Disconnected row never links to an OAuth URL', () => {
    expect(target('disconnected', login('oauth_url', 'https://claude.com/oauth'), 'thread_owner', true).oauthUrl).toBeNull()
  })
  test('a dialog whose Esc ends the session is not an action', () => {
    const dialog = { kind: 'unknown_dialog' as const, planPath: null, loginStage: null, oauthUrl: null, escEndsSession: true }
    expect(target('unknown_dialog', dialog, 'thread_owner', true).actionable).toBe(false)
  })
})
