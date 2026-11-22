import type { EngineProfile } from './profile.js'

export const claude: EngineProfile = { label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true }
