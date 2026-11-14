// Claude's way of checking a confined session against its policy (the adapter's `verifyLaunch`): Claude Code's own record of what it loaded: the `--debug-file` of the
// launch itself (tmux sessions emit no init event).
//
// The policy decides what a confined session may reach (scope.ts); the argv, settings and MCP config are built from it
// (claude-engine.ts). That is what hydra asked for. This reads what Claude Code did: the launch's debug file says which MCP servers it
// started and connected, which plugins it loaded, which permission rules it applied, and whether claude.ai's connectors were off.
// Any difference from the policy refuses the start. Claude Code loaded a different set from the same argv before (hydra#600: claude.ai
// connectors appeared on one run and not the next), so an argv that is right does not prove a session that is.
//
// Servers are matched by name only: the debug file does not show an MCP server's command or arguments (claude 2.1.323), so a server
// of the right name running another command passes here. The launch's own MCP config is what names the command, and it is written by hydra.
//
// What the debug file does not carry is the built-in tool list: `--tools` is verified by the init event in the live test
// (scoped-claude.live.test.ts); here, a tool beyond the policy shows as a permission rule Claude Code applied for it. And what
// is checked is Claude Code 2.1.32x's wording of those lines: a version that words them differently reads as "did not load as
// asked" and refuses (fail closed), and the live test is what notices.
//
// The mechanism is one function, `verifyLaunch`: poll the file until every expected server has connected (a surplus anywhere
// refuses at once), then judge. A file that never appears, or never completes, within the deadline refuses.

import { readFileSync } from 'fs'
import { BRIDGE_MCP_SERVER_KEY, BRIDGE_PLUGIN_ID, BRIDGE_TOOLS_PERMISSION } from '../plugin-manifest.js'
import { HYDRA_MOD, serverToolRule, type ConfinedPolicy } from '../scope.js'

/** What a launch's debug file says Claude Code loaded. Each field is read from the lines that say it, and nothing is inferred. */
export type Loaded = {
  /** MCP servers it started a connection to. */
  servers: string[]
  /** MCP servers that connected. */
  connected: string[]
  /** Plugins it loaded (a name per plugin, built-in ones included). */
  plugins: string[]
  /** The permission rules it applied under `--settings`. Undefined when it applied none. */
  allow: string[] | undefined
  /** Allow rules applied anywhere else (user, project, local or managed settings, the command line): destination to rules. */
  otherAllow: Record<string, string[]>
  /** The line that says claude.ai connectors were disabled by the environment was there. */
  connectorsOff: boolean
  /** Any other line about claude.ai connectors was logged. */
  connectorActivity: boolean
  /** Plugins Claude Code registered as its own (`name@builtin`): the only ones allowed besides the hydra mod and the bridge. */
  builtinPlugins: string[]
}

const BRIDGE_PLUGIN_NAME = BRIDGE_PLUGIN_ID.split('@')[0]
const flatten = (rules: unknown): string[] => (Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string') : [])

/** Reads a debug file's text into what it says loaded. Lines it does not recognize are ignored: the judgement rests on what it does recognize. */
export function readLoaded(log: string): Loaded {
  const servers = new Set<string>(), connected = new Set<string>(), plugins = new Set<string>(), builtin = new Set<string>()
  let allow: Set<string> | undefined
  const otherAllow: Record<string, Set<string>> = {}
  let connectorsOff = false
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
    // Claude Code's own debug lines only: `<timestamp> [DEBUG] <message>`. Text a server prints reaches the file as an [ERROR] line with its
    // newlines escaped, so it cannot begin a line of its own that reads as one of these.
    const prefix = raw.match(DEBUG_LINE)
    if (!prefix) continue
    const line = raw.slice(prefix[0].length)
    let m: RegExpMatchArray | null
    if ((m = line.match(/^MCP server "([^"]+)": Starting connection/))) servers.add(m[1])
    else if ((m = line.match(/^MCP server "([^"]+)": Successfully connected/))) { servers.add(m[1]); connected.add(m[1]) }
    else if ((m = line.match(/^Checking plugin (\S+?): skillsPath=/))) plugins.add(m[1])
    else if ((m = line.match(/^Loaded inline plugin from path: (\S+)/))) plugins.add(m[1])
    else if ((m = line.match(/^plugin\.register: (\S+) \((?:builtin|prepend), (\S+)@builtin\)/)) && m[1] === m[2]) builtin.add(m[1])
    else if ((m = line.match(/^(?:Applying permission update: )?(Adding|Replacing all) (?:\d+ )?allow rule(?:\(s\)|s) (?:to|for) destination '([^']+)'(?: with \d+ rule\(s\))?: (\[.*\])\s*$/))) {
      try { rules(m[2], flatten(JSON.parse(m[3])), m[1] !== 'Adding') } catch { /* an unreadable list is not a rule we can name */ }
    }
    else if (line.startsWith('[claudeai-mcp]')) {
      if (/^\[claudeai-mcp\] Disabled via env var\s*$/.test(line)) connectorsOff = true
      else connectorActivity = true
    }
  }
  return {
    servers: [...servers], connected: [...connected], plugins: [...plugins], allow: allow ? [...allow] : undefined,
    otherAllow: Object.fromEntries(Object.entries(otherAllow).filter(([, v]) => v.size).map(([k, v]) => [k, [...v]])),
    connectorsOff, connectorActivity, builtinPlugins: [...builtin],
  }
}

/** `2026-11-13T04:34:18.480Z [DEBUG] `: how every line Claude Code writes about itself begins. */
const DEBUG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \[DEBUG\] /

/** What a policy expects of a launch: the servers (the bridge and the listed ones), the permission rules and the plugins. */
export function expectedLoad(p: Pick<ConfinedPolicy, 'servers'>): { servers: string[]; allow: string[] } {
  return {
    servers: [BRIDGE_MCP_SERVER_KEY, ...p.servers.map(s => s.name)],
    allow: [BRIDGE_TOOLS_PERMISSION, ...p.servers.flatMap(s => s.tools.map(t => serverToolRule(s.name, t)))],
  }
}

/** What the debug file gave us, made safe to say in a thread: names and rules only, each bounded, at most five, nothing a file could phrase as an instruction. */
const safe = (x: string): string => x.replace(/[^\w.:@*()/ -]/g, '?').slice(0, 60)
const list = (xs: string[]): string => `${xs.slice(0, 5).map(x => `\`${safe(x)}\``).join(', ')}${xs.length > 5 ? ` and ${xs.length - 5} more` : ''}`

/** The ways what loaded is more than the policy allows: each one is enough to refuse, even before the rest has loaded. */
export function surplus(p: Pick<ConfinedPolicy, 'servers'>, got: Loaded): string[] {
  const want = expectedLoad(p)
  const out: string[] = []
  const extraServers = [...new Set([...got.servers, ...got.connected])].filter(s => !want.servers.includes(s))
  if (extraServers.length) out.push(`it started MCP servers the policy does not list: ${list(extraServers)}`)
  // The hydra mod and the bridge, and what Claude Code registers as its own (`name@builtin`): a plugin merely named like one is not.
  const extraPlugins = got.plugins.filter(n => n !== HYDRA_MOD && n !== BRIDGE_PLUGIN_NAME && !got.builtinPlugins.includes(n))
  if (extraPlugins.length) out.push(`it loaded plugins the policy does not allow: ${list(extraPlugins)}`)
  const extraRules = (got.allow ?? []).filter(r => !want.allow.includes(r))
  if (extraRules.length) out.push(`it applied permission rules the policy does not give: ${list(extraRules)}`)
  for (const [dest, rules] of Object.entries(got.otherAllow)) out.push(`it applied permission rules from ${safe(dest)}, which a confined session reads none of: ${list(rules)}`)
  if (got.connectorActivity) out.push('claude.ai connectors were not off (the log shows connector activity)')
  return out
}

/** The ways what loaded falls short of the policy, judged once every expected server has connected (or the deadline passed). */
export function shortfall(p: Pick<ConfinedPolicy, 'servers'>, got: Loaded): string[] {
  const want = expectedLoad(p)
  const out: string[] = []
  const unconnected = want.servers.filter(s => !got.connected.includes(s))
  // A listed server runs under sandbox-exec (config/server-sandbox.ts), and a denied path or socket shows only as 'did not connect': say so.
  const sandboxed = unconnected.some(n => n !== BRIDGE_MCP_SERVER_KEY)
  if (unconnected.length) out.push(`these MCP servers did not connect: ${list(unconnected)}${sandboxed ? ' (a listed server runs under sandbox-exec, which denies unix sockets other than name lookup, writes outside its own temp folder, signals to other processes and the places hydra lists as off limits (credential folders and more): a server that needs one of those cannot start)' : ''}`)
  const missingRules = want.allow.filter(r => !(got.allow ?? []).includes(r))
  if (missingRules.length) out.push(`it did not apply these permission rules: ${list(missingRules)}`)
  if (!got.connectorsOff && !got.connectorActivity) out.push('nothing says claude.ai connectors were off (no `[claudeai-mcp] Disabled via env var` line)')
  for (const need of [HYDRA_MOD, BRIDGE_PLUGIN_NAME]) if (!got.plugins.includes(need)) out.push(`the plugin ${list([need])} did not load`)
  return out
}

/** All the ways a launch's loaded set differs from its policy; empty when it is exactly what the policy says. */
export const mismatches = (p: Pick<ConfinedPolicy, 'servers'>, got: Loaded): string[] => [...surplus(p, got), ...shortfall(p, got)]

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
 * policy does not give) refuses as soon as it is read; otherwise it waits until every expected server has connected, then judges
 * the whole. A file that cannot be read, or a launch that has not finished loading by the deadline, refuses: never "no news, good news".
 */
export async function verifyLaunch(policy: Pick<ConfinedPolicy, 'servers'>, path: string | undefined, deps: typeof verifyDeps = verifyDeps): Promise<Verdict> {
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
