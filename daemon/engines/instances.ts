import { codexEngine } from '../codex-bootstrap.js'
import { ClaudeEngine } from './claude-engine.js'
import { CodexEngineAdapter } from './codex-engine-adapter.js'
import type { EngineAdapter, ProviderId } from './engine-adapter.js'

export { codexEngine }

export const engines: Record<ProviderId, EngineAdapter> = {
  claude: new ClaudeEngine(),
  codex: new CodexEngineAdapter(codexEngine),
}

export function resolveEngine(provider: ProviderId | undefined): EngineAdapter {
  return engines[provider ?? 'claude']
}
