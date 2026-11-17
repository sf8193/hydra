import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../daemon/config.js'
import { noteMainChannel } from '../../../daemon/main-session.js'
import { registry } from '../../../daemon/sessions.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import {
  getSlackWatcher, bindConversation, unbindConversation, formatConversations, formatConversationsFor, operatorBind, refreshSlackSpecialistSurface, slackWatchHealth, slackTokens, slackRuntimeDeps, parseConversation, replyInConversation, targetFor, startSlackWatch, stopSlackWatch,
} from '../runtime.js'
import { sessionCapabilities, isSpecialistOccupant, isToolAllowed } from '../../../daemon/tool-surface.js'
import { emit } from '../../../daemon/event-bus.js'
import { transport } from '../../../daemon/bridge-transport.js'
import { handleCLIRequest, type CLIRequest } from '../../../daemon/cli-handler.js'
import { executeTool } from '../../../daemon/bridge-dispatch.js'
import { alsoHeard, BASE, hydra, view } from './slack-config.js'
import { slackEnvNames } from '../../../config/token-vars.js'
import { defaultSlackApp } from '../../../config/types.js'
import { registerSpawnVars } from '../../../shared/spawn-env.js'
import { fakeAdapter } from '../../../daemon/__tests__/test-harness.js'

process.stderr.write = (() => true) as any

const FOOD = 'food-t'
const FOOD_THREAD = 'food-thread-1'
const OPS = 'ops-t'
const OPS_THREAD = 'ops-thread-1'
const TOML = `${BASE}
[people.olive]
addresses = ["slack:UOWNER"]
roles = ["owner"]
[specialists.${FOOD}]
workdir = "/w/food"
reachable_by = ["anyone"]
[[rules]]
place = "slack:C1"
target = "specialist:${FOOD}"
[specialists.${OPS}]
workdir = "/w/ops"
reachable_by = ["owner"]
[[rules]]
place = "slack:C2"
target = "specialist:${OPS}"
`
let current = TOML
function configure(toml = TOML, over: Parameters<typeof view>[1] = {}) {
  current = toml
  _setHydraConfigForTesting(hydra(toml))
  const v = view(toml, { maxWatches: 3, ...over })
  slackRuntimeDeps.view = () => v
}
const food = { threadId: FOOD_THREAD }
const stranger = { threadId: 'some-other-thread' }
let n = 0
const req = (command: string, params: Record<string, unknown>): CLIRequest => ({ type: 'cli', command, id: `sw-${++n}`, params })

const sessionIds: string[] = []
const realPost = slackRuntimeDeps.post
const posts: string[] = []
const fakePost = (fail?: number) => { posts.length = 0; let n = 0; slackRuntimeDeps.post = async (c, t, text) => { if (++n === fail) throw new Error('ratelimited'); posts.push(`${c}|${t ?? '-'}|${text}`); return `${n}.000001` } }
const session = (id: string, threadId: string) => {
  sessionIds.push(id)
  registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
}
beforeEach(() => {
  configure()
  // hydra.toml declares the recipes; the daemon keeps only where each one lives
  setSpecialistThread(FOOD, FOOD_THREAD)
  setSpecialistThread(OPS, OPS_THREAD)
})
afterEach(() => {
  for (const e of getSlackWatcher().list()) getSlackWatcher().unwatch(e.channel, e.threadTs)
  for (const s of sessionIds.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
  _reloadSpecialists()
  slackRuntimeDeps.view = () => null
  slackRuntimeDeps.post = realPost
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
})

describe('the specialist capability', () => {
  test("only a session in a hydra.toml specialist's thread has the conversation tools", () => {
    expect(isSpecialistOccupant(food)).toBe(true)
    expect(isSpecialistOccupant(stranger)).toBe(false)
    expect(sessionCapabilities({ ...food, capabilities: [], engine: 'claude' } as any).has('conversations')).toBe(true)
    expect(sessionCapabilities({ ...stranger, capabilities: [], engine: 'claude' } as any).has('conversations')).toBe(false)

    const add = (id: string, threadId: string) => {
      sessionIds.push(id)
      registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    }
    add('sw-in-specialist', FOOD_THREAD)
    add('sw-elsewhere', 'some-other-thread')
    expect(isToolAllowed('sw-in-specialist', 'bind_conversation')).toBe(true)
    expect(isToolAllowed('sw-in-specialist', 'unbind_conversation')).toBe(true)
    expect(isToolAllowed('sw-elsewhere', 'bind_conversation')).toBe(false)
    expect(isToolAllowed('main', 'bind_conversation')).toBe(false)
  })

  test('a specialist with a session record but not in hydra.toml is granted nothing', () => {
    configure(BASE)
    expect(isSpecialistOccupant(food)).toBe(false)
  })
})

describe('any session listens to a Slack thread: bound to its own thread', () => {
  const MINE = '1552619225032425525'
  const OTHER = '1552619225032425526'
  test('a thread session gets the conversation tools once Slack is connected; a protocol guest and an unconnected install do not', async () => {
    session('sw-listener', MINE)
    expect(isToolAllowed('sw-listener', 'bind_conversation')).toBe(true)
    expect(isToolAllowed('sw-listener', 'unbind_conversation')).toBe(true)
    sessionIds.push('sw-guest')
    registry.set('sw-guest', { sessionId: 'sw-guest', tmuxName: 'sw-guest', threadId: MINE, sessionType: 'thread_guest', engine: 'claude', createdAt: Date.now() } as any)
    expect(isToolAllowed('sw-guest', 'bind_conversation')).toBe(false)
    await expect(bindConversation({ threadId: MINE, sessionType: 'thread_guest' }, 'slack:C9:1.000001')).rejects.toThrow('no thread to bind')
    configure(TOML.replace(/\[slack\.apps\.default\][^[]*/, ''))
    expect(sessionCapabilities({ threadId: MINE, sessionType: 'thread_owner', capabilities: [], engine: 'claude' } as any).has('conversations')).toBe(false)
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow('Slack is not connected')
  })

  test('it binds a thread anywhere to itself, sees it in list_watches, lets go of it; another session can neither unbind nor take it', async () => {
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1793732224.093059')).toContain('is bound to this session')
    expect(getSlackWatcher().get('C9', '1793732224.093059')).toMatchObject({ specialist: MINE, mentionedBy: 'tool' })
    expect(formatConversationsFor({ threadId: MINE }).join()).toContain('slack:C9:1793732224.093059')
    expect(formatConversationsFor({ threadId: OTHER })).toEqual([])
    expect(() => unbindConversation({ threadId: OTHER }, 'slack:C9:1793732224.093059')).toThrow(`is bound to ${MINE}, not ${OTHER}`)
    await expect(bindConversation({ threadId: OTHER }, 'slack:C9:1793732224.093059')).rejects.toThrow(`is bound to ${MINE}; only the operator moves it`)
    expect(unbindConversation({ threadId: MINE }, 'slack:C9:1793732224.093059')).toBe('slack:C9:1793732224.093059 is unbound')
  })

  test("a session never binds a DM or a channel's top level", async () => {
    await expect(bindConversation({ threadId: MINE }, 'slack:D0OP')).rejects.toThrow('only a thread can be bound by hand')
    await expect(bindConversation({ threadId: MINE }, 'slack:C9')).rejects.toThrow('only a thread can be bound by hand')
  })

  test('a specialist takes a thread a session only listens to, where it listens, and the session is told', async () => {
    const told: [string, string][] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (c: string, text: string) => { told.push([c, text]); return 'id' }
    try {
      await bindConversation({ threadId: MINE }, 'slack:C1:5.000001')
      expect(await bindConversation(food, 'slack:C1:5.000001')).toStartWith(`slack:C1:5.000001 is bound to ${FOOD}`)
      expect(getSlackWatcher().get('C1', '5.000001')?.specialist).toBe(FOOD)
      await expect(bindConversation({ threadId: MINE }, 'slack:C1:5.000001')).rejects.toThrow(`is bound to ${FOOD}`)
      await Bun.sleep(5)
      expect(told.some(([c, t]) => c === MINE && t.includes(`${FOOD} took it`))).toBe(true)
    } finally { (gateway as any).send = realSend }
  })

  test('the operator can bind a thread to a session; hydra conversations shows the session by name', () => {
    session('sw-named', MINE)
    expect(operatorBind('slack:C9:8.000001', MINE)).toBe(`slack:C9:8.000001 → ${MINE}`)
    expect(formatConversations().find(l => l.startsWith('slack:C9:8.000001'))).toContain(`→ sw-named (listening, thread ${MINE})`)
  })

  describe('a session thread keeps its bound conversations while no session is in it', () => {
    const woken: { apps?: string[]; why?: string }[] = []
    const realWake = slackRuntimeDeps.wake
    beforeEach(() => { woken.length = 0; slackRuntimeDeps.wake = (apps, why) => { woken.push({ apps, why }) }; stopSlackWatch(); startSlackWatch() })
    afterEach(() => { slackRuntimeDeps.wake = realWake; jest.useRealTimers(); stopSlackWatch() })
    const told = (): [string, string][] => { const out: [string, string][] = []; (gateway as any).send = async (c: string, text: string) => { out.push([c, text]); return 'id' }; return out }

    test('a session that ends without being killed (a crash), then resumed after what used to be the grace: still bound, nothing said, and the owed messages are delivered at once', async () => {
      const realSend = gateway.send
      try {
        const out = told()
        jest.useFakeTimers()
        session('sw-first', MINE)
        await bindConversation({ threadId: MINE }, 'slack:C9:6.000001')
        getSlackWatcher().handle({ channel: 'C9', ts: '6.000002', threadTs: '6.000001', user: 'UANYONE', text: 'while you were gone' } as any)
        ;(registry.get('sw-first') as any).deadAt = 1
        emit('session:death', { sessionId: 'sw-first', threadId: MINE, wasOwner: true, tmuxName: 'sw-first' })
        jest.advanceTimersByTime(61_000)                                     // past the 60 s an empty thread used to be given
        jest.advanceTimersByTime(7 * 86_400_000 - 62_000)                    // and the whole idle week but one minute
        expect(getSlackWatcher().get('C9', '6.000001')?.specialist).toBe(MINE)
        expect(out.filter(([, t]) => t.includes('stopped listening'))).toEqual([])
        expect(woken).toEqual([])                                            // no session in the thread: nothing to deliver yet
        session('sw-resumed', MINE)
        emit('session:bridge-registered', { sessionId: 'sw-resumed', threadId: MINE })
        expect(woken).toEqual([{ apps: ['default'], why: 'a session registered in the thread' }])
      } finally { (gateway as any).send = realSend }
    })

    test("a kill unbinds its thread's conversations at once, says so once in the thread, and keeps nothing owed; another thread's are untouched", async () => {
      const realSend = gateway.send
      try {
        const out = told()
        await bindConversation({ threadId: MINE }, 'slack:C9:12.000001')
        await bindConversation({ threadId: MINE }, 'slack:C9:13.000001')
        await bindConversation({ threadId: OTHER }, 'slack:C9:14.000001')
        getSlackWatcher().handle({ channel: 'C9', ts: '12.000002', threadTs: '12.000001', user: 'UANYONE', text: 'owed' } as any)
        await getSlackWatcher().flush()
        expect(getSlackWatcher().get('C9', '12.000001')?.owed).toHaveLength(1)
        emit('session:death', { sessionId: 'killed', threadId: MINE, wasOwner: true, tmuxName: 'killed', deliberate: true })
        await new Promise(r => setTimeout(r, 20))
        expect(getSlackWatcher().get('C9', '12.000001')).toBeUndefined()
        expect(getSlackWatcher().get('C9', '13.000001')).toBeUndefined()
        expect(getSlackWatcher().get('C9', '14.000001')?.specialist).toBe(OTHER)
        const said = out.filter(([c]) => c === MINE).map(([, t]) => t)
        expect(said).toHaveLength(1)                                           // one notice, not one per conversation, and not a second for the owed drop
        expect(said[0]).toContain('This session was killed')
        expect(said[0]).toContain('Bind again with `bind_conversation` to resume')
        expect(said[0]).toContain('(1 owed dropped)')
        expect(woken).toEqual([])
        session('sw-resumed', MINE)
        emit('session:bridge-registered', { sessionId: 'sw-resumed', threadId: MINE })
        expect(woken).toEqual([])                                              // nothing was kept to deliver
      } finally { (gateway as any).send = realSend }
    })

    test('a handoff successor, a respawn and a reconnect all register a bridge in the thread, and each delivers only what is owed there', async () => {
      await bindConversation({ threadId: MINE }, 'slack:C9:7.000001')        // owes nothing
      emit('session:bridge-registered', { sessionId: 'sw-successor', threadId: MINE })
      expect(woken).toEqual([])                                              // no owed message, no pass
      getSlackWatcher().handle({ channel: 'C9', ts: '7.000002', threadTs: '7.000001', user: 'UANYONE', text: 'held' } as any)
      await getSlackWatcher().flush()                                        // no session is in the thread: the delivery fails and stays owed
      expect(getSlackWatcher().get('C9', '7.000001')?.owed).toEqual(['7.000002'])
      expect(transport.messageQueues.get('main') ?? []).toEqual([])          // owed to the thread's owner, never sent to main
      emit('session:bridge-registered', { sessionId: 'sw-successor', threadId: OTHER })   // another thread's session
      expect(woken).toEqual([])
      emit('session:bridge-registered', { sessionId: 'sw-successor', threadId: MINE })
      expect(woken).toEqual([{ apps: ['default'], why: 'a session registered in the thread' }])
    })

    test('a session thread the platform says is deleted lets its conversations go, at its session\'s death; one it cannot confirm, or another thread, keeps its own', async () => {
      const real = gateway.threadExists
      const logged: string[] = []
      const realWrite = process.stderr.write
      process.stderr.write = ((c: any) => { logged.push(String(c)); return true }) as any
      try {
        await bindConversation({ threadId: MINE }, 'slack:C9:8.000001')
        await bindConversation({ threadId: OTHER }, 'slack:C9:9.000001')
        ;(gateway as any).threadExists = async (t: string) => t !== MINE
        emit('session:death', { sessionId: 'gone-a', threadId: OTHER, wasOwner: true, tmuxName: 'gone-a' })
        await new Promise(r => setTimeout(r, 10))
        expect(getSlackWatcher().get('C9', '9.000001')?.specialist).toBe(OTHER)      // exists: kept
        emit('session:death', { sessionId: 'gone-b', threadId: MINE, wasOwner: true, tmuxName: 'gone-b' })
        await new Promise(r => setTimeout(r, 10))
        expect(getSlackWatcher().get('C9', '8.000001')).toBeUndefined()
        expect(logged.join('')).toContain(`unbound slack:C9:8.000001: its session thread ${MINE} was deleted`)   // said, though nothing was owed
        ;(gateway as any).threadExists = async () => { throw new Error('platform unreachable') }
        emit('session:death', { sessionId: 'gone-c', threadId: OTHER, wasOwner: true, tmuxName: 'gone-c' })
        await new Promise(r => setTimeout(r, 10))
        expect(getSlackWatcher().get('C9', '9.000001')?.specialist).toBe(OTHER)      // unconfirmed: kept
      } finally { (gateway as any).threadExists = real; process.stderr.write = realWrite }
    })

    test('a thread deleted while the daemon was down is found at start, not an hour later', async () => {
      const real = gateway.threadExists
      try {
        getSlackWatcher().bind('C9', '11.000001', MINE, 'tool')
        ;(gateway as any).threadExists = async () => false
        stopSlackWatch(); startSlackWatch()
        await new Promise(r => setTimeout(r, 10))
        expect(getSlackWatcher().get('C9', '11.000001')).toBeUndefined()
      } finally { (gateway as any).threadExists = real }
    })

    test('unbind ends it while no session is in the thread', async () => {
      session('sw-binder', MINE)
      await bindConversation({ threadId: MINE }, 'slack:C9:10.000001')
      expect(unbindConversation({ threadId: MINE }, 'slack:C9:10.000001')).toContain('is unbound')
      expect(getSlackWatcher().get('C9', '10.000001')).toBeUndefined()
    })
  })

  test('connecting or disconnecting Slack re-pushes every session its tools', () => {
    session('sw-pushed', MINE)
    const pushed: { id: string; tools: string[] }[] = []
    const real = transport.sendOrQueue
    ;(transport as any).sendOrQueue = (id: string, m: any) => { if (m.type === 'tools_update') pushed.push({ id, tools: m.tools.map((t: any) => t.name) }) }
    try {
      refreshSlackSpecialistSurface()                                    // remembers: connected
      configure(TOML.replace(/\[slack\.apps\.default\][^[]*/, ''))
      refreshSlackSpecialistSurface()
      expect(pushed.find(p => p.id === 'sw-pushed')?.tools).not.toContain('bind_conversation')
      pushed.length = 0
      configure()
      refreshSlackSpecialistSurface()
      expect(pushed.find(p => p.id === 'sw-pushed')?.tools).toContain('bind_conversation')
    } finally { (transport as any).sendOrQueue = real }
  })

  test('a session with no thread has nothing to bind to; a specialist still binds to the specialist', async () => {
    await expect(bindConversation({}, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')
    expect(await bindConversation(food, 'slack:C1:2.000001')).toStartWith(`slack:C1:2.000001 is bound to ${FOOD}`)
  })

  test('delivery targets the thread, and it is listen-only: no reply is posted, from that session or any other', async () => {
    expect(targetFor(MINE, 'slack:C9:3.000001')).toEqual({ to: MINE })
    session('sw-mine', MINE)
    session('sw-other', OTHER)
    await bindConversation({ threadId: MINE }, 'slack:C9:3.000001')
    fakePost()
    await expect(replyInConversation('sw-mine', 'slack:C9:3.000001', 'on it')).rejects.toThrow('bound to a session to listen to')
    await expect(replyInConversation('sw-other', 'slack:C9:3.000001', 'me too')).rejects.toThrow('bound to a session to listen to')
    expect(posts).toEqual([])
  })
})

describe('bind_conversation / unbind_conversation', () => {
  test('a specialist binds a conversation where it listens, and lets go of it', async () => {
    expect(await bindConversation(food, 'slack:C1:1793732224.093059')).toStartWith(`slack:C1:1793732224.093059 is bound to ${FOOD}`)
    expect(getSlackWatcher().get('C1', '1793732224.093059')).toMatchObject({ specialist: FOOD, mentionedBy: 'tool' })
    expect(formatConversations()[0]).toContain(`slack:C1:1793732224.093059 (slack:C1) → ${FOOD}`)
    expect(unbindConversation(food, 'slack:C1:1793732224.093059')).toBe('slack:C1:1793732224.093059 is unbound')
    expect(unbindConversation(food, 'slack:C1:1793732224.093059')).toContain('was not bound')
  })

  test("another session, a place it doesn't hear, another specialist's conversation, a malformed id, and a full table are all refused", async () => {
    await expect(bindConversation(stranger, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')   // its thread id is no session thread
    await expect(bindConversation(undefined, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')
    await expect(bindConversation(food, 'slack:C2:1.000001')).rejects.toThrow(`${FOOD} doesn't answer slack:C2`)
    await expect(bindConversation(food, 'C1:yesterday')).rejects.toThrow('conversation must look like')
    getSlackWatcher().bind('C1', '9.000001', OPS)
    await expect(bindConversation(food, 'slack:C1:9.000001')).rejects.toThrow(`is bound to ${OPS}; only the operator moves it`)
    for (const ts of ['1.000001', '2.000001']) await bindConversation(food, `slack:C1:${ts}`)
    await expect(bindConversation(food, 'slack:C1:4.000001')).rejects.toThrow('conversation table is full')
    expect(() => unbindConversation({ threadId: OPS_THREAD }, 'slack:C1:1.000001')).toThrow(`is bound to ${FOOD}, not ${OPS}`)
  })

  test("a rule there doesn't count: it takes chosen people's messages, not the place", async () => {
    configure(`${TOML}[[rules]]\nplace = "slack:C2"\nperson = "olive"\ntarget = "specialist:${FOOD}"\n`)
    await expect(bindConversation(food, 'slack:C2:1.000001')).rejects.toThrow(`${FOOD} doesn't answer slack:C2`)
  })

  test("a DM or a place's top level is never bound by hand: the operator's DM stays main's", async () => {
    configure(alsoHeard(TOML, FOOD, 'slack:dm'))
    getSlackWatcher().bind('D0OP', '0.000000', 'main')
    await expect(bindConversation(food, 'slack:D0OP')).rejects.toThrow('only a thread can be bound by hand')
    await expect(bindConversation(food, 'slack:C1')).rejects.toThrow('only a thread can be bound by hand')
    expect(getSlackWatcher().get('D0OP', '0.000000')!.specialist).toBe('main')
  })

  test('a specialist holds at most TOOL_BIND_MAX conversations it bound itself', async () => {
    configure(TOML, { maxWatches: 50 })
    for (let i = 1; i <= 10; i++) await bindConversation(food, `slack:C1:${i}.000001`)
    await expect(bindConversation(food, 'slack:C1:11.000001')).rejects.toThrow(`${FOOD} already holds 10 conversations it opened itself`)
    expect(await bindConversation(food, 'slack:C1:3.000001')).toContain('is bound to') // one it holds already is fine
  })

  test('a rename through `renamed_from` keeps a specialist\'s hold on its conversations', async () => {
    getSlackWatcher().bind('C1', '7.000001', 'old-food')
    configure(TOML.replace(`[specialists.${FOOD}]`, `[specialists.${FOOD}]\nrenamed_from = ["old-food"]`))
    expect(await bindConversation(food, 'slack:C1:7.000001')).toContain(`is bound to ${FOOD}`)
    sessionIds.push('sw-rn')
    registry.set('sw-rn', { sessionId: 'sw-rn', tmuxName: 'sw-rn', threadId: FOOD_THREAD, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    getSlackWatcher().bind('C1', '8.000001', 'old-food')
    expect(((await executeTool('list_watches', {}, 'sw-rn')).content[0] as { text: string }).text).toContain('slack:C1:8.000001')
    expect(unbindConversation(food, 'slack:C1:8.000001')).toContain('is unbound')
  })

  test('conversation ids: a thread, or a DM', () => {
    expect(parseConversation('slack:C1:1.000001')).toEqual({ channel: 'C1', threadTs: '1.000001' })
    expect(parseConversation('slack:D0ABC')).toEqual({ channel: 'D0ABC', threadTs: '0.000000' })
    expect(parseConversation('slack:C1')).toEqual({ channel: 'C1', threadTs: '0.000000' }) // a messages = "all" place's top level
  })

  test("list_watches: a specialist's session sees the conversations bound to it, never another's", async () => {
    for (const [id, threadId] of [['sw-food', FOOD_THREAD], ['sw-ops', OPS_THREAD], ['sw-none', 'some-other-thread']] as const) {
      sessionIds.push(id)
      registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    }
    getSlackWatcher().watch('C1', '11.000001', FOOD)
    getSlackWatcher().watch('C2', '22.000001', OPS)
    const seen = async (id: string) => ((await executeTool('list_watches', {}, id)).content[0] as { text: string }).text
    expect(await seen('sw-food')).toContain('slack:C1:11.000001')
    expect(await seen('sw-food')).not.toContain('C2:')
    expect(await seen('sw-ops')).toContain('slack:C2:22.000001')
    expect(await seen('sw-ops')).not.toContain('C1:')
    expect(await seen('sw-none')).not.toContain('slack')
  })

  test('the bridge tools reach the same code', async () => {
    sessionIds.push('sw-tool')
    registry.set('sw-tool', { sessionId: 'sw-tool', tmuxName: 'sw-tool', threadId: FOOD_THREAD, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    const out = await executeTool('bind_conversation', { conversation: 'slack:C1:5.000001' }, 'sw-tool')
    expect((out.content[0] as { text: string }).text).toContain(`is bound to ${FOOD}`)
  })
})

describe('replies: posted only into the conversation they answer', () => {
  test("a specialist's reply goes into its own conversation's thread, as written", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '5.000001', FOOD)
    expect(await replyInConversation('r-food', 'slack:C1:5.000001', 'Void it from *Invoices* → ⋯')).toBe('posted 1 message to slack:C1:5.000001')
    expect(posts).toEqual(['C1|5.000001|Void it from *Invoices* → ⋯'])
  })

  test('a top-level conversation (a DM) is answered at its top level; main answers the operator\'s DM', async () => {
    fakePost()
    getSlackWatcher().bind('D0OP', '0.000000', 'main')
    expect(await replyInConversation('main', 'slack:D0OP', 'hi')).toContain('posted 1')
    expect(posts).toEqual(['D0OP|-|hi'])
  })

  test("never into another specialist's conversation, one not open, or for a session in no specialist", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    session('r-none', 'some-other-thread')
    getSlackWatcher().bind('C2', '6.000001', OPS)
    await expect(replyInConversation('r-food', 'slack:C2:6.000001', 'x')).rejects.toThrow(`is bound to ${OPS}, not ${FOOD}: a reply goes only to a conversation bound to your specialist`)
    await expect(replyInConversation('r-food', 'slack:C1:7.000001', 'x')).rejects.toThrow('is not an open conversation')
    await expect(replyInConversation('r-none', 'slack:C2:6.000001', 'x')).rejects.toThrow(`is bound to ${OPS}: a reply goes only`)
    await expect(replyInConversation(undefined, 'slack:C2:6.000001', 'x')).rejects.toThrow('a reply goes only')
    expect(posts).toEqual([])
  })

  test("a specialist posts to its own home (a schedule's reply has no conversation): a new thread there, bound to it", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    session('r-ops', OPS_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome = "slack:#food-home"`), { names: { C7: 'food-home' } })
    expect(await replyInConversation('r-food', 'slack:#food-home', 'nightly summary')).toBe(`posted to ${FOOD}'s home (slack:#food-home); replies in its thread come back to ${FOOD}`)
    expect(posts).toEqual(['C7|-|nightly summary'])
    expect(getSlackWatcher().get('C7', '1.000001')).toMatchObject({ specialist: FOOD })
    expect(await replyInConversation('r-food', 'slack:C7', 'by id too')).toContain('home')
    await expect(replyInConversation('r-ops', 'slack:#food-home', 'not mine')).rejects.toThrow('conversation must look like')
    await expect(replyInConversation('r-ops', 'slack:C7', 'not mine')).rejects.toThrow('is not an open conversation')
  })

  test("a home answer in several parts keeps the rest in the first part's thread", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome = "slack:C7"`))
    await replyInConversation('r-food', 'slack:C7', 'para one\n\n'.repeat(800))
    expect(posts.map(p => p.split('|').slice(0, 2).join('|'))).toEqual(['C7|-', 'C7|1.000001', 'C7|1.000001'])
  })

  test("a part with no answer from Slack is reported as unknown (it may have posted), not as failed", async () => {
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '11.000001', FOOD)
    slackRuntimeDeps.post = async () => { throw new Error('A request error occurred: timeout of 30000ms exceeded') }
    await expect(replyInConversation('r-food', 'slack:C1:11.000001', 'hi')).rejects.toThrow("0 of 1 message(s) posted to slack:C1:11.000001; part 1's outcome is unknown (no answer from Slack: it may have posted)")
  })

  test('only a clean refusal counts as "did not post"; fatal_error, a 5xx or a dropped socket may have half succeeded: unknown', async () => {
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '13.000001', FOOD)
    const fate = async (msg: string) => {
      slackRuntimeDeps.post = async () => { throw new Error(msg) }
      return replyInConversation('r-food', 'slack:C1:13.000001', 'hi').then(() => 'posted', (e: Error) => e.message.includes('outcome is unknown') ? 'unknown' : e.message.includes('did not post') ? 'did not post' : e.message)
    }
    expect(await fate('An API error occurred: channel_not_found')).toBe('did not post')
    expect(await fate('An API error occurred: ratelimited')).toBe('did not post')
    expect(await fate('Slack is not connected; try again once it is')).toBe('did not post')
    expect(await fate('An API error occurred: fatal_error')).toBe('unknown')
    expect(await fate('An HTTP protocol error occurred: statusCode = 503')).toBe('unknown')
    expect(await fate('A request error occurred: socket hang up')).toBe('unknown')
  })

  test("a home reply's thread is bound as soon as its first part lands, even if a later part fails", async () => {
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome = "slack:C7"`))
    let n = 0
    slackRuntimeDeps.post = async () => { if (++n === 2) throw new Error('An API error occurred: ratelimited'); return '300.000001' }
    await expect(replyInConversation('r-food', 'slack:C7', 'para one\n\n'.repeat(800))).rejects.toThrow('reply failed after 1 of 3')
    expect(getSlackWatcher().get('C7', '300.000001')).toMatchObject({ specialist: FOOD, mentionedBy: 'home' })
  })

  test('a conversation moved away mid-reply gets no more of it', async () => {
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '12.000001', FOOD)
    posts.length = 0
    slackRuntimeDeps.post = async (c, t, text) => { posts.push(text.slice(0, 8)); getSlackWatcher().bind('C1', '12.000001', OPS); return '1.000001' }
    await expect(replyInConversation('r-food', 'slack:C1:12.000001', 'para one\n\n'.repeat(800))).rejects.toThrow('stopped after 1 of 3 message(s) to slack:C1:12.000001: it is no longer yours to answer')
    expect(posts).toHaveLength(1)
  })

  test('home threads count against what a specialist may open itself; past that the post goes, unbound, and the operator hears why', async () => {
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome = "slack:C7"`), { maxWatches: 50 })
    let n = 0
    slackRuntimeDeps.post = async () => `${100 + ++n}.000001`
    const posted: string[] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (_c: string, text: string) => { posted.push(text); return 'id' }
    try {
      for (let i = 0; i < 10; i++) expect(await replyInConversation('r-food', 'slack:C7', `report ${i}`)).toContain('replies in its thread come back')
      expect(await replyInConversation('r-food', 'slack:C7', 'one too many')).toContain(`its thread is not bound to ${FOOD}: ${FOOD} already holds 10 conversations it opened itself`)
      await Bun.sleep(5)
      expect(posted.some(p => p.includes("post to its home opened no conversation"))).toBe(true)
      await expect(bindConversation(food, 'slack:C1:99.000001')).rejects.toThrow('already holds 10 conversations it opened itself')
    } finally { (gateway as any).send = realSend }
  })

  test('a rename through `renamed_from` keeps the right to answer', async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '8.000001', 'old-food')
    configure(TOML.replace(`[specialists.${FOOD}]`, `[specialists.${FOOD}]\nrenamed_from = ["old-food"]`))
    expect(await replyInConversation('r-food', 'slack:C1:8.000001', 'still mine')).toContain('posted 1')
  })

  test('long text is split under Slack\'s limit; a failure says how far it got; attachments and empty text are refused', async () => {
    session('r-food', FOOD_THREAD)
    getSlackWatcher().bind('C1', '9.000001', FOOD)
    fakePost()
    expect(await replyInConversation('r-food', 'slack:C1:9.000001', 'para one\n\n'.repeat(800))).toBe('posted 3 messages to slack:C1:9.000001')
    expect(posts.every(p => p.length < 4000)).toBe(true)
    fakePost(2)
    await expect(replyInConversation('r-food', 'slack:C1:9.000001', 'para one\n\n'.repeat(800))).rejects.toThrow('reply failed after 1 of 3 message(s) posted to slack:C1:9.000001: ratelimited. Part 2 did not post; send from there.')
    await expect(replyInConversation('r-food', 'slack:C1:9.000001', 'see file', ['/tmp/x.pdf'])).rejects.toThrow('attachments are not posted to Slack yet')
    await expect(replyInConversation('r-food', 'slack:C1:9.000001', '  ')).rejects.toThrow('the text is empty')
  })

  test('the reply tool routes a slack: chat_id here, without Discord\'s allowlist', async () => {
    fakePost()
    session('r-tool', FOOD_THREAD)
    getSlackWatcher().bind('C1', '10.000001', FOOD)
    const out = await executeTool('reply', { chat_id: 'slack:C1:10.000001', text: 'done' }, 'r-tool')
    expect((out.content[0] as { text: string }).text).toBe('posted 1 message to slack:C1:10.000001')
    expect(posts).toEqual(['C1|10.000001|done'])
  })
})

describe('sessions = "per-conversation"', () => {
  test('first come, first served: a newer conversation waits behind older waiters, and a freed place wakes them', async () => {
    configure(TOML.replace(`reachable_by = ["anyone"]\n`, `reachable_by = ["anyone"]\nsessions = "per-conversation"\nmax_sessions = 1\n`))
    const w = getSlackWatcher()
    w.bind('C1', '1.000001', FOOD)
    const old = w.get('C1', '1.000001')!
    old.owed = ['1.000001']; old.waitingSince = Date.now() - 60_000
    w.handle({ channel: 'C1', ts: `${Math.floor(Date.now() / 1000)}.000002`, user: 'UA', text: '<@UBOT> newer' })
    await w.flush()
    const newer = w.list().find(e => e.threadTs !== '1.000001')!
    expect(newer.waitingSince).toBeDefined() // behind the older waiter, never spawned
    expect(w.owedHints()[0]).toMatchObject({ threadTs: '1.000001' }) // the oldest is refetched first
    let woke = 0
    const realWake = slackRuntimeDeps.wake
    slackRuntimeDeps.wake = () => { woke++ }
    startSlackWatch()
    try {
      emit('session:death', { sessionId: 'x', threadId: 't', wasOwner: true, tmuxName: `${FOOD}_c1-9-000001` })
      emit('session:death', { sessionId: 'y', threadId: 't', wasOwner: true, tmuxName: 'someone-else' })
      expect(woke).toBe(1)
      emit('session:marked-dead', { sessionId: 'z', tmuxName: `${FOOD}_c1-8-000001` }) // a crash the health poll found
      expect(woke).toBe(2)
    } finally { stopSlackWatch(); slackRuntimeDeps.wake = realWake }
  })

  test("first come, first served only when places are short: with a place to spare, a newer conversation doesn't wait", async () => {
    configure(TOML.replace(`reachable_by = ["anyone"]\n`, `reachable_by = ["anyone"]\nsessions = "per-conversation"\nmax_sessions = 3\n`))
    const w = getSlackWatcher()
    w.bind('C1', '1.000001', FOOD)
    const old = w.get('C1', '1.000001')!
    old.owed = ['1.000001']; old.waitingSince = Date.now() - 60_000 // waiting for its refetch, though places are free
    w.handle({ channel: 'C1', ts: `${Math.floor(Date.now() / 1000)}.000003`, user: 'UA', text: '<@UBOT> newer' })
    await w.flush()
    const newer = w.list().find(e => e.threadTs !== '1.000001')!
    expect(newer.waitingSince).toBeUndefined() // 3 places, 1 waiter ahead: it went on to its own session
  })

  test('a conversation session acts for its specialist: the tools, its home, but replies only into its own conversation', async () => {
    configure(TOML.replace(`reachable_by = ["anyone"]\n`, `reachable_by = ["anyone"]\nsessions = "per-conversation"\nhome = "slack:C7"\n`))
    fakePost()
    const conv = { threadId: 'conv-thread', tmuxName: `${FOOD}_c1-4-000001` }
    expect(isSpecialistOccupant(conv)).toBe(true)
    sessionIds.push('pc-own')
    registry.set('pc-own', { sessionId: 'pc-own', ...conv, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    getSlackWatcher().bind('C1', '4.000001', FOOD)
    getSlackWatcher().bind('C1', '5.000001', FOOD)
    expect(await replyInConversation('pc-own', 'slack:C7', 'scheduled report')).toContain(`posted to ${FOOD}'s home`)
    expect(await replyInConversation('pc-own', 'slack:C1:4.000001', 'mine')).toContain('posted 1')
    await expect(replyInConversation('pc-own', 'slack:C1:5.000001', 'a sibling\'s')).rejects.toThrow("and from a conversation's own session only to that conversation")
  })

  const PER = TOML.replace(`reachable_by = ["anyone"]\n`, `reachable_by = ["anyone"]\nsessions = "per-conversation"\nmax_sessions = 2\n`)
  const live = (name: string) => {
    const id = `pc-${name}`
    sessionIds.push(id)
    registry.set(id, { sessionId: id, tmuxName: name, threadId: `t-${name}`, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() - 600_000,
      adapter: fakeAdapter({ isAlive: () => true, usage: () => null }) } as any)
  }

  test('a shared specialist is one target; a per-conversation one names the conversation (targets.ts counts max)', () => {
    expect(targetFor(OPS, 'slack:C2:1.000001')).toEqual({ to: OPS })
    configure(PER)
    expect(targetFor(FOOD, 'slack:C1:1.000001')).toEqual({ perConversation: FOOD, conversation: 'slack:C1:1.000001' })
    expect(targetFor(FOOD, undefined)).toEqual({ to: FOOD }) // nothing to give its own session to
  })

  test("a conversation's own session answers its conversation, and no other; a renamed one still does", async () => {
    configure(PER.replace(`[specialists.${FOOD}]`, `[specialists.${FOOD}]\nrenamed_from = ["old-food"]`))
    fakePost()
    getSlackWatcher().bind('C1', '4.000001', FOOD)
    getSlackWatcher().bind('C1', '5.000001', FOOD)
    live(`${FOOD}_c1-4-000001`)
    live('old-food_c1-5-000001')
    expect(await replyInConversation(`pc-${FOOD}_c1-4-000001`, 'slack:C1:4.000001', 'yours')).toContain('posted 1')
    await expect(replyInConversation(`pc-${FOOD}_c1-4-000001`, 'slack:C1:5.000001', 'not yours')).rejects.toThrow('a reply goes only')
    expect(await replyInConversation('pc-old-food_c1-5-000001', 'slack:C1:5.000001', 'still mine')).toContain('posted 1')
    expect(posts).toEqual(['C1|4.000001|yours', 'C1|5.000001|still mine'])
  })
})

describe('the operator: hydra conversations and hydra route', () => {
  test('conversations bind, list, unbind; bind moves one from any specialist to any other', async () => {
    getSlackWatcher().watch('C1', '9.000001', FOOD)
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1:9.000001', to: OPS }))).toMatchObject({ ok: true, data: { bound: `slack:C1:9.000001 → ${OPS}` } })
    expect(getSlackWatcher().get('C1', '9.000001')!.specialist).toBe(OPS)
    const listed = await handleCLIRequest(req('conversations', { action: 'list' }))
    expect((listed.data as any).conversations).toEqual([expect.stringContaining(`slack:C1:9.000001 (slack:C1) → ${OPS} · idle 0h`)])
    expect((listed.data as any).health).toMatchObject({ places: [{ place: 'slack:C1', to: FOOD }, { place: 'slack:C2', to: OPS }], conversations: 1, owed: 0, oldestOwedAgeMin: null })
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1:9.000001', to: 'nobody' }))).toMatchObject({ ok: false, error: 'no specialist "nobody" in hydra.toml (or a session\'s thread id)' })
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1', to: OPS }))).toMatchObject({ ok: false, error: expect.stringContaining('names a channel, not a conversation') })
    expect(await handleCLIRequest(req('conversations', { action: 'unbind', conversation: 'slack:C1:9.000001' }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('conversations', { action: 'unbind', conversation: 'slack:C1:9.000001' }))).toMatchObject({ ok: true, data: { unbound: expect.stringContaining('was not bound') } })
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slack).toMatchObject({ conversations: 0 })
  })

  test('hydra route prints every candidate and why the winner won, and binds nothing', async () => {
    configure(TOML.replace(`[specialists.${FOOD}]`, `[[rules]]\nplace = "slack:C2"\nperson = "owner"\ntarget = "specialist:${FOOD}"\n[specialists.${FOOD}]`))
    const r = await handleCLIRequest(req('route', { person: 'olive', place: 'slack:C2' }))
    expect(r).toMatchObject({ ok: true, data: { fate: 'deliver', to: FOOD } })
    expect((r.data as any).report).toContain(`→ rule specialist:${FOOD}: rules[0]: first rule that matches`)
    expect((r.data as any).report).toContain(`rule specialist:${OPS}: rules[2] matches, but an earlier rule won`)
    expect(await handleCLIRequest(req('route', { person: 'stranger', place: 'slack:C2' }))).toMatchObject({ ok: true, data: { fate: 'refused', to: OPS } })
    expect(await handleCLIRequest(req('route', { person: 'slack:UNEW', place: 'slack:C9' }))).toMatchObject({ ok: true, data: { fate: 'unrouted' } })
    expect(await handleCLIRequest(req('route', { person: 'nobody', place: 'slack:C2' }))).toMatchObject({ ok: false })
    expect(getSlackWatcher().list()).toEqual([])
  })

  test('refusals by sender, unrouted mentions, and drops by kind are counted', async () => {
    configure(TOML, { maxWatches: 1 })
    const before = slackWatchHealth()!
    const w = getSlackWatcher()
    expect(w.handle({ channel: 'C2', ts: '50.000001', user: 'USTRANGER', text: '<@UBOT> hi' })).toBe('refused')
    expect(w.handle({ channel: 'C9', ts: '50.000002', user: 'USTRANGER', text: '<@UBOT> hi' })).toBe('unrouted')
    w.handle({ channel: 'C1', ts: '51.000001', user: 'UOWNER', text: '<@UBOT> one' })
    w.handle({ channel: 'C1', ts: '52.000001', user: 'UOWNER', text: '<@UBOT> two' }) // the table holds one
    const after = slackWatchHealth()!
    expect(after.refused - before.refused).toBe(1)
    expect(after.refusedBy.USTRANGER - (before.refusedBy.USTRANGER ?? 0)).toBe(1)
    expect(after.unrouted - before.unrouted).toBe(1)
    expect(after.dropped['table-full']! - (before.dropped['table-full'] ?? 0)).toBe(1)
    w.close()
  })

  test('health lists owed messages older than two catch-up passes, with the threshold it used (#669)', async () => {
    configure(TOML)
    const w = getSlackWatcher()
    w.handle({ channel: 'C1', ts: '51.000001', user: 'UOWNER', text: '<@UBOT> one' })   // accepted, never delivered: it is owed, and from 1970
    const h = ((await handleCLIRequest(req('health', {}))).data as any).slack
    expect(h.owedLateAfterMin).toBe(20)
    expect(h.owedLate).toHaveLength(1)
    expect(h.owedLate[0]).toMatchObject({ count: 1, cause: expect.any(String) })
    w.close()
  })

  test('health flags a #name place no channel answers to, and omits the line without an app named default', async () => {
    configure(TOML.replace('place = "slack:C2"', 'place = "slack:#ops-room"'))
    expect(slackWatchHealth()!.places.find(p => p.to === OPS)!.note).toContain('no channel answers to this name')
    configure('')
    expect(slackWatchHealth()).toBeNull()
    expect(((await handleCLIRequest(req('health', {}))).data as any).slack).toBeUndefined()
    void current
  })
})

describe('main and alerts', () => {
  test("the operator's DM reaches main only while main is connected; otherwise it stays owed", async () => {
    const w = getSlackWatcher()
    w.handle({ channel: 'D0OP', ts: '71.000001', user: 'UOP', text: 'hi' })
    await w.flush()
    expect(w.get('D0OP', '0.000000')?.owed).toEqual(['71.000001'])
  })

  test("a drop is alerted in its specialist's thread", async () => {
    noteMainChannel('C0MAINCH')
    const posted: { channel: string; text: string }[] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (channel: string, text: string) => { posted.push({ channel, text }); return 'id' }
    try {
      configure(TOML, { maxWatches: 1 })
      const w = getSlackWatcher()
      // ops, not food: the watcher is the daemon's one, and an earlier test began food's table-full episode
      w.handle({ channel: 'C2', ts: '80.000001', user: 'UOWNER', text: '<@UBOT> one' })
      w.handle({ channel: 'C2', ts: '81.000001', user: 'UOWNER', text: '<@UBOT> two' }) // table-full
      await Bun.sleep(10)
      expect(posted.some(p => p.channel === OPS_THREAD && p.text.includes('table-full'))).toBe(true)
      w.close()
    } finally { (gateway as any).send = realSend }
  })
})

const appOf = (toml: string) => defaultSlackApp(hydra(toml))!

describe('tokens', () => {
  test('a token is read only from a variable every session is kept from; any other name is refused, with which key and why', () => {
    const env = { SLOPBOT_SLACK_BOT_TOKEN: 'xoxb-1', SLOPBOT_SLACK_APP_TOKEN: 'xapp-1' }
    expect(slackTokens(appOf(TOML), env)).toEqual({ bot: 'xoxb-1', app: 'xapp-1' })
    const warned: string[] = []
    const leaky = appOf(TOML.replace('bot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"', 'bot_token_env = "SLACK_BOT_TOKEN"'))
    expect(slackTokens(leaky, { ...env, SLACK_BOT_TOKEN: 'xoxb-leak' }, l => warned.push(l))).toEqual({ bot: undefined, app: 'xapp-1' })
    expect(warned[0]).toContain('refusing to read the token in SLACK_BOT_TOKEN, the `bot_token_env` of the app named `default`')
    expect(warned[0]).not.toContain('xoxb')
  })
})

describe('tokens: any variable the config names', () => {
  test('a SLOPBOT_ name and a custom one are read once registered, and not before', () => {
    const toml = TOML.replace('"SLOPBOT_SLACK_BOT_TOKEN"', '"SLOPBOT_SLACK_SALES_BOT"').replace('"SLOPBOT_SLACK_APP_TOKEN"', '"ACME_SOCKET_TOKEN"')
    const env = { SLOPBOT_SLACK_SALES_BOT: 'xoxb-s', ACME_SOCKET_TOKEN: 'xapp-s' }
    const warned: string[] = []
    expect(slackTokens(appOf(toml), env, l => warned.push(l))).toEqual({ bot: undefined, app: undefined })
    expect(warned).toHaveLength(2)
    registerSpawnVars(slackEnvNames(hydra(toml)), {})
    expect(slackTokens(appOf(toml), env)).toEqual({ bot: 'xoxb-s', app: 'xapp-s' })
  })
  test('a name sessions need, like PATH, is refused, saying which key and why (the loader rejects it first; this is the backstop)', () => {
    const warned: string[] = []
    const app = { ...appOf(TOML), botTokenEnv: 'PATH' }
    expect(registerSpawnVars(['PATH'], {}).refused).toEqual([{ name: 'PATH', reason: 'is a variable sessions need' }])
    expect(slackTokens(app, { PATH: '/bin' }, l => warned.push(l)).bot).toBeUndefined()
    expect(warned[0]).toContain('refusing to read the token in PATH, the `bot_token_env` of the app named `default`: it is a variable sessions need')
  })
})

describe('tokens: the operator\'s user token', () => {
  test('read from HYDRA_SLACK_USER_TOKEN, a variable every session is kept from', () => {
    const toml = TOML.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"')
    const env = { SLOPBOT_SLACK_BOT_TOKEN: 'xoxb-1', SLOPBOT_SLACK_APP_TOKEN: 'xapp-1', HYDRA_SLACK_USER_TOKEN: 'xoxp-1' }
    expect(slackTokens(appOf(toml), env)).toEqual({ bot: 'xoxb-1', app: 'xapp-1', user: 'xoxp-1' })
    const warned: string[] = []
    expect(slackTokens(appOf(toml.replace('"HYDRA_SLACK_USER_TOKEN"', '"MY_USER_TOKEN"')), { ...env, MY_USER_TOKEN: 'xoxp-leak' }, l => warned.push(l)).user).toBeUndefined()
    expect(warned[0]).toContain('refusing to read the token in MY_USER_TOKEN, the `operator_token_env`')
  })
})

describe('bind_conversation asks Slack who can read the thread before it says "listening"', () => {
  const MINE = '1552619225032425525'
  const realRead = slackRuntimeDeps.readThread
  afterEach(() => { slackRuntimeDeps.readThread = realRead })
  const withUser = () => configure(TOML.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"'))

  test('the bot reads it: live', async () => {
    slackRuntimeDeps.readThread = async () => 'bot'
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).toContain('live: the bot is in slack:C9')
    expect(getSlackWatcher().get('C9', '1.000001')!.via).toBeUndefined()
  })

  test('only the operator reads it: bound, marked, and listed so', async () => {
    withUser()
    slackRuntimeDeps.readThread = async () => 'user'
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).toContain("live, read as the operator: the bot isn't in slack:C9")
    expect(getSlackWatcher().get('C9', '1.000001')!.via).toBe('user')
    expect(formatConversationsFor({ threadId: MINE }).join()).toContain('· read as the operator')
  })

  test('nobody can read it: refused, with what to do, and nothing is bound', async () => {
    slackRuntimeDeps.readThread = async () => { throw new Error('An API error occurred: not_in_channel') }
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow("not bound: slack:C9:1.000001: the bot (<@UBOT>) isn't in slack:C9 (An API error occurred: not_in_channel). Ask the operator to invite it")
    withUser()
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow('nor the operator is in slack:C9')
    slackRuntimeDeps.readThread = async () => { throw new Error('An API error occurred: thread_not_found') }
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow("not bound: slack:C9:1.000001: it can't be read (An API error occurred: thread_not_found)")
    expect(getSlackWatcher().get('C9', '1.000001')).toBeUndefined()
  })

  test("a specialist never binds a thread only the operator can read: it could not answer there", async () => {
    withUser()
    slackRuntimeDeps.readThread = async () => 'user'
    await expect(bindConversation(food, 'slack:C1:1.000001')).rejects.toThrow(`not bound: slack:C1:1.000001: the bot isn't in slack:C1, so ${FOOD} could not answer there`)
    expect(getSlackWatcher().get('C1', '1.000001')).toBeUndefined()
  })

  test('Slack not connected: bound, and said to be unchecked', async () => {
    slackRuntimeDeps.readThread = async () => null
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).toContain("not checked: Slack isn't connected; if the thread can't be read")
  })
})
