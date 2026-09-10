/** Compatibility lookup; native operations are implemented only by EngineAdapter. */
import type { SpawnOpts, ThreadSessionEntry } from './sessions.js'
import type { ProviderId } from './engines/engine-adapter.js'
import { engineAdapters } from './engines/instances.js'
export type { ProviderId, ProviderCapabilities, ProviderExecutionRef, ProviderRecoveryInput } from './engines/engine-adapter.js'
export { ensureCodexInteractiveSurface } from './engines/codex-surface.js'

export function codexForkSpawnOptions(identity: { threadId: string; homeName: string }, parentName: string): SpawnOpts {
  return {
    forkFrom: { codexThreadId: identity.threadId, codexHomeName: identity.homeName, parentName },
    engine: 'codex',
  }
}

export function providerFor(engine: ProviderId = 'claude') {
  return engineAdapters[engine]
}
export function providerForEntry(entry?: ThreadSessionEntry) {
  return providerFor(entry?.engine ?? (entry?.codexThreadId ? 'codex' : 'claude'))
}
