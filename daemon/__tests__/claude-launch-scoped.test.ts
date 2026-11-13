// The Claude launch command for a scoped specialist (access = "workdir"), on each shape, and the files it generates.
// The non-scoped shapes are pinned in claude-launch-argv.golden.test.ts and must not move.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ClaudeEngine, scopedConfig, SCOPED_MODS } from '../engines/claude-engine.js'
import { STATE_DIR, CLAUDE_CONFIG, SOCK_PATH } from '../config.js'
import { PolicyRefusal, policyIdFor, type ConfinedPolicy } from '../scope.js'
import { removeScopedFiles, scopedDir } from '../scoped-files.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

process.stderr.write = (() => true) as any

const servers = [{ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs', 'get_monitor'] }]
const policy: ConfinedPolicy = {
  specialist: 'ops', access: 'workdir', workdir: '/work/ops', tools: ['Read', 'Grep', 'Glob'], servers,
  id: policyIdFor('/work/ops', ['Read', 'Grep', 'Glob'], servers),
}
const scope = policy
const base = { sessionId: '11111111-1111-4111-8111-111111111111', tmuxName: 'sc-t', cwd: '/work/ops', originalCwd: '/work/ops', model: 'claude-opus-4-1', prompt: "it's a prompt", sessionType: 'scoped' as const, policy }

let fake: FakeTmux
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  rmSync(scopedDir(), { recursive: true, force: true })
  fake = withFakeTmux()
  for (const k of ['DD_API_KEY', 'GITHUB_TOKEN', 'DISCORD_BOT_TOKEN']) saved[k] = process.env[k]
  process.env.DD_API_KEY = 'dd-secret'; process.env.GITHUB_TOKEN = 'gh-secret'
  mkdirSync(join(STATE_DIR, 'mods', 'hydra'), { recursive: true }); writeFileSync(join(STATE_DIR, 'mods', 'hydra', 'plugin.json'), '{}')
  mkdirSync(join(STATE_DIR, 'mods', 'personal'), { recursive: true }); writeFileSync(join(STATE_DIR, 'mods', 'personal', 'plugin.json'), '{}')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fake.restore()
})

const mask = (s: string) => s
  .replaceAll(STATE_DIR, '<state>').replaceAll(CLAUDE_CONFIG, '<claude-config>').replaceAll(SOCK_PATH, '<sock>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
async function launch(extra: Record<string, unknown> = {}): Promise<string> {
  await new ClaudeEngine({} as any).launch({ ...base, ...extra } as any)
  const call = fake.calls().findLast(c => c.startsWith('new-session'))
  if (!call) throw new Error('no new-session call')
  return mask(call)
}

describe('argv', () => {
  test('fresh, resume and fork are pinned byte for byte', async () => {
    expect(await launch()).toMatchSnapshot('fresh')
    expect(await launch({ resumeFrom: 'C-old' })).toMatchSnapshot('resume')
    expect(await launch({ forkFrom: { claudeSessionId: 'C-parent' } })).toMatchSnapshot('fork')
  })

  test('the prompt comes before every variadic flag, and the confinement flags follow the channel', async () => {
    const cmd = await launch()
    const claude = cmd.slice(cmd.indexOf('claude --session-id'))
    expect(claude).toContain(`--model 'claude-opus-4-1' 'it'\\''s a prompt' --channels 'plugin:discord@claude-plugins-official' --restricted --tools 'Read,Grep,Glob' --settings `)
    expect(claude.indexOf("'it'\\''s a prompt'")).toBeLessThan(claude.indexOf('--channels'))
    expect(claude).toMatch(/--mcp-config '[^']+' --permission-mode dontAsk --debug-file /)
  })

  test('there is no --dangerously-skip-permissions on any shape', async () => {
    for (const extra of [{}, { resumeFrom: 'C-old' }, { forkFrom: { claudeSessionId: 'C-parent' } }]) {
      expect(await launch(extra)).not.toContain('--dangerously-skip-permissions')
    }
  })

  test('the tools come from the scope, not from the launch input', async () => {
    const cmd = await launch({ tools: ['Bash', 'Edit'] })
    expect(cmd).toContain("--tools 'Read,Grep,Glob'")
    expect(cmd).not.toContain('Bash')
  })

  test('the environment: claude.ai connectors off, and the hydra mod alone on CLAUDE_CODE_PLUGIN_DIRS', async () => {
    const cmd = await launch()
    expect(cmd).toContain(`export ENABLE_CLAUDEAI_MCP_SERVERS='false'`.replace("'false'", 'false'))
    expect(cmd).toContain("export CLAUDE_CODE_PLUGIN_DIRS='<state>/mods/hydra' ")
    expect(cmd).not.toContain('personal')
    expect(cmd).toContain("export HYDRA_SESSION_TYPE='scoped'")
    expect([...SCOPED_MODS]).toEqual(['hydra'])
  })

  test('every other shape of launch still loads every mod and leaves the connectors on', async () => {
    const cmd = await launch({ policy: undefined, sessionType: 'thread_owner' })
    expect(cmd).toContain('personal')
    expect(cmd).not.toContain('ENABLE_CLAUDEAI_MCP_SERVERS')
    expect(cmd).toContain('--dangerously-skip-permissions')
  })
})

describe("in launch(), the folder, the flags and the env come from the launch policy, whatever the caller passed", () => {
  const claudeCd = (cmd: string) => /&& cd '([^']*)' &&/.exec(cmd)?.[1]
  test("it starts in the policy's workdir whatever cwd and originalCwd the caller passed (the operator's spawn dir, a worktree)", async () => {
    for (const extra of [{ cwd: '/operator/spawn', originalCwd: '/operator/spawn' }, { cwd: '/wt/x', originalCwd: '/operator/spawn', worktreePath: '/wt/x', forkFromOriginalCwd: true }, { cwd: '', originalCwd: '' }]) {
      expect(claudeCd(await launch(extra))).toBe('/work/ops')
    }
    // A fork that asked for a worktree starts where the caller's spawn dir is: for a confined session that is its workdir too.
    expect(claudeCd(await launch({ cwd: '/wt/x', originalCwd: '/operator/spawn', worktreePath: '/wt/x', forkFromOriginalCwd: true, forkFrom: { claudeSessionId: 'C-parent' } }))).toBe('/work/ops')
    expect(claudeCd(await launch({ cwd: '/operator/spawn', originalCwd: '/operator/spawn', resumeFrom: 'C-old' }))).toBe('/work/ops')
    expect(claudeCd(await launch({ cwd: '/operator/spawn', originalCwd: '/operator/spawn', forkFrom: { claudeSessionId: 'C-parent' } }))).toBe('/work/ops')
  })
  test('with no policy, the caller\'s cwd rules, as it always has', async () => {
    expect(claudeCd(await launch({ policy: undefined, sessionType: 'thread_owner', cwd: '/elsewhere', originalCwd: '/elsewhere' }))).toBe('/elsewhere')
    expect(claudeCd(await launch({ policy: { specialist: 'desk', access: 'operator', id: 'operator' }, sessionType: 'thread_owner', cwd: '/elsewhere', originalCwd: '/elsewhere' }))).toBe('/elsewhere')
  })
  test('an operator policy launches byte for byte as no policy does', async () => {
    const plain = await launch({ policy: undefined, sessionType: 'thread_owner' })
    expect(await launch({ policy: { specialist: 'desk', access: 'operator', id: 'operator' }, sessionType: 'thread_owner' })).toBe(plain)
  })
  test.each([
    ['no workdir', { workdir: undefined }], ['a relative workdir', { workdir: 'work/ops' }], ['no tool list', { tools: undefined }],
    ['no server list', { servers: undefined }], ['an id that is not its facts\'', { id: 'workdir:000000000000' }],
  ])('a confining policy with %s refuses: nothing is started, and nothing falls back to the operator', async (_why, broken) => {
    const before = fake.calls().length
    await expect(launch({ policy: { ...policy, ...broken } })).rejects.toThrow(PolicyRefusal)
    expect(fake.calls().slice(before).some(c => c.startsWith('new-session'))).toBe(false)
  })
})

describe('generated settings and mcp-config', () => {
  const files = () => readdirSync(join(STATE_DIR, 'scoped')).sort()
  const read = (name: string) => JSON.parse(readFileSync(join(STATE_DIR, 'scoped', name), 'utf8'))

  test('the settings enable the bridge plugin and allow exactly the bridge and the listed server tools', async () => {
    await launch()
    expect(read('sc-t-11111111-1111-4111-8111-111111111111.settings.json')).toEqual({
      enabledPlugins: { 'discord@claude-plugins-official': true },
      permissions: { allow: ['mcp__plugin_discord_discord__*', 'mcp__datadog__search_logs', 'mcp__datadog__get_monitor'] },
    })
  })

  test('the mcp-config lists the listed servers, each with the token_env variables and nothing else of the environment', async () => {
    await launch()
    const mcp = read('sc-t-11111111-1111-4111-8111-111111111111.mcp.json')
    expect(mcp).toEqual({ mcpServers: { datadog: { type: 'stdio', command: '/usr/local/bin/datadog-mcp', args: [], env: { DD_API_KEY: 'dd-secret' } } } })
    expect(JSON.stringify(mcp)).not.toContain('gh-secret')
  })

  test('both files are 0600 in a 0700 folder, whatever the umask', async () => {
    const before = process.umask(0o000)
    try { await launch() } finally { process.umask(before) }
    for (const f of files()) expect(statSync(join(STATE_DIR, 'scoped', f)).mode & 0o777).toBe(0o600)
    expect(statSync(join(STATE_DIR, 'scoped')).mode & 0o777).toBe(0o700)
  })

  test("each launch writes its own and removes this session name's earlier ones", async () => {
    await launch()
    await launch({ sessionId: '22222222-2222-4222-8222-222222222222' })
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'other', sessionId: '33333333-3333-4333-8333-333333333333' } as any)
    expect(files()).toEqual(['other-33333333-3333-4333-8333-333333333333.mcp.json', 'other-33333333-3333-4333-8333-333333333333.settings.json', 'sc-t-22222222-2222-4222-8222-222222222222.mcp.json', 'sc-t-22222222-2222-4222-8222-222222222222.settings.json'])
  })

  test('a name that is a prefix of another is not the other: launching `ops` leaves `ops-eu` files alone', async () => {
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops-eu', sessionId: '11111111-1111-4111-8111-111111111111' } as any)
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops-v2', sessionId: '22222222-2222-4222-8222-222222222222' } as any)
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops', sessionId: '33333333-3333-4333-8333-333333333333' } as any)
    expect(files()).toEqual(['ops-33333333-3333-4333-8333-333333333333.mcp.json', 'ops-33333333-3333-4333-8333-333333333333.settings.json', 'ops-eu-11111111-1111-4111-8111-111111111111.mcp.json', 'ops-eu-11111111-1111-4111-8111-111111111111.settings.json', 'ops-v2-22222222-2222-4222-8222-222222222222.mcp.json', 'ops-v2-22222222-2222-4222-8222-222222222222.settings.json'])
    // Launching `ops` again replaces its own earlier pair and still leaves the others.
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops', sessionId: '44444444-4444-4444-8444-444444444444' } as any)
    expect(files().filter(f => f.startsWith('ops-eu-') || f.startsWith('ops-v2-'))).toHaveLength(4)
    expect(files().filter(f => f.includes('33333333-3333-4333-8333-333333333333'))).toEqual([])
  })

  test("removeScopedFiles removes exactly one session's pair", async () => {
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops', sessionId: '11111111-1111-4111-8111-111111111111' } as any)
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'ops-eu', sessionId: '22222222-2222-4222-8222-222222222222' } as any)
    removeScopedFiles({ tmuxName: 'ops', sessionId: '11111111-1111-4111-8111-111111111111' })
    expect(files()).toEqual(['ops-eu-22222222-2222-4222-8222-222222222222.mcp.json', 'ops-eu-22222222-2222-4222-8222-222222222222.settings.json'])
    removeScopedFiles({ tmuxName: 'ops', sessionId: '11111111-1111-4111-8111-111111111111' })   // already gone: quiet
  })

  test('a listed server whose token variable is not set refuses the launch: nothing is started', async () => {
    delete process.env.DD_API_KEY
    const before = fake.calls().length
    await expect(launch()).rejects.toThrow(PolicyRefusal)
    await expect(launch()).rejects.toThrow('[mcp.datadog] needs DD_API_KEY')
    expect(fake.calls().slice(before).some(c => c.startsWith('new-session'))).toBe(false)
  })

  test('a launch that fails after the files were written (tmux refuses the session) leaves none behind', async () => {
    writeFileSync(join(fake.dir, 'tmux'), '#!/bin/sh\ncase "$1" in new-session) echo "no server" >&2; exit 1;; esac\n', { mode: 0o755 })
    await expect(launch()).rejects.toThrow(/failed to spawn tmux session/)
    expect(existsSync(scopedDir()) ? readdirSync(scopedDir()) : []).toEqual([])
  })

  test('a launch that fails before the files exist leaves none either, and a failed one does not take an earlier running session\'s', async () => {
    await new ClaudeEngine({} as any).launch({ ...base, tmuxName: 'other', sessionId: '99999999-9999-4999-8999-999999999999' } as any)
    writeFileSync(join(fake.dir, 'tmux'), '#!/bin/sh\ncase "$1" in new-session) exit 1;; esac\n', { mode: 0o755 })
    await expect(launch()).rejects.toThrow()
    expect(readdirSync(scopedDir()).sort()).toEqual(['other-99999999-9999-4999-8999-999999999999.mcp.json', 'other-99999999-9999-4999-8999-999999999999.settings.json'])
  })

  test('removeScopedFiles is a no-op in a process that does not own the state dir, and removes in one that does (the one policy, for kill and death alike)', async () => {
    await launch()
    removeScopedFiles({ tmuxName: 'sc-t', sessionId: base.sessionId }, false)
    expect(readdirSync(scopedDir())).toHaveLength(2)
    removeScopedFiles({ tmuxName: 'sc-t', sessionId: base.sessionId }, true)
    expect(readdirSync(scopedDir())).toHaveLength(0)
  })

  test('a scope with no servers writes an empty server list and allows only the bridge', () => {
    const { settings, mcp } = scopedConfig({ ...scope, servers: [] }, {}, {})
    expect(mcp).toEqual({ mcpServers: {} })
    expect((settings as any).permissions.allow).toEqual(['mcp__plugin_discord_discord__*'])
  })

  test('a token held back from the environment by the scrub is still found where the daemon captured it', () => {
    const { mcp } = scopedConfig(scope, {}, { DD_API_KEY: 'captured' })
    expect((mcp as any).mcpServers.datadog.env).toEqual({ DD_API_KEY: 'captured' })
  })
})
