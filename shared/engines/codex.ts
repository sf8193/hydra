import type { EngineProfile } from './profile.js'

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
