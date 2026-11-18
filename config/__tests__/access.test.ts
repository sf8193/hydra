// `restricted`, specialist `tools` and `mcp_servers`, `[mcp_servers.*]`, `[restricted] off_limits`: every refusal and warning, one test per row.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { HydraConfig, LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { SANDBOX_EXEC } from '../server-sandbox.js'
import { offLimitRoots, workdirRestrictionIssues } from '../restricted-workdir.js'

const HOME = '/home/op'
const STATE = '/home/op/.claude/channels/discord'
const DIRS = [HOME, `${HOME}/Library/Safari`, `${HOME}/Library/Application Support/Firefox/profiles`, `${HOME}/Library/Cookies`, `${HOME}/.claude.json`, `${HOME}/.docker`, `${HOME}/.aws`, `${HOME}/.kube/cache`, `${HOME}/.gnupg`, `${HOME}/Library/Keychains`, `${HOME}/agents/nested`, `${HOME}/agents/huge`, `${HOME}/agents/under-mcp/work`, `${HOME}/cfg/claude/projects`, `${HOME}/agents/ops`, `${HOME}/agents/repo`, `${HOME}/agents/links`, `${HOME}/agents/mcpjson`, `${HOME}/notes/hydra`, `${HOME}/.ssh`, `${HOME}/.config/app`, `${HOME}/.claude/projects`, STATE, `${STATE}/sub`, '/']
const env: LoadEnv = testLoadEnv({
  home: HOME, sessionNames: ['spark'],
  stateDir: STATE,
  claudeConfigDir: `${HOME}/.claude`,
  isDir: p => DIRS.includes(p),
  isCommand: c => ['/usr/local/bin/datadog-mcp', 'bun', SANDBOX_EXEC].includes(c),
  realpath: p => (p === `${HOME}/agents/links-alias` ? `${HOME}/agents/links` : p),
  isGitWorkTree: p => p === `${HOME}/agents/repo`,
  scanWorkdir: p => ({
    escapingSymlinks: p === `${HOME}/agents/links` ? [`${p}/notes -> /etc`] : [],
    nestedGit: p === `${HOME}/agents/nested` ? [`${p}/vendor/lib/.git`] : [],
    truncated: p === `${HOME}/agents/huge`,
  }),
  exists: p => [`${HOME}/agents/mcpjson/.mcp.json`, `${HOME}/agents/under-mcp/.mcp.json`].includes(p),
})

const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[mcp_servers.datadog]
command = "/usr/local/bin/datadog-mcp"
token_env = ["DD_API_KEY"]
tools = ["search_logs", "get_monitor"]
[mcp_servers.empty]
command = "bun"
`
const spec = (body: string, workdir = '~/agents/ops') => `${BASE}\n[specialists.ops]\nworkdir = "${workdir}"\nreachable_by = []\n${body}\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:ops"\n`

const load = (text: string, e: LoadEnv = env) => loadHydraConfig(text, e)
const errorsOf = (text: string, e: LoadEnv = env): string[] => {
  const r = load(text, e)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(i => `${i.path}: ${i.message}`)
}
const ok = (text: string, e: LoadEnv = env) => {
  const r = load(text, e)
  if (!r.ok) throw new Error(`expected a load, got:\n${r.errors.map(i => `${i.path}: ${i.message}`).join('\n')}`)
  return { config: r.config as HydraConfig, warnings: r.warnings.map(i => `${i.path}: ${i.message}`) }
}

describe('access', () => {
  test('defaults to operator, which keeps every key as it was', () => {
    const { config } = ok(spec(''))
    expect(config.specialists.ops.restricted).toBe(false)
    expect(config.specialists.ops.tools).toBeUndefined()
    expect(config.specialists.ops.mcpServerNames).toBeUndefined()
  })

  test('workdir gets the default tools Read, Grep, Glob and no servers', () => {
    const { config } = ok(spec('restricted = true'))
    expect(config.specialists.ops).toMatchObject({ restricted: true, tools: ['Read', 'Grep', 'Glob'], mcpServerNames: [] })
  })

  test('a value other than true or false is an error', () => {
    expect(errorsOf(spec('restricted = "admin"'))).toEqual(['specialists.ops.restricted: must be true or false'])
  })

  test('tools and mcp on an operator specialist are refused: nothing passes silently', () => {
    const errs = errorsOf(spec('tools = ["Read"]\nmcp_servers = ["datadog"]'))
    expect(errs).toEqual([
      'specialists.ops.tools: has no effect while restricted = false: it already has every tool and server the operator does; set restricted = true to choose them',
      'specialists.ops.mcp_servers: has no effect while restricted = false: it already has every tool and server the operator does; set restricted = true to choose them',
    ])
  })
})

describe('tools (restricted = true)', () => {
  test('a subset of Read, Grep, Glob loads', () => {
    expect(ok(spec('restricted = true\ntools = ["Read", "Glob"]')).config.specialists.ops.tools).toEqual(['Read', 'Glob'])
  })
  test.each([
    ['Bash', 'runs code outside the workdir'],
    ['Edit', 'writes files'],
    ['Write', 'writes files'],
    ['Task', 'starts agents that carry other tools'],
  ])('%s is refused with its reason', (tool, why) => {
    expect(errorsOf(spec(`restricted = true\ntools = ["Read", "Grep", "${tool}"]`))).toEqual([`specialists.ops.tools[2]: ${tool} ${why}; remove it or set restricted = false`])
  })
  test('a tool outside the allowlist with no special reason gets the generic refusal', () => {
    expect(errorsOf(spec('restricted = true\ntools = ["Frobnicate"]'))).toEqual(['specialists.ops.tools[0]: Frobnicate is not a tool a restricted specialist may use (Read, Grep, Glob); remove it or set restricted = false'])
  })
  test('WebFetch loads, with a warning', () => {
    const { config, warnings } = ok(spec('restricted = true\ntools = ["Read", "WebFetch"]'))
    expect(config.specialists.ops.restricted).toBe(true)
    expect(warnings).toEqual(['specialists.ops.tools[1]: WebFetch can fetch an outside URL with data in it; anyone who can reach this specialist can choose that URL'])
  })
})

describe('workdir (restricted = true)', () => {
  const wd = (path: string) => errorsOf(spec('restricted = true', path))
  test('the home folder itself is refused', () => {
    expect(wd('~')).toEqual(['specialists.ops.workdir: /home/op is your whole home folder: a restricted specialist\'s folder must be its own'])
  })
  test.each([
    ['~/.ssh', '~/.ssh'], ['~/.config/app', '~/.config'], ['~/.claude/projects', '~/.claude'],
    ['~/.aws', '~/.aws'], ['~/.kube/cache', '~/.kube'], ['~/.gnupg', '~/.gnupg'], ['~/Library/Keychains', '~/Library/Keychains'],
    ['~/.docker', '~/.docker'], ['~/.claude.json', '~/.claude.json'], ['~/Library/Safari', '~/Library/Safari'], ['~/Library/Application Support/Firefox/profiles', '~/Library/Application Support/Firefox'], ['~/Library/Cookies', '~/Library/Cookies'],
  ])('%s is inside a private home folder', (path, root) => {
    expect(wd(path)).toEqual([`specialists.ops.workdir: ${HOME}${path.slice(1)} is inside ${root}, which holds what a restricted specialist must not know`])
  })
  test('the state folder, and a folder inside it', () => {
    expect(wd(STATE)[0]).toContain('is inside ~/.claude')   // the state dir lives under ~/.claude/channels
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/hydra-state', isDir: p => ['/srv/hydra-state', '/srv/hydra-state/sub'].includes(p) }
    expect(errorsOf(spec('restricted = true', '/srv/hydra-state/sub'), apart)).toEqual(['specialists.ops.workdir: /srv/hydra-state/sub is inside the state folder /srv/hydra-state, which holds what a restricted specialist must not know'])
  })
  test('a folder that contains the state folder (or any private root) is refused', () => {
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/hydra-state/x', isDir: p => p === '/srv/hydra-state' }
    expect(errorsOf(spec('restricted = true', '/srv/hydra-state'), apart)[0]).toContain('contains the state folder /srv/hydra-state/x')
    expect(wd('/')[0]).toContain('contains ~/.claude')
  })
  test('hydra.toml and the token file are covered through the state folder', () => {
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/s/state', isDir: p => p === '/srv/s' }
    expect(errorsOf(spec('restricted = true', '/srv/s'), apart)[0]).toContain('contains the state folder /srv/s/state')
  })
  test('an operator-configured private root, which lives in config and not in code', () => {
    const text = spec('restricted = true', '~/notes/hydra').replace('operator = "op"', 'operator = "op"\n[restricted]\noff_limits = ["~/notes"]')
    expect(errorsOf(text)).toEqual(['specialists.ops.workdir: /home/op/notes/hydra is inside /home/op/notes (listed in [restricted] off_limits), which holds what a restricted specialist must not know'])
    // The same folder with no private root configured loads: the loader knows no operator's paths.
    expect(ok(spec('restricted = true', '~/notes/hydra')).config.specialists.ops.restricted).toBe(true)
  })
  test('off_limits must be absolute', () => {
    expect(errorsOf(`${BASE}\n[restricted]\noff_limits = ["notes"]`)).toEqual(['restricted.off_limits[0]: "notes" must be an absolute path or start with ~'])
  })
  test('a git work tree is refused', () => {
    expect(wd('~/agents/repo')[0]).toContain('is a git work tree')
  })
  test('a symlink that resolves outside it is refused', () => {
    expect(wd('~/agents/links')).toEqual([`specialists.ops.workdir: /home/op/agents/links/notes -> /etc is a symlink that resolves outside /home/op/agents/links: a restricted specialist's folder must not lead anywhere else`])
  })
  test('a symlinked path to a private folder is judged by where it resolves', () => {
    const viaLink: LoadEnv = { ...env, isDir: p => p === `${HOME}/agents/ops`, realpath: p => (p === `${HOME}/agents/ops` ? `${HOME}/.ssh` : p) }
    expect(errorsOf(spec('restricted = true'), viaLink)[0]).toContain('is inside ~/.ssh')
  })
  test('a .mcp.json in the workdir is refused', () => {
    expect(wd('~/agents/mcpjson')[0]).toContain('holds a .mcp.json')
  })
  test('the same folders load under restricted = false: the rules are the seal\'s, not the loader\'s', () => {
    expect(ok(spec('', '~/agents/repo')).config.specialists.ops.restricted).toBe(false)
  })
  test('a clean folder loads', () => {
    expect(ok(spec('restricted = true')).warnings).toEqual([])
  })
})

describe('workdir (restricted = true): what Claude Code could still reach', () => {
  const wd = (path: string, e: LoadEnv = env) => errorsOf(spec('restricted = true', path), e)
  test('a git repository nested inside it is refused, and the refusal says why although --restricted would not read it', () => {
    expect(wd('~/agents/nested')).toEqual(['specialists.ops.workdir: /home/op/agents/nested holds a git repository (/home/op/agents/nested/vendor/lib/.git): its history is in reach of anyone who can reach this specialist; remove it, or give the specialist a folder with no repository in it'])
  })
  test('a .mcp.json in a folder above it is refused (--restricted ignores it, but a restricted folder sits under none)', () => {
    expect(wd('~/agents/under-mcp/work')).toEqual(['specialists.ops.workdir: /home/op/agents/under-mcp/work sits under a .mcp.json (/home/op/agents/under-mcp/.mcp.json): Claude Code reads that file for sessions started below it, and --restricted only happens to ignore it; move the folder, or remove the file'])
  })
  test('a folder too big to check its symlinks is refused, not trusted', () => {
    expect(wd('~/agents/huge')[0]).toContain('has more entries than can be checked for symlinks that leave it')
  })
  test('CLAUDE_CONFIG_DIR, wherever it is, is a private root', () => {
    const moved = testLoadEnv({ ...env, claudeConfigDir: `${HOME}/cfg/claude`, isDir: p => p === `${HOME}/cfg/claude/projects` })
    expect(wd('~/cfg/claude/projects', moved)[0]).toContain(`is inside ${HOME}/cfg/claude (Claude's config folder, CLAUDE_CONFIG_DIR)`)
  })
  test('an operator specialist is not subject to any of it', () => {
    expect(ok(spec('', '~/agents/nested')).config.specialists.ops.restricted).toBe(false)
  })
})

describe('LoadEnv: nothing is optional', () => {
  test('a test env names every probe, and the loader reads them all (a missing one is a type error, not a skipped check)', () => {
    const keys = Object.keys(testLoadEnv()).sort()
    expect(keys).toEqual(['claudeConfigDir', 'envFileHas', 'exists', 'home', 'isCommand', 'isDir', 'isGitWorkTree', 'macosVersion', 'mcpNamesIn', 'platform', 'realpath', 'scanWorkdir', 'sessionNames', 'stateDir'])
  })
})

describe('mcp (restricted = true)', () => {
  test('a declared server with tools loads, in file order', () => {
    expect(ok(spec('restricted = true\nmcp_servers = ["datadog"]')).config.specialists.ops.mcpServerNames).toEqual(['datadog'])
  })
  test('a name with no [mcp_servers.<name>] is refused', () => {
    expect(errorsOf(spec('restricted = true\nmcp_servers = ["datadog", "nope"]'))).toEqual(['specialists.ops.mcp_servers[1]: no [mcp_servers.nope]: declare the server in hydra.toml first'])
  })
  test('deny_tools on a listed server that names a tool the restricted specialist is allowed is refused, not ignored (it is held to the tools list)', () => {
    const withDeny = (names: string) => spec('restricted = true\nmcp_servers = ["datadog"]').replace('tools = ["search_logs", "get_monitor"]', `tools = ["search_logs", "get_monitor"]\ndeny_tools = ${names}`)
    expect(errorsOf(withDeny('["get_monitor"]'))).toEqual(['specialists.ops.mcp_servers[0]: [mcp_servers.datadog] deny_tools names get_monitor, which its tools list allows a restricted specialist, and deny_tools is not applied to one (it may call only the tools listed): remove it from tools or from deny_tools (a server needed with the tool by one specialist and without it by another: declare it twice under two [mcp_servers.*] names)'])
    expect(ok(withDeny('["delete_monitor"]')).config.specialists.ops.mcpServerNames).toEqual(['datadog'])   // a tool it is not allowed anyway: harmless
  })
  test('a server with no tools is refused', () => {
    expect(errorsOf(spec('restricted = true\nmcp_servers = ["empty"]'))).toEqual(['specialists.ops.mcp_servers[0]: [mcp_servers.empty] lists no tools, so a specialist could call none of them: set its `tools`'])
  })
})

describe('a machine without sandbox-exec (a listed server runs under it)', () => {
  const noSandbox = testLoadEnv({ ...env, isCommand: c => c !== SANDBOX_EXEC && env.isCommand(c) })
  test('a workdir specialist listing a server is refused, naming the cause and both fixes', () => {
    const e = errorsOf(spec('restricted = true\nmcp_servers = ["datadog"]'), noSandbox)
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(/^specialists\.ops\.mcp_servers: a listed \[mcp_servers\.\*\] server runs under \/usr\/bin\/sandbox-exec \(macOS only\), which blocks its connects to the daemon's socket and its reads of the listed credential folders\. This machine does not have it\. Remove the servers from the specialist's mcp_servers, set restricted = false, or run hydra on a Mac$/)
  })
  test('a workdir specialist listing none loads as before', () => {
    expect(ok(spec('restricted = true'), noSandbox).config.specialists.ops.restricted).toBe(true)
  })
  test('an operator specialist is not asked', () => {
    expect(ok(spec('restricted = false'), noSandbox).config.specialists.ops.restricted).toBe(false)
  })
})

describe('one list of off-limits roots, for the workdir check and the sandbox profile', () => {
  test('a folder inside any place offLimits lists is refused as a workdir, with that place named', () => {
    const roots = offLimitRoots(env, ['/home/op/Notes'])
    expect(roots.length).toBeGreaterThanOrEqual(12)
    // Some roots sit inside others here (the state dir is under ~/.claude), so the place named may be the outer one.
    for (const r of roots) expect([r.label, workdirRestrictionIssues(env, `${r.path}/work`, ['/home/op/Notes'])[0]]).toEqual([r.label, expect.stringMatching(new RegExp(`^${r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/work is inside .*, which holds what a restricted specialist must not know$`))])
  })
})

describe('a path the sandbox profile cannot hold (a control character), refused at load', () => {
  test('an off_limits entry with a newline is refused where it is written, with the fix', () => {
    const e = errorsOf(`${BASE}\n[restricted]\noff_limits = ["/home/op/a\\nb"]`)
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(/^restricted\.off_limits\[0\]: .*control character.*remove it from the path$/)
  })
  test('a quote, a parenthesis and a backslash in an off_limits entry are fine: they are escaped', () => {
    expect(ok(`${BASE}\n[restricted]\noff_limits = ["/home/op/a\\"b)c(d\\\\e"]`).config.offLimits).toEqual(['/home/op/a"b)c(d\\e'])
  })
  test('a state dir or Claude config dir with a newline refuses a specialist that lists a server (it is in the profile), and no one else', () => {
    const e = errorsOf(spec('restricted = true\nmcp_servers = ["datadog"]'), testLoadEnv({ ...env, stateDir: '/srv/hy\ndra' }))
    expect(e.some(m => /^specialists\.ops\.mcp_servers: .*control character/.test(m))).toBe(true)
    expect(ok(spec('restricted = true'), testLoadEnv({ ...env, stateDir: '/srv/hy\ndra', isDir: p => DIRS.includes(p) })).config.specialists.ops.restricted).toBe(true)
  })
})

describe('a listed server whose token variable the state .env does not set (a warning: .env can change, the launch is the hard check)', () => {
  const noDdKey = testLoadEnv({ ...env, envFileHas: n => n !== 'DD_API_KEY' })
  test('a workdir specialist listing it warns, naming the variable, the file and the restart', () => {
    const r = ok(spec('restricted = true\nmcp_servers = ["datadog"]'), noDdKey)
    expect(r.warnings).toEqual([`specialists.ops.mcp_servers[0]: [mcp_servers.datadog] needs DD_API_KEY, and ${STATE}/.env does not set it, so no session of this specialist can start until it does: add DD_API_KEY=<value> there and restart the daemon`])
  })
  test('it loads (a warning, not an error)', () => {
    expect(ok(spec('restricted = true\nmcp_servers = ["datadog"]'), noDdKey).config.specialists.ops.mcpServerNames).toEqual(['datadog'])
  })
  test('with the variable set, no warning; a server nobody lists, or a server with no token variable, warns about nothing', () => {
    expect(ok(spec('restricted = true\nmcp_servers = ["datadog"]')).warnings).toEqual([])
    expect(ok(spec(''), noDdKey).warnings.filter(w => w.includes('DD_API_KEY'))).toEqual([])
  })
  test('an operator-access specialist lists no servers, so there is nothing to check', () => {
    expect(ok(spec(''), noDdKey).warnings.filter(w => w.includes('DD_API_KEY'))).toEqual([])
  })
})

describe('a server\'s token_env and the variables hydra keeps from sessions', () => {
  const server = (name: string) => `${BASE}\n[mcp_servers.x]\ncommand = "bun"\ntoken_env = ["${name}"]\n`
  test('a server never gets the chat gateway\'s own token, on either platform', () => {
    for (const v of ['DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) expect(errorsOf(server(v)).join('\n'), v).toMatch(new RegExp(`mcp_servers\\.x\\.token_env\\[0\\]: "${v}" is the token variable of .*: a server never gets hydra's own tokens`))
  })
  test('a variable sessions need loads with a warning: the server gets it and so does every session', () => {
    const r = ok(server('GH_TOKEN'))
    expect(r.warnings).toContain('mcp_servers.x.token_env[0]: "GH_TOKEN" is a variable sessions need, so hydra cannot keep it from sessions: [mcp_servers.x] gets it, and so does every session')
  })
  test('an ordinary server key warns about nothing', () => {
    expect(ok(server('DD_API_KEY')).warnings.filter(w => w.includes('token_env'))).toEqual([])
  })
})

describe('[mcp_servers.*]', () => {
  test('is parsed into the config: command, token_env names, tools', () => {
    expect(ok(spec('')).config.mcpServers!.datadog).toEqual({ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs', 'get_monitor'] })
  })
  test('the command must exist', () => {
    expect(errorsOf(`${BASE}\n[mcp_servers.x]\ncommand = "/nope/x"\n`)).toEqual(['mcp_servers.x.command: /nope/x is not an executable file or a command on PATH'])
  })
  test('the command is required', () => {
    expect(errorsOf(`${BASE}\n[mcp_servers.x]\ntools = ["a"]\n`)[0]).toContain('mcp_servers.x.command: is required')
  })
  test('hydra\'s own token variables are never a server\'s', () => {
    expect(errorsOf(`${BASE}\n[mcp_servers.x]\ncommand = "bun"\ntoken_env = ["CONNECTOR_SLACK_BOT_TOKEN"]\n`)).toEqual(['mcp_servers.x.token_env[0]: "CONNECTOR_SLACK_BOT_TOKEN" is the token variable of slack.apps.default.bot_token_env: a server never gets hydra\'s own tokens'])
  })
  test('a tool name is a name, not a pattern', () => {
    expect(errorsOf(`${BASE}\n[mcp_servers.x]\ncommand = "bun"\ntools = ["search_*"]\n`)[0]).toContain('mcp_servers.x.tools[0]')
  })
  test('an unknown key is an error', () => {
    expect(errorsOf(`${BASE}\n[mcp_servers.x]\ncommand = "bun"\nargs = ["-y"]\n`)).toEqual(['mcp_servers.x.args: unknown key "args"'])
  })
})

describe('engine', () => {
  test('codex is refused with restricted = true', () => {
    expect(errorsOf(spec('restricted = true\nengine = "codex"'))).toEqual([`specialists.ops.engine: codex can't run a restricted specialist: that engine cannot confine its tools; use claude (engine = "claude", or a Claude model), or set restricted = false`])
  })
  test('omp is refused for a specialist, restricted or not, with its own one message', () => {
    for (const body of ['restricted = true\nengine = "omp"', 'engine = "omp"']) {
      expect(errorsOf(spec(body))).toEqual([`specialists.ops.engine: omp cannot confine a session's tools, so a specialist cannot use it; use claude or codex`])
    }
  })
  test('claude, or no engine, loads', () => {
    expect(ok(spec('restricted = true\nengine = "claude"')).config.specialists.ops.engine).toBe('claude')
  })
})

describe('[defaults.specialist]', () => {
  test.each(['restricted = true', 'tools = ["Read"]', 'mcp_servers = ["datadog"]', 'sends_to = ["y"]'])('%s is refused as a default', line => {
    const key = line.split(' ')[0]
    const text = `${BASE}\n[defaults.specialist]\nworkdir = "~/agents/ops"\n${line}\n[specialists.ops]\nreachable_by = []\n[[rules]]\nplace = "slack:app-dm:*"\ntarget = "specialist:ops"\n`
    expect(errorsOf(text)).toEqual([`defaults.specialist.${key}: can't be a default: ${key} says what one specialist's session may reach. Set it under [specialists.<id>] by editing hydra.toml`])
  })
})

describe('the warning for an operator-access specialist someone else can talk to', () => {
  const WITH_ALICE = BASE.replace('[mcp_servers.datadog]', '[people.alice]\naddresses = ["slack:U0ALICE"]\nroles = ["staff"]\n[people.bob]\naddresses = ["slack:U0BOB"]\n[mcp_servers.datadog]')
  const text = (base: string, extra: string, body: string) => `${base}\n[specialists.ops]\nworkdir = "~/agents/ops"\n${body}\n${extra}`
  const warnings = (extra: string, body = '', base = BASE): string[] => ok(text(base, extra, body)).warnings.filter(w => w.includes("the operator's account"))
  /** `[[rules]]` sending each place to ops: where it is heard. */
  const heard = (...places: string[]) => places.map(p => `[[rules]]\nplace = "${p}"\ntarget = "specialist:ops"\n`).join('')
  const WARN = (who: string) => [`specialists.ops: ${who} can reach the operator's account through it; set restricted = true`]

  describe('who can talk to it', () => {
    test('reachable_by = []: only the operator, whatever place it is in', () => {
      expect(warnings('' + heard("slack:app-dm:*"), 'reachable_by = []')).toEqual([])
      expect(warnings('' + heard("slack:C0CF123"), 'reachable_by = []')).toEqual([])
    })
    test('the default reachable_by = ["role:people"] with a roster of only the operator: no one else, no warning', () => {
      expect(warnings('' + heard("slack:app-dm:*"), '')).toEqual([])
      expect(warnings('' + heard("slack:C0CF123"), '')).toEqual([])
    })
    test('reachable_by = ["role:people"] with others on the roster names them', () => {
      expect(warnings('' + heard("slack:app-dm:*"), 'reachable_by = ["role:people"]', WITH_ALICE)).toEqual(WARN('person:alice and person:bob (reachable_by = ["role:people"])'))
    })
    test('a role names its holders other than the operator', () => {
      expect(warnings('' + heard("slack:app-dm:*"), 'reachable_by = ["role:staff"]', WITH_ALICE)).toEqual(WARN('person:alice (role:staff)'))
    })
    test('reachable_by = ["role:anyone"]', () => {
      expect(warnings('' + heard("slack:app-dm:*"), 'reachable_by = ["role:anyone"]')).toEqual(WARN('anyone'))
    })
    test('anyone in a shared or public place says which', () => {
      expect(warnings('' + heard("slack:C0CF123"), 'reachable_by = ["role:anyone"]')).toEqual(WARN('anyone in slack:C0CF123'))
    })
    test('anyone, named once, however many roles and places say it', () => {
      expect(warnings('' + heard("slack:C0CF123", "slack:C0CF456"), 'reachable_by = ["role:anyone", "role:people", "role:staff"]\nsessions = "per-conversation"\nidle = "1h"', WITH_ALICE)).toEqual(WARN('anyone in slack:C0CF123 and slack:C0CF456'))
    })
    test('a github: place, for anyone', () => {
      const t = `${BASE}\n[connectors.github]\nrepos = ["acme/widget"]\n[specialists.ops]\nworkdir = "~/agents/ops"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "github:acme/widget"\ntarget = "specialist:ops"\n`
      expect(ok(t).warnings.filter(w => w.includes("the operator's account"))).toEqual(WARN('anyone who can comment on github:acme/widget'))
      const alone = t.replace('reachable_by = ["role:anyone"]', 'reachable_by = []')
      expect(ok(alone).warnings.filter(w => w.includes("the operator's account"))).toEqual([])
    })
    test('a bots = true place: other bots talk to it whatever reachable_by says', () => {
      expect(warnings('[places."slack:app-dm:*"]\nbots = true\n' + heard("slack:app-dm:*"), 'reachable_by = []')).toEqual(WARN('any other bot in slack:app-dm:*'))
    })
  })

  describe('who can only read its replies', () => {
    test('is not enough to warn: only the operator can talk to it', () => {
      expect(warnings('' + heard("slack:C0CF123", "github:acme/widget"), 'reachable_by = []\nsessions = "per-conversation"\nidle = "1h"').length).toBe(0)
    })
  })

  test('restricted = true has nothing to warn about', () => {
    expect(warnings('' + heard("slack:C0CF123"), 'restricted = true\nreachable_by = ["role:anyone"]')).toEqual([])
  })
})

// `hydra config add`: a fragment comes from another repo, so it can't set what a session may reach.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addFragment } from '../add.js'

describe('hydra config add refuses what only a hand edit sets', () => {
  const LIVE = `operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[mcp_servers.datadog]\ncommand = "bun"\ntools = ["a"]\n`
  const run = (fragment: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'access-add-'))
    try {
      writeFileSync(join(dir, 'hydra.toml'), LIVE)
      const r = addFragment(dir, testLoadEnv({ home: '/h' }), fragment, '/repo/frag.toml')
      return { r, after: readFileSync(join(dir, 'hydra.toml'), 'utf8') }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  test.each(['restricted = true', 'tools = ["Read"]', 'mcp_servers = ["datadog"]'])('a specialist table with %s is refused and nothing is written', line => {
    const { r, after } = run(`[specialists.x]\nworkdir = "~/x"\n${line}\n`)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(`[specialists.x] ${line.split(' ')[0]}`)
    expect(after).toBe(LIVE)
  })
  test('an [mcp_servers.*] table is refused: a fragment cannot declare a server or list one', () => {
    const { r, after } = run(`[mcp_servers.evil]\ncommand = "bun"\ntools = ["a"]\n[specialists.x]\nworkdir = "~/x"\n`)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('sets mcp')
    expect(after).toBe(LIVE)
  })
})
