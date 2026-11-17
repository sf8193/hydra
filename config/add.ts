// `hydra config add <fragment.toml>`: an outside repo's setup adds its [specialists.<id>] and [schedules.<id>] tables, and the
// [[rules]] that say where they are heard, to a live hydra.toml. Each table is new (appended after the operator's text, which is kept exactly), already there
// (the same once loaded: nothing to do), or different (refused, with the edits that would make it so). The result is
// A rule has no name to compare by: one the file already has (same place, app, person and target) is there; any other is appended after the file's
// own rules. The result is written only if it loads, under the same lock and compare-before-write as `hydra people add`.

import { readFileSync } from 'fs'
import { join } from 'path'
import { withHydraTomlLock, writeIfUnchanged } from './append.js'
import { formatIssues, loadHydraConfig, RESTRICTION_KEYS, RESTRICTION_OLD_KEYS, SCHEDULE_RENAMES, SPECIALIST_RENAMES } from './load.js'
import { appendOnly, appendText, HYDRA_TOML, hydraTomlInUse, toToml } from './migrate.js'
import type { LoadEnv } from './types.js'
import { isSessionThread } from '../shared/specialist-name.js'
import { readTarget, spelled } from '../shared/target-kind.js'

type Doc = Record<string, unknown>
const SECTIONS = ['specialists', 'schedules'] as const
type Section = typeof SECTIONS[number]
const isTable = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A fragment still written with a schedule's old `to`, `prompt` or `cwd` is added as `target`, `message` or `workdir`, so hydra.toml gets only the new names (the loader would warn on the old). Both names stay as written: the loader refuses them. */
const scheduleNamed = (t: Doc): Doc => Object.fromEntries(Object.entries(t).map(([k, v]) => {
  const r = SCHEDULE_RENAMES.find(x => x.from === k && !(x.to in t))
  return [r ? r.to : k, v]
}))

/** A bare specialist name in a schedule's `target` is added as `specialist:<name>`, so hydra.toml gets only the new spelling (the loader would warn on the bare one). `main`, a thread id and a prefixed value stay as written. */
const targetSpelled = (t: Doc): Doc => {
  const read = typeof t.target === 'string' ? readTarget(t.target, id => !isSessionThread(id)) : undefined
  return read?.ok && read.bare && read.ref.kind === 'specialist' ? { ...t, target: spelled(read.ref) } : t
}

/**
 * A fragment still written with a specialist's old key names is added under the new ones, so hydra.toml gets only the new names (the loader would
 * warn on the old). Both names stay as written: the loader refuses them. `access` is left as written: a fragment may not set it (a restriction), so it is refused below.
 */
const specialistNamed = (t: Doc): Doc => Object.fromEntries(Object.entries(t).map(([k, v]) => {
  const r = SPECIALIST_RENAMES.find(x => x.from === k && !x.values && !(x.to in t))
  return [r ? r.to : k, v]
}))

/** A rule as hydra.toml writes it: the old key names read as the new, and a bare target spelled with its kind. */
const ruleNamed = (t: Doc): Doc => {
  const keys = { at: 'place', from: 'person', to: 'target' } as const
  const named = Object.fromEntries(Object.entries(t).map(([k, v]) => [Object.hasOwn(keys, k) && !(keys[k as keyof typeof keys] in t) ? keys[k as keyof typeof keys] : k, v]))
  return targetSpelled(named)
}
const describeRule = (r: Doc): string => `[[rules]] ${[r.place !== undefined && `place = ${JSON.stringify(r.place)}`, r.app !== undefined && `app = ${JSON.stringify(r.app)}`, r.person !== undefined && `person = ${JSON.stringify(r.person)}`, `target = ${JSON.stringify(r.target)}`].filter(Boolean).join(', ')}`
const sameRule = (a: Doc, b: Doc): boolean => Bun.deepEquals(a, b)

export type AddFragmentPlan =
  | { ok: true; text: string; from: string; added: string[]; already: string[] }
  | { ok: false; error: string }

export function planAddFragment(stateDir: string, env: LoadEnv, fragmentText: string, source: string): AddFragmentPlan {
  const path = join(stateDir, HYDRA_TOML)
  if (!hydraTomlInUse(stateDir)) return { ok: false, error: `${path} isn't in use yet, and hydra config add only adds to it. Move this machine to hydra.toml first: hydra down && hydra migrate <platform> && hydra up` }
  let fragment: Doc
  try { fragment = Bun.TOML.parse(fragmentText) as Doc } catch (e) { return { ok: false, error: `${source} isn't valid TOML (${(e as Error).message})` } }
  const others = Object.keys(fragment).filter(k => !(SECTIONS as readonly string[]).includes(k) && k !== 'rules')
  if (others.length) return { ok: false, error: `${source} sets ${others.join(', ')}; hydra config add takes only [specialists.<id>] and [schedules.<id>] tables and [[rules]] (a person: hydra people add; anything else, including an [mcp.*] server, is a hand edit)` }
  const flat = SECTIONS.flatMap(sec => {
    const v = fragment[sec]
    return v === undefined ? [] : isTable(v) && Object.values(v).every(isTable) ? Object.entries(v).map(([id, t]) => ({ sec, id, t: sec === 'schedules' ? targetSpelled(scheduleNamed(t as Doc)) : specialistNamed(t as Doc) })) : [{ sec, id: '', t: {} }]
  })
  const loose = flat.find(e => e.id === '')
  if (loose) return { ok: false, error: `${source}: ${loose.sec} must be [${loose.sec}.<id>] tables` }
  if (fragment.rules !== undefined && !(Array.isArray(fragment.rules) && fragment.rules.every(isTable))) return { ok: false, error: `${source}: rules must be [[rules]] tables` }
  // An old `listens` on a specialist is added as the rules it means, so hydra.toml gets only [[rules]]: one per place, targeting that specialist.
  const listened: Doc[] = []
  for (const e of flat) {
    if (e.sec !== 'specialists' || !Array.isArray(e.t.listens)) continue
    for (const p of e.t.listens as unknown[]) if (typeof p === 'string') listened.push({ place: p, target: `specialist:${e.id}` })
    delete e.t.listens
  }
  const fragmentRules = [...((fragment.rules ?? []) as Doc[]).map(ruleNamed), ...listened].filter((r, i, all) => all.findIndex(x => sameRule(x, r)) === i)
  // What a session may reach is the operator's to set by hand: a fragment comes from another repo, and a table it names can't widen or narrow that.
  const restricted = flat.flatMap(e => e.sec === 'specialists' ? [...RESTRICTION_KEYS, ...RESTRICTION_OLD_KEYS].filter(k => k in e.t).map(k => `[specialists.${e.id}] ${k}`) : [])
  if (restricted.length) return { ok: false, error: `${source} sets ${restricted.join(', ')}: restricted, tools, mcp and talks_to say what a specialist's session may reach, and only a hand edit of hydra.toml sets them (and the [mcp.*] servers they name)` }
  if (!flat.length && !fragmentRules.length) return { ok: false, error: `${source} has no [specialists.<id>] or [schedules.<id>] table, or [[rules]] entry, to add` }

  const existingText = readFileSync(path, 'utf8')
  let existing: Doc
  try { existing = Bun.TOML.parse(existingText) as Doc } catch (e) { return { ok: false, error: `hydra.toml isn't valid TOML (${(e as Error).message}); fix it first` } }

  const added: string[] = []
  const already: string[] = []
  const edits: string[] = []
  const merged = structuredClone(existing)
  const haveRules = (Array.isArray(existing.rules) ? existing.rules : []).filter(isTable).map(ruleNamed)
  const newRules = fragmentRules.filter(r => !haveRules.some(h => sameRule(h, r)))
  for (const r of fragmentRules) if (!newRules.includes(r)) already.push(describeRule(r))
  if (newRules.length) merged.rules = [...(Array.isArray(existing.rules) ? existing.rules : []), ...newRules]
  for (const { sec, id, t } of flat) {
    const name = `[${sec}.${id}]`
    const before = isTable(existing[sec]) ? (existing[sec] as Doc)[id] : undefined
    if (before === undefined) { ((merged[sec] ??= {}) as Doc)[id] = t; added.push(name); continue }
    if (isTable(before) && sameOnceLoaded(existing, sec, id, t, env)) { already.push(name); continue }
    edits.push(...differences(name, isTable(before) ? before : {}, t))
  }
  added.push(...newRules.map(describeRule))
  if (edits.length) return { ok: false, error: `hydra.toml already has ${edits.length > 1 ? 'tables' : 'a table'} the fragment would change, and hydra config add only adds. To take the fragment's version, edit hydra.toml by hand:\n${edits.map(e => `- ${e}`).join('\n')}` }
  if (!added.length) return { ok: true, text: existingText, from: existingText, added, already }

  const append = appendOnly(existing, merged, existingText, 'hydra config add')
  if ('refusal' in append) return { ok: false, error: append.refusal }
  const text = appendText(existingText, `# Added by \`hydra config add\` from ${source}.\n${toToml(append.doc, false)}`)
  const loaded = loadHydraConfig(text, env)
  if (!loaded.ok) return { ok: false, error: `hydra.toml wouldn't load with ${added.join(', ')}:\n${formatIssues(loaded.errors)}` }
  // An appended rule comes after the file's own, so one for everyone at a place the file already sends somewhere (even through an old `listens`)
  // is the one that goes unmatched. Say so rather than quietly take the place: only a warning on the new rules themselves is the fragment's own business.
  const before = loadHydraConfig(existingText, env)
  const known = new Set(before.warnings.map(w => `${w.path}: ${w.message}`))
  const oldRules = Array.isArray(existing.rules) ? existing.rules.length : 0
  const takesFromFile = loaded.warnings.filter(w => /never matches|gets only some apps/.test(w.message) && !known.has(`${w.path}: ${w.message}`)
    && !(/^rules\[(\d+)\]$/.test(w.path) && Number(/^rules\[(\d+)\]$/.exec(w.path)![1]) >= oldRules))
  if (takesFromFile.length) return { ok: false, error: `${added.join(', ')} would take a place from what hydra.toml already says, and hydra config add only adds:\n${takesFromFile.map(w => `- ${w.path}: ${w.message}`).join('\n')}\nGive the rule a \`person\` or an \`app\`, or edit hydra.toml by hand.` }
  return { ok: true, text, from: existingText, added, already }
}

/** Plans and writes under hydra.toml.lock; writes nothing when every table is already there. */
export function addFragment(stateDir: string, env: LoadEnv, fragmentText: string, source: string, opts: { dryRun?: boolean } = {}): AddFragmentPlan {
  return withHydraTomlLock(stateDir, () => {
    const plan = planAddFragment(stateDir, env, fragmentText, source)
    if (!plan.ok || opts.dryRun || !plan.added.length) return plan
    const changed = writeIfUnchanged(stateDir, plan.from, plan.text)
    return changed ? { ok: false, error: changed } : plan
  }, error => ({ ok: false, error }))
}

/**
 * Whether the fragment's table means what hydra.toml's already does: both loaded, so a default written out on one side
 * (runner = "launchd") and left out on the other is the same. If either doesn't load, the text must match.
 */
function sameOnceLoaded(existing: Doc, sec: Section, id: string, t: Doc, env: LoadEnv): boolean {
  const before = (existing[sec] as Doc)[id]
  const raw = (v: unknown) => JSON.stringify(v, Object.keys(v as Doc).sort())
  try {
    const variant = structuredClone(existing);
    (variant[sec] as Doc)[id] = t
    const a = loadHydraConfig(toToml(existing), env)
    const b = loadHydraConfig(toToml(variant), env)
    if (a.ok && b.ok) return Bun.deepEquals(a.config[sec][id], b.config[sec][id])
  } catch {}
  return raw(before) === raw(t)
}

function differences(name: string, before: Doc, t: Doc): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(t)) if (!Bun.deepEquals(before[k], v)) out.push(`under ${name}: ${k in before ? 'set' : 'add'} ${k} = ${JSON.stringify(v)}`)
  for (const k of Object.keys(before)) if (!(k in t)) out.push(`under ${name}: remove ${k}`)
  return out.length ? out : [`${name} differs from the fragment once loaded`]
}
