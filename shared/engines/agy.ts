import type { EngineProfile } from './profile.js'

/** agy (Google Antigravity CLI). Gemini models run only on agy, so an alias needs no prefix. The ids are the ones `agy models` lists. */
export const agy: EngineProfile = {
  label: 'agy', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false,
  aliases: {
    'neon': 'gemini-4-neon-high',
    'carbon': 'gemini-4-carbon-high',
    'hydrogen': 'gemini-4-hydrogen-high',
    'argon': 'gemini-4-argon-high',
    'flash': 'gemini-3.8-flash-high',
  },
  idPrefix: 'gemini-',
}
