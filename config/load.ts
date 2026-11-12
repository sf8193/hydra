// Loads `<state>/hydra.toml`: parse, fill defaults, check. Pure but for `env`, so the same text and machine give the same answer.
// Strict: an unknown key, a malformed address or place, or a reference to nothing is an error, and any error rejects the whole file.

import { statSync, accessSync, constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { parseCron } from '../shared/cron-local.js'
import { parseIdleTtl } from '../shared/constants.js'
import { ENV_NAME_RE, tokenVarRefusal } from '../shared/spawn-env.js'
import { noSuchApp, pinnersOf, serves, whyNotServed } from './pins.js'
import { SLACK_APP_DEFAULTS } from '../connectors/slack/app.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import {
  BUILTIN_ROLES, DEFAULT_SLACK_APP, type Address, type ConfigIssue, type Connectors, type Guard, type HydraConfig, type LoadEnv, type LoadResult,
  type Person, type Place, type PlaceOptions, type Platform, type Rule, type Schedule, type SessionsMode, type SlackApp, type Specialist, type Vitals,
} from './types.js'

export const VITALS_DEFAULTS: Vitals = Object.freeze({
  overloadLoadPerCore: 1.5, overloadIdlePct: 15, swapUsedPct: 85, ticks: 3, resumeSettleMs: 20 * 60_000, memoryCooldownMs: 24 * 3_600_000,
})

export const EMPTY_CONFIG: HydraConfig = Object.freeze({ connectors: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] }) as HydraConfig

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
const CHANNEL_PLACE_RE = /^(slack|discord):(dm|#[a-z0-9][a-z0-9_-]*)$|^slack:[CG][A-Z0-9]+$|^discord:\d+$/
const SESSIONS: readonly SessionsMode[] = ['shared', 'per-conversation']
const ENGINES = ['claude', 'codex', 'omp'] as const
const MAX_DAY_MS = 86_400_000
const GUARD_TIMEOUT_MAX_MS = 30_000 // deliveries for a conversation wait on the guard
const MAX_ALERT_AFTER_MS = 30 * MAX_DAY_MS
const BUILTIN: readonly string[] = BUILTIN_ROLES

const TOP_KEYS = ['operator', 'connectors', 'slack', 'people', 'specialists', 'defaults', 'places', 'schedules', 'rules', 'guard', 'vitals']
const SPECIALIST_KEYS = ['workdir', 'prompt', 'prompt_file', 'listens', 'apps', 'allow', 'sessions', 'max', 'idle', 'home', 'model', 'engine', 'env_file', 'was']

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

  // --- connectors and Slack apps -------------------------------------------------------------------------------------

  const connectors: Connectors = {}
  // Which key holds each token variable: a variable on two keys (two apps, or a Slack app and Discord) is a bug.
  const envOwner = new Map<string, string>()
  const claimEnv = (v: string, path: string): boolean => {
    const other = envOwner.get(v)
    if (other) { error(path, `"${v}" is already the token variable of ${other}: each token needs its own variable`); return false }
    envOwner.set(v, path)
    return true
  }
  const conns = table(doc.connectors, 'connectors') ?? {}
  for (const [platform, raw] of Object.entries(conns)) {
    if (platform === 'slack') continue   // with [slack.apps], below
    const path = `connectors.${platform}`
    const t = table(raw, path)
    if (!t) continue
    const envName = (k: string, required: boolean): string | undefined => {
      const v = str(t, k, path)
      if (v === undefined) { if (required) error(join2(path, k), 'is required'); return undefined }
      if (!ENV_NAME_RE.test(v)) { error(join2(path, k), `"${v}" must name an environment variable, like DISCORD_BOT_TOKEN`); return undefined }
      return claimEnv(v, join2(path, k)) ? v : undefined
    }
    if (platform === 'discord') {
      unknownKeys(t, ['bot_token_env'], path)
      const botTokenEnv = envName('bot_token_env', true)
      if (botTokenEnv) connectors.discord = { botTokenEnv }
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

  // Slack: any number of apps, `[slack.apps.<id>]`. `[connectors.slack]` is the app `default`, so it can't be declared twice.
  // No prototype: an id like `constructor` is a valid name.
  const slackApps: Record<string, SlackApp> = Object.create(null)
  /** One Slack app from its table. Only `[connectors.slack]` spells the display name `app_name` and the description `app_description`. */
  const slackApp = (id: string, t: Table, path: string, keys = { displayName: 'display_name', description: 'description' }): SlackApp | undefined => {
    unknownKeys(t, ['bot_token_env', 'app_token_env', 'user_token_env', keys.displayName, keys.description], path)
    const envName = (k: string, required: boolean): string | undefined => {
      const v = str(t, k, path)
      if (v === undefined) { if (required) error(join2(path, k), 'is required'); return undefined }
      if (!ENV_NAME_RE.test(v)) { error(join2(path, k), `"${v}" must name an environment variable, like SLACK_BOT_TOKEN`); return undefined }
      const why = tokenVarRefusal(v)
      if (why) { error(join2(path, k), `"${v}" ${why}, so it cannot hold a token; name one only the daemon needs, like SLACK_BOT_TOKEN`); return undefined }
      return claimEnv(v, join2(path, k)) ? v : undefined
    }
    const botTokenEnv = envName('bot_token_env', true)
    const appTokenEnv = envName('app_token_env', false)
    const userTokenEnv = envName('user_token_env', false)
    // Slack's own limits for an app's name and description: past them, creating the app from the manifest fails.
    const capped = (k: string, max: number): string | undefined => {
      const v = str(t, k, path)
      const n = v === undefined ? 0 : [...v].length   // characters, not UTF-16 units: an emoji is one
      if (v === undefined || n <= max) return v
      error(join2(path, k), `is ${n} characters; Slack allows at most ${max}`)
      return undefined
    }
    const displayName = capped(keys.displayName, 35) ?? (id === DEFAULT_SLACK_APP ? SLACK_APP_DEFAULTS.name : id)
    const description = capped(keys.description, 140) ?? SLACK_APP_DEFAULTS.description + (userTokenEnv ? SLACK_APP_DEFAULTS.userTokenNote : '')
    if (!botTokenEnv) return undefined
    return { id, botTokenEnv, ...(appTokenEnv && { appTokenEnv }), ...(userTokenEnv && { userTokenEnv }), displayName, description }
  }
  const connectorsSlack = table(conns.slack, 'connectors.slack')
  if (connectorsSlack) {
    const app = slackApp(DEFAULT_SLACK_APP, connectorsSlack, 'connectors.slack', { displayName: 'app_name', description: 'app_description' })
    if (app) slackApps[DEFAULT_SLACK_APP] = app
  }
  const slackTable = table(doc.slack, 'slack') ?? {}
  unknownKeys(slackTable, ['apps'], 'slack')
  for (const [id, raw] of Object.entries(table(slackTable.apps, 'slack.apps') ?? {})) {
    const path = `slack.apps.${id}`
    if (!SLACK_APP_ID_RE.test(id)) { error(path, `"${id}" is not a valid app name: lowercase letters, digits, "-" and "_", starting with a letter, at most 35 characters`); continue }
    const t = table(raw, path)
    if (!t) continue
    if (id === DEFAULT_SLACK_APP && has(conns, 'slack')) { error(path, 'is the same app as [connectors.slack]: declare it once, in either table'); continue }
    const app = slackApp(id, t, path)
    if (app) slackApps[id] = app
  }
  if (Object.keys(slackApps).length && !Object.hasOwn(slackApps, DEFAULT_SLACK_APP)) {
    warn('slack.apps', `no app is named "${DEFAULT_SLACK_APP}", and Slack connects only the app named "${DEFAULT_SLACK_APP}", so Slack stays off. Name the app to connect "${DEFAULT_SLACK_APP}".`)
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
    str(t, 'workdir', path); str(t, 'prompt', path); str(t, 'prompt_file', path); strList(t, 'listens', path); strList(t, 'apps', path); strList(t, 'allow', path)
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
  /** Who listens on each place, with the apps they are pinned to (undefined: unpinned). */
  const listener = new Map<Place, { id: string; apps?: string[] }[]>()
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
      // Its sessions run there, where today's spawns run too (SPAWN_CWD), but hydra won't mark a whole home folder trusted.
      else if (resolve(workdir) === resolve(env.home) || resolve(workdir) === '/') warn(at('workdir'), `${workdir} is ${resolve(workdir) === '/' ? 'the whole disk' : 'your whole home folder'}: its sessions can read everything there, and hydra won't pre-approve Claude's trust for it; give the specialist a folder of its own`)
    }
    const prompt = str(t, 'prompt', path)
    const promptFileRaw = str(t, 'prompt_file', path)
    const underWorkdir = (p: string) => isAbsolute(expand(p)) ? expand(p) : join(workdir, p)
    const promptFile = promptFileRaw === undefined ? undefined : underWorkdir(promptFileRaw)

    // `apps` pins it: it takes only messages that come through those Slack apps, and those apps deliver only to specialists pinned to them. Absent: unpinned.
    let apps: string[] | undefined
    const appsRaw = strList(t, 'apps', path)
    if (appsRaw !== undefined) {
      if (appsRaw.length === 0) error(at('apps'), 'must name at least one app; leave `apps` out to take every app that no specialist is pinned to')
      for (const [i, a] of appsRaw.entries()) {
        if (!Object.hasOwn(slackApps, a)) error(`${at('apps')}[${i}]`, noSuchApp(a, Object.keys(slackApps)))
      }
      if (appsRaw.length) apps = [...new Set(appsRaw)]
    }

    const listens: Place[] = []
    for (const [i, rawPlace] of (strList(t, 'listens', path) ?? []).entries()) {
      const p = place(rawPlace, `${at('listens')}[${i}]`)
      if (!p) continue
      if (apps && !p.startsWith('slack:')) error(`${at('listens')}[${i}]`, `${p} is not a Slack place, and \`apps\` pins this specialist to Slack apps: remove \`apps\`, or listen on a \`slack:\` place`)
      const here = listener.get(p) ?? []
      if (here.some(o => o.id === id)) continue
      // An unpinned specialist takes only apps nobody is pinned to, so a pinned one and an unpinned one never share an app.
      const mine = apps
      const bothUnpinned = (o: { apps?: string[] }) => !o.apps && !mine
      const shareAnApp = (o: { apps?: string[] }) => !!o.apps && !!mine && o.apps.some(a => mine.includes(a))
      const clash = here.find(o => bothUnpinned(o) || shareAnApp(o))
      if (clash) {
        const via = clash.apps && apps ? `app ${apps.filter(a => clash.apps!.includes(a)).join(', ')}` : 'every app nobody is pinned to'
        error(`${at('listens')}[${i}]`, `${clash.id} already listens on ${p}, and ${via} reaches both: two specialists may share a place only when no app reaches both: give one \`apps\` the other lacks, or pin only one of them`)
      } else listener.set(p, [...here, { id, ...(apps && { apps }) }])
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
    // A place, or a channel by its platform id: where its threads open.
    if (home !== undefined && !normalizePlace(home) && !/^\d+$/.test(home)) error(at('home'), `"${home}" must be a place (slack:#channel, discord:#channel, …) or a channel id`)
    const model = str(t, 'model', path)
    const engine = oneOf(t, 'engine', path, ENGINES)
    specialists[id] = {
      id, workdir, listens, allow,
      ...(apps && { apps }),
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
    unknownKeys(t, ['ack', 'files', 'listen', 'bots', 'default_app'], path)
    const ack = str(t, 'ack', path)
    // Which app answers an unmentioned message when several apps are in this channel.
    const defaultApp = str(t, 'default_app', path)
    if (defaultApp !== undefined) {
      if (!p.startsWith('slack:') || p === 'slack:dm') error(`${path}.default_app`, `${p} is not a Slack channel: \`default_app\` picks among the apps in a channel`)
      else if (!Object.hasOwn(slackApps, defaultApp)) error(`${path}.default_app`, noSuchApp(defaultApp, Object.keys(slackApps)))
    }
    places[p] = {
      ...(ack !== undefined && { ack }),
      ...(defaultApp !== undefined && Object.hasOwn(slackApps, defaultApp) && { defaultApp }),
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
    unknownKeys(t, ['cron', 'to', 'prompt', 'check', 'cwd', 'env_file', 'runner', 'needs', 'alert_after'], path)
    const cron = str(t, 'cron', path)
    if (t.cron === undefined) error(`${path}.cron`, 'is required: 5 fields, local time')
    else if (cron !== undefined) {
      try { parseCron(cron) } catch (e) { error(`${path}.cron`, (e as Error).message) }
    }
    const to = str(t, 'to', path)
    if (to !== undefined && !isTarget(to)) error(`${path}.to`, `no specialist "${to}"`)
    const prompt = t.prompt === '' ? '' : str(t, 'prompt', path) ?? ''
    const check = str(t, 'check', path)
    // No `to`: a sensor. It sends nothing, so it needs a check and takes no prompt.
    if (t.to === undefined && check === undefined) error(`${path}.to`, 'is required unless there is a check (a sensor): a specialist, or main')
    if (t.to === undefined && prompt !== '') error(`${path}.prompt`, 'a schedule with no to sends nothing, so it takes no prompt')
    const cwdRaw = str(t, 'cwd', path)
    const cwd = cwdRaw === undefined ? undefined : expand(cwdRaw)
    if (cwd !== undefined && !isAbsolute(cwd)) error(`${path}.cwd`, `"${cwdRaw}" must be an absolute path or start with ~`)
    // Relative to the schedule's cwd, as prompt_file and env_file are to a specialist's workdir.
    const envFileRaw = str(t, 'env_file', path)
    const envFile = envFileRaw === undefined ? undefined : isAbsolute(expand(envFileRaw)) ? expand(envFileRaw) : cwd && isAbsolute(cwd) ? join(cwd, envFileRaw) : undefined
    if (envFileRaw !== undefined && envFile === undefined) error(`${path}.env_file`, `"${envFileRaw}" is relative, so it needs an absolute cwd`)
    const runner = oneOf(t, 'runner', path, ['launchd', 'daemon'] as const) ?? 'launchd'
    // A daemon schedule is retried until done; launchd fires once. needs and alert_after only mean something retried.
    const needs = strList(t, 'needs', path)
    for (const [i, n] of (needs ?? []).entries()) if (n !== 'internet') error(`${path}.needs[${i}]`, `unknown precondition "${n}" (known: internet)`)
    const alertAfterMs = duration(t, 'alert_after', path, MAX_ALERT_AFTER_MS)
    for (const k of ['needs', 'alert_after']) if (t[k] !== undefined && runner !== 'daemon') error(`${path}.${k}`, 'needs runner = "daemon"')
    schedules[id] = {
      id, cron: cron ?? '', prompt, runner,
      ...(to !== undefined && { to }),
      ...(needs?.length && { needs: [...new Set(needs)] as 'internet'[] }),
      ...(alertAfterMs !== undefined && { alertAfterMs }),
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
    unknownKeys(t, ['at', 'app', 'from', 'to'], path)
    const atRaw = str(t, 'at', path)
    const appRaw = str(t, 'app', path)
    if (t.at === undefined && t.app === undefined) error(path, 'a rule needs `at`, `app` or both; `from` only narrows who it applies to')
    const at = atRaw === undefined ? undefined : place(atRaw, `${path}.at`)
    let app: string | undefined
    if (appRaw !== undefined) {
      if (!Object.hasOwn(slackApps, appRaw)) error(`${path}.app`, noSuchApp(appRaw, Object.keys(slackApps)))
      else app = appRaw
      if (at && !at.startsWith('slack:')) error(`${path}.app`, `an app is a Slack app, but ${at} is not a Slack place: set \`at\` to a \`slack:\` place, remove \`at\`, or remove \`app\``)
    }
    const from = str(t, 'from', path)
    if (from !== undefined && !has(people, from) && !isRole(from)) error(`${path}.from`, `"${from}" is neither a person nor a role anyone holds`)
    const to = str(t, 'to', path)
    if (t.to === undefined) error(`${path}.to`, 'is required: a specialist, or main')
    else if (to !== undefined && !isTarget(to)) error(`${path}.to`, `no specialist "${to}"`)
    // Whether `to` can ever take what the rule matches: a pinned specialist only through its apps, and an app that any specialist is pinned to delivers only to them.
    const target = to !== undefined ? specialists[to] : undefined
    if (target && to !== undefined) {
      const pin = `add ${app} to ${to}'s \`apps\`, or change the rule's \`app\``
      if (app && target.apps && !target.apps.includes(app)) error(`${path}.to`, `${to} is pinned to ${target.apps.join(', ')}, so app ${app} can never deliver to it: ${pin}`)
      else if (app && !target.apps && pinnersOf(specialists, app).length) error(`${path}.to`, `app ${app} serves only specialists pinned to it (${pinnersOf(specialists, app).join(', ')}), and ${to} is not pinned to it: ${pin}`)
      else if (target.apps && !app && at && !at.startsWith('slack:')) error(`${path}.to`, `${to} is pinned to Slack apps, so it can never take a message at ${at}: remove \`apps\` from ${to}, or change \`at\` to a \`slack:\` place`)
    }
    if ((at || app) && to) rules.push({ to, ...(at && { at }), ...(app && { app }), ...(from !== undefined && { from }) })
  }
  // A rule never matches when an earlier one takes everything it would: its place and app are the same or wider, and who `later`
  // names is a subset of who `earlier` names. Absent and `anyone` include strangers; `people` is the roster; a role, its holders.
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
  const where = (r: Rule) => r.at && r.app ? `at ${r.at} through app ${r.app}` : r.at ? `at ${r.at}` : `through app ${r.app}`
  // The apps a rule applies to: its own `app`; else, to a pinned specialist, that specialist's apps; else, to anyone else, every app
  // that no specialist is pinned to (an app that has pinned specialists skips a rule to anyone else). 'any' when pins play no part.
  const appsOf = (r: Rule): string[] | 'any' => {
    if (r.app) return [r.app]
    const target = specialists[r.to]
    if (target?.apps) return target.apps
    if (!target || !Object.values(specialists).some(x => x.apps)) return 'any'
    return Object.keys(slackApps).filter(a => pinnersOf(specialists, a).length === 0)
  }
  const appsCover = (earlier: Rule, later: Rule): boolean => {
    const e = appsOf(earlier), l = appsOf(later)
    return e === 'any' || (l !== 'any' && l.every(a => e.includes(a)))
  }
  for (const [j, later] of rules.entries()) {
    const i = rules.findIndex((earlier, k) => k < j && (earlier.at === undefined || earlier.at === later.at) && appsCover(earlier, later) && covers(earlier.from, later.from))
    if (i >= 0) warn(`rules[${j}]`, `never matches: rules[${i}] already takes ${later.from ? `${later.from}'s messages` : 'every message'} ${where(later)}`)
  }
  // A rule for everyone is checked before `listens`, so a specialist that listens where it applies, and takes one of its apps, never hears it there.
  const takesAppOf = (s: Specialist, r: Rule): boolean => {
    const via = appsOf(r)
    return via === 'any' || via.some(a => serves(specialists, s, a))
  }
  for (const [i, r] of rules.entries()) {
    if (senders(r.from) !== 'everyone') continue
    for (const s of Object.values(specialists)) {
      if (s.id === r.to || !takesAppOf(s, r) || (r.at !== undefined && !s.listens.includes(r.at)) || !s.listens.length) continue
      warn(`rules[${i}]`, r.at ? `takes every message ${where(r)}, so ${s.id}, which listens there, never hears it` : `takes every message ${where(r)}, so ${s.id}, which listens on ${s.listens.join(', ')}, never hears it through that app`)
    }
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

  /** Whether hydra connects the platform: Slack through its app `default`. */
  const connected = (platform: 'discord' | 'slack' | 'github'): boolean => platform === 'slack' ? Object.hasOwn(slackApps, DEFAULT_SLACK_APP) : !!connectors[platform]

  // --- warnings that need the whole file -----------------------------------------------------------------------------

  // The operator passes admin checks only through an address on the platform a daemon runs: on a connected platform
  // with none, nobody is in charge there.
  if (operator) for (const platform of ['discord', 'slack'] as const) {
    if (connected(platform) && !people[operator].ids.some(a => a.startsWith(`${platform}:`))) {
      warn('operator', `${operator} has no ${platform}: address, so on ${platform} nobody passes admin checks or reaches main by DM`)
    }
  }

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
    // Without idle, a per-conversation session never ends on its own, so its slot under max never frees.
    if (s.sessions === 'per-conversation' && s.idleMs === undefined) warn(path, `conversations past max (${s.max}) will wait until a session is ended by hand; set idle`)
    // Pinning an app takes it from every unpinned specialist: one that listens where no pinned specialist does has lost that app there.
    if (!s.apps) for (const app of Object.keys(slackApps)) {
      const by = pinnersOf(specialists, app)
      const lost = s.listens.find(p => p.startsWith('slack:') && !by.some(y => specialists[y].listens.includes(p)))
      if (by.length && lost) warn(path, `${s.id} is unpinned, and app ${app} is pinned by ${by.join(', ')}, so ${s.id} no longer hears ${app} on ${lost}`)
    }
    for (const p of s.listens) {
      const platform = p.split(':')[0] as Platform | 'cli'
      if (platform === 'cli') continue
      if (!connected(platform)) warn(path, platform === 'slack' ? `listens on ${p}, but hydra.toml has no app named "${DEFAULT_SLACK_APP}": add [slack.apps.${DEFAULT_SLACK_APP}], or it won't hear it` : `listens on ${p}, but [connectors.${platform}] isn't set, so it won't hear it`)
      else if (platform === 'github' && !connectors.github!.repos.includes(p.slice('github:'.length))) warn(path, `listens on ${p}, but connectors.github.repos doesn't include it`)
    }
  }

  if (errors.length) return { ok: false, errors, warnings }
  return { ok: true, config: { ...(operator && { operator }), connectors, slackApps, people, specialists, places, schedules, rules, ...(guard && { guard }), ...(vitals && { vitals }) }, warnings }
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
