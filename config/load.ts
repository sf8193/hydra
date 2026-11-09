// Loads `<state>/hydra.toml`: parse, fill defaults, check. Pure but for `env`, so the same text and machine give the same answer.
// Strict: an unknown key, a malformed address or place, or a reference to nothing is an error, and any error rejects the whole file.

import { statSync, accessSync, constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { parseCron } from '../shared/cron-local.js'
import { parseIdleTtl } from '../shared/constants.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import {
  BUILTIN_ROLES, type Address, type ConfigIssue, type Connectors, type Guard, type HydraConfig, type LoadEnv, type LoadResult,
  type Person, type Place, type PlaceOptions, type Platform, type Rule, type Schedule, type SessionsMode, type Specialist,
} from './types.js'

export const EMPTY_CONFIG: HydraConfig = Object.freeze({ connectors: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] }) as HydraConfig

/** People, roles and schedules: lowercase letters, digits and dashes. Specialists add their own rule (shared/specialist-name.ts). */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const ADDRESS_RE: Record<Platform, RegExp> = {
  discord: /^discord:\d+$/,
  slack: /^slack:[UW][A-Z0-9]+$/,
  github: /^github:[a-z0-9](?:[a-z0-9-]{0,38})$/,
}
const REPO_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/
// A channel by name or by the platform's own id (an app without the scopes to list channels only knows ids).
const CHANNEL_PLACE_RE = /^(slack|discord):(dm|#[a-z0-9][a-z0-9_-]*)$|^slack:[CG][A-Z0-9]+$|^discord:\d+$/
const SESSIONS: readonly SessionsMode[] = ['shared', 'per-conversation']
const ENGINES = ['claude', 'codex', 'omp'] as const
const MAX_DAY_MS = 86_400_000
const GUARD_TIMEOUT_MAX_MS = 30_000 // deliveries for a conversation wait on the guard
const BUILTIN: readonly string[] = BUILTIN_ROLES

const TOP_KEYS = ['operator', 'connectors', 'people', 'specialists', 'defaults', 'places', 'schedules', 'rules', 'guard']
const SPECIALIST_KEYS = ['workdir', 'prompt', 'prompt_file', 'listens', 'allow', 'sessions', 'max', 'idle', 'home', 'model', 'engine', 'env_file', 'was']

type Table = Record<string, unknown>
/** Own keys only: a name like `constructor` must not resolve through the prototype. */
const has = (t: object, k: string) => Object.hasOwn(t, k)
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/** The machine as it is: `~` is this user's home, folders and commands are looked up for real. */
export function systemEnv(sessionNames: readonly string[]): LoadEnv {
  return {
    home: homedir(),
    sessionNames,
    isDir: path => { try { return statSync(path).isDirectory() } catch { return false } },
    isCommand: command => {
      if (!command.includes('/')) return Bun.which(command) !== null
      try { accessSync(command, fsConstants.X_OK); return statSync(command).isFile() } catch { return false }
    },
  }
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
    if (p) return p
    error(path, `"${raw}" is not a place: use slack:#channel, slack:<channel id>, slack:dm, discord:#channel, discord:<channel id>, discord:dm, github:owner/repo or cli`)
    return undefined
  }

  unknownKeys(doc, TOP_KEYS, '')

  // --- connectors ----------------------------------------------------------------------------------------------------

  const connectors: Connectors = {}
  const conns = table(doc.connectors, 'connectors') ?? {}
  for (const [platform, raw] of Object.entries(conns)) {
    const path = `connectors.${platform}`
    const t = table(raw, path)
    if (!t) continue
    const envName = (k: string, required: boolean): string | undefined => {
      const v = str(t, k, path)
      if (v === undefined) { if (required) error(join2(path, k), 'is required'); return undefined }
      if (ENV_NAME_RE.test(v)) return v
      error(join2(path, k), `"${v}" must name an environment variable, like DISCORD_BOT_TOKEN`)
      return undefined
    }
    if (platform === 'discord') {
      unknownKeys(t, ['bot_token_env'], path)
      const botTokenEnv = envName('bot_token_env', true)
      if (botTokenEnv) connectors.discord = { botTokenEnv }
    } else if (platform === 'slack') {
      unknownKeys(t, ['bot_token_env', 'app_token_env'], path)
      const botTokenEnv = envName('bot_token_env', true)
      const appTokenEnv = envName('app_token_env', false)
      if (botTokenEnv) connectors.slack = { botTokenEnv, ...(appTokenEnv && { appTokenEnv }) }
    } else if (platform === 'github') {
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
    } else {
      error(path, `unknown platform "${platform}": use discord, slack or github`)
    }
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
    unknownKeys(t, ['ids', 'roles', 'name'], path)
    const ids = strList(t, 'ids', path)
    if (t.ids === undefined || ids?.length === 0) error(`${path}.ids`, 'is required: at least one address, like "slack:U0TEST" or "github:alice"')
    const addresses: Address[] = []
    for (const [i, raw] of (ids ?? []).entries()) {
      const a = normalizeAddress(raw)
      if (!a) { error(`${path}.ids[${i}]`, `"${raw}" is not an address: use discord:<user id>, slack:<user id> or github:<login>`); continue }
      const other = owner.get(a)
      if (other && other !== id) error(`${path}.ids[${i}]`, `${a} already belongs to ${other}: one address, one person`)
      owner.set(a, id)
      addresses.push(a)
    }
    const roles = strList(t, 'roles', path) ?? []
    for (const [i, r] of roles.entries()) {
      if (BUILTIN.includes(r)) error(`${path}.roles[${i}]`, `"${r}" is built in: ${r === 'people' ? 'everyone on the roster' : 'anyone at all'} holds it already`)
      else if (!ID_RE.test(r)) error(`${path}.roles[${i}]`, `role "${r}" must be lowercase letters, digits and dashes`)
    }
    people[id] = { id, ids: addresses, roles, name: str(t, 'name', path) ?? id }
  }
  const declaredRoles = new Set(Object.values(people).flatMap(p => p.roles))
  // A role named like a person would make a rule's `from` ambiguous.
  for (const role of declaredRoles) if (has(people, role)) error(`people.${role}`, `"${role}" is both a person and a role; rename one`)
  const isRole = (r: string) => BUILTIN.includes(r) || declaredRoles.has(r)

  // --- operator ------------------------------------------------------------------------------------------------------

  let operator: string | undefined
  if (doc.operator !== undefined) {
    if (typeof doc.operator !== 'string') error('operator', 'must be a quoted person id')
    else if (!has(people, doc.operator)) error('operator', `"${doc.operator}" is not a person: declare [people.${doc.operator}]`)
    else operator = doc.operator
  } else if (Object.keys(doc).some(k => k !== 'operator')) {
    error('operator', 'is required: name the person whose DMs reach main and who may reach every specialist')
  }

  // --- specialists, with [defaults.specialist] -----------------------------------------------------------------------

  const defaultsTable = table(doc.defaults, 'defaults') ?? {}
  unknownKeys(defaultsTable, ['specialist'], 'defaults')
  const defaults = table(defaultsTable.specialist, 'defaults.specialist') ?? {}
  unknownKeys(defaults, SPECIALIST_KEYS, 'defaults.specialist')
  if (defaults.workdir !== undefined && typeof defaults.workdir === 'string' && !defaults.workdir.includes('{id}')) {
    warn('defaults.specialist.workdir', 'has no {id}, so every specialist without its own workdir shares one folder')
  }
  if (defaults.prompt !== undefined && defaults.prompt_file !== undefined) error('defaults.specialist', 'set prompt or prompt_file, not both')
  // Defaults are type-checked once, here, so a bad default is reported once, not once per specialist.
  const goodDefaults: Table = {}
  for (const k of Object.keys(defaults)) {
    if (!SPECIALIST_KEYS.includes(k)) continue
    const n = errors.length
    readSpecialistKeyTypes({ [k]: defaults[k] }, 'defaults.specialist')
    if (errors.length === n && k === 'idle') checkIdle(defaults.idle as string, 'defaults.specialist.idle')
    if (errors.length === n && k === 'allow') checkAllow(defaults.allow as string[], 'defaults.specialist.allow')
    if (errors.length === n) goodDefaults[k] = defaults[k]
  }

  function checkIdle(raw: string, path: string): number | undefined {
    const ms = parseIdleTtl(raw)
    if (ms === null) error(path, `"${raw}" must be a duration like 90m, 12h or 4d, at most 7d`)
    return ms ?? undefined
  }
  function checkAllow(allow: string[], path: string) {
    for (const [i, r] of allow.entries()) {
      if (isRole(r)) continue
      error(`${path}[${i}]`, has(people, r) ? `"${r}" is a person, not a role: give them a role and allow that` : `no one holds the role "${r}"`)
    }
  }

  function readSpecialistKeyTypes(t: Table, path: string) {
    str(t, 'workdir', path); str(t, 'prompt', path); str(t, 'prompt_file', path); strList(t, 'listens', path); strList(t, 'allow', path)
    oneOf(t, 'sessions', path, SESSIONS); positiveInt(t, 'max', path); str(t, 'idle', path); str(t, 'home', path); str(t, 'model', path)
    oneOf(t, 'engine', path, ENGINES); str(t, 'env_file', path); strList(t, 'was', path)
  }
  function positiveInt(t: Table, k: string, path: string): number | undefined {
    const v = t[k]
    if (v === undefined) return undefined
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
    error(join2(path, k), 'must be a whole number above 0')
    return undefined
  }

  const specialists: Record<string, Specialist> = {}
  const listener = new Map<Place, string>()
  const formerly = new Map<string, string>()
  const specialistTables = table(doc.specialists, 'specialists') ?? {}
  for (const [id, raw] of Object.entries(specialistTables)) {
    const path = `specialists.${id}`
    const why = invalidSpecialistName(id, env.sessionNames)
    if (why) error(path, why)
    const own = table(raw, path)
    if (!own) continue
    unknownKeys(own, SPECIALIST_KEYS, path)
    if (own.prompt !== undefined && own.prompt_file !== undefined) error(path, 'set prompt or prompt_file, not both')
    // Its own keys win; its own prompt or prompt_file replaces both defaults.
    const inherited = Object.fromEntries(Object.entries(goodDefaults)
      .filter(([k]) => !((k === 'prompt' || k === 'prompt_file') && (own.prompt !== undefined || own.prompt_file !== undefined)))
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
    }
    const prompt = str(t, 'prompt', path)
    const promptFileRaw = str(t, 'prompt_file', path)
    const underWorkdir = (p: string) => isAbsolute(expand(p)) ? expand(p) : join(workdir, p)
    const promptFile = promptFileRaw === undefined ? undefined : underWorkdir(promptFileRaw)

    const listens: Place[] = []
    for (const [i, rawPlace] of (strList(t, 'listens', path) ?? []).entries()) {
      const p = place(rawPlace, `${at('listens')}[${i}]`)
      if (!p) continue
      const other = listener.get(p)
      if (other === id) continue
      if (other) error(`${at('listens')}[${i}]`, `${other} already listens on ${p}: one place, one specialist`)
      else listener.set(p, id)
      listens.push(p)
    }

    const allow = strList(t, 'allow', path) ?? ['people']
    if (has(own, 'allow')) checkAllow(allow, `${path}.allow`)

    const idleRaw = str(t, 'idle', path)
    // An inherited idle was checked once, at the default.
    const idleMs = idleRaw === undefined ? undefined : has(own, 'idle') ? checkIdle(idleRaw, `${path}.idle`) : parseIdleTtl(idleRaw) ?? undefined

    const was = strList(t, 'was', path) ?? []
    for (const [i, old] of was.entries()) {
      const bad = invalidSpecialistName(old, env.sessionNames)
      if (bad) { error(`${at('was')}[${i}]`, bad); continue }
      if (has(specialistTables, old)) error(`${at('was')}[${i}]`, `"${old}" is a current specialist; an old id can't be in use`)
      else if (formerly.has(old) && formerly.get(old) !== id) error(`${at('was')}[${i}]`, `"${old}" is already an old id of ${formerly.get(old)}`)
      else formerly.set(old, id)
    }

    const envFile = str(t, 'env_file', path)
    const home = str(t, 'home', path)
    // A place, or a thread or channel by its platform id.
    if (home !== undefined && !normalizePlace(home) && !/^\d+$/.test(home)) error(at('home'), `"${home}" must be a place (slack:#channel, discord:#channel, …) or a thread id`)
    const model = str(t, 'model', path)
    const engine = oneOf(t, 'engine', path, ENGINES)
    specialists[id] = {
      id, workdir, listens, allow,
      sessions: oneOf(t, 'sessions', path, SESSIONS) ?? 'shared',
      max: positiveInt(t, 'max', path) ?? 20,
      was,
      ...(prompt !== undefined && { prompt }),
      ...(promptFile !== undefined && { promptFile }),
      ...(idleMs !== undefined && { idleMs }),
      ...(home !== undefined && { home: normalizePlace(home) ?? home }),
      ...(model !== undefined && { model }),
      ...(engine !== undefined && { engine }),
      ...(envFile !== undefined && { envFile: underWorkdir(envFile) }),
    }
  }
  // `main` is the built-in specialist: a valid target, never declared, never in `listens`.
  const isTarget = (id: string) => id === 'main' || has(specialists, id)

  // --- places --------------------------------------------------------------------------------------------------------

  const places: Record<Place, PlaceOptions> = {}
  for (const [rawPlace, raw] of Object.entries(table(doc.places, 'places') ?? {})) {
    const path = `places."${rawPlace}"`
    const p = place(rawPlace, path)
    const t = table(raw, path)
    if (!p || !t) continue
    if (has(places, p)) { error(path, `${p} is already set: places compare without case on GitHub`); continue }
    unknownKeys(t, ['ack', 'files', 'listen', 'bots'], path)
    const ack = str(t, 'ack', path)
    places[p] = {
      ...(ack !== undefined && { ack }),
      files: bool(t, 'files', path) ?? false,
      listen: oneOf(t, 'listen', path, ['mentions', 'all'] as const) ?? 'mentions',
      bots: bool(t, 'bots', path) ?? false,
    }
  }

  // --- schedules (checked now, run by a later step) ------------------------------------------------------------------

  const schedules: Record<string, Schedule> = {}
  for (const [id, raw] of Object.entries(table(doc.schedules, 'schedules') ?? {})) {
    const path = `schedules.${id}`
    if (!ID_RE.test(id)) error(path, 'a schedule\'s id must be lowercase letters, digits and dashes')
    const t = table(raw, path)
    if (!t) continue
    unknownKeys(t, ['cron', 'to', 'prompt', 'check', 'cwd', 'env_file', 'runner'], path)
    const cron = str(t, 'cron', path)
    if (t.cron === undefined) error(`${path}.cron`, 'is required: 5 fields, local time')
    else if (cron !== undefined) {
      try { parseCron(cron) } catch (e) { error(`${path}.cron`, (e as Error).message) }
    }
    const to = str(t, 'to', path)
    if (t.to === undefined) error(`${path}.to`, 'is required: a specialist, or main')
    else if (to !== undefined && !isTarget(to)) error(`${path}.to`, `no specialist "${to}"`)
    const prompt = t.prompt === '' ? '' : str(t, 'prompt', path) ?? ''
    const check = str(t, 'check', path)
    const cwdRaw = str(t, 'cwd', path)
    const cwd = cwdRaw === undefined ? undefined : expand(cwdRaw)
    if (cwd !== undefined && !isAbsolute(cwd)) error(`${path}.cwd`, `"${cwdRaw}" must be an absolute path or start with ~`)
    // Relative to the schedule's cwd, as prompt_file and env_file are to a specialist's workdir.
    const envFileRaw = str(t, 'env_file', path)
    const envFile = envFileRaw === undefined ? undefined : isAbsolute(expand(envFileRaw)) ? expand(envFileRaw) : cwd && isAbsolute(cwd) ? join(cwd, envFileRaw) : undefined
    if (envFileRaw !== undefined && envFile === undefined) error(`${path}.env_file`, `"${envFileRaw}" is relative, so it needs an absolute cwd`)
    schedules[id] = {
      id, cron: cron ?? '', to: to ?? '', prompt,
      runner: oneOf(t, 'runner', path, ['launchd', 'daemon'] as const) ?? 'launchd',
      ...(check !== undefined && { check }),
      ...(cwd !== undefined && { cwd }),
      ...(envFile !== undefined && { envFile }),
    }
  }

  // --- rules (checked now, applied by a later step) ------------------------------------------------------------------

  const rules: Rule[] = []
  if (doc.rules !== undefined && !(Array.isArray(doc.rules) && doc.rules.every(isTable))) error('rules', 'must be [[rules]] tables')
  else for (const [i, t] of ((doc.rules ?? []) as Table[]).entries()) {
    const path = `rules[${i}]`
    unknownKeys(t, ['at', 'from', 'to'], path)
    const atRaw = str(t, 'at', path)
    if (t.at === undefined) error(`${path}.at`, 'is required: a rule refines a place, never takes one over')
    const at = atRaw === undefined ? undefined : place(atRaw, `${path}.at`)
    const from = str(t, 'from', path)
    if (from !== undefined && !has(people, from) && !isRole(from)) error(`${path}.from`, `"${from}" is neither a person nor a role anyone holds`)
    const to = str(t, 'to', path)
    if (t.to === undefined) error(`${path}.to`, 'is required: a specialist, or main')
    else if (to !== undefined && !isTarget(to)) error(`${path}.to`, `no specialist "${to}"`)
    if (at && to) rules.push({ at, to, ...(from !== undefined && { from }) })
  }
  // A rule never matches when an earlier one at the same place takes every sender it would: who `later` names is a
  // subset of who `earlier` names. Absent and `anyone` include strangers; `people` is the roster; a role, its holders.
  const senders = (from: string | undefined): Set<string> | 'everyone' => {
    if (from === undefined || from === 'anyone') return 'everyone'
    if (from === 'people') return new Set(Object.keys(people))
    if (has(people, from)) return new Set([from])
    return new Set(Object.values(people).filter(p => p.roles.includes(from)).map(p => p.id))
  }
  const covers = (earlier: string | undefined, later: string | undefined): boolean => {
    const e = senders(earlier), l = senders(later)
    if (e === 'everyone') return true
    if (l === 'everyone') return false
    return [...l].every(id => e.has(id))
  }
  for (const [j, later] of rules.entries()) {
    const i = rules.findIndex((earlier, k) => k < j && earlier.at === later.at && covers(earlier.from, later.from))
    if (i >= 0) warn(`rules[${j}]`, `never matches: rules[${i}] already takes ${later.from ? `${later.from}'s messages` : 'every message'} at ${later.at}`)
  }
  // A rule for everyone at a place is checked before `listens`, so the place's listener never hears it there.
  for (const [i, r] of rules.entries()) {
    const heard = listener.get(r.at)
    if (senders(r.from) === 'everyone' && heard && heard !== r.to) warn(`rules[${i}]`, `takes every message at ${r.at}, so ${heard}, which listens there, never hears it`)
  }

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

  // --- warnings that need the whole file -----------------------------------------------------------------------------

  const ruleTargets = new Set(rules.map(r => r.to))
  const scheduleTargets = new Set(Object.values(schedules).map(s => s.to))
  for (const s of Object.values(specialists)) {
    const path = `specialists.${s.id}`
    if (s.listens.length === 0 && !ruleTargets.has(s.id) && !scheduleTargets.has(s.id)) {
      warn(path, 'nobody can reach it: it listens nowhere, and no rule or schedule sends to it')
    }
    if (s.sessions === 'shared') {
      if (s.listens.length >= 2) warn(path, `one shared session hears ${s.listens.join(', ')}, so what's said in one place is remembered in the others; use sessions = "per-conversation" or one specialist per place`)
      else if (s.listens.some(p => p.endsWith(':dm')) && s.allow.length > 0) warn(path, `one shared session hears everyone's DMs (allow = ${JSON.stringify(s.allow)}), so one person's DM is remembered in another's; use sessions = "per-conversation" or allow = []`)
    }
    for (const p of s.listens) {
      const platform = p.split(':')[0] as Platform | 'cli'
      if (platform === 'cli') continue
      if (!connectors[platform]) warn(path, `listens on ${p}, but [connectors.${platform}] isn't set, so it won't hear it`)
      else if (platform === 'github' && !connectors.github!.repos.includes(p.slice('github:'.length))) warn(path, `listens on ${p}, but connectors.github.repos doesn't include it`)
    }
  }

  if (errors.length) return { ok: false, errors, warnings }
  return { ok: true, config: { ...(operator && { operator }), connectors, people, specialists, places, schedules, rules, ...(guard && { guard }) }, warnings }
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
  if (!(platform in ADDRESS_RE)) return undefined
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
