import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// Mock daemon modules before importing pane-probe
// ---------------------------------------------------------------------------

const sentMessages: Array<{ channelId: string; text: string }> = []
const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = []

mock.module('../config.js', () => ({
  gateway: {
    send: async (channelId: string, text: string) => {
      sentMessages.push({ channelId, text })
      return { id: `msg-${sentMessages.length}` }
    },
    react: async (channelId: string, messageId: string, emoji: string) => {
      reactions.push({ channelId, messageId, emoji })
    },
    platform: 'discord',
    maxMessageLength: 2000,
  },
  PLATFORM: 'discord',
  DEFAULT_SESSION_CHANNEL: 'root-channel-123',
}))

mock.module('../access.js', () => ({
  loadAccess: () => ({
    allowFrom: ['user-123'],
    groups: {},
  }),
}))

const registryEntries = new Map<string, any>()
mock.module('../sessions.js', () => ({
  registry: {
    values: () => registryEntries.values(),
    get: (id: string) => registryEntries.get(id),
    set: (id: string, info: any) => registryEntries.set(id, info),
    has: (id: string) => registryEntries.has(id),
    delete: (id: string) => registryEntries.delete(id),
    get size() { return registryEntries.size },
    persist: () => {},
    debouncedPersist: () => {},
  },
}))

mock.module('../util.js', () => ({
  safeSend: async (channelId: string, text: string) => {
    sentMessages.push({ channelId, text })
    return [`msg-${sentMessages.length}`]
  },
}))

mock.module('../../discord-table-format.js', () => ({
  formatDiscordTables: (t: string) => t,
}))

import {
  detectBlockingState,
  probeAllSessions,
  getThreadIntercept,
  clearInterceptsForSession,
  _resetForTesting,
  _setIO,
  _resetIO,
  _CONFIRM_PROBES,
  _NOTIFY_COOLDOWN_MS,
  _MAX_NOTIFICATIONS,
  _MIN_IDLE_BEFORE_PROBE_S,
  _PANE_TAIL_LINES,
  _INTERCEPT_GRACE_MS,
  type PaneProbeIO,
  type BlockingState,
} from '../pane-probe.js'

// ---------------------------------------------------------------------------
// Fixtures: real pane captures from live sessions
// ---------------------------------------------------------------------------

const PLAN_MODE_TAIL = `⏺ Entered plan mode
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Claude has written up a plan and is ready to execute. Would you like to
   proceed?

   ❯ 1. Yes, and bypass permissions
     2. Yes, manually approve edits
     3. Tell Claude what to change

   ctrl+g to edit in VS Code · .claude/plans/witty-humming-beaver.md`

const LOGIN_PROMPT_TAIL = `
⚠️  Not authenticated. Please sign in to continue.

Open this URL to sign in:
  https://auth.anthropic.com/authorize?code=abc123

Waiting for authentication...`

const LOGIN_EXPIRING_TAIL = `✻ Wandering… (2m 3s · ↓ 1.2k tokens)
❯
  ctx: 15%
  ⚠️ Your login expires in 1 day · run /login to renew`

const LOGIN_SELECT_METHOD_TAIL = `  Login

  Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.

  Select login method:

  › 1. Claude account with subscription · Pro, Max, Team, or Enterprise
    2. Anthropic Console account · API usage billing
    3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI`

const LOGIN_OAUTH_URL_TAIL = `  Login

  Browser didn't open? Use the url below to sign in (c to copy)

https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=VEtxuL6A

  Paste code here if prompted >`

const LOGIN_SUCCESS_TAIL = `  Login

  Logged in as d.cetlin@hey.com
  Login successful. Press Enter to continue…`

const NORMAL_SESSION_TAIL = `✻ Wandering… (9m 16s · ↓ 9.2k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's
     current work
                                                               ● high · /effort
────────────────────────────────────────────── vps-health-monitoring-buildout ──
❯
────────────────────────────────────────────────────────────────────────────────
  ctx: 9%
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`

const PROSE_MENTIONING_LOGIN = `⏺ Noted — orbit spawned to unblock bloom and design plan-mode/login detection
  mechanism. The /login flow and the plan approval flow are the two cases
  we need to handle. See the design document.

✻ Wandering… (2m 3s · ↓ 1.2k tokens)
❯
  ctx: 15%`

const HISTORICAL_PLAN_MODE = `⏺ Entered plan mode
  Plan: Do something...
⏺ Plan approved. Building now.

✻ Hashing… (1m 36s · ↓ 4.5k tokens)
❯
  ctx: 22%`

// ---------------------------------------------------------------------------
// Test IO — injectable seam
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000
const flush = () => new Promise(r => setTimeout(r, 10))

const paneTails = new Map<string, string>()
const windowActivity = new Map<string, number>()
const keysSent: Array<{ tmuxName: string; keys: string }> = []
const fileContents = new Map<string, string>()

function makeTestIO(): PaneProbeIO {
  return {
    capturePaneTail(tmuxName, _lines) {
      return paneTails.get(tmuxName) ?? null
    },
    getWindowActivity(tmuxName) {
      return windowActivity.get(tmuxName) ?? null
    },
    sendKeys(tmuxName, ...keys) {
      keysSent.push({ tmuxName, keys: keys.join(' ') })
      return true
    },
    readFile(path) {
      return fileContents.get(path) ?? null
    },
    now: () => T0,
  }
}

function addSession(sessionId: string, opts: { tmuxName: string; threadId: string; deadAt?: number; engine?: string }) {
  registryEntries.set(sessionId, { sessionId, ...opts, createdAt: T0, lastActive: T0, listening: true })
}

describe('detectBlockingState (pure)', () => {
  it('detects plan mode when both indicator and options are present', () => {
    const result = detectBlockingState(PLAN_MODE_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('plan_mode')
    expect(result!.planPath).toBe('witty-humming-beaver.md')
  })

  it('does NOT match prose mentioning /login', () => {
    expect(detectBlockingState(PROSE_MENTIONING_LOGIN)).toBeNull()
  })

  it('does NOT match a normal working session', () => {
    expect(detectBlockingState(NORMAL_SESSION_TAIL)).toBeNull()
  })

  it('does NOT match historical plan mode that has been exited', () => {
    expect(detectBlockingState(HISTORICAL_PLAN_MODE)).toBeNull()
  })

  it('detects login prompt (select method)', () => {
    const result = detectBlockingState(LOGIN_SELECT_METHOD_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('login_required')
    expect(result!.loginStage).toBe('blocked')
  })

  it('detects login expiring warning', () => {
    const result = detectBlockingState(LOGIN_EXPIRING_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('login_required')
    expect(result!.loginStage).toBe('expiring')
  })

  it('detects Select login method prompt', () => {
    const result = detectBlockingState(LOGIN_SELECT_METHOD_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('login_required')
    expect(result!.loginStage).toBe('blocked')
  })

  it('detects OAuth URL screen and extracts URL', () => {
    const result = detectBlockingState(LOGIN_OAUTH_URL_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('login_required')
    expect(result!.loginStage).toBe('oauth_url')
    expect(result!.oauthUrl).toContain('claude.com/cai/oauth/authorize')
  })

  it('detects Login successful screen', () => {
    const result = detectBlockingState(LOGIN_SUCCESS_TAIL)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('login_required')
    expect(result!.loginStage).toBe('success')
  })

  it('requires at least two of the three plan options to co-occur', () => {
    // Only one option — not enough
    expect(detectBlockingState('Yes, and bypass permissions\nSome other text')).toBeNull()
    // Two options — enough
    expect(detectBlockingState('Yes, and bypass permissions\nYes, manually approve edits')).not.toBeNull()
  })

  it('detects plan mode from options alone (long plan, Entered plan mode scrolled off)', () => {
    // Simulates what bloom's pane looks like — only the options menu in the tail
    const longPlanTail = `   Phase 2: Activate MCP server globally
   ctrl+g to edit in VS Code · .claude/plans/sparkling-wondering-torvalds.md

   ❯ 1. Yes, and bypass permissions
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback`
    const result = detectBlockingState(longPlanTail)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('plan_mode')
    expect(result!.planPath).toBe('sparkling-wondering-torvalds.md')
  })

  it('captures path traversal attempt but readPlanSummary rejects it', () => {
    const traversalTail = PLAN_MODE_TAIL.replace('witty-humming-beaver.md', '../../../etc/passwd.md')
    const result = detectBlockingState(traversalTail)
    expect(result).not.toBeNull()
    // The regex captures the path, but readPlanSummary rejects paths containing ".."
    expect(result!.planPath).toContain('..')
  })
})

describe('probeAllSessions', () => {
  beforeEach(() => {
    _resetForTesting()
    registryEntries.clear()
    sentMessages.length = 0
    reactions.length = 0
    paneTails.clear()
    windowActivity.clear()
    keysSent.length = 0
    fileContents.clear()
    _setIO(makeTestIO())
  })

  afterEach(() => {
    _resetIO()
  })

  it('does not probe active sessions (idle gate)', () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    // Session was active 5 seconds ago — below MIN_IDLE_BEFORE_PROBE_S
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 5)
    // Also set byte to avoid byte probing
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    expect(sentMessages).toHaveLength(0)
  })

  it('probes idle sessions', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60) // idle 60s
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    // First probe — sets consecutive=1, no notification yet
    probeAllSessions(T0)
    expect(sentMessages).toHaveLength(0)

    // Second probe — confirms, sends notification
    probeAllSessions(T0 + 60_000)
    await flush()
    expect(sentMessages.length).toBeGreaterThan(0)
    expect(sentMessages[0].channelId).toBe('thread-1')
    expect(sentMessages[0].text).toContain('plan approval')
  })

  it('registers intercept on plan mode notification', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()

    const intercept = getThreadIntercept('thread-1')
    expect(intercept).not.toBeUndefined()
    expect(intercept!.kind).toBe('plan_mode')
    expect(intercept!.tmuxName).toBe('bloom')
  })

  it('keeps intercept alive during grace period after detection clears', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000) // notification fires
    await flush()
    expect(getThreadIntercept('thread-1')).not.toBeUndefined()

    // Session resumes — but intercept survives grace period
    paneTails.set('bloom', NORMAL_SESSION_TAIL)
    probeAllSessions(T0 + 120_000)
    expect(getThreadIntercept('thread-1')).not.toBeUndefined() // still alive

    // After grace period expires
    probeAllSessions(T0 + 60_000 + _INTERCEPT_GRACE_MS + 1000)
    expect(getThreadIntercept('thread-1')).toBeUndefined() // now cleared
  })

  it('clears intercept on session death', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()
    expect(getThreadIntercept('thread-1')).not.toBeUndefined()

    // Session dies — clearInterceptsForSession called
    clearInterceptsForSession('bloom')
    expect(getThreadIntercept('thread-1')).toBeUndefined()
  })

  it('clears state when tmux session disappears', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()
    expect(getThreadIntercept('thread-1')).not.toBeUndefined()

    // tmux dies — getWindowActivity returns null
    windowActivity.delete('bloom')
    probeAllSessions(T0 + 120_000)
    expect(getThreadIntercept('thread-1')).toBeUndefined()
  })

  it('skips codex sessions', () => {
    addSession('s1', { tmuxName: 'cedar', threadId: 'thread-1', engine: 'codex' })
    paneTails.set('cedar', PLAN_MODE_TAIL)
    windowActivity.set('cedar', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    // Only byte might trigger, not cedar
    expect(getThreadIntercept('thread-1')).toBeUndefined()
  })

  it('skips dead sessions', () => {
    addSession('s1', { tmuxName: 'cedar', threadId: 'thread-1', deadAt: T0 - 1000 })
    paneTails.set('cedar', PLAN_MODE_TAIL)
    windowActivity.set('cedar', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    expect(getThreadIntercept('thread-1')).toBeUndefined()
  })

  it('auto-triggers /login with re-confirmation when HYDRA_AUTO_LOGIN=1', async () => {
    const origEnv = process.env.HYDRA_AUTO_LOGIN
    process.env.HYDRA_AUTO_LOGIN = '1'
    try {
      addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
      paneTails.set('bloom', LOGIN_SELECT_METHOD_TAIL)
      windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
      windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

      probeAllSessions(T0)
      probeAllSessions(T0 + 60_000)
      await flush()

      const loginKey = keysSent.find(k => k.tmuxName === 'bloom')
      expect(loginKey).not.toBeUndefined()
      expect(loginKey!.keys).toContain('/login')

      const loginMsg = sentMessages.find(m => m.channelId === 'thread-1')
      expect(loginMsg).not.toBeUndefined()
      expect(loginMsg!.text).toContain('authentication')
    } finally {
      if (origEnv !== undefined) process.env.HYDRA_AUTO_LOGIN = origEnv
      else delete process.env.HYDRA_AUTO_LOGIN
    }
  })

  it('does not auto-trigger /login when HYDRA_AUTO_LOGIN is unset', async () => {
    const origEnv = process.env.HYDRA_AUTO_LOGIN
    delete process.env.HYDRA_AUTO_LOGIN
    try {
      addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
      paneTails.set('bloom', LOGIN_SELECT_METHOD_TAIL)
      windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
      windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

      probeAllSessions(T0)
      probeAllSessions(T0 + 60_000)
      await flush()

      const loginKey = keysSent.find(k => k.tmuxName === 'bloom' && k.keys.includes('/login'))
      expect(loginKey).toBeUndefined()

      // Should still notify
      const loginMsg = sentMessages.find(m => m.channelId === 'thread-1')
      expect(loginMsg).not.toBeUndefined()
      expect(loginMsg!.text).toContain('authentication')
    } finally {
      if (origEnv !== undefined) process.env.HYDRA_AUTO_LOGIN = origEnv
    }
  })

  it('tags admin user when byte needs login', async () => {
    paneTails.set('discord-byte', LOGIN_SELECT_METHOD_TAIL)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 60)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()

    const byteMsg = sentMessages.find(m => m.channelId === 'root-channel-123')
    expect(byteMsg).not.toBeUndefined()
    expect(byteMsg!.text).toContain('<@user-123>')
    expect(byteMsg!.text).toContain('all message processing is paused')
  })

  it('respects notification cooldown', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000) // first notification
    await flush()
    const firstCount = sentMessages.length

    probeAllSessions(T0 + 120_000) // within cooldown
    await flush()
    expect(sentMessages.length).toBe(firstCount) // no new message

    probeAllSessions(T0 + _NOTIFY_COOLDOWN_MS + 120_000) // after cooldown
    await flush()
    expect(sentMessages.length).toBeGreaterThan(firstCount) // new notification
  })

  it('stops after _MAX_NOTIFICATIONS', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    // First two probes to confirm
    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()
    const afterFirst = sentMessages.length

    // Send remaining notifications
    for (let i = 1; i < _MAX_NOTIFICATIONS; i++) {
      probeAllSessions(T0 + (i + 1) * _NOTIFY_COOLDOWN_MS + 60_000)
      await flush()
    }
    const afterAll = sentMessages.length
    expect(afterAll).toBeGreaterThan(afterFirst)

    // One more — should not notify
    const afterMax = sentMessages.length
    probeAllSessions(T0 + (_MAX_NOTIFICATIONS + 1) * _NOTIFY_COOLDOWN_MS + 60_000)
    await flush()
    expect(sentMessages.length).toBe(afterMax)
  })

  it('reads BYTE_SESSION_NAME from env', async () => {
    const origEnv = process.env.BYTE_SESSION_NAME
    const origLogin = process.env.HYDRA_AUTO_LOGIN
    process.env.BYTE_SESSION_NAME = 'custom-byte'
    process.env.HYDRA_AUTO_LOGIN = '1'
    try {
      paneTails.set('custom-byte', LOGIN_SELECT_METHOD_TAIL)
      windowActivity.set('custom-byte', Math.floor(T0 / 1000) - 60)

      probeAllSessions(T0)
      probeAllSessions(T0 + 60_000)
      await flush()

      const loginKey = keysSent.find(k => k.tmuxName === 'custom-byte')
      expect(loginKey).not.toBeUndefined()
    } finally {
      if (origEnv !== undefined) process.env.BYTE_SESSION_NAME = origEnv
      else delete process.env.BYTE_SESSION_NAME
      if (origLogin !== undefined) process.env.HYDRA_AUTO_LOGIN = origLogin
      else delete process.env.HYDRA_AUTO_LOGIN
    }
  })
})

describe('intercept handler', () => {
  beforeEach(() => {
    _resetForTesting()
    registryEntries.clear()
    sentMessages.length = 0
    reactions.length = 0
    paneTails.clear()
    windowActivity.clear()
    keysSent.length = 0
    fileContents.clear()
    _setIO(makeTestIO())
  })

  afterEach(() => {
    _resetIO()
  })

  it('approve re-confirms plan is on screen before sending Enter', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()

    const intercept = getThreadIntercept('thread-1')
    expect(intercept).not.toBeUndefined()

    // Approve — plan is still showing
    await intercept!.handler('approve', 'thread-1', 'msg-reply')

    const enterKey = keysSent.find(k => k.tmuxName === 'bloom' && k.keys === 'Enter')
    expect(enterKey).not.toBeUndefined()
    // Intercept cleaned up
    expect(getThreadIntercept('thread-1')).toBeUndefined()
  })

  it('approve fails safely when plan is no longer on screen', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()

    // Session has moved on
    paneTails.set('bloom', NORMAL_SESSION_TAIL)

    const intercept = getThreadIntercept('thread-1')!
    await intercept.handler('approve', 'thread-1', 'msg-reply')

    // No Enter sent — re-confirm failed
    const enterKey = keysSent.find(k => k.tmuxName === 'bloom' && k.keys === 'Enter')
    expect(enterKey).toBeUndefined()
    // Posts "no longer on screen" message
    const noScreen = sentMessages.find(m => m.text.includes('no longer on screen'))
    expect(noScreen).not.toBeUndefined()
  })

  it('reject sends Down Down Enter after re-confirmation', async () => {
    addSession('s1', { tmuxName: 'bloom', threadId: 'thread-1' })
    paneTails.set('bloom', PLAN_MODE_TAIL)
    windowActivity.set('bloom', Math.floor(T0 / 1000) - 60)
    windowActivity.set('discord-byte', Math.floor(T0 / 1000) - 5)

    probeAllSessions(T0)
    probeAllSessions(T0 + 60_000)
    await flush()

    const intercept = getThreadIntercept('thread-1')!
    await intercept.handler('reject', 'thread-1', 'msg-reply')

    const rejectKey = keysSent.find(k => k.tmuxName === 'bloom' && k.keys === 'Down Down Enter')
    expect(rejectKey).not.toBeUndefined()
  })
})

describe('constants', () => {
  it('CONFIRM_PROBES is 2', () => expect(_CONFIRM_PROBES).toBe(2))
  it('_NOTIFY_COOLDOWN_MS is 10 minutes', () => expect(_NOTIFY_COOLDOWN_MS).toBe(600_000))
  it('_MAX_NOTIFICATIONS is 3', () => expect(_MAX_NOTIFICATIONS).toBe(3))
  it('MIN_IDLE_BEFORE_PROBE_S is 30', () => expect(_MIN_IDLE_BEFORE_PROBE_S).toBe(30))
  it('PANE_TAIL_LINES is 8', () => expect(_PANE_TAIL_LINES).toBe(8))
})
