import type { EngineProfile } from './profile.js'

// forkable: false: a Codex fork would launch its own app-server in a fresh CODEX_HOME, where the source's rollout is not found; launching in the source's home would restart its app-server.
export const codex: EngineProfile = {
  label: 'Codex', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: true,
  aliases: {
    'astra': 'gpt-6-astra',
    'sol': 'gpt-6.1-sol',
    'terra': 'gpt-5.6-terra',
    'luna': 'gpt-5.6-luna',
  },
  idPrefix: 'gpt-',
}
