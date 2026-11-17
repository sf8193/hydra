// What a named value says: `person:alice`, `role:finance`, `app:sales`, the `platform:thing` shape that places, addresses and targets use.
// The one reader of that shape for the values that name a person, a role or an app (the hydra.toml loader and `hydra route` both use it).
// Pure: it splits a value and checks it against the kinds the key takes; whether the person, role or app exists is the caller's to say.
//
// A value without a kind is an error. The loaded config holds the bare name (a person's id, a role, an app id): within one kind a name is
// unique, and a name cannot be a person and a role at once.

export type ValueKind = 'person' | 'role' | 'app'

export type ValueRead =
  | { ok: true; kind: ValueKind; name: string }
  | { ok: false; error: string }

/** What a key takes, in words: `a person (person:<id>) or a role (role:<name>)`. */
const FORM: Record<ValueKind, string> = { person: 'person:<id>', role: 'role:<name>', app: 'app:<id>' }
export const kindsFor = (kinds: readonly ValueKind[]): string => kinds.map(k => FORM[k]).join(' or ')

/** `value` read as one of `kinds`. A prefix that is not one of them is an error that names the ones the key takes. */
export function readValue(raw: string, kinds: readonly ValueKind[]): ValueRead {
  const value = raw
  const colon = value.indexOf(':')
  if (colon < 0) return { ok: false, error: `"${value}" does not say its kind: write ${kindsFor(kinds)}` }
  const kind = value.slice(0, colon)
  const name = value.slice(colon + 1)
  if (!(kinds as readonly string[]).includes(kind)) return { ok: false, error: `"${value}" starts with "${kind}:", which is not a kind this key takes: write ${kindsFor(kinds)}` }
  if (!name) return { ok: false, error: `"${value}" names no ${kind}: write ${FORM[kind as ValueKind]}` }
  return { ok: true, kind: kind as ValueKind, name }
}

export const spelledPerson = (id: string): string => `person:${id}`
export const spelledRole = (role: string): string => `role:${role}`
export const spelledApp = (id: string): string => `app:${id}`

/** A rule's `person`, by what it is: a person from `people`, else a role. */
export const whoSpelled = (people: Record<string, unknown>, name: string): string => Object.hasOwn(people, name) ? spelledPerson(name) : spelledRole(name)
