import { expect, test } from 'bun:test'
import { ENGINE_CAPABILITIES, engineLabel } from '../engine-capabilities.js'

// What the spawn, respawn and notice paths used to decide by naming engines: Claude does everything, Codex takes templates only, omp and agy take none of them.
test('each engine\'s row says what its sessions can be asked', () => {
  expect(ENGINE_CAPABILITIES).toEqual({
    claude: { label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true },
    codex: { label: 'Codex', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: true },
    omp: { label: 'omp', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
    agy: { label: 'agy', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
  })
})

test('a session with no engine named is Claude\'s', () => {
  expect(engineLabel(undefined)).toBe('Claude')
  expect(engineLabel('agy')).toBe('agy')
})
