// Compat shim — routes through EngineAdapter
import { resolveEngine } from './engines/instances.js'
import type { ProviderId } from './engines/engine-adapter.js'

export function providerFor(engine: ProviderId | undefined = 'claude') {
  return resolveEngine(engine ?? 'claude')
}
