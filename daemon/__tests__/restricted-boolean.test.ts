// A restricted specialist is the boolean `restricted` on its launch policy. Before it, the same fact was stored two ways: the policy's
// `access` (`workdir` | `operator`) and the session type `scoped`. Each old form must still load, and mean what it meant.
//
//   1. Records on disk (sessions.json, threads.json): read by the loader, then only the boolean is seen.
//   2. A running session's bridge declaring HYDRA_SESSION_TYPE=scoped (bridge-flap.test.ts covers the registration; here the tool surface).
//   3. The folders `<state>/scoped` and `<temp>/hydra-scoped` of a session launched before: removed by its end, never written.
//   4. The toml has no old form to read: `access` was dropped at #700 and stays refused (config/__tests__/drop-old-names.test.ts).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { SessionRegistry, ThreadRegistry, type SessionInfo } from '../sessions.js'
import { _setTmuxForTesting } from '../tmux.js'
import { isPlainWorker, isRestricted, readStoredPolicy, readStoredSession } from '../policy-record.js'
import { confinementIdFor, OPERATOR_POLICY_ID, policyIdFor, policyProblem, unverified, type LaunchPolicy } from '../restricted.js'
import { getToolsForSession, isRestrictedSession, isToolAllowed, noteDeclaredRestrictions } from '../tool-surface.js'
import { registry } from '../sessions.js'
import { BASE_TOOLS } from '../../shared/constants.js'
import { legacyRestrictedDir, legacyServerTmpRoot, makeServerTmpDirs, removeRestrictedFiles, restrictedDir, serverTmpRoot, writeRestrictedFiles } from '../restricted-files.js'

process.stderr.write = (() => true) as any

const SID = '11111111-1111-4111-8111-111111111111'
const servers = [{ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs'] }]
const confinedId = policyIdFor('/work/ops', ['Read', 'Grep'], servers)
const writes = { workdir: '/work/gem', denyCommands: ['rm'], cannotRead: ['/secret'], servers: [] }

/** A policy exactly as the code before the boolean stored it. */
const oldWorkdir = () => ({ specialist: 'ops', access: 'workdir', workdir: '/work/ops', tools: ['Read', 'Grep'], servers, id: confinedId })
const oldOperator = () => ({ specialist: 'desk', access: 'operator', id: OPERATOR_POLICY_ID })
const oldWriteConfined = () => ({ specialist: 'gem', access: 'operator', canOnlyWriteTo: writes, id: confinementIdFor(writes) })

describe('an old stored policy is read as the boolean', () => {
  test.each([
    ['access: workdir', oldWorkdir(), true],
    ['access: operator', oldOperator(), false],
    ['access: operator with can_only_write_to', oldWriteConfined(), false],
  ] as const)('%s', (_name, stored, restricted) => {
    const id = (stored as { id: string }).id
    readStoredPolicy(stored)
    expect(stored).not.toHaveProperty('access')
    expect(stored).toMatchObject({ restricted, id })   // the id is a hash of the facts: it must not move, or every running session would drift
    expect(policyProblem(stored)).toBeUndefined()      // and it still validates
  })

  test('a policy already holding the boolean is left as it is, and an unknown `access` is dropped without guessing', () => {
    const fresh: LaunchPolicy = { specialist: 'ops', restricted: true, workdir: '/work/ops', tools: ['Read', 'Grep'], servers, id: confinedId }
    const copy = structuredClone(fresh)
    readStoredPolicy(fresh)
    expect(fresh).toEqual(copy)
    const odd: Record<string, unknown> = { specialist: 'ops', access: 'root', id: 'x' }
    readStoredPolicy(odd)
    expect(odd).toEqual({ specialist: 'ops', id: 'x' })
    expect(policyProblem(odd)).toBe('its restricted is undefined')   // refused to read, as `its access is "root"` was
  })
})

describe('an old stored session is read as the boolean', () => {
  test('type scoped with its workdir policy: a thread owner whose policy says restricted', () => {
    const rec: any = { sessionType: 'scoped', specialist: 'ops', policy: oldWorkdir() }
    readStoredSession(rec)
    expect(rec.sessionType).toBe('thread_owner')
    expect(rec.policy).toMatchObject({ restricted: true, id: confinedId })
    expect(policyProblem(rec.policy)).toBeUndefined()
    expect(isRestricted(rec)).toBe(true)
    expect(isPlainWorker(rec)).toBe(false)
  })

  test('type scoped with no policy, or an operator one: still restricted, and the policy cannot be read, so nothing starts under it', () => {
    for (const policy of [undefined, oldOperator()]) {
      const rec: any = { sessionType: 'scoped', specialist: 'ops', ...(policy && { policy }) }
      readStoredSession(rec)
      expect(isRestricted(rec)).toBe(true)
      expect(policyProblem(rec.policy)).toBeDefined()
    }
  })

  test('a record that was never restricted is untouched, and the read is idempotent', () => {
    const plain: any = { sessionType: 'thread_owner', policy: oldOperator() }
    readStoredSession(plain); readStoredSession(plain)
    expect(plain).toEqual({ sessionType: 'thread_owner', policy: { specialist: 'desk', restricted: false, id: OPERATOR_POLICY_ID } })
    expect(isPlainWorker(plain)).toBe(true)
    const none: any = { sessionType: 'thread_guest' }
    readStoredSession(none)
    expect(none).toEqual({ sessionType: 'thread_guest' })
  })

  // Every old record shape the code could have written, then the new one: what the old code said (the oracle) and what the new says after the read.
  // The old code answered "restricted tools?" by the type alone, and "confined launch / awaiting verification?" by type, access or can_only_write_to.
  test('table: for every old combination, the new answer is the old one (and stricter only where the old record contradicted itself)', () => {
    const types = ['thread_owner', 'thread_guest', 'master_orchestrator', 'scoped']
    const accesses = [undefined, 'workdir', 'operator'] as const
    let rows = 0, stricter = 0
    for (const type of types) for (const access of accesses) for (const confinedWrites of [false, true]) for (const verified of [false, true]) {
      const policy = access === undefined ? undefined : { specialist: 's', access, id: 'x', ...(access === 'workdir' && { workdir: '/w', tools: [], servers: [] }), ...(confinedWrites && access === 'operator' && { canOnlyWriteTo: writes }) }
      if (confinedWrites && access !== 'operator') continue
      const rec: any = { sessionType: type, ...(policy && { policy: structuredClone(policy) }), verified }
      const oldTools = type === 'scoped'                                                       // tool surface: the type alone
      const oldUnverified = (type === 'scoped' || access === 'workdir' || confinedWrites) && !verified
      readStoredSession(rec)
      const consistent = (type === 'scoped') === (access === 'workdir')
      if (consistent) {
        expect(isRestricted(rec)).toBe(oldTools)
        expect(unverified(rec)).toBe(oldUnverified)
      } else {
        stricter++
        expect(isRestricted(rec)).toBe(type === 'scoped' || access === 'workdir')             // either old signal restricts, never neither
      }
      expect(rec).not.toHaveProperty('policy.access')
      expect(rec.sessionType).not.toBe('scoped')
      rows++
    }
    expect(rows).toBe(32)   // 4 types x (no policy, workdir, operator, operator with can_only_write_to) x verified or not
    expect(stricter).toBeGreaterThan(0)
  })
})

describe('the loaders read the old record on disk', () => {
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
    registry.delete('old-restricted'); registry.delete('old-desk'); registry.delete('old-gem')
  })

  const rec = (id: string, over: Record<string, unknown>) => ({ sessionId: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), tmuxName: id, listening: false, engine: 'claude', ...over })

  test('sessions.json written before the boolean: a restricted, an operator and a write-confined record', () => {
    writeFileSync(sessionsFile, JSON.stringify([
      rec('old-restricted', { sessionType: 'scoped', specialist: 'ops', policy: oldWorkdir(), verified: true }),
      rec('old-desk', { sessionType: 'thread_owner', specialist: 'desk', policy: oldOperator() }),
      rec('old-gem', { sessionType: 'thread_owner', specialist: 'gem', policy: oldWriteConfined(), verified: true }),
    ]))
    const reg = new SessionRegistry()
    expect(reg.get('old-restricted')).toMatchObject({ sessionType: 'thread_owner', policy: { restricted: true, workdir: '/work/ops', id: confinedId } })
    expect(reg.get('old-desk')).toMatchObject({ sessionType: 'thread_owner', policy: { restricted: false } })
    expect(reg.get('old-gem')).toMatchObject({ sessionType: 'thread_owner', policy: { restricted: false, canOnlyWriteTo: { workdir: '/work/gem' } } })
    expect(reg.get('old-restricted')!.policy).not.toHaveProperty('access')
    reg.persist()   // what it writes holds the boolean, with the historical forms beside it (a revert reads those: see the revert test below)
    expect(readFileSync(sessionsFile, 'utf8')).toContain('"restricted": true')
  })

  test('threads.json written before the boolean: a history entry keeps the policy a revive reads', () => {
    writeFileSync(threadsFile, JSON.stringify([{
      threadId: 'th-old', topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0,
      sessionHistory: [{ sessionId: SID, tmuxName: 'ops', originType: 'spawn', startedAt: 1, messageCount: 0, policy: oldWorkdir() }],
    }]))
    const threads = new ThreadRegistry()
    threads.boot(new SessionRegistry())
    const entry = threads.get('th-old')!.sessionHistory[0]
    expect(entry.policy).toMatchObject({ restricted: true, id: confinedId })
    expect(entry.policy).not.toHaveProperty('access')
    expect(policyProblem(entry.policy)).toBeUndefined()
  })

  // The same records, as the tool surface sees them: the restricted one holds exactly the restricted tools, the others what they held.
  test('the tool surface of each loaded record is what the old record had', () => {
    writeFileSync(sessionsFile, JSON.stringify([
      rec('old-restricted', { sessionType: 'scoped', specialist: 'ops', policy: oldWorkdir() }),
      rec('old-desk', { sessionType: 'thread_owner', specialist: 'desk', policy: oldOperator() }),
    ]))
    const loaded = new SessionRegistry()
    registry.set('old-restricted', loaded.get('old-restricted')!)
    registry.set('old-desk', loaded.get('old-desk')!)
    expect(isRestrictedSession('old-restricted')).toBe(true)
    expect(getToolsForSession('old-restricted').map(t => String(t.name)).sort()).toEqual([...BASE_TOOLS.restricted].filter(t => t !== 'send_to_thread').map(String).sort())
    expect(isToolAllowed('old-restricted', 'spawn_session')).toBe(false)
    expect(isRestrictedSession('old-desk')).toBe(false)
    expect(isToolAllowed('old-desk', 'spawn_session')).toBe(true)
  })
})

describe('a bridge launched with HYDRA_SESSION_TYPE=scoped, already running when the boolean arrived', () => {
  test.each([
    ['the old declaration', { sessionType: 'scoped' }],
    ['the new declaration', { restricted: true }],
  ])('%s narrows an id the registry does not know', (_n, declared) => {
    const id = `ghost-${Math.random().toString(36).slice(2, 7)}`
    expect(isToolAllowed(id, 'spawn_session')).toBe(true)
    noteDeclaredRestrictions(id, declared)
    expect(isToolAllowed(id, 'spawn_session')).toBe(false)
    expect(isToolAllowed(id, 'reply')).toBe(true)
  })
  test('another type, or restricted: false, narrows nothing', () => {
    noteDeclaredRestrictions('ghost-plain', { sessionType: 'thread_owner', restricted: false })
    expect(isToolAllowed('ghost-plain', 'spawn_session')).toBe(true)
  })
})

describe('the folders of a session launched before the boolean', () => {
  const tmuxName = 'ops'
  const legacyFile = () => join(legacyRestrictedDir(), `${tmuxName}-${SID}.mcp.json`)
  const legacyServer = () => join(legacyServerTmpRoot(), `${tmuxName}-${SID}`, 'datadog')
  beforeEach(() => {
    mkdirSync(legacyRestrictedDir(), { recursive: true }); writeFileSync(legacyFile(), '{}')
    mkdirSync(legacyServer(), { recursive: true })
  })
  afterEach(() => { rmSync(legacyRestrictedDir(), { recursive: true, force: true }); rmSync(legacyServerTmpRoot(), { recursive: true, force: true }); rmSync(restrictedDir(), { recursive: true, force: true }); rmSync(serverTmpRoot(), { recursive: true, force: true }) })

  test('its end removes its files from the old folders', () => {
    removeRestrictedFiles({ tmuxName, sessionId: SID }, true)
    expect(existsSync(legacyFile())).toBe(false)
    expect(existsSync(legacyServer())).toBe(false)
  })

  test('a new launch under the same name removes the earlier files there, and writes only to the new folders', () => {
    const later = '22222222-2222-4222-8222-222222222222'
    const out = writeRestrictedFiles(tmuxName, later, { settings: {}, mcp: {} })
    makeServerTmpDirs(tmuxName, later, ['datadog'])
    expect(existsSync(legacyFile())).toBe(false)
    expect(existsSync(legacyServer())).toBe(false)
    expect(out.mcp.startsWith(restrictedDir())).toBe(true)
    expect(restrictedDir().endsWith('/restricted')).toBe(true)
    expect(serverTmpRoot()).toBe(join(tmpdir(), 'hydra-restricted'))
    expect(existsSync(join(legacyRestrictedDir(), `${tmuxName}-${later}.mcp.json`))).toBe(false)
  })

  test('files of another session name in the old folders are left alone', () => {
    const other = join(legacyRestrictedDir(), `ops-eu-${SID}.mcp.json`)
    writeFileSync(other, '{}')
    writeRestrictedFiles(tmuxName, '33333333-3333-4333-8333-333333333333', { settings: {}, mcp: {} })
    expect(existsSync(other)).toBe(true)
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
    ["a stored `access: 'root'` read as nothing", (() => { const p: Record<string, unknown> = { access: 'root' }; readStoredPolicy(p); return p })(), true],
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

// The build before the boolean, reading what this build writes after a revert. Its decisions, copied from daemon/restricted.ts and daemon/tool-surface.ts
// at the parent of this change (71580dc), are the oracle: the same verdict on the same facts.
describe('a revert: the previous build reads the records this build writes', () => {
  const oldTools = (r: { sessionType?: string }) => r.sessionType === 'scoped'                                  // tool-surface isRestrictedSession, from the record
  const oldPlainWorker = (r: { sessionType?: string }) => r.sessionType === 'thread_owner'                      // idle-limit, auto-handoff, recovery, daemon.ts
  const oldUnverified = (r: { sessionType?: string; policy?: { access?: string; canOnlyWriteTo?: unknown }; verified?: boolean }) =>
    (r.sessionType === 'scoped' || r.policy?.access === 'workdir' || !!r.policy?.canOnlyWriteTo) && !r.verified
  const oldConfined = (p: { access?: string } | undefined) => !!p && p.access === 'workdir'                    // confined()
  const oldWas = oldConfined                                                                                    // policyDrifted: `stored?.access === 'workdir'`
  const oldPolicyProblem = (q: any): string | undefined => {                                                    // the access-reading half of policyProblem
    if (q.access === 'operator' && q.canOnlyWriteTo !== undefined) return q.id === confinementIdFor(q.canOnlyWriteTo) ? undefined : 'id'
    if (q.access === 'operator') return q.id === OPERATOR_POLICY_ID ? undefined : 'id'
    if (q.access !== 'workdir') return `its access is ${JSON.stringify(q.access)}`
    return q.id === policyIdFor(q.workdir, q.tools, q.servers) ? undefined : 'id'
  }

  const sessionsFile = join(STATE_DIR, 'sessions.json')
  const threadsFile = join(STATE_DIR, 'threads.json')
  let savedS: string | null, savedT: string | null
  beforeEach(() => {
    savedS = existsSync(sessionsFile) ? readFileSync(sessionsFile, 'utf8') : null
    savedT = existsSync(threadsFile) ? readFileSync(threadsFile, 'utf8') : null
    _setTmuxForTesting({ exec: (() => { throw Object.assign(new Error('tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) as any })
  })
  afterEach(() => { for (const [f, s] of [[sessionsFile, savedS], [threadsFile, savedT]] as const) { if (s === null) rmSync(f, { force: true }); else writeFileSync(f, s) } })

  const rec = (id: string, policy: object, extra: object = {}) => ({ sessionId: id, tmuxName: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude', sessionType: 'thread_owner', policy, ...extra }) as unknown as SessionInfo
  const shapes = {
    restricted: { policy: { specialist: 'ops', restricted: true, workdir: '/work/ops', tools: ['Read', 'Grep'], servers, id: confinedId }, restricts: true, confinedWrites: false },
    operator: { policy: { specialist: 'desk', restricted: false, id: OPERATOR_POLICY_ID }, restricts: false, confinedWrites: false },
    'write-confined': { policy: { specialist: 'gem', restricted: false, canOnlyWriteTo: writes, id: confinementIdFor(writes) }, restricts: false, confinedWrites: true },
  } as const

  test.each(Object.entries(shapes))('%s: sessions.json and threads.json as written now give the previous build the verdicts it gave its own', (name, shape) => {
    const reg = new SessionRegistry()
    reg.set(`rv-${name}`, rec(`rv-${name}`, structuredClone(shape.policy), { verified: true }))
    reg.set(`rv-${name}-u`, rec(`rv-${name}-u`, structuredClone(shape.policy)))
    reg.persist()
    const [verified, unverifiedRec] = JSON.parse(readFileSync(sessionsFile, 'utf8')).filter((r: any) => r.sessionId.startsWith(`rv-${name}`))
    for (const r of [verified, unverifiedRec]) {
      expect(oldTools(r)).toBe(shape.restricts)
      expect(oldPlainWorker(r)).toBe(!shape.restricts)
      expect(oldConfined(r.policy)).toBe(shape.restricts)
      expect(oldWas(r.policy)).toBe(shape.restricts)
      expect(oldPolicyProblem(r.policy)).toBeUndefined()   // so its resolvePolicy reads it: no "its access is undefined"
    }
    expect(oldUnverified(verified)).toBe(false)
    expect(oldUnverified(unverifiedRec)).toBe(shape.restricts || shape.confinedWrites)

    const threads = new ThreadRegistry()
    ;(threads as any).threads.set('th-rv', { threadId: 'th-rv', topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [{ sessionId: SID, tmuxName: 'x', originType: 'spawn', startedAt: 1, messageCount: 0, policy: structuredClone(shape.policy) }] })
    threads.persist()
    const entry = JSON.parse(readFileSync(threadsFile, 'utf8')).find((t: any) => t.threadId === 'th-rv').sessionHistory[0]
    expect(oldConfined(entry.policy)).toBe(shape.restricts)
    expect(oldPolicyProblem(entry.policy)).toBeUndefined()
  })

  test('and this build still reads them back as the boolean, then writes them the same', () => {
    const reg = new SessionRegistry()
    reg.set('rv-again', rec('rv-again', structuredClone(shapes.restricted.policy)))
    reg.persist()
    const again = new SessionRegistry()
    expect(again.get('rv-again')).toMatchObject({ sessionType: 'thread_owner', policy: { restricted: true } })
    expect(JSON.parse(readFileSync(sessionsFile, 'utf8')).find((r: any) => r.sessionId === 'rv-again')).toMatchObject({ sessionType: 'scoped', policy: { restricted: true, access: 'workdir' } })
  })
})
