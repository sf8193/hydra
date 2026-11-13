import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCLIRequest, type CLIRequest } from '../../daemon/cli-handler.js'
import { registry, threadRegistry } from '../../daemon/sessions.js'
import { transport } from '../../daemon/bridge-transport.js'
import { specialistDeps } from '../specialist-deliver.js'
import { conversationSessionName, deliverToTarget, toSession, toThread } from '../targets.js'
import { executeTool } from '../../daemon/bridge-dispatch.js'
import { _resetDelivery, _setDeliveryDeps, deliverUserMessage } from '../../daemon/typed-delivery.js'
import { engines } from '../../daemon/engines/instances.js'
import { removeSpecialist, setSpecialist, setSpecialistThread, getSpecialist, withTargetLock, listSpecialists } from '../specialists.js'
import { bornPolicy, deliveryRefusal, type LaunchPolicy } from '../../daemon/scope.js'
import { gateway } from '../../daemon/config.js'
import { _resetBackoff, _reloadBackoff, backoffClock, getBackoff, BACKOFF_BASE_MS as SPAWN_BACKOFF_BASE_MS, BACKOFF_STALE_MS } from '../../daemon/recovery-backoff.js'
import { _setRecoveryDeps, _resetRecoveryDeps } from '../../daemon/recovery.js'
import { handleResumeIntercept } from '../../daemon/commands/thread.js'
import { fakeAdapter } from '../../daemon/__tests__/test-harness.js'
import { getIdempotencyEntry } from '../../daemon/idempotency.js'
import { _setDaemonStartedAtForTesting } from '../../daemon/session-reachability.js'
import { _setHydraConfigForTesting, currentHydraConfig } from '../../daemon/hydra-config.js'

process.stderr.write = (() => true) as any

let n = 0
const req = (command: string, params: Record<string, unknown>): CLIRequest => ({ type: 'cli', command, id: `specialist-${++n}`, params })
const deliver = (specialist: string, extra: Record<string, unknown> = {}) =>
  handleCLIRequest(req('deliver', { specialist, message: 'a mention', initiator: 'forwarder', ...extra }))

describe('specialists', () => {
  test('a specialist cannot take a default session name', () => {
    expect(() => setSpecialist('comet', { threadId: 't-1' })).toThrow(/default session name/)
    expect(getSpecialist('comet')).toBeUndefined()
  })

  const realDeps = { ...specialistDeps }
  const realClock = { ...backoffClock }
  const names: string[] = []
  const sessions: string[] = []
  const threads: string[] = []
  afterEach(() => {
    Object.assign(specialistDeps, realDeps)
    Object.assign(backoffClock, realClock)
    _setDaemonStartedAtForTesting(undefined)
    _resetBackoff()
    _resetRecoveryDeps()
    for (const s of sessions.splice(0)) { registry.delete(s); transport.bridges.delete(s) }
    for (const t of threads.splice(0)) { registry.threadToSession.delete(t); threadRegistry.delete(t) }
    for (const name of names.splice(0)) removeSpecialist(name)
  })

  const specialist = (thread: string, extra: Record<string, unknown> = {}) => {
    const name = `t-specialist-${++n}`
    names.push(name)
    setSpecialist(name, { threadId: thread, kickoff: 'be the slopbot', ...extra })
    return name
  }
  function occupy(thread: string, over: Record<string, unknown> = {}) {
    const sessionId = `specialist-sess-${++n}`
    sessions.push(sessionId)
    registry.set(sessionId, { sessionId, tmuxName: `${sessionId}-tmux`, threadId: thread, engine: 'claude', createdAt: Date.now(), adapter: fakeAdapter({ isAlive: () => true }), ...over } as any)
    registry.threadToSession.set(thread, sessionId)
    threads.push(thread)
    return sessionId
  }
  /** Every revive tier spawns through `spawn` (doSpawnSession's signature); there is no conversation to resume. */
  function setSpawn(spawn: (...args: any[]) => Promise<any>) {
    _setRecoveryDeps({
      doSpawnSession: spawn as any,
      tryResume: async () => null,
      tryRespawn: ((threadId: string, topic: string, resurrectFrom: string | undefined, model: string | undefined, extra: any) =>
        spawn(topic, undefined, undefined, { ...extra, existingThreadId: threadId, resurrectFrom, model })) as any,
    })
  }
  /** A spawn that behaves like doSpawnSession: registers a live session and reports its thread. */
  function fakeSpawn() {
    const calls: unknown[][] = []
    const spawn = async (...args: unknown[]) => {
      calls.push(args)
      await Bun.sleep(15) // a real spawn yields; concurrent callers must still share it
      const opts = args[3] as { existingThreadId?: string }
      const threadId = opts.existingThreadId ?? `fresh-thread-${++n}`
      const sessionId = occupy(threadId)
      return { name: `${sessionId}-tmux`, sessionId, threadId, url: '' }
    }
    setSpawn(spawn)
    return Object.assign(calls, { spawn })
  }

  test('a live occupant gets the message and nothing is spawned', async () => {
    const calls = fakeSpawn()
    const sid = occupy('thread-live')
    const name = specialist('thread-live')
    const res = await deliver(name)
    expect(res).toMatchObject({ ok: true, data: { sessionId: sid, specialist: name, spawned: false, threadId: 'thread-live' } })
    expect(calls).toHaveLength(0)
  })

  describe("a running session whose specialist's scope changed is not delivered to", () => {
    const MCP = { datadog: { name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs'] }, loki: { name: 'loki', command: '/usr/local/bin/loki-mcp', tokenEnv: [], tools: ['query'] } }
    const configure = (name: string, over: Record<string, unknown> = {}) => _setHydraConfigForTesting({
      operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [], mcpServers: MCP,
      people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
      specialists: { [name]: { id: name, workdir: '/srv/x', prompt: 'k', home: '555', listens: [], allow: [], sessions: 'shared', max: 20, was: [], access: 'operator', ...over } as any },
    })
    afterEach(() => _setHydraConfigForTesting(undefined))
    /** The real Claude adapter (its `deliver` is where every delivery is gated), reported alive: the session is running, with no bridge. */
    const gated = () => Object.assign(Object.create(engines.claude), { isAlive: () => true })
    const queued = (sid: string) => (transport.messageQueues.get(sid) ?? []).length
    const quiet = async <T>(fn: () => Promise<T>): Promise<{ out: T; log: string; posted: string[] }> => {
      const lines: string[] = []; const posted: string[] = []
      const w = process.stderr.write; const send = gateway.send
      process.stderr.write = ((t: string) => { lines.push(String(t)); return true }) as any
      ;(gateway as any).send = async (_c: string, text: string) => { posted.push(text); return { id: 'm' } }
      try { const out = await fn(); await Bun.sleep(20); return { out, log: lines.join(''), posted } } finally { process.stderr.write = w; (gateway as any).send = send }
    }
    /** A running session of `name` that started under `scopeId`, in a thread hydra.toml names as the specialist's. */
    function running(name: string, thread: string, policy: LaunchPolicy | undefined) {
      configure(name)
      setSpecialistThread(name, thread)
      return occupy(thread, { policy, sessionType: 'thread_owner', adapter: gated() })
    }
    const operatorPolicy = (id: string): LaunchPolicy => ({ specialist: id, access: 'operator', id: 'operator' })
    const nameOf = () => { const name = `t-scope-${++n}`; names.push(name); return name }

    test('operator access to workdir: nothing is delivered, the thread is told the command, the log names both accesses; after a respawn it delivers', async () => {
      const calls = fakeSpawn()
      const name = nameOf()
      const sid = running(name, 'thread-scope-1', operatorPolicy(name))
      expect((await deliver(name)).ok).toBe(true)                                 // unchanged: delivered
      const before = queued(sid)
      expect(before).toBeGreaterThan(0)

      configure(name, { access: 'workdir', tools: ['Read', 'Grep', 'Glob'], mcp: [] })   // the operator edits hydra.toml
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      expect((r.out as any).error).toContain(`hydra kill ${sid}-tmux`)
      expect((r.out as any).error).toContain('access = "operator"')
      expect((r.out as any).error).toContain('access = "workdir"')
      expect(queued(sid)).toBe(before)                                             // nothing delivered
      expect(calls).toHaveLength(0)                                                // nothing killed or restarted by hydra
      expect(registry.get(sid)).toBeDefined()
      expect(r.log).toContain(`specialist ${name}`)
      expect(r.log).toContain('access = "operator"')
      expect(r.log).toContain('access = "workdir" (folder /srv/x; tools Read,Grep,Glob; mcp none)')
      expect(r.log).not.toMatch(/workdir:[0-9a-f]{12}/)                            // words, not a hash
      expect(r.posted).toHaveLength(1)
      expect(r.posted[0]).toContain(`hydra kill ${sid}-tmux`)
      expect(r.posted[0]).toContain('nothing was delivered')

      // Another message: still refused, and the thread is not told twice.
      const again = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(again.out).toMatchObject({ ok: false, exitCode: 3 })
      expect(again.posted).toHaveLength(0)

      // The operator kills it as told; the next message starts it fresh, under the new scope, and then delivers.
      registry.delete(sid); registry.threadToSession.delete('thread-scope-1'); transport.bridges.delete(sid)
      const revived = await deliver(name, { idempotencyKey: `scope-k-${++n}` })
      expect(revived).toMatchObject({ ok: true, data: { spawned: true } })
      expect(calls).toHaveLength(1)
      expect((calls[0][3] as any).specialist).toBe(name)
      const fresh = (revived.data as any).sessionId as string
      registry.get(fresh)!.policy = bornPolicy(name)                              // what a real scoped launch records
      expect((await deliver(name, { idempotencyKey: `scope-k-${++n}` })).ok).toBe(true)
      expect(queued(fresh)).toBeGreaterThan(0)
    })

    test('a tools-only change refuses too', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read', 'Grep', 'Glob'], mcp: [] })
      const sid = occupy('thread-scope-2', { policy: bornPolicy(name), sessionType: 'scoped', verified: true, adapter: gated() })
      setSpecialistThread(name, 'thread-scope-2')
      expect((await deliver(name)).ok).toBe(true)                                  // same scope: delivered
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [] })
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      expect(r.log).toContain('tools Read,Grep,Glob')                              // the old tools are in the words
      expect(r.log).toContain('tools Read;')
      expect(queued(sid)).toBe(1)
    })

    test('an mcp-only change refuses too', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: ['datadog'] })
      const sid = occupy('thread-scope-3', { policy: bornPolicy(name), sessionType: 'scoped', verified: true, adapter: gated() })
      setSpecialistThread(name, 'thread-scope-3')
      expect((await deliver(name)).ok).toBe(true)
      configure(name, { access: 'workdir', tools: ['Read'], mcp: ['datadog', 'loki'] })
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      expect(r.log).toContain('mcp datadog,loki')
      expect(queued(sid)).toBe(1)
    })

    test('a listed server gaining a tool: the refusal and the thread say what changed (the old and new tools differ in the words)', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: ['datadog'] })
      const sid = occupy('thread-scope-7', { policy: bornPolicy(name), sessionType: 'scoped', verified: true, adapter: gated() })
      setSpecialistThread(name, 'thread-scope-7')
      _setHydraConfigForTesting({ ...currentHydraConfig(), mcpServers: { ...MCP, datadog: { ...MCP.datadog, tools: ['search_logs', 'get_monitor'] } } })
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      const text = (r.out as any).error as string
      expect(text).toContain('mcp datadog tools: search_logs -> search_logs,get_monitor')
      expect(text).toContain(`Run \`hydra kill ${sid}-tmux\`; the next message to the specialist starts a new session that re-reads hydra.toml.`)
      expect(r.posted.join('\n')).toContain('mcp datadog tools: search_logs -> search_logs,get_monitor')
      expect(queued(sid)).toBe(0)
    })

    test('workdir back to operator refuses as well (the session still holds the narrower scope)', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [] })
      const sid = occupy('thread-scope-4', { policy: bornPolicy(name), sessionType: 'scoped', verified: true, adapter: gated() })
      setSpecialistThread(name, 'thread-scope-4')
      configure(name, { access: 'operator' })
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      expect(queued(sid)).toBe(0)
    })

    test('a session that started before scopes were recorded counts as the operator\'s: a flip to workdir refuses it', async () => {
      const name = nameOf()
      configure(name)
      setSpecialistThread(name, 'thread-scope-5')
      const sid = occupy('thread-scope-5', { sessionType: 'thread_owner', adapter: gated() })       // no specialist, no scopeId: an old record
      expect((await deliver(name)).ok).toBe(true)
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [] })
      const r = await quiet(() => deliver(name, { idempotencyKey: `scope-k-${++n}` }))
      expect(r.out).toMatchObject({ ok: false, exitCode: 3 })
      expect(queued(sid)).toBe(1)
    })

    describe('every route to a drifted session is refused, and the thread hears the one remedy sentence', () => {
      const REMEDY = (sid: string) => `Run \`hydra kill ${sid}-tmux\`; the next message to the specialist starts a new session that re-reads hydra.toml.`
      /** A running operator-access specialist session, then hydra.toml says workdir. */
      function drifted(thread: string) {
        const name = nameOf()
        const sid = running(name, thread, operatorPolicy(name))
        configure(name, { access: 'workdir', tools: ['Read'], mcp: [] })
        return { name, sid }
      }
      const heard = (r: { posted: string[] }, sid: string) => { expect(r.posted.join('\n')).toContain(REMEDY(sid)) }

      test('deliverToTarget to the specialist', async () => {
        const { name, sid } = drifted('thread-route-1')
        const r = await quiet(() => deliver(name, { idempotencyKey: `route-${++n}` }))
        expect(r.out).toMatchObject({ ok: false })
        expect(queued(sid)).toBe(0); heard(r, sid)
      })
      test('toThread to its thread id, no revive', async () => {
        const { sid } = drifted('thread-route-2')
        const r = await quiet(() => toThread('thread-route-2', 'hi', { initiator: 'x', queue: true }, false))
        expect(r.out).toMatchObject({ ok: false })
        expect(queued(sid)).toBe(0); heard(r, sid)
      })
      test('toThread with revive: a live session is still not delivered to', async () => {
        const { sid } = drifted('thread-route-3')
        const r = await quiet(() => toThread('thread-route-3', 'hi', { initiator: 'x', queue: true }, true))
        expect(r.out).toMatchObject({ ok: false })
        expect(queued(sid)).toBe(0); heard(r, sid)
      })
      test('toSession by name', async () => {
        const { sid } = drifted('thread-route-4')
        const r = await quiet(() => toSession(registry.get(sid)!, 'hi', { initiator: 'x', queue: true }))
        expect(r.out).toMatchObject({ ok: false })
        expect(queued(sid)).toBe(0); heard(r, sid)
      })
      test('send_to_thread to it from another session', async () => {
        const { sid } = drifted('thread-route-5')
        const other = occupy('thread-route-5-other', { sessionType: 'thread_owner' })
        const r = await quiet(() => executeTool('send_to_thread', { target: `${sid}-tmux`, type: 'progress', text: 'hello' }, other))
        expect(queued(sid)).toBe(0); heard(r, sid)
      })
      test('an inbound chat message (the router\'s path: deliverUserMessage into sendOrQueue)', async () => {
        const { sid } = drifted('thread-route-6')
        const r = await quiet(() => deliverUserMessage(sid, 'a question', { chat_id: 'thread-route-6', message_id: 'm1', user: 'u', user_id: 'u1' }, () => transport.sendOrQueue(sid, { type: 'notification', content: 'a question', meta: { chat_id: 'thread-route-6', message_id: 'm1', user: 'u', user_id: 'u1' } })))
        await Bun.sleep(30)   // sendOrQueue delivers through the adapter without awaiting it
        expect(queued(sid)).toBe(0)
      })
      test('a trusted sender\'s message is not typed into a drifted session\'s pane either', async () => {
        const { sid } = drifted('thread-route-7')
        const saved = { mode: process.env.HYDRA_TYPED_DELIVERY_MODE, ids: process.env.HYDRA_TYPED_DELIVERY_USER_IDS }
        process.env.HYDRA_TYPED_DELIVERY_MODE = 'paste'; process.env.HYDRA_TYPED_DELIVERY_USER_IDS = 'u1'
        const pasted: string[] = []
        _setDeliveryDeps({ isWorking: async () => true, paste: async (_i, c) => { pasted.push(c); return true } })
        try {
          await quiet(() => deliverUserMessage(sid, 'do it', { chat_id: 'thread-route-7', message_id: 'm2', user: 'u', user_id: 'u1' }, () => transport.sendOrQueue(sid, { type: 'notification', content: 'do it', meta: {} })))
          await Bun.sleep(30)
          expect(pasted).toEqual([])
          expect(queued(sid)).toBe(0)
        } finally {
          _resetDelivery()
          for (const [k, v] of [['HYDRA_TYPED_DELIVERY_MODE', saved.mode], ['HYDRA_TYPED_DELIVERY_USER_IDS', saved.ids]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
        }
      })
      test('the control: with no drift, each of those routes delivers', async () => {
        const name = nameOf()
        const sid = running(name, 'thread-route-8', operatorPolicy(name))
        expect((await toThread('thread-route-8', 'hi', { initiator: 'x', queue: true }, false)).ok).toBe(true)
        expect((await toSession(registry.get(sid)!, 'hi', { initiator: 'x', queue: true })).ok).toBe(true)
        transport.sendOrQueue(sid, { type: 'notification', content: 'x', meta: {} })
        await Bun.sleep(30)
        expect(queued(sid)).toBe(3)
      })
    })

    test('a conversation\'s running session is refused through deliverToTarget (perConversation), the check that landRunning used to hold alone', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [], sessions: 'per-conversation' })
      const conv = 'slack:C1:1.000001'
      const tmux = conversationSessionName(name, conv)
      const sid = occupy('thread-conv-route', { tmuxName: tmux, policy: operatorPolicy(name), sessionType: 'thread_owner', adapter: gated() })
      const r = await quiet(() => deliverToTarget({ perConversation: name, conversation: conv }, 'hi', { initiator: 'x' }))
      expect(r.out).toMatchObject({ ok: false })
      expect(queued(sid)).toBe(0)
      expect(r.posted.join('\n')).toContain(`Run \`hydra kill ${tmux}\``)
    })
    test('a specialist moved or renamed since the session started is still found by the id the session was born with', async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [] })
      // The session sits in a thread the specialist no longer owns (its pointer moved): only the stored policy still names it.
      const session = { sessionId: 's-moved', tmuxName: 'moved-tmux', threadId: 'thread-nobody-owns', policy: operatorPolicy(name), sessionType: 'thread_owner' } as any
      const reason = (await quiet(async () => deliveryRefusal(session))).out
      expect(reason).toContain(`specialist ${name}`)
      expect(reason).toContain('access: operator -> workdir')
    })
    test("a conversation's own session (crm_<conversation>) is held to the same rule", async () => {
      const name = nameOf()
      configure(name, { access: 'workdir', tools: ['Read'], mcp: [], sessions: 'per-conversation' })
      const conv = { sessionId: 'conv-1', tmuxName: `${name}_c1`, threadId: 'thread-conv-1', policy: operatorPolicy(name), sessionType: 'thread_owner' } as any
      const reason = (await quiet(async () => deliveryRefusal(conv))).out
      expect(reason).toContain(`hydra kill ${name}_c1`)
      expect(reason).toContain('access = "operator"')
      expect(deliveryRefusal({ ...conv, policy: bornPolicy(name), sessionType: 'scoped', verified: true })).toBeUndefined()
    })

    test('an unchanged scope is never refused, and a session no specialist fills is not looked at', async () => {
      const name = nameOf()
      const sid = running(name, 'thread-scope-6', operatorPolicy(name))
      for (let i = 0; i < 3; i++) expect((await deliver(name, { idempotencyKey: `scope-k-${++n}` })).ok).toBe(true)
      expect(queued(sid)).toBe(3)
    })
  })

  test('a vacant specialist spawns once from its kickoff, reusing its thread when hydra knows it', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-known')
    // The thread must be known to hydra for it to be reused.
    threads.push('thread-known')
    threadRegistry.set('thread-known', { threadId: 'thread-known', sessionHistory: [] } as any)
    const res = await deliver(name, { model: undefined })
    expect(res.ok).toBe(true)
    expect((res.data as any).spawned).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('be the slopbot')
    expect((calls[0][3] as any).existingThreadId).toBe('thread-known')
    expect(getSpecialist(name)!.threadId).toBe('thread-known')
  })

  test('two concurrent mentions on a vacant specialist share one spawn', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-vacant', { channel: 'chan-1' })
    const [a, b] = await Promise.all([deliver(name, { idempotencyKey: `specialist-k-${++n}` }), deliver(name, { idempotencyKey: `specialist-k-${++n}` })])
    expect(a.ok && b.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect((a.data as any).sessionId).toBe((b.data as any).sessionId)
    expect([(a.data as any).spawned, (b.data as any).spawned].sort()).toEqual([false, true])
  })

  test('when the platform says the thread is gone the specialist moves to the fresh thread the spawn opened', async () => {
    fakeSpawn()
    specialistDeps.threadExists = async () => false
    const name = specialist('thread-deleted', { channel: 'chan-1' })
    const res = await deliver(name)
    expect(res.ok).toBe(true)
    expect(getSpecialist(name)!.threadId).toBe((res.data as any).threadId)
    expect(getSpecialist(name)!.threadId).not.toBe('thread-deleted')
    expect(getSpecialist(name)!.kickoff).toBe('be the slopbot')
  })

  test('a gone thread with no channel, no kickoff, and unknown specialist each fail clearly and spawn nothing', async () => {
    const calls = fakeSpawn()
    specialistDeps.threadExists = async () => false
    expect(await deliver(specialist('thread-gone'))).toMatchObject({ ok: false, error: expect.stringContaining('no channel') })
    expect(await deliver(specialist('thread-gone-2', { kickoff: undefined, channel: 'c' }))).toMatchObject({ ok: false, error: expect.stringContaining('no kickoff') })
    expect(await deliver('no-such-specialist')).toMatchObject({ ok: false, exitCode: 8, error: 'no such specialist: no-such-specialist' })
    expect(calls).toHaveLength(0)
  })

  test('kickoffFile is re-read on every spawn', async () => {
    const calls = fakeSpawn()
    const dir = mkdtempSync(join(tmpdir(), 'specialist-'))
    try {
      const file = join(dir, 'kick.md')
      writeFileSync(file, 'first kickoff\n')
      const name = specialist('thread-file', { kickoff: undefined, kickoffFile: file, channel: 'c' })
      await deliver(name)
      for (const s of sessions.splice(0)) registry.delete(s)
      for (const t of threads.splice(0)) registry.threadToSession.delete(t)
      writeFileSync(file, 'second kickoff\n')
      await deliver(name)
      expect(calls.map(c => c[0])).toEqual(['first kickoff', 'second kickoff'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the idempotency key blocks a repeat, and a failed delivery frees it', async () => {
    fakeSpawn()
    const name = specialist('thread-idem', { channel: 'c' })
    const key = `specialist-idem-${++n}`
    expect((await deliver(name, { idempotencyKey: key })).ok).toBe(true)
    expect(getIdempotencyEntry(key)?.status).toBe('completed')
    expect(await deliver(name, { idempotencyKey: key })).toMatchObject({ ok: false, exitCode: 2 })

    specialistDeps.threadExists = async () => false
    const failing = specialist('thread-fails')
    const k2 = `specialist-idem-${++n}`
    expect((await deliver(failing, { idempotencyKey: k2 })).ok).toBe(false)
    expect(getIdempotencyEntry(k2)).toBeUndefined()
  })

  test('a refill into a known thread is a respawn that names the last occupant and its model', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-hist')
    threads.push('thread-hist')
    threadRegistry.set('thread-hist', { threadId: 'thread-hist', sessionHistory: [{ tmuxName: 'comet', model: 'claude-opus-5-5' }] } as any)
    expect((await deliver(name)).ok).toBe(true)
    expect(calls[0][3]).toMatchObject({ existingThreadId: 'thread-hist', resurrectFrom: 'comet', model: 'claude-opus-5-5', trigger: `specialist:${name}`, name })
  })

  const cli = (action: string, name: string | undefined, extra: Record<string, unknown> = {}) => handleCLIRequest(req('specialist', { action, ...(name && { name }), ...extra }))

  const spawnAs = (name: string, extra: Record<string, unknown> = {}) => handleCLIRequest(req('spawn', { specialist: name, initiator: 'tester', idempotencyKey: `spawn-as-${++n}`, ...extra }))

  test('a specialist declared with only a channel opens its thread, named for it, on the first delivery', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    names.push(name)
    expect(await cli('set', name, { channel: 'chan-new', kickoff: 'be the slopbot' })).toMatchObject({ ok: true })
    expect(getSpecialist(name)!.threadId).toBeUndefined()
    expect((await deliver(name)).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe('chan-new')
    expect((calls[0][3] as any).existingThreadId).toBeUndefined()
    expect((calls[0][3] as any).name).toBe(name)
    expect(getSpecialist(name)!.threadId).toMatch(/^fresh-thread-/)
  })

  test('a hydra.toml specialist opens its thread in its home on the first delivery; only its pointer is written, and only --thread moves it', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    _setHydraConfigForTesting({
      operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
      people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
      specialists: { [name]: { id: name, workdir: '/srv/x', prompt: 'be the slopbot', home: '555', listens: [], allow: ['people'], sessions: 'shared', max: 20, was: [], access: 'operator' } },
    })
    try {
      expect((await deliver(name)).ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe('be the slopbot')
      expect(calls[0][1]).toBe('555')
      const first = getSpecialist(name)!.threadId
      expect(first).toMatch(/^fresh-thread-/)
      expect(await cli('set', name, { kickoff: 'something else' })).toMatchObject({ ok: false, error: expect.stringContaining('declared in hydra.toml') })
      expect(await cli('rm', name)).toMatchObject({ ok: false, error: expect.stringContaining('declared in hydra.toml') })
      // A live specialist doesn't move (G); once its session is gone, the pointer does.
      expect(await cli('set', name, { thread: 'thread-moved' })).toMatchObject({ ok: false, exitCode: 3 })
      registry.delete(registry.threadToSession.get(first!)!)
      expect(await cli('set', name, { thread: 'thread-moved' })).toMatchObject({ ok: true })
      expect(getSpecialist(name)).toMatchObject({ threadId: 'thread-moved', kickoff: 'be the slopbot', workdir: '/srv/x' })
    } finally {
      _setHydraConfigForTesting(undefined)
    }
  })

  test('specialist list shows each hydra.toml specialist\'s sessions mode, and max when it is per-conversation', async () => {
    const [a, b] = [`t-specialist-${++n}`, `t-specialist-${++n}`]
    const base = { workdir: '/srv/x', prompt: 'k', home: '555', listens: [], allow: ['people'], was: [], access: 'operator' as const }
    _setHydraConfigForTesting({
      operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
      people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
      specialists: {
        [a]: { id: a, ...base, sessions: 'shared', max: 20 },
        [b]: { id: b, ...base, sessions: 'per-conversation', max: 3 },
      },
    })
    try {
      const list = (await cli('list', undefined)).data as Record<string, unknown>[]
      const [sa, sb] = [list.find(s => s.name === a)!, list.find(s => s.name === b)!]
      expect(sa.sessions).toBe('shared')
      expect(sa).not.toHaveProperty('max')
      expect(sb).toMatchObject({ sessions: 'per-conversation', max: 3 })
      expect((await cli('show', b)).data).toMatchObject({ sessions: 'per-conversation', max: 3 })
    } finally {
      _setHydraConfigForTesting(undefined)
    }
  })

  test('specialist show and list print each hydra.toml specialist\'s effective access, with its tools and servers when it is workdir', async () => {
    const [a, b] = [`t-specialist-${++n}`, `t-specialist-${++n}`]
    const base = { workdir: '/srv/x', prompt: 'k', home: '555', listens: [], allow: ['people'], was: [], sessions: 'shared' as const, max: 20 }
    _setHydraConfigForTesting({
      operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
      people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
      specialists: {
        [a]: { id: a, ...base, access: 'operator' },
        [b]: { id: b, ...base, access: 'workdir', tools: ['Read'], mcp: ['datadog'] },
      },
    })
    try {
      const list = (await cli('list', undefined)).data as Record<string, unknown>[]
      expect(list.find(s => s.name === a)).toMatchObject({ access: 'operator' })
      expect(list.find(s => s.name === a)).not.toHaveProperty('tools')
      expect((await cli('show', b)).data).toMatchObject({ access: 'workdir', tools: ['Read'], mcp: ['datadog'] })
    } finally {
      _setHydraConfigForTesting(undefined)
    }
  })

  test('a hydra.toml specialist\'s fresh session starts in its workdir, on a new thread and on the respawn tier alike', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    _setHydraConfigForTesting({
      operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
      people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
      specialists: { [name]: { id: name, workdir: '/srv/ops', prompt: 'be the slopbot', home: '555', listens: [], allow: ['people'], sessions: 'shared', max: 20, was: [], access: 'operator' } },
    })
    try {
      expect((await deliver(name)).ok).toBe(true)
      expect((calls[0][3] as any).cwd).toBe('/srv/ops')
      // Its session dies; the thread is still there, so the refill respawns into it, in the workdir again.
      const thread = getSpecialist(name)!.threadId!
      threadRegistry.set(thread, { threadId: thread, sessionHistory: [] } as any)
      registry.delete(registry.threadToSession.get(thread)!)
      expect((await deliver(name, { idempotencyKey: `specialist-k-${++n}` })).ok).toBe(true)
      expect(calls).toHaveLength(2)
      expect((calls[1][3] as any)).toMatchObject({ existingThreadId: thread, cwd: '/srv/ops' })
    } finally {
      _setHydraConfigForTesting(undefined)
    }
  })

  test('a new specialist needs a channel or a thread', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    expect(await cli('set', name, { kickoff: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('--channel') })
    expect(getSpecialist(name)).toBeUndefined()
  })

  test('spawn --specialist fills a vacant specialist; a second spawn, concurrent or later, refuses naming the occupant', async () => {
    const calls = fakeSpawn()
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-up', kickoff: 'be the slopbot' })
    const results = await Promise.all([spawnAs(name), spawnAs(name)]) as any[]
    expect(calls).toHaveLength(1) // one spawn, however many callers
    const ok = results.find(r => r.ok)
    const refused = results.find(r => !r.ok)
    const filledBy: string = ok.data.name // read before toMatchObject, which leaves its matchers in the object under Bun
    expect(ok.data.threadId).toBe(getSpecialist(name)!.threadId)
    expect(refused.exitCode).toBe(3)
    expect(refused.error).toContain('already filled by')
    expect(refused.error).toContain(filledBy)
    expect(await spawnAs(name)).toMatchObject({ ok: false, exitCode: 3 })
    expect(calls).toHaveLength(1)
    expect((calls[0][3] as any).initiator).toBe('tester')
    expect((calls[0][3] as any).name).toBe(name)
  })

  test('spawn --specialist: an unknown name, flags the declaration owns, a repeated key, and the refill back-off', async () => {
    const calls = fakeSpawn()
    expect(await spawnAs('no-such-one')).toMatchObject({ ok: false, exitCode: 8, error: 'no such specialist: no-such-one' })
    const sid = occupy('thread-spawn-live')
    const live = specialist('thread-spawn-live')
    const filled = await spawnAs(live) as any
    expect(filled).toMatchObject({ ok: false, exitCode: 3 })
    expect(filled.error).toContain(`${sid}-tmux`)
    expect(calls).toHaveLength(0)

    const e = await spawnAs(live, { prompt: 'do x', model: 'm', channel: 'c' }) as any
    expect(e.ok).toBe(false)
    expect(e.error).toContain('prompt, channel, model')

    const key = `spawn-key-${++n}`
    const vacant = specialist('thread-spawn-vacant', { channel: 'c' })
    expect((await spawnAs(vacant, { idempotencyKey: key }) as any).ok).toBe(true)
    expect(await spawnAs(vacant, { idempotencyKey: key })).toMatchObject({ ok: false, exitCode: 2 })

    let attempts = 0
    setSpawn(async () => { attempts++; throw new Error('tmux exploded') })
    const bad = specialist('thread-spawn-bad', { channel: 'c' })
    expect(await deliver(bad)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: tmux exploded') })
    expect(await deliver(bad)).toMatchObject({ ok: false, exitCode: 6 }) // an automatic refill waits out the back-off
    expect(await spawnAs(bad)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: tmux exploded') }) // an operator's spawn tries now
    expect(attempts).toBe(2)
    expect(((await cli('show', bad)) as any).data.refillBackoff.failures).toBe(2) // and its failure counts
    fakeSpawn()
    expect((await spawnAs(bad) as any).ok).toBe(true)
    expect(((await cli('show', bad)) as any).data.refillBackoff).toBeUndefined() // a manual success clears it
  })

  test('show and list say who fills the specialist and whether refills are backing off', async () => {
    const sid = occupy('thread-show')
    const filled = specialist('thread-show')
    expect(await cli('show', filled)).toMatchObject({ ok: true, data: { name: filled, occupant: { session: `${sid}-tmux`, connected: false } } })
    setSpawn(async () => { throw new Error('tmux exploded') })
    const bad = specialist('thread-show-bad', { channel: 'c' })
    await deliver(bad)
    const listed = (await cli('list', undefined) as any).data.find((s: any) => s.name === bad)
    expect(listed.occupant).toBeUndefined()
    expect(listed.refillBackoff).toMatchObject({ failures: 1 })
  })

  test('a set or rm that lands while the spawn is running is not undone when the new thread is recorded', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-race', kickoff: 'old kickoff' })
    setSpawn(async () => {
      await Bun.sleep(30)
      const threadId = `fresh-thread-${++n}`
      const sessionId = occupy(threadId)
      return { name: `${sessionId}-tmux`, sessionId, threadId, url: '' }
    })
    const up = spawnAs(name)
    await Bun.sleep(5)
    await cli('set', name, { kickoff: 'new kickoff', model: 'm-2' }) // lands mid-spawn
    expect(await up).toMatchObject({ ok: true })
    expect(getSpecialist(name)).toMatchObject({ kickoff: 'new kickoff', model: 'm-2' })
    expect(getSpecialist(name)!.threadId).toMatch(/^fresh-thread-/) // and the new thread is still recorded, on top of the newer declaration

    const gone = `t-specialist-${++n}`
    names.push(gone)
    await cli('set', gone, { channel: 'chan-race', kickoff: 'k' })
    const up2 = spawnAs(gone)
    await Bun.sleep(5)
    await cli('rm', gone)
    await up2
    expect(getSpecialist(gone)).toBeUndefined() // a removed specialist stays removed
  })

  test('G: a set --thread waits out a running spawn, then refuses to move a live specialist (exit 3); once it is killed, the move lands', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    await cli('set', name, { channel: 'chan-repoint', kickoff: 'k' })
    let started = ''
    setSpawn(async () => {
      await Bun.sleep(30)
      started = `fresh-thread-${++n}`
      const sessionId = occupy(started)
      return { name: `${sessionId}-tmux`, sessionId, threadId: started, url: '' }
    })
    const up = spawnAs(name)
    await Bun.sleep(5)
    const moved = await cli('set', name, { thread: 'thread-chosen-by-operator' }) as any // queued behind the spawn on the specialist's lock
    expect(await up).toMatchObject({ ok: true })
    expect(moved).toMatchObject({ ok: false, exitCode: 3, error: `${name}: is live in ${started}; hydra kill ${name} first` })
    expect(getSpecialist(name)!.threadId).toBe(started) // one session, one name: the pointer did not move under it

    registry.deleteThread(started)
    expect(await cli('set', name, { thread: 'thread-chosen-by-operator' })).toMatchObject({ ok: true })
    expect(getSpecialist(name)!.threadId).toBe('thread-chosen-by-operator')
  })

  test('a name needs a letter: an all-digit one reads as a thread id', async () => {
    expect(await cli('set', '12345', { channel: 'c', kickoff: 'k' })).toMatchObject({ ok: false, error: expect.stringContaining('needs a letter') })
    expect(getSpecialist('12345')).toBeUndefined()
  })

  test('a live session holding the specialist\'s name elsewhere makes a fill refuse (exit 3, naming it) without counting as a failed refill', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-own', { channel: 'c' })
    const strayId = occupy('thread-elsewhere', { tmuxName: name })
    for (const attempt of [1, 2]) {
      const res = await deliver(name) as any
      expect(res.ok).toBe(false)
      expect(res.exitCode).toBe(3) // not 6: this is not a back-off
      expect(res.error).toContain(`hydra specialist set ${name} --thread thread-elsewhere`)
      void attempt
    }
    expect(getBackoff(name)).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(registry.get(strayId)).toBeDefined()
    // An operator's keyed spawn refused for the stray started nothing, so its key does not block a retry.
    const k = `stray-key-${++n}`
    expect(await spawnAs(name, { idempotencyKey: k })).toMatchObject({ ok: false, exitCode: 3 })
    expect(getIdempotencyEntry(k)).toMatchObject({ status: 'failed' })
    expect(await spawnAs(name, { idempotencyKey: k })).toMatchObject({ ok: false, exitCode: 3 }) // refused again, not "already exists" (2)
    // The fix it names works: thread-own is vacant, so the move is not the live move G refuses.
    expect(await cli('set', name, { thread: 'thread-elsewhere' })).toMatchObject({ ok: true })
    expect(await deliver(name)).toMatchObject({ ok: true, data: { sessionId: strayId, spawned: false } })
  })

  test('a thread Discord no longer has moves the specialist to its channel; without a channel it fails', async () => {
    const calls = fakeSpawn()
    specialistDeps.threadExists = async () => false
    threads.push('thread-del', 'thread-del2')
    threadRegistry.set('thread-del', { threadId: 'thread-del', sessionHistory: [] } as any)
    threadRegistry.set('thread-del2', { threadId: 'thread-del2', sessionHistory: [] } as any)
    const moved = specialist('thread-del', { channel: 'chan-9' })
    const res = await deliver(moved)
    expect(res.ok).toBe(true)
    expect((calls[0][3] as any).existingThreadId).toBeUndefined()
    expect(calls[0][1]).toBe('chan-9')
    expect(getSpecialist(moved)!.threadId).not.toBe('thread-del')
    expect(await deliver(specialist('thread-del2'))).toMatchObject({ ok: false, error: expect.stringContaining('gone') })
  })

  test('failed refills back off per specialist, then try again once the wait passes', async () => {
    let now = 1_000_000
    backoffClock.now = () => now
    let attempts = 0
    setSpawn(async () => { attempts++; throw new Error('tmux exploded') })
    const name = specialist('thread-backoff', { channel: 'c' })
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: tmux exploded') })
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('not retrying until') })
    expect(attempts).toBe(1)
    now += SPAWN_BACKOFF_BASE_MS + 1
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: tmux exploded') })
    expect(attempts).toBe(2)
    now += SPAWN_BACKOFF_BASE_MS * 2 + 1 // the second failure doubled the wait
    fakeSpawn()
    expect((await deliver(name)).ok).toBe(true)
  })

  test('an occupant with no bridge past the grace window is orphaned: a failure the caller keeps owing', async () => {
    _setDaemonStartedAtForTesting(0)
    const calls = fakeSpawn()
    occupy('thread-orphan', { createdAt: Date.now() - 10 * 60_000 })
    const name = specialist('thread-orphan')
    const k = `specialist-orphan-${++n}`
    expect(await deliver(name, { idempotencyKey: k })).toMatchObject({ ok: false, exitCode: 4, error: expect.stringContaining('orphaned') })
    expect(getIdempotencyEntry(k)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('an occupant stamped dead whose tmux still runs is orphaned: exit 4, never respawned over', async () => {
    _setDaemonStartedAtForTesting(0)
    const calls = fakeSpawn()
    occupy('thread-stamped', { deadAt: Date.now() })
    expect(await deliver(specialist('thread-stamped'))).toMatchObject({ ok: false, exitCode: 4, error: expect.stringContaining('orphaned') })
    expect(calls).toHaveLength(0)
  })

  test('an old occupant with no bridge right after a daemon restart is booting, not orphaned', async () => {
    _setDaemonStartedAtForTesting(Date.now())
    occupy('thread-restarted', { createdAt: Date.now() - 10 * 60_000 })
    expect(await deliver(specialist('thread-restarted'))).toMatchObject({ ok: true, data: { spawned: false } })
  })

  test('a freshly booting occupant (no bridge yet, inside the grace window) accepts the queued message', async () => {
    occupy('thread-booting')
    const res = await deliver(specialist('thread-booting'))
    expect(res).toMatchObject({ ok: true, data: { spawned: false } })
  })

  test('queued behind an occupant that died during delivery is a failure', async () => {
    let alive = true
    occupy('thread-dies', { adapter: fakeAdapter({ isAlive: () => alive, deliver: async () => { alive = false; return { status: 'accepted', via: 'queued' } } }) })
    transport.set(sessions[sessions.length - 1], { sessionId: sessions[sessions.length - 1], socket: { destroyed: false, write: () => true } } as any)
    // bridge present => not "queued" by the outcome mapping; use a booting session instead
    transport.bridges.delete(sessions[sessions.length - 1])
    const res = await deliver(specialist('thread-dies'))
    expect(res).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('died') })
  })

  test('the delivery carries the caller\'s source label; an oversized message is refused permanently', async () => {
    const seen: any[] = []
    occupy('thread-src', { adapter: fakeAdapter({ isAlive: () => true, deliver: async (_i: unknown, m: unknown) => { seen.push(m); return { status: 'accepted' } } }) })
    const name = specialist('thread-src')
    const { deliverToSpecialist } = await import('../specialist-deliver.js')
    expect((await deliverToSpecialist({ specialist: name, message: 'hi', source: 'slack-watch', initiator: 'slack-watch' })).ok).toBe(true)
    expect(seen[0].meta).toMatchObject({ source: 'slack-watch', specialist: name, initiator: 'slack-watch' })
    const big = await deliverToSpecialist({ specialist: name, message: 'x'.repeat(10_001) })
    expect(big).toMatchObject({ ok: false, permanent: true })
    expect(seen).toHaveLength(1)
  })

  test('--specialist excludes --thread/--session', async () => {
    const res = await deliver(specialist('t'), { thread: 'x' })
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('drop --thread/--session') })
  })

  test('specialist set merges: re-pointing the thread keeps the kickoff; rm and list agree', async () => {
    const name = `t-specialist-${++n}`
    names.push(name)
    const first = await handleCLIRequest(req('specialist', { action: 'set', name, thread: 't1', channel: 'c1', kickoff: 'k' }))
    expect(first).toMatchObject({ ok: true, data: { name, threadId: 't1', channel: 'c1', kickoff: 'k' } })
    const second = await handleCLIRequest(req('specialist', { action: 'set', name, thread: 't2' }))
    expect(second).toMatchObject({ ok: true, data: { threadId: 't2', channel: 'c1', kickoff: 'k' } })
    expect(listSpecialists().some(([s]) => s === name)).toBe(true)
    expect(await handleCLIRequest(req('specialist', { action: 'rm', name }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('specialist', { action: 'show', name }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('specialist', { action: 'set', name: 'Bad Name', thread: 't' }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('specialist', { action: 'set', name: `t-specialist-new-${n}` }))).toMatchObject({ ok: false, error: expect.stringContaining('--thread') })
  })
  // ── reviveThread: the refill is the cascade (spec §2, §5; flows B, D, E) ──

  test('a refill resumes the dead occupant first; the kickoff is only the respawn prompt, so a broken one does not stop it', async () => {
    const calls = fakeSpawn()
    const resumed: any[] = []
    const { spawn } = calls
    _setRecoveryDeps({
      doSpawnSession: spawn as any, tryRespawn: async () => { throw new Error('the respawn tier must not run') },
      tryResume: (async (dead: any) => {
        resumed.push(dead)
        return spawn('resume', undefined, undefined, { existingThreadId: dead.threadId, name: dead.name })
      }) as any,
    })
    occupy('thread-resume', { claudeSessionId: 'C-1', adapter: fakeAdapter({ isAlive: () => false }), tmuxName: 'old-tmux' })
    const name = specialist('thread-resume', { kickoff: undefined, kickoffFile: '/nonexistent/kickoff.md' })
    const res = await deliver(name)
    expect(res).toMatchObject({ ok: true, data: { spawned: true, threadId: 'thread-resume' } })
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ claudeSessionId: 'C-1', threadId: 'thread-resume', name })
    expect(calls.map(c => c[0])).toEqual(['resume'])
  })

  test('a refill keeps the dead occupant\'s worktree on every tier', async () => {
    const calls = fakeSpawn()
    const wt = mkdtempSync(join(tmpdir(), 'specialist-wt-'))
    try {
      occupy('thread-wt', { adapter: fakeAdapter({ isAlive: () => false }), worktreeRepo: '/repo', worktreePath: wt, worktreeBranch: 'wt/ops-old' })
      const res = await deliver(specialist('thread-wt'))
      expect(res.ok).toBe(true)
      expect(calls[0][3]).toMatchObject({ preserveWorktree: true, reuseWorktree: { repo: '/repo', path: wt, branch: 'wt/ops-old' } })
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })

  test('D: twenty sends to a vacant specialist start one session and all land on it', async () => {
    const calls = fakeSpawn()
    const name = specialist('thread-burst', { channel: 'c' })
    const all = await Promise.all(Array.from({ length: 20 }, () => deliver(name)))
    expect(all.every(r => r.ok)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(new Set(all.map(r => (r.data as any).sessionId)).size).toBe(1)
  })

  test('E: the back-off survives a daemon restart, says when and why, and an operator spawn still tries', async () => {
    let attempts = 0
    setSpawn(async () => { attempts++; throw new Error('kickoff file not found') })
    const name = specialist('thread-restart', { channel: 'c' })
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('start failed: kickoff file not found') })
    _reloadBackoff() // what a restart does
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringMatching(/not retrying until \d\d:\d\d:\d\d \(1 failure\); last: kickoff file not found/) })
    expect(attempts).toBe(1)
    expect(((await cli('show', name)) as any).data.refillBackoff).toMatchObject({ failures: 1, lastError: 'kickoff file not found' })
  })

  test('a back-off is removed by specialist rm, and one whose wait ended over 7 days ago is dropped at load', async () => {
    setSpawn(async () => { throw new Error('boom') })
    const removed = specialist('thread-rm', { channel: 'c' })
    await deliver(removed)
    expect(getBackoff(removed)).toBeDefined()
    await cli('rm', removed)
    expect(getBackoff(removed)).toBeUndefined()

    const stale = specialist('thread-stale', { channel: 'c' })
    await deliver(stale)
    expect(getBackoff(stale)).toBeDefined()
    _reloadBackoff(getBackoff(stale)!.nextAt + BACKOFF_STALE_MS + 1)
    expect(getBackoff(stale)).toBeUndefined()
  })

  test('a refill of a specialist whose session had a wt/<name> worktree can still claim its name', async () => {
    const calls = fakeSpawn()
    const { spawn } = calls
    // The claim doSpawnSession makes: the record it replaces, and dead same-named records, do not count.
    setSpawn(async (...args: any[]) => {
      registry.claimSessionName(args[3].name, registry.getByThread(args[3].existingThreadId), s => !s.adapter.isAlive(s))
      return spawn(...args)
    })
    const wt = mkdtempSync(join(tmpdir(), 'specialist-wt-'))
    try {
      const name = 'opswtown' // no dash: a branch's base name is the text before its first one
      names.push(name)
      setSpecialist(name, { threadId: 'thread-wt-own', kickoff: 'be the slopbot' })
      occupy('thread-wt-own', { tmuxName: `${name}-old`, adapter: fakeAdapter({ isAlive: () => false }), worktreeRepo: '/repo', worktreePath: wt, worktreeBranch: `wt/${name}` })
      expect(await deliver(name)).toMatchObject({ ok: true, data: { spawned: true } })
      expect(registry.reservedNames.has(name)).toBe(false)
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })

  test('M2: a specialist moved to a new thread keeps its dead session\'s worktree', async () => {
    const calls = fakeSpawn()
    specialistDeps.threadExists = async () => false
    const wt = mkdtempSync(join(tmpdir(), 'specialist-wt-'))
    try {
      const name = specialist('thread-m2', { channel: 'c' })
      occupy('thread-m2', { tmuxName: name, adapter: fakeAdapter({ isAlive: () => false }), worktreeRepo: '/repo', worktreePath: wt, worktreeBranch: `wt/${name}` })
      expect((await deliver(name)).ok).toBe(true)
      expect(calls[0][1]).toBe('c') // a new thread, in the specialist's channel
      expect(calls[0][3]).toMatchObject({ preserveWorktree: true, reuseWorktree: { path: wt } })
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })

  test('L3: while a specialist backs off, a delivery never asks the platform about its thread', async () => {
    setSpawn(async () => { throw new Error('boom') })
    let asked = 0
    specialistDeps.threadExists = async () => { asked++; return true }
    const name = specialist('thread-l3a', { channel: 'c' })
    await deliver(name)
    asked = 0
    expect(await deliver(name)).toMatchObject({ ok: false, exitCode: 6, error: expect.stringContaining('not retrying until') })
    expect(asked).toBe(0)
  })

  test('L3: a resume typed in a specialist\'s thread clears its back-off when it succeeds', async () => {
    setSpawn(async () => { throw new Error('boom') })
    const name = specialist('thread-l3b', { channel: 'c' })
    threadRegistry.threads.set('thread-l3b', { threadId: 'thread-l3b', topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [] } as any)
    threads.push('thread-l3b')
    await deliver(name)
    expect(getBackoff(name)).toBeDefined()
    fakeSpawn()
    await handleResumeIntercept({ id: `l3-${++n}`, channelId: 'thread-l3b', isThread: true, effectiveThreadId: 'thread-l3b' })
    expect(getBackoff(name)).toBeUndefined()
  })

  test('a crashed occupant holding the name in a gone thread does not block its own refill', async () => {
    const name = specialist('thread-crashed', { channel: 'c' })
    occupy('thread-crashed', { tmuxName: name, adapter: fakeAdapter({ isAlive: () => false }) })
    expect(registry.claimSessionName(name, undefined, s => !s.adapter.isAlive(s))).toBe(name)
    const live = specialist('thread-live-holder')
    occupy('thread-live-holder', { tmuxName: live })
    expect(() => registry.claimSessionName(live, undefined, s => !s.adapter.isAlive(s))).toThrow(/already in use/)
  })
})

describe('withTargetLock', () => {
  test('runs tasks for one specialist in order, even when an earlier one throws', async () => {
    const order: string[] = []
    const a = withTargetLock('lock-a', async () => { await Bun.sleep(20); order.push('a1') })
    const b = withTargetLock('lock-a', async () => { order.push('a2'); throw new Error('boom') })
    const c = withTargetLock('lock-a', async () => { order.push('a3') })
    const other = withTargetLock('lock-b', async () => { order.push('b') })
    await Promise.allSettled([a, b, c, other])
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a1'))
    expect(order.filter(x => x.startsWith('a'))).toEqual(['a1', 'a2', 'a3'])
  })
})
