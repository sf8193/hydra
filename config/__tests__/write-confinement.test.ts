// `can_only_write_to = "workdir"`: the middle trust level. Every load refusal and warning, one test per row.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { HydraConfig, LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { confinementWarning, readDenyRoots, unreadableWorkdir } from '../write-confinement.js'

const HOME = '/home/op'
const env: LoadEnv = testLoadEnv({ home: HOME, stateDir: `${HOME}/.claude/channels/discord`, claudeConfigDir: `${HOME}/.claude`, isCommand: c => c === '/usr/local/bin/browser-mcp' || c === '/usr/local/bin/datadog-mcp' })

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
const spec = (body: string, reachableBy = '[]', workdir = '~/agents/ops') => `${BASE}\n[specialists.ops]\nworkdir = "${workdir}"\nreachable_by = ${reachableBy}\n${body}\n[[rules]]\nplace = "slack:dm"\ntarget = "specialist:ops"\n`
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

  test('with restricted = true it is a load error: restricted already confines writes', () => {
    expect(errorsOf(spec('restricted = true\ncan_only_write_to = "workdir"'))).toEqual(['specialists.ops.can_only_write_to: restricted = true already confines writes and reads (and more); set restricted, or can_only_write_to, not both'])
  })

  test('tools and sends_to still belong to restricted = true alone', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\ntools = ["Read"]\nsends_to = ["x"]'))).toEqual([
      'specialists.ops.tools: has no effect while restricted = false: it already has every tool and server the operator does; set restricted = true to choose them',
      'specialists.ops.sends_to: has no effect while restricted = false: it already has every tool and server the operator does, and send_to_thread to any session; set restricted = true to choose them',
    ])
  })

  test('only the claude engine can run it', () => {
    expect(errorsOf(spec('can_only_write_to = "workdir"\nengine = "codex"'))).toEqual(['specialists.ops.engine: codex can\'t run a write-confined specialist: only Claude Code\'s own sandbox does the confining; set engine = "claude", or remove can_only_write_to'])
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
    expect(errorsOf(spec('restricted = true\ncan_only_write_to = "workdir"'))).toEqual(['specialists.ops.can_only_write_to: restricted = true already confines writes and reads (and more); set restricted, or can_only_write_to, not both'])
    expect(errorsOf(spec('restricted = true\ncannot_read = []'))[0]).toContain('specialists.ops.cannot_read: restricted = true already confines reads and commands')
    expect(errorsOf(spec('restricted = true\ndeny_commands = ["x"]'))[0]).toContain('specialists.ops.deny_commands: restricted = true already confines reads and commands')
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
    expect(confinementWarning('/w')).toBe("can reach the operator's account: Bash and Edit/Write writes are confined to /w, and Claude Code's tools and shell cannot read the credential folders (~/.ssh, ~/.aws and the like), hydra's state folder or other specialists' workdirs; ~/Library/Keychains is one of those folders, so `security` and git's keychain helper fail in its shell (shown with a throwaway keychain; login keychain: not proven live; the git helper cannot be told apart on the real one without writing an item; a store the keychain service holds without a file is not separately blocked); the browser and MCP servers can read them, and other reads, network, MCP servers' own writes and credentials are not confined; only a listed server that declares a profile folder uses its own profile in /w, and servers from the operator's ~/.claude.json or plugins still load and keep theirs; attachments sent to it are unreadable (the shared inbox is denied). Credential separation (run_as) is planned, not built.")
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
