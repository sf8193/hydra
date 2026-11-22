// A restricted specialist is the boolean `restricted` on its launch policy, stored as it is: no `access` on the policy, no session type
// `scoped`. This file pins that storage (sessions.json, threads.json), the bridge's own declaration, and the fail-closed reads.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../infra/config.js'
import { SessionRegistry, ThreadRegistry, type SessionInfo } from '../../sessions/registry.js'
import { _setTmuxForTesting } from '../../infra/tmux.js'
import { isPlainWorker, isRestricted } from '../../shared/policy-record.js'
import { confinementIdFor, deliveryRefusal, OPERATOR_POLICY_ID, policyIdFor, policyProblem, type LaunchPolicy } from '../../app/restricted.js'
import { isToolAllowed, noteDeclaredRestrictions } from '../../sessions/tool-surface.js'
import { registry } from '../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'

process.stderr.write = (() => true) as any

const SID = '11111111-1111-4111-8111-111111111111'
const servers = [{ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs'] }]
const restrictedId = policyIdFor('/work/ops', ['Read', 'Grep'], servers)
const writes = { workdir: '/work/gem', denyCommands: ['rm'], cannotRead: ['/secret'], servers: [] }

const restrictedPolicy = (): LaunchPolicy => ({ specialist: 'ops', restricted: true, workdir: '/work/ops', tools: ['Read', 'Grep'], servers, id: restrictedId })
const operatorPolicy = (): LaunchPolicy => ({ specialist: 'desk', restricted: false, id: OPERATOR_POLICY_ID })
const writeConfinedPolicy = (): LaunchPolicy => ({ specialist: 'gem', restricted: false, canOnlyWriteTo: writes, id: confinementIdFor(writes) })

describe('records on disk hold the boolean and nothing older', () => {
  const sessionsFile = join(STATE_DIR, 'sessions.json')
  const threadsFile = join(STATE_DIR, 'threads.json')
  let savedSessions: string | null, savedThreads: string | null
  beforeEach(() => {
    savedSessions = existsSync(sessionsFile) ? readFileSync(sessionsFile, 'utf8') : null
    savedThreads = existsSync(threadsFile) ? readFileSync(threadsFile, 'utf8') : null
    // Every tmux call times out: no tmux is touched and each record stays as saved.
    _setTmuxForTesting({ exec: (() => { throw Object.assign(new Error('tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) as any })
  })
  afterEach(() => {
    for (const [f, saved] of [[sessionsFile, savedSessions], [threadsFile, savedThreads]] as const) { if (saved === null) rmSync(f, { force: true }); else writeFileSync(f, saved) }
  })

  const rec = (id: string, policy: object, extra: object = {}) => ({ sessionId: id, tmuxName: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude', sessionType: 'thread_owner', policy, ...extra }) as unknown as SessionInfo
  const shapes = { restricted: restrictedPolicy, operator: operatorPolicy, 'write-confined': writeConfinedPolicy } as const

  test.each(Object.entries(shapes))('%s: sessions.json and threads.json carry the policy as it is, and it loads back unchanged', (name, policy) => {
    const reg = new SessionRegistry()
    reg.set(`rt-${name}`, rec(`rt-${name}`, policy(), { verified: true }))
    reg.persist()
    const stored = JSON.parse(readFileSync(sessionsFile, 'utf8')).find((r: any) => r.sessionId === `rt-${name}`)
    expect(stored.sessionType).toBe('thread_owner')            // a restricted session is stored as the owner it is
    expect(stored.policy).toEqual(policy())                    // no `access` added
    expect(new SessionRegistry().get(`rt-${name}`)!.policy).toEqual(policy())
    expect(policyProblem(stored.policy)).toBeUndefined()

    const threads = new ThreadRegistry()
    ;(threads as any).threads.set('th-rt', { threadId: 'th-rt', topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [{ sessionId: SID, tmuxName: 'x', originType: 'spawn', startedAt: 1, messageCount: 0, policy: policy() }] })
    threads.persist()
    const onDisk = JSON.parse(readFileSync(threadsFile, 'utf8')).find((t: any) => t.threadId === 'th-rt').sessionHistory[0]
    expect(onDisk.policy).toEqual(policy())
    const booted = new ThreadRegistry()
    booted.boot(new SessionRegistry())
    expect(booted.get('th-rt')!.sessionHistory[0].policy).toEqual(policy())
  })

  test('the old forms are no longer read: a record holding `access` and no `restricted` is a policy that cannot be read, and fails closed', () => {
    const old = { specialist: 'ops', access: 'workdir', workdir: '/work/ops', tools: ['Read', 'Grep'], servers, id: restrictedId }
    expect(isRestricted({ policy: old as {} })).toBe(true)
    expect(policyProblem(old)).toBe('its restricted is undefined')
  })

  // Delivery describes a stored policy without validating it: an old operator record has no `restricted`, so it is restricted with no folder, tools or servers.
  test('an old operator record, verified: delivery refuses it with its description, never throws', () => {
    writeFileSync(sessionsFile, JSON.stringify([rec('old-op', { specialist: 'ops', access: 'operator', id: OPERATOR_POLICY_ID }, { verified: true })]))
    _setHydraConfigForTesting({ connectors: {}, gateways: {}, slackApps: {}, people: {}, places: {}, schedules: {}, rules: [],
      specialists: { ops: { id: 'ops', workdir: '/work/ops', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: true, tools: ['Read'], mcpServerNames: [] } } })
    try {
      expect(deliveryRefusal(new SessionRegistry().get('old-op')!)).toContain('restricted = true (folder ?')
    } finally { _setHydraConfigForTesting(undefined) }
  })
})

describe('a bridge declares itself restricted by HYDRA_RESTRICTED, and no other way', () => {
  test('restricted: true narrows an id the registry does not know', () => {
    const id = `ghost-${Math.random().toString(36).slice(2, 7)}`
    expect(isToolAllowed(id, 'spawn_session')).toBe(true)
    noteDeclaredRestrictions(id, { restricted: true })
    expect(isToolAllowed(id, 'spawn_session')).toBe(false)
    expect(isToolAllowed(id, 'reply')).toBe(true)
  })
  test('the type `scoped` no longer narrows; restricted: false and another type narrow nothing', () => {
    noteDeclaredRestrictions('ghost-old-type', { sessionType: 'scoped' } as any)
    expect(isToolAllowed('ghost-old-type', 'spawn_session')).toBe(true)
    noteDeclaredRestrictions('ghost-plain', { restricted: false })
    expect(isToolAllowed('ghost-plain', 'spawn_session')).toBe(true)
  })
})

describe('the tool gate fails closed on a stored policy it cannot read', () => {
  test.each([
    ['restricted: true', true, true],
    ['restricted: false', false, false],
    ['restricted missing', undefined, true],
    ['restricted a string', 'false', true],
    ['restricted null', null, true],
  ])('%s', (_n, value, closed) => {
    const id = `gate-${Math.random().toString(36).slice(2, 7)}`
    registry.set(id, { sessionId: id, tmuxName: id, threadId: `th-${id}`, topic: '', createdAt: 1, lastActive: 1, listening: false, engine: 'claude', sessionType: 'thread_owner', policy: { specialist: 'x', id: 'x', ...(value !== undefined && { restricted: value }) } } as any)
    try { expect(isToolAllowed(id, 'spawn_session')).toBe(!closed) } finally { registry.delete(id) }
  })
  test('a record with no policy is a plain session', () => {
    registry.set('gate-none', { sessionId: 'gate-none', tmuxName: 'gate-none', threadId: 'th-gn', topic: '', createdAt: 1, lastActive: 1, listening: false, engine: 'claude', sessionType: 'thread_owner' } as any)
    try { expect(isToolAllowed('gate-none', 'spawn_session')).toBe(true) } finally { registry.delete('gate-none') }
  })
})

describe('one predicate, fail closed', () => {
  test.each([
    ['restricted: true', { restricted: true }, true],
    ['restricted: false', { restricted: false }, false],
    ['unset', {}, true],
    ["a stored `access` and no `restricted`", { access: 'workdir' } as {}, true],
    ['a string', { restricted: 'false' }, true],
    ['null', { restricted: null }, true],
  ] as const)('a stored policy with %s', (_n, policy, closed) => {
    expect(isRestricted({ policy })).toBe(closed)
    expect(isPlainWorker({ sessionType: 'thread_owner', policy })).toBe(!closed)
  })
  test('no policy at all is a plain session', () => {
    expect(isRestricted({})).toBe(false)
    expect(isPlainWorker({ sessionType: 'thread_owner' })).toBe(true)
  })
})
