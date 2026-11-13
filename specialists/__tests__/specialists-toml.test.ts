import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, DEFAULT_SESSION_CHANNEL } from '../../daemon/config.js'
import { _reloadSpecialists, getSpecialist, listSpecialists, removeSpecialist, setSpecialist, setSpecialistThread, specialistForThread } from '../specialists.js'
import { _setHydraConfigForTesting, hydraConfigPath, onHydraConfigLoad, startHydraConfig, stopHydraConfig } from '../../daemon/hydra-config.js'
import type { HydraConfig, Specialist as Declared } from '../../config/types.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

const threads = join(STATE_DIR, 'specialist-threads.json')
const legacy = join(STATE_DIR, 'specialists.json')

const declared = (id: string, extra: Partial<Declared> = {}): Declared =>
  ({ id, workdir: `/srv/${id}`, listens: [], allow: ['people'], sessions: 'shared', max: 20, was: [], access: 'operator', ...extra })
const config = (...specialists: Declared[]): HydraConfig => ({
  operator: 'op', connectors: {}, slackApps: {}, places: {}, schedules: {}, rules: [],
  people: { op: { id: 'op', ids: ['discord:100000000000000001'], roles: [], name: 'op' } },
  specialists: Object.fromEntries(specialists.map(s => [s.id, s])),
})

beforeEach(() => { rmSync(threads, { force: true }); rmSync(legacy, { force: true }); _reloadSpecialists() })
afterEach(() => { _setHydraConfigForTesting(undefined); rmSync(threads, { force: true }); rmSync(legacy, { force: true }); _reloadSpecialists() })

describe('specialists declared in hydra.toml', () => {
  test('the recipe comes from hydra.toml, mapped to the daemon\'s shape', () => {
    _setHydraConfigForTesting(config(declared('ops', { prompt: '/orient ops', model: 'm1', idleMs: 4 * 3_600_000, home: '123456789' })))
    expect(getSpecialist('ops')).toEqual({ channel: '123456789', kickoff: '/orient ops', model: 'm1', idle: '240m', workdir: '/srv/ops', updatedAt: 0 })
    expect(getSpecialist('crm')).toBeUndefined()
    expect(getSpecialist('constructor')).toBeUndefined()
    expect(listSpecialists().map(([name]) => name)).toEqual(['ops'])
  })

  test('a fill records only the pointer, in specialist-threads.json, and specialists.json is untouched', () => {
    writeFileSync(legacy, JSON.stringify({ old: { channel: 'C1', kickoff: 'k', updatedAt: 1 } }))
    _reloadSpecialists()
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' })))
    setSpecialistThread('ops', '900')
    expect(getSpecialist('ops')?.threadId).toBe('900')
    expect(specialistForThread('900')).toBe('ops')
    expect(Object.keys(JSON.parse(readFileSync(threads, 'utf8')))).toEqual(['ops'])
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual({ old: { channel: 'C1', kickoff: 'k', updatedAt: 1 } })
    expect(() => setSpecialistThread('ghost', '901')).toThrow('no such specialist: ghost')
  })

  test('a rename keeps its thread through `was`, and the next write moves the pointer to the new id', () => {
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' })))
    setSpecialistThread('ops', '900')
    _setHydraConfigForTesting(config(declared('desk', { prompt: 'p', was: ['ops'] })))
    expect(getSpecialist('desk')?.threadId).toBe('900')
    setSpecialistThread('desk', '901')
    expect(Object.keys(JSON.parse(readFileSync(threads, 'utf8')))).toEqual(['desk'])
  })

  test('a load moves a renamed specialist\'s pointer to its new id, so dropping `was` later keeps its thread', () => {
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' })))
    setSpecialistThread('ops', '900')
    _setHydraConfigForTesting(config(declared('desk', { prompt: 'p', was: ['ops'] })))
    expect(Object.keys(JSON.parse(readFileSync(threads, 'utf8')))).toEqual(['desk'])
    _setHydraConfigForTesting(config(declared('desk', { prompt: 'p' })))
    expect(getSpecialist('desk')?.threadId).toBe('900')
    expect(specialistForThread('900')).toBe('desk')
  })

  test('a load keeps pointers for ids it doesn\'t declare (a save caught mid-write, a table commented out), and was wins over a leftover', () => {
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' }), declared('desk', { prompt: 'p' })))
    setSpecialistThread('ops', '900')
    setSpecialistThread('desk', '950')
    _setHydraConfigForTesting(config(declared('desk', { prompt: 'p' })))
    expect(JSON.parse(readFileSync(threads, 'utf8'))).toMatchObject({ ops: { threadId: '900' }, desk: { threadId: '950' } })
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' }), declared('desk', { prompt: 'p' })))
    expect(getSpecialist('ops')?.threadId).toBe('900')
    // desk renamed to ops: the rename means desk's thread, not ops's leftover.
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p', was: ['desk'] })))
    expect(getSpecialist('ops')?.threadId).toBe('950')
  })

  test('a daemon boot with hydra.toml keeps the pointers on disk (the first load reads the config it loaded)', () => {
    mkdirSync(join(STATE_DIR, 'ops-w'), { recursive: true })
    writeFileSync(hydraConfigPath(), `operator = "op"\n[people.op]\nids = ["discord:100000000000000001"]\n[specialists.ops]\nworkdir = "/srv/ops"\nprompt = "p"\nwas = ["old-ops"]\n`)
    writeFileSync(threads, JSON.stringify({ ops: { threadId: '900', updatedAt: 7 }, gone: { threadId: '901', updatedAt: 7 } }))
    _reloadSpecialists()
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(() => seen.push(getSpecialist('ops')?.threadId))
    startHydraConfig({ env: testLoadEnv({ home: '/h', sessionNames: [] }) })
    try {
      expect(seen).toEqual(['900'])
      expect(getSpecialist('ops')?.threadId).toBe('900')
      expect(JSON.parse(readFileSync(threads, 'utf8'))).toEqual({ ops: { threadId: '900', updatedAt: 7 }, gone: { threadId: '901', updatedAt: 7 } })
    } finally {
      off(); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true })
    }
  })

  test('an unreadable specialist-threads.json is never written over', () => {
    writeFileSync(threads, '{ not json')
    _reloadSpecialists()
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' })))
    expect(() => setSpecialistThread('ops', '900')).toThrow("couldn't be read")
    expect(readFileSync(threads, 'utf8')).toBe('{ not json')
  })

  test('a home that isn\'t a channel id here falls back to the default channel', () => {
    _setHydraConfigForTesting(config(declared('ops', { home: 'discord:#feed' }), declared('crm', { home: 'slack:C0TEST' }), declared('desk', { home: 'discord:200000000000000000' })))
    expect(getSpecialist('ops')?.channel).toBe(DEFAULT_SESSION_CHANNEL || undefined)
    expect(getSpecialist('crm')?.channel).toBe(DEFAULT_SESSION_CHANNEL || undefined)
    expect(getSpecialist('desk')?.channel).toBe('200000000000000000')
  })

  test('a hydra.toml that failed to load at boot declares nothing, and never falls back to specialists.json', () => {
    setSpecialist('old', { channel: 'C1', kickoff: 'k' })
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    startHydraConfig({ env: testLoadEnv({ home: '/h', sessionNames: [] }) })
    try {
      expect(getSpecialist('old')).toBeUndefined()
      expect(() => setSpecialist('new', { channel: 'C1', kickoff: 'k' })).toThrow('declared in hydra.toml')
    } finally {
      stopHydraConfig(); rmSync(hydraConfigPath(), { force: true })
    }
  })

  test('declaring or removing by hand is refused: hydra.toml is where recipes live', () => {
    _setHydraConfigForTesting(config(declared('ops')))
    expect(() => setSpecialist('ops', { channel: 'C1', kickoff: 'k' })).toThrow('declared in hydra.toml')
    expect(() => removeSpecialist('ops')).toThrow('declared in hydra.toml')
  })

  test('without hydra.toml, specialists.json still holds both halves', () => {
    setSpecialist('ops', { channel: 'C1', kickoff: 'k' })
    setSpecialistThread('ops', '900')
    expect(getSpecialist('ops')).toMatchObject({ channel: 'C1', kickoff: 'k', threadId: '900' })
    expect(existsSync(threads)).toBe(false)
  })
})
