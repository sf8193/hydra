// hydra.toml as a document: merge partial docs (people by address), write tables as TOML, and append to an operator's
// file without changing a byte of it. Pure; reading and writing the file is the callers' (infra/migrate.ts,
// infra/add-fragment.ts, infra/add-person.ts, config/admit.ts).

export const HYDRA_TOML = 'hydra.toml'

export type Doc = Record<string, unknown>

export const isTable = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

// --- merging docs ------------------------------------------------------------------------------------------------

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

type PersonDoc = { addresses: string[]; roles?: string[]; name?: string }

/**
 * Merges the steps' docs. People are merged by address (one address, one person; the first step's id wins, roles
 * are unioned), and a merged-away id is rewritten where the step referred to it (operator, a rule's person, a place's allow).
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
      const target = p.addresses.map(a => owner.get(a)).find(x => x !== undefined)
      let into = target
      if (!into) {
        into = id
        for (let n = 2; people[into]; n++) into = `${id}-${n}`
        if (into !== id) notes.push(`people.${id} from two sources with different addresses: the second is people.${into}`)
        people[into] = { addresses: [] }
      }
      if (into !== id) rename.set(id, into)
      const merged = people[into]
      for (const a of p.addresses) if (!merged.addresses.includes(a)) merged.addresses.push(a)
      for (const r of p.roles ?? []) if (!(merged.roles ??= []).includes(r)) merged.roles.push(r)
      if (p.name && !merged.name) merged.name = p.name
      for (const a of merged.addresses) owner.set(a, into)
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
      // A rule's person is its `person`, or, in a file not yet moved to the new name, its `from`.
      for (const r of rules as Doc[]) list.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'person' || k === 'from' ? renamed(v) : v])))
    }
    for (const place of Object.values(isTable(rest.places) ? rest.places : {})) {
      const access = isTable(place) ? place.access : undefined
      if (isTable(access) && Array.isArray(access.allow)) access.allow = access.allow.map(id => id === 'anyone' ? id : renamed(id))
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

const ORDER = ['operator', 'gateways', 'connectors', 'slack', 'people', 'defaults', 'specialists', 'places', 'schedules', 'rules', 'guard']

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
  const head = [...(header ? ['# Written by `hydra migrate`. Edit freely: hydra re-reads this file when it changes.', '# Every key, explained: hydra.example.toml in the hydra repo; where each kind of setting lives: docs/reference.md › Configuration.', ''] : []), ...top, ...(top.length ? [''] : [])]
  return [...head, ...lines].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// --- appending to the operator's file -----------------------------------------------------------------------------

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
  // Keys set at the top of the file (`people = { … }`, `people.op.addresses = …`) can't take appended [people.x] tables.
  const firstTable = existingText.search(/^\s*\[/m)
  const top = firstTable < 0 ? existingText : existingText.slice(0, firstTable)
  const inline = new Set([...top.matchAll(/^\s*([A-Za-z0-9_-]+)\s*[.=]/gm)].map(m => m[1]))
  const blocked = Object.keys(doc).filter(k => inline.has(k))
  if (blocked.length) return { refusal: `hydra.toml sets ${blocked.join(', ')} inline or with dotted keys at the top of the file (e.g. ${blocked[0]} = { … }), and ${by} can only append [${blocked[0]}.<id>] tables after it. Rewrite ${blocked.length > 1 ? 'them' : 'it'} as tables, then run ${by} again.` }
  return { doc, tables }
}
