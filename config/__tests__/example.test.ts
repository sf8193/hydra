import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig, formatIssues } from '../load.js'
import { testLoadEnv } from './load-env.js'

// hydra.example.toml is the reference for every key: it must load, with no errors and no warnings, or it has drifted.
describe('hydra.example.toml', () => {
  test('loads clean', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', 'hydra.example.toml'), 'utf8')
    const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'] }))
    if (!r.ok) throw new Error(formatIssues(r.errors))
    expect(formatIssues(r.warnings.filter(w => !w.message.includes("the operator's account")))).toBe('')
    // Every table the schema has is shown.
    expect(Object.keys(r.config.gateways)).toEqual(['discord'])
    expect(Object.keys(r.config.connectors)).toEqual(['github'])
    expect(Object.keys(r.config.slackApps)).toEqual(['default', 'sales'])
    expect(r.config.specialists.crm.sessions).toBe('per-conversation')
    expect(r.config.schedules['disk-watch'].check).toBeDefined()
    expect(r.config.schedules['backup-watch']).toMatchObject({ runner: 'daemon', needs: ['internet'] })
    expect(r.config.rules).toHaveLength(3)
    expect(r.config.specialists.deals.pinnedTo).toEqual(['sales'])
    expect(r.config.places['slack:#help'].defaultApp).toBe('default')
    // The confined specialist, its server and its place.
    expect(r.config.specialists.helpdesk).toMatchObject({ restricted: true, tools: ['Read', 'Grep', 'Glob'], mcp: ['datadog'], talksTo: ['triage'] })
    expect(r.config.specialists.triage).toMatchObject({ restricted: true, listens: [], talksTo: ['helpdesk'] })
    expect(r.config.mcpServers?.datadog.tools).toEqual(['search_logs', 'get_monitor'])
    expect(r.config.places['slack:#ops']).toMatchObject({ messages: 'all', linkPreviews: false })
    expect(r.config.places['slack:#help'].linkPreviews).toBe(true)
    expect(r.config.guard).toBeDefined()
    expect(r.config.vitals).toBeDefined()
  })
})
