import type { EngineProfile } from './profile.js'

export const claude: EngineProfile = {
  label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true,
  defaultModel: 'spawn', recordsClaudeSessionId: true, dropsNotificationsAtStart: true, reportsTurnEnd: true, judgesOwnDeath: false,
  hasHourPromptCache: true, losesFirstTurnToExpiredLogin: true, waitsOutLongTools: true, distrustsMidTurnChannel: true,
  aliases: {
    'sonnet': 'claude-sonnet-5-5[1m]',
    'sonnet-5': 'claude-sonnet-5[1m]',
    'haiku': 'claude-haiku-4-5-20251001',
    'opus': 'claude-opus-5-5[1m]',
    'fable': 'claude-fable-5-2[1m]',
    'fable-5-1': 'claude-fable-5-1[1m]',
    'fable-5-2': 'claude-fable-5-2[1m]',
    'opus-5': 'claude-opus-5[1m]',
    'opus-5-5': 'claude-opus-5-5[1m]',
    'opus-4-7': 'claude-opus-4-7[1m]',
    'opus-4-8': 'claude-opus-4-8[1m]',
  },
}
