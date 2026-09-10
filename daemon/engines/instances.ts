import { CodexEngine } from '../codex-engine.js'
import { ClaudeAdapter } from './claude-adapter.js'
import { CodexAdapter } from './codex-adapter.js'
import type { EngineAdapter, ProviderId } from './engine-adapter.js'

export const codexEngine = new CodexEngine()
export const engineAdapters = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(codexEngine),
} satisfies { [P in ProviderId]: EngineAdapter<P> }
