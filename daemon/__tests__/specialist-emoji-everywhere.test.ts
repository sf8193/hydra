// A specialist's `emoji` is the glyph its sessions wear wherever hydra shows a session, not only in thread names (sf8193/hydra#685). Every site that used to
// print the catalog glyph (`sessionEmoji`) asks `emojiOfName` instead; one test per site drives that site through its real function and checks both halves:
//   (a) a session born for a specialist with `emoji = "🔐"` shows 🔐 there, and
//   (b) an ordinary session, a specialist with no emoji, and a name outside the catalog show what they always did (🔣, 🔣, 🔹), byte for byte.
// Not driven here, so each is pinned by a source assertion at the bottom ("the spawn-time sites"): the spawn announcement in daemon.ts (the top-level home spawn
// handler) and the spawn line in doSpawnSession (it runs after a real launch); and the dashboard rows, which need the Slack platform at module load, are in
// specialist-emoji-dashboard.test.ts.
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { gateway, STATE_DIR } from '../../infra/config.js'
import { registry, threadRegistry, sessionEmoji, type SessionInfo } from '../../sessions/registry.js'
import { emojiOf, emojiOfName } from '../../sessions/anchor-state.js'
import { transport } from '../../sessions/bridge-transport.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { engines } from '../../sessions/engine-instances.js'
import { handleListIntercept, handleUsageIntercept, __test as statusTest } from '../../app/commands/status.js'
import { handleForkIntercept, handleForksIntercept, handleResumeIntercept, handleRespawnIntercept, _setRecoveryDeps, _resetRecoveryDeps } from '../../app/commands/thread.js'
import { handleSpawnIntercept } from '../../app/commands/global.js'
import * as lifecycle from '../../app/session-lifecycle.js'
import { killSession } from '../../app/session-lifecycle.js'
import { handleRecoverIntercept } from '../../app/recovery.js'
import { executeTool } from '../../app/bridge-dispatch.js'
import { sendToThread, sendDeps, _resetSends } from '../../app/sends-to.js'
import { mainTmux } from '../../sessions/main.js'
import { protocol } from '../../protocols/dsl.js'
import { onRunAdvance, __test as protocolTest } from '../../app/protocol-runner.js'
import { setSpecialistThread, _reloadSpecialists } from '../../sessions/specialists.js'
import { fakeAdapter } from './test-harness.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const decl = (id: string, over: Record<string, unknown> = {}) => ({ id, workdir: '/srv/x', kickoff: 'k', homePlace: '555', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...over })
const configure = (...specialists: ReturnType<typeof decl>[]) => _setHydraConfigForTesting({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', addresses: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: Object.fromEntries(specialists.map(s => [s.id, s])),
} as any)

/** The four sessions every site is shown: what each wears, and for whom. 'glyph' is a catalog name (🔣); the last is outside it (🔹). */
type Kind = { what: string; name: string; specialist?: string; glyph: string }
const KINDS: Kind[] = [
  { what: 'a session born for a specialist with an emoji', name: 'glyph', specialist: 'ops', glyph: '🔐' },
  { what: 'an ordinary session', name: 'glyph', glyph: '🔣' },
  { what: 'a session born for a specialist with no emoji', name: 'glyph', specialist: 'plain', glyph: '🔣' },
  { what: 'a name outside the catalog', name: 'not-in-the-catalog', glyph: '🔹' },
]
const born = (k: Kind) => k.specialist ? { policy: { specialist: k.specialist, restricted: false } } : {}

let n = 0
const made: SessionInfo[] = []
/** A live, registered session in its own thread. `kid-x` and `par-x` (outside the catalog: 🔹) are the ordinary neighbours a kind is shown beside. */
function mk(name: string, over: Record<string, unknown> = {}): SessionInfo {
  const k = ++n
  const info = {
    sessionId: `eve-s${k}`, tmuxName: name, topic: 'fixing auth middleware', description: 'fixing auth middleware', threadId: `eve-t${k}`, createdAt: Date.now() - 60_000, lastActive: Date.now(),
    listening: false, engine: 'claude', sessionType: 'thread_owner', messageCount: 4,
    adapter: fakeAdapter({ isAlive: () => true, usage: () => null, stop: async () => ({ status: 'stopped' }) }), ...over,
  } as unknown as SessionInfo
  registry.set(info.sessionId, info)
  registry.setThread(info.threadId, info.sessionId)
  made.push(info)
  return info
}
const rm = (s: SessionInfo) => { registry.delete(s.sessionId); registry.deleteThread(s.threadId) }

/** Runs `drive` once per kind with that kind's session registered, then removes it so the next kind can reuse its name. `sent` starts empty each time. */
async function eachKind(drive: (s: SessionInfo, k: Kind) => Promise<void>): Promise<void> {
  for (const k of KINDS) {
    sent.length = 0; edited.length = 0
    const s = mk(k.name, born(k))
    try { await drive(s, k) } finally { rm(s) }
  }
}

const sent: { to: string; text: string }[] = []
const edited: { to: string; id: string; text: string }[] = []
const texts = () => sent.map(s => s.text)
const lines = () => texts().join('\n').split('\n')
const saved = { send: gateway.send, react: gateway.react, edit: gateway.edit, fetchMessages: gateway.fetchMessages, updateSessionVisual: (gateway as any).updateSessionVisual, getThreadUrl: gateway.getThreadUrl, rp: registry.persist, tp: threadRegistry.persist }

beforeEach(() => {
  configure(decl('ops', { emoji: '🔐' }), decl('plain'))
  sent.length = 0; edited.length = 0
  ;(gateway as any).send = async (to: string, text: string) => { sent.push({ to, text }); return { id: `m${sent.length}`, channelId: to } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async (to: string, id: string, text: string) => { edited.push({ to, id, text }); return id }
  ;(gateway as any).fetchMessages = async () => []
  ;(gateway as any).updateSessionVisual = async () => {}
  ;(gateway as any).getThreadUrl = async () => ''
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  statusTest!.setPersist(() => {})
})
afterEach(() => {
  Object.assign(gateway, saved); (gateway as any).updateSessionVisual = saved.updateSessionVisual
  ;(registry as any).persist = saved.rp
  ;(threadRegistry as any).persist = saved.tp
  statusTest!.setTrackedListMsgs([]); statusTest!.resetPersist()
  for (const s of made.splice(0)) rm(s)
  _setHydraConfigForTesting(undefined)
})

// ---------------------------------------------------------------------------
// The one function
// ---------------------------------------------------------------------------

describe('emojiOfName', () => {
  test('the defaults are the catalog glyphs the sites always showed', () => {
    expect(sessionEmoji('glyph')).toBe('🔣')
    expect(sessionEmoji('not-in-the-catalog')).toBe('🔹')
  })

  test('by name and by record agree, for every kind, and a name with no record is its catalog glyph', () => {
    for (const k of KINDS) {
      const s = mk(k.name, born(k))
      try {
        expect(emojiOf(s)).toBe(k.glyph)
        expect(emojiOfName(s.tmuxName)).toBe(emojiOf(s))
      } finally { rm(s) }
    }
    expect(emojiOfName('no-such-session')).toBe('🔹')
    expect(emojiOfName('glyph')).toBe('🔣')
  })
})

// ---------------------------------------------------------------------------
// app/commands/status.ts
// ---------------------------------------------------------------------------

describe('status.ts', () => {
  test('the session row in `list`', async () => {
    await eachKind(async (s, k) => {
      await handleListIntercept({ id: 'm1', channelId: 'chan' } as any)
      // not connected, so the row carries the ⚠️ badge
      expect(lines()).toContain(`${k.glyph} \`${s.tmuxName}\` ⚠️`)
    })
  })

  test('`usage` in a thread: the session line, and the parent a fork or handoff came from', async () => {
    await eachKind(async (s, k) => {
      await handleUsageIntercept({ id: 'm1', channelId: s.threadId, isThread: true } as any)
      expect(lines()[0]).toBe(`${k.glyph} \`${s.tmuxName}\` — fixing auth middleware`)

      for (const [originType, line] of [['fork', '🍴 forked from'], ['handoff', '🤝 handed off from']] as const) {
        sent.length = 0
        const kid = mk('kid-x', { originType, originFrom: s.tmuxName })
        try {
          await handleUsageIntercept({ id: 'm2', channelId: kid.threadId, isThread: true } as any)
          expect(lines()[0]).toBe('🔹 `kid-x` — fixing auth middleware')
          expect(lines()).toContain(`    ◦ ${line} ${k.glyph} \`${s.tmuxName}\``)
        } finally { rm(kid) }
      }
    })
  })

  test('`usage` for the main session: main has no record, so no specialist: its default glyph, whatever hydra.toml says', async () => {
    const tmux = withFakeTmux()
    try {
      const byte = mainTmux()
      tmux.alive(byte); tmux.pane(byte, `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  main ctx:42%\n`)
      await handleUsageIntercept({ id: 'm1', channelId: 'chan-a', isThread: false } as any)
      expect(lines()[0]).toBe(`${sessionEmoji(byte)} \`${byte}\` — main hydra session`)
    } finally { tmux.restore() }
  })
})

// ---------------------------------------------------------------------------
// app/commands/thread.ts
// ---------------------------------------------------------------------------

describe('thread.ts', () => {
  let tmux: FakeTmux
  let spawn: () => Promise<unknown>
  beforeEach(() => {
    tmux = withFakeTmux()
    spawn = async () => { throw new Error('spawn not set') }
    _setRecoveryDeps({
      doSpawnSession: (async () => spawn()) as any,
      tryResume: (async () => spawn()) as any,
      tryRespawn: (async () => spawn()) as any,
    })
  })
  afterEach(() => { tmux.restore(); _resetRecoveryDeps(); for (const t of threadIds.splice(0)) threadRegistry.threads.delete(t) })

  const threadIds: string[] = []
  const spawned = (s: SessionInfo) => ({ name: s.tmuxName, sessionId: s.sessionId, threadId: s.threadId, url: '' })
  /** A live Claude session that a fork reaches natively (it has a native id), or, with `native: false`, only as a continuation. */
  const source = (name: string, over: Record<string, unknown> = {}, native = true) => {
    const s = mk(name, { adapter: engines.claude, sessionMetadata: { model: 'src-model' }, ...(native && { claudeSessionId: 'C-src' }), ...over })
    tmux.alive(name)
    return s
  }
  const at = (s: SessionInfo) => ({ id: 'm1', channelId: s.threadId, isThread: true, parentChannelId: 'parent-chan', effectiveThreadId: s.threadId, content: 'x' }) as any

  test('fork: the reply names the parent and the child (native fork)', async () => {
    await eachKind(async (parent, k) => {
      const kid = mk('kid-x')
      tmux.alive(parent.tmuxName); Object.assign(parent, { adapter: engines.claude, claudeSessionId: 'C-src' })
      spawn = async () => spawned(kid)
      try {
        await handleForkIntercept(at(parent))
        expect(texts().some(t => t.startsWith(`🔹 \`kid-x\` — forked from ${k.glyph} \`${parent.tmuxName}\``))).toBe(true)
      } finally { rm(kid) }
    })
    // the other direction: the kind is the child
    for (const k of KINDS) {
      sent.length = 0
      const par = source('par-x'); const kid = mk(k.name, born(k))
      spawn = async () => spawned(kid)
      try {
        await handleForkIntercept(at(par))
        expect(texts().some(t => t.startsWith(`${k.glyph} \`${k.name}\` — forked from 🔹 \`par-x\``))).toBe(true)
      } finally { rm(par); rm(kid) }
    }
  })

  test('fork: a session with no native id is continued, and the reply names the child', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const par = source('par-x', {}, false); const kid = mk(k.name, born(k))
      spawn = async () => spawned(kid)
      try {
        await handleForkIntercept(at(par))
        expect(texts().some(t => t.startsWith(`${k.glyph} \`${k.name}\` spawned (session not forkable yet — reading thread from **par-x**)`))).toBe(true)
      } finally { rm(par); rm(kid) }
    }
  })

  test('fork: when the fork fails, the fallback spawn names the child', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const par = source('par-x'); const kid = mk(k.name, born(k))
      let calls = 0
      spawn = async () => { if (++calls === 1) throw new Error('fork failed'); return spawned(kid) }
      try {
        await handleForkIntercept(at(par))
        expect(texts().some(t => t.startsWith(`${k.glyph} \`${k.name}\` spawned (reading thread from **par-x**)`))).toBe(true)
      } finally { rm(par); rm(kid) }
    }
  })

  test('forks: "No forks from" names the parent', async () => {
    await eachKind(async (parent, k) => {
      await handleForksIntercept(at(parent))
      expect(texts()).toEqual([`No forks from ${k.glyph} \`${parent.tmuxName}\`.`])
    })
  })

  test('forks: the header names the parent', async () => {
    await eachKind(async (parent, k) => {
      const kid = mk('kid-x', { originType: 'fork', originFrom: parent.tmuxName })
      try {
        await handleForksIntercept(at(parent))
        expect(lines()[0]).toBe(`Forks from ${k.glyph} \`${parent.tmuxName}\``)
      } finally { rm(kid) }
    })
  })

  test('forks: each row names its fork', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const par = mk('par-x'); const kid = mk(k.name, { ...born(k), originType: 'fork', originFrom: 'par-x' })
      try {
        await handleForksIntercept(at(par))
        expect(lines().some(l => l.startsWith(`╰ ${k.glyph} \`${k.name}\` — `))).toBe(true)
      } finally { rm(par); rm(kid) }
    }
  })

  /** A thread with one ended conversation, for the commands that revive it. */
  function thread(threadId: string) {
    threadIds.push(threadId)
    threadRegistry.threads.set(threadId, {
      threadId, topic: 'the topic', threadUrl: `https://x/${threadId}`, respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: `eve-dead-${threadId}`, tmuxName: `eve-dead-${threadId}`, originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 3, model: 'dead-model', claudeSessionId: 'C-1' }],
    } as any)
  }
  const inThread = (threadId: string) => ({ id: 'm1', channelId: threadId, isThread: true, effectiveThreadId: threadId, content: 'x' }) as any

  test('resume: the announcement names the session that came back', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const kid = mk(k.name, born(k)); thread('eve-resume-thread')
      spawn = async () => spawned(kid)
      try {
        await handleResumeIntercept(inThread('eve-resume-thread'))
        expect(texts().some(t => t.startsWith(`⏯️ ${k.glyph} \`${k.name}\` resumed — full context restored`))).toBe(true)
      } finally { rm(kid) }
    }
  })

  test('respawn: the announcement names the new session', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const kid = mk(k.name, born(k)); thread('eve-respawn-thread')
      spawn = async () => spawned(kid)
      try {
        await handleRespawnIntercept(inThread('eve-respawn-thread'))
        expect(texts().some(t => t.startsWith(`🔁 ${k.glyph} \`${k.name}\` respawned`))).toBe(true)
      } finally { rm(kid) }
    }
  })
})

// ---------------------------------------------------------------------------
// app/commands/global.ts
// ---------------------------------------------------------------------------

describe('global.ts spawn announcements', () => {
  const toMain: string[] = []
  const spies: Array<{ mockRestore(): void }> = []
  let result: SessionInfo
  beforeEach(() => {
    toMain.length = 0
    spies.push(
      spyOn(lifecycle, 'doSpawnSession').mockImplementation((async () => ({ name: result.tmuxName, sessionId: result.sessionId, threadId: result.threadId, url: '' })) as any),
      spyOn(transport, 'get').mockImplementation(((id: string) => id === 'main' ? { fake: 'main' } : undefined) as any),
      spyOn(transport, 'sendToBridge').mockImplementation(((_b: unknown, m: { content: string }) => { toMain.push(m.content) }) as any),
    )
  })
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })

  const spawnFrom = (isDM: boolean) => handleSpawnIntercept({ id: 'm1', channelId: 'chan', isDM, isThread: false, authorUsername: 'u' } as any, 'a topic')

  test('the reply to a DM', async () => {
    for (const k of KINDS) {
      sent.length = 0
      result = mk(k.name, born(k))
      try {
        await spawnFrom(true)
        expect(lines()).toContain(`Spawned ${k.glyph} \`${k.name}\``)
      } finally { rm(result) }
    }
  })

  test('the notice to the main session', async () => {
    for (const k of KINDS) {
      toMain.length = 0
      result = mk(k.name, born(k))
      try {
        await spawnFrom(false)
        expect(toMain).toEqual([`[system] Spawned ${k.glyph} \`${k.name}\` for: a topic`])
      } finally { rm(result) }
    }
  })
})

// ---------------------------------------------------------------------------
// app/session-lifecycle.ts, app/recovery.ts
// ---------------------------------------------------------------------------

describe('session-lifecycle.ts', () => {
  test('the death notice a child sends its parent', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const parent = mk('par-x'); const child = mk(k.name, { ...born(k), originType: 'fork', originFrom: 'par-x', parentId: parent.sessionId })
      try {
        await killSession(child, 'session ended')
        expect(sent).toContainEqual({ to: parent.threadId, text: `${k.glyph} \`${k.name}\` died — _session ended_ (4 msgs)` })
      } finally { rm(parent); rm(child) }
    }
  })

  test('a guest\'s spawn line, edited when it leaves', async () => {
    for (const k of KINDS) {
      edited.length = 0
      const guest = mk(k.name, { ...born(k), sessionType: 'thread_guest', spawnAnnounceId: 'ann-1', initiator: 'tester', originType: 'spawn' })
      try {
        await killSession(guest, 'session ended')
        expect(edited).toHaveLength(1)
        expect(edited[0].text).toStartWith(`> ⚡ spawned [ ${k.glyph} ${k.name} ] · model \`unknown\` · by spawn from tester`)
      } finally { rm(guest) }
    }
  })
})

describe('recovery.ts', () => {
  afterEach(() => { _resetRecoveryDeps() })

  test('the "recovered" line in the thread', async () => {
    const tmux = withFakeTmux()
    try {
      for (const k of KINDS) {
        sent.length = 0
        const back = mk(k.name, born(k))
        const dead = mk('dead-x', { adapter: engines.claude, deadAt: 1, claudeSessionId: 'C-1' })
        threadRegistry.set(dead.threadId, { threadId: dead.threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [] } as any)
        _setRecoveryDeps({ tryResume: (async () => ({ name: back.tmuxName, sessionId: back.sessionId, threadId: back.threadId })) as any })
        try {
          await handleRecoverIntercept({ channelId: 'ch', id: 'm1' } as any, 'dead-x')
          expect(sent).toContainEqual({ to: dead.threadId, text: `${k.glyph} \`${k.name}\` recovered (resumed)` })
        } finally { rm(back); rm(dead); threadRegistry.threads.delete(dead.threadId) }
      }
    } finally { tmux.restore() }
  })
})

// ---------------------------------------------------------------------------
// app/protocol-runner.ts
// ---------------------------------------------------------------------------

describe('protocol-runner.ts', () => {
  const proto = protocol('emoji-review', {
    emoji: '🧪', display: 'Emoji Review', cancelPhase: 'cancelled', cleanupPhase: 'closing',
    roles: { critic: 'The Critic', owner: 'The Owner' },
    phases: {
      critic_turn: { actor: 'critic', half: 'top', on: { posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'posted' },
      owner_turn: { actor: 'owner', half: 'bottom', on: { posted: 'critic_turn', final: 'closing', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'posted', finalAdvanceEvent: 'final' },
      closing: { actor: 'owner', half: 'top', on: { summary: 'complete', timeout: 'complete' }, advanceEvent: 'summary' },
      complete: { actor: 'owner', half: 'top', on: {} },
      cancelled: { actor: 'owner', half: 'top', on: {} },
    },
    windows: { critic_turn: '10m', owner_turn: '30m', closing: '5m' },
    grace: { critic: '30s', owner: '2m' },
    decisions: {},
    seed: {},
  } as any)
  const { runs, threadToRun, sessionToRun } = protocolTest!
  afterEach(() => {
    for (const [, run] of runs) { if (run.timeout) clearTimeout(run.timeout); if (run._healthMonitor) clearInterval(run._healthMonitor); for (const t of run.disconnectTimers.values()) clearTimeout(t) }
    runs.clear(); threadToRun.clear(); sessionToRun.clear(); transport.messageQueues.clear()
  })

  test('the "is working..." line names the actor whose turn it is', async () => {
    for (const k of KINDS) {
      sent.length = 0
      const owner = mk(k.name, born(k))
      const run = {
        id: 'emoji-run', protocol: proto, threadId: 'emoji-run-thread', ownerSessionId: owner.sessionId, phase: 'critic_turn', currentRound: 1, rounds: 3,
        startedAt: Date.now(), _extensions: 0, _phaseStartedAt: Date.now(), params: {},
        participants: new Map([['critic', 'emoji-critic'], ['owner', owner.sessionId]]),
        sessionToRole: new Map([['emoji-critic', 'critic'], [owner.sessionId, 'owner']]),
        protocolChildren: new Map(), timeout: undefined, disconnectTimers: new Map(), decisions: [], messageIds: [], statusHistory: [], strike: false, ext: {},
      } as any
      runs.set(run.id, run); threadToRun.set(run.threadId, run.id)
      sessionToRun.set('emoji-critic', run.id); sessionToRun.set(owner.sessionId, run.id)
      try {
        const r = await onRunAdvance('emoji-critic', 'Your code is bad.')
        expect(r.ok).toBe(true)
        expect(run.statusHistory.some((l: string) => l.endsWith(`— ${k.glyph} ${k.name} (The Owner) is working...`))).toBe(true)
      } finally { rm(owner); if (run.timeout) clearTimeout(run.timeout); runs.clear(); threadToRun.clear(); sessionToRun.clear() }
    }
  })
})

// ---------------------------------------------------------------------------
// app/bridge-dispatch.ts (send_to_thread's quiet send)
// ---------------------------------------------------------------------------

describe('bridge-dispatch.ts: the line a session-to-session send posts in each thread', () => {
  const real = { deliver: transport.deliver }
  beforeEach(() => { ;(transport as any).deliver = async () => ({ status: 'accepted' }) })
  afterEach(() => { Object.assign(transport, real) })
  const send = (from: string, target: string) => executeTool('send_to_thread', { target, type: 'result', text: 'body', summary: 'PR up' }, from)

  test('both parties: the sender in the recipient\'s thread, the recipient in the sender\'s', async () => {
    for (const k of KINDS) {
      sent.length = 0
      // the kind sends to an ordinary session, then receives from one
      const a = mk(k.name, born(k)); const b = mk('kid-x')
      try {
        await send(a.sessionId, b.tmuxName)
        expect(sent.find(s => s.to === b.threadId)!.text).toMatch(new RegExp(`^📨 from ${k.glyph} ${k.name} →`))
        expect(sent.find(s => s.to === a.threadId)!.text).toMatch(/^📤 to 🔹 kid-x →/)
        sent.length = 0
        await send(b.sessionId, a.tmuxName)
        expect(sent.find(s => s.to === a.threadId)!.text).toMatch(/^📨 from 🔹 kid-x →/)
        expect(sent.find(s => s.to === b.threadId)!.text).toMatch(new RegExp(`^📤 to ${k.glyph} ${k.name} →`))
      } finally { rm(a); rm(b) }
    }
  })

  test('a sender with no record (main) is named with its default glyph', async () => {
    const b = mk('kid-x')
    try {
      await send('main', b.tmuxName)
      expect(sent.find(s => s.to === b.threadId)!.text).toMatch(new RegExp(`^📨 from ${sessionEmoji('main')} main →`))
    } finally { rm(b) }
  })
})

// ---------------------------------------------------------------------------
// app/sends-to.ts
// ---------------------------------------------------------------------------

describe('sends-to.ts: the note a restricted specialist\'s hand-off leaves in the receiver\'s thread', () => {
  const real = { ...sendDeps }
  const notes: { threadId: string; line: string }[] = []
  beforeEach(() => {
    notes.length = 0; _resetSends()
    sendDeps.land = async () => ({ threadId: 'eve-deep-thread' })
    sendDeps.linkOf = async () => undefined
    sendDeps.note = async (threadId, line) => { notes.push({ threadId, line }) }
  })
  afterEach(() => { Object.assign(sendDeps, real); rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true }); _reloadSpecialists() })

  const asSpecialist = async (id: string) => {
    const s = mk(`${id}-session`, { sessionType: 'thread_owner', policy: { specialist: id, restricted: true, id: 'x' }, threadId: `eve-home-${id}` })
    setSpecialistThread(id, s.threadId)
    try { await sendToThread(s.sessionId, { target: 'deep', type: 'result', text: 'the answer', chat_id: 'eve-chat' }) } finally { rm(s) }
    return notes.at(-1)?.line
  }

  // The note names the sending specialist by its id (`from ops`), so its emoji is the specialist's own: 🔐 for `ops`.
  test('a specialist with an emoji wears it', async () => {
    expect(await asSpecialist('ops')).toMatch(/^📨 from 🔐 ops/)
  })

  test('a specialist with no emoji, and one whose id is a catalog name, keep their default glyph', async () => {
    configure(decl('ops', { emoji: '🔐' }), decl('plain'), decl('glyph'))
    expect(await asSpecialist('plain')).toMatch(/^📨 from 🔹 plain/)
    expect(await asSpecialist('glyph')).toMatch(/^📨 from 🔣 glyph/)
  })
})

// ---------------------------------------------------------------------------
// One function answers: no site reads the catalog glyph directly
// ---------------------------------------------------------------------------

const root = resolve(import.meta.dir, '..', '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

describe('no site reads the catalog glyph', () => {
  test('only the definition (sessions/registry.ts) and the fallback (sessions/anchor-state.ts) reference sessionEmoji', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir))) {
        const rel = join(dir, e)
        if (e === '__tests__' || e === 'node_modules') continue
        if (statSync(join(root, rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx|js|mjs)$/.test(e)) files.push(rel)
      }
    }
    for (const dir of ['app', 'infra', 'engines', 'sessions', 'protocols', 'shared', 'gateways']) walk(dir)
    files.push('daemon.ts')
    expect(files.length).toBeGreaterThan(50)   // the walk found the tree, not nothing
    const holders = files.filter(f => /\bsessionEmoji\b/.test(read(f))).map(f => relative('.', f)).sort()
    expect(holders).toEqual(['sessions/anchor-state.ts', 'sessions/registry.ts'])
  })
})

// The spawn-time sites cannot be driven without a live launch (a real tmux session and bridge) or the gateway's top-level wiring, so, like the thread name at spawn
// (specialist-emoji-thread-name.test.ts), they are pinned to take their glyph from emojiOfName.
describe('the spawn-time sites (source-pinned)', () => {
  test('the spawn line doSpawnSession posts in the new session\'s thread', () => {
    const src = read('app/session-lifecycle.ts')
    expect(src).toMatch(/const spawnLine = formatSpawnLine\(\{[^}]*emoji: emojiOfName\(tmuxName\),/s)
  })

  test('the home spawn announcement in daemon.ts', () => {
    const src = read('daemon.ts')
    expect(src).toMatch(/\[system\] Spawned \$\{emojiOfName\(result\.name\)\} \\`\$\{result\.name\}\\`/)
  })
})

describe('a name is resolved to the right record', () => {
  const own = { policy: { specialist: 'ops', restricted: false as const } }

  test('an older record holding the name (a dead predecessor) does not hide its successor', () => {
    configure(decl('ops', { emoji: '🔐' }))
    mk('glyph', { createdAt: Date.now() - 90_000 })
    mk('glyph', { ...own, createdAt: Date.now() - 1000 })
    expect(emojiOfName('glyph')).toBe('🔐')
  })

  test('a record alone still answers, and no record at all is the catalog glyph', () => {
    configure(decl('ops', { emoji: '🔐' }))
    mk('glyph', own)
    expect(emojiOfName('glyph')).toBe('🔐')
    expect(emojiOfName('not-in-the-catalog')).toBe('🔹')
  })

  test('contentEmoji outranks the specialist, which outranks the catalog', () => {
    configure(decl('ops', { emoji: '🔐' }))
    expect(emojiOf({ tmuxName: 'glyph', contentEmoji: '🧪', ...own } as any)).toBe('🧪')
    expect(emojiOf({ tmuxName: 'glyph', ...own } as any)).toBe('🔐')
  })
})
