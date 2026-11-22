// The engine and model a session starts on, through the real path: hydra.toml text -> loader -> a specialist's recipe -> revive -> doSpawnSession.
// Fake engines (one per provider) record what they were launched with; fake tmux and gateway, no daemon I/O.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway } from '../../infra/config.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { ensureSpecialist } from '../../specialists/specialist-deliver.js'
import { getSpecialist } from '../../sessions/specialists.js'
import { _resetBackoff } from '../../infra/recovery-backoff.js'
import { doSpawnSession } from '../../app/session-lifecycle.js'
import { registry, threadRegistry, type SessionInfo } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { engines } from '../../engines/instances.js'
import type { LaunchInput, ProviderId } from '../../engines/engine-adapter.js'
import { _resetRecoveryDeps, reviveThread } from '../../app/recovery.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { engineOfModel, resolveLaunchSelection } from '../../shared/constants.js'

process.stderr.write = (() => true) as any

const dir = mkdtempSync(join(tmpdir(), 'launch-engine-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const env = testLoadEnv({ home: '/home/op', isDir: p => p === dir || p === '/home/op', isCommand: () => true, sessionNames: ['spark'] })
const PEOPLE = `operator = "op"\n[people.op]\naddresses = ["discord:100000000000000001"]\n`
const specialistToml = (body: string) => `${PEOPLE}[specialists.helper]\nworkdir = "${dir}"\nreachable_by = []\nhome_place = "123456789"\nkickoff = "be the helper"\n${body}\n`
/** hydra.toml text through the real loader, installed as the live config. Returns the load's errors, or none. */
function install(text: string): string[] {
  const r = loadHydraConfig(text, env)
  if (!r.ok) return r.errors.map(e => `${e.path}: ${e.message}`)
  _setHydraConfigForTesting(r.config)
  return []
}

let fake: FakeTmux
const launches: (LaunchInput & { provider: ProviderId })[] = []
const orig: Record<string, any> = {}
const fakeEngine = (provider: ProviderId) => ({
  provider, channel: 'bridge',
  launch: async (input: LaunchInput) => {
    launches.push({ ...input, provider })
    return { provider, model: input.model, identity: {} }
  },
  stop: async () => ({ status: 'stopped' }), isAlive: () => false, surface: () => null,
  recoveryPlan: (s: any, o: any) => orig[provider].recoveryPlan(s, o),
})
const lastLaunch = () => launches.at(-1)!

beforeAll(() => {
  for (const p of ['claude', 'codex', 'omp', 'agy'] as const) { orig[p] = engines[p]; engines[p] = fakeEngine(p) as any }
  for (const k of ['send', 'react', 'edit', 'fetchChannel', 'getThreadUrl', 'createThread'] as const) orig[k] = (gateway as any)[k]
  orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist
  orig.spawnCwd = process.env.SPAWN_CWD
  ;(gateway as any).send = async (c: string) => ({ id: 'm', channelId: c })
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  ;(gateway as any).fetchChannel = async () => ({ isThread: true, isDM: false, parentId: '123456789' })
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  let t = 0
  ;(gateway as any).createThread = async () => ({ id: `le-thread-${++t}` })
  ;(transport as any).has = () => launches.length > 0
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = process.cwd()
})
afterAll(() => {
  for (const p of ['claude', 'codex', 'omp', 'agy'] as const) engines[p] = orig[p]
  for (const k of ['send', 'react', 'edit', 'fetchChannel', 'getThreadUrl', 'createThread'] as const) (gateway as any)[k] = orig[k]
  ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
  if (orig.spawnCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.spawnCwd
  _setHydraConfigForTesting(undefined)
})
beforeEach(() => { fake = withFakeTmux(); launches.length = 0; _resetBackoff() })
// Whatever a test started: every session, thread and history entry made since it began.
let before = { sessions: new Set<string>(), threads: new Set<string>() }
beforeEach(() => { before = { sessions: new Set([...registry.values()].map(s => s.sessionId)), threads: new Set(threadRegistry.threads.keys()) } })
afterEach(() => {
  for (const s of [...registry.values()]) if (!before.sessions.has(s.sessionId)) registry.delete(s.sessionId)
  for (const t of [...threadRegistry.threads.keys()]) if (!before.threads.has(t)) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
  fake.restore()
  _setHydraConfigForTesting(undefined)
  _resetRecoveryDeps()
})

describe('resolveLaunchSelection', () => {
  test('the Codex and omp tables are checked before the Claude one; any other string is Claude\'s', () => {
    expect(resolveLaunchSelection('astra')).toEqual({ model: 'gpt-6-astra', engine: 'codex' })
    expect(resolveLaunchSelection('Luna')).toEqual({ model: 'gpt-5.6-luna', engine: 'codex' })
    expect(resolveLaunchSelection('omp-sonnet')).toEqual({ model: 'claude-sonnet-5-5[1m]', engine: 'omp' })
    expect(resolveLaunchSelection('omp-astra')).toEqual({ model: 'gpt-6-astra', engine: 'omp' })
    expect(resolveLaunchSelection('opus')).toEqual({ model: 'claude-opus-5-5[1m]', engine: 'claude' })
    expect(resolveLaunchSelection('some-unknown-id')).toEqual({ model: 'some-unknown-id', engine: 'claude' })
    expect(engineOfModel('some-unknown-id')).toBeUndefined()
  })
  test('engineOfModel places a full id of a known family, and leaves any other name alone', () => {
    expect(engineOfModel('claude-opus-5-5')).toBe('claude')
    expect(engineOfModel('claude-opus-5-5[1m]')).toBe('claude')
    expect(engineOfModel('gpt-6-astra')).toBe('codex')
    expect(engineOfModel('gpt-9-future')).toBe('codex')
    expect(engineOfModel('omp-luna')).toBe('omp')
    expect(engineOfModel('claude-not-a-model')).toBeUndefined()
    expect(resolveLaunchSelection('gpt-6-astra')).toEqual({ model: 'gpt-6-astra', engine: 'codex' })
  })
  test('an engine given reads the alias in its own table and passes a full id through', () => {
    expect(resolveLaunchSelection('astra', 'codex')).toEqual({ model: 'gpt-6-astra', engine: 'codex' })
    expect(resolveLaunchSelection('gpt-6-astra', 'codex')).toEqual({ model: 'gpt-6-astra', engine: 'codex' })
    expect(resolveLaunchSelection('claude-sonnet-5-5[1m]', 'omp')).toEqual({ model: 'claude-sonnet-5-5[1m]', engine: 'omp' })
  })
})

describe('a specialist declared in hydra.toml', () => {
  test('engine = "codex" reaches the loaded specialist, its recipe, and the engine its fresh session launches on', async () => {
    expect(install(specialistToml('engine = "codex"'))).toEqual([])
    expect(getSpecialist('helper')).toMatchObject({ engine: 'codex' })
    await ensureSpecialist('helper')
    // No model named: Codex picks its own default, it is not handed the Claude spawn default.
    expect(lastLaunch().provider).toBe('codex')
    expect(lastLaunch().model).toBeUndefined()
    expect([...registry.values()].find(s => s.tmuxName === 'helper')?.engine).toBe('codex')
  })

  test('engine = "agy" with no model starts agy on its flash model, not the Claude spawn default', async () => {
    expect(install(specialistToml('engine = "agy"'))).toEqual([])
    await ensureSpecialist('helper')
    expect(lastLaunch()).toMatchObject({ provider: 'agy', model: 'gemini-3.8-flash-high' })
  })

  test('an agy alias as the model picks the engine and the model; another engine\'s model with engine = "agy" is a load error', async () => {
    expect(install(specialistToml('model = "neon"'))).toEqual([])
    await ensureSpecialist('helper')
    expect(lastLaunch()).toMatchObject({ provider: 'agy', model: 'gemini-4-neon-high' })
    const errs = install(specialistToml('engine = "agy"\nmodel = "opus"'))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('engine = "agy"')
  })

  test('with no engine it starts on claude, as before', async () => {
    expect(install(specialistToml(''))).toEqual([])
    await ensureSpecialist('helper')
    expect(lastLaunch().provider).toBe('claude')
  })

  test.each([['astra', 'gpt-6-astra'], ['sol', 'gpt-6.1-sol'], ['terra', 'gpt-5.6-terra'], ['luna', 'gpt-5.6-luna']])('model = "%s" starts the Codex engine on %s', async (alias, id) => {
    expect(install(specialistToml(`model = "${alias}"`))).toEqual([])
    await ensureSpecialist('helper')
    expect(lastLaunch()).toMatchObject({ provider: 'codex', model: id })
  })

  test('a Claude alias keeps Claude and its resolved id', async () => {
    expect(install(specialistToml('model = "opus"'))).toEqual([])
    await ensureSpecialist('helper')
    expect(lastLaunch()).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5[1m]' })
  })

  test('engine = "codex" with a Codex alias agrees; with a Claude alias it is a load error naming both', () => {
    expect(install(specialistToml('engine = "codex"\nmodel = "sol"'))).toEqual([])
    const errs = install(specialistToml('engine = "claude"\nmodel = "astra"'))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('specialists.helper.model')
    expect(errs[0]).toContain('"astra"')
    expect(errs[0]).toContain('codex model')
    expect(errs[0]).toContain('engine = "claude"')
    expect(install(specialistToml('engine = "codex"\nmodel = "opus"'))).toHaveLength(1)
  })

  test('a full id of another engine disagrees with engine the same way as an alias', () => {
    for (const [engine, model] of [['claude', 'gpt-6-astra'], ['codex', 'claude-opus-5-5[1m]']]) {
      const errs = install(specialistToml(`engine = "${engine}"\nmodel = "${model}"`))
      expect(errs).toHaveLength(1)
      expect(errs[0]).toContain(`"${model}"`)
      expect(errs[0]).toContain(`engine = "${engine}"`)
    }
    expect(install(specialistToml('engine = "claude"\nmodel = "claude-opus-5-5[1m]"'))).toEqual([])
    expect(install(specialistToml('engine = "codex"\nmodel = "some-new-codex-id"'))).toEqual([])
  })

  test('restricted + engine codex + a Claude model is one error: the restricted refusal, not stacked with the disagreement', () => {
    const errs = install(specialistToml('restricted = true\nengine = "codex"\nmodel = "opus"'))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("codex can't run a restricted specialist")
  })
})

describe('a specialist whose conversation has history', () => {
  const seedDead = (engine: ProviderId) => {
    const sessionId = `le-dead-${engine}`
    registry.set(sessionId, {
      sessionId, topic: 'topic', threadId: 'le-hist', createdAt: Date.now() - 1e6, lastActive: Date.now(), tmuxName: 'helper', listening: false,
      engine, sessionType: 'thread_owner', deadAt: Date.now(), adapter: fakeEngine(engine) as any, ...(engine === 'claude' && { claudeSessionId: 'C-1' }),
    } as any as SessionInfo)
    registry.setThread('le-hist', sessionId)
    threadRegistry.recordSpawn('le-hist', { topic: 'topic', respawnCount: 0, sessionId, tmuxName: 'helper', originType: 'spawn', model: 'm', label: undefined })
  }
  const revive = (declaredEngine: ProviderId | undefined, extra: Record<string, unknown> = {}) =>
    reviveThread({ thread: threadRegistry.get('le-hist')!, respawnOnly: true, respawnTopic: 'kickoff', name: 'helper', declaredEngine, ...extra } as any)

  test('a claude history keeps claude over a declared codex', async () => {
    seedDead('claude')
    expect(await revive('codex')).toMatchObject({ ok: true })
    expect(lastLaunch().provider).toBe('claude')
  })

  test('a codex history keeps codex over a declared claude', async () => {
    seedDead('codex')
    expect(await revive('claude')).toMatchObject({ ok: true })
    expect(lastLaunch().provider).toBe('codex')
  })

  test('a model that another engine runs is not sent to the history\'s engine', async () => {
    seedDead('claude')
    expect((await revive('codex', { model: 'astra' })).ok).toBe(true)
    expect(lastLaunch().provider).toBe('claude')
    expect(lastLaunch().model).not.toContain('astra')
  })

  test('a full id of another engine is dropped too, and the drop is said once on stderr', async () => {
    seedDead('claude')
    const lines: string[] = []
    const realWrite = process.stderr.write
    process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as any
    try { expect((await revive('codex', { model: 'gpt-6-astra' })).ok).toBe(true) } finally { process.stderr.write = realWrite }
    expect(lastLaunch().provider).toBe('claude')
    expect(lastLaunch().model).not.toContain('gpt')
    expect(lines.filter(l => l.includes('belongs to the codex engine') && l.includes('was not sent'))).toHaveLength(1)
  })

  test('a history entry that records no engine, with no record left (a clean kill), is a Claude conversation over a declared codex', async () => {
    threadRegistry.recordSpawn('le-hist', { topic: 'topic', respawnCount: 0, sessionId: 'le-killed', tmuxName: 'helper', originType: 'spawn', model: 'm', label: undefined })
    expect(registry.get('le-killed')).toBeUndefined()
    expect(await revive('codex')).toMatchObject({ ok: true })
    expect(lastLaunch().provider).toBe('claude')
  })

  test('an explicit engine (handoff) still overrides the history', async () => {
    seedDead('claude')
    expect((await revive(undefined, { engine: 'codex', model: 'gpt-6-astra' })).ok).toBe(true)
    expect(lastLaunch()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
  })
})

describe('every other launch path', () => {
  test('hydra spawn --model astra (no engine) starts Codex on the resolved id', async () => {
    await doSpawnSession('topic', undefined, undefined, { model: 'astra' })
    expect(lastLaunch()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
  })
  test('hydra spawn --model omp-luna starts omp on the resolved id', async () => {
    await doSpawnSession('topic', undefined, undefined, { model: 'omp-luna' })
    expect(lastLaunch()).toMatchObject({ provider: 'omp', model: 'gpt-5.6-luna' })
  })
  test('hydra spawn --model sonnet stays Claude', async () => {
    await doSpawnSession('topic', undefined, undefined, { model: 'sonnet' })
    expect(lastLaunch()).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5[1m]' })
  })
  test('a chat spawn, which names the engine and the resolved id itself, is unchanged', async () => {
    await doSpawnSession('topic', undefined, undefined, { model: 'gpt-6-astra', engine: 'codex' })
    expect(lastLaunch()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
    await doSpawnSession('topic', undefined, undefined, { engine: 'codex' })
    expect(lastLaunch()).toMatchObject({ provider: 'codex', model: undefined })
    await doSpawnSession('topic', undefined, undefined, { model: 'claude-sonnet-5-5[1m]', engine: 'omp' })
    expect(lastLaunch()).toMatchObject({ provider: 'omp', model: 'claude-sonnet-5-5[1m]' })
  })
})

describe('omp and main', () => {
  test('a specialist cannot use omp: engine or an omp- alias, restricted or not, one message each', () => {
    const one = (body: string) => { const e = install(specialistToml(body)); expect(e).toHaveLength(1); return e[0] }
    expect(one('engine = "omp"')).toContain("omp cannot restrict a session's tools, so a specialist cannot use it; use claude, codex, or agy")
    expect(one('model = "omp-sonnet"')).toContain('specialists.helper.model')
    expect(one('engine = "omp"\nrestricted = true')).toContain('omp cannot restrict')
    expect(one('model = "omp-luna"\nrestricted = true')).toContain('omp cannot restrict')
  })
  test('restricted with a Codex engine or alias keeps its one refusal', () => {
    for (const body of ['engine = "codex"\nrestricted = true', 'model = "astra"\nrestricted = true']) {
      const e = install(specialistToml(body))
      expect(e).toHaveLength(1)
      expect(e[0]).toContain("codex can't run a restricted specialist")
    }
  })
  test('[main] model refuses a Codex or omp alias, which main (it starts `claude --model`) cannot run, and takes a Claude one', () => {
    const main = (m: string) => install(`${PEOPLE}[main]\nmodel = "${m}"\n`)
    expect(main('astra')).toEqual(['main.model: "astra" is a codex model, and main runs on Claude: use a Claude model (opus, sonnet, ...) or a full Claude model id'])
    expect(main('omp-sonnet')[0]).toContain('omp model')
    expect(main('gpt-6-astra')[0]).toContain('codex model')
    expect(main('opus')).toEqual([])
    expect(main('claude-opus-5-5[1m]')).toEqual([])
  })
})
