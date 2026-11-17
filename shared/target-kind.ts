// What a target value says: `main`, `specialist:<name>` or `thread:<id>`, the `platform:thing` shape that places and addresses use.
// The one reader of that shape: `resolveTo` (specialists/targets.ts) adds the live specialist list for delivery and the CLI, and the
// hydra.toml loader passes the specialists it has loaded, so config checks and delivery never disagree about what a value means.
// Pure on purpose (shared/ can't import the daemon): `declared` says whether a specialist of that name exists.
//
// A value without a kind (`ops`, `1234`) is an error here. Stored state holds the bare form (`refOfBare`).
import { isSessionThread, SPECIALIST_NAME_RE } from './specialist-name.js'

export type TargetRef = { kind: 'main' } | { kind: 'specialist'; name: string } | { kind: 'thread'; threadId: string }

export type TargetRead =
  | { ok: true; ref: TargetRef }
  /** `undeclared`: well-formed, but no such specialist (each caller words that its own way). Else `error` says what is wrong. */
  | { ok: false; undeclared: string; error?: undefined }
  | { ok: false; error: string; undeclared?: undefined }

export const TARGET_FORMS = 'main, specialist:<name> or thread:<id>'

export function readTarget(raw: string, declared: (name: string) => boolean): TargetRead {
  const value = raw.trim()
  if (value === 'main') return { ok: true, ref: { kind: 'main' } }
  const colon = value.indexOf(':')
  if (colon < 0) return { ok: false, error: `"${value}" does not say its kind: a target is ${TARGET_FORMS}` }
  const kind = value.slice(0, colon)
  const rest = value.slice(colon + 1)
  if (kind === 'specialist') {
    if (rest === 'main') return { ok: false, error: `"${value}" names main as a specialist, but main is the operator's own session; write "main"` }
    if (isSessionThread(rest)) return { ok: false, error: `"${value}": a specialist's name needs a letter, and an all-digit value is a thread id; write "thread:${rest}" for the thread` }
    if (!SPECIALIST_NAME_RE.test(rest) || !declared(rest)) return { ok: false, undeclared: rest }
    return { ok: true, ref: { kind: 'specialist', name: rest } }
  }
  if (kind === 'thread') {
    if (!isSessionThread(rest)) return { ok: false, error: `"${value}": a thread id is all digits, like "thread:1234567890"` }
    return { ok: true, ref: { kind: 'thread', threadId: rest } }
  }
  return { ok: false, error: `"${value}" starts with "${kind}:", which is not a kind of target: a target is ${TARGET_FORMS}` }
}

/** The value as the toml and the CLI write it, and as every log and report prints it: `main`, `specialist:ops`, `thread:123`. */
export const spelled = (ref: TargetRef): string => ref.kind === 'main' ? 'main' : ref.kind === 'specialist' ? `specialist:${ref.name}` : `thread:${ref.threadId}`

/** The value as stored state holds it: `main`, a specialist's name, a thread id. */
export const bareOf = (ref: TargetRef): string => ref.kind === 'main' ? 'main' : ref.kind === 'specialist' ? ref.name : ref.threadId


/** A value as stored state holds it (`main`, a specialist's name, a thread id: never prefixed), read as a target. */
export const refOfBare = (bare: string): TargetRef => bare === 'main' ? { kind: 'main' } : isSessionThread(bare) ? { kind: 'thread', threadId: bare } : { kind: 'specialist', name: bare }

/** A stored (bare) value as the toml and the CLI write it, for printing: `main`, `specialist:ops`, `thread:1234`. */
export const spelledBare = (bare: string): string => spelled(refOfBare(bare))

/** A `to` that is either already spelled (`specialist:ops`) or in the stored form hydra's own callers hold (`ops`, `1234`), spelled. */
export const spelledTo = (to: string): string => to === 'main' || to.includes(':') ? to : spelledBare(to)
