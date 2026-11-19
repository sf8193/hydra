import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../daemon/config.js'
import { noteMainChannel } from '../../../daemon/main-session.js'
import { registry } from '../../../daemon/sessions.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import {
  getConversationTable, bindConversation, unbindConversation, formatConversations, formatConversationsFor, operatorBind, slackConversationHealth, slackTokens, slackRuntimeDeps, placeFileFor, parseConversation, replyInConversation, targetFor, startConversationTable, stopConversationTable,
} from '../runtime.js'
import { sessionCapabilities, isSpecialistOccupant, isToolAllowed, advertiseTools } from '../../../daemon/tool-surface.js'
import { emit } from '../../../daemon/event-bus.js'
import { transport } from '../../../daemon/bridge-transport.js'
import { handleCLIRequest, type CLIRequest } from '../../../daemon/cli-handler.js'
import { executeTool } from '../../../daemon/bridge-dispatch.js'
import { alsoHeard, BASE, hydra, view } from './slack-config.js'
import { tokenEnvNames } from '../../../config/token-vars.js'
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
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C1"
target = "specialist:${FOOD}"
[specialists.${OPS}]
workdir = "/w/ops"
reachable_by = ["role:owner"]
[[rules]]
place = "slack:C2"
target = "specialist:${OPS}"
`
let current = TOML
function configure(toml = TOML, over: Parameters<typeof view>[1] = {}) {
  current = toml
  _setHydraConfigForTesting(hydra(toml))
  const v = view(toml, { maxConversations: 3, ...over })
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
  for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs)
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
    expect(getConversationTable().get('C9', '1793732224.093059')).toMatchObject({ specialist: MINE, mentionedBy: 'tool' })
    expect(formatConversationsFor({ threadId: MINE }).join()).toContain('slack:C9:1793732224.093059')
    expect(formatConversationsFor({ threadId: OTHER })).toEqual([])
    expect(() => unbindConversation({ threadId: OTHER }, 'slack:C9:1793732224.093059')).toThrow(`is bound to ${MINE}, not ${OTHER}`)
    await expect(bindConversation({ threadId: OTHER }, 'slack:C9:1793732224.093059')).rejects.toThrow(`is bound to ${MINE}; only the operator moves it`)
    expect(unbindConversation({ threadId: MINE }, 'slack:C9:1793732224.093059')).toBe('slack:C9:1793732224.093059 is unbound')
  })

  test('a session hosted in a Slack thread binds a thread to itself as a thread, not a specialist', async () => {
    const SLACK = 'D0BE3RB4Y00:1792616731.235729'
    session('sw-slack', SLACK)
    expect(isToolAllowed('sw-slack', 'bind_conversation')).toBe(true)
    expect(await bindConversation({ threadId: SLACK }, 'slack:C9:1793732224.093060')).toContain('is bound to this session')
    expect(getConversationTable().get('C9', '1793732224.093060')).toMatchObject({ specialist: SLACK, mentionedBy: 'tool' })
    expect(unbindConversation({ threadId: SLACK }, 'slack:C9:1793732224.093060')).toBe('slack:C9:1793732224.093060 is unbound')
  })

  test("a session never binds another hydra session's own thread, however the conversation is spelled", async () => {
    const SLACK = 'D0BE3RB4Y00:1792616731.235729'
    session('sw-slack', SLACK)
    session('sw-host', 'C9:1793732224.093060')
    registry.setThread('C9:1793732224.093060', 'sw-host')
    try {
      for (const c of ['slack:C9:1793732224.093060', 'slack:C9:1793732224.09306', 'slack:default:C9:1793732224.093060'])
        await expect(bindConversation({ threadId: SLACK }, c)).rejects.toThrow("is a hydra session's own thread")
      await expect(operatorBind('slack:C9:1793732224.093060', `thread:${SLACK}`)).rejects.toThrow("is a hydra session's own thread")
      expect(await operatorBind('slack:C9:1793732224.093060', 'main')).toBe('slack:C9:1793732224.093060 → main')
    } finally { registry.deleteThread('C9:1793732224.093060') }
  })

  test("a thread a hydra session now lives in is let go by a session listening to it, at its next message; a specialist's binding is kept", async () => {
    const told: [string, string][] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (c: string, text: string) => { told.push([c, text]); return 'id' }
    stopConversationTable(); startConversationTable()
    try {
      session('sw-listener', MINE)
      await bindConversation({ threadId: MINE }, 'slack:C9:1793732224.093062')
      await bindConversation(food, 'slack:C1:5.000003')
      for (const t of ['C9:1793732224.093062', 'C1:5.000003']) registry.setThread(t, 'sw-host')
      getConversationTable().handle({ channel: 'C9', ts: '1793732224.093063', threadTs: '1793732224.093062', user: 'UANYONE', text: 'for the host' } as any)
      getConversationTable().handle({ channel: 'C1', ts: '5.000004', threadTs: '5.000003', user: 'UANYONE', text: 'for food' } as any)
      await getConversationTable().flush()
      expect(getConversationTable().get('C9', '1793732224.093062')).toBeUndefined()
      expect(getConversationTable().get('C1', '5.000003')?.specialist).toBe(FOOD)
      await Bun.sleep(5)
      expect(told.filter(([c, t]) => c === MINE && t.includes("is now a hydra session's own thread") && t.includes('(1 owed dropped)'))).toHaveLength(1)
    } finally {
      (gateway as any).send = realSend; stopConversationTable()
      for (const t of ['C9:1793732224.093062', 'C1:5.000003']) registry.deleteThread(t)
    }
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
      expect(getConversationTable().get('C1', '5.000001')?.specialist).toBe(FOOD)
      await expect(bindConversation({ threadId: MINE }, 'slack:C1:5.000001')).rejects.toThrow(`is bound to ${FOOD}`)
      await Bun.sleep(5)
      expect(told.some(([c, t]) => c === MINE && t.includes(`${FOOD} took it`))).toBe(true)
    } finally { (gateway as any).send = realSend }
  })

  test('the operator can bind a thread to a session; hydra conversations shows the session by name', async () => {
    session('sw-named', MINE)
    expect(await operatorBind('slack:C9:8.000001', `thread:${MINE}`)).toStartWith(`slack:C9:8.000001 → ${MINE}; `)
    expect(formatConversations().find(l => l.startsWith('slack:C9:8.000001'))).toContain(`→ sw-named (its thread ${MINE})`)
  })

  describe('a session thread keeps its bound conversations while no session is in it', () => {
    const woken: { apps?: string[]; why?: string }[] = []
    const realWake = slackRuntimeDeps.wake
    beforeEach(() => { woken.length = 0; slackRuntimeDeps.wake = (apps, why) => { woken.push({ apps, why }) }; stopConversationTable(); startConversationTable() })
    afterEach(() => { slackRuntimeDeps.wake = realWake; jest.useRealTimers(); stopConversationTable() })
    const told = (): [string, string][] => { const out: [string, string][] = []; (gateway as any).send = async (c: string, text: string) => { out.push([c, text]); return 'id' }; return out }

    test('a session that ends without being killed (a crash), then resumed after what used to be the grace: still bound, nothing said, and the owed messages are delivered at once', async () => {
      const realSend = gateway.send
      try {
        const out = told()
        jest.useFakeTimers()
        session('sw-first', MINE)
        await bindConversation({ threadId: MINE }, 'slack:C9:6.000001')
        getConversationTable().handle({ channel: 'C9', ts: '6.000002', threadTs: '6.000001', user: 'UANYONE', text: 'while you were gone' } as any)
        ;(registry.get('sw-first') as any).deadAt = 1
        emit('session:death', { sessionId: 'sw-first', threadId: MINE, wasOwner: true, tmuxName: 'sw-first' })
        jest.advanceTimersByTime(61_000)                                     // past the 60 s an empty thread used to be given
        jest.advanceTimersByTime(7 * 86_400_000 - 62_000)                    // and the whole idle week but one minute
        expect(getConversationTable().get('C9', '6.000001')?.specialist).toBe(MINE)
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
        getConversationTable().handle({ channel: 'C9', ts: '12.000002', threadTs: '12.000001', user: 'UANYONE', text: 'owed' } as any)
        await getConversationTable().flush()
        expect(getConversationTable().get('C9', '12.000001')?.owed).toHaveLength(1)
        emit('session:death', { sessionId: 'killed', threadId: MINE, wasOwner: true, tmuxName: 'killed', deliberate: true })
        await new Promise(r => setTimeout(r, 20))
        expect(getConversationTable().get('C9', '12.000001')).toBeUndefined()
        expect(getConversationTable().get('C9', '13.000001')).toBeUndefined()
        expect(getConversationTable().get('C9', '14.000001')?.specialist).toBe(OTHER)
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
      getConversationTable().handle({ channel: 'C9', ts: '7.000002', threadTs: '7.000001', user: 'UANYONE', text: 'held' } as any)
      await getConversationTable().flush()                                        // no session is in the thread: the delivery fails and stays owed
      expect(getConversationTable().get('C9', '7.000001')?.owed).toEqual(['7.000002'])
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
        expect(getConversationTable().get('C9', '9.000001')?.specialist).toBe(OTHER)      // exists: kept
        emit('session:death', { sessionId: 'gone-b', threadId: MINE, wasOwner: true, tmuxName: 'gone-b' })
        await new Promise(r => setTimeout(r, 10))
        expect(getConversationTable().get('C9', '8.000001')).toBeUndefined()
        expect(logged.join('')).toContain(`unbound slack:C9:8.000001: its session thread ${MINE} was deleted`)   // said, though nothing was owed
        ;(gateway as any).threadExists = async () => { throw new Error('platform unreachable') }
        emit('session:death', { sessionId: 'gone-c', threadId: OTHER, wasOwner: true, tmuxName: 'gone-c' })
        await new Promise(r => setTimeout(r, 10))
        expect(getConversationTable().get('C9', '9.000001')?.specialist).toBe(OTHER)      // unconfirmed: kept
      } finally { (gateway as any).threadExists = real; process.stderr.write = realWrite }
    })

    test('a thread destroyed with no session in it lets its conversations go at once, and another thread keeps its own', async () => {
      const real = gateway.threadExists
      try {
        await bindConversation({ threadId: MINE }, 'slack:C9:12.000001')
        await bindConversation({ threadId: OTHER }, 'slack:C9:13.000001')
        ;(gateway as any).threadExists = async (t: string) => t !== MINE
        emit('thread:destroyed', { threadId: MINE })
        await new Promise(r => setTimeout(r, 10))
        expect(getConversationTable().get('C9', '12.000001')).toBeUndefined()
        expect(getConversationTable().get('C9', '13.000001')?.specialist).toBe(OTHER)
      } finally { (gateway as any).threadExists = real }
    })

    test('a thread deleted while the daemon was down is found at start, not an hour later', async () => {
      const real = gateway.threadExists
      try {
        getConversationTable().bind('C9', '11.000001', MINE, 'tool')
        ;(gateway as any).threadExists = async () => false
        stopConversationTable(); startConversationTable()
        await new Promise(r => setTimeout(r, 10))
        expect(getConversationTable().get('C9', '11.000001')).toBeUndefined()
      } finally { (gateway as any).threadExists = real }
    })

    test('unbind ends it while no session is in the thread', async () => {
      session('sw-binder', MINE)
      await bindConversation({ threadId: MINE }, 'slack:C9:10.000001')
      expect(unbindConversation({ threadId: MINE }, 'slack:C9:10.000001')).toContain('is unbound')
      expect(getConversationTable().get('C9', '10.000001')).toBeUndefined()
    })
  })

  test('a reload that connects or disconnects Slack re-pushes a session its tools; one that changes nothing pushes nothing', () => {
    session('sw-pushed', MINE)
    advertiseTools('sw-pushed')                                            // its bridge was sent its list, as at registration
    const pushed: { id: string; tools: string[] }[] = []
    const real = transport.sendOrQueue
    ;(transport as any).sendOrQueue = (id: string, m: any) => { if (m.type === 'tools_update') pushed.push({ id, tools: m.tools.map((t: any) => t.name) }) }
    try {
      configure()
      expect(pushed.filter(p => p.id === 'sw-pushed')).toEqual([])
      configure(TOML.replace(/\[slack\.apps\.default\][^[]*/, ''))
      expect(pushed.find(p => p.id === 'sw-pushed')?.tools).not.toContain('bind_conversation')
      pushed.length = 0
      configure()
      expect(pushed.find(p => p.id === 'sw-pushed')?.tools).toContain('bind_conversation')
    } finally { (transport as any).sendOrQueue = real }
  })

  test('a session with no thread has nothing to bind to; a specialist still binds to the specialist', async () => {
    await expect(bindConversation({}, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')
    expect(await bindConversation(food, 'slack:C1:2.000001')).toStartWith(`slack:C1:2.000001 is bound to ${FOOD}`)
  })

  test('delivery targets the thread; the session it is bound to answers there, and no other session does', async () => {
    expect(targetFor(MINE, 'slack:C9:3.000001')).toEqual({ to: MINE })
    session('sw-mine', MINE)
    session('sw-other', OTHER)
    await bindConversation({ threadId: MINE }, 'slack:C9:3.000001')
    fakePost()
    await expect(replyInConversation('sw-other', 'slack:C9:3.000001', 'me too')).rejects.toThrow(`is bound to ${MINE}, not ${OTHER}`)
    expect(await replyInConversation('sw-mine', 'slack:C9:3.000001', 'on it')).toBe('posted 1 message to slack:C9:3.000001')
    expect(posts).toEqual(['C9|3.000001|on it'])
  })
})

describe('bind_conversation / unbind_conversation', () => {
  test('a specialist binds a conversation where it listens, and lets go of it', async () => {
    expect(await bindConversation(food, 'slack:C1:1793732224.093059')).toStartWith(`slack:C1:1793732224.093059 is bound to ${FOOD}`)
    expect(getConversationTable().get('C1', '1793732224.093059')).toMatchObject({ specialist: FOOD, mentionedBy: 'tool' })
    expect(formatConversations()[0]).toContain(`slack:C1:1793732224.093059 (slack:C1) → ${FOOD}`)
    expect(unbindConversation(food, 'slack:C1:1793732224.093059')).toBe('slack:C1:1793732224.093059 is unbound')
    expect(unbindConversation(food, 'slack:C1:1793732224.093059')).toContain('was not bound')
  })

  test("another session, a place it doesn't hear, another specialist's conversation, a malformed id, and a full table are all refused", async () => {
    await expect(bindConversation(stranger, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')   // its thread id is no session thread
    await expect(bindConversation(undefined, 'slack:C1:1.000001')).rejects.toThrow('no thread to bind')
    await expect(bindConversation(food, 'slack:C2:1.000001')).rejects.toThrow(`${FOOD} doesn't answer slack:C2`)
    await expect(bindConversation(food, 'C1:yesterday')).rejects.toThrow('conversation must look like')
    getConversationTable().bind('C1', '9.000001', OPS)
    await expect(bindConversation(food, 'slack:C1:9.000001')).rejects.toThrow(`is bound to ${OPS}; only the operator moves it`)
    for (const ts of ['1.000001', '2.000001']) await bindConversation(food, `slack:C1:${ts}`)
    await expect(bindConversation(food, 'slack:C1:4.000001')).rejects.toThrow('conversation table is full')
    expect(() => unbindConversation({ threadId: OPS_THREAD }, 'slack:C1:1.000001')).toThrow(`is bound to ${FOOD}, not ${OPS}`)
  })

  test("a rule there doesn't count: it takes chosen people's messages, not the place", async () => {
    configure(`${TOML}[[rules]]\nplace = "slack:C2"\nperson = "person:olive"\ntarget = "specialist:${FOOD}"\n`)
    await expect(bindConversation(food, 'slack:C2:1.000001')).rejects.toThrow(`${FOOD} doesn't answer slack:C2`)
  })

  test("a DM or a place's top level is never bound by hand: the operator's DM stays main's", async () => {
    configure(alsoHeard(TOML, FOOD, 'slack:app-dm:*'))
    getConversationTable().bind('D0OP', '0.000000', 'main')
    await expect(bindConversation(food, 'slack:D0OP')).rejects.toThrow('only a thread can be bound by hand')
    await expect(bindConversation(food, 'slack:C1')).rejects.toThrow('only a thread can be bound by hand')
    expect(getConversationTable().get('D0OP', '0.000000')!.specialist).toBe('main')
  })

  test('a specialist holds at most TOOL_BIND_MAX conversations it bound itself', async () => {
    configure(TOML, { maxConversations: 50 })
    for (let i = 1; i <= 10; i++) await bindConversation(food, `slack:C1:${i}.000001`)
    await expect(bindConversation(food, 'slack:C1:11.000001')).rejects.toThrow(`${FOOD} already holds 10 conversations it opened itself`)
    expect(await bindConversation(food, 'slack:C1:3.000001')).toContain('is bound to') // one it holds already is fine
  })

  test('binding threads routing opened to it counts toward TOOL_BIND_MAX: hand-binding cannot pin slots past it', async () => {
    configure(TOML, { maxConversations: 50 })
    for (let i = 1; i <= 11; i++) getConversationTable().watch('C1', `${i}.000001`, FOOD, 'UALICE')   // routing opened them, bound to it
    for (let i = 1; i <= 10; i++) await bindConversation(food, `slack:C1:${i}.000001`)
    await expect(bindConversation(food, 'slack:C1:11.000001')).rejects.toThrow(`${FOOD} already holds 10 conversations it opened itself`)
    expect(await bindConversation(food, 'slack:C1:3.000001')).toContain('is bound to') // one it holds already is fine
  })

  test('a rename through `renamed_from` keeps a specialist\'s hold on its conversations', async () => {
    getConversationTable().bind('C1', '7.000001', 'old-food')
    configure(TOML.replace(`[specialists.${FOOD}]`, `[specialists.${FOOD}]\nrenamed_from = ["old-food"]`))
    expect(await bindConversation(food, 'slack:C1:7.000001')).toContain(`is bound to ${FOOD}`)
    sessionIds.push('sw-rn')
    registry.set('sw-rn', { sessionId: 'sw-rn', tmuxName: 'sw-rn', threadId: FOOD_THREAD, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    getConversationTable().bind('C1', '8.000001', 'old-food')
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
    getConversationTable().watch('C1', '11.000001', FOOD)
    getConversationTable().watch('C2', '22.000001', OPS)
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
    getConversationTable().bind('C1', '5.000001', FOOD)
    expect(await replyInConversation('r-food', 'slack:C1:5.000001', 'Void it from *Invoices* → ⋯')).toBe('posted 1 message to slack:C1:5.000001')
    expect(posts).toEqual(['C1|5.000001|Void it from *Invoices* → ⋯'])
  })

  test('a top-level conversation (a DM) is answered at its top level; main answers the operator\'s DM', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    expect(await replyInConversation('main', 'slack:D0OP', 'hi')).toContain('posted 1')
    expect(posts).toEqual(['D0OP|-|hi'])
  })

  test("never into another specialist's conversation, one not open, or for a session in no specialist", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    session('r-none', 'some-other-thread')
    getConversationTable().bind('C2', '6.000001', OPS)
    await expect(replyInConversation('r-food', 'slack:C2:6.000001', 'x')).rejects.toThrow(`is bound to ${OPS}, not ${FOOD}: a reply goes only to a conversation bound to your specialist`)
    await expect(replyInConversation('r-food', 'slack:C1:7.000001', 'x')).rejects.toThrow('is not an open conversation')
    await expect(replyInConversation('r-none', 'slack:C2:6.000001', 'x')).rejects.toThrow(`is bound to ${OPS}: a reply goes only`)
    await expect(replyInConversation(undefined, 'slack:C2:6.000001', 'x')).rejects.toThrow('a reply goes only')
    expect(posts).toEqual([])
  })

  test("a specialist posts to its own home_place (a schedule's reply has no conversation): a new thread there, bound to it", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    session('r-ops', OPS_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome_place = "slack:#food-home"`), { names: { C7: 'food-home' } })
    expect(await replyInConversation('r-food', 'slack:#food-home', 'nightly summary')).toBe(`posted to ${FOOD}'s home_place (slack:#food-home); replies in its thread come back to ${FOOD}`)
    expect(posts).toEqual(['C7|-|nightly summary'])
    expect(getConversationTable().get('C7', '1.000001')).toMatchObject({ specialist: FOOD })
    expect(await replyInConversation('r-food', 'slack:C7', 'by id too')).toContain('home_place')
    await expect(replyInConversation('r-ops', 'slack:#food-home', 'not mine')).rejects.toThrow('conversation must look like')
    await expect(replyInConversation('r-ops', 'slack:C7', 'not mine')).rejects.toThrow('is not an open conversation')
  })

  test("a home_place answer in several parts keeps the rest in the first part's thread", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome_place = "slack:C7"`))
    await replyInConversation('r-food', 'slack:C7', 'para one\n\n'.repeat(800))
    expect(posts.map(p => p.split('|').slice(0, 2).join('|'))).toEqual(['C7|-', 'C7|1.000001', 'C7|1.000001'])
  })

  test("a part with no answer from Slack is reported as unknown (it may have posted), not as failed", async () => {
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '11.000001', FOOD)
    slackRuntimeDeps.post = async () => { throw new Error('A request error occurred: timeout of 30000ms exceeded') }
    await expect(replyInConversation('r-food', 'slack:C1:11.000001', 'hi')).rejects.toThrow("0 of 1 message(s) posted to slack:C1:11.000001; part 1's outcome is unknown (no answer from Slack: it may have posted)")
  })

  test('only a clean refusal counts as "did not post"; fatal_error, a 5xx or a dropped socket may have half succeeded: unknown', async () => {
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '13.000001', FOOD)
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

  test("a home_place reply's thread is bound as soon as its first part lands, even if a later part fails", async () => {
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome_place = "slack:C7"`))
    let n = 0
    slackRuntimeDeps.post = async () => { if (++n === 2) throw new Error('An API error occurred: ratelimited'); return '300.000001' }
    await expect(replyInConversation('r-food', 'slack:C7', 'para one\n\n'.repeat(800))).rejects.toThrow('reply failed after 1 of 3')
    expect(getConversationTable().get('C7', '300.000001')).toMatchObject({ specialist: FOOD, mentionedBy: 'home' })
  })

  test('a conversation moved away mid-reply gets no more of it', async () => {
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '12.000001', FOOD)
    posts.length = 0
    slackRuntimeDeps.post = async (c, t, text) => { posts.push(text.slice(0, 8)); getConversationTable().bind('C1', '12.000001', OPS); return '1.000001' }
    await expect(replyInConversation('r-food', 'slack:C1:12.000001', 'para one\n\n'.repeat(800))).rejects.toThrow('stopped after 1 of 3 message(s) to slack:C1:12.000001: it is no longer yours to answer')
    expect(posts).toHaveLength(1)
  })

  test('home_place threads count against what a specialist may open itself; past that the post goes, unbound, and the operator hears why', async () => {
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome_place = "slack:C7"`), { maxConversations: 50 })
    let n = 0
    slackRuntimeDeps.post = async () => `${100 + ++n}.000001`
    const posted: string[] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (_c: string, text: string) => { posted.push(text); return 'id' }
    try {
      for (let i = 0; i < 10; i++) expect(await replyInConversation('r-food', 'slack:C7', `report ${i}`)).toContain('replies in its thread come back')
      expect(await replyInConversation('r-food', 'slack:C7', 'one too many')).toContain(`its thread is not bound to ${FOOD}: ${FOOD} already holds 10 conversations it opened itself`)
      await Bun.sleep(5)
      expect(posted.some(p => p.includes("post to its home_place opened no conversation"))).toBe(true)
      await expect(bindConversation(food, 'slack:C1:99.000001')).rejects.toThrow('already holds 10 conversations it opened itself')
    } finally { (gateway as any).send = realSend }
  })

  test('a rename through `renamed_from` keeps the right to answer', async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '8.000001', 'old-food')
    configure(TOML.replace(`[specialists.${FOOD}]`, `[specialists.${FOOD}]\nrenamed_from = ["old-food"]`))
    expect(await replyInConversation('r-food', 'slack:C1:8.000001', 'still mine')).toContain('posted 1')
  })

  test('long text is split under Slack\'s limit; a failure says how far it got; attachments and empty text are refused', async () => {
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '9.000001', FOOD)
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
    getConversationTable().bind('C1', '10.000001', FOOD)
    const out = await executeTool('reply', { chat_id: 'slack:C1:10.000001', text: 'done' }, 'r-tool')
    expect((out.content[0] as { text: string }).text).toBe('posted 1 message to slack:C1:10.000001')
    expect(posts).toEqual(['C1|10.000001|done'])
  })
})

describe('sessions = "per-conversation"', () => {
  test('first come, first served: a newer conversation waits behind older waiters, and a freed place wakes them', async () => {
    configure(TOML.replace(`reachable_by = ["role:anyone"]\n`, `reachable_by = ["role:anyone"]\nsessions = "per-conversation"\nmax_sessions = 1\n`))
    const w = getConversationTable()
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
    startConversationTable()
    try {
      emit('session:death', { sessionId: 'x', threadId: 't', wasOwner: true, tmuxName: `${FOOD}_c1-9-000001` })
      emit('session:death', { sessionId: 'y', threadId: 't', wasOwner: true, tmuxName: 'someone-else' })
      expect(woke).toBe(1)
      emit('session:marked-dead', { sessionId: 'z', tmuxName: `${FOOD}_c1-8-000001` }) // a crash the health poll found
      expect(woke).toBe(2)
    } finally { stopConversationTable(); slackRuntimeDeps.wake = realWake }
  })

  test("first come, first served only when places are short: with a place to spare, a newer conversation doesn't wait", async () => {
    configure(TOML.replace(`reachable_by = ["role:anyone"]\n`, `reachable_by = ["role:anyone"]\nsessions = "per-conversation"\nmax_sessions = 3\n`))
    const w = getConversationTable()
    w.bind('C1', '1.000001', FOOD)
    const old = w.get('C1', '1.000001')!
    old.owed = ['1.000001']; old.waitingSince = Date.now() - 60_000 // waiting for its refetch, though places are free
    w.handle({ channel: 'C1', ts: `${Math.floor(Date.now() / 1000)}.000003`, user: 'UA', text: '<@UBOT> newer' })
    await w.flush()
    const newer = w.list().find(e => e.threadTs !== '1.000001')!
    expect(newer.waitingSince).toBeUndefined() // 3 places, 1 waiter ahead: it went on to its own session
  })

  test('a conversation session acts for its specialist: the tools, its home_place, but replies only into its own conversation', async () => {
    configure(TOML.replace(`reachable_by = ["role:anyone"]\n`, `reachable_by = ["role:anyone"]\nsessions = "per-conversation"\nhome_place = "slack:C7"\n`))
    fakePost()
    const conv = { threadId: 'conv-thread', tmuxName: `${FOOD}_c1-4-000001` }
    expect(isSpecialistOccupant(conv)).toBe(true)
    sessionIds.push('pc-own')
    registry.set('pc-own', { sessionId: 'pc-own', ...conv, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    getConversationTable().bind('C1', '4.000001', FOOD)
    getConversationTable().bind('C1', '5.000001', FOOD)
    expect(await replyInConversation('pc-own', 'slack:C7', 'scheduled report')).toContain(`posted to ${FOOD}'s home_place`)
    expect(await replyInConversation('pc-own', 'slack:C1:4.000001', 'mine')).toContain('posted 1')
    await expect(replyInConversation('pc-own', 'slack:C1:5.000001', 'a sibling\'s')).rejects.toThrow("and from a conversation's own session only to that conversation")
  })

  const PER = TOML.replace(`reachable_by = ["role:anyone"]\n`, `reachable_by = ["role:anyone"]\nsessions = "per-conversation"\nmax_sessions = 2\n`)
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
    getConversationTable().bind('C1', '4.000001', FOOD)
    getConversationTable().bind('C1', '5.000001', FOOD)
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
    getConversationTable().watch('C1', '9.000001', FOOD)
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1:9.000001', to: `specialist:${OPS}` }))).toMatchObject({ ok: true, data: { bound: `slack:C1:9.000001 → ${OPS}` } })
    expect(getConversationTable().get('C1', '9.000001')!.specialist).toBe(OPS)
    const listed = await handleCLIRequest(req('conversations', { action: 'list' }))
    expect((listed.data as any).conversations).toEqual([expect.stringContaining(`slack:C1:9.000001 (slack:C1) → ${OPS} · idle 0h`)])
    expect((listed.data as any).health).toMatchObject({ places: [{ place: 'slack:C1', to: FOOD }, { place: 'slack:C2', to: OPS }], conversations: 1, owed: 0, oldestOwedAgeMin: null })
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1:9.000001', to: 'specialist:nobody' }))).toMatchObject({ ok: false, error: 'no specialist "nobody" in hydra.toml (or a session\'s thread id)' })
    expect(await handleCLIRequest(req('conversations', { action: 'bind', conversation: 'slack:C1', to: `specialist:${OPS}` }))).toMatchObject({ ok: false, error: expect.stringContaining('names a channel, not a conversation') })
    expect(await handleCLIRequest(req('conversations', { action: 'unbind', conversation: 'slack:C1:9.000001' }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('conversations', { action: 'unbind', conversation: 'slack:C1:9.000001' }))).toMatchObject({ ok: true, data: { unbound: expect.stringContaining('was not bound') } })
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slack).toMatchObject({ conversations: 0 })
  })

  test('hydra route prints every candidate and why the winner won, and binds nothing', async () => {
    configure(TOML.replace(`[specialists.${FOOD}]`, `[[rules]]\nplace = "slack:C2"\nperson = "role:owner"\ntarget = "specialist:${FOOD}"\n[specialists.${FOOD}]`))
    const r = await handleCLIRequest(req('route', { person: 'person:olive', place: 'slack:C2' }))
    expect(r).toMatchObject({ ok: true, data: { fate: 'deliver', to: FOOD } })
    expect((r.data as any).report).toContain(`→ rule specialist:${FOOD}: rules[0]: first rule that matches`)
    expect((r.data as any).report).toContain(`rule specialist:${OPS}: rules[2] matches, but an earlier rule won`)
    expect(await handleCLIRequest(req('route', { person: 'stranger', place: 'slack:C2' }))).toMatchObject({ ok: true, data: { fate: 'refused', to: OPS } })
    expect(await handleCLIRequest(req('route', { person: 'slack:UNEW', place: 'slack:C9' }))).toMatchObject({ ok: true, data: { fate: 'unrouted' } })
    expect(await handleCLIRequest(req('route', { person: 'nobody', place: 'slack:C2' }))).toMatchObject({ ok: false })
    expect(getConversationTable().list()).toEqual([])
  })

  test('refusals by sender, unrouted mentions, and drops by kind are counted', async () => {
    configure(TOML, { maxConversations: 1 })
    const before = slackConversationHealth()!
    const w = getConversationTable()
    expect(w.handle({ channel: 'C2', ts: '50.000001', user: 'USTRANGER', text: '<@UBOT> hi' })).toBe('refused')
    expect(w.handle({ channel: 'C9', ts: '50.000002', user: 'USTRANGER', text: '<@UBOT> hi' })).toBe('unrouted')
    w.handle({ channel: 'C1', ts: '51.000001', user: 'UOWNER', text: '<@UBOT> one' })
    w.handle({ channel: 'C1', ts: '52.000001', user: 'UOWNER', text: '<@UBOT> two' }) // the table holds one
    const after = slackConversationHealth()!
    expect(after.refused - before.refused).toBe(1)
    expect(after.refusedBy.USTRANGER - (before.refusedBy.USTRANGER ?? 0)).toBe(1)
    expect(after.unrouted - before.unrouted).toBe(1)
    expect(after.dropped['table-full']! - (before.dropped['table-full'] ?? 0)).toBe(1)
    w.close()
  })

  test('health lists owed messages older than two catch-up passes, with the threshold it used (#669)', async () => {
    configure(TOML)
    const w = getConversationTable()
    w.handle({ channel: 'C1', ts: '51.000001', user: 'UOWNER', text: '<@UBOT> one' })   // accepted, never delivered: it is owed, and from 1970
    const h = ((await handleCLIRequest(req('health', {}))).data as any).slack
    expect(h.owedLateAfterMin).toBe(20)
    expect(h.owedLate).toHaveLength(1)
    expect(h.owedLate[0]).toMatchObject({ count: 1, cause: expect.any(String) })
    w.close()
  })

  test('health flags a #name place no channel answers to, and omits the line without an app named default', async () => {
    configure(TOML.replace('place = "slack:C2"', 'place = "slack:#ops-room"'))
    expect(slackConversationHealth()!.places.find(p => p.to === OPS)!.note).toContain('no channel answers to this name')
    configure('')
    expect(slackConversationHealth()).toBeNull()
    expect(((await handleCLIRequest(req('health', {}))).data as any).slack).toBeUndefined()
    void current
  })
})

describe('main and alerts', () => {
  test("the operator's DM reaches main only while main is connected; otherwise it stays owed", async () => {
    const w = getConversationTable()
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
      configure(TOML, { maxConversations: 1 })
      const w = getConversationTable()
      // ops, not food: the watcher is the daemon's one, and an earlier test began food's table-full episode
      w.handle({ channel: 'C2', ts: '80.000001', user: 'UOWNER', text: '<@UBOT> one' })
      w.handle({ channel: 'C2', ts: '81.000001', user: 'UOWNER', text: '<@UBOT> two' }) // table-full
      await Bun.sleep(10)
      expect(posted.some(p => p.channel === OPS_THREAD && p.text.includes('table-full'))).toBe(true)
      w.close()
    } finally { (gateway as any).send = realSend }
  })
})

describe('a live session is told, as input, what the connector says about its own bindings', () => {
  const MINE = '1552619225032425525'
  const heard: string[] = []
  const posted: [string, string][] = []
  const realSend = gateway.send
  beforeEach(() => {
    heard.length = 0; posted.length = 0
    ;(gateway as any).send = async (c: string, text: string) => { posted.push([c, text]); return 'id' }
  })
  beforeEach(() => { stopConversationTable(); startConversationTable() })
  afterEach(() => { (gateway as any).send = realSend; stopConversationTable(); for (const t of [MINE, OPS_THREAD]) registry.deleteThread(t) })
  /** A session in `threadId` whose input is recorded; `alive: false` is one that was killed. */
  const listening = (id: string, threadId: string, alive = true) => {
    sessionIds.push(id)
    registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() - 600_000, ...(alive ? {} : { deadAt: 1 }),
      adapter: fakeAdapter({ isAlive: () => alive, usage: () => null, deliver: async (_i: unknown, msg: { content?: string }) => { heard.push(String(msg.content)); return { status: 'accepted' } } }) } as any)
    registry.setThread(threadId, id)
  }
  const settle = () => new Promise(r => setTimeout(r, 20))
  const saidIn = (thread: string) => posted.filter(([c]) => c === thread).map(([, t]) => t)

  test('a specialist taking a thread the session listens to (bind_conversation): posted and delivered, once', async () => {
    listening('told-a', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C1:5.000001')
    await bindConversation(food, 'slack:C1:5.000001')
    await settle()
    expect(heard).toEqual([expect.stringMatching(new RegExp(`^\\[system\\] ℹ️ slack:C1:5.000001 was bound to this session to listen; ${FOOD} took it`))])
    expect(saidIn(MINE)).toHaveLength(1)
  })

  test("a specialist taking it through another app: the session listening through its own app is told", async () => {
    listening('told-b', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C9:6.000001')
    getConversationTable().watch('C9', '6.000001', FOOD, undefined, 'other')
    await settle()
    expect(heard).toHaveLength(1)
    expect(heard[0]).toStartWith('[system] ℹ️ ')
    expect(heard[0]).toContain(`${FOOD} now answers this thread through other`)
  })

  test('a tag of the bot in a thread the session listens to: the session is told the specialist took it', async () => {
    listening('told-c', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C1:7.000001')
    getConversationTable().handle({ channel: 'C1', ts: '7.000002', threadTs: '7.000001', user: 'UOWNER', text: '<@UBOT> hello' } as any)
    await settle()
    expect(getConversationTable().get('C1', '7.000001')?.specialist).toBe(FOOD)
    expect(heard).toEqual([expect.stringContaining(`Someone tagged the bot in slack:C1:7.000001, so ${FOOD} took it`)])
  })

  test("Slack can no longer read the conversation: the session that held it is told what was lost and what to do", async () => {
    listening('told-d', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C9:8.000001')
    getConversationTable().threadGone('C9', '8.000001', 'thread_not_found')
    await settle()
    expect(heard).toHaveLength(1)
    expect(heard[0]).toStartWith('[system] ⚠️ Let go of slack:C9:8.000001')
    expect(saidIn(MINE)).toHaveLength(1)
  })

  test('messages the session was owed and never got are dropped: the session that is in the thread is told, once', async () => {
    listening('told-g', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C9:11.000001')
    getConversationTable().get('C9', '11.000001')!.owed = ['11.000002']      // from 1970: past what is worth chasing
    getConversationTable().sweep()
    await settle()
    expect(heard).toHaveLength(1)
    expect(heard[0]).toStartWith('[system] ⚠️ Dropped 1 Slack message in C9:11.000001 (expired')
  })

  test('a session that unbinds a conversation owing messages is not also told: its tool result says it', async () => {
    listening('told-h', MINE)
    await bindConversation({ threadId: MINE }, 'slack:C9:12.000001')
    getConversationTable().get('C9', '12.000001')!.owed = [`${Math.floor(Date.now() / 1000)}.000001`]
    expect(unbindConversation({ threadId: MINE }, 'slack:C9:12.000001')).toBe('slack:C9:12.000001 is unbound; 1 message it still owed were dropped')
    await settle()
    expect(heard).toEqual([])
  })

  test('a session killed (nothing can read it) gets the post only: no input, and the dead session is not revived', async () => {
    listening('told-e', MINE, false)
    getConversationTable().bind('C9', '9.000001', MINE, 'tool')
    emit('session:death', { sessionId: 'told-e', threadId: MINE, wasOwner: true, tmuxName: 'told-e', deliberate: true })
    await settle()
    expect(saidIn(MINE)).toEqual([expect.stringContaining('This session was killed')])
    expect(heard).toEqual([])
    expect(registry.get('told-e')?.deadAt).toBe(1)
  })

  test('a thread with no session in it (vacant) is posted to, and nothing is delivered', async () => {
    getConversationTable().bind('C9', '10.000001', MINE, 'tool')
    getConversationTable().threadGone('C9', '10.000001', 'thread_not_found')
    await settle()
    expect(saidIn(MINE)).toHaveLength(1)
    expect(heard).toEqual([])
  })

  test("a specialist's alert stays post-only: the connector's trouble is the operator's, not a binding the session holds", async () => {
    // a specialist no earlier test used: the watcher is the daemon's one, and an alert episode lasts an hour
    const LONE = 'lone-t', LONE_THREAD = 'lone-thread-1'
    configure(`${TOML}[specialists.${LONE}]\nworkdir = "/w/lone"\nreachable_by = ["role:owner"]\n[[rules]]\nplace = "slack:C3"\ntarget = "specialist:${LONE}"\n`, { maxConversations: 1 })
    setSpecialistThread(LONE, LONE_THREAD)
    listening('told-f', LONE_THREAD)
    const w = getConversationTable()
    w.handle({ channel: 'C3', ts: '90.000001', user: 'UOWNER', text: '<@UBOT> one' })
    w.handle({ channel: 'C3', ts: '91.000001', user: 'UOWNER', text: '<@UBOT> two' })
    await settle()
    expect(saidIn(LONE_THREAD).some(t => t.includes('table-full'))).toBe(true)
    expect(heard).toEqual([])
    registry.deleteThread(LONE_THREAD)
    w.close()
  })
})

const appOf = (toml: string) => defaultSlackApp(hydra(toml))!

describe('tokens', () => {
  test('a token is read only from a variable every session is kept from; any other name is refused, with which key and why', () => {
    const env = { SLOPBOT_SLACK_BOT_TOKEN: 'xoxb-1', SLOPBOT_SLACK_APP_TOKEN: 'xapp-1' }
    expect(slackTokens(appOf(TOML), env)).toEqual({ bot: 'xoxb-1', app: 'xapp-1' })
    const warned: string[] = []
    const leaky = appOf(TOML.replace('bot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"', 'bot_token_env = "UNLISTED_BOT_TOKEN"'))
    expect(slackTokens(leaky, { ...env, UNLISTED_BOT_TOKEN: 'xoxb-leak' }, l => warned.push(l))).toEqual({ bot: undefined, app: 'xapp-1' })
    expect(warned[0]).toContain('refusing to read the token in UNLISTED_BOT_TOKEN, the `bot_token_env` of hydra (`[slack.apps.default]`)')
    expect(warned[0]).not.toContain('xoxb')
    // With a display_name the name leads, and the table to edit is still named once.
    const named: string[] = []
    const krust = appOf(TOML.replace('bot_token_env = "SLOPBOT_SLACK_BOT_TOKEN"', 'bot_token_env = "UNLISTED_BOT_TOKEN"\ndisplay_name = "Acme helper"'))
    slackTokens(krust, { ...env, UNLISTED_BOT_TOKEN: 'xoxb-leak' }, l => named.push(l))
    expect(named[0]).toContain('refusing to read the token in UNLISTED_BOT_TOKEN, the `bot_token_env` of Acme helper (`[slack.apps.default]`):')
  })
})

describe('tokens: any variable the config names', () => {
  test('a SLOPBOT_ name and a custom one are read once registered, and not before', () => {
    const toml = TOML.replace('"SLOPBOT_SLACK_BOT_TOKEN"', '"SLOPBOT_SLACK_SALES_BOT"').replace('"SLOPBOT_SLACK_APP_TOKEN"', '"ACME_SOCKET_TOKEN"')
    const env = { SLOPBOT_SLACK_SALES_BOT: 'xoxb-s', ACME_SOCKET_TOKEN: 'xapp-s' }
    const warned: string[] = []
    expect(slackTokens(appOf(toml), env, l => warned.push(l))).toEqual({ bot: undefined, app: undefined })
    expect(warned).toHaveLength(2)
    registerSpawnVars(tokenEnvNames(hydra(toml)), {})
    expect(slackTokens(appOf(toml), env)).toEqual({ bot: 'xoxb-s', app: 'xapp-s' })
  })
  test('a name sessions need, like PATH, is refused, saying which key and why (the loader rejects it first; this is the backstop)', () => {
    const warned: string[] = []
    const app = { ...appOf(TOML), botTokenEnv: 'PATH' }
    expect(registerSpawnVars(['PATH'], {}).refused).toEqual([{ name: 'PATH', reason: 'is a variable sessions need' }])
    expect(slackTokens(app, { PATH: '/bin' }, l => warned.push(l)).bot).toBeUndefined()
    expect(warned[0]).toContain('refusing to read the token in PATH, the `bot_token_env` of hydra (`[slack.apps.default]`): it is a variable sessions need')
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
    expect(getConversationTable().get('C9', '1.000001')!.via).toBeUndefined()
  })

  test('only the operator reads it: bound, marked, and listed so', async () => {
    withUser()
    slackRuntimeDeps.readThread = async () => 'user'
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).toContain("live, read as the operator: the bot isn't in slack:C9")
    expect(getConversationTable().get('C9', '1.000001')!.via).toBe('user')
    expect(formatConversationsFor({ threadId: MINE }).join()).toContain('· read as the operator')
  })

  test('nobody can read it: refused, with what to do, and nothing is bound', async () => {
    slackRuntimeDeps.readThread = async () => { throw new Error('An API error occurred: not_in_channel') }
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow("not bound: slack:C9:1.000001: the bot (<@UBOT>) isn't in slack:C9 (An API error occurred: not_in_channel). Ask the operator to invite it")
    withUser()
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow('nor the operator is in slack:C9')
    slackRuntimeDeps.readThread = async () => { throw new Error('An API error occurred: thread_not_found') }
    await expect(bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).rejects.toThrow("not bound: slack:C9:1.000001: it can't be read (An API error occurred: thread_not_found)")
    expect(getConversationTable().get('C9', '1.000001')).toBeUndefined()
  })

  test("a specialist never binds a thread only the operator can read: it could not answer there", async () => {
    withUser()
    slackRuntimeDeps.readThread = async () => 'user'
    await expect(bindConversation(food, 'slack:C1:1.000001')).rejects.toThrow(`not bound: slack:C1:1.000001: the bot isn't in slack:C1, so ${FOOD} could not answer there`)
    expect(getConversationTable().get('C1', '1.000001')).toBeUndefined()
  })

  test('Slack not connected: bound, and said to be unchecked', async () => {
    slackRuntimeDeps.readThread = async () => null
    expect(await bindConversation({ threadId: MINE }, 'slack:C9:1.000001')).toContain("not checked: Slack isn't connected; if the thread can't be read")
  })
})

describe('reply_to answers in the thread of one message', () => {
  const MSG = '1793000001.000100'
  const DM = 'slack:D0OP'

  test('main answering a DM message with reply_to posts in that message\'s thread and binds it to main', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    const out = await replyInConversation('main', DM, 'in thread', [], MSG)
    expect(posts).toEqual([`D0OP|${MSG}|in thread`])
    expect(out).toBe(`posted 1 message to ${DM}, in the thread of message ${MSG}; replies in it come back to main`)
    expect(getConversationTable().get('D0OP', MSG)).toMatchObject({ specialist: 'main' })
  })

  test('the same through the bridge reply tool, with the ts in reply_to and the conversation in chat_id', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    const out = await executeTool('reply', { chat_id: DM, text: 'hi', reply_to: MSG }, 'main')
    expect(posts).toEqual([`D0OP|${MSG}|hi`])
    expect((out.content[0] as { text: string }).text).toContain(`in the thread of message ${MSG}`)
  })

  test("a message's ts as chat_id is still not a conversation (the tool text says to use reply_to)", async () => {
    fakePost()
    await expect(replyInConversation('main', `slack:D0OP:${MSG}`, 'x')).rejects.toThrow('is not an open conversation')
    expect(posts).toEqual([])
  })

  test('a specialist answering a DM bound to it opens a thread bound to it', async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('D0OP', '0.000000', FOOD)
    expect(await replyInConversation('r-food', DM, 'there', [], MSG)).toContain(`replies in it come back to ${FOOD}`)
    expect(posts).toEqual([`D0OP|${MSG}|there`])
    expect(getConversationTable().get('D0OP', MSG)).toMatchObject({ specialist: FOOD })
  })

  test('a thread the rules bound to another specialist while the first part posted is not taken from it', async () => {
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('D0OP', '0.000000', FOOD)
    posts.length = 0
    slackRuntimeDeps.post = async (c, t, text) => { posts.push(`${c}|${t}|${text}`); getConversationTable().bind('D0OP', MSG, OPS); return '1.000001' }
    expect(await replyInConversation('r-food', DM, 'x', [], MSG)).toContain(`not bound to ${FOOD}: it is already bound to ${OPS}`)
    expect(getConversationTable().get('D0OP', MSG)).toMatchObject({ specialist: OPS })
  })

  test('a long answer keeps every part in that thread', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    await replyInConversation('main', DM, 'para\n\n'.repeat(1200), [], MSG)
    expect(posts.length).toBeGreaterThan(1)
    expect(posts.every(p => p.startsWith(`D0OP|${MSG}|`))).toBe(true)
  })

  test('a reply_to that is not a message ts posts nothing and says so', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    await expect(replyInConversation('main', DM, 'x', [], 'not-a-ts')).rejects.toThrow('reply_to not-a-ts is not a Slack message ts')
    expect(posts).toEqual([])
    expect(getConversationTable().get('D0OP', MSG)).toBeUndefined()
  })

  test("in a thread conversation the post goes to the thread; reply_to naming another message is reported, its own root is not", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '5.000001', FOOD)
    expect(await replyInConversation('r-food', 'slack:C1:5.000001', 'a', [], '5.000001')).toBe('posted 1 message to slack:C1:5.000001')
    const out = await replyInConversation('r-food', 'slack:C1:5.000001', 'b', [], MSG)
    expect(out).toContain(`reply_to ${MSG} is not this thread's first message`)
    expect(out).toContain('posted to the thread as a whole')
    expect(posts).toEqual(['C1|5.000001|a', 'C1|5.000001|b'])
  })

  test("never under a message whose thread is another specialist's, or bound to a session", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    getConversationTable().bind('C1', '0.000000', FOOD)
    getConversationTable().bind('C1', MSG, OPS)
    await expect(replyInConversation('r-food', 'slack:C1', 'x', [], MSG)).rejects.toThrow(`is bound to ${OPS}, not ${FOOD}`)
    getConversationTable().unwatch('C1', MSG)
    session('sw-listener', '1552619225032425525')
    getConversationTable().bind('C1', MSG, '1552619225032425525')
    await expect(replyInConversation('r-food', 'slack:C1', 'x', [], MSG)).rejects.toThrow(`is bound to 1552619225032425525, not ${FOOD}`)
    expect(posts).toEqual([])
  })

  test("a thread of the replier's own that already exists is answered, not rebound", async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    getConversationTable().bind('D0OP', MSG, 'main')
    expect(await replyInConversation('main', DM, 'again', [], MSG)).toBe(`posted 1 message to ${DM}, in the thread of message ${MSG}`)
    expect(posts).toEqual([`D0OP|${MSG}|again`])
  })

  test("a home_place post opens its own thread: reply_to there is refused, nothing posted", async () => {
    fakePost()
    session('r-food', FOOD_THREAD)
    configure(TOML.replace(`workdir = "/w/food"`, `workdir = "/w/food"\nhome_place = "slack:C7"`))
    await expect(replyInConversation('r-food', 'slack:C7', 'x', [], MSG)).rejects.toThrow('reply_to cannot be used on a post to')
    expect(posts).toEqual([])
  })

  test("a conversation's own session cannot open a thread (it would be a new conversation with another session)", async () => {
    fakePost()
    configure(TOML.replace(`reachable_by = ["role:anyone"]\n`, `reachable_by = ["role:anyone"]\nsessions = "per-conversation"\n`))
    session(`${FOOD}_c1`, FOOD_THREAD)
    getConversationTable().bind('C1', '0.000000', FOOD)
    await expect(replyInConversation(`${FOOD}_c1`, 'slack:C1', 'x', [], MSG)).rejects.toThrow("from a conversation's own session")
    expect(posts).toEqual([])
  })

  test('when the table cannot bind the thread, the post still lands and the result says follow-ups will not come back', async () => {
    fakePost()
    getConversationTable().bind('D0OP', '0.000000', 'main')
    getConversationTable().bind('C1', '1.000001', FOOD)
    getConversationTable().bind('C1', '2.000001', FOOD) // the table holds 3
    const out = await replyInConversation('main', DM, 'x', [], MSG)
    expect(posts).toEqual([`D0OP|${MSG}|x`])
    expect(out).toContain('its thread is not bound to main: the conversation table is full')
  })
})

describe('placeFileFor (a download for a specialist that reads only its own folder)', () => {
  test('a write-confined specialist gets a copy in <workdir>/.inbox; any other recipient gets nothing, so the download stands', () => {
    const { mkdtempSync, writeFileSync, readFileSync, realpathSync } = require('fs') as typeof import('fs')
    const { tmpdir } = require('os') as typeof import('os')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'place-file-')))
    try {
      const src = join(root, 'F1-a.pdf'); writeFileSync(src, 'bytes')
      const work = join(root, 'work'); require('fs').mkdirSync(work)
      const p = placeFileFor({ canOnlyWriteTo: 'workdir', workdir: work }, src, 'a.pdf')!
      expect(p.startsWith(join(work, '.inbox') + '/')).toBe(true)
      expect(readFileSync(p, 'utf8')).toBe('bytes')
      expect(placeFileFor({ workdir: work }, src, 'a.pdf')).toBeUndefined()
      expect(placeFileFor(undefined, src, 'a.pdf')).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
