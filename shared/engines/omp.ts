import { claude } from './claude.js'
import { codex } from './codex.js'
import type { EngineProfile } from './profile.js'

/** omp (oh-my-pi) runs the Claude and Codex models, so its aliases are theirs with an `omp-` prefix. */
export const omp: EngineProfile = {
  label: 'omp', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false,
  specialistRefusal: 'cannot restrict a session\'s tools, so a specialist cannot use it',
  aliases: Object.fromEntries(Object.entries({ ...claude.aliases, ...codex.aliases }).map(([alias, id]) => [`omp-${alias}`, id])),
}
