// `can_only_write_to = "workdir"`: what every start of such a specialist's session launches with, and how its stored policy is read and compared.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { CLAUDE_CONFIG, STATE_DIR } from '../config.js'
import { PolicyRefusal, bornPolicy, describePolicy, policyDrifted, policyProblem, confinementIdFor, type LaunchPolicy } from '../restricted.js'
import { removeRestrictedFiles, restrictedDir } from '../restricted-files.js'
import { confinementShortfall, confinementSurplus, readLoaded, verifyConfinement, verifyDeps } from '../engines/claude-verify.js'
import { bridgeServerCommands, claudeSettingsProblems, MIN_CLAUDE_VERSION, claudeVersion, claudeVersionRefusal, confinementMcp, confinementRules, confinementSettings } from '../write-confinement.js'
import { EMPTY_CONFIG } from '../../config/load.js'
import { readDenyRoots } from '../../config/write-confinement.js'
import { hydraLoadEnv } from '../hydra-config.js'
import type { HydraConfig } from '../../config/types.js'
import { _resetSourcedEnvNamesForTesting, sourceEnvFiles } from '../../shared/env-parse.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

let work: string
let fake: FakeTmux
let savedVersion: string | undefined
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'write-confinement-'))
  mkdirSync(join(CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord', '0.0.4'), { recursive: true })   // the bridge plugin the daemon syncs at boot
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
  return { specialist: 'gem', restricted: false, canOnlyWriteTo, id: confinementIdFor(canOnlyWriteTo) }
}
const bridgeCmd = (real = false) => ['bun', 'run', '--cwd', join(real ? realpathSync(CLAUDE_CONFIG) : CLAUDE_CONFIG, 'plugins', 'cache', 'claude-plugins-official', 'discord', '0.0.4'), '--shell=bun', '--silent', 'start']
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
    expect(cmd).toContain(` --settings '<state>/restricted/sc-w-<uuid>.settings.json' --mcp-config '<state>/restricted/sc-w-<uuid>.mcp.json'`)
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

  test('every start tells its bridge it is write-confined (HYDRA_WRITE_CONFINED), so a record that is gone cannot widen it; no other launch does', async () => {
    for (const extra of [{}, { resumeFrom: 'C-old' }, { forkFrom: { claudeSessionId: 'C-parent' } }]) expect(await launch(extra)).toContain("export HYDRA_WRITE_CONFINED=1")
    expect(await launch({}, null)).not.toContain('HYDRA_WRITE_CONFINED')
  })

  test('a write-confined session keeps only the allowlisted part of the state .env: every other name it sets is unset, on every shape; no other launch has the line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'confined-env-'))
    writeFileSync(join(dir, '.env'), 'FAKE_SERVER_KEY=1\nHYDRA_MODEL=m\nCHAT_PLATFORM=discord\n')
    const was = process.env.FAKE_SERVER_KEY
    try {
      sourceEnvFiles([join(dir, '.env')])
      for (const extra of [{}, { resumeFrom: 'C-old' }, { forkFrom: { claudeSessionId: 'C-parent' } }]) expect(await launch(extra)).toContain('unset FAKE_SERVER_KEY && ')
      expect(await launch({}, null)).not.toContain('unset FAKE_SERVER_KEY')
    } finally {
      if (was === undefined) delete process.env.FAKE_SERVER_KEY; else process.env.FAKE_SERVER_KEY = was
      _resetSourcedEnvNamesForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no servers listed: no --mcp-config', async () => {
    expect(await launch({}, policyOf({ servers: [] }))).not.toContain('--mcp-config')
  })

  test('a policy without canOnlyWriteTo launches byte for byte as before (the golden shapes do not move)', async () => {
    const plain = await launch({}, null)
    expect(await launch({}, { specialist: 'gem', restricted: false, id: 'operator' })).toBe(plain)
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
      allowedMcpServers: [{ serverCommand: ['/usr/local/bin/browser-mcp', '--user-data-dir', join(work, '.browser', 'profile'), `--downloads=${join(work, '.browser', 'downloads')}`] }, ...[...new Map([bridgeCmd(), bridgeCmd(true)].map(c => [c.join('\0'), { serverCommand: c }])).values()]],
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

  test('the allowlist is each listed server and the bridge by the exact command it runs (never a `serverName`, never a `plugin:` key)', () => {
    const cmd = ['bun', 'run', '--cwd', '/cfg/plugins/cache/claude-plugins-official/discord/0.0.4', '--shell=bun', '--silent', 'start']
    const s: any = confinementSettings({ denyCommands: [], cannotRead: [], workdir: '/w', servers: [server], bridgeCommands: [cmd] })
    expect(s.allowedMcpServers).toEqual([{ serverCommand: ['/usr/local/bin/browser-mcp', '--user-data-dir', '/w/.browser/profile', '--downloads=/w/.browser/downloads'] }, { serverCommand: cmd }])
    expect(claudeSettingsProblems(s)).toEqual([])
    expect(s.disableClaudeAiConnectors).toBe(true)
  })

  // Claude Code 2.1.326 matches a stdio server by its full command once any serverCommand entry (the bridge's) exists: a name no longer admits it. See #772.
  test('the allowlist admits the MCP config it ships with: every server\'s command, as the config runs it, is an entry', () => {
    const policy = { specialist: 's', workdir: '/w', denyCommands: [], cannotRead: [], servers: [server, { ...server, name: 'second', command: 'npx', profileArgs: ['-y', 'pkg', '--out', '{download_dir}'] }], browserProfile: '/w/p1' }
    const mcp: any = confinementMcp(policy, 's', { BR_TOKEN: 't' }, {}, '/env')
    const entries = new Set(((confinementSettings({ ...policy, bridgeCommands: [['bun', 'run', 'x']] }) as any).allowedMcpServers as any[]).map(e => JSON.stringify(e.serverCommand)))
    expect(Object.keys(mcp.mcpServers)).toEqual(['browser', 'second'])
    for (const [name, c] of Object.entries<any>(mcp.mcpServers)) expect([name, entries.has(JSON.stringify([c.command, ...c.args]))]).toEqual([name, true])
    expect(entries.has(JSON.stringify(['/usr/local/bin/browser-mcp', '--user-data-dir', '/w/p1', '--downloads=/w/p1-downloads']))).toBe(true)
  })

  test('with no servers listed the allowlist is the bridge alone', () => {
    const cmd = ['bun', 'run', '--cwd', '/x', '--shell=bun', '--silent', 'start']
    expect((confinementSettings({ denyCommands: [], cannotRead: [], bridgeCommands: [cmd] }) as any).allowedMcpServers).toEqual([{ serverCommand: cmd }])
  })

  // The regression: the first allowlist named the bridge `plugin:discord:discord`. Claude Code's schema is ^[a-zA-Z0-9_-]+$ for serverName; it stopped at an interactive
  // "Settings Warning" (real pane text pinned in fixtures/confinement-settings-warning.txt) and never started MCP.
  test('an entry Claude Code\'s schema rejects is found before launch: the colon-named bridge of the regression, an empty command, an entry naming nothing', () => {
    expect(claudeSettingsProblems({ allowedMcpServers: [{ serverName: 'plugin:discord:discord' }] })).toEqual(['allowedMcpServers[0]: server name "plugin:discord:discord" can only contain letters, numbers, hyphens and underscores'])
    expect(claudeSettingsProblems({ allowedMcpServers: [{ serverCommand: [] }, {}] })).toEqual(['allowedMcpServers[0]: serverCommand must be a non-empty list of strings', 'allowedMcpServers[1]: names no server'])
    expect(claudeSettingsProblems({ allowedMcpServers: [{ serverName: 'ok_name-1' }] })).toEqual([])
  })
  test('the real pane text of the regression names the entry and the rule', () => {
    const pane = readFileSync(join(import.meta.dir, 'fixtures', 'confinement-settings-warning.txt'), 'utf8')
    expect(pane).toContain('allowedMcpServers[0]')
    expect(pane).toContain('Server name can only contain letters, numbers, hyphens, and underscores')
  })

  const deps = (files: Record<string, string>, folders: Record<string, string[]> = {}, real: (p: string) => string = p => p) => ({
    read: (p: string) => { if (p in files) return files[p]; throw new Error('ENOENT') },
    list: (d: string) => { if (d in folders) return folders[d]; throw new Error('ENOENT') },
    exists: () => true,   // every folder named exists here; the last test is the one where none does
    real,
  })
  const CACHE = '/cfg/plugins/cache/claude-plugins-official/discord'
  test('the bridge commands use the manifest\'s own command string (bare `bun`), from the install path installed_plugins.json records, and the marketplace source folder; each as written and as resolved', () => {
    const files = { '/cfg/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'discord@claude-plugins-official': [{ scope: 'user', installPath: `${CACHE}/0.0.4`, version: '0.0.4' }] } }) }
    const got = bridgeServerCommands('/cfg', deps(files, {}, p => (p.endsWith('0.0.4') ? '/real/discord/0.0.4' : p)))
    expect(got.map(c => c[3])).toEqual([`${CACHE}/0.0.4`, '/real/discord/0.0.4', '/cfg/plugins/marketplaces/claude-plugins-official/external_plugins/discord'])
    for (const c of got) expect([c[0], c[1], c[2], ...c.slice(4)]).toEqual(['bun', 'run', '--cwd', '--shell=bun', '--silent', 'start'])
  })
  test('one rule: installed_plugins.json decides; a stale version folder is not admitted beside it; with no record, every version folder is', () => {
    const files = { '/cfg/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'discord@claude-plugins-official': [{ installPath: `${CACHE}/0.0.5` }] } }) }
    const withRecord = bridgeServerCommands('/cfg', deps(files, { [CACHE]: ['0.0.3', '0.0.5'] })).map(c => c[3])
    expect(withRecord).toContain(`${CACHE}/0.0.5`)
    expect(withRecord).not.toContain(`${CACHE}/0.0.3`)
    const without = bridgeServerCommands('/cfg', deps({}, { [CACHE]: ['0.0.3', '0.0.4'] })).map(c => c[3])
    expect(without).toEqual(expect.arrayContaining([`${CACHE}/0.0.3`, `${CACHE}/0.0.4`]))
  })
  test('nothing synced and no marketplace folder: no commands', () => {
    expect(bridgeServerCommands('/cfg', { read: () => { throw new Error('ENOENT') }, list: () => { throw new Error('ENOENT') }, exists: () => false, real: p => p })).toEqual([])
  })

  test('a launch with no bridge plugin synced refuses and writes nothing (the session could never reach its thread)', async () => {
    rmSync(join(CLAUDE_CONFIG, 'plugins'), { recursive: true, force: true })
    await expect(launch()).rejects.toThrow(/hydra's bridge plugin is not synced/)
    expect(existsSync(settingsFile())).toBe(false)
  })

  test('the written settings carry the bridge command for each synced folder', async () => {
    await launch()
    const got = readJson(settingsFile()).allowedMcpServers
    expect(got[0]).toEqual({ serverCommand: ['/usr/local/bin/browser-mcp', '--user-data-dir', join(work, '.browser', 'profile'), `--downloads=${join(work, '.browser', 'downloads')}`] })
    expect(got.slice(1).every((e: any) => e.serverCommand[0] === 'bun' && e.serverCommand[3].includes('/plugins/cache/claude-plugins-official/discord/0.0.4'))).toBe(true)
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

  test('an existing profile or download folder is brought to 0700 too (adopted, not only created)', async () => {
    for (const d of ['profile', 'downloads']) { mkdirSync(join(work, '.browser', d), { recursive: true }); chmodSync(join(work, '.browser', d), 0o755) }
    await launch()
    for (const d of ['profile', 'downloads']) expect(statSync(join(work, '.browser', d)).mode & 0o777).toBe(0o700)
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

  test('a named browser profile is the server\'s exactly: its folder and the download folder beside it, made 0700, and no .browser default is made', async () => {
    const named = join(work, 'deep', 'chrome')
    await launch({}, policyOf({ browserProfile: named }))
    expect(readJson(mcpFile()).mcpServers.browser.args).toEqual(['--user-data-dir', named, `--downloads=${named}-downloads`])
    expect(readJson(mcpFile()).mcpServers.browser.env.BROWSER_HOME).toBe(named)
    for (const d of [named, `${named}-downloads`]) { expect(statSync(d).isDirectory()).toBe(true); expect(statSync(d).mode & 0o077).toBe(0) }
    expect(existsSync(join(work, '.browser'))).toBe(false)
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

  test('born from hydra.toml: a listed server\'s deny_tools reach the policy (and none, no key)', () => {
    const withDeny = cfg({ canOnlyWriteTo: 'workdir', mcpServerNames: ['browser'] }, { mcpServers: { browser: { name: 'browser', command: server.command, tokenEnv: server.tokenEnv, tools: [], profileArgs: server.profileArgs, profileEnv: server.profileEnv, denyTools: ['browser_run_code_unsafe'] } } })
    expect(bornPolicy('gem', withDeny)!.canOnlyWriteTo!.servers[0].denyTools).toEqual(['browser_run_code_unsafe'])
    expect('denyTools' in bornPolicy('gem', cfg({ canOnlyWriteTo: 'workdir', mcpServerNames: ['browser'] }))!.canOnlyWriteTo!.servers[0]).toBe(false)
  })

  test('born from hydra.toml: an operator policy carrying canOnlyWriteTo, with its servers\' profile declaration and its own id', () => {
    const p = bornPolicy('gem', cfg({ canOnlyWriteTo: 'workdir', cannotRead: ['/home/op/notes'], denyCommands: ['rm -rf *'], mcpServerNames: ['browser'] }))!
    expect(p.restricted).toBe(false)
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
    expect(bornPolicy('gem', cfg({}))).toEqual({ specialist: 'gem', restricted: false, id: 'operator' })
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
    expect(policyProblem({ specialist: 'gem', restricted: false, canOnlyWriteTo: a, id: old })).toBeUndefined()
    expect(confinementIdFor({ ...a, tools: ['Read'] })).not.toBe(old)
    expect(confinementIdFor({ ...a, browserProfile: '/w/chrome' })).not.toBe(old)
    expect(policyProblem({ ...policyOf(), canOnlyWriteTo: { ...a, browserProfile: 'relative' } })).toMatch(/no readable browser profile/)
  })

  test('a change of can_only_write_to is noticed: set, removed, a new folder, deny list or server', () => {
    const none: LaunchPolicy = { specialist: 'gem', restricted: false, id: 'operator' }
    const w = policyOf()
    expect(policyDrifted(none, w)).toEqual(['can_only_write_to: none -> "workdir"'])
    expect(policyDrifted(w, none)).toEqual(['can_only_write_to: "workdir" -> none'])
    expect(policyDrifted(w, w)).toEqual([])
    expect(policyDrifted(w, policyOf({ workdir: '/else' }))).toEqual([`can_only_write_to folder: ${work} -> /else`])
    expect(policyDrifted(w, policyOf({ denyCommands: [] }))).toEqual(['deny_commands: rm -rf * -> '])
    expect(policyDrifted(w, policyOf({ tools: ['Read'] }))).toEqual(['tools: all -> Read'])
    expect(policyDrifted(w, policyOf({ browserProfile: '/w/chrome' }))).toEqual(['browser_profile: default -> /w/chrome'])
    expect(policyDrifted(policyOf({ browserProfile: '/w/a' }), policyOf({ browserProfile: '/w/b' }))).toEqual(['browser_profile: /w/a -> /w/b'])
    expect(policyDrifted(policyOf({ tools: ['Read'] }), w)).toEqual(['tools: Read -> all'])
    expect(policyDrifted(policyOf({ tools: ['Read', 'Bash'] }), policyOf({ tools: ['Bash', 'Read'] }))).toEqual([])
    expect(policyDrifted(w, policyOf({ cannotRead: ['/home/op/.ssh'] }))).toEqual(['cannot_read: /home/op/.ssh | /home/op/other -> /home/op/.ssh'])
    expect(policyDrifted(w, policyOf({ servers: [] }))).toEqual(['mcp browser: listed -> not listed'])
    expect(policyDrifted(w, policyOf({ servers: [{ ...server, profileArgs: ['{profile_dir}'] }] }))).toEqual(['mcp browser: command, token_env or profile declaration changed'])
  })

  test('it is not confused with restricted: restricted -> can_only_write_to is a change of restricted', () => {
    const restricted = { specialist: 'gem', restricted: true, workdir: '/w', tools: ['Read'], servers: [], id: 'x' } as LaunchPolicy
    expect(policyDrifted(restricted, policyOf())).toEqual(['restricted: true -> false'])
  })

  test('described in words for a log line and the thread', () => {
    expect(describePolicy(policyOf())).toBe(`restricted = false, can_only_write_to = "workdir" (folder ${work}; tools all; cannot_read 2 places; mcp_servers browser; deny_commands rm -rf *)`)
    expect(describePolicy({ specialist: 'gem', restricted: false, id: 'operator' })).toBe('restricted = false')
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

describe('the real debug files of the regression (fixtures, sanitised)', () => {
  const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')
  const want = { allow: ['WebFetch(domain:*)'], deny: ['Read(//home/op/.ssh/**)', 'Read(//home/op/.aws/**)'], servers: ['plugin:discord:discord'] }
  test('a start stuck at the settings dialog: rules applied, MCP never resolved; refused, with the dialog named as the likely cause', () => {
    const got = readLoaded(fx('confined-start-hung.debug.txt'))
    expect(got.mcpConfigsLoading).toBe(true)
    expect(got.mcpConfigsResolved).toBe(false)
    expect(got.allow).toEqual(['WebFetch(domain:*)'])
    const short = confinementShortfall({ ...want, deny: got.deny ?? [] }, got)
    expect(short.join('\n')).toMatch(/never finished loading its MCP configs.*Settings Warning/)
    expect(short.join('\n')).toMatch(/did not connect: `plugin:discord:discord`/)
    expect(short.join('\n')).toMatch(/nothing says claude\.ai connectors were off/)
  })
  test('a working start\'s real lines: MCP resolved, the bridge starts and connects under its `plugin:` key', () => {
    const got = readLoaded(fx('confined-start-working.debug.txt'))
    expect(got.mcpConfigsResolved).toBe(true)
    expect(got.connected).toEqual(['plugin:discord:discord'])
    expect(confinementSurplus(want, got)).toEqual([])
  })
})

describe('what Claude Code 2.1.326 writes for the allowlist, from a real `claude -p` run (write-confinement-mcp.live.test.ts; fixtures, sanitised)', () => {
  const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')
  test('a server admitted by name, and a plugin\'s server admitted by its exact command, both start and connect; connectors off by the environment variable', () => {
    for (const [file, key] of [['allowlist-admitted-by-name.debug.txt', 'alpha'], ['allowlist-plugin-admitted-by-command.debug.txt', 'plugin:probebridge:probebridge']] as const) {
      const got = readLoaded(fx(file))
      expect(got.mcpConfigsResolved).toBe(true)
      expect(got.connected).toEqual([key])
      expect(got.connectorsOff).toBe(true)
      expect(confinementShortfall({ allow: [], deny: [], servers: [key] }, { ...got, allow: [], deny: [] })).toEqual([])
    }
  })
  test('a server the allowlist refuses is silent in the log (no line at all): only its absence shows, so the start check requires every expected server to connect', () => {
    const got = readLoaded(fx('allowlist-plugin-refused.debug.txt'))
    expect(got.mcpConfigsResolved).toBe(true)
    expect(got.servers).toEqual([])
    expect(confinementShortfall({ allow: [], deny: [], servers: ['plugin:probebridge:probebridge'] }, { ...got, allow: [], deny: [] }).join('\n')).toMatch(/did not connect: `plugin:probebridge:probebridge`/)
  })
  test('an invalid entry is skipped in an automated session with this line, and stops at a dialog in an interactive one (the regression)', () => {
    expect(fx('allowlist-invalid-entry-skipped.debug.txt')).toMatch(/Invalid entry was ignored: Server name can only contain letters, numbers, hyphens, and underscores/)
  })
})

describe('a listed server\'s deny_tools', () => {
  const a = { workdir: '/w', denyCommands: [] as string[], cannotRead: ['/s'] }
  const rule = 'mcp__browser__browser_run_code_unsafe'
  const denies = (servers: any[]) => ((confinementSettings({ ...a, servers }) as any).permissions.deny as string[])
  test('each becomes a permissions.deny rule mcp__<server>__<tool>, beside the read and command rules; none without it', () => {
    expect(denies([{ ...server, denyTools: ['browser_run_code_unsafe'] }])).toContain(rule)
    expect(denies([{ ...server, denyTools: ['browser_run_code_unsafe'] }]).filter(r => r.startsWith('mcp__'))).toEqual([rule])
    expect(denies([server]).filter(r => r.startsWith('mcp__'))).toEqual([])
    expect(denies([{ ...server, denyTools: [] }]).filter(r => r.startsWith('mcp__'))).toEqual([])
  })
  test('the start check expects the same rules (confinementRules)', () => {
    expect(confinementRules({ ...a, servers: [{ ...server, denyTools: ['browser_run_code_unsafe'] }] } as any).deny).toContain(rule)
  })
  test('the policy id changes with the list and with nothing else; a server with none keeps the id it had', () => {
    const base = { ...a, tools: undefined, servers: [server] } as any
    const withDeny = { ...a, servers: [{ ...server, denyTools: ['browser_run_code_unsafe'] }] } as any
    expect(confinementIdFor(withDeny)).not.toBe(confinementIdFor(base))
    expect(confinementIdFor({ ...a, servers: [{ ...server, denyTools: ['b', 'a'] }] } as any)).toBe(confinementIdFor({ ...a, servers: [{ ...server, denyTools: ['a', 'b'] }] } as any))
    expect(confinementIdFor({ ...a, servers: [{ ...server, denyTools: [] }] } as any)).toBe(confinementIdFor({ ...a, servers: [server] } as any))
  })
  test('a stored denyTools that is not a list of strings is not a readable policy (it would otherwise be silently dropped)', () => {
    const mk = (denyTools: unknown) => { const w = { ...a, servers: [{ ...server, denyTools }] } as any; return { specialist: 'gem', restricted: false, canOnlyWriteTo: w, id: confinementIdFor({ ...a, servers: [server] } as any) } as any }
    expect(policyProblem(mk([1]))).toBe('its can_only_write_to has no readable server list')
    expect(policyProblem(mk('x'))).toBe('its can_only_write_to has no readable server list')
  })
  test('the drift check ignores the order of deny_tools', () => {
    const p = (denyTools: string[]) => { const w = { ...a, servers: [{ ...server, denyTools }] } as any; return { specialist: 'gem', restricted: false, canOnlyWriteTo: w, id: confinementIdFor(w) } as any }
    expect(policyDrifted(p(['a', 'b']), p(['b', 'a']))).toEqual([])
  })
  test('a stored policy from before the key (no denyTools on its servers) is still read, and a changed list is a drift', () => {
    const old = { specialist: 'gem', restricted: false, canOnlyWriteTo: { ...a, servers: [server] }, id: '' } as any
    old.id = confinementIdFor(old.canOnlyWriteTo)
    expect(policyProblem(old)).toBeUndefined()
    const changed = { ...old, canOnlyWriteTo: { ...a, servers: [{ ...server, denyTools: ['x'] }] } } as any
    changed.id = confinementIdFor(changed.canOnlyWriteTo)
    expect(policyDrifted(old, changed)).toEqual(['mcp browser: deny_tools changed'])
  })
})
