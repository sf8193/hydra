// `hydra config add <fragment.toml>`: an outside repo's setup adds its [specialists.<id>] and [schedules.<id>] tables to
// a live hydra.toml. Each table is new (appended after the operator's text, which is kept exactly), already there
// (the same once loaded: nothing to do), or different (refused, with the edits that would make it so). The result is
// written only if it loads, under the same lock and compare-before-write as `hydra people add`.

import { readFileSync } from 'fs'
import { join } from 'path'
import { withHydraTomlLock, writeIfUnchanged } from './append.js'
import { formatIssues, loadHydraConfig, SCOPE_KEYS } from './load.js'
import { appendOnly, appendText, HYDRA_TOML, hydraTomlInUse, toToml } from './migrate.js'
import type { LoadEnv } from './types.js'

type Doc = Record<string, unknown>
const SECTIONS = ['specialists', 'schedules'] as const
type Section = typeof SECTIONS[number]
const isTable = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

export type AddFragmentPlan =
  | { ok: true; text: string; from: string; added: string[]; already: string[] }
  | { ok: false; error: string }

export function planAddFragment(stateDir: string, env: LoadEnv, fragmentText: string, source: string): AddFragmentPlan {
  const path = join(stateDir, HYDRA_TOML)
  if (!hydraTomlInUse(stateDir)) return { ok: false, error: `${path} isn't in use yet, and hydra config add only adds to it. Move this machine to hydra.toml first: hydra down && hydra migrate <platform> && hydra up` }
  let fragment: Doc
  try { fragment = Bun.TOML.parse(fragmentText) as Doc } catch (e) { return { ok: false, error: `${source} isn't valid TOML (${(e as Error).message})` } }
  const others = Object.keys(fragment).filter(k => !(SECTIONS as readonly string[]).includes(k))
  if (others.length) return { ok: false, error: `${source} sets ${others.join(', ')}; hydra config add takes only [specialists.<id>] and [schedules.<id>] tables (a person: hydra people add; anything else, including an [mcp.*] server, is a hand edit)` }
  const flat = SECTIONS.flatMap(sec => {
    const v = fragment[sec]
    return v === undefined ? [] : isTable(v) && Object.values(v).every(isTable) ? Object.entries(v).map(([id, t]) => ({ sec, id, t: t as Doc })) : [{ sec, id: '', t: {} }]
  })
  const loose = flat.find(e => e.id === '')
  if (loose) return { ok: false, error: `${source}: ${loose.sec} must be [${loose.sec}.<id>] tables` }
  // What a session may reach is the operator's to set by hand: a fragment comes from another repo, and a table it names can't widen or narrow that.
  const scoped = flat.flatMap(e => e.sec === 'specialists' ? SCOPE_KEYS.filter(k => k in e.t).map(k => `[specialists.${e.id}] ${k}`) : [])
  if (scoped.length) return { ok: false, error: `${source} sets ${scoped.join(', ')}: access, tools and mcp say what a specialist's session may reach, and only a hand edit of hydra.toml sets them (and the [mcp.*] servers they name)` }
  if (!flat.length) return { ok: false, error: `${source} has no [specialists.<id>] or [schedules.<id>] table to add` }

  const existingText = readFileSync(path, 'utf8')
  let existing: Doc
  try { existing = Bun.TOML.parse(existingText) as Doc } catch (e) { return { ok: false, error: `hydra.toml isn't valid TOML (${(e as Error).message}); fix it first` } }

  const added: string[] = []
  const already: string[] = []
  const edits: string[] = []
  const merged = structuredClone(existing)
  for (const { sec, id, t } of flat) {
    const name = `[${sec}.${id}]`
    const before = isTable(existing[sec]) ? (existing[sec] as Doc)[id] : undefined
    if (before === undefined) { ((merged[sec] ??= {}) as Doc)[id] = t; added.push(name); continue }
    if (isTable(before) && sameOnceLoaded(existing, sec, id, t, env)) { already.push(name); continue }
    edits.push(...differences(name, isTable(before) ? before : {}, t))
  }
  if (edits.length) return { ok: false, error: `hydra.toml already has ${edits.length > 1 ? 'tables' : 'a table'} the fragment would change, and hydra config add only adds. To take the fragment's version, edit hydra.toml by hand:\n${edits.map(e => `- ${e}`).join('\n')}` }
  if (!added.length) return { ok: true, text: existingText, from: existingText, added, already }

  const append = appendOnly(existing, merged, existingText, 'hydra config add')
  if ('refusal' in append) return { ok: false, error: append.refusal }
  const text = appendText(existingText, `# Added by \`hydra config add\` from ${source}.\n${toToml(append.doc, false)}`)
  const loaded = loadHydraConfig(text, env)
  if (!loaded.ok) return { ok: false, error: `hydra.toml wouldn't load with ${added.join(', ')}:\n${formatIssues(loaded.errors)}` }
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
