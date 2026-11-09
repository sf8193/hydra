// `hydra people add`: put a person on hydra.toml's roster, the way `hydra migrate` adds tables: merged with what's
// there (one address, one person), appended after the operator's text (which is kept exactly), and written only if
// the result loads. Removing someone is an edit to an existing table, which the operator (or the access skill) makes.

import { readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { formatIssues, loadHydraConfig, normalizeAddress } from './load.js'
import { appendOnly, appendText, HYDRA_TOML, hydraTomlInUse, mergeDocs, toToml } from './migrate.js'
import type { LoadEnv } from './types.js'

const ID_RE = /^[a-z0-9][a-z0-9-]*$/

export type AddPerson = { id: string; address: string; roles?: string[]; name?: string }
export type AddPersonPlan = { ok: true; text: string; added: string } | { ok: false; error: string }

export function planAddPerson(stateDir: string, env: LoadEnv, p: AddPerson): AddPersonPlan {
  if (!hydraTomlInUse(stateDir)) return { ok: false, error: `${join(stateDir, HYDRA_TOML)} isn't in use yet: people are still access.json's allowFrom (or run hydra migrate first)` }
  if (!ID_RE.test(p.id)) return { ok: false, error: `"${p.id}" must be lowercase letters, digits and dashes` }
  const address = normalizeAddress(p.address)
  if (!address) return { ok: false, error: `"${p.address}" is not an address: use discord:<user id>, slack:<user id> or github:<login>` }
  const path = join(stateDir, HYDRA_TOML)
  const existingText = readFileSync(path, 'utf8')
  let existing: Record<string, unknown>
  try { existing = Bun.TOML.parse(existingText) as Record<string, unknown> } catch (e) {
    return { ok: false, error: `hydra.toml isn't valid TOML (${(e as Error).message}); fix it first` }
  }
  const people = (existing.people ?? {}) as Record<string, { ids?: string[] }>
  const owner = Object.entries(people).find(([, q]) => (q.ids ?? []).map(a => normalizeAddress(a) ?? a).includes(address))
  if (owner) return { ok: false, error: `${address} already belongs to people.${owner[0]}` }
  if (Object.hasOwn(people, p.id)) return { ok: false, error: `people.${p.id} already exists: add ${address} to its ids in hydra.toml by hand (under [people.${p.id}]: ids = [..., "${address}"])` }
  const person = { ids: [address], ...(p.roles?.length && { roles: p.roles }), ...(p.name && { name: p.name }) }
  const merged = mergeDocs([existing, { people: { [p.id]: person } }])
  if (merged.conflicts.length) return { ok: false, error: merged.conflicts.join('; ') }
  const added = appendOnly(existing, merged.doc, existingText)
  if ('refusal' in added) return { ok: false, error: added.refusal }
  const text = appendText(existingText, toToml(added.doc, false))
  const loaded = loadHydraConfig(text, env)
  if (!loaded.ok) return { ok: false, error: `hydra.toml wouldn't load with people.${p.id}:\n${formatIssues(loaded.errors)}` }
  return { ok: true, text, added: `[people.${p.id}]` }
}

/** Writes the planned hydra.toml in one step, keeping the file's mode. The daemon re-reads it within a second. */
export function applyAddPerson(stateDir: string, text: string): void {
  const path = join(stateDir, HYDRA_TOML)
  const mode = statSync(path).mode & 0o777
  writeFileSync(`${path}.tmp`, text, { mode })
  renameSync(`${path}.tmp`, path)
}
