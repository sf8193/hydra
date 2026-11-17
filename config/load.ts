// Loads `<state>/hydra.toml`: parse, fill defaults, check. Pure but for `env`, so the same text and machine give the same answer.
// Strict: an unknown key, a malformed address or place, or a reference to nothing is an error, and any error rejects the whole file.

import { statSync, accessSync, lstatSync, readdirSync, readFileSync, realpathSync, constants as fsConstants } from 'fs'
import { parseEnvLine } from '../shared/env-parse.js'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { parseCron } from '../shared/cron-local.js'
import { engineOfModel, parseIdleTtl, SLACK_GATEWAY_TOKEN_ENVS } from '../shared/constants.js'
import { ENV_NAME_RE, tokenVarRefusal } from '../shared/spawn-env.js'
import { offLimitRoots, workdirRestrictionIssues } from './restricted-workdir.js'
import { ALLOW_UNPROVEN_MACOS, macosGateIssue, sandboxIssues, unquotablePath } from './server-sandbox.js'
import { engineConfinesAccess } from '../shared/engine-capabilities.js'
import { noSuchApp, pinnersOf, speaksAsOf, whyNotServed } from './pins.js'
import { SLACK_APP_DEFAULTS } from '../connectors/slack/app.js'
import { emojiProblem, reactionNameProblem } from '../shared/emoji.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import { bareOf, readTarget, spelled } from '../shared/target-kind.js'
import { readValue, spelledApp, spelledPerson, spelledRole, whoSpelled } from '../shared/value-kind.js'
import {
  BUILTIN_ROLES, DEFAULT_SLACK_APP, SLACK_DM, SLACK_GROUP_DM, dmPerson, isDmPlace, namesAChannel, namesDmWithOthers, placesAnsweredBy, type Address, type ConfigIssue, type Connectors, type Gateways, type Guard, type HydraConfig, type LoadEnv, type LoadResult, type MainOptions,
  type McpServer, type WorkdirScan, type Person, type Place, type PlaceOptions, type Platform, type Rule, type Schedule, type SlackApp, type Specialist, type Vitals,
  NEEDS, RUNNERS, SESSIONS_MODES, WORKDIR_TOOLS, type Need,
} from './types.js'

export const VITALS_DEFAULTS: Vitals = Object.freeze({
  overloadLoadPerCore: 1.5, overloadIdlePct: 15, swapUsedPct: 85, ticks: 3, resumeSettleMs: 20 * 60_000, memoryCooldownMs: 24 * 3_600_000,
})

export const EMPTY_CONFIG: HydraConfig = Object.freeze({ connectors: {}, gateways: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] }) as HydraConfig

/** People, roles and schedules: lowercase letters, digits and dashes. Specialists add their own rule (shared/specialist-name.ts). */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
/** A Slack app's id: lowercase, so it can never be taken for a channel id (`C0TEST`); at most 35, since it can become the app's display name. */
const SLACK_APP_ID_RE = /^[a-z][a-z0-9_-]{0,34}$/
const ADDRESS_RE: Record<Platform, RegExp> = {
  discord: /^discord:\d+$/,
  slack: /^slack:[UW][A-Z0-9]+$/,
  github: /^github:[a-z0-9](?:[a-z0-9-]{0,38})$/,
}
const REPO_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/
// A channel by name or by the platform's own id (an app without the scopes to list channels only knows ids).
const CHANNEL_PLACE_RE = /^(slack|discord):(dm|#[a-z0-9][a-z0-9_-]*)$|^slack:group-dm$|^slack:dm:[a-z0-9][a-z0-9-]*$|^slack:[CG][A-Z0-9]+$|^discord:\d+$/
const ENGINES = ['claude', 'codex', 'omp'] as const
/** Why a built-in tool is not on a restricted specialist's list. Any other name gets the generic refusal. */
const TOOL_REFUSALS: Readonly<Record<string, string>> = {
  Bash: 'runs code outside the workdir', PowerShell: 'runs code outside the workdir', Monitor: 'runs code outside the workdir',
  Edit: 'writes files', Write: 'writes files', NotebookEdit: 'writes files',
  Task: 'starts agents that carry other tools', Agent: 'starts agents that carry other tools',
  WebSearch: 'reaches the open web with whatever it was asked',
}
/** Warned, not refused: a fetch can carry data to a URL the readers chose. */
const TOOL_WARNINGS: Readonly<Record<string, string>> = {
  WebFetch: 'can fetch an outside URL with data in it; anyone who can reach this specialist can choose that URL',
}
const MCP_TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MAX_DAY_MS = 86_400_000
const GUARD_TIMEOUT_MAX_MS = 30_000 // deliveries for a conversation wait on the guard
const MAX_ALERT_AFTER_MS = 30 * MAX_DAY_MS
const BUILTIN: readonly string[] = BUILTIN_ROLES
const MAIN_TARGET = 'main'

const TOP_KEYS = ['operator', 'main', 'gateways', 'connectors', 'slack', 'people', 'specialists', 'defaults', 'places', 'schedules', 'rules', 'guard', 'vitals', 'mcp_servers', 'restricted']
/** Keys a file may set without an operator: the operator itself, and `[main]`, which says how main runs, not who reaches it. */
const OPERATOR_FREE_KEYS = ['operator', 'main']
/** `[main]`: the operator's harness, as `[specialists.<id>]` is a specialist. */
const MAIN_KEYS = ['model']
const SPECIALIST_KEYS = ['workdir', 'kickoff', 'kickoff_file', 'pinned_to', 'speaks_as', 'reachable_by', 'sessions', 'max_sessions', 'idle', 'home_place', 'model', 'emoji', 'engine', 'env_file', 'renamed_from', 'restricted', 'tools', 'mcp_servers', 'sends_to']
/** A Slack app's keys, as `[slack.apps.<id>]` spells them. */
const SLACK_APP_KEYS = ['bot_token_env', 'socket_token_env', 'operator_token_env', 'display_name', 'description']
/** Keys only a hand edit of one specialist's own table sets: a default would reach every specialist, a fragment's table is someone else's. */
export const RESTRICTION_KEYS = ['restricted', 'tools', 'mcp_servers', 'sends_to'] as const

type Table = Record<string, unknown>
/** Own keys only: a name like `constructor` must not resolve through the prototype. */
const has = (t: object, k: string) => Object.hasOwn(t, k)
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/** Claude's config folder as sessions get it: CLAUDE_CONFIG_DIR, else `~/.claude`. */
export const defaultClaudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

let macosVersionOnce: { value: string | undefined } | undefined
/** `sw_vers -productVersion` on macOS, read once (the OS does not change under a running daemon); undefined when this is not macOS; the empty string when `sw_vers` cannot be read (which unprovenMacos counts as unproven). */
function macosVersion(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  if (!macosVersionOnce) {
    let v = ''
    try { v = new TextDecoder().decode(Bun.spawnSync(['/usr/bin/sw_vers', '-productVersion']).stdout).trim() } catch { /* unreadable: the empty string */ }
    macosVersionOnce = { value: v }
  }
  return macosVersionOnce.value
}

/** The machine as it is: `~` is this user's home, folders and commands are looked up for real. */
export function systemEnv(sessionNames: readonly string[], stateDir: string, platform: LoadEnv['platform'], claudeConfigDir: string = defaultClaudeConfigDir()): LoadEnv {
  return {
    home: homedir(),
    platform,
    macosVersion: macosVersion(),
    sessionNames,
    stateDir,
    claudeConfigDir,
    exists: path => { try { statSync(path); return true } catch { return false } },
    envFileHas: name => {
      try {
        for (const line of readFileSync(join(stateDir, '.env'), 'utf8').split('\n')) { const kv = parseEnvLine(line); if (kv && kv[0] === name && kv[1].trim() !== '') return true }
      } catch { /* no .env */ }
      return false
    },
    realpath: nearestRealpath,
    isGitWorkTree: path => {
      for (let p = resolve(path); ; p = dirname(p)) {
        try { lstatSync(join(p, '.git')); return true } catch { /* not here */ }
        if (dirname(p) === p) return false
      }
    },
    scanWorkdir: dir => scanWorkdirOnDisk(dir),
    isDir: path => { try { return statSync(path).isDirectory() } catch { return false } },
    isCommand: command => {
      if (!command.includes('/')) return Bun.which(command) !== null
      try { accessSync(command, fsConstants.X_OK); return statSync(command).isFile() } catch { return false }
    },
  }
}

/**
 * The path with symlinks resolved. A path that does not exist yet is resolved through its nearest existing ancestor, with the rest
 * put back: `/tmp/x/y` is `/private/tmp/x/y` whether or not `x` exists, as Seatbelt (which matches resolved paths) sees it.
 */
export function nearestRealpath(path: string): string {
  const rest: string[] = []
  for (let p = path; ; p = dirname(p)) {
    try { return join(realpathSync(p), ...rest.reverse()) } catch { /* not here: try the parent */ }
    if (dirname(p) === p) return path
    rest.push(basename(p))
  }
}

const SCAN_MAX_ENTRIES = 50_000

/**
 * Looks through `dir` for symlinks that resolve outside it (a dangling one counts: where it points cannot be checked) and for
 * git repositories below it. Stops after `maxEntries` entries and says so (`truncated`): a folder too big to look through is not
 * thereby clean.
 */
export function scanWorkdirOnDisk(dir: string, maxEntries = SCAN_MAX_ENTRIES): WorkdirScan {
  const out: WorkdirScan = { escapingSymlinks: [], nestedGit: [], truncated: false }
  let root: string
  try { root = realpathSync(dir) } catch { return out }
  let seen = 0
  const walk = (d: string, top: boolean) => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (out.truncated) return
      if (++seen > maxEntries) { out.truncated = true; return }
      const full = join(d, name)
      let st
      try { st = lstatSync(full) } catch { continue }
      if (name === '.git' && !top) { if (out.nestedGit.length < 5) out.nestedGit.push(full); continue }
      if (st.isSymbolicLink()) {
        let target: string
        try { target = realpathSync(full) } catch { if (out.escapingSymlinks.length < 5) out.escapingSymlinks.push(full); continue }
        if (target !== root && !target.startsWith(root + sep) && out.escapingSymlinks.length < 5) out.escapingSymlinks.push(full)
      } else if (st.isDirectory() && name !== '.git') walk(full, false)
    }
  }
  walk(root, true)
  return out
}

/** One line per issue, for an alert or a CLI. */
export function formatIssues(issues: ConfigIssue[]): string {
  return issues.map(i => `hydra.toml${i.path ? ` ${i.path}` : ''}: ${i.message}`).join('\n')
}

export function loadHydraConfig(text: string, env: LoadEnv): LoadResult {
  const errors: ConfigIssue[] = []
  const warnings: ConfigIssue[] = []
  const error = (path: string, message: string) => { errors.push({ path, message }) }
  const warn = (path: string, message: string) => { warnings.push({ path, message }) }

  let doc: Table
  try {
    doc = Bun.TOML.parse(text) as Table
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `not valid TOML: ${(e as Error).message}` }], warnings }
  }

  // --- small readers: each reports a wrong type at its path and returns undefined ----------------------------------

  const unknownKeys = (t: Table, known: readonly string[], path: string) => {
    for (const k of Object.keys(t)) if (!known.includes(k)) error(join2(path, k), `unknown key "${k}"`)
  }
  const table = (v: unknown, path: string): Table | undefined => {
    if (v === undefined) return undefined
    if (isTable(v)) return v
    error(path, 'must be a table')
    return undefined
  }
  const str = (t: Table, k: string, path: string): string | undefined => {
    const v = t[k]
    if (v === undefined) return undefined
    if (typeof v === 'string' && v.trim() !== '') return v
    error(join2(path, k), 'must be a non-empty string')
    return undefined
  }
  const strList = (t: Table, k: string, path: string): string[] | undefined => {
    const v = t[k]
    if (v === undefined) return undefined
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[]
    error(join2(path, k), 'must be a list of strings')
    return undefined
  }
  const bool = (t: Table, k: string, path: string): boolean | undefined => {
    const v = t[k]
    if (v === undefined || typeof v === 'boolean') return v
    error(join2(path, k), 'must be true or false')
    return undefined
  }
  const oneOf = <T extends string>(t: Table, k: string, path: string, options: readonly T[]): T | undefined => {
    const v = t[k]
    if (v === undefined) return undefined
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T
    error(join2(path, k), `must be one of ${options.map(o => `"${o}"`).join(', ')}`)
    return undefined
  }
  const duration = (t: Table, k: string, path: string, maxMs: number): number | undefined => {
    const v = str(t, k, path)
    if (v === undefined) return undefined
    const ms = parseDurationMs(v)
    if (ms !== null && ms <= maxMs) return ms
    error(join2(path, k), `"${v}" must be a duration like 90s, 5m or 2h, at most ${formatMs(maxMs)}`)
    return undefined
  }
  const expand = (p: string) => p === '~' ? env.home : p.startsWith('~/') ? join(env.home, p.slice(2)) : p
  const place = (raw: string, path: string): Place | undefined => {
    const p = normalizePlace(raw)
    const who = p === undefined ? undefined : dmPerson(p)
    if (p && who !== undefined) {
      // A DM with a person is found by their Slack address, so the person must be declared and have one.
      if (!has(people, who)) error(path, `"${raw}": ${who} is not a person: declare [people.${who}]`)
      else if (!people[who].addresses.some(a => a.startsWith('slack:'))) error(path, `"${raw}": ${who} has no slack: address; add one to people.${who}.addresses`)
      return p
    }
    if (p) return p
    error(path, `"${raw}" is not a place: use slack:#channel, slack:<channel id>, slack:dm, slack:dm:<person>, slack:group-dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli`)
    return undefined
  }

  unknownKeys(doc, TOP_KEYS, '')

  // --- gateways, connectors and Slack apps -------------------------------------------------------------------------------------

  const connectors: Connectors = {}
  // Which key holds each token variable: a variable on two keys (two apps, or a Slack app and Discord) is a bug.
  // The Slack gateway holds its own app's two tokens, so on its daemon it owns them: one Slack app belongs to one system.
  const GATEWAY = 'the Slack gateway (CHAT_PLATFORM=slack)'
  const GATEWAY_HINT = '; give the connector its own Slack app, with its own variables like CONNECTOR_SLACK_BOT_TOKEN'
  const envOwner = new Map<string, string>(env.platform === 'slack' ? Object.values(SLACK_GATEWAY_TOKEN_ENVS).map(v => [v, GATEWAY] as const) : [])
  const claimEnv = (v: string, path: string): boolean => {
    const other = envOwner.get(v)
    if (other) { error(path, `"${v}" is already the token variable of ${other}: each token needs its own variable${other === GATEWAY ? GATEWAY_HINT : ''}`); return false }
    envOwner.set(v, path)
    return true
  }
  const gateways: Gateways = {}
  const discordGateway = (t: Table, path: string) => {
    unknownKeys(t, ['bot_token_env'], path)
    const v = str(t, 'bot_token_env', path)
    if (v === undefined) { if (t.bot_token_env === undefined) error(join2(path, 'bot_token_env'), 'is required'); return }
    if (!ENV_NAME_RE.test(v)) { error(join2(path, 'bot_token_env'), `"${v}" must name an environment variable, like DISCORD_BOT_TOKEN`); return }
    if (claimEnv(v, join2(path, 'bot_token_env'))) gateways.discord = { botTokenEnv: v }
  }
  const gw = table(doc.gateways, 'gateways') ?? {}
  unknownKeys(gw, ['discord'], 'gateways')
  const gwDiscord = table(gw.discord, 'gateways.discord')
  if (gwDiscord) discordGateway(gwDiscord, 'gateways.discord')

  const conns = table(doc.connectors, 'connectors') ?? {}
  unknownKeys(conns, ['github'], 'connectors')
  const githubTable = table(conns.github, 'connectors.github')
  if (githubTable) {
    const path = 'connectors.github'
    const t = githubTable
    unknownKeys(t, ['repos', 'poll'], path)
    const repos = strList(t, 'repos', path)
    if (repos === undefined && t.repos === undefined) error(`${path}.repos`, 'is required: the repos to watch, as "owner/repo"')
    const good = (repos ?? []).flatMap((r, i) => {
      if (REPO_RE.test(r.toLowerCase())) return [r.toLowerCase()]
      error(`${path}.repos[${i}]`, `"${r}" must be owner/repo`)
      return []
    })
    const pollMs = duration(t, 'poll', path, MAX_DAY_MS) ?? 3 * 60_000
    if (repos) connectors.github = { repos: good, pollMs }
  }

  // Slack: any number of apps, `[slack.apps.<id>]`.
  // No prototype: an id like `constructor` is a valid name.
  const slackApps: Record<string, SlackApp> = Object.create(null)
  /** One Slack app from its table. */
  const slackApp = (id: string, t: Table, path: string): SlackApp | undefined => {
    unknownKeys(t, SLACK_APP_KEYS, path)
    const envName = (k: string, required: boolean): string | undefined => {
      const v = str(t, k, path)
      if (v === undefined) { if (required) error(join2(path, k), 'is required'); return undefined }
      if (!ENV_NAME_RE.test(v)) { error(join2(path, k), `"${v}" must name an environment variable, like CONNECTOR_SLACK_BOT_TOKEN`); return undefined }
      const why = tokenVarRefusal(v)
      if (why) { error(join2(path, k), `"${v}" ${why}, so it cannot hold a token; name one only the daemon needs, like CONNECTOR_SLACK_BOT_TOKEN`); return undefined }
      return claimEnv(v, join2(path, k)) ? v : undefined
    }
    const botTokenEnv = envName('bot_token_env', true)
    const socketTokenEnv = envName('socket_token_env', false)
    const operatorTokenEnv = envName('operator_token_env', false)
    // Slack's own limits for an app's name and description: past them, creating the app from the manifest fails.
    const capped = (k: string, max: number): string | undefined => {
      const v = str(t, k, path)
      const n = v === undefined ? 0 : [...v].length   // characters, not UTF-16 units: an emoji is one
      if (v === undefined || n <= max) return v
      error(join2(path, k), `is ${n} characters; Slack allows at most ${max}`)
      return undefined
    }
    const displayName = capped('display_name', 35) ?? (id === DEFAULT_SLACK_APP ? SLACK_APP_DEFAULTS.name : id)
    const description = capped('description', 140) ?? SLACK_APP_DEFAULTS.description + (operatorTokenEnv ? SLACK_APP_DEFAULTS.operatorTokenNote : '')
    if (!botTokenEnv) return undefined
    return { id, botTokenEnv, ...(socketTokenEnv && { socketTokenEnv }), ...(operatorTokenEnv && { operatorTokenEnv }), displayName, description }
  }
  const slackTable = table(doc.slack, 'slack') ?? {}
  unknownKeys(slackTable, ['apps'], 'slack')
  for (const [id, raw] of Object.entries(table(slackTable.apps, 'slack.apps') ?? {})) {
    const path = `slack.apps.${id}`
    if (!SLACK_APP_ID_RE.test(id)) { error(path, `"${id}" is not a valid app name: lowercase letters, digits, "-" and "_", starting with a letter, at most 35 characters`); continue }
    const t = table(raw, path)
    if (!t) continue
    const app = slackApp(id, t, path)
    if (app) slackApps[id] = app
  }
  // Messages name an app by its display_name alone, so two apps with one name would read as one.
  const nameOwner = new Map<string, string>()
  for (const app of Object.values(slackApps)) {
    const first = nameOwner.get(app.displayName.toLowerCase())
    if (first) error(`slack.apps.${app.id}.display_name`, `"${app.displayName}" is already the name of [slack.apps.${first}]: alerts and \`hydra health\` name an app by it, so each app needs its own`)
    else nameOwner.set(app.displayName.toLowerCase(), app.id)
  }

  // --- MCP servers specialists may list ------------------------------------------------------------------------------

  // Declared here and nowhere else: a server is a process that runs as the operator, so only a hand edit of hydra.toml adds one.
  const mcpServers: Record<string, McpServer> = Object.create(null)
  for (const [name, raw] of Object.entries(table(doc.mcp_servers, 'mcp_servers') ?? {})) {
    const path = `mcp_servers.${name}`
    if (!ID_RE.test(name)) { error(path, `"${name}" is not a valid server name: lowercase letters, digits and dashes`); continue }
    const t = table(raw, path)
    if (!t) continue
    unknownKeys(t, ['command', 'token_env', 'tools'], path)
    const command = str(t, 'command', path)
    if (t.command === undefined) error(`${path}.command`, 'is required: the server\'s executable, pinned (a path or a versioned binary, not `npx -y` latest)')
    else if (command !== undefined && !env.isCommand(expand(command))) error(`${path}.command`, `${expand(command)} is not an executable file or a command on PATH`)
    const tokenEnv: string[] = []
    for (const [i, v] of (strList(t, 'token_env', path) ?? []).entries()) {
      if (!ENV_NAME_RE.test(v)) { error(`${path}.token_env[${i}]`, `"${v}" must name an environment variable, like DD_API_KEY`); continue }
      const owned = envOwner.get(v)
      if (owned) { error(`${path}.token_env[${i}]`, `"${v}" is the token variable of ${owned}: a server never gets hydra's own tokens`); continue }
      if (!tokenEnv.includes(v)) tokenEnv.push(v)
    }
    const tools: string[] = []
    for (const [i, v] of (strList(t, 'tools', path) ?? []).entries()) {
      if (!MCP_TOOL_RE.test(v)) { error(`${path}.tools[${i}]`, `"${v}" must be a tool name the server offers, like search_logs (no wildcards)`); continue }
      if (!tools.includes(v)) tools.push(v)
    }
    if (command !== undefined) mcpServers[name] = { name, command: expand(command), tokenEnv, tools }
  }

  // --- people --------------------------------------------------------------------------------------------------------

  const people: Record<string, Person> = {}
  const owner = new Map<Address, string>()
  for (const [id, raw] of Object.entries(table(doc.people, 'people') ?? {})) {
    const path = `people.${id}`
    if (!ID_RE.test(id)) error(path, 'a person\'s id must be lowercase letters, digits and dashes')
    else if (BUILTIN.includes(id)) error(path, `"${id}" is a built-in role; a person needs another id`)
    const t = table(raw, path)
    if (!t) continue
    unknownKeys(t, ['addresses', 'roles', 'name'], path)
    const written = strList(t, 'addresses', path)
    if (t.addresses === undefined || written?.length === 0) error(`${path}.addresses`, 'is required: at least one address, like "slack:U0TEST" or "github:alice"')
    const addresses: Address[] = []
    for (const [i, raw] of (written ?? []).entries()) {
      const a = normalizeAddress(raw)
      if (!a) { error(`${path}.addresses[${i}]`, `"${raw}" is not an address: use discord:<user id>, slack:<user id> or github:<login>`); continue }
      const other = owner.get(a)
      if (other && other !== id) error(`${path}.addresses[${i}]`, `${a} already belongs to ${other}: one address, one person`)
      owner.set(a, id)
      addresses.push(a)
    }
    const roles = strList(t, 'roles', path) ?? []
    for (const [i, r] of roles.entries()) {
      if (BUILTIN.includes(r)) error(`${path}.roles[${i}]`, `"${r}" is built in: ${r === 'people' ? 'everyone on the roster' : 'anyone at all'} holds it already`)
      else if (!ID_RE.test(r)) error(`${path}.roles[${i}]`, `role "${r}" must be lowercase letters, digits and dashes`)
    }
    const name = str(t, 'name', path)
    people[id] = { id, addresses, roles, ...(name !== undefined && { name }) }
  }
  const declaredRoles = new Set(Object.values(people).flatMap(p => p.roles))
  // A role named like a person would make a rule's `person` ambiguous.
  for (const role of declaredRoles) if (has(people, role)) error(`people.${role}`, `"${role}" is both a person and a role (${spelledPerson(role)} and ${spelledRole(role)}); rename one`)
  const isRole = (r: string) => BUILTIN.includes(r) || declaredRoles.has(r)

  // --- named values --------------------------------------------------------------------------------------------------
  // A value that names a person, a role or an app says its kind: `person:alice`, `role:finance`, `app:sales`. The reader is shared/value-kind.ts,
  // as `hydra route` reads it; the loaded config holds the bare name, which routing compares with. A person and a role never share a name (above).
  const noRole = (r: string, key = '') => `no one holds the role "${r}": ${key}give a person that role in [people.<id>] roles`
  /** A role someone holds, or a built-in one: `role:<name>`. For a key that lists roles only (`reachable_by`). */
  const roleValue = (raw: string, path: string): string | undefined => {
    const r = readValue(raw, ['role'])
    if (!r.ok) { error(path, r.error); return undefined }
    if (!isRole(r.name)) { error(path, noRole(r.name, 'reachable_by lists roles, so ')); return undefined }
    return r.name
  }
  /** A person from `[people]` or a role someone holds: `person:<id>` or `role:<name>`. For a rule's `person`. */
  const whoValue = (raw: string, path: string): string | undefined => {
    const r = readValue(raw, ['person', 'role'])
    if (!r.ok) { error(path, r.error); return undefined }
    if (r.kind === 'person' && !has(people, r.name)) { error(path, `"${raw}" is not a person: declare [people.${r.name}]`); return undefined }
    if (r.kind === 'role' && !isRole(r.name)) { error(path, noRole(r.name)); return undefined }
    return r.name
  }
  /** A declared Slack app: `app:<id>`. */
  const appValue = (raw: string, path: string): string | undefined => {
    const r = readValue(raw, ['app'])
    if (!r.ok) { error(path, r.error); return undefined }
    if (!Object.hasOwn(slackApps, r.name)) { error(path, noSuchApp(r.name, Object.keys(slackApps))); return undefined }
    return r.name
  }
  const appList = (l: readonly string[]) => l.map(spelledApp).join(', ')

  // --- operator ------------------------------------------------------------------------------------------------------

  let operator: string | undefined
  if (doc.operator !== undefined) {
    if (typeof doc.operator !== 'string') error('operator', 'must be a quoted person id')
    else if (!has(people, doc.operator)) error('operator', `"${doc.operator}" is not a person: declare [people.${doc.operator}]`)
    else operator = doc.operator
  } else if (Object.keys(doc).some(k => !OPERATOR_FREE_KEYS.includes(k))) {
    error('operator', 'is required: name the person whose DMs reach main and who may reach every specialist')
  }

  // --- main: how the operator's harness runs (read by whatever starts it, not by the daemon) ---------------------------

  let main: MainOptions | undefined
  const mainTable = table(doc.main, 'main')
  if (mainTable) {
    unknownKeys(mainTable, MAIN_KEYS, 'main')
    // As a specialist's `model`: kept as written; the start resolves an alias (resolveLaunchModel).
    const model = str(mainTable, 'model', 'main')
    // Main starts `claude --model <model>` (cli/lifecycle.ts byteLaunch), so a model of another engine would reach Claude as a literal.
    const mainEngine = model === undefined ? undefined : engineOfModel(model)
    if (mainEngine !== undefined && mainEngine !== 'claude') error('main.model', `"${model}" is a ${mainEngine} model, and main runs on Claude: use a Claude model (opus, sonnet, ...) or a full Claude model id`)
    else if (model !== undefined) main = { model }
  }

  // --- specialists, with [defaults.specialist] -----------------------------------------------------------------------

  const defaultsTable = table(doc.defaults, 'defaults') ?? {}
  unknownKeys(defaultsTable, ['specialist'], 'defaults')
  const restrictedTable = table(doc.restricted, 'restricted') ?? {}
  unknownKeys(restrictedTable, ['off_limits', ALLOW_UNPROVEN_MACOS], 'restricted')
  const allowUnprovenMacos = bool(restrictedTable, ALLOW_UNPROVEN_MACOS, 'restricted') ?? false
  // Folders no restricted specialist may use, beyond the built-in ones: per-operator, so they live here and never in code.
  const offLimits: string[] = []
  for (const [i, raw] of (strList(restrictedTable, 'off_limits', 'restricted') ?? []).entries()) {
    const root = expand(raw)
    if (!isAbsolute(root)) error(`restricted.off_limits[${i}]`, `"${raw}" must be an absolute path or start with ~`)
    else if (unquotablePath(root)) error(`restricted.off_limits[${i}]`, unquotablePath(root)!)
    else offLimits.push(root)
  }
  const defaults = table(defaultsTable.specialist, 'defaults.specialist') ?? {}
  unknownKeys(defaults, SPECIALIST_KEYS, 'defaults.specialist')
  // A default reaches every specialist, including ones nobody meant to scope: these are set on one specialist's own table.
  for (const k of RESTRICTION_KEYS) if (has(defaults, k)) error(`defaults.specialist.${k}`, `can't be a default: ${k} says what one specialist's session may reach. Set it under [specialists.<id>] by editing hydra.toml`)
  if (has(defaults, 'emoji')) error('defaults.specialist.emoji', "can't be a default: an emoji tells one specialist's threads from the others'. Set it under [specialists.<id>]")
  if (defaults.workdir !== undefined && typeof defaults.workdir === 'string' && !defaults.workdir.includes('{id}')) {
    warn('defaults.specialist.workdir', 'has no {id}, so every specialist without its own workdir shares one folder')
  }
  if (defaults.kickoff !== undefined && defaults.kickoff_file !== undefined) error('defaults.specialist', 'set kickoff or kickoff_file, not both')
  // Defaults are type-checked once, here, so a bad default is reported once, not once per specialist.
  const goodDefaults: Table = {}
  for (const k of Object.keys(defaults)) {
    if (!SPECIALIST_KEYS.includes(k) || k === 'emoji' || (RESTRICTION_KEYS as readonly string[]).includes(k)) continue
    const n = errors.length
    readSpecialistKeyTypes({ [k]: defaults[k] }, 'defaults.specialist')
    if (errors.length === n && k === 'idle') checkIdle(defaults.idle as string, 'defaults.specialist.idle')
    if (errors.length === n && k === 'reachable_by') { goodDefaults[k] = readReachableBy(defaults.reachable_by as string[], 'defaults.specialist.reachable_by'); continue }
    if (errors.length === n) goodDefaults[k] = defaults[k]
  }

  function checkIdle(raw: string, path: string): number | undefined {
    const ms = parseIdleTtl(raw)
    if (ms === null) error(path, `"${raw}" must be a duration like 90m, 12h or 4d, at most 7d`)
    return ms ?? undefined
  }
  /** `reachable_by` as the loaded config holds it: bare role names, each checked. */
  function readReachableBy(roles: string[], path: string): string[] {
    return roles.flatMap((r, i) => roleValue(r, `${path}[${i}]`) ?? [])
  }

  function readSpecialistKeyTypes(t: Table, path: string) {
    str(t, 'workdir', path); str(t, 'kickoff', path); str(t, 'kickoff_file', path); strList(t, 'pinned_to', path); str(t, 'speaks_as', path); strList(t, 'reachable_by', path)
    oneOf(t, 'sessions', path, SESSIONS_MODES); positiveInt(t, 'max_sessions', path); str(t, 'idle', path); str(t, 'home_place', path); str(t, 'model', path)
    oneOf(t, 'engine', path, ENGINES); str(t, 'env_file', path); strList(t, 'renamed_from', path)
    bool(t, 'restricted', path); strList(t, 'tools', path); strList(t, 'mcp_servers', path); strList(t, 'sends_to', path)
  }
  function positiveInt(t: Table, k: string, path: string): number | undefined {
    const v = t[k]
    if (v === undefined) return undefined
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
    error(join2(path, k), 'must be a whole number above 0')
    return undefined
  }

  const checkWorkdirRestriction = (at: string, workdir: string) => { for (const why of workdirRestrictionIssues(env, workdir, offLimits)) error(at, why) }

  const specialists: Record<string, Specialist> = {}
  const formerly = new Map<string, string>()
  const specialistTables = table(doc.specialists, 'specialists') ?? {}
  for (const [id, raw] of Object.entries(specialistTables)) {
    const path = `specialists.${id}`
    const why = invalidSpecialistName(id, env.sessionNames)
    if (why) error(path, why)
    const own = table(raw, path)
    if (!own) continue
    unknownKeys(own, SPECIALIST_KEYS, path)
    if (own.kickoff !== undefined && own.kickoff_file !== undefined) error(path, 'set kickoff or kickoff_file, not both')
    // Its own keys win; its own kickoff or kickoff_file replaces both defaults.
    const inherited = Object.fromEntries(Object.entries(goodDefaults)
      .filter(([k]) => !((k === 'kickoff' || k === 'kickoff_file') && (own.kickoff !== undefined || own.kickoff_file !== undefined)))
      .map(([k, v]) => [k, fillId(v, id)]))
    const t: Table = { ...inherited, ...own }
    const at = (k: string) => has(own, k) ? `${path}.${k}` : `${path}.${k} (from defaults.specialist)`

    const workdirRaw = str(t, 'workdir', path)
    let workdir = ''
    if (t.workdir === undefined) error(`${path}.workdir`, 'is required: the folder it runs in')
    else if (workdirRaw !== undefined) {
      workdir = expand(workdirRaw)
      if (!isAbsolute(workdir)) error(at('workdir'), `"${workdirRaw}" must be an absolute path or start with ~`)
      else if (!env.isDir(workdir)) error(at('workdir'), `${workdir} is not a folder`)
      // Its sessions run there, where today's spawns run too (SPAWN_CWD), but hydra won't mark a whole home folder trusted.
      else if (resolve(workdir) === resolve(env.home) || resolve(workdir) === '/') warn(at('workdir'), `${workdir} is ${resolve(workdir) === '/' ? 'the whole disk' : 'your whole home folder'}: its sessions can read everything there, and hydra won't pre-approve Claude's trust for it; give the specialist a folder of its own`)
    }
    const kickoff = str(t, 'kickoff', path)
    const kickoffFileRaw = str(t, 'kickoff_file', path)
    const underWorkdir = (p: string) => isAbsolute(expand(p)) ? expand(p) : join(workdir, p)
    const kickoffFile = kickoffFileRaw === undefined ? undefined : underWorkdir(kickoffFileRaw)

    // `pinned_to` pins it: it takes only messages that come through those Slack apps, and those apps deliver only to specialists pinned to them. Absent: unpinned.
    let pinnedTo: string[] | undefined
    const pinnedRaw = strList(t, 'pinned_to', path)
    if (pinnedRaw !== undefined) {
      if (pinnedRaw.length === 0) error(at('pinned_to'), 'must name at least one app; leave `pinned_to` out to take every app that no specialist is pinned to')
      const apps = pinnedRaw.flatMap((a, i) => appValue(a, `${at('pinned_to')}[${i}]`) ?? [])
      if (pinnedRaw.length) pinnedTo = [...new Set(apps)]
    }

    // `speaks_as`: the app it posts as when no message came in (its `home_place`, a new thread). It names a declared app, one it is pinned to if it is pinned.
    const speaksAsRaw = str(t, 'speaks_as', path)
    const speaksAs = speaksAsRaw === undefined ? undefined : appValue(speaksAsRaw, at('speaks_as'))
    if (speaksAs !== undefined) {
      if (pinnedTo && !pinnedTo.includes(speaksAs)) error(at('speaks_as'), `${spelledApp(speaksAs)} is not one of the apps ${id} is pinned to (${appList(pinnedTo)}): a pinned specialist speaks only through its own apps`)
    }

    // An inherited `reachable_by` was read once, at the default.
    const reachableByRaw = strList(t, 'reachable_by', path) ?? ['people']
    const reachableBy = has(own, 'reachable_by') ? readReachableBy(reachableByRaw, `${path}.reachable_by`) : reachableByRaw

    const idleRaw = str(t, 'idle', path)
    // An inherited idle was checked once, at the default.
    const idleMs = idleRaw === undefined ? undefined : has(own, 'idle') ? checkIdle(idleRaw, `${path}.idle`) : parseIdleTtl(idleRaw) ?? undefined

    const renamedFrom = strList(t, 'renamed_from', path) ?? []
    for (const [i, old] of renamedFrom.entries()) {
      const bad = invalidSpecialistName(old, env.sessionNames)
      if (bad) { error(`${at('renamed_from')}[${i}]`, bad); continue }
      if (has(specialistTables, old)) error(`${at('renamed_from')}[${i}]`, `"${old}" is a current specialist; an old id can't be in use`)
      else if (formerly.has(old) && formerly.get(old) !== id) error(`${at('renamed_from')}[${i}]`, `"${old}" is already an old id of ${formerly.get(old)}`)
      else formerly.set(old, id)
    }

    const envFile = str(t, 'env_file', path)
    const homePlace = str(t, 'home_place', path)
    // A place, or a channel by its platform id: where it posts when nobody wrote to it first (a new thread).
    if (homePlace !== undefined && !normalizePlace(homePlace) && !/^\d+$/.test(homePlace)) error(at('home_place'), `"${homePlace}" must be a place (slack:#channel, discord:#channel, …) or a channel id`)
    const model = str(t, 'model', path)
    // One emoji character, for its threads' names (shared/emoji.ts). Read raw, so an empty or spaced value gets what to write, not the generic string message.
    const emojiWhy = t.emoji === undefined ? undefined : emojiProblem(t.emoji)
    if (emojiWhy) error(at('emoji'), emojiWhy)
    const engine = oneOf(t, 'engine', path, ENGINES)
    // One rule for the engine a specialist runs on: its `engine`, else the one its model alias names. omp can't be confined or
    // pinned to a thread's tools, so no specialist runs on it; an `engine` and a model that name two engines is a mistake.
    const aliased = model === undefined ? undefined : engineOfModel(model)
    const runsOn = engine ?? aliased
    if (runsOn === 'omp') error(engine === 'omp' ? at('engine') : at('model'), `omp cannot confine a session's tools, so a specialist cannot use it; use claude or codex`)

    // `restricted`: its session runs in its folder, with only what it lists. Everything below refuses what would let a restricted session reach past its folder.
    const restricted = bool(t, 'restricted', path) ?? false
    // Two engines named: said once. Not when the restricted refusal below already stands for the same specialist (it names the engine to leave).
    if (engine !== undefined && aliased !== undefined && aliased !== engine && !(restricted && !engineConfinesAccess(engine))) error(at('model'), `"${model}" is a ${aliased} model, but engine = "${engine}": set engine = "${aliased}", or use a model for ${engine}`)
    const toolsRaw = strList(t, 'tools', path)
    const mcpServerNamesRaw = strList(t, 'mcp_servers', path)
    const sendsToRaw = strList(t, 'sends_to', path)
    let tools: string[] | undefined
    let mcpServerNames: string[] | undefined
    if (!restricted) {
      for (const k of ['tools', 'mcp_servers', 'sends_to'] as const) if (t[k] !== undefined) error(`${path}.${k}`, `has no effect while restricted = false: it already has every tool and server the operator does${k === 'sends_to' ? ', and send_to_thread to any session' : ''}; set restricted = true to choose them`)
    } else {
      tools = [...new Set(toolsRaw ?? WORKDIR_TOOLS)]
      for (const [i, name] of (toolsRaw ?? []).entries()) {
        if ((WORKDIR_TOOLS as readonly string[]).includes(name)) continue
        if (Object.hasOwn(TOOL_WARNINGS, name)) { warn(`${path}.tools[${i}]`, `${name} ${TOOL_WARNINGS[name]}`); continue }
        error(`${path}.tools[${i}]`, `${name} ${Object.hasOwn(TOOL_REFUSALS, name) ? TOOL_REFUSALS[name] : `is not a tool a restricted specialist may use (${WORKDIR_TOOLS.join(', ')})`}; remove it or set restricted = false`)
      }
      mcpServerNames = [...new Set(mcpServerNamesRaw ?? [])]
      for (const [i, name] of (mcpServerNamesRaw ?? []).entries()) {
        if (!Object.hasOwn(mcpServers, name)) error(`${path}.mcp_servers[${i}]`, `no [mcp_servers.${name}]: declare the server in hydra.toml first`)
        else if (mcpServers[name].tools.length === 0) error(`${path}.mcp_servers[${i}]`, `[mcp_servers.${name}] lists no tools, so a specialist could call none of them: set its \`tools\``)
        else for (const v of mcpServers[name].tokenEnv) if (!env.envFileHas(v)) warn(`${path}.mcp_servers[${i}]`, `[mcp_servers.${name}] needs ${v}, and ${join(env.stateDir, '.env')} does not set it, so no session of this specialist can start until it does: add ${v}=<value> there and restart the daemon`)
      }
      // A listed server runs under sandbox-exec; a machine without it cannot host the specialist (the launch checks again).
      if (mcpServerNames.length) {
        const why = sandboxIssues(env.isCommand, offLimitRoots(env, offLimits))
        if (why) error(`${path}.mcp_servers`, why)
        const unproven = macosGateIssue(env.macosVersion, allowUnprovenMacos)
        if (unproven) warn(`${path}.mcp_servers`, unproven)
      }
      // The engine actually used comes from thread history and `handoff <model>` can switch it, so launch checks it again.
      if (runsOn !== undefined && runsOn !== 'omp' && !engineConfinesAccess(runsOn)) error(engine !== undefined ? at('engine') : at('model'), `${runsOn} can't run a restricted specialist: that engine cannot confine its tools; use claude (engine = "claude", or a Claude model), or set restricted = false`)
      if (workdirRaw !== undefined && isAbsolute(workdir) && env.isDir(workdir)) checkWorkdirRestriction(at('workdir'), workdir)
    }
    specialists[id] = {
      id, workdir, reachableBy,
      ...(pinnedTo && { pinnedTo }),
      ...(speaksAs !== undefined && Object.hasOwn(slackApps, speaksAs) && { speaksAs }),
      sessions: oneOf(t, 'sessions', path, SESSIONS_MODES) ?? 'shared',
      maxSessions: positiveInt(t, 'max_sessions', path) ?? 20,
      renamedFrom,
      ...(kickoff !== undefined && { kickoff }),
      ...(kickoffFile !== undefined && { kickoffFile }),
      ...(idleMs !== undefined && { idleMs }),
      ...(homePlace !== undefined && { homePlace: normalizePlace(homePlace) ?? homePlace }),
      ...(model !== undefined && { model }),
      ...(t.emoji !== undefined && !emojiWhy && { emoji: t.emoji as string }),
      ...(engine !== undefined && { engine }),
      restricted,
      ...(tools && { tools }),
      ...(mcpServerNames && { mcpServerNames }),
      ...(sendsToRaw && restricted && { sendsTo: [...new Set(sendsToRaw)] }),
      ...(envFile !== undefined && { envFile: underWorkdir(envFile) }),
    }
  }
  // A target value says its kind: `main` (the built-in specialist: never declared) or `specialist:<name>` (declared here).
  // Read by `readTarget`, as delivery and the CLI read it; the loaded config holds the bare form (`main`, a specialist's id), which is what routing and the schedules compare against.
  const targetOf = (raw: string, path: string, owner: 'rule' | 'schedule'): string | undefined => {
    const r = readTarget(raw, id => has(specialists, id))
    if (!r.ok) { error(path, r.error ?? `no specialist "${r.undeclared}": declare [specialists.${r.undeclared}], or use main`); return undefined }
    if (r.ref.kind === 'thread') { error(path, `"${raw}" is a thread, and a ${owner}'s target is main or a declared specialist: declare a specialist for that thread, and write specialist:<name>`); return undefined }
    return bareOf(r.ref)
  }

  // --- places --------------------------------------------------------------------------------------------------------

  const places: Record<Place, PlaceOptions> = {}
  for (const [rawPlace, raw] of Object.entries(table(doc.places, 'places') ?? {})) {
    const path = `places."${rawPlace}"`
    const p = place(rawPlace, path)
    const t = table(raw, path)
    if (!p || !t) continue
    if (has(places, p)) { error(path, `${p} is already set: places compare without case on GitHub`); continue }
    unknownKeys(t, ['ack', 'files', 'messages', 'bots', 'reactions', 'default_app', 'link_previews'], path)
    const ack = str(t, 'ack', path)
    const ackWhy = ack === undefined ? undefined : reactionNameProblem(ack)
    if (ackWhy) error(join2(path, 'ack'), ackWhy)
    // Which app answers an unmentioned message when several apps are in this channel.
    const defaultAppRaw = str(t, 'default_app', path)
    let defaultApp: string | undefined
    if (defaultAppRaw !== undefined) {
      if (!p.startsWith('slack:') || !namesAChannel(p)) error(`${path}.default_app`, `${p} is not a Slack channel: \`default_app\` picks among the apps in a channel`)
      else defaultApp = appValue(defaultAppRaw, `${path}.default_app`)
    }
    if (Object.hasOwn(t, 'reactions') && !p.startsWith('slack:')) error(`${path}.reactions`, `${p} is not a Slack place: \`reactions\` is heard only from Slack`)
    // Hydra reads a Discord channel by id: a place named `discord:#name` can never be matched to a channel, so previews could not be switched off there.
    if (namesDmWithOthers(p)) for (const key of ['link_previews', 'messages', 'bots', 'reactions']) if (Object.hasOwn(t, key)) error(`${path}.${key}`, `${key} does not apply to ${p}: only ack and files do. Remove it.`)
    if (p.startsWith('discord:#') && t.link_previews === false) error(`${path}.link_previews`, 'cannot be set on a Discord channel by name: hydra reads a Discord channel by id, so name it discord:<channel id>')
    places[p] = {
      ...(ack !== undefined && !ackWhy && { ack }),
      ...(defaultApp !== undefined && { defaultApp }),
      files: bool(t, 'files', path) ?? false,
      messages: oneOf(t, 'messages', path, ['addressed', 'all'] as const) ?? 'addressed',
      bots: bool(t, 'bots', path) ?? false,
      reactions: oneOf(t, 'reactions', path, ['off', 'bot-messages', 'all'] as const) ?? 'off',
      linkPreviews: bool(t, 'link_previews', path) ?? true,
    }
  }

  // --- schedules (checked now, run by a later step) ------------------------------------------------------------------

  const schedules: Record<string, Schedule> = {}
  for (const [id, raw] of Object.entries(table(doc.schedules, 'schedules') ?? {})) {
    const path = `schedules.${id}`
    if (!ID_RE.test(id)) error(path, 'a schedule\'s id must be lowercase letters, digits and dashes')
    const t = table(raw, path)
    if (!t) continue
    unknownKeys(t, ['cron', 'target', 'message', 'check', 'workdir', 'env_file', 'runner', 'needs', 'alert_after', 'paused'], path)
    const cron = str(t, 'cron', path)
    if (t.cron === undefined) error(`${path}.cron`, 'is required: 5 fields, local time')
    else if (cron !== undefined) {
      try { parseCron(cron) } catch (e) { error(`${path}.cron`, (e as Error).message) }
    }
    const targetRaw = str(t, 'target', path)
    const target = targetRaw === undefined ? undefined : targetOf(targetRaw, `${path}.target`, 'schedule')
    const message = t.message === '' ? '' : str(t, 'message', path) ?? ''
    const check = str(t, 'check', path)
    // No `target`: a sensor. It sends nothing, so it needs a check and takes no message.
    if (t.target === undefined && check === undefined) error(`${path}.target`, 'is required unless there is a check (a sensor): specialist:<name>, or main')
    if (t.target === undefined && message !== '') error(`${path}.message`, 'a schedule with no target sends nothing, so it takes no message')
    const workdirRaw = str(t, 'workdir', path)
    const workdir = workdirRaw === undefined ? undefined : expand(workdirRaw)
    if (workdir !== undefined && !isAbsolute(workdir)) error(`${path}.workdir`, `"${workdirRaw}" must be an absolute path or start with ~`)
    // Relative to the schedule's workdir, as kickoff_file and env_file are to a specialist's workdir.
    const envFileRaw = str(t, 'env_file', path)
    const envFile = envFileRaw === undefined ? undefined : isAbsolute(expand(envFileRaw)) ? expand(envFileRaw) : workdir && isAbsolute(workdir) ? join(workdir, envFileRaw) : undefined
    if (envFileRaw !== undefined && envFile === undefined) error(`${path}.env_file`, `"${envFileRaw}" is relative, so it needs an absolute workdir`)
    const runner = oneOf(t, 'runner', path, RUNNERS) ?? 'launchd'
    // A daemon schedule is retried until done; launchd fires once. needs and alert_after only mean something retried.
    const needs = strList(t, 'needs', path)
    for (const [i, n] of (needs ?? []).entries()) if (!(NEEDS as readonly string[]).includes(n)) error(`${path}.needs[${i}]`, `unknown precondition "${n}" (known: ${NEEDS.join(', ')})`)
    const alertAfterMs = duration(t, 'alert_after', path, MAX_ALERT_AFTER_MS)
    for (const k of ['needs', 'alert_after']) if (t[k] !== undefined && runner !== 'daemon') error(`${path}.${k}`, 'needs runner = "daemon"')
    const paused = bool(t, 'paused', path)
    schedules[id] = {
      id, cron: cron ?? '', message, runner,
      ...(paused && { paused: true as const }),
      ...(target !== undefined && { target }),
      ...(needs?.length && { needs: [...new Set(needs)] as Need[] }),
      ...(alertAfterMs !== undefined && { alertAfterMs }),
      ...(check !== undefined && { check }),
      ...(workdir !== undefined && { workdir }),
      ...(envFile !== undefined && { envFile }),
    }
  }

  // --- rules (checked now, applied by a later step) ------------------------------------------------------------------

  const rules: Rule[] = []
  /** Where each rule in `rules` was written: `rules[2]`. */
  const ruleAt: string[] = []
  /** One rule's table checked and added. `at` names the key an error is about: `<path>.<key>`. */
  const readRule = (t: Table, path: string, at: (key: string) => string) => {
    unknownKeys(t, ['place', 'app', 'person', 'target'], path)
    const placeRaw = str(t, 'place', path)
    const appRaw = str(t, 'app', path)
    if (t.place === undefined && t.app === undefined) error(path, 'a rule needs `place`, `app` or both; `person` only narrows who it applies to')
    const rulePlace = placeRaw === undefined ? undefined : place(placeRaw, at('place'))
    let app: string | undefined
    if (appRaw !== undefined) {
      app = appValue(appRaw, at('app'))
      if (rulePlace && !rulePlace.startsWith('slack:')) error(at('app'), `an app is a Slack app, but ${rulePlace} is not a Slack place: set \`place\` to a \`slack:\` place, remove \`place\`, or remove \`app\``)
    }
    const personRaw = str(t, 'person', path)
    const person = personRaw === undefined ? undefined : whoValue(personRaw, at('person'))
    const ruleTargetRaw = str(t, 'target', path)
    if (t.target === undefined) error(at('target'), 'is required: specialist:<name>, or main')
    const ruleTarget = ruleTargetRaw === undefined ? undefined : targetOf(ruleTargetRaw, at('target'), 'rule')
    // Whether `target` can ever take what the rule matches: a pinned specialist only through its `pinned_to` apps, and an app that any specialist is pinned to delivers only to them.
    const specialist = ruleTarget !== undefined ? specialists[ruleTarget] : undefined
    if (specialist && ruleTarget !== undefined) {
      const pin = !app ? '' : `add ${spelledApp(app)} to ${ruleTarget}'s \`pinned_to\`, or change the rule's \`app\``
      if (app && specialist.pinnedTo && !specialist.pinnedTo.includes(app)) error(at('target'), `${ruleTarget} is pinned to ${appList(specialist.pinnedTo)}, so ${spelledApp(app)} can never deliver to it: ${pin}`)
      else if (app && !specialist.pinnedTo && pinnersOf(specialists, app).length) error(at('target'), `${spelledApp(app)} serves only specialists pinned to it (${pinnersOf(specialists, app).join(', ')}), and ${ruleTarget} is not pinned to it: ${pin}`)
      else if (specialist.pinnedTo && !app && rulePlace && !rulePlace.startsWith('slack:')) error(at('target'), `${ruleTarget} is pinned to Slack apps, so it can never take a message at ${rulePlace}: remove \`pinned_to\` from ${ruleTarget}, or send it a \`slack:\` place instead`)
    }
    if ((rulePlace || app) && ruleTarget) {
      ruleAt.push(path)
      rules.push({ target: ruleTarget, ...(rulePlace && { place: rulePlace }), ...(app && { app }), ...(person !== undefined && { person }) })
    }
  }
  if (doc.rules !== undefined && !(Array.isArray(doc.rules) && doc.rules.every(isTable))) error('rules', 'must be [[rules]] tables')
  else for (const [i, t0] of ((doc.rules ?? []) as Table[]).entries()) {
    const path = `rules[${i}]`
    readRule(t0, path, k => join2(path, k))
  }
  // A rule never matches when an earlier one takes everything it would: its place and app are the same or wider, and who `later`
  // names is a subset of who `earlier` names. Absent and `anyone` include strangers; `people` is the roster; a role, its holders.
  const senders = (person: string | undefined): Set<string> | 'everyone' => {
    if (person === undefined || person === 'anyone') return 'everyone'
    if (person === 'people') return new Set(Object.keys(people))
    if (has(people, person)) return new Set([person])
    return new Set(Object.values(people).filter(p => p.roles.includes(person)).map(p => p.id))
  }
  const covers = (earlier: string | undefined, later: string | undefined): boolean => {
    const e = senders(earlier), l = senders(later)
    if (e === 'everyone') return true
    if (l === 'everyone') return false
    return [...l].every(id => e.has(id))
  }
  const where = (r: Rule) => r.place && r.app ? `at ${r.place} through ${spelledApp(r.app)}` : r.place ? `at ${r.place}` : `through ${spelledApp(r.app!)}`
  // The apps a rule applies to: its own `app`; else, to a pinned specialist, that specialist's apps; else, to anyone else, every app
  // that no specialist is pinned to (an app that has pinned specialists skips a rule to anyone else). 'any' when pins play no part.
  const appsOf = (r: Rule): string[] | 'any' => {
    if (r.app) return [r.app]
    const target = specialists[r.target]
    if (target?.pinnedTo) return target.pinnedTo
    if (!target || !Object.values(specialists).some(x => x.pinnedTo)) return 'any'
    return Object.keys(slackApps).filter(a => pinnersOf(specialists, a).length === 0)
  }
  const appsCover = (earlier: Rule, later: Rule): boolean => {
    const e = appsOf(earlier), l = appsOf(later)
    return e === 'any' || (l !== 'any' && l.every(a => e.includes(a)))
  }
  // Two rules that take every message at one place through one app are a mistake, not a preference: the earlier wins and the later never gets
  // them. That is an error, naming both.
  const takesEveryone = (r: Rule) => senders(r.person) === 'everyone'
  const clashApps = (earlier: Rule, later: Rule): string | undefined => {
    const e = appsOf(earlier), l = appsOf(later)
    const shared = e === 'any' ? l : l === 'any' ? e : l.filter(a => e.includes(a))
    // Both name apps (a pin, or an `app`): sharing one is a clash even if each also has another. 'any' on one side clashes only when the other is wholly covered.
    if (e !== 'any' && l !== 'any') return shared.length ? appList(shared as string[]) : undefined
    return appsCover(earlier, later) && !(l !== 'any' && l.length === 0) ? 'any app' : undefined
  }
  const clashed = new Set<number>()
  for (const [j, later] of rules.entries()) {
    if (later.place === undefined || !takesEveryone(later)) continue
    for (const [i, earlier] of rules.slice(0, j).entries()) {
      // The same target twice is a redundant rule, not a shadowed one: it keeps its `never matches` warning.
      if (earlier.place !== later.place || !takesEveryone(earlier) || earlier.target === later.target) continue
      const via = clashApps(earlier, later)
      if (via === undefined) continue
      const named = (r: Rule) => r.target === MAIN_TARGET ? 'main' : `specialist:${r.target}`
      error(ruleAt[j], `sends every message at ${later.place} through ${via} to ${named(later)}, but ${ruleAt[i]} already sends them to ${named(earlier)}: give ${ruleAt[j]} a \`person\`, or remove it`)
      clashed.add(j)
      break
    }
  }
  for (const [j, later] of rules.entries()) {
    if (clashed.has(j)) continue
    const i = rules.findIndex((earlier, k) => k < j && (earlier.place === undefined || earlier.place === later.place) && appsCover(earlier, later) && covers(earlier.person, later.person))
    if (i >= 0) warn(ruleAt[j], `never matches: ${ruleAt[i]} already takes ${later.person ? `${whoSpelled(people, later.person)}'s messages` : 'every message'} ${where(later)}`)
  }
  /** Where a specialist answers every message (see `placesAnsweredBy`). */
  const answered = (id: string): Place[] => placesAnsweredBy({ rules }, id)

  // --- guard (checked now, run by a later step) ----------------------------------------------------------------------

  let guard: Guard | undefined
  const g = table(doc.guard, 'guard')
  if (g) {
    unknownKeys(g, ['command', 'timeout', 'include_text', 'owed_max'], 'guard')
    const command = str(g, 'command', 'guard')
    if (g.command === undefined) error('guard.command', 'is required')
    else if (command !== undefined) {
      const program = expand(shellProgram(command))
      if (!env.isCommand(program)) error('guard.command', `${program} is not an executable file or a command on PATH`)
    }
    const timeoutMs = duration(g, 'timeout', 'guard', GUARD_TIMEOUT_MAX_MS) ?? 5_000
    const owedMaxMs = duration(g, 'owed_max', 'guard', 7 * MAX_DAY_MS) ?? 3_600_000
    if (command !== undefined) guard = { command: command.trim(), timeoutMs, includeText: bool(g, 'include_text', 'guard') ?? false, owedMaxMs }
  }

  // --- vitals: when host health alerts ------------------------------------------------------------------------------

  let vitals: Vitals | undefined
  const vt = table(doc.vitals, 'vitals')
  if (vt) {
    unknownKeys(vt, ['overload_load_per_core', 'overload_idle_pct', 'swap_used_pct', 'ticks', 'resume_settle', 'memory_cooldown'], 'vitals')
    const d = VITALS_DEFAULTS
    vitals = {
      overloadLoadPerCore: positiveUpTo100(vt, 'overload_load_per_core', 'vitals') ?? d.overloadLoadPerCore,
      overloadIdlePct: positiveUpTo100(vt, 'overload_idle_pct', 'vitals') ?? d.overloadIdlePct,
      swapUsedPct: positiveUpTo100(vt, 'swap_used_pct', 'vitals') ?? d.swapUsedPct,
      ticks: positiveInt(vt, 'ticks', 'vitals') ?? d.ticks,
      resumeSettleMs: duration(vt, 'resume_settle', 'vitals', MAX_DAY_MS) ?? d.resumeSettleMs,
      memoryCooldownMs: duration(vt, 'memory_cooldown', 'vitals', 7 * MAX_DAY_MS) ?? d.memoryCooldownMs,
    }
  }
  // A percentage, or a load per core (past 100 is no threshold at all).
  function positiveUpTo100(t: Table, k: string, path: string): number | undefined {
    const v = t[k]
    if (v === undefined) return undefined
    if (typeof v === 'number' && v > 0 && v <= 100) return v
    error(join2(path, k), 'must be a number above 0, at most 100')
    return undefined
  }

  /** Whether hydra connects the platform: Slack through any app it declares. */
  const connected = (platform: Platform): boolean => platform === 'slack' ? Object.keys(slackApps).length > 0 : platform === 'discord' ? !!gateways.discord : !!connectors.github

  // --- warnings that need the whole file -----------------------------------------------------------------------------

  // The operator passes admin checks only through an address on the platform a daemon runs: on a connected platform
  // with none, nobody is in charge there.
  if (operator) for (const platform of ['discord', 'slack'] as const) {
    if (connected(platform) && !people[operator].addresses.some(a => a.startsWith(`${platform}:`))) {
      warn('operator', `${operator} has no ${platform}: address, so on ${platform} nobody passes admin checks or reaches main by DM`)
    }
  }

  // A post that answers no message (a specialist's `home_place`, a new thread) goes out through its `speaks_as` app (see speaksAsOf), and
  // the thread it opens must be one that app can deliver back to the specialist: checked for every specialist with a Slack home_place.
  const declaredApps = Object.keys(slackApps)
  for (const s of Object.values(specialists)) {
    const slackHomePlace = !!s.homePlace?.startsWith('slack:') && namesAChannel(s.homePlace)
    if (!slackHomePlace && !s.speaksAs) continue
    const app = speaksAsOf(s, declaredApps)
    const path = `specialists.${s.id}.speaks_as`
    if (!app) { if (declaredApps.length) error(path, `${s.id} has a Slack home_place, and ${declaredApps.length} Slack apps are declared and none is \`default\`: set \`speaks_as\` to the app it posts as`); continue }
    // A pinned specialist's own `speaks_as` was checked against its `pinned_to` above.
    const apart = s.pinnedTo && s.speaksAs ? undefined : whyNotServed(specialists, s, app, 'it would post through')
    if (apart) error(path, `${apart}: set \`speaks_as\` to an app ${s.id} can be reached through, or pin ${s.id} to ${spelledApp(app)}`)
  }

  /**
   * Who, besides the operator, can reach this specialist: the people `reachable_by` lets in (other than the operator), anyone if
   * `reachable_by` says so (with where they would be: a shared or public place, a repo), and other bots where a place hears them.
   * Reading its replies is not talking to it: a place others only read adds nothing here.
   */
  function reachedBy(s: Specialist): string[] {
    const shared = answered(s.id).filter(p => p !== 'cli' && !isDmPlace(p) && dmPerson(p) === undefined)
    const others = (people_: Person[]) => people_.filter(p => p.id !== operator).map(p => spelledPerson(p.id))
    const who: string[] = []
    if (s.reachableBy.includes('anyone')) {
      const where = shared.map(p => p.startsWith('github:') ? `who can comment on ${p}` : `in ${p}`)
      // "anyone in A and B", "anyone who can comment on R"; one phrase per kind of place.
      const inPlaces = where.filter(w => w.startsWith('in '))
      const onRepos = where.filter(w => w.startsWith('who '))
      who.push(`anyone${inPlaces.length ? ` ${inPlaces[0]}${inPlaces.slice(1).map(w => ` and ${w.slice(3)}`).join('')}` : ''}${onRepos.length ? `${inPlaces.length ? ', ' : ' '}${onRepos.join(' and ')}` : ''}`)
    } else {
      const named = new Set<string>()
      for (const role of s.reachableBy) {
        const holders = others(role === 'people' ? Object.values(people) : Object.values(people).filter(p => p.roles.includes(role)))
        const fresh = holders.filter(id => !named.has(id))
        if (!fresh.length) continue
        fresh.forEach(id => named.add(id))
        who.push(role === 'people' ? `${listJoin(fresh)} (reachable_by = ${JSON.stringify(s.reachableBy.map(spelledRole))})` : `${listJoin(fresh)} (${spelledRole(role)})`)
      }
    }
    for (const p of answered(s.id)) if (p !== 'cli' && places[p]?.bots) who.push(`any other bot in ${p}`)
    return who
  }
  const listJoin = (items: string[]) => items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

  // `sends_to`: the specialists a restricted session may send to (send_to_thread). Only specialists: never `main`, byte or a session by name. The
  // target must be a shared-session specialist, which has one session to land in. A target that runs under the operator's account is a way in for
  // whatever a restricted session was talked into saying, so it loads with a warning that says so.
  for (const s of Object.values(specialists)) {
    for (const [i, target] of (s.sendsTo ?? []).entries()) {
      const id = s.id
      const at = `specialists.${id}.sends_to[${i}]`
      if (target === id) { error(at, `${id} cannot send to itself`); continue }
      if (target === 'main' || !has(specialists, target)) { error(at, target === 'main' ? 'main is the operator\'s own session: sends_to names specialists only' : `no [specialists.${target}]: sends_to names a specialist declared in hydra.toml`); continue }
      if (specialists[target].sessions !== 'shared') { error(at, `${target} has sessions = "per-conversation": a hand-off needs one session to land in; send to a shared specialist`); continue }
      if (!specialists[target].restricted) warn(at, `${target} runs under the operator's account (restricted = false): whatever ${id} is talked into sending reaches that account, quoted and labelled but read by a session that can act as the operator; make ${target} restricted = true, with the broader folder it needs`)
    }
  }

  const ruleOrSendsToTargets = new Set([...rules.map(r => r.target), ...Object.values(specialists).flatMap(s => s.sendsTo ?? [])])
  const scheduleTargets = new Set(Object.values(schedules).map(s => s.target))
  for (const s of Object.values(specialists)) {
    const path = `specialists.${s.id}`
    const answeredAt = answered(s.id)
    if (!ruleOrSendsToTargets.has(s.id) && !scheduleTargets.has(s.id)) warn(path, 'nobody can reach it: no rule, schedule or `sends_to` names it')
    // An unrestricted session runs under the operator's account, so whoever can reach it can use that account through it.
    if (!s.restricted) {
      const who = reachedBy(s)
      if (who.length) warn(path, `${listJoin(who)} can reach the operator's account through it; set restricted = true`)
    }
    // A restricted specialist's answer can carry a link; where previews are on, the preview shows readers content they could not open themselves.
    // Previews can be switched off in a Slack channel (by id or name) and a Discord channel by id; a Discord channel given by name is not one hydra can match.
    if (s.restricted && s.reachableBy.includes('anyone')) {
      const chat = answeredAt.filter(p => (p.startsWith('slack:') || p.startsWith('discord:')) && places[p]?.linkPreviews !== false)
      const open = chat.filter(p => !p.startsWith('discord:#') && !namesDmWithOthers(p))
      const named = chat.filter(p => p.startsWith('discord:#'))
      const lead = `anyone can reach it in`
      const why = 'where a link in its answer unfurls a preview that can show readers content they could not open themselves'
      if (open.length) warn(path, `${lead} ${listJoin(open)}, ${why}; set link_previews = false in ${open.map(p => `[places.${JSON.stringify(p)}]`).join(' and ')}`)
      const noSwitch = chat.filter(namesDmWithOthers)
      if (noSwitch.length) warn(path, `${lead} ${listJoin(noSwitch)}, ${why}; previews cannot be switched off there, so let it hear another place, or narrow \`reachable_by\``)
      if (named.length) warn(path, `${lead} ${listJoin(named)}, ${why}; hydra can switch previews off in a Discord channel only by id, so list it as discord:<channel id> and set link_previews = false there`)
    }
    if (s.sessions === 'shared') {
      if (answeredAt.length >= 2) warn(path, `one shared session hears ${answeredAt.join(', ')}, so what's said in one place is remembered in the others; use sessions = "per-conversation" or one specialist per place`)
      else if (answeredAt.includes(SLACK_GROUP_DM) && s.reachableBy.length > 0) warn(path, `one shared session hears every group DM (reachable_by = ${JSON.stringify(s.reachableBy.map(spelledRole))}), so what one group says is remembered in another; use sessions = "per-conversation" or reachable_by = []`)
      else if (answeredAt.some(isDmPlace) && s.reachableBy.length > 0) warn(path, `one shared session hears everyone's DMs (reachable_by = ${JSON.stringify(s.reachableBy.map(spelledRole))}), so one person's DM is remembered in another's; use sessions = "per-conversation" or reachable_by = []`)
    }
    // Without idle, a per-conversation session never ends on its own, so its slot under max_sessions never frees.
    if (s.sessions === 'per-conversation' && s.idleMs === undefined) warn(path, `conversations past max_sessions (${s.maxSessions}) will wait until a session is ended by hand; set idle`)
    // Pinning an app takes it from every unpinned specialist: one that answers a place where no pinned specialist does has lost that app there.
    // (A rule with its own `app` answers through that app only, so it is not a place every app delivers.)
    const answeredViaEveryApp = (id: string) => placesAnsweredBy({ rules: rules.filter(r => r.app === undefined) }, id)
    if (!s.pinnedTo) for (const app of Object.keys(slackApps)) {
      const by = pinnersOf(specialists, app)
      const lost = answeredViaEveryApp(s.id).find(p => p.startsWith('slack:') && !by.some(y => answeredViaEveryApp(y).includes(p)))
      if (by.length && lost) warn(path, `${s.id} is unpinned, and ${spelledApp(app)} is pinned by ${by.join(', ')}, so ${s.id} no longer hears ${spelledApp(app)} on ${lost}`)
    }
    for (const p of answeredAt) {
      const platform = p.split(':')[0] as Platform | 'cli'
      if (platform === 'cli') continue
      if (!connected(platform)) warn(path, platform === 'slack' ? `a rule sends ${p} to it, but hydra.toml declares no Slack app: add [slack.apps.<id>], or it won't hear it` : `a rule sends ${p} to it, but [${platform === 'discord' ? 'gateways' : 'connectors'}.${platform}] isn't set, so it won't hear it`)
      else if (platform === 'github' && !connectors.github!.repos.includes(p.slice('github:'.length))) warn(path, `a rule sends ${p} to it, but connectors.github.repos doesn't include it`)
    }
  }

  if (errors.length) return { ok: false, errors, warnings }
  return { ok: true, config: { ...(operator && { operator }), ...(main && { main }), connectors, gateways, slackApps, people, specialists, places, schedules, rules, ...(Object.keys(mcpServers).length && { mcpServers }), ...(offLimits.length && { offLimits }), ...(allowUnprovenMacos && { allowUnprovenMacos }), ...(guard && { guard }), ...(vitals && { vitals }) }, warnings }
}

/** The program a `sh -c` command runs: past any leading VAR=value, with one level of quotes removed. */
function shellProgram(command: string): string {
  const words = command.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  const first = words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''
  return /^(['"]).*\1$/.test(first) ? first.slice(1, -1) : first
}

const join2 = (path: string, key: string) => path ? `${path}.${key}` : key

/** `slack:U0TEST`, `discord:123`, `github:Alice` → canonical form (GitHub logins lowercased), or undefined. */
export function normalizeAddress(raw: string): Address | undefined {
  const platform = raw.split(':')[0] as Platform
  if (!Object.hasOwn(ADDRESS_RE, platform)) return undefined
  const a = platform === 'github' ? raw.toLowerCase() : raw
  return ADDRESS_RE[platform].test(a) ? a as Address : undefined
}

/** A place in canonical form (GitHub repos lowercased), or undefined. */
export function normalizePlace(raw: string): Place | undefined {
  if (raw === 'cli' || CHANNEL_PLACE_RE.test(raw)) return raw
  if (raw.startsWith('github:') && REPO_RE.test(raw.slice(7).toLowerCase())) return raw.toLowerCase()
  return undefined
}

function fillId(v: unknown, id: string): unknown {
  if (typeof v === 'string') return v.replaceAll('{id}', id)
  if (Array.isArray(v)) return v.map(x => fillId(x, id))
  return v
}

/** `1500ms`, `90s`, `5m`, `2h`, `1d` → ms; null when malformed or zero. */
function parseDurationMs(s: string): number | null {
  const m = s.trim().match(/^(\d+)(ms|s|m|h|d)$/)
  if (!m) return null
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']
  const ms = parseInt(m[1], 10) * unit
  return ms > 0 ? ms : null
}

function formatMs(ms: number): string {
  return ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`
}
