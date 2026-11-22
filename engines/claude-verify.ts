// Claude's way of checking a restricted specialist's session against its policy (the adapter's `verifyLaunch`): Claude Code's own record of what it loaded: the `--debug-file` of the
// launch itself (tmux sessions emit no init event).
//
// The policy decides what a restricted specialist may reach (restricted.ts); the argv, settings and MCP config are built from it
// (claude-engine.ts). That is what hydra asked for. This reads what Claude Code did: the launch's debug file says which MCP servers it
// started and connected, which plugins it loaded, which permission rules it applied, and whether claude.ai's connectors were off.
// Any difference from the policy refuses the start. Claude Code loaded a different set from the same argv before (hydra#600: claude.ai
// connectors appeared on one run and not the next), so an argv that is right does not prove a session that is.
//
// Servers are matched by name only: the debug file does not show an MCP server's command or arguments (claude 2.1.323), so a server
// of the right name running another command passes here. The launch's own MCP config is what names the command, and it is written by hydra.
//
// What the debug file does not carry is the built-in tool list: `--tools` is verified by the init event in the live test
// (restricted-claude.live.test.ts); here, a tool beyond the policy shows as a permission rule Claude Code applied for it. And what
// is checked is Claude Code 2.1.32x's wording of those lines: a version that words them differently reads as "did not load as
// asked" and refuses (fail closed), and the live test is what notices.
//
// The mechanism is one function, `verifyLaunch`: poll the file until every expected server has connected (a surplus anywhere
// refuses at once), then judge. A file that never appears, or never completes, within the deadline refuses.

import { readFileSync } from 'fs'
import { BRIDGE_MCP_SERVER_KEY, BRIDGE_PLUGIN_ID, BRIDGE_TOOLS_PERMISSION, bridgePluginCache } from '../infra/plugin-manifest.js'
import { HYDRA_MOD, serverToolRule, type RestrictedPolicy } from '../daemon/restricted.js'
import { claudeConfigDir } from '../shared/constants.js'

/** What a launch's debug file says Claude Code loaded. Each field is read from the lines that say it, and nothing is inferred. */
export type Loaded = {
  /** MCP servers it started a connection to. */
  servers: string[]
  /** MCP servers that connected. */
  connected: string[]
  /** Plugins it loaded (a name per plugin, built-in ones included). */
  plugins: string[]
  /**
   * Each `Checking plugin <name>: skillsPath=<state>` line, one entry per line (a plugin checked twice is two entries), with the folder
   * its `Attempting to load skills from plugin <name> default skillsPath: <folder>` line names, when one follows it. A path line that no
   * check of its name is waiting for is an entry of its own, with no state.
   */
  pluginChecks: PluginCheck[]
  /** The permission rules it applied under `--settings`. Undefined when it applied none. */
  allow: string[] | undefined
  /** `[STARTUP] Loading MCP configs...` was logged, and `[STARTUP] MCP configs resolved in` after it: without the second, Claude Code is stuck before MCP init (typically a dialog on its screen). */
  mcpConfigsLoading: boolean
  mcpConfigsResolved: boolean
  /** The deny rules it applied under `--settings`. Undefined when it applied none. */
  deny: string[] | undefined
  /** Allow rules applied anywhere else (user, project, local or managed settings, the command line): destination to rules. */
  otherAllow: Record<string, string[]>
  /** The line that says claude.ai connectors were disabled by the environment was there. */
  connectorsOff: boolean
  /** Any other line about claude.ai connectors was logged. */
  connectorActivity: boolean
  /** Plugins Claude Code registered as its own (`name@builtin`). */
  builtinPlugins: string[]
  /** The names of plugins it has registered, of any source. A plugin is named on a `Checking plugin` line first and registered ~100 ms later: until then its source is unknown. */
  registeredPlugins: string[]
  /** Every `plugin.register` line, one entry each: the name, the kind Claude Code gave it and the id (`name@source`) it registered as. Not de-duplicated: a name that registers twice is two entries. */
  registrations: Registration[]
  /** Plugins it loaded from a folder named on its command line or in `CLAUDE_CODE_PLUGIN_DIRS` (`Loaded inline plugin from path: <name>`). */
  inlinePlugins: string[]
}

export type Registration = { name: string; kind: string; id: string }
/** A plugin's skills check: `skillsPath` is `exists` or `none` (`''` for a path line with no check), `skillsDir` the folder it loads skills from (`<plugin folder>/skills`). */
export type PluginCheck = { name: string; skillsPath: string; skillsDir?: string }

/** The only registrations a restricted specialist may have: Claude Code's own (`name@builtin`, of kind builtin or prepend), the hydra mod inline, and the bridge by its exact id. */
export const registrationAllowed = (r: Registration): boolean =>
  (r.id === `${r.name}@builtin` && (r.kind === 'builtin' || r.kind === 'prepend'))
  || (r.name === HYDRA_MOD && r.id === `${HYDRA_MOD}@inline`)
  || (r.name === BRIDGE_PLUGIN_NAME && r.id === BRIDGE_PLUGIN_ID)

const BRIDGE_PLUGIN_NAME = BRIDGE_PLUGIN_ID.split('@')[0]
const flatten = (rules: unknown): string[] => (Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string') : [])

/** Reads a debug file's text into what it says loaded. Lines it does not recognize are ignored: the judgement rests on what it does recognize. */
export function readLoaded(log: string): Loaded {
  const servers = new Set<string>(), connected = new Set<string>(), plugins = new Set<string>(), builtin = new Set<string>(), registered = new Set<string>()
  const pluginChecks: PluginCheck[] = []
  const registrations: Registration[] = []
  const inline = new Set<string>()
  let allow: Set<string> | undefined
  let deny: Set<string> | undefined
  const otherAllow: Record<string, Set<string>> = {}
  let connectorsOff = false
  let mcpConfigsLoading = false, mcpConfigsResolved = false
  let connectorActivity = false
  const rules = (dest: string, list: string[], replace: boolean) => {
    if (dest === 'flagSettings') { allow = replace ? new Set(list) : new Set([...(allow ?? []), ...list]); return }
    if (!list.length && replace) return   // "replacing every rule of this destination with none" is what a clean start says for each of them
    otherAllow[dest] = replace ? new Set(list) : new Set([...(otherAllow[dest] ?? []), ...list])
  }
  // Only whole lines: the file is still being written, and half of `[claudeai-mcp] Disabled via env var` must not read as another line.
  const lines = log.split('\n')
  if (!log.endsWith('\n')) lines.pop()
  for (const raw of lines) {
    // Claude Code's own debug lines only: `<timestamp> [DEBUG] <message>`. A line is only read when it begins that way. Text from a server
    // does reach the file: its stderr in one [ERROR] line, and a channel notification's text, cut short, in a [DEBUG] line. What keeps it
    // from starting a line of its own is Claude Code writing a newline in it as `\n`: for stderr in the test fixture, for notifications in
    // recorded launches (none in a fixture). A Claude Code that wrote one raw would let a message beginning with a timestamp and `[DEBUG]`
    // read here as Claude Code's.
    const prefix = raw.match(DEBUG_LINE)
    if (!prefix) continue
    const line = raw.slice(prefix[0].length)
    let m: RegExpMatchArray | null
    if ((m = line.match(/^MCP server "([^"]+)": Starting connection/))) servers.add(m[1])
    else if ((m = line.match(/^MCP server "([^"]+)": Successfully connected/))) { servers.add(m[1]); connected.add(m[1]) }
    else if ((m = line.match(/^Checking plugin (\S+?): skillsPath=(\w*)/))) { plugins.add(m[1]); pluginChecks.push({ name: m[1], skillsPath: m[2] }) }
    else if ((m = line.match(/^Loaded inline plugin from path: (\S+)/))) { plugins.add(m[1]); inline.add(m[1]) }
    else if ((m = line.match(/^Attempting to load skills from plugin (\S+) default skillsPath: (.+?)\s*$/))) {
      // Claude Code writes it right after its plugin's check: it belongs to the last check of that name, if that one has none yet.
      const last = pluginChecks.findLast(c => c.name === m![1])
      if (last && last.skillsDir === undefined) last.skillsDir = m[2]
      else pluginChecks.push({ name: m[1], skillsPath: '', skillsDir: m[2] })
    }
    else if ((m = line.match(/^plugin\.register: (\S+) \(([^,()]+), (\S+)\)/))) {
      const r = { name: m[1], kind: m[2], id: m[3] }
      registered.add(r.name)
      registrations.push(r)
      if (r.id === `${r.name}@builtin` && (r.kind === 'builtin' || r.kind === 'prepend')) builtin.add(r.name)
    }
    else if ((m = line.match(/^(?:Applying permission update: )?(Adding|Replacing all) (?:\d+ )?deny rule(?:\(s\)|s) (?:to|for) destination 'flagSettings'(?: with \d+ rule\(s\))?: (\[.*\])\s*$/))) {
      try { const list = flatten(JSON.parse(m[2])); deny = m[1] !== 'Adding' ? new Set(list) : new Set([...(deny ?? []), ...list]) } catch { /* an unreadable list is not a rule we can name */ }
    }
    else if ((m = line.match(/^(?:Applying permission update: )?(Adding|Replacing all) (?:\d+ )?allow rule(?:\(s\)|s) (?:to|for) destination '([^']+)'(?: with \d+ rule\(s\))?: (\[.*\])\s*$/))) {
      try { rules(m[2], flatten(JSON.parse(m[3])), m[1] !== 'Adding') } catch { /* an unreadable list is not a rule we can name */ }
    }
    else if (line.startsWith('[STARTUP] Loading MCP configs')) mcpConfigsLoading = true
    else if (line.startsWith('[STARTUP] MCP configs resolved')) mcpConfigsResolved = true
    else if (line.startsWith('[claudeai-mcp]')) {
      if (/^\[claudeai-mcp\] Disabled via env var\s*$/.test(line)) connectorsOff = true
      else connectorActivity = true
    }
  }
  return {
    servers: [...servers], connected: [...connected], plugins: [...plugins], pluginChecks, allow: allow ? [...allow] : undefined, deny: deny ? [...deny] : undefined,
    otherAllow: Object.fromEntries(Object.entries(otherAllow).filter(([, v]) => v.size).map(([k, v]) => [k, [...v]])),
    mcpConfigsLoading, mcpConfigsResolved, connectorsOff, connectorActivity, builtinPlugins: [...builtin], registeredPlugins: [...registered], registrations,
    inlinePlugins: [...inline],
  }
}

/** `2026-11-13T04:34:18.480Z [DEBUG] `: how every line Claude Code writes about itself begins. */
const DEBUG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \[DEBUG\] /

/** The MCP servers a launch started or connected that are not in `want`: one rule for a restricted launch and a write-confined one. */
const extraServerNames = (want: readonly string[], got: Loaded): string[] => [...new Set([...got.servers, ...got.connected])].filter(s => !want.includes(s))
/** The servers in `want` that have not connected. */
const unconnectedServers = (want: readonly string[], got: Loaded): string[] => want.filter(s => !got.connected.includes(s))
/** claude.ai connector activity (a surplus: judged as soon as it is read), and the missing "disabled" line (a shortfall: judged once the launch has loaded). */
const connectorActivity = (got: Loaded): string | undefined => got.connectorActivity ? 'claude.ai connectors were not off (the log shows connector activity)' : undefined
const connectorsNotOff = (got: Loaded): string | undefined => !got.connectorsOff && !got.connectorActivity ? 'nothing says claude.ai connectors were off (no `[claudeai-mcp] Disabled via env var` line)' : undefined

/** What a policy expects of a launch: the servers (the bridge and the listed ones), the permission rules and the plugins. */
/** The servers a launch may run: the bridge and the policy's listed ones (a restricted launch's and a write-confined one's alike). */
export const expectedServerNames = (listed: ReadonlyArray<{ name: string }>): string[] => [BRIDGE_MCP_SERVER_KEY, ...listed.map(s => s.name)]

export function expectedLoad(p: Pick<RestrictedPolicy, 'servers'>): { servers: string[]; allow: string[] } {
  return {
    servers: expectedServerNames(p.servers),
    allow: [BRIDGE_TOOLS_PERMISSION, ...p.servers.flatMap(s => s.tools.map(t => serverToolRule(s.name, t)))],
  }
}

/** What the debug file gave us, made safe to say in a thread: names and rules only, each bounded, at most five, nothing a file could phrase as an instruction. */
const safe = (x: string): string => x.replace(/[^\w.:@*()/ -]/g, '?').slice(0, 60)
const list = (xs: string[]): string => `${xs.slice(0, 5).map(x => `\`${safe(x)}\``).join(', ')}${xs.length > 5 ? ` and ${xs.length - 5} more` : ''}`

/**
 * The ways what loaded is more than the policy allows: each one is enough to refuse, even before the rest has loaded.
 * A plugin is judged by what Claude Code registered it as. While the file is still being written, a plugin that is named but not yet
 * registered is not yet a surplus (Claude Code's own built-ins are named ~100 ms before they register as built in). `final` is the
 * judgement that ends the wait: a plugin that never registered is refused then, because its source is unknown.
 */
export function surplus(p: Pick<RestrictedPolicy, 'servers'>, got: Loaded, final = false): string[] {
  const want = expectedLoad(p)
  const out: string[] = []
  const extraServers = extraServerNames(want.servers, got)
  if (extraServers.length) out.push(`it started MCP servers the policy does not list: ${list(extraServers)}`)
  // Two judgements. By registration: every `plugin.register` line is judged by its id, so a name that registers from another source
  // (as `discord` or `hydra` from a marketplace, or once as built in and once as a user's) is refused, and so is one never named on a
  // `Checking plugin` line. By name: a plugin named but not registered is judged only at `final`. The hydra mod and the bridge are
  // left to `shortfall`, which needs the hydra mod to have registered as its exact id and the bridge to be proven by `bridgeProven`.
  const badRegistrations = got.registrations.filter(r => !registrationAllowed(r))
  const badNames = new Set(badRegistrations.map(r => r.name))
  const extraPlugins = [...new Set([
    ...badRegistrations.map(r => r.id),
    ...got.plugins.filter(n => !badNames.has(n) && n !== HYDRA_MOD && n !== BRIDGE_PLUGIN_NAME && !got.builtinPlugins.includes(n) && (final || got.registeredPlugins.includes(n))),
  ])]
  if (extraPlugins.length) out.push(`it loaded plugins the policy does not allow: ${list(extraPlugins)} (a restricted specialist loads only the hydra mod, the bridge and Claude Code's built-in plugins; hydra's launch turns on only the bridge, so anything else is enabled in Claude Code's settings (user, project or local) or loaded with --plugin-dir: turn it off there)`)
  const extraRules = (got.allow ?? []).filter(r => !want.allow.includes(r))
  if (extraRules.length) out.push(`it applied permission rules the policy does not give: ${list(extraRules)}`)
  for (const [dest, rules] of Object.entries(got.otherAllow)) out.push(`it applied permission rules from ${safe(dest)}, which a restricted specialist reads none of: ${list(rules)}`)
  const activity = connectorActivity(got)
  if (activity) out.push(activity)
  return out
}

/** The ways what loaded falls short of the policy, judged once every expected server has connected (or the deadline passed). */
export function shortfall(p: Pick<RestrictedPolicy, 'servers'>, got: Loaded): string[] {
  const want = expectedLoad(p)
  const out: string[] = []
  const unconnected = unconnectedServers(want.servers, got)
  // A listed server runs under sandbox-exec (config/server-sandbox.ts), and a denied path or socket shows only as 'did not connect': say so.
  const sandboxed = unconnected.some(n => n !== BRIDGE_MCP_SERVER_KEY)
  if (unconnected.length) out.push(`these MCP servers did not connect: ${list(unconnected)}${sandboxed ? ' (a listed server runs under sandbox-exec, which denies unix sockets other than name lookup, writes outside its own temp folder, signals to other processes and the places hydra lists as off limits (credential folders and more): a server that needs one of those cannot start)' : ''}`)
  const missingRules = want.allow.filter(r => !(got.allow ?? []).includes(r))
  if (missingRules.length) out.push(`it did not apply these permission rules: ${list(missingRules)}`)
  const notOff = connectorsNotOff(got)
  if (notOff) out.push(notOff)
  // The hydra mod registers before the bridge's MCP server connects, and this runs after that, so a missing line is a refusal, not a wait.
  if (!got.registrations.some(r => r.name === HYDRA_MOD && r.id === `${HYDRA_MOD}@inline`)) out.push(`the plugin ${list([HYDRA_MOD])} did not register as ${list([`${HYDRA_MOD}@inline`])}, so it may not be the one hydra installed`)
  // The bridge's skills load, and its register line (when there is one) is written, before its server connects, and this runs after that.
  if (!bridgeProven(got)) out.push(`the plugin ${list([BRIDGE_PLUGIN_NAME])} neither registered as ${list([BRIDGE_PLUGIN_ID])} nor loaded only from its folder in the plugin cache (plugins/cache/claude-plugins-official/discord/<version>/skills), so it may not be the one hydra installed`)
  return out
}

/** `dir` is `<cache><version>/skills`: the skills folder of a version folder of the bridge's folder in the plugin cache, with no `.`, `..` or empty segment. Lexical: a path that names the cache another way (through a symlinked config dir, with `//`, in another case) is refused, never accepted. */
const versionSkillsDir = (dir: string, cache: string): boolean => {
  if (!dir.startsWith(cache)) return false
  const segs = dir.slice(cache.length).split('/')
  return segs.length === 2 && segs[1] === 'skills' && segs[0] !== '' && segs[0] !== '.' && segs[0] !== '..'
}

/**
 * The bridge's provenance, from what Claude Code says of it. Two cases:
 *
 * - **It logged a `plugin.register` line for `discord`**: that line must carry the bridge's exact id (any other id is also refused by `surplus`).
 * - **It logged none** (reported where Claude Code's `cc-plugin-sec-default` built-in, which judges and logs a plugin's registration, is
 *   not seated; no such launch is recorded here): the bridge is proven by where it loaded from. Every `Checking plugin discord` line says `skillsPath=exists` and is followed by its skills
 *   folder, every such folder is `<version>/skills` in the bridge's folder in the plugin cache (`bridgePluginCache`), and no `discord` was
 *   loaded inline. A second `discord` without a skills folder is a check with `skillsPath=none`, and a path line no check waits for counts too.
 *
 * What both cases rest on. The lines are Claude Code's own: `DEBUG_LINE`'s anchor, with Claude Code writing a newline in a server's text as
 * `\n` (see `readLoaded`). And neither tells hydra's bridge from upstream's: `discord@claude-plugins-official` is the upstream plugin's id
 * too, and the cache's version folders are installed by Claude Code from that marketplace (its updater writes there too); the daemon
 * links hydra's bridge server into each one it finds. The path check is as strong as the id check it stands in for, no stronger.
 */
const bridgeProven = (got: Loaded): boolean => {
  const regs = got.registrations.filter(r => r.name === BRIDGE_PLUGIN_NAME)
  if (regs.length) return regs.some(r => r.id === BRIDGE_PLUGIN_ID)
  const cache = `${bridgePluginCache(claudeConfigDir())}/`
  const checks = got.pluginChecks.filter(c => c.name === BRIDGE_PLUGIN_NAME)
  return checks.length > 0
    && checks.every(c => c.skillsPath === 'exists' && c.skillsDir !== undefined && versionSkillsDir(c.skillsDir, cache))
    && !got.inlinePlugins.includes(BRIDGE_PLUGIN_NAME)
}

/** All the ways a launch's loaded set differs from its policy; empty when it is exactly what the policy says. */
export const mismatches = (p: Pick<RestrictedPolicy, 'servers'>, got: Loaded): string[] => [...surplus(p, got, true), ...shortfall(p, got)]

/** Test seams: the file read, the clock and the deadline. */
export const verifyDeps = {
  read: (path: string): string => readFileSync(path, 'utf8'),
  sleep: (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)),
  now: (): number => Date.now(),
  /** The longest a launch may take to load: Claude Code's own limit for an MCP server to connect is 30 s. */
  deadlineMs: 45_000,
  pollMs: 250,
  /** After every expected server has connected, the file is read once more this much later, for a line that arrives after the last connection. */
  settleMs: 500,
}

export type Verdict = { ok: true } | { ok: false; why: string }

/**
 * Whether the launch whose debug file is `path` loaded what `policy` says. Polls the file: a surplus (a server, plugin or rule the
 * policy does not give) refuses as soon as it is read (a plugin only once it has registered: see `surplus`); otherwise it waits until every expected server has connected, then judges
 * the whole. A file that cannot be read, or a launch that has not finished loading by the deadline, refuses: never "no news, good news".
 */
export async function verifyLaunch(policy: Pick<RestrictedPolicy, 'servers'>, path: string | undefined, deps: typeof verifyDeps = verifyDeps): Promise<Verdict> {
  if (!path) return { ok: false, why: 'the launch wrote no debug file to check what it loaded' }
  const start = deps.now()
  const want = expectedLoad(policy)
  let readError: string | undefined
  let got: Loaded | undefined
  for (;;) {
    try {
      got = readLoaded(deps.read(path))
      readError = undefined
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err)
    }
    if (got) {
      const extra = surplus(policy, got)
      if (extra.length) return { ok: false, why: extra.join('; ') }
      if (want.servers.every(s => got!.connected.includes(s))) {
        const short = shortfall(policy, got)
        if (short.length) return { ok: false, why: short.join('; ') }
        // Judged once, then once more after a moment: a surplus line written after the last expected server connected is still caught.
        await deps.sleep(deps.settleMs)
        let again: Loaded
        try { again = readLoaded(deps.read(path)) } catch (err) { return { ok: false, why: `its debug file ${path} could not be read to confirm it (${err instanceof Error ? err.message : String(err)}), so what it loaded is unknown` } }
        const late = mismatches(policy, again)
        return late.length ? { ok: false, why: late.join('; ') } : { ok: true }
      }
    }
    if (deps.now() - start >= deps.deadlineMs) break
    await deps.sleep(deps.pollMs)
  }
  if (!got) return { ok: false, why: `its debug file ${path} could not be read within ${Math.round(deps.deadlineMs / 1000)}s (${readError ?? 'no such file'}), so what it loaded is unknown` }
  const short = shortfall(policy, got)
  return { ok: false, why: `it had not finished loading after ${Math.round(deps.deadlineMs / 1000)}s: ${short.join('; ')}` }
}

/**
 * What a write-confined launch's debug file can show: that Claude Code read the launch's `--settings` and applied the rules in it (the deny rules that
 * keep reads out of the credential places, the allow rule that opens the network), that the bridge and the listed servers connected and no other MCP server
 * started, and that claude.ai connectors were off. A restricted launch is judged by everything it loaded
 * (`verifyLaunch`); this layer runs the operator's own account, so only its own rules are judged, and nothing else the session loads is.
 *
 * What it cannot show: the `sandbox.*` keys and `permissions.blockWritesOutsideWorkingDirectories`. Claude Code 2.1.326 logs no line for them that
 * hydra has seen, so a version that ignored or renamed one would pass here. The rules passing proves the settings file was read and applied
 * (a renamed *rule* key fails here), not that every other key in it was understood; the launch's version gate and the live smoke test cover the rest.
 */
/** Test seam: a write-confined launch whose bridge has not connected this long after its settings loaded (the rules and the connectors line are in the file) is refused; Claude Code's own limit for a server to connect is 30 s, and the deadline from the start is 45 s. */
export const confinementDeps = { bridgeWaitMs: 20_000 }

export type ConfinementWant = { allow: readonly string[]; deny: readonly string[]; servers: readonly string[] }

/**
 * What a write-confined start loaded that it should not have, judged as soon as it is read: an MCP server beyond the bridge and the listed ones (the operator's own, a
 * plugin's, a project's or a claude.ai connector), or any claude.ai connector activity. Plugins other than MCP servers are not judged: the operator's own account loads its own.
 * Servers are matched by name, as for a restricted launch (see the top of this file); hydra refuses a listed name an operator's own config also declares, so a name is one server.
 */
export function confinementSurplus(want: ConfinementWant, got: Loaded): string[] {
  const out: string[] = []
  const extra = extraServerNames(want.servers, got)
  if (extra.length) out.push(`it started MCP servers the policy does not give it: ${list(extra)}`)
  const activity = connectorActivity(got)
  if (activity) out.push(activity)
  return out
}

export function confinementShortfall(want: ConfinementWant, got: Loaded): string[] {
  const out: string[] = []
  const missingDeny = want.deny.filter(r => !(got.deny ?? []).includes(r))
  const missingAllow = want.allow.filter(r => !(got.allow ?? []).includes(r))
  if (missingDeny.length) out.push(`it did not apply these deny rules: ${list(missingDeny)}`)
  if (missingAllow.length) out.push(`it did not apply these allow rules: ${list(missingAllow)}`)
  if (got.mcpConfigsLoading && !got.mcpConfigsResolved) out.push('Claude Code never finished loading its MCP configs (no `[STARTUP] MCP configs resolved` line): it is stuck before MCP starts, typically at a dialog on its screen (a Settings Warning about the launch settings): attach to the session and read it')
  const unconnected = unconnectedServers(want.servers, got)
  if (unconnected.length) out.push(`these MCP servers did not connect: ${list(unconnected)}${unconnected.includes(BRIDGE_MCP_SERVER_KEY) ? ' (the bridge is one: Claude Code\'s server allowlist may have refused it by name)' : ''}`)
  const notOff = connectorsNotOff(got)
  if (notOff) out.push(notOff)
  return out
}

/** Whether the launch whose debug file is `path` applied the write-confined layer's rules; polls the file until it has, or the deadline: never "no news, good news". */
export async function verifyConfinement(want: ConfinementWant, path: string | undefined, deps: typeof verifyDeps = verifyDeps): Promise<Verdict> {
  if (!path) return { ok: false, why: 'the launch wrote no debug file to check what it applied' }
  const start = deps.now()
  let readError: string | undefined
  let short: string[] = ['nothing yet']
  let loadedAt: number | undefined
  for (;;) {
    try {
      const got = readLoaded(deps.read(path))
      readError = undefined
      const extra = confinementSurplus(want, got)
      if (extra.length) return { ok: false, why: extra.join('; ') }
      short = confinementShortfall(want, got)
      if (!short.length) {
        // Judged once, then once more after a moment: a server or a connector line that arrives after the last expected server connected is still caught.
        await deps.sleep(deps.settleMs)
        const again = readLoaded(deps.read(path))
        const late = [...confinementSurplus(want, again), ...confinementShortfall(want, again)]
        return late.length ? { ok: false, why: late.join('; ') } : { ok: true }
      }
      // The settings have loaded (the rules and the connectors line are there) and the bridge still has not connected after the time it needs: refuse now, not at the deadline.
      if (!short.some(x => /^it did not apply|^nothing says/.test(x))) loadedAt ??= deps.now()
      if (loadedAt !== undefined && !got.connected.includes(BRIDGE_MCP_SERVER_KEY) && deps.now() - loadedAt >= confinementDeps.bridgeWaitMs) return { ok: false, why: `${short.join('; ')} (its settings were loaded ${Math.round((deps.now() - loadedAt) / 1000)}s ago and the bridge still has not connected)` }
    } catch (err) { readError = err instanceof Error ? err.message : String(err) }
    if (deps.now() - start >= deps.deadlineMs) break
    await deps.sleep(deps.pollMs)
  }
  if (readError) return { ok: false, why: `its debug file ${path} could not be read within ${Math.round(deps.deadlineMs / 1000)}s (${readError}), so what it applied is unknown` }
  return { ok: false, why: `after ${Math.round(deps.deadlineMs / 1000)}s: ${short.join('; ')} (Claude Code may have ignored or renamed a key in the launch's settings)` }
}
