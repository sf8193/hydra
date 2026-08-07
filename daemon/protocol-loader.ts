// Protocol loader — resolves a protocol name to its DSL definition.
//
// Lives at the domain layer (peer of protocol-runner/protocol-registry) rather
// than under commands/, because domain modules load protocols too: factory.ts
// starts a review run without going through a command handler. Putting the
// loader in commands/ inverted the dependency direction (domain → commands).

import type { Protocol } from './protocol-dsl.js'

const VALID_NAME = /^[a-z][a-z0-9-]*$/

const protocols = new Map<string, Protocol>()

export async function getProtocol(name: string): Promise<Protocol> {
  let proto = protocols.get(name)
  if (proto) return proto
  if (!VALID_NAME.test(name)) throw new Error(`invalid protocol name "${name}"`)

  let mod: { default?: Protocol }
  try {
    mod = await import(`../protocols/${name}.js`)
  } catch (err) {
    // Node's dynamic import errors embed absolute filesystem paths. Surface a
    // stable message; the underlying error still reaches the daemon log.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`protocol "${name}" failed to load: ${detail}`)
  }

  const def = mod.default
  if (!def?.name) throw new Error(`protocol "${name}" has no default export`)
  if (def.name !== name) throw new Error(`protocol file "${name}" declares name "${def.name}"`)
  if (!def.phases || typeof def.phases !== 'object') throw new Error(`protocol "${name}" has no phases`)
  if (!def.initialPhase) throw new Error(`protocol "${name}" has no initialPhase`)
  if (!def.phases[def.initialPhase]) {
    throw new Error(`protocol "${name}" initialPhase "${def.initialPhase}" is not a declared phase`)
  }

  protocols.set(name, def)
  return def
}

/** Test seam — drops the module-level cache. */
export function _resetProtocolCacheForTesting(): void {
  protocols.clear()
}
