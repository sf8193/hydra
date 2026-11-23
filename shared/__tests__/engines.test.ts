import { expect, test } from 'bun:test'
import { ENGINES, ENGINE_PROFILES, engineProfile, engineLabel, engineLimitsAccess, type EngineName, type EngineProfile } from '../engines/index.js'

// What the spawn, respawn and notice paths used to decide by naming engines: Claude does everything, Codex takes templates only, omp and agy take none of them.
test('each engine\'s profile says what its sessions can be asked', () => {
  const asked = (e: EngineName) => { const { label, limitsAccess, forkable, enforcesReadOnly, takesTemplates } = ENGINE_PROFILES[e]; return { label, limitsAccess, forkable, enforcesReadOnly, takesTemplates } }
  expect(Object.fromEntries(ENGINES.map(e => [e, asked(e)]))).toEqual({
    claude: { label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true },
    codex: { label: 'Codex', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: true },
    omp: { label: 'omp', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
    agy: { label: 'agy', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
  })
})

test('an engine that names its models by prefix has every alias target under it', () => {
  for (const [engine, { aliases, idPrefix }] of Object.entries(ENGINE_PROFILES) as Array<[EngineName, EngineProfile]>) {
    if (idPrefix) for (const id of Object.values(aliases)) expect(`${engine}:${id}`).toStartWith(`${engine}:${idPrefix}`)
  }
  expect(ENGINE_PROFILES.codex.idPrefix).toBe('gpt-')
  expect(ENGINE_PROFILES.agy.idPrefix).toBe('gemini-')
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

// What the daemon used to decide by naming an engine, one capability per question. Each row is the four engines in order: claude, codex, omp, agy.
test('each capability that replaced an engine-name branch gives the answer the name did', () => {
  const table: Record<string, (e: EngineName) => unknown> = {
    recordsClaudeSessionId: e => engineProfile(e).recordsClaudeSessionId,
    dropsNotificationsAtStart: e => engineProfile(e).dropsNotificationsAtStart,
    reportsTurnEnd: e => engineProfile(e).reportsTurnEnd,
    judgesOwnDeath: e => engineProfile(e).judgesOwnDeath,
    hasHourPromptCache: e => engineProfile(e).hasHourPromptCache,
    losesFirstTurnToExpiredLogin: e => engineProfile(e).losesFirstTurnToExpiredLogin,
    waitsOutLongTools: e => engineProfile(e).waitsOutLongTools,
    distrustsMidTurnChannel: e => engineProfile(e).distrustsMidTurnChannel,
    defaultModel: e => engineProfile(e).defaultModel,
    forkable: e => engineProfile(e).forkable,
  }
  const T = true, F = false
  const expected: Record<string, unknown[]> = {
    recordsClaudeSessionId: [T, F, F, F],
    dropsNotificationsAtStart: [T, F, F, F],
    reportsTurnEnd: [T, F, F, F],
    judgesOwnDeath: [F, T, F, F],
    hasHourPromptCache: [T, F, F, F],
    losesFirstTurnToExpiredLogin: [T, F, F, F],
    waitsOutLongTools: [T, F, F, F],
    distrustsMidTurnChannel: [T, F, F, F],
    defaultModel: ['spawn', 'own', 'spawn', { alias: 'flash' }],
    forkable: [T, F, F, F],
  }
  for (const [name, read] of Object.entries(table)) expect({ [name]: ENGINES.map(read) }).toEqual({ [name]: expected[name]! })
})

test('an engine whose default model is an alias names one it has', () => {
  for (const engine of ENGINES) {
    const { defaultModel, aliases } = engineProfile(engine)
    if (typeof defaultModel === 'object') expect(aliases).toHaveProperty(defaultModel.alias)
  }
})

test('a record with no engine reads as Claude\'s profile', () => {
  expect(engineProfile(undefined)).toBe(ENGINE_PROFILES.claude)
})
