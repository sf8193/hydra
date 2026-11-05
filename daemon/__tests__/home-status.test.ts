import { describe, expect, test } from 'bun:test'
import { homeStatus, homeStatusAccessory, markUserMessaged, markYourTurn, type HomeStatus, type HomeStatusInputs } from '../home-status.js'
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
  const row = (sessionId: string, status: HomeStatus | null) => ({ sessionId, status }) as Parameters<NonNullable<typeof dashboardTest>['statusKey']>[0][number]

  test('a status change on any shown row changes the key, and row order does not', () => {
    const { statusKey } = dashboardTest!
    const base = statusKey([row('a', 'idle'), row('b', 'working')])
    expect(statusKey([row('a', 'your_turn'), row('b', 'working')])).not.toBe(base)
    expect(statusKey([row('b', 'working'), row('a', 'idle')])).toBe(base)
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
