import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig, formatIssues } from '../load.js'
import { placesAnsweredBy } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { route } from '../../routing/route.js'
import type { Inbound } from '../../routing/route.js'

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
    expect(r.config.rules).toHaveLength(7)
    expect(r.config.specialists.deals.pinnedTo).toEqual(['sales'])
    expect(r.config.places['slack:#help'].defaultApp).toBe('default')
    // The confined specialist, its server and its place.
    expect(r.config.specialists.helpdesk).toMatchObject({ restricted: true, tools: ['Read', 'Grep', 'Glob'], mcpServerNames: ['datadog'], sendsTo: ['triage'] })
    expect(r.config.specialists.triage).toMatchObject({ restricted: true, sendsTo: ['helpdesk'] })
    expect(placesAnsweredBy(r.config, 'triage')).toEqual([])
    expect(placesAnsweredBy(r.config, 'crm')).toEqual(['slack:#help'])
    expect(r.config.mcpServers?.datadog.tools).toEqual(['search_logs', 'get_monitor'])
    expect(r.config.places['slack:#ops']).toMatchObject({ messages: 'all', linkPreviews: false })
    expect(r.config.places['slack:#help'].linkPreviews).toBe(true)
    expect(r.config.guard).toBeDefined()
    expect(r.config.vitals).toBeDefined()
  })

  // The rules read as their comments say: a rule the heard-through app cannot serve is skipped, so each message lands where the file says.
  test('routes the cases its rules describe', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', 'hydra.example.toml'), 'utf8')
    const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'] }))
    if (!r.ok) throw new Error(formatIssues(r.errors))
    // The operator's DMs arrive through the app that holds the operator token, and `route` never reads the token: pin where it sits.
    expect(r.config.slackApps.default.operatorTokenEnv).toBeDefined()
    expect(r.config.slackApps.sales.operatorTokenEnv).toBeUndefined()
    const to = (m: Partial<Inbound>) => { const d = route(r.config, { addressed: true, at: ['slack:#help'], ...m }); return d.fate === 'deliver' ? d.to : d.fate }
    expect(to({ from: 'slack:U0BOB', app: 'default' })).toBe('ops')            // finance via default: the first rule
    expect(to({ from: 'slack:U0BOB', app: 'sales' })).toBe('deals')            // via sales the first rule is skipped; the sales rule decides
    expect(to({ from: 'slack:U0ALICE', app: 'default' })).toBe('crm')
    expect(to({ from: 'slack:U0ALICE', app: 'sales' })).toBe('deals')
    expect(to({ from: 'slack:U0OP', at: ['slack:dm:alice'], app: 'default' })).toBe('ops') // the operator-token app hears that DM
    expect(to({ from: 'slack:U0BOB', at: ['slack:#ops'], app: 'sales' })).toBe('helpdesk')
  })
})
