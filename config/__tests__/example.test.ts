import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig, formatIssues } from '../load.js'

// hydra.example.toml is the reference for every key: it must load, with no errors and no warnings, or it has drifted.
describe('hydra.example.toml', () => {
  test('loads clean', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', 'hydra.example.toml'), 'utf8')
    const r = loadHydraConfig(text, { home: '/home/op', isDir: () => true, isCommand: () => true, sessionNames: ['spark'] })
    if (!r.ok) throw new Error(formatIssues(r.errors))
    expect(formatIssues(r.warnings)).toBe('')
    // Every table the schema has is shown.
    expect(Object.keys(r.config.connectors).sort()).toEqual(['discord', 'github'])
    expect(Object.keys(r.config.slackApps)).toEqual(['default', 'sales'])
    expect(r.config.specialists.crm.sessions).toBe('per-conversation')
    expect(r.config.schedules['disk-watch'].check).toBeDefined()
    expect(r.config.schedules['backup-watch']).toMatchObject({ runner: 'daemon', needs: ['internet'] })
    expect(r.config.rules).toHaveLength(1)
    expect(r.config.guard).toBeDefined()
    expect(r.config.vitals).toBeDefined()
  })
})
