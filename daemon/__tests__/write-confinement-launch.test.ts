// `can_only_write_to = "workdir"`: what every start of such a specialist's session launches with, and how its stored policy is read and compared.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { STATE_DIR } from '../config.js'
import { PolicyRefusal, bornPolicy, describePolicy, policyDrifted, policyProblem, confinementIdFor, type LaunchPolicy } from '../restricted.js'
import { removeRestrictedFiles, restrictedDir } from '../restricted-files.js'
import { confinementShortfall, confinementSurplus, readLoaded, verifyConfinement, verifyDeps } from '../engines/claude-verify.js'
import { MIN_CLAUDE_VERSION, claudeVersion, claudeVersionRefusal, confinementSettings } from '../write-confinement.js'
import { EMPTY_CONFIG } from '../../config/load.js'
import { readDenyRoots } from '../../config/write-confinement.js'
import { hydraLoadEnv } from '../hydra-config.js'
import type { HydraConfig } from '../../config/types.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

let work: string
let fake: FakeTmux
let savedVersion: string | undefined
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'write-confinement-'))
  rmSync(restrictedDir(), { recursive: true, force: true })
  fake = withFakeTmux()
  savedVersion = claudeVersion.cache
  claudeVersion.cache = '2.1.326'
  for (const k of ['BR_TOKEN']) saved[k] = process.env[k]
  process.env.BR_TOKEN = 'br-secret'
  mkdirSync(join(STATE_DIR, 'mods', 'personal'), { recursive: true }); writeFileSync(join(STATE_DIR, 'mods', 'personal', 'plugin.json'), '{}')
})
afterEach(() => {
  fake.restore()
  claudeVersion.cache = savedVersion
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(work, { recursive: true, force: true })
})

const server = { name: 'browser', command: '/usr/local/bin/browser-mcp', tokenEnv: ['BR_TOKEN'], profileArgs: ['--user-data-dir', '{profile_dir}', '--downloads={download_dir}'], profileEnv: { BROWSER_HOME: '{profile_dir}' } }
const policyOf = (over: Partial<NonNullable<LaunchPolicy['canOnlyWriteTo']>> = {}): LaunchPolicy => {
  const canOnlyWriteTo = { workdir: work, denyCommands: ['rm -rf *'], cannotRead: ['/home/op/.ssh', '/home/op/other'], servers: [server], ...over }
  return { specialist: 'gem', access: 'operator', canOnlyWriteTo, id: confinementIdFor(canOnlyWriteTo) }
}
const id = '22222222-2222-4222-8222-222222222222'
const base = { sessionId: id, tmuxName: 'sc-w', cwd: '/operator/spawn', originalCwd: '/operator/spawn', model: 'claude-opus-4-1', prompt: 'hello', sessionType: 'thread_owner' as const }
const launch = async (extra: Record<string, unknown> = {}, policy: LaunchPolicy | null = policyOf()): Promise<string> => {
  await new ClaudeEngine({} as any).launch({ ...base, ...(policy && { policy }), ...extra } as any)
  const call = fake.calls().findLast(c => c.startsWith('new-session'))
  if (!call) throw new Error('no new-session call')
  return call.replaceAll(STATE_DIR, '<state>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
}
const settingsFile = () => join(restrictedDir(), `sc-w-${id}.settings.json`)
const mcpFile = () => join(restrictedDir(), `sc-w-${id}.mcp.json`)
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('every way a session starts gets the settings', () => {
  test.each([
    ['a fresh start', {}],
    ['a resume', { resumeFrom: 'C-old' }],
    ['a fork', { forkFrom: { claudeSessionId: 'C-parent' } }],
    ['a start that asked for a worktree', { cwd: '/wt/x', worktreePath: '/wt/x', forkFromOriginalCwd: true }],
  ])('%s: starts in the workdir, with --settings and --mcp-config after the prompt, and the operator\'s flags', async (_name, extra) => {
    const cmd = await launch(extra)
    expect(cmd).toContain(`&& cd '${work}' &&`)
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain(` --settings '<state>/scoped/sc-w-<uuid>.settings.json' --mcp-config '<state>/scoped/sc-w-<uuid>.mcp.json'`)
    expect(cmd).not.toContain('--restricted')
    expect(cmd).not.toContain('--strict-mcp-config')
    expect(cmd).not.toContain('--tools ')
    expect(existsSync(settingsFile())).toBe(true)
  })

  test('the operator\'s mods stay on, claude.ai connectors are off (as for restricted), and the MCP set is the allowlist\'s, not --strict-mcp-config\'s', async () => {
    const cmd = await launch()
    expect(cmd).toContain('personal')
    expect(cmd).toContain('export ENABLE_CLAUDEAI_MCP_SERVERS=false')
    expect(cmd).not.toContain('--strict-mcp-config')   // it would drop the bridge, which is a plugin's MCP server
    expect(await launch({}, null)).not.toContain('ENABLE_CLAUDEAI_MCP_SERVERS')   // an operator specialist keeps its connectors
  })

  test('`tools` is the session\'s built-in tool list from the policy; a caller\'s own list can only narrow it, never widen it; absent, no --tools at all', async () => {
    expect(await launch({}, policyOf({ tools: ['Read', 'Grep'] }))).toContain(" --tools 'Read,Grep' --settings ")
    const narrowed = await launch({ tools: ['Bash', 'Read'] }, policyOf({ tools: ['Read', 'Grep'] }))
    expect(narrowed).toContain(" --tools 'Read' --settings ")
    expect((narrowed.match(/--tools /g) ?? []).length).toBe(1)
    for (const extra of [{ resumeFrom: 'C-old' }, { forkFrom: { claudeSessionId: 'C-parent' } }]) expect(await launch(extra, policyOf({ tools: ['Read'] }))).toContain(" --tools 'Read' --settings ")
    expect(await launch({}, policyOf())).not.toContain('--tools')
  })

  test('a caller\'s list that leaves none of the policy\'s tools refuses the start, and nothing starts', async () => {
    const before = fake.calls().length
    await expect(launch({ tools: ['Bash', 'Edit'] }, policyOf({ tools: ['Read', 'Grep'] }))).rejects.toThrow(/leave none of the tools its policy lists/)
    expect(fake.calls().slice(before).some(c => c.startsWith('new-session'))).toBe(false)
  })

  test('no servers listed: no --mcp-config', async () => {
    expect(await launch({}, policyOf({ servers: [] }))).not.toContain('--mcp-config')
  })

  test('a policy without canOnlyWriteTo launches byte for byte as before (the golden shapes do not move)', async () => {
    const plain = await launch({}, null)
    expect(await launch({}, { specialist: 'gem', access: 'operator', id: 'operator' })).toBe(plain)
    expect(plain).not.toContain('--settings')
  })

  test('a start that cannot be read (id that is not its facts) refuses, and starts nothing', async () => {
    const before = fake.calls().length
    expect(policyProblem({ ...policyOf(), id: 'writes:000000000000' })).toMatch(/id does not match/)
    expect(policyProblem({ ...policyOf(), canOnlyWriteTo: { workdir: 'relative', denyCommands: [], cannotRead: [], servers: [] } })).toMatch(/no workdir/)
    expect(fake.calls().length).toBe(before)
  })
})

describe('the settings', () => {
  test('pinned exactly: the sandbox on, no unsandboxed retry, no unsandboxed commands, the write block, the deny list', async () => {
    await launch()
    expect(readJson(settingsFile())).toEqual({
      allowedMcpServers: [{ serverName: 'plugin:discord:discord' }, { serverName: 'browser' }],
      disableClaudeAiConnectors: true,
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [], filesystem: { disabled: false, denyRead: ['/home/op/.ssh', '/home/op/other'] }, enableWeakerNestedSandbox: false, autoAllowBashIfSandboxed: true },
      permissions: { blockWritesOutsideWorkingDirectories: true, allow: ['WebFetch(domain:*)'], deny: ['Read(//home/op/.ssh/**)', 'Read(//home/op/other/**)', 'Bash(rm -rf *)'] },
    })
  })

  // Each setting is the only thing standing between the session and one way out; a mutation check names which.
  test.each([
    ['the sandbox is on', (s: any) => s.sandbox.enabled, true],
    ['a machine that cannot sandbox refuses to start (no silent unsandboxed fallback)', (s: any) => s.sandbox.failIfUnavailable, true],
    ['a blocked command is not retried outside the sandbox (dangerouslyDisableSandbox is ignored)', (s: any) => s.sandbox.allowUnsandboxedCommands, false],
    ['the filesystem boundary is not switched off', (s: any) => s.sandbox.filesystem.disabled, false],
    ['no command is excluded from the sandbox by name', (s: any) => s.sandbox.excludedCommands, []],
    ['Edit, Write and NotebookEdit refuse paths outside the workdir in every permission mode', (s: any) => s.permissions.blockWritesOutsideWorkingDirectories, true],
  ])('%s', (_what, pick, want) => {
    expect(pick(confinementSettings({ denyCommands: [], cannotRead: [] }))).toEqual(want)
  })

  test.each([
    ['the allowlist is the bridge plus the listed servers, and nothing else', (s: any) => s.allowedMcpServers.map((e: any) => e.serverName), ['plugin:discord:discord', 'browser']],
    ['claude.ai connectors are off in the settings too', (s: any) => s.disableClaudeAiConnectors, true],
  ])('%s', (_what, pick, want) => {
    expect(pick(confinementSettings({ denyCommands: [], cannotRead: [], servers: [server] }))).toEqual(want)
  })

  test('with no servers listed the allowlist is the bridge alone: a server of the operator\'s is not admitted', () => {
    expect((confinementSettings({ denyCommands: [], cannotRead: [] }) as any).allowedMcpServers).toEqual([{ serverName: 'plugin:discord:discord' }])
  })

  test('no extra writable folders are granted: no allowWrite and no additionalDirectories, and the only allow rule is the one for the network', () => {
    const s: any = confinementSettings({ denyCommands: [], cannotRead: [] })
    expect(s.sandbox.filesystem.allowWrite).toBeUndefined()
    expect(s.permissions.additionalDirectories).toBeUndefined()
    expect(s.permissions.allow).toEqual(['WebFetch(domain:*)'])   // the one allow rule: it opens the sandbox proxy to any host (a bare `*` in allowedDomains is refused by Claude Code)
  })

  test('the same places are denied to the shell (sandbox denyRead, as paths) and to Read (permission rules, `//` + the absolute path), nothing more', () => {
    const s: any = confinementSettings({ denyCommands: [], cannotRead: ['/Users/op/.aws', '/Users/op/work b'] })
    expect(s.sandbox.filesystem.denyRead).toEqual(['/Users/op/.aws', '/Users/op/work b'])
    expect(s.permissions.deny).toEqual(['Read(//Users/op/.aws/**)', 'Read(//Users/op/work b/**)'])
  })
})

describe('the browser', () => {
  test('its own profile and download folders are made inside the workdir (0700), never anywhere else', async () => {
    await launch()
    for (const d of ['profile', 'downloads']) {
      expect(statSync(join(work, '.browser', d)).isDirectory()).toBe(true)
      expect(statSync(join(work, '.browser', d)).mode & 0o077).toBe(0)
    }
  })

  test('the listed server gets the folders through its own declaration, unsandboxed, with its token variable and nothing else of the environment', async () => {
    process.env.NOT_FOR_SERVERS = 'x'
    await launch()
    expect(readJson(mcpFile())).toEqual({ mcpServers: { browser: {
      type: 'stdio', command: '/usr/local/bin/browser-mcp',
      args: ['--user-data-dir', `${work}/.browser/profile`, `--downloads=${work}/.browser/downloads`],
      env: { BR_TOKEN: 'br-secret', BROWSER_HOME: `${work}/.browser/profile` },
    } } })
    expect(readFileSync(mcpFile(), 'utf8')).not.toContain('sandbox-exec')
    delete process.env.NOT_FOR_SERVERS
  })

  test('a server that needs a token the daemon does not have refuses the start, with the file to fix, and leaves no file', async () => {
    delete process.env.BR_TOKEN
    await expect(launch()).rejects.toThrow(/\[mcp_servers\.browser\] needs BR_TOKEN, which is not set/)
    expect(existsSync(settingsFile())).toBe(false)
    expect(fake.calls().filter(c => c.startsWith('new-session'))).toHaveLength(0)
  })

  test('the profile is the specialist\'s to keep: a later launch and a session\'s end leave it', async () => {
    await launch()
    writeFileSync(join(work, '.browser', 'profile', 'Cookies'), 'logged-in')
    await launch()
    removeRestrictedFiles({ tmuxName: 'sc-w', sessionId: id }, true)
    expect(readFileSync(join(work, '.browser', 'profile', 'Cookies'), 'utf8')).toBe('logged-in')
    expect(existsSync(settingsFile())).toBe(false)   // the generated files do go with the session
    expect(existsSync(mcpFile())).toBe(false)
  })
})

describe('Claude Code must be new enough to confine Edit and Write', () => {
  test('older than the first version with the write block: refused before anything is written or started', async () => {
    claudeVersion.cache = '2.1.313'
    await expect(launch()).rejects.toThrow(PolicyRefusal)
    await expect(launch()).rejects.toThrow(/Claude Code 2\.1\.313 is older than 2\.1\.314/)
    expect(existsSync(settingsFile())).toBe(false)
    expect(fake.calls().filter(c => c.startsWith('new-session'))).toHaveLength(0)
  })
  test('a version that cannot be read is a refusal, not a pass', () => {
    expect(claudeVersionRefusal({ specialist: 'gem' }, 's', () => undefined)).toMatch(/could not read `claude --version`/)
  })
  test.each([['2.1.314', true], ['2.1.326', true], ['2.2.0', true], ['3.0.0', true], ['2.1.313', false], ['2.0.999', false]])('%s is %s', (v, fine) => {
    expect(claudeVersionRefusal({ specialist: 'gem' }, 's', () => v) === undefined).toBe(fine)
    expect(MIN_CLAUDE_VERSION.join('.')).toBe('2.1.314')
  })
})

describe('the stored policy', () => {
  const cfg = (specialist: object, extra: object = {}): HydraConfig => ({
    ...EMPTY_CONFIG,
    specialists: {
      gem: { id: 'gem', workdir: work, reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, ...specialist } as any,
      other: { id: 'other', workdir: '/srv/other-specialist', reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false } as any,
    },
    mcpServers: { browser: { name: 'browser', command: server.command, tokenEnv: server.tokenEnv, tools: [], profileArgs: server.profileArgs, profileEnv: server.profileEnv } },
    ...extra,
  })

  test('born from hydra.toml: an operator policy carrying canOnlyWriteTo, with its servers\' profile declaration and its own id', () => {
    const p = bornPolicy('gem', cfg({ canOnlyWriteTo: 'workdir', cannotRead: ['/home/op/notes'], denyCommands: ['rm -rf *'], mcpServerNames: ['browser'] }))!
    expect(p.access).toBe('operator')
    const roots = readDenyRoots(hydraLoadEnv(), work, ['/srv/other-specialist'], ['/home/op/notes'])
    expect(p.canOnlyWriteTo).toEqual({ workdir: work, denyCommands: ['rm -rf *'], cannotRead: roots, servers: [server] })
    // the built-in credential places, hydra's token file, the operator's additions and the other specialists' workdirs, and not this one's own
    expect(roots).toContain(`${hydraLoadEnv().home}/.ssh`)
    expect(roots).toContain(`${hydraLoadEnv().home}/.config/gh`)
    expect(roots).toContain('/home/op/notes')
    expect(roots).toContain('/srv/other-specialist')
    expect(roots).not.toContain(work)
    expect(p.id).toBe(confinementIdFor(p.canOnlyWriteTo!))
    expect(p.id).toMatch(/^writes:[0-9a-f]{12}$/)
    expect(policyProblem(p)).toBeUndefined()
  })

  test('without can_only_write_to it is the plain operator policy', () => {
    expect(bornPolicy('gem', cfg({}))).toEqual({ specialist: 'gem', access: 'operator', id: 'operator' })
  })

  test('the id changes with the folder, a deny pattern, a server\'s command, token variable or profile declaration, and with nothing else', () => {
    const a = policyOf().canOnlyWriteTo!
    const ids = new Set([
      confinementIdFor(a), confinementIdFor({ ...a, workdir: '/other' }), confinementIdFor({ ...a, denyCommands: [] }), confinementIdFor({ ...a, cannotRead: [] }), confinementIdFor({ ...a, tools: ['Read'] }), confinementIdFor({ ...a, tools: ['Read', 'Bash'] }),
      confinementIdFor({ ...a, servers: [{ ...server, command: '/other' }] }), confinementIdFor({ ...a, servers: [{ ...server, tokenEnv: [] }] }),
      confinementIdFor({ ...a, servers: [{ ...server, profileArgs: ['{profile_dir}'] }] }), confinementIdFor({ ...a, servers: [{ ...server, profileEnv: {} }] }),
    ])
    expect(ids.size).toBe(10)
    expect(confinementIdFor({ ...a, tools: ['Bash', 'Read'] })).toBe(confinementIdFor({ ...a, tools: ['Read', 'Bash'] }))
    expect(confinementIdFor({ ...a, denyCommands: ['rm -rf *'].reverse() })).toBe(confinementIdFor(a))
  })

  test('an id from before `tools` existed still validates and still matches: the key is added only when tools is set', () => {
    const a = policyOf().canOnlyWriteTo!
    // the identity as it was written before `tools` was a field (same keys, same order)
    const old = `writes:${createHash('sha256').update(JSON.stringify({ workdir: a.workdir, deny: [...a.denyCommands].sort(), noRead: [...a.cannotRead].sort(), servers: a.servers.map(s => ({ name: s.name, command: s.command, tokenEnv: [...s.tokenEnv].sort(), args: s.profileArgs, env: Object.entries(s.profileEnv).sort(([x], [y]) => x.localeCompare(y)) })) })).digest('hex').slice(0, 12)}`
    expect(confinementIdFor(a)).toBe(old)
    expect(policyProblem({ specialist: 'gem', access: 'operator', canOnlyWriteTo: a, id: old })).toBeUndefined()
    expect(confinementIdFor({ ...a, tools: ['Read'] })).not.toBe(old)
  })

  test('a change of can_only_write_to is noticed: set, removed, a new folder, deny list or server', () => {
    const none: LaunchPolicy = { specialist: 'gem', access: 'operator', id: 'operator' }
    const w = policyOf()
    expect(policyDrifted(none, w)).toEqual(['can_only_write_to: none -> "workdir"'])
    expect(policyDrifted(w, none)).toEqual(['can_only_write_to: "workdir" -> none'])
    expect(policyDrifted(w, w)).toEqual([])
    expect(policyDrifted(w, policyOf({ workdir: '/else' }))).toEqual([`can_only_write_to folder: ${work} -> /else`])
    expect(policyDrifted(w, policyOf({ denyCommands: [] }))).toEqual(['deny_commands: rm -rf * -> '])
    expect(policyDrifted(w, policyOf({ tools: ['Read'] }))).toEqual(['tools: all -> Read'])
    expect(policyDrifted(policyOf({ tools: ['Read'] }), w)).toEqual(['tools: Read -> all'])
    expect(policyDrifted(policyOf({ tools: ['Read', 'Bash'] }), policyOf({ tools: ['Bash', 'Read'] }))).toEqual([])
    expect(policyDrifted(w, policyOf({ cannotRead: ['/home/op/.ssh'] }))).toEqual(['cannot_read: /home/op/.ssh | /home/op/other -> /home/op/.ssh'])
    expect(policyDrifted(w, policyOf({ servers: [] }))).toEqual(['mcp browser: listed -> not listed'])
    expect(policyDrifted(w, policyOf({ servers: [{ ...server, profileArgs: ['{profile_dir}'] }] }))).toEqual(['mcp browser: command, token_env or profile declaration changed'])
  })

  test('it is not confused with restricted: restricted -> can_only_write_to is a change of restricted', () => {
    const restricted = { specialist: 'gem', access: 'workdir', workdir: '/w', tools: ['Read'], servers: [], id: 'x' } as LaunchPolicy
    expect(policyDrifted(restricted, policyOf())).toEqual(['restricted: true -> false'])
  })

  test('described in words for a log line and the thread', () => {
    expect(describePolicy(policyOf())).toBe(`restricted = false, can_only_write_to = "workdir" (folder ${work}; tools all; cannot_read 2 places; mcp_servers browser; deny_commands rm -rf *)`)
    expect(describePolicy({ specialist: 'gem', access: 'operator', id: 'operator' })).toBe('restricted = false')
  })
})

describe('the start check reads the rules Claude Code applied (claude-verify.ts)', () => {
  const T = '2026-11-13T04:34:18.000Z [DEBUG] '
  const log = (lines: string[]) => lines.map(l => T + l).join('\n') + '\n'
  const rules = { allow: ['WebFetch(domain:*)'], deny: ['Read(//home/op/.ssh/**)', 'Bash(rm -rf *)'], servers: ['plugin:discord:discord', 'browser'] }
  const ok = [`MCP server "plugin:discord:discord": Successfully connected (transport: stdio) in 9ms`, `MCP server "browser": Successfully connected (transport: stdio) in 9ms`, '[claudeai-mcp] Disabled via env var']
  test('both lists, under flagSettings, as Adding and as Replacing all', () => {
    const got = readLoaded(log([
      `Applying permission update: Adding 1 allow rule(s) to destination 'flagSettings': ${JSON.stringify(rules.allow)}`,
      `Applying permission update: Replacing all deny rules for destination 'flagSettings' with 2 rule(s): ${JSON.stringify(rules.deny)}`,
      ...ok,
    ]))
    expect(got.allow).toEqual(rules.allow)
    expect(got.deny).toEqual(rules.deny)
    expect(confinementShortfall(rules, got)).toEqual([])
  })
  test('a deny rule from another destination does not count as the launch\'s', () => {
    const got = readLoaded(log([`Applying permission update: Adding 2 deny rule(s) to destination 'userSettings': ${JSON.stringify(rules.deny)}`, `Adding 1 allow rule(s) to destination 'flagSettings': ${JSON.stringify(rules.allow)}`, ...ok]))
    expect(confinementShortfall(rules, got)[0]).toMatch(/did not apply these deny rules: .*Read\(\/\/home\/op\/\.ssh\/\*\*\)/)
  })
  test('a missing rule is named; nothing applied names every one', () => {
    expect(confinementShortfall(rules, readLoaded(''))).toHaveLength(4)
  })
  const base = [`Adding 1 allow rule(s) to destination 'flagSettings': ${JSON.stringify(rules.allow)}`, `Adding 2 deny rule(s) to destination 'flagSettings': ${JSON.stringify(rules.deny)}`]
  test('a server beyond the bridge and the listed ones is refused as soon as it starts (an operator\'s, a plugin\'s, a connector)', () => {
    const got = readLoaded(log([...base, ...ok, 'MCP server "plugin:slack:slack": Starting connection with timeout of 30000ms']))
    expect(confinementSurplus(rules, got)).toEqual(['it started MCP servers the policy does not give it: `plugin:slack:slack`'])
    expect(confinementSurplus(rules, readLoaded(log([...base, ...ok])))).toEqual([])
  })
  test('claude.ai connector activity is refused; the "Disabled via env var" line is required', () => {
    expect(confinementSurplus(rules, readLoaded(log([...base, ...ok, '[claudeai-mcp] Fetching connectors']))).join()).toMatch(/connectors were not off/)
    expect(confinementShortfall(rules, readLoaded(log([...base, ...ok.slice(0, 2)])))).toEqual([expect.stringMatching(/nothing says claude\.ai connectors were off/)])
  })
  test('the bridge not connecting names the allowlist as the likely cause', () => {
    const got = readLoaded(log([...base, 'MCP server "browser": Successfully connected (transport: stdio) in 9ms', '[claudeai-mcp] Disabled via env var']))
    expect(confinementShortfall(rules, got)[0]).toMatch(/did not connect: `plugin:discord:discord`.*allowlist may have refused/)
  })
  test('a server that starts after the expected ones connected is caught by the settle read, not passed on the first look', async () => {
    const first = log([...base, ...ok]), second = log([...base, ...ok, 'MCP server "plugin:slack:slack": Starting connection with timeout of 30000ms'])
    let reads = 0
    const v = await verifyConfinement(rules, '/f', { ...verifyDeps, read: () => (++reads === 1 ? first : second), sleep: async () => {}, settleMs: 1 })
    expect(v).toMatchObject({ ok: false })
    expect((v as any).why).toMatch(/started MCP servers the policy does not give it: `plugin:slack:slack`/)
    expect(reads).toBe(2)
  })
  test('a late connector line is caught the same way', async () => {
    let reads = 0
    const v = await verifyConfinement(rules, '/f', { ...verifyDeps, read: () => (++reads === 1 ? log([...base, ...ok]) : log([...base, ...ok, '[claudeai-mcp] Fetching connectors'])), sleep: async () => {}, settleMs: 1 })
    expect((v as any).why).toMatch(/connectors were not off/)
  })
  test('a clean file passes after the settle read', async () => {
    expect(await verifyConfinement(rules, '/f', { ...verifyDeps, read: () => log([...base, ...ok]), sleep: async () => {}, settleMs: 1 })).toEqual({ ok: true })
  })
  test('the bridge not connecting is refused a set time after its settings loaded (the rules and the connectors line), not at the deadline, and the elapsed time is from then', async () => {
    let t = 0
    const noBridge = log([...base, 'MCP server "browser": Successfully connected (transport: stdio) in 9ms', '[claudeai-mcp] Disabled via env var'])
    const v = await verifyConfinement(rules, '/f', { ...verifyDeps, read: () => noBridge, now: () => (t += 4_000), sleep: async () => {}, deadlineMs: 45_000 })
    expect((v as any).why).toMatch(/did not connect: `plugin:discord:discord`.*allowlist may have refused it by name.*its settings were loaded 2\d+s ago and the bridge still has not connected/)
    expect(t).toBeLessThan(40_000)
  })
  test('a cold start whose settings load late is not refused for the time before they loaded', async () => {
    let t = 0, reads = 0
    const slow = log(['Starting up'])
    const loaded = log([...base, ...ok.slice(1, 2).map(() => 'MCP server "browser": Successfully connected (transport: stdio) in 9ms'), '[claudeai-mcp] Disabled via env var'])
    const connected = log([...base, ...ok])
    // 40 s of nothing, then the settings load, then the bridge connects 8 s later: a timer from the start would have refused at 20 s
    const v = await verifyConfinement(rules, '/f', { ...verifyDeps, read: () => (t < 40_000 ? slow : t < 48_000 ? loaded : connected), now: () => t, sleep: async (ms: number) => { t += ms; reads++ }, settleMs: 1, deadlineMs: 120_000, pollMs: 4_000 })
    expect(v).toEqual({ ok: true })
  })
  test('a file that cannot be read refuses at the deadline, with the cause', async () => {
    let t = 0
    const v = await verifyConfinement(rules, '/nope', { ...verifyDeps, read: () => { throw new Error('ENOENT') }, now: () => (t += 20_000), sleep: async () => {}, deadlineMs: 45_000 })
    expect(v).toMatchObject({ ok: false })
    expect((v as any).why).toMatch(/could not be read within 45s \(ENOENT\)/)
  })
})
