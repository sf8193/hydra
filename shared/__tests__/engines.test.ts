import { expect, test } from 'bun:test'
import { ENGINES, ENGINE_PROFILES, engineLabel, engineLimitsAccess } from '../engines/index.js'

// What the spawn, respawn and notice paths used to decide by naming engines: Claude does everything, Codex takes templates only, omp and agy take none of them.
test('each engine\'s profile says what its sessions can be asked', () => {
  expect(ENGINE_PROFILES).toEqual({
    claude: { label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true },
    codex: { label: 'Codex', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: true },
    omp: { label: 'omp', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
    agy: { label: 'agy', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
  })
})

test('the engines are listed in this order', () => {
  expect(ENGINES).toEqual(['claude', 'codex', 'omp', 'agy'])
})

test('an engine\'s label and access come from its own profile; a session with no engine named is Claude\'s', () => {
  for (const engine of ENGINES) {
    expect(engineLabel(engine)).toBe(ENGINE_PROFILES[engine].label)
    expect(engineLimitsAccess(engine)).toBe(ENGINE_PROFILES[engine].limitsAccess)
  }
  expect(engineLabel(undefined)).toBe('Claude')
  expect(engineLimitsAccess(undefined)).toBe(true)
})
