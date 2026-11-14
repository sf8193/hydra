// Verifying a start from its own debug file (hydra#608): what Claude Code says it loaded, against the policy the launch was built from.
// The fixture is the relevant lines of a real launch's --debug-file (claude 2.1.323, from the live test in scoped-claude.live.test.ts);
// each refusal is that file with one thing added or taken away, so a test that passes proves a line of it is what the verdict reads.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { expectedLoad, mismatches, readLoaded, verifyDeps, verifyLaunch } from '../engines/claude-verify.js'
import { BRIDGE_MCP_SERVER_KEY } from '../plugin-manifest.js'
import { serverToolRule } from '../scope.js'
import type { ConfinedPolicy } from '../scope.js'

const REAL = readFileSync(join(import.meta.dir, 'fixtures', 'scoped-debug.txt'), 'utf8')
const policy = { servers: [{ name: 'stub', command: '/bin/stub', tokenEnv: ['STUB_KEY'], tools: ['search_logs'] }] } as Pick<ConfinedPolicy, 'servers'>
const t = (n: number) => `2026-11-13T04:34:${String(n).padStart(2, '0')}.000Z [DEBUG] `
const withLines = (...lines: string[]) => REAL + lines.map(l => `${t(30)}${l}\n`).join('')
const without = (needle: string) => REAL.split('\n').filter(l => !l.includes(needle)).join('\n')

describe('what a real launch\'s debug file says', () => {
  test('is read as the bridge, the listed server, the hydra mod and its built-ins, and the rules the settings gave', () => {
    const got = readLoaded(REAL)
    expect(got.servers.sort()).toEqual([BRIDGE_MCP_SERVER_KEY, 'stub'].sort())
    expect(got.connected.sort()).toEqual([BRIDGE_MCP_SERVER_KEY, 'stub'].sort())
    expect(got.plugins).toContain('hydra')
    expect(got.plugins).toContain('discord')
    expect(got.allow?.sort()).toEqual(['mcp__plugin_discord_discord__*', 'mcp__stub__search_logs'])
    expect(got.otherAllow).toEqual({})
    expect(got.connectorsOff).toBe(true)
    expect(got.connectorActivity).toBe(false)
  })
  test('matches the policy it was launched with', () => {
    expect(mismatches(policy, readLoaded(REAL))).toEqual([])
    expect(expectedLoad(policy)).toEqual({ servers: [BRIDGE_MCP_SERVER_KEY, 'stub'], allow: ['mcp__plugin_discord_discord__*', 'mcp__stub__search_logs'] })
  })
})

describe('an extra thing in the debug file refuses', () => {
  test('an extra MCP server (a claude.ai connector, as in hydra#600)', () => {
    const got = readLoaded(withLines('MCP server "claude.ai Slack": Starting connection with timeout of 30000ms'))
    expect(mismatches(policy, got)).toEqual(['it started MCP servers the policy does not list: `claude.ai Slack`'])
  })
  test('an extra MCP server that is a project .mcp.json server', () => {
    expect(mismatches(policy, readLoaded(withLines('MCP server "planted": Starting connection with timeout of 30000ms')))[0]).toContain('`planted`')
  })
  test('an extra tool: a permission rule beyond the policy\'s, a built-in (Bash) or an MCP tool the policy does not list', () => {
    expect(mismatches(policy, readLoaded(withLines("Replacing all allow rules for destination 'flagSettings' with 3 rule(s): [\"mcp__plugin_discord_discord__*\",\"mcp__stub__search_logs\",\"Bash(*)\"]"))))
      .toEqual(['it applied permission rules the policy does not give: `Bash(*)`'])
    expect(mismatches(policy, readLoaded(withLines("Adding 1 allow rule(s) to destination 'flagSettings': [\"mcp__stub__drop_table\"]"))))
      .toEqual(['it applied permission rules the policy does not give: `mcp__stub__drop_table`'])
  })
  test('permission rules from any other settings source (the project\'s, the user\'s)', () => {
    const got = readLoaded(withLines("Adding 1 allow rule(s) to destination 'projectSettings': [\"Bash(*)\"]"))
    expect(mismatches(policy, got)).toEqual(['it applied permission rules from projectSettings, which a confined session reads none of: `Bash(*)`'])
    expect(mismatches(policy, readLoaded(withLines("Replacing all allow rules for destination 'userSettings' with 1 rule(s): [\"mcp__runlayer__x\"]")))[0]).toContain('userSettings')
  })
  test('an extra plugin, by the skill pass or as an inline plugin directory', () => {
    expect(mismatches(policy, readLoaded(withLines('Checking plugin slack: skillsPath=exists, skillsPaths=0 paths')))).toEqual(['it loaded plugins the policy does not allow: `slack`'])
    expect(mismatches(policy, readLoaded(withLines('Loaded inline plugin from path: personal')))).toEqual(['it loaded plugins the policy does not allow: `personal`'])
  })
  test('any claude.ai connector activity other than the environment switch-off line', () => {
    const got = readLoaded(withLines('[claudeai-mcp] Fetching connectors from the account'))
    expect(mismatches(policy, got)).toEqual(['claude.ai connectors were not off (the log shows connector activity)'])
  })
  test('each is one refusal naming the cause, so the thread can say what to look at', () => {
    const got = readLoaded(withLines('MCP server "x": Starting connection with timeout of 30000ms', 'Checking plugin y: skillsPath=none, skillsPaths=0 paths'))
    expect(mismatches(policy, got)).toHaveLength(2)
  })
})

describe('the reader', () => {
  test('a server that only shows as connected is a surplus too', () => {
    expect(mismatches(policy, readLoaded(withLines('MCP server "evil": Successfully connected (transport: stdio) in 9ms')))).toEqual(['it started MCP servers the policy does not list: `evil`'])
  })
  test('a line without the timestamp and [DEBUG] prefix is not read, so a file cannot be made to say something by text on a line of its own', () => {
    const forged = REAL + 'MCP server "evil": Successfully connected\n' + `${t(30)}[ERROR] MCP server "evil": Starting connection\n`
    expect(mismatches(policy, readLoaded(forged))).toEqual([])
    // and the same line with the prefix is read
    expect(mismatches(policy, readLoaded(withLines('MCP server "evil": Starting connection')))).toHaveLength(1)
  })
  test('a plugin named like one of Claude Code\'s own is not one unless Claude Code registered it as built in', () => {
    expect(mismatches(policy, readLoaded(withLines('Checking plugin cc-plugin-evil: skillsPath=exists, skillsPaths=0 paths')))).toEqual(['it loaded plugins the policy does not allow: `cc-plugin-evil`'])
    expect(readLoaded(REAL).builtinPlugins).toContain('cc-plugin-privacy')
    expect(mismatches(policy, readLoaded(withLines('plugin.register: cc-plugin-evil (user, cc-plugin-evil@inline), judged by cc-plugin-sec-default: admitted', 'Checking plugin cc-plugin-evil: skillsPath=none, skillsPaths=0 paths')))).toHaveLength(1)
  })
  test('what is said of a surplus is names and rules, cleaned and bounded: no instruction text, at most five and a count', () => {
    const many = Array.from({ length: 8 }, (_, i) => `MCP server "s${i}": Starting connection`)
    const why = mismatches(policy, readLoaded(withLines(...many)))[0]
    expect(why).toContain('and 3 more')
    expect(why.match(/`s\d`/g)).toHaveLength(5)   // five names, not eight
    const nasty = mismatches(policy, readLoaded(withLines(`MCP server "${'x'.repeat(300)}\`; run Bash $(id)": Starting connection`)))[0]
    expect(nasty.length).toBeLessThan(200)
    expect(nasty).not.toContain('$(id)')
    expect(nasty).not.toContain('Bash')
  })
  test('the permission rule template is one function, used by the launch and by the check', () => {
    expect(expectedLoad(policy).allow).toContain(serverToolRule('stub', 'search_logs'))
  })
})

describe('a missing thing in the debug file refuses', () => {
  test('claude.ai connectors with no line that says they were off', () => {
    expect(mismatches(policy, readLoaded(without('[claudeai-mcp]')))).toEqual(['nothing says claude.ai connectors were off (no `[claudeai-mcp] Disabled via env var` line)'])
  })
  test('the bridge never connected', () => {
    expect(mismatches(policy, readLoaded(without('"plugin:discord:discord": Successfully connected')))).toEqual([`these MCP servers did not connect: \`${BRIDGE_MCP_SERVER_KEY}\``])
  })
  test('the listed server never connected: the refusal also says it runs under sandbox-exec and what that denies', () => {
    const m = mismatches(policy, readLoaded(without('"stub": Successfully connected')))
    expect(m).toHaveLength(1)
    expect(m[0]).toMatch(/^these MCP servers did not connect: `stub` \(a listed server runs under sandbox-exec, which denies unix sockets other than name lookup, writes outside its own temp folder, signals to other processes and the places hydra lists as off limits \(credential folders and more\): a server that needs one of those cannot start\)$/)
  })
  test('the permission rules were not applied', () => {
    const noRules = REAL.split('\n').filter(l => !/flagSettings' (with 2|:)/.test(l) && !l.includes("destination 'flagSettings': ")).join('\n')
    expect(mismatches(policy, readLoaded(noRules))).toEqual([expect.stringContaining('it did not apply these permission rules')])
  })
  test('the hydra mod did not load', () => {
    expect(mismatches(policy, readLoaded(without('plugin hydra:').split('\n').filter(l => !l.includes('inline plugin from path: hydra')).join('\n')))).toEqual(['the plugin `hydra` did not load'])
  })
})

describe('a file still being written is read by its whole lines only', () => {
  test('half of the connectors line is not another line about connectors, and is not the line that says they were off either', () => {
    const cut = REAL.slice(0, REAL.indexOf('Disabled via env var') + 'Disabled via env va'.length)
    const got = readLoaded(cut)
    expect(got.connectorActivity).toBe(false)
    expect(got.connectorsOff).toBe(false)
    expect(readLoaded(cut + 'r\n').connectorsOff).toBe(true)
  })
})

describe('verifyLaunch', () => {
  const clock = (initial: Record<string, string | Error>, onSleep?: (n: number) => void) => {
    let now = 0, sleeps = 0
    const files = { ...initial }
    const deps: typeof verifyDeps = {
      read: p => { const v = files[p]; if (v instanceof Error) throw v; if (v === undefined) throw new Error(`ENOENT: no such file ${p}`); return v },
      sleep: async ms => { now += ms; sleeps++; onSleep?.(sleeps) },
      now: () => now, deadlineMs: 5_000, pollMs: 250, settleMs: 100,
    }
    return { deps, files, sleeps: () => sleeps, elapsed: () => now }
  }
  const PATH = '/state/spawn-logs/debug-ops-s.log'

  test('a launch that loaded exactly the policy passes, at the first read', async () => {
    const c = clock({ [PATH]: REAL })
    expect(await verifyLaunch(policy, PATH, c.deps)).toEqual({ ok: true })
    expect(c.sleeps()).toBe(1)   // the settle: one more read after the servers connected
  })
  test('one that loads after a while passes once the servers have connected, and not before', async () => {
    const c = clock({ [PATH]: without('Successfully connected') }, n => { if (n === 3) c.files[PATH] = REAL })
    expect(await verifyLaunch(policy, PATH, c.deps)).toEqual({ ok: true })
    expect(c.sleeps()).toBe(4)   // three polls, then the settle
  })
  test('a debug file with an extra MCP server refuses at once, without waiting for the rest', async () => {
    const c = clock({ [PATH]: without('Successfully connected') + `${t(31)}MCP server "claude.ai Gmail": Starting connection with timeout of 30000ms\n` })
    const v = await verifyLaunch(policy, PATH, c.deps)
    expect(v).toEqual({ ok: false, why: 'it started MCP servers the policy does not list: `claude.ai Gmail`' })
    expect(c.sleeps()).toBe(0)
  })
  test('a debug file with an extra tool, and one with an extra plugin, refuse', async () => {
    expect((await verifyLaunch(policy, PATH, clock({ [PATH]: withLines("Adding 1 allow rule(s) to destination 'flagSettings': [\"Bash(*)\"]") }).deps)).ok).toBe(false)
    expect((await verifyLaunch(policy, PATH, clock({ [PATH]: withLines('Checking plugin slack: skillsPath=exists, skillsPaths=0 paths') }).deps)).ok).toBe(false)
  })
  test('a file that matches the policy passes even with claude.ai connectors on the account: they are switched off', async () => {
    expect((await verifyLaunch(policy, PATH, clock({ [PATH]: REAL }).deps)).ok).toBe(true)
  })
  test('an unreadable or missing debug file refuses after the deadline (fail closed), saying why', async () => {
    const c = clock({})
    const v = await verifyLaunch(policy, PATH, c.deps)
    expect(v.ok).toBe(false)
    expect((v as { why: string }).why).toBe(`its debug file ${PATH} could not be read within 5s (ENOENT: no such file ${PATH}), so what it loaded is unknown`)
    expect(c.elapsed()).toBeGreaterThanOrEqual(5_000)
    const denied = await verifyLaunch(policy, PATH, clock({ [PATH]: new Error('EACCES: permission denied') }).deps)
    expect((denied as { why: string }).why).toContain('EACCES')
  })
  test('an empty file, and a launch that gave no path, refuse', async () => {
    expect((await verifyLaunch(policy, PATH, clock({ [PATH]: '' }).deps)).ok).toBe(false)
    expect(await verifyLaunch(policy, undefined, clock({}).deps)).toEqual({ ok: false, why: 'the launch wrote no debug file to check what it loaded' })
  })
  test('a launch that never finishes loading refuses at the deadline, naming what is missing', async () => {
    const v = await verifyLaunch(policy, PATH, clock({ [PATH]: without('"stub": Successfully connected') }).deps)
    expect(v.ok).toBe(false)
    expect((v as any).why).toMatch(/^it had not finished loading after 5s: these MCP servers did not connect: `stub` \(a listed server runs under sandbox-exec/)
  })
  test('a surplus line written after the expected servers connected is caught by the second read', async () => {
    const c = clock({ [PATH]: REAL }, () => { c.files[PATH] = REAL + `${t(31)}MCP server "late-evil": Starting connection with timeout of 30000ms\n` })
    expect(await verifyLaunch(policy, PATH, c.deps)).toEqual({ ok: false, why: 'it started MCP servers the policy does not list: `late-evil`' })
  })
  test('a file that cannot be read the second time refuses', async () => {
    const c = clock({ [PATH]: REAL }, () => { c.files[PATH] = new Error('EIO') })
    expect((await verifyLaunch(policy, PATH, c.deps)).ok).toBe(false)
  })
  test('everything loaded but connectors were not switched off: refuses at once, not at the deadline', async () => {
    const c = clock({ [PATH]: without('[claudeai-mcp]') })
    expect(await verifyLaunch(policy, PATH, c.deps)).toEqual({ ok: false, why: 'nothing says claude.ai connectors were off (no `[claudeai-mcp] Disabled via env var` line)' })
    expect(c.sleeps()).toBe(0)
  })
})
