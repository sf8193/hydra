import { CodexEngineAdapter, codexLaunchProcess } from '../../engines/codex-engine-adapter.js'
import { registry } from '../../sessions/registry.js'
import { codexPiggyback, type CodexPiggyback } from '../../sessions/codex-piggyback.js'

/** A CodexEngineAdapter over the live registry and piggyback buffer, as engine-instances builds it. */
export const codexAdapter = (engine: unknown, proc?: unknown, piggyback?: CodexPiggyback): CodexEngineAdapter =>
  new CodexEngineAdapter(engine as any, (proc ?? codexLaunchProcess) as any, piggyback ?? codexPiggyback, registry)
