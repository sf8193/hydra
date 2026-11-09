// `hydra migrate`: write <state>/hydra.toml once from the old files, then retire them.
// Each step translates the old state it owns into a partial hydra.toml; the runner merges the steps, checks the
// result with the loader, and only if it's clean writes it and retires what the steps consumed. Each step migrates
// what its build step deletes: access.json's allowFrom and specialists.json here; slack-watch.json and jobs.toml
// join as their own steps.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { parseIdleTtl } from '../shared/constants.js'
import { invalidSpecialistName } from '../shared/specialist-name.js'
import { loadHydraConfig, normalizeAddress, normalizePlace, formatIssues } from './load.js'
import type { ConfigIssue, LoadEnv } from './types.js'
import { slackWatchStep } from './migrate-slack-watch.js'
import { jobsStep } from './migrate-jobs.js'

export const HYDRA_TOML = 'hydra.toml'
/** The daemon's specialist pointers, as specialists/specialists.ts keeps them. */
export const SPECIALIST_THREADS = 'specialist-threads.json'

export type MigrateInput = {
  stateDir: string
  env: LoadEnv
  /** The folder sessions spawn in today: a migrated specialist's workdir. */
  spawnCwd: string
  platform: 'discord' | 'slack'
  /** Where the old daemon ran, which its relative paths (a kickoffFile) were read from. Default: as written. */
  daemonCwd?: string
}

type Doc = Record<string, unknown>
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
const isTable = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

// --- access.json: allowFrom becomes the operator and people --------------------------------------------------------

function allowFromOf(stateDir: string): { raw: Doc; allowFrom: string[] } | undefined {
  const path = join(stateDir, 'access.json')
  if (!existsSync(path)) return undefined
  const raw = readJson(path)
  if (!isTable(raw)) throw new Error('access.json is not a JSON object')
  const ids = Array.isArray(raw.allowFrom) ? raw.allowFrom.map(x => typeof x === 'number' ? String(x) : x).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []
  return { raw, allowFrom: [...new Set(ids)] }
}

export const accessStep: MigrateStep = {
  name: 'access.json allowFrom',
  pending: stateDir => {
    try { return (allowFromOf(stateDir)?.allowFrom.length ?? 0) > 0 } catch { return true }
  },
  run({ stateDir, platform }) {
    const found = allowFromOf(stateDir)
    if (!found || found.allowFrom.length === 0) return undefined
    const notes: string[] = []
    const people: Doc = {}
    let operator: string | undefined
    found.allowFrom.forEach((id, i) => {
      const address = normalizeAddress(`${platform}:${id}`)
      if (!address) { notes.push(`allowFrom "${id}" isn't a ${platform} user id; left out`); return }
      const personId = operator === undefined ? 'operator' : `person-${i + 1}`
      people[personId] = { ids: [address] }
      if (operator === undefined) operator = personId
      else notes.push(`${address} (now people.${personId}) was in allowFrom but isn't the operator: they no longer reach main by DM or use admin commands. Route their DMs to a specialist, or make them the operator.`)
    })
    // Never write a hydra.toml with no operator: allowFrom would be gone and nobody would pass admin checks.
    if (!operator) throw new Error(`no allowFrom id is a ${platform} user id (${found.allowFrom.join(', ')}); is this a ${platform} state dir?`)
    const chosen = (people.operator as { ids: string[] }).ids[0]
    notes.unshift(`${chosen} is the operator, as people.operator (the first ${platform} id in allowFrom); rename the id if you like, and update operator = to match.`)
    // B1 retires only allowFrom: the rest of access.json (DM policy, groups, pending codes) stays until places replace it.
    const { allowFrom: _gone, ...rest } = found.raw
    return {
      doc: { ...(operator && { operator }), people },
      consumed: [],
      notes,
      writes: {
        'access.json.migrated': readFileSync(join(stateDir, 'access.json'), 'utf8'),
        'access.json': JSON.stringify(rest, null, 2) + '\n',
      },
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
        // hydra.toml reads a relative prompt_file under the workdir; the old daemon read it from its own cwd.
        const absolute = isAbsolute(s.kickoffFile) || s.kickoffFile.startsWith('~') || !daemonCwd ? s.kickoffFile : resolve(daemonCwd, s.kickoffFile)
        if (absolute !== s.kickoffFile) notes.push(`specialist "${name}": kickoffFile ${s.kickoffFile} was relative to the daemon's folder; written as ${absolute}`)
        spec.prompt_file = absolute
      } else if (s.kickoff) spec.prompt = s.kickoff
      if (s.model) spec.model = s.model
      if (s.idle) {
        if (parseIdleTtl(s.idle) !== null) spec.idle = s.idle
        else notes.push(`specialist "${name}": idle "${s.idle}" isn't a duration hydra.toml takes; left out`)
      }
      // A channel id is where its threads open. Digits stand alone; any other id is written as a place on this platform.
      if (s.channel) {
        const home = /^\d+$/.test(s.channel) ? s.channel : normalizePlace(`${platform}:${s.channel}`)
        if (home) spec.home = home
        else notes.push(`specialist "${name}": channel ${s.channel} isn't a channel hydra.toml can name; left out, so its new threads open in the operator's channel`)
      }
      specialists[name] = spec
      if (s.threadId) pointers[name] = { threadId: s.threadId, updatedAt: s.updatedAt ?? Date.now() }
    }
    if (Object.keys(specialists).length) {
      notes.push(`each specialist's workdir is ${spawnCwd}, where sessions start today; point it at the specialist's own folder when it has one.`)
      notes.push('a "nobody can reach it" warning counts only listens, rules and schedules: hydra deliver and jobs still reach these specialists as before.')
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

/** Every step, in merge order. */
export const STEPS: MigrateStep[] = [accessStep, specialistsStep, slackWatchStep, jobsStep]

/** Old files no step migrates yet: migrate refuses while one is here, so nothing goes quiet on upgrade. */
export const UNHANDLED: string[] = []

/**
 * Whether hydra.toml governs, by the daemon's own test: it has something in it (a comment-only file doesn't), or it
 * doesn't parse (a file that fails to load still governs, rather than handing back to the old files).
 */
export function hydraTomlInUse(stateDir: string): boolean {
  let text: string
  try { text = readFileSync(join(stateDir, HYDRA_TOML), 'utf8') } catch { return false }
  try { return Object.keys(Bun.TOML.parse(text) as object).length > 0 } catch { return true }
}

/** Where a daemon that refused to start says why, for the watchdog and `hydra health` (it never reaches chat). */
export const BOOT_REFUSED_FILE = 'boot-refused.json'

/**
 * Why a daemon must not start on this state dir, or undefined. One rule: hydra.toml has content while old state
 * it replaces is still here (a step is pending, or a file no step migrates yet), named by file. Running with both
 * would have the daemon silently prefer one. Also while a migration's journal says it is half committed.
 */
export function bootRefusal(stateDir: string, steps: MigrateStep[] = STEPS): string | undefined {
  if (existsSync(join(stateDir, MIGRATE_JOURNAL))) return `refusing to start: a hydra migrate in ${stateDir} was interrupted after it committed; run 'hydra migrate' to finish it.`
  if (!hydraTomlInUse(stateDir)) return undefined
  const old = [...steps.filter(s => s.pending(stateDir)).map(s => s.name), ...UNHANDLED.filter(f => existsSync(join(stateDir, f)))]
  if (!old.length) return undefined
  return `refusing to start: hydra.toml is in use, but old state it replaces is still in ${stateDir}: ${old.join(', ')}. `
    + `Run 'hydra migrate' (it adds that state to hydra.toml and retires it), or retire it by hand.`
}

// --- merging the steps --------------------------------------------------------------------------------------------

/** Deep equality that ignores key order (a table written by hand may list its keys in any order). */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : isTable(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** Merges tables key by key; the same key with different values is a conflict. */
function mergeTable(into: Doc, from: Doc, path: string, conflicts: string[]): void {
  for (const [k, v] of Object.entries(from)) {
    if (!(k in into)) into[k] = v
    else if (isTable(into[k]) && isTable(v)) mergeTable(into[k] as Doc, v, `${path}.${k}`, conflicts)
    else if (!same(into[k], v)) conflicts.push(`${path}.${k}: ${JSON.stringify(into[k])} vs ${JSON.stringify(v)}`)
  }
}

type PersonDoc = { ids: string[]; roles?: string[]; name?: string }

/**
 * Merges the steps' docs. People are merged by address (one address, one person; the first step's id wins, roles
 * are unioned), and a merged-away id is rewritten where the step referred to it (operator, a rule's from).
 * Everything else merges key by key, a conflict being the same key with different values.
 */
export function mergeDocs(docs: Doc[]): { doc: Doc; conflicts: string[]; notes: string[]; renames: Map<string, string>[] } {
  const out: Doc = {}
  const people: Record<string, PersonDoc> = {}
  const owner = new Map<string, string>()
  const conflicts: string[] = []
  const notes: string[] = []
  const renames: Map<string, string>[] = []
  // Merging writes into the output's tables; copy each input so none is changed underneath its caller.
  for (const doc of docs.map(d => structuredClone(d))) {
    const rename = new Map<string, string>()
    renames.push(rename)
    for (const [id, raw] of Object.entries(isTable(doc.people) ? doc.people : {})) {
      const p = raw as PersonDoc
      const target = p.ids.map(a => owner.get(a)).find(x => x !== undefined)
      let into = target
      if (!into) {
        into = id
        for (let n = 2; people[into]; n++) into = `${id}-${n}`
        if (into !== id) notes.push(`people.${id} from two sources with different addresses: the second is people.${into}`)
        people[into] = { ids: [] }
      }
      if (into !== id) rename.set(id, into)
      const merged = people[into]
      for (const a of p.ids) if (!merged.ids.includes(a)) merged.ids.push(a)
      for (const r of p.roles ?? []) if (!(merged.roles ??= []).includes(r)) merged.roles.push(r)
      if (p.name && !merged.name) merged.name = p.name
      for (const a of merged.ids) owner.set(a, into)
    }
    const renamed = (id: unknown) => typeof id === 'string' ? rename.get(id) ?? id : id
    const { people: _p, rules, operator, ...rest } = doc
    if (operator !== undefined) {
      const op = renamed(operator)
      if (out.operator === undefined) out.operator = op
      else if (out.operator !== op) conflicts.push(`operator: ${JSON.stringify(out.operator)} vs ${JSON.stringify(op)}`)
    }
    if (Array.isArray(rules)) {
      const list = (out.rules ??= []) as Doc[]
      for (const r of rules as Doc[]) list.push(r.from === undefined ? r : { ...r, from: renamed(r.from) })
    }
    mergeTable(out, rest, '', conflicts)
  }
  if (Object.keys(people).length) out.people = people
  notes.push(...lookAlikes(people))
  return { doc: out, conflicts: conflicts.map(c => c.replace(/^\./, '')), notes, renames }
}

/** People whose names read the same: perhaps one human under two ids, for the operator to merge. */
function lookAlikes(people: Record<string, PersonDoc>): string[] {
  const groups = new Map<string, string[]>()
  for (const [id, p] of Object.entries(people)) {
    const key = (p.name ?? id).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (key) groups.set(key, [...(groups.get(key) ?? []), id])
  }
  return [...groups.values()].filter(ids => ids.length > 1)
    .map(ids => `${ids.map(id => `people.${id}`).join(' and ')} may be the same human: to merge, move every address into one and drop the other`)
}

// --- TOML out ------------------------------------------------------------------------------------------------------

const ORDER = ['operator', 'connectors', 'people', 'defaults', 'specialists', 'places', 'schedules', 'rules', 'guard']
const key = (k: string) => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
const value = (v: unknown): string => {
  // A JSON string is a TOML basic string, once DEL is escaped and a lone surrogate (not Unicode) is replaced.
  if (typeof v === 'string') return JSON.stringify(v.toWellFormed()).replace(/\x7f/g, '\\u007f')
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(value).join(', ')}]`
  throw new Error(`can't write ${JSON.stringify(v)} as a TOML value`)
}

/** A hydra.toml doc as TOML: top-level values, then each table, in the schema's order. */
export function toToml(doc: Doc, header = true): string {
  const lines: string[] = []
  const table = (path: string, t: Doc) => {
    const scalars = Object.entries(t).filter(([, v]) => !isTable(v))
    const subs = Object.entries(t).filter(([, v]) => isTable(v))
    if (scalars.length || !subs.length) {
      lines.push(`[${path}]`, ...scalars.map(([k, v]) => `${key(k)} = ${value(v)}`), '')
    }
    for (const [k, v] of subs) table(`${path}.${key(k)}`, v as Doc)
  }
  const top: string[] = []
  const keys = [...ORDER.filter(k => k in doc), ...Object.keys(doc).filter(k => !ORDER.includes(k))]
  for (const k of keys) {
    const v = doc[k]
    if (k === 'rules' && Array.isArray(v)) {
      for (const r of v as Doc[]) lines.push('[[rules]]', ...Object.entries(r).map(([rk, rv]) => `${key(rk)} = ${value(rv)}`), '')
    } else if (isTable(v)) {
      table(key(k), v)
    } else {
      top.push(`${key(k)} = ${value(v)}`)
    }
  }
  const head = [...(header ? ['# Written by `hydra migrate`. Edit freely: hydra re-reads this file when it changes.', '# Every key, explained: hydra.example.toml in the hydra repo; where each kind of setting lives: README › Configuration.', ''] : []), ...top, ...(top.length ? [''] : [])]
  return [...head, ...lines].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
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
    if (!steps.some(s => s.pending(input.stateDir)) && !UNHANDLED.some(f => existsSync(join(input.stateDir, f)))) {
      return { ok: false, errors: [`${toml} already has content and nothing is left to migrate: this state dir is migrated.`] }
    }
    try { existing = Bun.TOML.parse(existingText) as Doc } catch (e) {
      return { ok: false, errors: [`${toml} isn't valid TOML (${(e as Error).message}); fix it, then run hydra migrate again.`] }
    }
  }
  const unhandled = UNHANDLED.filter(f => existsSync(join(input.stateDir, f)))
  if (unhandled.length) {
    return { ok: false, errors: [`${unhandled.join(', ')} can't be migrated by this version, and its routes would go quiet; update hydra and run it again.`] }
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
  if (!outputs.length) return { ok: false, errors: ['nothing to migrate: no allowFrom in access.json and no specialists.json'] }
  const merged = mergeDocs([...(existing ? [existing] : []), ...outputs.map(o => o.doc)])
  if (merged.conflicts.length) return { ok: false, errors: merged.conflicts.map(c => `two sources disagree on ${c}`) }
  // A hydra.toml governs only once it names an operator; one without would retire allowFrom and leave nobody in charge.
  if (typeof merged.doc.operator !== 'string') return { ok: false, errors: ['no operator: access.json has no allowFrom to take one from. Add an allowFrom id (or write hydra.toml by hand).'] }
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
  for (const f of consumed) writes[`${f}.migrated`] ??= readFileSync(join(input.stateDir, f), 'utf8')
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

/** New text after an existing hydra.toml, which is kept exactly (line endings included); the new text follows in its style. */
export function appendText(existingText: string, body: string): string {
  const eol = existingText.includes('\r\n') ? '\r\n' : '\n'
  return existingText + (existingText === '' || existingText.endsWith('\n') ? '' : eol) + eol + body.replace(/\n/g, eol)
}

/**
 * What a merge adds to an existing hydra.toml, as tables to append; or why it can't be appended. Appending keeps the
 * operator's file (edits, comments) as it is, so a merge may only add: new tables, new [[rules]] after the existing
 * ones. TOML can't extend a table from the end of the file, so a change to an existing table or value is refused,
 * with the exact edits to make by hand. A table written inline or with dotted keys at the top of the file can't take
 * appended sub-tables either, and is refused by name.
 */
export function appendOnly(existing: Doc, merged: Doc, existingText = '', by = 'hydra migrate'): { doc: Doc; tables: string[] } | { refusal: string } {
  const doc: Doc = {}
  const tables: string[] = []
  const edits: string[] = []
  const lines = (where: string, was: Doc, now: Doc) => {
    for (const [k, v] of Object.entries(now)) {
      if (k in was && same(was[k], v)) continue
      let written: string
      try { written = value(v) } catch { written = JSON.stringify(v) }
      edits.push(`under ${where}: ${k in was ? 'set' : 'add'} ${key(k)} = ${written}`)
    }
  }
  const keys = [...ORDER.filter(k => k in merged), ...Object.keys(merged).filter(k => !ORDER.includes(k))]
  for (const k of keys) {
    const v = merged[k]
    const before = existing[k]
    if (k === 'rules' && Array.isArray(v)) {
      const old = Array.isArray(before) ? before : []
      if (!same(v.slice(0, old.length), old)) { edits.push('[[rules]]: the existing rules would change; compare them with hydra migrate --dry-run from a copy without hydra.toml'); continue }
      if (v.length > old.length) { doc.rules = v.slice(old.length); tables.push(`[[rules]] ×${v.length - old.length}`) }
    } else if (isTable(v) && Object.values(v).every(isTable) && (before === undefined || isTable(before))) {
      // A table of tables ([people.*], [specialists.*], …): each sub-table is new, or unchanged.
      for (const [sub, t] of Object.entries(v)) {
        const was = isTable(before) ? before[sub] : undefined
        if (was === undefined) { ((doc[k] ??= {}) as Doc)[sub] = t; tables.push(`[${k}.${key(sub)}]`) }
        else if (!same(was, t)) lines(`[${k}.${key(sub)}]`, was as Doc, t as Doc)
      }
    } else if (before === undefined) {
      if (!isTable(v)) { let w: string; try { w = value(v) } catch { w = JSON.stringify(v) } edits.push(`at the top, before any table: add ${key(k)} = ${w}`); continue }
      doc[k] = v
      tables.push(`[${k}]`)
    } else if (!same(before, v)) {
      if (isTable(v) && isTable(before)) lines(`[${k}]`, before, v)
      else { let w: string; try { w = value(v) } catch { w = JSON.stringify(v) } edits.push(`at the top: set ${key(k)} = ${w}`) }
    }
  }
  if (edits.length) return { refusal: `hydra migrate would change what hydra.toml already says, and TOML can't extend a table from the end of the file. Make these edits by hand, then run hydra migrate again:\n${edits.map(e => `- ${e}`).join('\n')}` }
  // Keys set at the top of the file (`people = { … }`, `people.dan.ids = …`) can't take appended [people.x] tables.
  const firstTable = existingText.search(/^\s*\[/m)
  const top = firstTable < 0 ? existingText : existingText.slice(0, firstTable)
  const inline = new Set([...top.matchAll(/^\s*([A-Za-z0-9_-]+)\s*[.=]/gm)].map(m => m[1]))
  const blocked = Object.keys(doc).filter(k => inline.has(k))
  if (blocked.length) return { refusal: `hydra.toml sets ${blocked.join(', ')} inline or with dotted keys at the top of the file (e.g. ${blocked[0]} = { … }), and ${by} can only append [${blocked[0]}.<id>] tables after it. Rewrite ${blocked.length > 1 ? 'them' : 'it'} as tables, then run ${by} again.` }
  return { doc, tables }
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
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
