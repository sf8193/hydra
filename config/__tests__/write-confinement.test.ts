// `can_only_write_to = "workdir"`: the middle trust level. Every load refusal and warning, one test per row.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import { systemEnv } from '../../infra/load-env.js'
import type { HydraConfig, LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { KNOWN_BUILTIN_TOOLS, confinementWarning, readDenyRoots, unreadableWorkdir } from '../write-confinement.js'

const HOME = '/home/op'
const env: LoadEnv = testLoadEnv({ home: HOME, stateDir: `${HOME}/.claude/channels/discord`, claudeConfigDir: `${HOME}/.claude`, isCommand: c => c === '/usr/local/bin/browser-mcp' || c === '/home/op/bin/setup' || c === '/usr/local/bin/datadog-mcp' })

const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[people.pat]
addresses = ["slack:U0PAT"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[mcp_servers.browser]
command = "/usr/local/bin/browser-mcp"
profile_args = ["--user-data-dir", "{profile_dir}", "--downloads={download_dir}"]
profile_env = { BROWSER_HOME = "{profile_dir}" }
[mcp_servers.plain]
command = "/usr/local/bin/datadog-mcp"
`
const spec = (body: string, reachableBy = '[]', workdir = '~/agents/ops') => `${BASE}\n[specialists.ops]\nworkdir = "${workdir}"\nreachable_by = ${reachableBy}\n${body}\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:ops"\n`
const errorsOf = (text: string): string[] => {
  const r = loadHydraConfig(text, env)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(i => `${i.path}: ${i.message}`)
}
const ok = (text: string) => {
  const r = loadHydraConfig(text, env)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.map(i => `${i.path}: ${i.message}`).join('\n')}`)
  return { config: r.config as HydraConfig, warnings: r.warnings.map(i => `${i.path}: ${i.message}`) }
}

describe('can_only_write_to', () => {
  test('absent: writes anywhere, as today', () => {
    expect(ok(spec('')).config.specialists.ops.canOnlyWriteTo).toBeUndefined()
  })

  test('"workdir" loads, and the specialist is still the operator\'s account (restricted stays false)', () => {
    expect(ok(spec('can_only_write_to = "workdir"')).config.specialists.ops).toMatchObject({ restricted: false, canOnlyWriteTo: 'workdir' })
  })

  test('any other value is an error naming the one value', () => {
    expect(errorsOf(spec('can_only_write_to = "home"'))).toEqual(['specialists.ops.can_only_write_to: must be "workdir" (or a list holding only "workdir")'])
  })

  test('with restricted = true it is a load error: a specialist is restricted or write-confined, never both', () => {
    expect(errorsOf(spec('restricted = true\ncan_only_write_to = "workdir"'))).toEqual(['specialists.ops.can_only_write_to: a specialist is restricted or write-confined, never both: restricted = true already limits its writes and reads (and more); remove can_only_write_to, or set restricted = false'])
  })

  test('sends_to still belongs to restricted = true alone', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nsends_to = ["x"]'))).toEqual([
      'specialists.ops.sends_to: has no effect while restricted = false: it already has every tool and server the operator does, and send_to_thread to any session; set restricted = true to choose them',
    ])
  })

  // The engine a specialist runs on is its `engine`, else the one its model names (a Codex alias, a `gpt-` id): the launch refuses a
  // write-confined session on any engine but claude, so the load refuses what the launch always would, whichever way the engine is named.
  const REFUSED = (engine: string, key: 'engine' | 'model') => [`specialists.ops.${key}: ${engine} can't run a write-confined specialist: only Claude Code's own sandbox does the confining; use claude (engine = "claude", or a Claude model), or remove can_only_write_to`]
  test('only the claude engine can run it: a named engine, or a model that names one', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "codex"'))).toEqual(REFUSED('codex', 'engine'))
    for (const model of ['sol', 'astra', 'terra', 'luna', 'gpt-5.6-terra']) {
      expect(errorsOf(spec(`can_only_write_to = "workdir"\nmodel = "${model}"`))).toEqual(REFUSED('codex', 'model'))
    }
  })
  test('an engine and a model that name two engines is said once, at the engine that cannot confine', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "codex"\nmodel = "opus"'))).toEqual(REFUSED('codex', 'engine'))
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "claude"\nmodel = "sol"'))).toEqual([`specialists.ops.model: "sol" is a codex model, but engine = "claude": set engine = "codex", or use a model for claude`])
  })
  test('omp is refused with its own one message, not a second one for write confinement', () => {
    const omp = `specialists.ops.engine: omp cannot restrict a session's tools, so a specialist cannot use it; use claude, codex, or agy`
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "omp"'))).toEqual([omp])
    expect(errorsOf(spec('can_only_write_to = "workdir"\nmodel = "omp-sol"'))).toEqual([omp.replace('.engine:', '.model:')])
  })
  test('agy cannot confine writes either: a named engine, or a model alias', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "agy"'))).toEqual(REFUSED('agy', 'engine'))
    expect(errorsOf(spec('can_only_write_to = "workdir"\nmodel = "neon"'))).toEqual(REFUSED('agy', 'model'))
  })
  test('claude, a Claude model, or no engine and no model loads', () => {
    for (const body of ['', 'engine = "claude"', 'model = "opus"', 'engine = "claude"\nmodel = "opus"']) {
      expect(ok(spec(`can_only_write_to = "workdir"\n${body}`)).config.specialists.ops.canOnlyWriteTo).toBe('workdir')
    }
  })
  test('a model that comes from [defaults.specialist] is refused the same, and says where it came from', () => {
    const text = spec('can_only_write_to = "workdir"').replace('[specialists.ops]', '[defaults.specialist]\nmodel = "sol"\n[specialists.ops]')
    expect(errorsOf(text)).toEqual([`specialists.ops.model (from defaults.specialist): codex can't run a write-confined specialist: only Claude Code's own sandbox does the confining; use claude (engine = "claude", or a Claude model), or remove can_only_write_to`])
  })
  test('a Codex model with no can_only_write_to still loads: the refusal is for write confinement alone', () => {
    expect(ok(spec('model = "sol"')).config.specialists.ops.canOnlyWriteTo).toBeUndefined()
  })
})

describe('mcp_servers with can_only_write_to', () => {
  test('listed servers load, carrying their profile declaration; no `tools` list is needed', () => {
    const { config } = ok(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser", "plain"]'))
    expect(config.specialists.ops.mcpServerNames).toEqual(['browser', 'plain'])
    expect(config.mcpServers!.browser).toMatchObject({ profileArgs: ['--user-data-dir', '{profile_dir}', '--downloads={download_dir}'], profileEnv: { BROWSER_HOME: '{profile_dir}' } })
    expect(config.mcpServers!.plain.profileArgs).toBeUndefined()
  })

  test('a server hydra.toml does not declare is an error', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nmcp_servers = ["nope"]'))).toEqual(['specialists.ops.mcp_servers[0]: no [mcp_servers.nope]: declare the server in hydra.toml first'])
  })

  test('without can_only_write_to or restricted the key is still refused', () => {
    expect(errorsOf(spec('mcp_servers = ["browser"]'))[0]).toContain('has no effect while restricted = false')
  })

  test('profile_args and profile_env name only {profile_dir} and {download_dir}, and need at least one', () => {
    const decl = (extra: string) => BASE.replace('profile_args = ["--user-data-dir", "{profile_dir}", "--downloads={download_dir}"]\nprofile_env = { BROWSER_HOME = "{profile_dir}" }', extra)
    const errs = (extra: string) => errorsOf(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]').replace(BASE, decl(extra)))
    expect(errs('profile_args = ["--dir={nope}"]')[0]).toBe('mcp_servers.browser.profile_args[0]: "--dir={nope}" names {nope}; a placeholder is {profile_dir} or {download_dir}')
    expect(errs('profile_args = ["--headless"]')).toEqual(['mcp_servers.browser: profile_args and profile_env hold no {profile_dir} or {download_dir}, so the server would never be given its own profile'])
    expect(errs('profile_env = { A = "{x}" }')[0]).toBe('mcp_servers.browser.profile_env.A: "{x}" names {x}; a placeholder is {profile_dir} or {download_dir}')
  })
})

describe('tools and mcp_servers are the write-confined specialist\'s allowlist', () => {
  test('tools (built-in tool names) load; absent means all', () => {
    expect(ok(spec('can_only_write_to = "workdir"\ntools = ["Bash", "Edit", "Write", "Read"]')).config.specialists.ops.tools).toEqual(['Bash', 'Edit', 'Write', 'Read'])
    expect(ok(spec('can_only_write_to = "workdir"')).config.specialists.ops.tools).toBeUndefined()
  })
  test('a name that is not a tool name, and an empty list, are errors naming the path', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\ntools = ["bash", "Bash(rm *)"]'))).toEqual([
      'specialists.ops.tools[0]: "bash" must be the name of a built-in tool, like Bash, Edit or Read',
      'specialists.ops.tools[1]: "Bash(rm *)" must be the name of a built-in tool, like Bash, Edit or Read',
    ])
    expect(errorsOf(spec('can_only_write_to = "workdir"\ntools = []'))).toEqual(['specialists.ops.tools: is empty: a session with no built-in tool cannot do anything; list the tools it may use, or leave tools out for all of them'])
  })
  test('without can_only_write_to, tools is still refused where it has no effect', () => {
    expect(errorsOf(spec('tools = ["Read"]'))[0]).toContain('has no effect while restricted = false')
  })
})

describe('the same-name hole and the tool warnings', () => {
  const MANAGED = '/Library/Application Support/ClaudeCode/managed-mcp.json'
  const withNames = (over: Record<string, string[] | Error>) => testLoadEnv({ ...env, mcpNamesIn: (f: string) => { const v = over[f]; if (v instanceof Error) throw v; return v ?? [] } })
  const clashErrors = (e: LoadEnv) => { const r = loadHydraConfig(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]'), e); return r.ok ? [] : r.errors.map(i => `${i.path}: ${i.message}`) }
  test('a listed server whose name a managed MCP config also declares is an error naming the file', () => {
    expect(clashErrors(withNames({ [MANAGED]: ['browser'] }))).toEqual([`specialists.ops.mcp_servers[0]: ${MANAGED} already declares an MCP server named browser; Claude Code's own text says a managed MCP config's servers are admitted without listing them (not shown live), so that one could run in place of [mcp_servers.browser]: rename [mcp_servers.browser]`])
    expect(clashErrors(withNames({ '/etc/claude-code/managed-mcp.json': ['browser'] }))[0]).toContain('/etc/claude-code/managed-mcp.json already declares an MCP server named browser')
  })
  test('the operator\'s own config does not clash: its server has another command, so the allowlist does not admit it (live: write-confinement-mcp.live.test.ts)', () => {
    // Only the managed file is read: a name in ~/.claude.json, its project entry or any .mcp.json is never looked up.
    const seen: string[] = []
    const e = testLoadEnv({ ...env, mcpNamesIn: (f: string) => { seen.push(f); return ['browser'] } })
    expect(clashErrors(e).length).toBe(2)   // both managed paths say it; nothing else is asked
    expect(seen.sort()).toEqual(['/Library/Application Support/ClaudeCode/managed-mcp.json', '/etc/claude-code/managed-mcp.json'])
  })
  test('a managed file that exists and cannot be read or parsed is an error naming it, never "no clash"', () => {
    const errs = clashErrors(withNames({ [MANAGED]: new Error(`${MANAGED} is not valid JSON (Unexpected end)`) }))
    expect(errs).toEqual([`specialists.ops.mcp_servers[0]: ${MANAGED} is not valid JSON (Unexpected end), so hydra cannot tell whether it declares an MCP server named browser (Claude Code's own text says a managed MCP config's servers are admitted without listing them (not shown live)): fix or remove the file`])
    expect(clashErrors(withNames({ '/etc/claude-code/managed-mcp.json': new Error('/etc/claude-code/managed-mcp.json cannot be read (EACCES)') }))[0]).toContain('cannot be read (EACCES)')
  })
  test('the real reader: a missing file declares nothing; an unparseable or unreadable one throws, naming it (what "fails closed" rests on)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpnames-'))
    try {
      const read = systemEnv([], dir, 'discord').mcpNamesIn
      expect(read(join(dir, 'absent.json'))).toEqual([])
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({ mcpServers: { browser: {}, other: {} } }))
      expect(read(join(dir, 'ok.json'))).toEqual(['browser', 'other'])
      writeFileSync(join(dir, 'bad.json'), '{ not json')
      expect(() => read(join(dir, 'bad.json'))).toThrow(`${join(dir, 'bad.json')} is not valid JSON`)
      expect(() => read(dir)).toThrow(`${dir} cannot be read`)   // a directory where a file should be
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('a name only another file declares, or no clash at all, loads', () => {
    expect(ok(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]')).config.specialists.ops.mcpServerNames).toEqual(['browser'])
  })
  test('a tool name Claude Code does not have is warned about with the known list (a typo would drop the tool)', () => {
    const { warnings } = ok(spec('can_only_write_to = "workdir"\ntools = ["Bash", "Raed"]'))
    expect(warnings.filter(w => w.includes('Raed'))).toEqual([expect.stringMatching(/^specialists\.ops\.tools\[1\]: Raed is not a built-in tool hydra knows \(Agent, .*Write\): a typo leaves the session without the tool it meant$/)])
    expect(warnings.filter(w => w.includes('Bash is not'))).toEqual([])
  })
  test('every built-in tool of Claude Code 2.1.326 that a session is offered is a known name (valid tools never warn); names that version no longer has are not', () => {
    for (const t of ['PowerShell', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList', 'SendMessage', 'Workflow', 'ScheduleWakeup', 'PushNotification', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob']) expect(KNOWN_BUILTIN_TOOLS as readonly string[]).toContain(t)
    for (const t of ['BashOutput', 'SlashCommand', 'Task', 'TaskOutput', 'KillShell']) expect(KNOWN_BUILTIN_TOOLS as readonly string[]).not.toContain(t)
    expect(ok(spec('can_only_write_to = "workdir"\ntools = ["PowerShell", "TaskCreate", "Workflow", "Bash"]')).warnings.filter(w => w.includes('built-in tool hydra knows'))).toEqual([])
  })
  test('a listed server that lists tools is warned: it limits nothing at this level', () => {
    const withTools = spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]').replace('profile_env =', 'tools = ["open"]\nprofile_env =')
    expect(ok(withTools).warnings).toContain('specialists.ops.mcp_servers[0]: [mcp_servers.browser] lists tools, which limit nothing at this level: every tool of the server is callable here except those in deny_tools (only a restricted specialist is held to the tools list)')
  })
})

describe('browser_profile (the folder named for a specialist\'s browser)', () => {
  const withProfile = (v: string, extra = '') => spec(`can_only_write_to = "workdir"\nmcp_servers = ["browser"]\nbrowser_profile = "${v}"${extra}`)
  test('a path under the workdir (relative, or absolute) is kept resolved, and the default stays absent', () => {
    expect(ok(withProfile('chrome')).config.specialists.ops.browserProfile).toBe('/home/op/agents/ops/chrome')
    expect(ok(withProfile('~/agents/ops/deep/chrome')).config.specialists.ops.browserProfile).toBe('/home/op/agents/ops/deep/chrome')
    expect(ok(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]')).config.specialists.ops.browserProfile).toBeUndefined()
  })
  test('outside the workdir is an error: the logins would live outside its own folder', () => {
    expect(errorsOf(withProfile('/srv/elsewhere'))).toEqual(['specialists.ops.browser_profile: /srv/elsewhere is not inside the workdir ~/agents/ops: a profile outside it would keep the specialist\'s logins outside its own folder'.replace('~/agents/ops', '/home/op/agents/ops')])
    expect(errorsOf(withProfile('../sibling'))[0]).toContain('is not inside the workdir')
  })
  test('the workdir itself, the default .browser folder, and a place the layer denies reading are errors', () => {
    expect(errorsOf(withProfile('~/agents/ops'))[0]).toContain('is the workdir itself')
    expect(errorsOf(withProfile('.browser/other'))[0]).toContain('the folder of the default profile and downloads')
    expect(errorsOf(withProfile('.', ''))[0]).toContain('is the workdir itself')
    const r = errorsOf(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]\ncannot_read = ["~/agents/ops/secret"]\nbrowser_profile = "secret/p"'))
    expect(r[0]).toContain('which the layer denies reading')
  })
  test('compared as resolved: a link out of the workdir is refused', () => {
    const linked = testLoadEnv({ ...env, realpath: p => (p === '/home/op/agents/ops/chrome' ? '/srv/real/chrome' : p) })
    const r = loadHydraConfig(withProfile('chrome'), linked)
    expect(r.ok).toBe(false)
    expect((r as any).errors[0].message).toContain('is not inside the workdir')
  })
  test('only with can_only_write_to (it names what that layer gives its servers)', () => {
    expect(errorsOf(spec('browser_profile = "chrome"'))).toEqual(['specialists.ops.browser_profile: has no effect without can_only_write_to = "workdir"; it names the folder that layer gives its listed servers as their browser profile'])
  })
  test('two specialists whose profile folders are, hold or sit in one another are an error naming both; distinct ones load', () => {
    const two = (aProfile: string, bProfile: string, bWorkdir = '~/agents/ops') => `${BASE}
[specialists.ops]
workdir = "~/agents/ops"
reachable_by = []
can_only_write_to = "workdir"
mcp_servers = ["browser"]
${aProfile}
[specialists.ops2]
workdir = "${bWorkdir}"
reachable_by = []
can_only_write_to = "workdir"
mcp_servers = ["browser"]
${bProfile}
[[rules]]
place = "slack:#y"
target = "specialist:ops"
[[rules]]
place = "slack:#x"
target = "specialist:ops2"
`
    const same = errorsOf(two('browser_profile = "a"', 'browser_profile = "a"'))
    expect(same).toEqual([expect.stringContaining('specialists.ops2.browser_profile: its browser profile folder /home/op/agents/ops/a overlaps the profile folder /home/op/agents/ops/a of specialists.ops')])
    expect(errorsOf(two('browser_profile = "a"', 'browser_profile = "a/b"'))[0]).toContain('overlaps')
    expect(errorsOf(two('', ''))[0]).toContain('specialists.ops2.workdir: its browser profile folder /home/op/agents/ops/.browser/profile overlaps')   // one workdir, two default profiles
    const fine = loadHydraConfig(two('browser_profile = "a"', 'browser_profile = "b"'), env)
    expect(fine.ok).toBe(true)
  })
})


describe('browser_profile uniqueness and neighbours (resolved, case-folded, downloads included)', () => {
  const two = (a: string, b: string, o: { bWorkdir?: string; aServers?: string; bServers?: string; real?: (p: string) => string } = {}) => {
    const text = `${BASE}
[specialists.ops]
workdir = "~/agents/ops"
reachable_by = []
can_only_write_to = "workdir"
mcp_servers = [${o.aServers ?? '"browser"'}]
${a}
[specialists.ops2]
workdir = "${o.bWorkdir ?? '~/agents/ops'}"
reachable_by = []
can_only_write_to = "workdir"
mcp_servers = [${o.bServers ?? '"browser"'}]
${b}
[[rules]]
place = "slack:#y"
target = "specialist:ops"
[[rules]]
place = "slack:#x"
target = "specialist:ops2"
`
    return loadHydraConfig(text, testLoadEnv({ ...env, ...(o.real && { realpath: o.real }) }))
  }
  const errsOf = (r: ReturnType<typeof loadHydraConfig>) => (r.ok ? [] : r.errors.map(i => `${i.path}: ${i.message}`))
  test('a symlink and its target are one folder (compared resolved)', () => {
    const r = two('browser_profile = "a"', 'browser_profile = "link"', { real: p => (p === '/home/op/agents/ops/link' ? '/home/op/agents/ops/a' : p) })
    expect(errsOf(r)[0]).toContain('overlaps')
  })
  test('Chrome and chrome are one folder (a case-insensitive filesystem)', () => {
    expect(errsOf(two('browser_profile = "Chrome"', 'browser_profile = "chrome"'))[0]).toContain('overlaps')
  })
  test('.BROWSER/x is still the default folder (case-folded)', () => {
    expect(errsOf(two('browser_profile = ".BROWSER/x"', ''))[0]).toContain('the folder of the default profile and downloads')
  })
  test('one specialist\'s profile x and another\'s x-downloads collide: profile and downloads folders are compared against each other', () => {
    // ops names "x"; ops2 names "x-downloads", whose own downloads are "x-downloads-downloads"; ops2's profile IS ops's downloads folder
    expect(errsOf(two('browser_profile = "x"', 'browser_profile = "x-downloads"'))[0]).toContain('overlaps')
    expect(errsOf(two('browser_profile = "x-downloads"', 'browser_profile = "x"'))[0]).toContain('overlaps')   // and the other way round
  })
  test('only a specialist given a server that declares a profile counts: two sharing a workdir with non-browser servers load as they did', () => {
    expect(errsOf(two('', '', { aServers: '"plain"', bServers: '"plain"' }))).toEqual([])
    expect(errsOf(two('', '', { aServers: '"plain"' }))).toEqual([])
    expect(errsOf(two('', ''))[0]).toContain('overlaps')   // both with the browser: the shared default
  })
  test('a profile inside ANOTHER specialist\'s workdir (nested workdirs) is an error naming it', () => {
    const r = two('browser_profile = "sub/chrome"', '', { bWorkdir: '~/agents/ops/sub' })
    expect(errsOf(r).join('\n')).toContain('specialists.ops.browser_profile: its browser profile folder /home/op/agents/ops/sub/chrome is inside the workdir /home/op/agents/ops/sub of specialists.ops2')
  })
})

describe('browser_profile values and the substitution', () => {
  const withProfile = (v: string, servers = '"browser"') => spec(`can_only_write_to = "workdir"\nmcp_servers = [${servers}]\nbrowser_profile = "${v}"`)
  test('an empty browser_profile is a load error, like any empty value', () => {
    expect(errorsOf(withProfile(''))).toEqual(['specialists.ops.browser_profile: must be a non-empty string'])
  })
  test('a valid browser_profile with no listed server that declares profile_args or profile_env is a named warning', () => {
    const { warnings } = ok(withProfile('chrome', '"plain"'))
    expect(warnings.filter(w => w.includes('browser_profile'))).toEqual(['specialists.ops.browser_profile: no server it lists declares profile_args or profile_env, so nothing is given this folder: declare how a listed server takes its profile, or remove browser_profile'])
    expect(ok(withProfile('chrome')).warnings.filter(w => w.includes('browser_profile'))).toEqual([])
  })
  test('{profile_dir} and {download_dir} are filled in one pass: a folder whose name holds a placeholder is not substituted again', async () => {
    const { fillProfile } = await import('../write-confinement.js')
    expect(fillProfile('--a={profile_dir} --b={download_dir}', '/w', '/w/x{download_dir}y')).toBe('--a=/w/x{download_dir}y --b=/w/x{download_dir}y-downloads')
  })
})

describe('[mcp_servers.<name>] login_command and profile_locks (hydra specialist browser)', () => {
  const decl = (extra: string) => BASE.replace('profile_env = { BROWSER_HOME = "{profile_dir}" }', `profile_env = { BROWSER_HOME = "{profile_dir}" }\n${extra}`)
  const load = (extra: string) => loadHydraConfig(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]').replace(BASE, decl(extra)), env)
  const errs = (extra: string) => { const r = load(extra); return r.ok ? [] : r.errors.map(i => `${i.path}: ${i.message}`) }
  test('login_command and profile_locks load, with the executable ~-expanded and the placeholders kept for the command to fill', () => {
    const r = load('login_command = ["/usr/local/bin/browser-mcp", "--user-data-dir={profile_dir}"]\nprofile_locks = ["SingletonLock", ".parentlock"]')
    expect(r.ok).toBe(true)
    expect((r as any).config.mcpServers.browser).toMatchObject({ loginCommand: ['/usr/local/bin/browser-mcp', '--user-data-dir={profile_dir}'], profileLocks: ['SingletonLock', '.parentlock'] })
  })
  test('setup_command loads with the executable ~-expanded; it takes no placeholder, is not empty, names an executable that exists, and needs a login_command', () => {
    const r = load('login_command = ["/usr/local/bin/browser-mcp", "--user-data-dir={profile_dir}"]\nsetup_command = ["/usr/local/bin/browser-mcp", "install-browser", "pinned"]')
    expect(r.ok).toBe(true)
    expect((r as any).config.mcpServers.browser.setupCommand).toEqual(['/usr/local/bin/browser-mcp', 'install-browser', 'pinned'])
    expect((load('login_command = ["/usr/local/bin/browser-mcp", "{profile_dir}"]\nsetup_command = ["~/bin/setup", "~/keep"]') as any).config.mcpServers.browser.setupCommand).toEqual(['/home/op/bin/setup', '~/keep'])
    expect(errs('setup_command = ["/usr/local/bin/browser-mcp"]')).toEqual(['mcp_servers.browser: setup_command runs only as part of `hydra specialist browser`, which needs login_command: declare how to open the browser too'])
    expect(errs('login_command = ["/usr/local/bin/browser-mcp", "{profile_dir}"]\nsetup_command = []')).toEqual(['mcp_servers.browser.setup_command: is empty: it is the command that installs what the server needs, its first element the executable'])
    expect(errs('login_command = ["/usr/local/bin/browser-mcp", "{profile_dir}"]\nsetup_command = ["/usr/local/bin/browser-mcp", "{profile_dir}"]')[0]).toContain('takes no placeholder')
    expect(errs('login_command = ["/usr/local/bin/browser-mcp", "{profile_dir}"]\nsetup_command = ["/no/such/installer"]')[0]).toContain('is not an executable file or a command on PATH')
  })
  test('errors: no {profile_dir}, an unknown placeholder, an empty command, an executable that does not exist, a lock name with a slash', () => {
    expect(errs('login_command = ["/usr/local/bin/browser-mcp"]')).toEqual(["mcp_servers.browser: login_command holds no {profile_dir}, so it would not open the specialist's own profile"])
    expect(errs('login_command = ["/usr/local/bin/browser-mcp", "{profile_dir}", "{nope}"]')[0]).toContain('names {nope}')
    expect(errs('login_command = []')).toEqual(['mcp_servers.browser.login_command: is empty: it is the command that opens the browser, its first element the executable'])
    expect(errs('login_command = ["/no/such/browser", "{profile_dir}"]')[0]).toContain('is not an executable file or a command on PATH')
    expect(errs('profile_locks = ["a/b"]')[0]).toContain('must be a plain file name inside the profile folder')
  })
})

describe('cannot_read', () => {
  test('is valid only with can_only_write_to: alone it is an error naming the path (and says what it extends)', () => {
    expect(errorsOf(spec('cannot_read = ["~/notes"]'))).toEqual(['specialists.ops.cannot_read: has no effect without can_only_write_to = "workdir"; it adds to the places that layer denies reading'])
    expect(errorsOf(spec('cannot_read = []'))).toEqual(['specialists.ops.cannot_read: has no effect without can_only_write_to = "workdir"; it adds to the places that layer denies reading'])
  })
  test('with can_only_write_to the operator\'s paths are kept, ~ expanded, as additions; the built-in places always apply', () => {
    expect(ok(spec('can_only_write_to = "workdir"\ncannot_read = ["~/notes", "/srv/private"]')).config.specialists.ops.cannotRead).toEqual(['/home/op/notes', '/srv/private'])
    expect(ok(spec('can_only_write_to = "workdir"')).config.specialists.ops.cannotRead).toEqual([])
  })
  test('can_only_write_to takes a string or a list, and only "workdir" is a value', () => {
    expect(ok(spec('can_only_write_to = ["workdir"]')).config.specialists.ops.canOnlyWriteTo).toBe('workdir')
    expect(errorsOf(spec('can_only_write_to = ["workdir", "home"]'))).toEqual(['specialists.ops.can_only_write_to: must be "workdir" (or a list holding only "workdir")'])
    expect(errorsOf(spec('can_only_write_to = []'))).toEqual(['specialists.ops.can_only_write_to: must be "workdir" (or a list holding only "workdir")'])
  })
  test('with restricted = true, can_only_write_to is a load error, and so are cannot_read and deny_commands (restricted already covers them)', () => {
    expect(errorsOf(spec('restricted = true\ncan_only_write_to = "workdir"'))).toEqual(['specialists.ops.can_only_write_to: a specialist is restricted or write-confined, never both: restricted = true already limits its writes and reads (and more); remove can_only_write_to, or set restricted = false'])
    expect(errorsOf(spec('restricted = true\ncannot_read = []'))[0]).toContain('specialists.ops.cannot_read: belongs to can_only_write_to, and restricted = true already limits its reads and commands')
    expect(errorsOf(spec('restricted = true\ndeny_commands = ["x"]'))[0]).toContain('specialists.ops.deny_commands: belongs to can_only_write_to, and restricted = true already limits its reads and commands')
  })
  test('a relative path is an error naming it', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\ncannot_read = ["notes"]'))).toEqual(['specialists.ops.cannot_read[0]: "notes" must be an absolute path or start with ~'])
  })
  test('a workdir the layer would deny reading is an error: the specialist could not read its own folder', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"', '[]', '~/.ssh/agent'))).toEqual([expect.stringContaining('specialists.ops.workdir: /home/op/.ssh/agent is, or holds, /home/op/.ssh')])
    expect(errorsOf(spec('can_only_write_to = "workdir"\ncannot_read = ["~/agents"]'))[0]).toContain('is, or holds, /home/op/agents')
  })
  test('the state folder is denied whole, so a workdir inside it is refused', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"', '[]', '~/.claude/channels/discord/agent'))[0]).toContain('is, or holds, /home/op/.claude/channels/discord')
  })
  test('compared as resolved: a workdir that is a link into a denied place is refused', () => {
    const linked = testLoadEnv({ ...env, realpath: p => (p === '/home/op/agents/ops' ? '/home/op/.aws/keys' : p) })
    const r = loadHydraConfig(spec('can_only_write_to = "workdir"'), linked)
    expect(r.ok).toBe(false)
    expect((r as any).errors.map((i: any) => i.message).join('\n')).toContain('is, or holds, /home/op/.aws')
  })
})

describe('the places denied for reading (readDenyRoots)', () => {
  const home = '/home/op'
  const denv = { home, stateDir: '/home/op/state', realpath: (p: string) => (p === '/home/op/link' ? '/srv/real' : p) }
  test('the built-in credential places, the whole state folder (not just .env), the operator\'s additions and the other specialists\' workdirs', () => {
    const roots = readDenyRoots(denv, '/home/op/work', ['/home/op/other', '/home/op/work'], ['/home/op/notes'])
    for (const d of ['.ssh', '.aws', '.config/gh', '.config/gcloud', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', 'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Safari']) expect(roots).toContain(`${home}/${d}`)
    expect(roots).toContain('/home/op/state')
    expect(roots).not.toContain('/home/op/state/.env')
    expect(roots).toContain('/home/op/notes')
    expect(roots).toContain('/home/op/other')
    expect(roots).not.toContain('/home/op/work')
    expect(roots).not.toContain(`${home}/.config`)   // not all of ~/.config: an operator's own tools read it
  })
  test('a workdir that holds or sits in the specialist\'s own is left out of the others (it cannot be denied without denying its own folder)', () => {
    const roots = readDenyRoots(denv, '/home/op/work', ['/home/op', '/home/op/work/sub', '/home/op/else'], [])
    expect(roots).not.toContain('/home/op')
    expect(roots).not.toContain('/home/op/work/sub')
    expect(roots).toContain('/home/op/else')
  })
  test('a place that resolves elsewhere is listed as written and as it resolves (the sandbox matches resolved paths)', () => {
    const roots = readDenyRoots(denv, '/home/op/work', [], ['/home/op/link'])
    expect(roots).toContain('/home/op/link')
    expect(roots).toContain('/srv/real')
  })
  test('unreadableWorkdir: the root a folder sits in or around, compared as resolved', () => {
    expect(unreadableWorkdir('/home/op/.ssh/x', ['/home/op/.ssh'])).toBe('/home/op/.ssh')
    expect(unreadableWorkdir('/home/op', ['/home/op/.ssh'])).toBe('/home/op/.ssh')
    expect(unreadableWorkdir('/home/op/work', ['/home/op/.ssh'])).toBeUndefined()
    expect(unreadableWorkdir('/home/op/link', ['/srv/real'], denv.realpath)).toBe('/srv/real')
  })
})

describe('the browser profile and the listed servers', () => {
  test('per-conversation sessions with a server that is given the profile folder are refused: they would share it', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]\nsessions = "per-conversation"'))).toEqual(['specialists.ops.sessions: "per-conversation" would start several sessions at once, all sharing the one browser profile [mcp_servers.browser] is given in the workdir, which a browser locks: use sessions = "shared", or drop browser from mcp_servers'])
  })
  test('per-conversation without such a server is fine', () => {
    expect(ok(spec('can_only_write_to = "workdir"\nsessions = "per-conversation"')).config.specialists.ops.canOnlyWriteTo).toBe('workdir')
  })
  test('a listed server that declares no profile_args or profile_env warns, naming it: it keeps its own default profile', () => {
    const { warnings } = ok(spec('can_only_write_to = "workdir"\nmcp_servers = ["plain"]'))
    expect(warnings.filter(w => w.includes('plain'))).toEqual(['specialists.ops.mcp_servers[0]: [mcp_servers.plain] declares no profile_args or profile_env, so it keeps its own default browser profile (the operator\'s, if it is a browser): declare how it takes a profile folder, or accept that'])
    expect(ok(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]')).warnings.filter(w => w.includes('browser'))).toEqual([])
  })
})

describe('deny_commands', () => {
  test('is a Bash deny list for a write-confined specialist', () => {
    expect(ok(spec('can_only_write_to = "workdir"\ndeny_commands = ["rm -rf *", "sudo *"]')).config.specialists.ops.denyCommands).toEqual(['rm -rf *', 'sudo *'])
  })
  test('without can_only_write_to it is refused', () => {
    expect(errorsOf(spec('deny_commands = ["rm *"]'))).toEqual(['specialists.ops.deny_commands: has no effect without can_only_write_to = "workdir"; it adds to the commands that layer denies'])
  })
  test('an empty or paren-carrying pattern is refused (a pattern is the text inside Bash(...))', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\ndeny_commands = ["", "rm (x)"]'))).toEqual([
      'specialists.ops.deny_commands[0]: must not be empty',
      'specialists.ops.deny_commands[1]: "rm (x)" has a parenthesis, which a Bash rule cannot hold; write the command without it',
    ])
  })
})

describe('config check warning', () => {
  test('a write-confined specialist someone can reach warns at its own level, in the agreed words, and never says safe', () => {
    const { warnings } = ok(spec('can_only_write_to = "workdir"', '["role:people"]'))
    const mine = warnings.filter(w => w.startsWith('specialists.ops:') && w.includes("operator's account"))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatch(/^specialists\.ops: .+ can reach the operator's account: /)
    expect(mine[0].endsWith(confinementWarning('/home/op/agents/ops').replace(/^can reach/, 'can reach'))).toBe(true)
    expect(confinementWarning('/w')).toBe("can reach the operator's account: Bash and Edit/Write writes are confined to /w, and Claude Code's tools and shell cannot read the credential folders (~/.ssh, ~/.aws and the like), hydra's state folder or other specialists' workdirs; ~/Library/Keychains is one of those folders, so `security` and git's keychain helper fail in its shell (shown with a throwaway keychain; login keychain: not proven live; the git helper cannot be told apart on the real one without writing an item; a store the keychain service holds without a file is not separately blocked); the browser and MCP servers can read them; the daemon attaches, for it, only a file in its folder or temp folder that is in none of those places, and it holds no tool that reaches another session (spawn, list, peek, kill, send_to_thread, handoff, watch, bind) and uses its reading and reply tools only in its own conversation; and other reads, network, MCP servers' own writes and credentials are not confined; it sees only the MCP servers it lists (hydra's bridge aside), and a listed server that declares a profile folder uses its own profile in the folder browser_profile names, else /w/.browser/profile, while one that declares none keeps its default; files people send it are saved in /w/.inbox, a folder the daemon makes (0700) in its own folder, and the message names the path (the shared inbox is denied to it). Credential separation (run_as) is planned, not built.")
    expect(confinementWarning('/w')).not.toMatch(/safe/i)
  })

  test('the warning is per specialist and also names that MCP servers and the browser run outside the sandbox', () => {
    expect(confinementWarning('/w')).toContain("MCP servers' own writes")
  })

  test('a write-confined specialist nobody can reach does not warn about reach', () => {
    expect(ok(spec('can_only_write_to = "workdir"')).warnings.filter(w => w.includes("operator's account"))).toEqual([])
  })

  test('an unrestricted specialist someone can reach still gets the old warning', () => {
    expect(ok(spec('', '["role:people"]')).warnings.some(w => w.endsWith("can reach the operator's account through it; set restricted = true"))).toBe(true)
  })
})

describe('what the docs say a write-confined session may write', () => {
  const root = join(import.meta.dir, '..', '..')
  const read = (f: string) => readFileSync(join(root, f), 'utf8')
  // Claude Code's sandbox allows the folder and the per-user $TMPDIR (macOS: /tmp/claude-<uid>), not the shared /tmp, which any local user can read.
  const files = ['README.md', 'docs/slack.md', 'app/write-confinement.ts']
  for (const f of files) {
    test(`${f} names the per-user $TMPDIR and never says "temp" alone is writable`, () => {
      const text = read(f)
      expect(text).not.toMatch(/workdir and temp\b|working directory and temp\b|writes only in the workdir and temp/)
      expect(text).toContain('$TMPDIR')
    })
  }
  test('README and the guide say shared /tmp is not writable', () => {
    for (const f of ['README.md', 'docs/slack.md']) { expect(read(f)).toMatch(/shared `\/tmp`[^.]*not/); expect(read(f)).toContain("Claude Code's sandbox default") }
  })
})

describe('[mcp_servers.<name>] deny_tools', () => {
  const decl = (extra: string) => BASE.replace('profile_env = { BROWSER_HOME = "{profile_dir}" }', `profile_env = { BROWSER_HOME = "{profile_dir}" }\n${extra}`)
  const load = (extra: string) => loadHydraConfig(spec('can_only_write_to = "workdir"\nmcp_servers = ["browser"]').replace(BASE, decl(extra)), env)
  const errs = (extra: string) => { const r = load(extra); return r.ok ? [] : r.errors.map(i => `${i.path}: ${i.message}`) }
  test('loads, as the server\'s denyTools (a tool name of the server, in the order and without repeats)', () => {
    const r = load('deny_tools = ["browser_run_code_unsafe", "browser_evaluate", "browser_evaluate"]')
    expect(r.ok).toBe(true)
    expect((r as any).config.mcpServers.browser.denyTools).toEqual(['browser_run_code_unsafe', 'browser_evaluate'])
  })
  test('absent: the server has no denyTools key at all', () => {
    expect((load('') as any).config.mcpServers.browser.denyTools).toBeUndefined()
  })
  test('an empty entry, a name that is not a plain tool name, and a non-string are errors naming the path', () => {
    expect(errs('deny_tools = [""]')).toEqual(['mcp_servers.browser.deny_tools[0]: "" must be the name of one of the server\'s tools, like browser_run_code_unsafe'])
    expect(errs('deny_tools = ["a b"]')[0]).toContain('mcp_servers.browser.deny_tools[0]')
    expect(errs('deny_tools = ["mcp__browser__x"]')[0]).toContain('mcp_servers.browser.deny_tools[0]')
    expect(errs('deny_tools = ["*"]')[0]).toContain('mcp_servers.browser.deny_tools[0]')
    expect(errs('deny_tools = [1]')).toEqual(['mcp_servers.browser.deny_tools: must be a list of strings'])
    expect(errs('deny_tools = "x"')).toEqual(['mcp_servers.browser.deny_tools: must be a list of strings'])
  })
})
