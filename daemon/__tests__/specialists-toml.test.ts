import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, DEFAULT_SESSION_CHANNEL } from '../config.js'
import { _reloadSpecialists, getSpecialist, listSpecialists, removeSpecialist, setSpecialist, setSpecialistThread, specialistForThread } from '../specialists.js'
import { _setHydraConfigForTesting, hydraConfigPath, startHydraConfig, stopHydraConfig } from '../hydra-config.js'
import type { HydraConfig, Specialist as Declared } from '../../config/types.js'

const threads = join(STATE_DIR, 'specialist-threads.json')
const legacy = join(STATE_DIR, 'specialists.json')

const declared = (id: string, extra: Partial<Declared> = {}): Declared =>
  ({ id, workdir: `/srv/${id}`, listens: [], allow: ['people'], sessions: 'shared', max: 20, was: [], ...extra })
const config = (...specialists: Declared[]): HydraConfig => ({
  operator: 'op', connectors: {}, places: {}, schedules: {}, rules: [],
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

  test('a load drops pointers for ids no longer declared, so a later specialist reusing the id starts fresh', () => {
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p' }), declared('desk', { prompt: 'p' })))
    setSpecialistThread('ops', '900')
    setSpecialistThread('desk', '950')
    _setHydraConfigForTesting(config(declared('desk', { prompt: 'p' })))
    _setHydraConfigForTesting(config(declared('ops', { prompt: 'p', was: ['desk'] })))
    expect(getSpecialist('ops')?.threadId).toBe('950')
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
    startHydraConfig({ env: { home: '/h', isDir: () => true, isCommand: () => true, sessionNames: [] } })
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
