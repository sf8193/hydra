// `access`, specialist `tools` and `mcp`, `[mcp.*]`, `[defaults] private_roots`: every refusal and warning, one test per row.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { HydraConfig, LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'

const HOME = '/home/op'
const STATE = '/home/op/.claude/channels/discord'
const DIRS = [HOME, `${HOME}/agents/nested`, `${HOME}/agents/huge`, `${HOME}/agents/under-mcp/work`, `${HOME}/cfg/claude/projects`, `${HOME}/agents/ops`, `${HOME}/agents/repo`, `${HOME}/agents/links`, `${HOME}/agents/mcpjson`, `${HOME}/notes/hydra`, `${HOME}/.ssh`, `${HOME}/.config/app`, `${HOME}/.claude/projects`, STATE, `${STATE}/sub`, '/']
const env: LoadEnv = testLoadEnv({
  home: HOME, sessionNames: ['spark'],
  stateDir: STATE,
  claudeConfigDir: `${HOME}/.claude`,
  isDir: p => DIRS.includes(p),
  isCommand: c => ['/usr/local/bin/datadog-mcp', 'bun'].includes(c),
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
ids = ["slack:U0OP"]
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
[mcp.datadog]
command = "/usr/local/bin/datadog-mcp"
token_env = ["DD_API_KEY"]
tools = ["search_logs", "get_monitor"]
[mcp.empty]
command = "bun"
`
const spec = (body: string, workdir = '~/agents/ops') => `${BASE}\n[specialists.ops]\nworkdir = "${workdir}"\nlistens = ["slack:dm"]\nallow = []\nhome = "slack:#escalations"\n${body}\n`

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
    expect(config.specialists.ops.access).toBe('operator')
    expect(config.specialists.ops.tools).toBeUndefined()
    expect(config.specialists.ops.mcp).toBeUndefined()
  })

  test('workdir gets the default tools Read, Grep, Glob and no servers', () => {
    const { config } = ok(spec('access = "workdir"'))
    expect(config.specialists.ops).toMatchObject({ access: 'workdir', tools: ['Read', 'Grep', 'Glob'], mcp: [] })
  })

  test('a value other than operator or workdir is an error', () => {
    expect(errorsOf(spec('access = "admin"'))).toEqual(['specialists.ops.access: must be one of "operator", "workdir"'])
  })

  test('tools and mcp on an operator specialist are refused: nothing passes silently', () => {
    const errs = errorsOf(spec('tools = ["Read"]\nmcp = ["datadog"]'))
    expect(errs).toEqual([
      'specialists.ops.tools: has no effect while access = "operator": it already has every tool and server the operator does; set access = "workdir" to choose them',
      'specialists.ops.mcp: has no effect while access = "operator": it already has every tool and server the operator does; set access = "workdir" to choose them',
    ])
  })
})

describe('tools (access = "workdir")', () => {
  test('a subset of Read, Grep, Glob loads', () => {
    expect(ok(spec('access = "workdir"\ntools = ["Read", "Glob"]')).config.specialists.ops.tools).toEqual(['Read', 'Glob'])
  })
  test.each([
    ['Bash', 'runs code outside the workdir'],
    ['Edit', 'writes files'],
    ['Write', 'writes files'],
    ['Task', 'starts agents that carry other tools'],
  ])('%s is refused with its reason', (tool, why) => {
    expect(errorsOf(spec(`access = "workdir"\ntools = ["Read", "Grep", "${tool}"]`))).toEqual([`specialists.ops.tools[2]: ${tool} ${why}; remove it or set access = "operator"`])
  })
  test('a tool outside the allowlist with no special reason gets the generic refusal', () => {
    expect(errorsOf(spec('access = "workdir"\ntools = ["Frobnicate"]'))).toEqual(['specialists.ops.tools[0]: Frobnicate is not a tool a workdir specialist may use (Read, Grep, Glob); remove it or set access = "operator"'])
  })
  test('WebFetch loads, with a warning', () => {
    const { config, warnings } = ok(spec('access = "workdir"\ntools = ["Read", "WebFetch"]'))
    expect(config.specialists.ops.access).toBe('workdir')
    expect(warnings).toEqual(['specialists.ops.tools[1]: WebFetch can fetch an outside URL with data in it; anyone who can talk to this specialist can choose that URL'])
  })
})

describe('workdir (access = "workdir")', () => {
  const wd = (path: string) => errorsOf(spec('access = "workdir"', path))
  test('the home folder itself is refused', () => {
    expect(wd('~')).toEqual(['specialists.ops.workdir: /home/op is your whole home folder: a scoped specialist\'s folder must be its own'])
  })
  test.each([
    ['~/.ssh', '~/.ssh'], ['~/.config/app', '~/.config'], ['~/.claude/projects', '~/.claude'],
  ])('%s is inside a private home folder', (path, root) => {
    expect(wd(path)).toEqual([`specialists.ops.workdir: ${HOME}${path.slice(1)} is inside ${root}, which holds what a scoped specialist must not know`])
  })
  test('the state folder, and a folder inside it', () => {
    expect(wd(STATE)[0]).toContain('is inside ~/.claude')   // the state dir lives under ~/.claude/channels
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/hydra-state', isDir: p => ['/srv/hydra-state', '/srv/hydra-state/sub'].includes(p) }
    expect(errorsOf(spec('access = "workdir"', '/srv/hydra-state/sub'), apart)).toEqual(['specialists.ops.workdir: /srv/hydra-state/sub is inside the state folder /srv/hydra-state, which holds what a scoped specialist must not know'])
  })
  test('a folder that contains the state folder (or any private root) is refused', () => {
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/hydra-state/x', isDir: p => p === '/srv/hydra-state' }
    expect(errorsOf(spec('access = "workdir"', '/srv/hydra-state'), apart)[0]).toContain('contains the state folder /srv/hydra-state/x')
    expect(wd('/')[0]).toContain('contains ~/.claude')
  })
  test('hydra.toml and the token file are covered through the state folder', () => {
    const apart: LoadEnv = { ...env, home: '/other', stateDir: '/srv/s/state', isDir: p => p === '/srv/s' }
    expect(errorsOf(spec('access = "workdir"', '/srv/s'), apart)[0]).toContain('contains the state folder /srv/s/state')
  })
  test('an operator-configured private root, which lives in config and not in code', () => {
    const text = spec('access = "workdir"', '~/notes/hydra').replace('operator = "op"', 'operator = "op"\n[defaults]\nprivate_roots = ["~/notes"]')
    expect(errorsOf(text)).toEqual(['specialists.ops.workdir: /home/op/notes/hydra is inside /home/op/notes (a private root in [defaults]), which holds what a scoped specialist must not know'])
    // The same folder with no private root configured loads: the loader knows no operator's paths.
    expect(ok(spec('access = "workdir"', '~/notes/hydra')).config.specialists.ops.access).toBe('workdir')
  })
  test('private_roots must be absolute', () => {
    expect(errorsOf(`${BASE}\n[defaults]\nprivate_roots = ["notes"]`)).toEqual(['defaults.private_roots[0]: "notes" must be an absolute path or start with ~'])
  })
  test('a git work tree is refused', () => {
    expect(wd('~/agents/repo')[0]).toContain('is a git work tree')
  })
  test('a symlink that resolves outside it is refused', () => {
    expect(wd('~/agents/links')).toEqual([`specialists.ops.workdir: /home/op/agents/links/notes -> /etc is a symlink that resolves outside /home/op/agents/links: a scoped specialist's folder must not lead anywhere else`])
  })
  test('a symlinked path to a private folder is judged by where it resolves', () => {
    const viaLink: LoadEnv = { ...env, isDir: p => p === `${HOME}/agents/ops`, realpath: p => (p === `${HOME}/agents/ops` ? `${HOME}/.ssh` : p) }
    expect(errorsOf(spec('access = "workdir"'), viaLink)[0]).toContain('is inside ~/.ssh')
  })
  test('a .mcp.json in the workdir is refused', () => {
    expect(wd('~/agents/mcpjson')[0]).toContain('holds a .mcp.json')
  })
  test('the same folders load under access = "operator": the rules are the seal\'s, not the loader\'s', () => {
    expect(ok(spec('', '~/agents/repo')).config.specialists.ops.access).toBe('operator')
  })
  test('a clean folder loads', () => {
    expect(ok(spec('access = "workdir"')).warnings).toEqual([])
  })
})

describe('workdir (access = "workdir"): what Claude Code could still reach', () => {
  const wd = (path: string, e: LoadEnv = env) => errorsOf(spec('access = "workdir"', path), e)
  test('a git repository nested inside it is refused, and the refusal says why although --restricted would not read it', () => {
    expect(wd('~/agents/nested')).toEqual(['specialists.ops.workdir: /home/op/agents/nested holds a git repository (/home/op/agents/nested/vendor/lib/.git): its history is in reach of anyone who can talk to this specialist; remove it, or give the specialist a folder with no repository in it'])
  })
  test('a .mcp.json in a folder above it is refused (--restricted ignores it, but a scoped folder sits under none)', () => {
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
    expect(ok(spec('', '~/agents/nested')).config.specialists.ops.access).toBe('operator')
  })
})

describe('LoadEnv: nothing is optional', () => {
  test('a test env names every probe, and the loader reads them all (a missing one is a type error, not a skipped check)', () => {
    const keys = Object.keys(testLoadEnv()).sort()
    expect(keys).toEqual(['claudeConfigDir', 'envFileHas', 'exists', 'home', 'isCommand', 'isDir', 'isGitWorkTree', 'realpath', 'scanWorkdir', 'sessionNames', 'stateDir'])
  })
})

describe('mcp (access = "workdir")', () => {
  test('a declared server with tools loads, in file order', () => {
    expect(ok(spec('access = "workdir"\nmcp = ["datadog"]')).config.specialists.ops.mcp).toEqual(['datadog'])
  })
  test('a name with no [mcp.<name>] is refused', () => {
    expect(errorsOf(spec('access = "workdir"\nmcp = ["datadog", "nope"]'))).toEqual(['specialists.ops.mcp[1]: no [mcp.nope]: declare the server in hydra.toml first'])
  })
  test('a server with no tools is refused', () => {
    expect(errorsOf(spec('access = "workdir"\nmcp = ["empty"]'))).toEqual(['specialists.ops.mcp[0]: [mcp.empty] lists no tools, so a specialist could call none of them: set its `tools`'])
  })
})

describe('a listed server whose token variable the state .env does not set (a warning: .env can change, the launch is the hard check)', () => {
  const noDdKey = testLoadEnv({ ...env, envFileHas: n => n !== 'DD_API_KEY' })
  test('a workdir specialist listing it warns, naming the variable, the file and the restart', () => {
    const r = ok(spec('access = "workdir"\nmcp = ["datadog"]'), noDdKey)
    expect(r.warnings).toEqual([`specialists.ops.mcp[0]: [mcp.datadog] needs DD_API_KEY, and ${STATE}/.env does not set it, so no session of this specialist can start until it does: add DD_API_KEY=<value> there and restart the daemon`])
  })
  test('it loads (a warning, not an error)', () => {
    expect(ok(spec('access = "workdir"\nmcp = ["datadog"]'), noDdKey).config.specialists.ops.mcp).toEqual(['datadog'])
  })
  test('with the variable set, no warning; a server nobody lists, or a server with no token variable, warns about nothing', () => {
    expect(ok(spec('access = "workdir"\nmcp = ["datadog"]')).warnings).toEqual([])
    expect(ok(spec(''), noDdKey).warnings.filter(w => w.includes('DD_API_KEY'))).toEqual([])
  })
  test('an operator-access specialist lists no servers, so there is nothing to check', () => {
    expect(ok(spec(''), noDdKey).warnings.filter(w => w.includes('DD_API_KEY'))).toEqual([])
  })
})

describe('[mcp.*]', () => {
  test('is parsed into the config: command, token_env names, tools', () => {
    expect(ok(spec('')).config.mcpServers!.datadog).toEqual({ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs', 'get_monitor'] })
  })
  test('the command must exist', () => {
    expect(errorsOf(`${BASE}\n[mcp.x]\ncommand = "/nope/x"\n`)).toEqual(['mcp.x.command: /nope/x is not an executable file or a command on PATH'])
  })
  test('the command is required', () => {
    expect(errorsOf(`${BASE}\n[mcp.x]\ntools = ["a"]\n`)[0]).toContain('mcp.x.command: is required')
  })
  test('hydra\'s own token variables are never a server\'s', () => {
    expect(errorsOf(`${BASE}\n[mcp.x]\ncommand = "bun"\ntoken_env = ["SLACK_BOT_TOKEN"]\n`)).toEqual(['mcp.x.token_env[0]: "SLACK_BOT_TOKEN" is the token variable of connectors.slack.bot_token_env: a server never gets hydra\'s own tokens'])
  })
  test('a tool name is a name, not a pattern', () => {
    expect(errorsOf(`${BASE}\n[mcp.x]\ncommand = "bun"\ntools = ["search_*"]\n`)[0]).toContain('mcp.x.tools[0]')
  })
  test('an unknown key is an error', () => {
    expect(errorsOf(`${BASE}\n[mcp.x]\ncommand = "bun"\nargs = ["-y"]\n`)).toEqual(['mcp.x.args: unknown key "args"'])
  })
})

describe('engine', () => {
  test.each(['codex', 'omp'])('%s is refused with access = "workdir"', engine => {
    expect(errorsOf(spec(`access = "workdir"\nengine = "${engine}"`))[0]).toContain(`specialists.ops.engine: ${engine} can't run an access = "workdir" specialist: that engine cannot confine its tools; set engine = "claude", or set access = "operator"`)
  })
  test('claude, or no engine, loads', () => {
    expect(ok(spec('access = "workdir"\nengine = "claude"')).config.specialists.ops.engine).toBe('claude')
  })
})

describe('[defaults.specialist]', () => {
  test.each(['access = "workdir"', 'tools = ["Read"]', 'mcp = ["datadog"]'])('%s is refused as a default', line => {
    const key = line.split(' ')[0]
    const text = `${BASE}\n[defaults.specialist]\nworkdir = "~/agents/ops"\n${line}\n[specialists.ops]\nlistens = ["slack:dm"]\nallow = []\n`
    expect(errorsOf(text)).toEqual([`defaults.specialist.${key}: can't be a default: ${key} says what one specialist's session may reach. Set it under [specialists.<id>] by editing hydra.toml`])
  })
})

describe('the warning for an operator-access specialist someone else can talk to', () => {
  const WITH_ALICE = BASE.replace('[mcp.datadog]', '[people.alice]\nids = ["slack:U0ALICE"]\nroles = ["staff"]\n[people.bob]\nids = ["slack:U0BOB"]\n[mcp.datadog]')
  const text = (base: string, extra: string, body: string) => `${base}\n[specialists.ops]\nworkdir = "~/agents/ops"\n${body}\n${extra}`
  const warnings = (extra: string, body = '', base = BASE): string[] => ok(text(base, extra, body)).warnings.filter(w => w.includes("the operator's account"))
  const WARN = (who: string) => [`specialists.ops: ${who} can reach the operator's account through it; set access = "workdir"`]

  describe('who can talk to it', () => {
    test('allow = []: only the operator, whatever place it is in', () => {
      expect(warnings('', 'listens = ["slack:dm"]\nallow = []')).toEqual([])
      expect(warnings('', 'listens = ["slack:C0CF123"]\nallow = []')).toEqual([])
    })
    test('the default allow = ["people"] with a roster of only the operator: no one else, no warning', () => {
      expect(warnings('', 'listens = ["slack:dm"]')).toEqual([])
      expect(warnings('', 'listens = ["slack:C0CF123"]')).toEqual([])
    })
    test('allow = ["people"] with others on the roster names them', () => {
      expect(warnings('', 'listens = ["slack:dm"]\nallow = ["people"]', WITH_ALICE)).toEqual(WARN('alice and bob (allow = ["people"])'))
    })
    test('a role names its holders other than the operator', () => {
      expect(warnings('', 'listens = ["slack:dm"]\nallow = ["staff"]', WITH_ALICE)).toEqual(WARN('alice (role "staff")'))
    })
    test('allow = ["anyone"]', () => {
      expect(warnings('', 'listens = ["slack:dm"]\nallow = ["anyone"]')).toEqual(WARN('anyone'))
    })
    test('anyone in a shared or public place says which', () => {
      expect(warnings('', 'listens = ["slack:C0CF123"]\nallow = ["anyone"]')).toEqual(WARN('anyone in slack:C0CF123'))
    })
    test('anyone, named once, however many roles and places say it', () => {
      expect(warnings('', 'listens = ["slack:C0CF123", "slack:C0CF456"]\nallow = ["anyone", "people", "staff"]\nsessions = "per-conversation"\nidle = "1h"', WITH_ALICE)).toEqual(WARN('anyone in slack:C0CF123 and slack:C0CF456'))
    })
    test('a github: place, for anyone', () => {
      const t = `${BASE}\n[connectors.github]\nrepos = ["acme/widget"]\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["github:acme/widget"]\nallow = ["anyone"]\n`
      expect(ok(t).warnings.filter(w => w.includes("the operator's account"))).toEqual(WARN('anyone who can comment on github:acme/widget'))
      const alone = t.replace('allow = ["anyone"]', 'allow = []')
      expect(ok(alone).warnings.filter(w => w.includes("the operator's account"))).toEqual([])
    })
    test('a bots = true place: other bots talk to it whatever allow says', () => {
      expect(warnings('[places."slack:dm"]\nbots = true', 'listens = ["slack:dm"]\nallow = []')).toEqual(WARN('any other bot in slack:dm'))
    })
  })

  describe('who can only read its replies', () => {
    test('is not enough to warn: only the operator can talk to it', () => {
      expect(warnings('', 'listens = ["slack:C0CF123", "github:acme/widget"]\nallow = []\nsessions = "per-conversation"\nidle = "1h"').length).toBe(0)
    })
  })

  test('access = "workdir" has nothing to warn about', () => {
    expect(warnings('', 'access = "workdir"\nlistens = ["slack:C0CF123"]\nallow = ["anyone"]')).toEqual([])
  })
})

// `hydra config add`: a fragment comes from another repo, so it can't set what a session may reach.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addFragment } from '../add.js'

describe('hydra config add refuses what only a hand edit sets', () => {
  const LIVE = `operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n[mcp.datadog]\ncommand = "bun"\ntools = ["a"]\n`
  const run = (fragment: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'access-add-'))
    try {
      writeFileSync(join(dir, 'hydra.toml'), LIVE)
      const r = addFragment(dir, testLoadEnv({ home: '/h' }), fragment, '/repo/frag.toml')
      return { r, after: readFileSync(join(dir, 'hydra.toml'), 'utf8') }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  test.each(['access = "workdir"', 'tools = ["Read"]', 'mcp = ["datadog"]'])('a specialist table with %s is refused and nothing is written', line => {
    const { r, after } = run(`[specialists.x]\nworkdir = "~/x"\n${line}\n`)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(`[specialists.x] ${line.split(' ')[0]}`)
    expect(after).toBe(LIVE)
  })
  test('an [mcp.*] table is refused: a fragment cannot declare a server or list one', () => {
    const { r, after } = run(`[mcp.evil]\ncommand = "bun"\ntools = ["a"]\n[specialists.x]\nworkdir = "~/x"\n`)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('sets mcp')
    expect(after).toBe(LIVE)
  })
})
