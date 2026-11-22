// `hydra migrate`: write <state>/hydra.toml once from the old files, then retire them.
// Each step translates the old state it owns into a partial hydra.toml; the runner merges the steps, checks the
// result with the loader, and only if it's clean writes it and retires what the steps consumed. Each step migrates
// what its build step deletes: access.json's allowFrom, specialists.json, slack-watch.json and jobs.toml (the last two
// translated by config/migrate-slack-watch.ts and config/migrate-jobs.ts). Merging docs and writing TOML: config/toml-doc.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { parseIdleTtl, SPECIALIST_THREADS } from '../shared/constants.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import { loadHydraConfig, normalizeAddress, formatIssues } from '../config/load.js'
import { parsePlace, placeKey } from '../config/types.js'
import type { ChatPlatform, ConfigIssue, LoadEnv } from '../config/types.js'
import { appendOnly, appendText, HYDRA_TOML, isTable, mergeDocs, toToml, type Doc } from '../config/toml-doc.js'
import { migrateSlackWatch } from '../config/migrate-slack-watch.js'
import { migrateJobs, type ScheduleTable, type SpecialistTable } from '../config/migrate-jobs.js'
import { daemonFile, jobInitiator, owedSlot } from '../shared/jobs.js'
import { readDaemonState, readJobState } from './job-files.js'
import { nextSlot } from '../shared/cron-local.js'

export type MigrateInput = {
  stateDir: string
  env: LoadEnv
  /** The folder sessions spawn in today: a migrated specialist's workdir. */
  spawnCwd: string
  platform: ChatPlatform
  /** Where the old daemon ran, which its relative paths (a kickoffFile) were read from. Default: as written. */
  daemonCwd?: string
  /** `--operator <user id>`: on a fresh install with nothing to migrate, who the operator is on `platform`. */
  operator?: string
}

export type MigrateOutput = {
  /** A partial hydra.toml, file-shaped (snake_case keys, as TOML parses). */
  doc: Doc
  /** Files in the state dir this step retires: each is kept as <name>.migrated. */
  consumed: string[]
  /** Said to the operator: what changed for whom, what to check. */
  notes: string[]
  /** Other files to write in the state dir (path → content), before hydra.toml appears. */
  writes?: Record<string, string>
}

export type MigrateStep = {
  name: string
  /** Old state this step would migrate is still here. (The boot check uses it: hydra.toml beside pending old state.) */
  pending(stateDir: string): boolean
  run(input: MigrateInput): MigrateOutput | undefined
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

// --- access.json: allowFrom becomes the operator and people; groups become places; the settings move to gateways ---------

function accessOf(stateDir: string): { raw: Doc; allowFrom: string[] } | undefined {
  const path = join(stateDir, 'access.json')
  if (!existsSync(path)) return undefined
  const raw = readJson(path)
  if (!isTable(raw)) throw new Error('access.json is not a JSON object')
  const ids = Array.isArray(raw.allowFrom) ? raw.allowFrom.map(x => typeof x === 'number' ? String(x) : x).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []
  return { raw, allowFrom: [...new Set(ids)] }
}

/** Settings hydra.toml no longer has: hydra uses markdown chunks, replies to the first message, and 1440-minute threads. Set in access.json, they stop the migration rather than vanish. */
const CUT_TOP_KEYS = ['replyToMode', 'textChunkLimit', 'chunkMode']
const groupsOf = (raw: Doc): [string, Doc][] => isTable(raw.groups) ? Object.entries(raw.groups).filter((e): e is [string, Doc] => isTable(e[1])) : []
const cutSettings = (raw: Doc): string[] => [...CUT_TOP_KEYS.filter(k => raw[k] !== undefined), ...groupsOf(raw).filter(([, g]) => g.threadArchiveMinutes !== undefined).map(([id]) => `groups.${id}.threadArchiveMinutes`)]
const mentionPatternsOf = (raw: Doc): string[] => Array.isArray(raw.mentionPatterns) ? raw.mentionPatterns.filter((x): x is string => typeof x === 'string') : []

export const accessStep: MigrateStep = {
  name: 'access.json',
  pending: stateDir => {
    try {
      const found = accessOf(stateDir)
      if (!found) return false
      const r = found.raw
      return found.allowFrom.length > 0 || groupsOf(r).length > 0 || cutSettings(r).length > 0 || r.dmPolicy === 'disabled' || r.ackReaction !== undefined || r.defaultListen !== undefined || mentionPatternsOf(r).length > 0
    } catch { return true }
  },
  run({ stateDir, platform, operator: operatorFlag }) {
    const found = accessOf(stateDir)
    if (!found || !this.pending(stateDir)) return undefined
    const { raw } = found
    const cut = cutSettings(raw)
    if (cut.length) throw new Error(`access.json sets ${cut.join(', ')}, which hydra.toml no longer has (hydra uses markdown chunks, replies to the first message, and 1440-minute threads). Remove ${cut.length === 1 ? 'it' : 'them'} from access.json, then run hydra migrate again`)
    const notes: string[] = []
    const people: Doc = {}
    let operator: string | undefined
    found.allowFrom.forEach((id, i) => {
      const address = normalizeAddress(`${platform}:${id}`)
      if (!address) { notes.push(`allowFrom "${id}" isn't a ${platform} user id; left out`); return }
      const personId = operator === undefined ? 'operator' : `person-${i + 1}`
      people[personId] = { addresses: [address] }
      if (operator === undefined) operator = personId
      else notes.push(`${address} (now people.${personId}) was in allowFrom but isn't the operator: they no longer reach main by DM or use admin commands. Route their DMs to a specialist, or make them the operator.`)
    })
    // Never write a hydra.toml with no operator: allowFrom would be gone and nobody would pass admin checks.
    if (found.allowFrom.length && !operator) throw new Error(`no allowFrom id is a ${platform} user id (${found.allowFrom.join(', ')}); is this a ${platform} state dir?`)
    if (operator) {
      const chosen = (people.operator as { addresses: string[] }).addresses[0]
      notes.unshift(`${chosen} is the operator, as people.operator (the first ${platform} id in allowFrom); rename the id if you like, and update operator = to match.`)
    }
    // Who each id in a group's allowFrom is: a person made above, or one hydra.toml already has. Anyone else must be added first.
    const known = new Map<string, string>()
    const toml = join(stateDir, HYDRA_TOML)
    // The run has already refused a hydra.toml that doesn't parse, so this one does.
    const existing = existsSync(toml) ? (Bun.TOML.parse(readFileSync(toml, 'utf8')) as Doc) : {}
    for (const [pid, p] of Object.entries(isTable(existing.people) ? existing.people : {})) for (const a of isTable(p) && Array.isArray(p.addresses) ? p.addresses : []) known.set(normalizeAddress(String(a)) ?? String(a), pid)
    // An address hydra.toml already gives a person stays theirs: the merge folds the new person into them.
    for (const [pid, p] of Object.entries(people)) { const a = (p as { addresses: string[] }).addresses[0]; if (!known.has(a)) known.set(a, pid) }
    // --operator names the person this run adds as people.operator, so a group may list them.
    const flagged = operatorFlag === undefined ? undefined : normalizeAddress(`${platform}:${operatorFlag.trim()}`)
    if (flagged && !known.has(flagged)) known.set(flagged, 'operator')
    const asPerson = (id: string) => known.get(normalizeAddress(`${platform}:${id}`) ?? '')
    const places: Doc = {}
    for (const [channel, g] of Object.entries(isTable(raw.groups) ? raw.groups : {})) {
      if (!isTable(g)) { notes.push(`group "${channel}" left out: not an object`); continue }
      if (g.allowFrom !== undefined && !Array.isArray(g.allowFrom)) throw new Error(`groups.${channel}.allowFrom must be a list of ids, not ${JSON.stringify(g.allowFrom)}: fix it in access.json, then run hydra migrate again`)
      const ids = (Array.isArray(g.allowFrom) ? g.allowFrom : []).map(String).map(x => x.trim()).filter(Boolean)
      const key = `${platform}:${channel}`
      if (!parsePlace(key).ok) { notes.push(`group "${channel}" left out: ${key} isn't a channel id hydra.toml can name`); continue }
      const stranger = ids.filter(id => asPerson(id) === undefined)
      if (stranger.length) throw new Error(`groups.${channel}.allowFrom has ${stranger.join(', ')}, who ${stranger.length === 1 ? 'is' : 'are'} not in hydra.toml's people. Add ${stranger.length === 1 ? 'them' : 'each'} first (hydra people add <name> ${platform}:${stranger[0]}), then run hydra migrate again`)
      const who = [...new Set(ids.map(id => asPerson(id) as string))]
      places[key] = {
        ...(typeof g.threadReply === 'boolean' && { thread_reply: g.threadReply }),
        access: { mention: g.requireMention !== false, allow: who.length ? who : ['anyone'], ...(typeof g.defaultListen === 'boolean' && { listen: g.defaultListen }) },
      }
    }
    const patterns = mentionPatternsOf(raw)
    const settings = {
      ...(raw.dmPolicy === 'disabled' && { off: true }),
      ...(typeof raw.ackReaction === 'string' && raw.ackReaction !== '' && { ack_reaction: raw.ackReaction }),
      ...(typeof raw.defaultListen === 'boolean' && { listen: raw.defaultListen }),
      ...(patterns.length && { mention_patterns: patterns }),
    }
    if (isTable(raw.pending) && Object.keys(raw.pending).length) notes.push('access.json had pairing codes waiting: pairing is gone, so those people are dropped. Add anyone you want with hydra people add.')
    if (raw.dmPolicy === 'pairing') notes.push('dmPolicy "pairing" is gone: strangers\' DMs are dropped, with no pairing code. People come in through hydra people add.')
    if (raw.dmPolicy === 'disabled') notes.push('dmPolicy "disabled" is now [gateways.' + platform + '] off = true: hydra drops every message')
    return {
      doc: { ...(operator && { operator }), ...(Object.keys(people).length && { people }), ...(Object.keys(places).length && { places }), ...(Object.keys(settings).length && { gateways: { [platform]: settings } }) },
      // The whole file goes: what it said now lives in hydra.toml; the original is kept as a backup.
      consumed: ['access.json'],
      notes,
    }
  },
}

// --- specialists.json: recipes become [specialists.*], threads become pointers --------------------------------------

type OldSpecialist = { threadId?: string; channel?: string; kickoff?: string; kickoffFile?: string; model?: string; idle?: string; updatedAt?: number }

export const specialistsStep: MigrateStep = {
  name: 'specialists.json',
  pending: stateDir => existsSync(join(stateDir, 'specialists.json')),
  run({ stateDir, env, spawnCwd, platform, daemonCwd }) {
    const path = join(stateDir, 'specialists.json')
    if (!existsSync(path)) return undefined
    const raw = readJson(path)
    if (!isTable(raw)) throw new Error('specialists.json is not a JSON object')
    const specialists: Doc = {}
    const pointers: Record<string, { threadId: string; updatedAt: number }> = {}
    const notes: string[] = []
    for (const [name, value] of Object.entries(raw)) {
      const why = invalidSpecialistName(name, env.sessionNames)
      if (why) { notes.push(`specialist "${name}" left out: ${why}. Declare it under a new name.`); continue }
      if (!isTable(value)) { notes.push(`specialist "${name}" left out: not an object`); continue }
      const s = value as OldSpecialist
      const spec: Doc = { workdir: spawnCwd }
      // kickoffFile won over kickoff in specialists.json.
      if (s.kickoffFile) {
        // hydra.toml reads a relative kickoff_file under the workdir; the old daemon read it from its own cwd.
        const absolute = isAbsolute(s.kickoffFile) || s.kickoffFile.startsWith('~') || !daemonCwd ? s.kickoffFile : resolve(daemonCwd, s.kickoffFile)
        if (absolute !== s.kickoffFile) notes.push(`specialist "${name}": kickoffFile ${s.kickoffFile} was relative to the daemon's folder; written as ${absolute}`)
        spec.kickoff_file = absolute
      } else if (s.kickoff) spec.kickoff = s.kickoff
      if (s.model) spec.model = s.model
      if (s.idle) {
        if (parseIdleTtl(s.idle) !== null) spec.idle = s.idle
        else notes.push(`specialist "${name}": idle "${s.idle}" isn't a duration hydra.toml takes; left out`)
      }
      // A channel id is where its threads open. Digits stand alone; any other id is written as a place on this platform.
      if (s.channel) {
        const parsed = /^\d+$/.test(s.channel) ? undefined : parsePlace(`${platform}:${s.channel}`)
        const homePlace = parsed === undefined ? s.channel : parsed.ok ? placeKey(parsed.place) : undefined
        if (homePlace) spec.home_place = homePlace
        else notes.push(`specialist "${name}": channel ${s.channel} isn't a channel hydra.toml can name; left out, so its new threads open in the operator's channel`)
      }
      specialists[name] = spec
      if (s.threadId) pointers[name] = { threadId: s.threadId, updatedAt: s.updatedAt ?? Date.now() }
    }
    if (Object.keys(specialists).length) {
      notes.push(`each specialist's workdir is ${spawnCwd}, where sessions start today; point it at the specialist's own folder when it has one.`)
      notes.push('a "nobody can reach it" warning counts only rules, schedules and sends_to: hydra deliver and jobs still reach these specialists as before.')
    }
    // Pointers already here (a hydra.toml tried earlier) are kept; per name, the more recently updated one wins.
    const writes: Record<string, string> = {}
    const existingPath = join(stateDir, SPECIALIST_THREADS)
    if (existsSync(existingPath)) {
      const text = readFileSync(existingPath, 'utf8')
      const existing = readJson(existingPath)
      if (!isTable(existing)) throw new Error(`${SPECIALIST_THREADS} is not a JSON object`)
      for (const [name, p] of Object.entries(existing as Record<string, { threadId: string; updatedAt?: number }>)) {
        if (!pointers[name] || (p.updatedAt ?? 0) > pointers[name].updatedAt) pointers[name] = { threadId: p.threadId, updatedAt: p.updatedAt ?? 0 }
      }
      writes[`${SPECIALIST_THREADS}.migrated`] = text
      notes.push(`${SPECIALIST_THREADS} already existed: merged with the migrated threads (the newer wins per specialist), kept as ${SPECIALIST_THREADS}.migrated`)
    }
    writes[SPECIALIST_THREADS] = JSON.stringify(pointers, null, 2) + '\n'
    return { doc: { specialists }, consumed: ['specialists.json'], notes, writes }
  },
}

// --- slack-watch.json and jobs.toml: their translations are config/migrate-slack-watch.ts and config/migrate-jobs.ts ----

const SLACK_WATCH = 'slack-watch.json'

/** The step `hydra migrate` runs: slack-watch.json in, its tables merged with the other steps', the file retired. */
export const slackWatchStep: MigrateStep = {
  name: SLACK_WATCH,
  pending: stateDir => existsSync(join(stateDir, SLACK_WATCH)),
  run({ stateDir }) {
    const path = join(stateDir, SLACK_WATCH)
    if (!existsSync(path)) return undefined
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${SLACK_WATCH} is not valid JSON: ${(e as Error).message}`) }
    const { notes, ...doc } = migrateSlackWatch(raw)
    return { doc, consumed: [SLACK_WATCH], notes }
  },
}

/**
 * The jobs.toml step for `hydra migrate`. Pending while jobs.toml is here: until migrate retires it, the clock runs it
 * exactly as before (schedulesAreSource, infra/schedule-source.ts). A job that can't be carried over refuses the whole migrate, naming it.
 */
export const jobsStep: MigrateStep = {
  name: 'jobs.toml',
  pending: stateDir => existsSync(join(stateDir, 'jobs.toml')),
  run({ stateDir, env, spawnCwd }) {
    const path = join(stateDir, 'jobs.toml')
    if (!existsSync(path)) return undefined
    const m = migrateJobs(readFileSync(path, 'utf8'), { sessionNames: env.sessionNames, defaultWorkdir: spawnCwd })
    if (m.refusals.length) throw new Error(m.refusals.join('; '))
    const now = new Date()
    return {
      doc: {
        ...(Object.keys(m.schedules).length > 0 && { schedules: m.schedules }),
        ...(Object.keys(m.specialists).length > 0 && { specialists: m.specialists }),
      },
      consumed: ['jobs.toml'],
      // Recorded here, with the daemon stopped, so deleting jobs.toml.migrated before its first tick changes nothing.
      writes: { [relative(stateDir, daemonFile(stateDir))]: JSON.stringify({ ...readDaemonState(stateDir).state, jobsMigrated: now.toISOString() }, null, 2) },
      notes: [...m.notes, ...Object.entries(m.schedules).map(([id, s]) => equivalence(stateDir, id, s, m.specialists[id], now))],
    }
  },
}

/**
 * One line per schedule that a dry run can be checked against: the next slot, and whether a slot is owed now (from the
 * same jobs-state/<id>.state.json, so a covered slot stays covered), the runner, and where a run goes and as whom.
 */
function equivalence(stateDir: string, id: string, s: ScheduleTable, spec: SpecialistTable | undefined, now: Date): string {
  const next = nextSlot(s.cron, now)
  let owed = ''
  if (s.runner === 'daemon') {
    const r = readJobState(stateDir, id, s.cron)
    const slot = r.kind === 'ok' ? owedSlot(s.cron, r.state, now) : null
    owed = r.kind === 'missing' ? ', no record yet (nothing owed)' : r.kind === 'unreadable' ? `, record unreadable (${r.error})` : slot ? `, owed: ${slot.label}` : ', not owed'
  }
  const extras = [...(s.needs ? [`needs ${s.needs.join(', ')}`] : []), ...(s.alert_after ? [`alert_after ${s.alert_after}`] : [])]
  const where = !s.target ? 'a sensor (no message)'
    : spec ? `to ${s.target}: a fresh session in a new thread in ${spec.home_place}`
    : `to ${s.target}`
  return `${id}: next ${next ? next.label : 'never'}${owed}; runner ${s.runner}${extras.length ? `, ${extras.join(', ')}` : ''}; ${where}; initiator ${jobInitiator(id)}`
}

/** Every step, in merge order. */
export const STEPS: MigrateStep[] = [accessStep, specialistsStep, slackWatchStep, jobsStep]

/**
 * Whether hydra.toml governs, by the daemon's own test: it has something in it (a comment-only file doesn't), or it
 * doesn't parse (a file that fails to load still governs, rather than handing back to the old files).
 */
export function hydraTomlInUse(stateDir: string): boolean {
  let text: string
  try { text = readFileSync(join(stateDir, HYDRA_TOML), 'utf8') } catch { return false }
  try { return Object.keys(Bun.TOML.parse(text) as object).length > 0 } catch { return true }
}

/** Appended to every refusal that `hydra migrate` fixes: where the steps are. */
const UPGRADE_STEPS = ` Steps: ACCESS.md, "Upgrading from access.json".`

/** Where a daemon that refused to start says why, for the watchdog and `hydra health` (it never reaches chat). */
export const BOOT_REFUSED_FILE = 'boot-refused.json'

/**
 * Why a daemon must not start on this state dir, or undefined. One rule: hydra.toml has content while old state
 * it replaces is still here (a step is pending), named by file. Running with both
 * would have the daemon silently prefer one. Also while a migration's journal says it is half committed.
 */
export function bootRefusal(stateDir: string, steps: MigrateStep[] = STEPS): string | undefined {
  if (existsSync(join(stateDir, MIGRATE_JOURNAL))) return `refusing to start: a hydra migrate in ${stateDir} was interrupted after it committed; run 'hydra migrate' to finish it.${UPGRADE_STEPS}`
  if (!hydraTomlInUse(stateDir)) {
    // access.json's channels and settings live in hydra.toml now: without one, they would be ignored.
    // (A file that doesn't parse counts as pending: nothing else reads or moves it.)
    return steps.includes(accessStep) && accessStep.pending(stateDir)
      ? `refusing to start: ${join(stateDir, 'access.json')} still holds channels or settings, and hydra.toml is not here to take them. Run 'hydra migrate' (it writes hydra.toml from it and retires it).${UPGRADE_STEPS}`
      : undefined
  }
  const old = steps.filter(s => s.pending(stateDir)).map(s => s.name)
  if (!old.length) return undefined
  return `refusing to start: hydra.toml is in use, but old state it replaces is still in ${stateDir}: ${old.join(', ')}. `
    + `Run 'hydra migrate' (it adds that state to hydra.toml and retires it), or retire it by hand.${UPGRADE_STEPS}`
}

// --- the run --------------------------------------------------------------------------------------------------------

export type MigratePlan =
  | { ok: true; text: string; warnings: ConfigIssue[]; notes: string[]; consumed: string[]; writes: Record<string, string> }
  | { ok: false; errors: string[] }

/** Everything `hydra migrate` would do, without writing. */
export function planMigrate(input: MigrateInput, steps: MigrateStep[] = STEPS): MigratePlan {
  if (existsSync(join(input.stateDir, MIGRATE_JOURNAL))) return { ok: false, errors: ['a migration was interrupted after it committed: run hydra migrate again to finish it'] }
  const toml = join(input.stateDir, HYDRA_TOML)
  const existingText = existsSync(toml) ? readFileSync(toml, 'utf8') : ''
  // A hydra.toml already here (an earlier migration, or written by hand) is kept: what's still pending is added to it.
  let existing: Doc | undefined
  if (hydraTomlInUse(input.stateDir)) {
    if (!steps.some(s => s.pending(input.stateDir))) {
      return { ok: false, errors: [`${toml} already has content and nothing is left to migrate: this state dir is migrated.`] }
    }
    try { existing = Bun.TOML.parse(existingText) as Doc } catch (e) {
      return { ok: false, errors: [`${toml} isn't valid TOML (${(e as Error).message}); fix it, then run hydra migrate again.`] }
    }
  }
  const outputs: MigrateOutput[] = []
  const errors: string[] = []
  for (const step of steps) {
    try {
      const out = step.run(input)
      if (out) outputs.push(out)
    } catch (e) {
      errors.push(`${step.name}: ${(e as Error).message}`)
    }
  }
  if (errors.length) return { ok: false, errors }
  if (input.operator !== undefined) {
    const address = normalizeAddress(`${input.platform}:${input.operator.trim()}`)
    if (!address) return { ok: false, errors: [`--operator "${input.operator}" isn't a ${input.platform} user id`] }
    if (existing?.operator !== undefined || outputs.some(o => o.doc.operator !== undefined)) return { ok: false, errors: ['--operator is for a fresh install: this one already names an operator (hydra.toml, or an allowFrom id in access.json)'] }
    outputs.push({ doc: { operator: 'operator', people: { operator: { addresses: [address] } } }, consumed: [], notes: [`${address} is the operator, as people.operator, from --operator.`] })
  }
  if (!outputs.length) return { ok: false, errors: [`nothing to migrate: no allowFrom in access.json and no specialists.json. On a fresh install, say who you are: hydra migrate ${input.platform} --operator <your ${input.platform} user id>`] }
  const merged = mergeDocs([...(existing ? [existing] : []), ...outputs.map(o => o.doc)])
  if (merged.conflicts.length) return { ok: false, errors: merged.conflicts.map(c => `two sources disagree on ${c}`) }
  // A hydra.toml governs only once it names an operator; one without would retire allowFrom and leave nobody in charge.
  if (typeof merged.doc.operator !== 'string') return { ok: false, errors: ['no operator: access.json has no allowFrom to take one from. Pass --operator <your user id> (or write hydra.toml by hand).'] }
  // A hydra.toml with only comments in it is kept above the new content.
  const after = (body: string) => appendText(existingText, body)
  let text = existingText.trim() && !existing ? after(toToml(merged.doc)) : toToml(merged.doc)
  const appendNotes: string[] = []
  if (existing) {
    const added = appendOnly(existing, merged.doc, existingText)
    if ('refusal' in added) return { ok: false, errors: [added.refusal] }
    if (added.tables.length) {
      text = after(`# Added by \`hydra migrate\`.\n${toToml(added.doc, false)}`)
      appendNotes.push(`appends to the existing hydra.toml, leaving what's there as it is: ${added.tables.join(', ')}`)
    } else {
      text = existingText
      appendNotes.push('nothing to add to hydra.toml; it is left as it is')
    }
  }
  const loaded = loadHydraConfig(text, input.env)
  if (!loaded.ok) return { ok: false, errors: [`the migrated hydra.toml doesn't load:\n${formatIssues(loaded.errors)}\n\n${text}`] }
  const writes: Record<string, string> = {}
  for (const o of outputs) for (const [path, content] of Object.entries(o.writes ?? {})) {
    if (path in writes) return { ok: false, errors: [`two steps write ${path}`] }
    writes[path] = content
  }
  const consumed = outputs.flatMap(o => o.consumed)
  // Each retired file is kept beside it as <name>.migrated, or <name>.2.migrated, ... when an earlier one is there with other content: never overwritten.
  for (const f of consumed) {
    const content = readFileSync(join(input.stateDir, f), 'utf8')
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${f}.migrated` : `${f}.${n}.migrated`
      const there = join(input.stateDir, name)
      if (!existsSync(there) || readFileSync(there, 'utf8') === content) { writes[name] ??= content; break }
    }
  }
  // A backup already here is fine when it's this same content (a rerun after an interruption); never overwrite another.
  const clash = Object.entries(writes).filter(([f, content]) => f.endsWith('.migrated') && existsSync(join(input.stateDir, f)) && readFileSync(join(input.stateDir, f), 'utf8') !== content).map(([f]) => f)
  if (clash.length) {
    const at = (f: string) => join(input.stateDir, f)
    return { ok: false, errors: [`${clash.join(', ')} already exists with other content (a previous run, or the originals changed since one staged). To start over: mv ${clash.map(f => `'${at(f)}' '${at(f)}.old'`).join(' && mv ')} && rm -f '${input.stateDir}'/*${STAGED}, then run hydra migrate again.`] }
  }
  // A step's notes name its own person ids; follow the merge's renames (e.g. into a person hydra.toml already has).
  const offset = existing ? 1 : 0
  const stepNotes = outputs.flatMap((o, i) => o.notes.map(n => n.replace(/people\.([a-z0-9-]+)/g, (m, id: string) => `people.${merged.renames[i + offset].get(id) ?? id}`)))
  return { ok: true, text, warnings: loaded.warnings, notes: [...appendNotes, ...stepNotes, ...merged.notes], consumed, writes }
}

const STAGED = '.migrating'
/** Written once everything is staged: the commit point. While it exists, a migration is in flight. */
export const MIGRATE_JOURNAL = 'migrate-journal.json'
type Journal = { renames: [string, string][]; unlinks: string[] }

/**
 * Carries out a clean plan so that an interruption anywhere is recovered by running `hydra migrate` again.
 * 1. Stage: each new file as <name>.migrating, and the backups (*.migrated). Nothing live has changed; a rerun
 *    plans again from the untouched originals.
 * 2. The journal (the commit point): the renames and removals left to do.
 * 3. Commit: the renames (hydra.toml last), the retired files removed, the journal removed. Every step can be
 *    repeated, so a rerun that finds the journal finishes it (finishMigrate) instead of planning again.
 * The daemon must not be running (see the CLI).
 * State files are written 0600, as the daemon writes them.
 */
export function applyMigrate(stateDir: string, plan: Extract<MigratePlan, { ok: true }>, failpoint?: { stopAfter: 'stage' | 'journal' }): void {
  const at = (f: string) => join(stateDir, f)
  const live = { ...Object.fromEntries(Object.entries(plan.writes).filter(([f]) => !f.endsWith('.migrated'))), [HYDRA_TOML]: plan.text }
  for (const [f, content] of Object.entries(live)) writeState(at(f + STAGED), content)
  for (const [f, content] of Object.entries(plan.writes)) if (f.endsWith('.migrated')) writeState(at(f), content)
  if (failpoint?.stopAfter === 'stage') return // tests: a crash before the commit point
  const order = [...Object.keys(live).filter(f => f !== HYDRA_TOML), HYDRA_TOML]
  const journal: Journal = { renames: order.map(f => [f + STAGED, f]), unlinks: plan.consumed }
  writeState(at(MIGRATE_JOURNAL), JSON.stringify(journal, null, 2) + '\n')
  if (failpoint?.stopAfter === 'journal') return // tests: a crash just after the commit point
  finishMigrate(stateDir)
}

/** Finishes the journaled commit, if one is in flight: true when it did. */
export function finishMigrate(stateDir: string): boolean {
  const at = (f: string) => join(stateDir, f)
  if (!existsSync(at(MIGRATE_JOURNAL))) return false
  const journal = JSON.parse(readFileSync(at(MIGRATE_JOURNAL), 'utf8')) as Journal
  for (const [from, to] of journal.renames) if (existsSync(at(from))) renameSync(at(from), at(to))
  for (const f of journal.unlinks) if (existsSync(at(f))) unlinkSync(at(f))
  unlinkSync(at(MIGRATE_JOURNAL))
  return true
}

function writeState(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })   // jobs-state/ may not exist yet
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
