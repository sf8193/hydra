// A can_only_write_to specialist through the session lifecycle: the gates every start passes (folder, worktree, token, engine), the start check, and the delivery gate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gateway } from '../config.js'
import { _resetRefusalNotices, _resetVerifyBackoff, doSpawnSession } from '../session-lifecycle.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import type { LaunchInput } from '../engines/engine-adapter.js'
import { _setHydraConfigForTesting, _setLoadEnvForTesting } from '../hydra-config.js'
import { PolicyRefusal, bornPolicy, deliveryRefusal, unverified, type LaunchPolicy } from '../restricted.js'
import { confinementRules, confinementServers } from '../write-confinement.js'
import { verifyConfinement, verifyDeps } from '../engines/claude-verify.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { macLike } from './sandbox-host.js'
import type { HydraConfig, Specialist, WriteConfinedSpecialist } from '../../config/types.js'

process.stderr.write = (() => true) as any

const THREAD = 'cw-thread'
const PARENT = 'cw-parent'
const workdir = mkdtempSync(join(tmpdir(), 'confinement-'))
const SPAWN = mkdtempSync(join(tmpdir(), 'confinement-spawn-'))
afterAll(() => { rmSync(workdir, { recursive: true, force: true }); rmSync(SPAWN, { recursive: true, force: true }) })

const spec = (id: string, over: Partial<Specialist> = {}): Specialist => ({ id, workdir, reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...over }) as Specialist
const configWith = (specialists: Specialist[]): HydraConfig => ({
  operator: 'op', connectors: {}, gateways: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', addresses: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: Object.fromEntries(specialists.map(s => [s.id, s])),
  mcpServers: { browser: { name: 'browser', command: '/usr/local/bin/browser-mcp', tokenEnv: ['BR_TOKEN'], tools: [], profileArgs: ['--dir={profile_dir}'] } },
})
const GEM = spec('gem', { canOnlyWriteTo: 'workdir', cannotRead: [], mcpServerNames: ['browser'] }) as WriteConfinedSpecialist
const use = (...s: Specialist[]) => _setHydraConfigForTesting(configWith(s))

let fake: FakeTmux
let debugText: ((p: LaunchPolicy) => string) | undefined
const launches: LaunchInput[] = []
const stops: string[] = []
const told: string[] = []
let launchError: Error | undefined
const orig: Record<string, any> = {}
const fakeClaude = {
  provider: 'claude', channel: 'bridge', limitsAccess: true,
  launch: async (input: LaunchInput) => {
    launches.push(input)
    if (launchError) throw launchError
    return { provider: 'claude', model: 'claude-x', identity: { claudeSessionId: `new-${launches.length}` }, debugLogPath: `/spawn-logs/debug-${input.tmuxName}-${input.sessionId}.log` }
  },
  // The real start check, on the fake engine's launch.
  verifyConfinement: (policy: LaunchPolicy, launched: any) => verifyConfinement({ ...confinementRules(policy.canOnlyWriteTo!), servers: confinementServers(policy.canOnlyWriteTo!) }, launched.debugLogPath),
  stop: async (info: SessionInfo) => { stops.push(info.sessionId); return { status: 'stopped' } }, isAlive: () => false, surface: () => null,
  recoveryPlan: (s: any, o: any) => orig.claude.recoveryPlan(s, o),
}
/** A debug file, as Claude Code writes it, that shows the policy's rules applied. */
const applied = (p: LaunchPolicy): string => {
  const r = confinementRules(p.canOnlyWriteTo!)
  const T = '2026-11-13T04:34:18.000Z [DEBUG] '
  return [`${T}Applying permission update: Adding ${r.allow.length} allow rule(s) to destination 'flagSettings': ${JSON.stringify(r.allow)}`, `${T}Applying permission update: Adding ${r.deny.length} deny rule(s) to destination 'flagSettings': ${JSON.stringify(r.deny)}`,
    ...confinementServers(p.canOnlyWriteTo!).map(n => `${T}MCP server "${n}": Successfully connected (transport: stdio) in 9ms`), `${T}[claudeai-mcp] Disabled via env var`].join('\n') + '\n'
}

const savedVerify = { read: verifyDeps.read, deadline: verifyDeps.deadlineMs, poll: verifyDeps.pollMs }
beforeAll(() => {
  verifyDeps.deadlineMs = 30; verifyDeps.pollMs = 5
  verifyDeps.read = () => { const p = launches.at(-1)?.policy; if (!p) throw new Error('no launch'); return (debugText ?? applied)(p) }
  process.env.BR_TOKEN = 'br-test'
  orig.claude = engines.claude
  for (const k of ['send', 'react', 'edit', 'fetchChannel', 'getThreadUrl', 'createThread'] as const) orig[k] = (gateway as any)[k]
  orig.has = transport.has; orig.sendOrQueue = transport.sendOrQueue
  orig.persist = registry.persist; orig.tpersist = threadRegistry.persist
  orig.spawnCwd = process.env.SPAWN_CWD
  engines.claude = fakeClaude as any
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  ;(gateway as any).fetchChannel = async () => ({ isThread: true, isDM: false, parentId: PARENT })
  ;(gateway as any).getThreadUrl = async () => 'https://x/thread'
  ;(gateway as any).createThread = async () => ({ id: THREAD })
  ;(transport as any).has = () => launches.length > 0
  ;(transport as any).sendOrQueue = () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  process.env.SPAWN_CWD = SPAWN
})
afterAll(() => {
  Object.assign(verifyDeps, { read: savedVerify.read, deadlineMs: savedVerify.deadline, pollMs: savedVerify.poll })
  engines.claude = orig.claude
  for (const k of ['send', 'react', 'edit', 'fetchChannel', 'getThreadUrl', 'createThread'] as const) (gateway as any)[k] = orig[k]
  ;(transport as any).has = orig.has; (transport as any).sendOrQueue = orig.sendOrQueue
  ;(registry as any).persist = orig.persist; (threadRegistry as any).persist = orig.tpersist
  if (orig.spawnCwd === undefined) delete process.env.SPAWN_CWD; else process.env.SPAWN_CWD = orig.spawnCwd
  _setHydraConfigForTesting(undefined)
})
beforeEach(() => {
  _setLoadEnvForTesting(macLike()); fake = withFakeTmux(); launches.length = 0; stops.length = 0; told.length = 0; debugText = undefined; launchError = undefined
  _resetRefusalNotices(); _resetVerifyBackoff?.()
  ;(gateway as any).send = async (c: string, text: string) => { told.push(text); return { id: 'm', channelId: c } }
  use(GEM, spec('desk'))
})
afterEach(() => {
  for (const s of [...registry.values()]) if (s.threadId === THREAD) registry.delete(s.sessionId)
  registry.deleteThread(THREAD)
  threadRegistry.threads.delete(THREAD)
  fake.restore()
  _setLoadEnvForTesting(undefined)
})

let seq = 0
function seedDead(extra: Partial<SessionInfo> = {}): SessionInfo {
  const n = ++seq
  const info = { sessionId: `cw-dead-${n}`, topic: 'topic', threadId: THREAD, createdAt: Date.now() - 1e6, lastActive: Date.now(), tmuxName: `cwdead${n}`, listening: false, engine: 'claude', sessionType: 'thread_owner', anchorChannelId: PARENT, deadAt: Date.now(), adapter: fakeClaude, claudeSessionId: `C-${n}`, ...extra } as any as SessionInfo
  registry.set(info.sessionId, info)
  registry.setThread(THREAD, info.sessionId)
  threadRegistry.recordSpawn(THREAD, { topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName, originType: 'spawn', model: 'm', claudeSessionId: info.claudeSessionId } as any)
  return info
}
const start = (extra: Record<string, unknown> = {}) => doSpawnSession('t', undefined, undefined, { existingThreadId: THREAD, specialist: 'gem', ...extra })
const live = () => registry.get(registry.getByThread(THREAD)!)!

describe('a start of a write-confined specialist', () => {
  test('runs in its workdir whatever the caller\'s spawn dir is, carries the stored policy, and is verified before it takes a message', async () => {
    seedDead()
    await start()
    expect(launches).toHaveLength(1)
    expect(launches[0].cwd).toBe(workdir)
    expect(launches[0].policy?.canOnlyWriteTo?.workdir).toBe(workdir)
    expect(live().policy).toEqual(bornPolicy('gem'))
    expect(live().verified).toBe(true)
    expect(unverified(live())).toBe(false)
    expect(told.join('\n')).not.toMatch(/did not show the write confinement/)
  })

  test('an unverified record takes no message: the delivery gate covers this layer too', () => {
    const info = seedDead({ policy: bornPolicy('gem'), verified: undefined })
    expect(unverified(info)).toBe(true)
    expect(deliveryRefusal(info)).toMatch(/has not been checked against its policy|still being checked/)
  })

  test('a worktree is refused in the thread, and nothing starts', async () => {
    seedDead()
    await expect(start({ worktree: 'some-repo' })).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(/can only write in its workdir .* it never gets a git worktree/)
  })

  test('a workdir that does not exist is refused in the thread', async () => {
    use(spec('gem', { ...GEM, workdir: '/gone/gem-workdir' }), spec('desk'))
    seedDead()
    await expect(start()).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(/its workdir \/gone\/gem-workdir does not exist/)
  })

  test('a workdir that now sits in a place the layer denies is refused (a link added after the load)', async () => {
    const inner = join(workdir, 'inner'); mkdirSync(inner, { recursive: true })
    use(spec('gem', { ...GEM, workdir: inner }), spec('desk'))
    const info = seedDead()
    // the denied list holds the parent folder: as if a symlink led there
    ;(info as any).policy = undefined
    const p = bornPolicy('gem')!
    p.canOnlyWriteTo!.cannotRead.push(workdir)
    use(spec('gem', { ...GEM, workdir: inner, cannotRead: [workdir] }), spec('desk'))
    await expect(start()).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(/is, or now holds, .*which the layer denies reading/)
  })

  test('a listed server whose token variable is not set: the thread is told which variable and which file', async () => {
    seedDead()
    const saved = process.env.BR_TOKEN
    delete process.env.BR_TOKEN
    try {
      await expect(start()).rejects.toThrow(PolicyRefusal)
      expect(launches).toHaveLength(0)
      expect(told.join('\n')).toMatch(/\[mcp_servers\.browser\] needs BR_TOKEN, which is not set: add BR_TOKEN=<value> to .*\.env, and the next start picks it up/)
    } finally { process.env.BR_TOKEN = saved }
  })

  const MANAGED = '/Library/Application Support/ClaudeCode/managed-mcp.json'
  test('a listed server whose name a managed MCP config also declares refuses the start in the thread, naming the file; nothing starts', async () => {
    _setLoadEnvForTesting(macLike({ mcpNamesIn: f => (f === MANAGED ? ['browser'] : []) }))
    seedDead()
    await expect(start()).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toContain(`${MANAGED} already declares an MCP server named browser; Claude Code's own text says a managed MCP config's servers are admitted without listing them (not shown live)`)
  })

  test('the operator\'s own config declaring the listed name does not refuse the start: only the managed files are looked up, and its server has another command, which the allowlist does not admit', async () => {
    const asked: string[] = []
    _setLoadEnvForTesting(macLike({ mcpNamesIn: f => { asked.push(f); return f === MANAGED || f.startsWith('/etc/claude-code/') ? [] : ['browser'] } }))
    seedDead()
    await start()
    expect(launches).toHaveLength(1)
    expect(asked.sort()).toEqual([MANAGED, '/etc/claude-code/managed-mcp.json'].sort())
  })

  test('a managed MCP config that cannot be read refuses the start (the probe fails closed)', async () => {
    _setLoadEnvForTesting(macLike({ mcpNamesIn: f => { if (f === MANAGED) throw new Error(`${f} is not valid JSON (Unexpected end)`); return [] } }))
    seedDead()
    await expect(start()).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(/is not valid JSON \(Unexpected end\), so hydra cannot tell whether it declares an MCP server named like a listed one/)
  })

  test('a named browser profile that now resolves outside the workdir (a link added after the load) refuses the start', async () => {
    const named = join(workdir, 'chrome')
    use(spec('gem', { ...GEM, browserProfile: named }), spec('desk'))
    _setLoadEnvForTesting(macLike({ realpath: p => (p === named ? '/srv/real/chrome' : p) }))
    seedDead()
    await expect(start()).rejects.toThrow(PolicyRefusal)
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(/is not inside the workdir .*so no session starts/)
  })

  test.each(['codex', 'omp'] as const)('%s: refused in the thread, naming the engine hydra actually chose (not "undefined")', async engine => {
    seedDead({ engine: engine as any })
    await expect(start({ engine })).rejects.toThrow(new RegExp(`which the ${engine} engine cannot give`))
    expect(launches).toHaveLength(0)
    expect(told.join('\n')).toMatch(new RegExp(`can_only_write_to = "workdir", which the ${engine} engine cannot give`))
    expect(told.join('\n')).not.toContain('undefined')
  })

  test('a refusal the launch itself makes (an old Claude Code) is posted in the thread', async () => {
    seedDead()
    launchError = new PolicyRefusal('specialist gem: Claude Code 2.1.313 is older than 2.1.314')
    await expect(start()).rejects.toThrow(/older than/)
    expect(told.join('\n')).toMatch(/Claude Code 2\.1\.313 is older than 2\.1\.314/)
  })
})

describe('the start check', () => {
  test('a session whose debug file does not show the deny rules is stopped, the thread told the cause, and the start refuses', async () => {
    debugText = p => applied(p).split('\n').filter(l => !l.includes('deny rule')).join('\n') + '\n'
    seedDead()
    await expect(start()).rejects.toThrow(/did not show the write confinement/)
    expect(stops).toContain(launches[0].sessionId)   // this launch's own session is the one stopped
    expect(told.join('\n')).toMatch(/did not apply these deny rules: .*Read\(\/\//)
    expect(told.join('\n')).toMatch(/Send another message to start a fresh one/)
  })

  test('a session that started a server it was not given (an operator\'s, a plugin\'s, a connector) is stopped and the thread told which', async () => {
    debugText = p => applied(p) + '2026-11-13T04:34:18.000Z [DEBUG] MCP server "plugin:slack:slack": Starting connection with timeout of 30000ms\n'
    seedDead()
    await expect(start()).rejects.toThrow(/did not show the write confinement/)
    expect(stops).toContain(launches[0].sessionId)
    expect(told.join('\n')).toMatch(/started MCP servers the policy does not give it: `plugin:slack:slack`/)
  })

  test('a file that never appears refuses: no news is not good news', async () => {
    verifyDeps.read = () => { throw new Error('ENOENT') }
    try {
      seedDead()
      await expect(start()).rejects.toThrow(/did not show the write confinement/)
      expect(told.join('\n')).toMatch(/could not be read/)
    } finally { verifyDeps.read = () => { const p = launches.at(-1)?.policy; if (!p) throw new Error('no launch'); return (debugText ?? applied)(p) } }
  })

  test('a start stopped by the check is not repeated at once for each message', async () => {
    debugText = () => '\n'
    seedDead()
    await expect(start()).rejects.toThrow(PolicyRefusal)
    const before = launches.length
    await expect(start()).rejects.toThrow(/hydra waits \d+s before starting it again/)
    expect(launches).toHaveLength(before)
  })
})
