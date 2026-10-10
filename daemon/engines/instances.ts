import { codexEngine } from './codex-runtime.js'
import { transport } from '../bridge-transport.js'
import { ClaudeEngine } from './claude-engine.js'
import { CodexEngineAdapter } from './codex-engine-adapter.js'
import type { EngineAdapter, ProviderId } from './engine-adapter.js'

export { codexEngine }

// Exported by itself: main is always Claude and talks to it through ClaudeSubject, not the provider-neutral interface.
export const claudeEngine = new ClaudeEngine(transport)

export const engines: Record<ProviderId, EngineAdapter> = {
  claude: claudeEngine,
  codex: new CodexEngineAdapter(codexEngine),
}

export function resolveEngine(provider: ProviderId | undefined): EngineAdapter {
  return engines[provider ?? 'claude']
}
