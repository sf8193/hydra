import { codexEngine } from '../engines/codex-runtime.js'
import { transport } from './bridge-transport.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { OmpEngine } from '../engines/omp-engine.js'
import { AgyEngine } from '../engines/agy-engine.js'
import type { EngineAdapter, ProviderId } from '../engines/engine-adapter.js'

export { codexEngine }

// Exported by itself: main is always Claude and talks to it through ClaudeSubject, not the provider-neutral interface.
export const claudeEngine = new ClaudeEngine(transport)

export const engines: Record<ProviderId, EngineAdapter> = {
  claude: claudeEngine,
  codex: new CodexEngineAdapter(codexEngine),
  omp: new OmpEngine(claudeEngine),
  agy: new AgyEngine(claudeEngine),
}

export function resolveEngine(provider: ProviderId | undefined): EngineAdapter {
  return engines[provider ?? 'claude']
}
