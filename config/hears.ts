import type { Address, Person } from './types.js'

/**
 * Whether another app (a Slack or Discord bot) is heard at all: hydra.toml declares it, a `[people]` entry of its own holds its address. Declared, it
 * is a person: `allow`, `reachable_by` and the mention rule judge it as they judge anyone. Undeclared, it is not heard.
 * Never the operator's entry: an app message posted under the operator's address (a user token used through an app) gets no operator standing.
 * Hydra's own apps are never heard, declared or not: the caller drops those first.
 */
export function hearsApp(people: Readonly<Record<string, Person>>, operator: string | undefined, from: Address | undefined): boolean {
  return !!from && Object.values(people).some(p => p.id !== operator && p.addresses.includes(from))
}
