import { describe, test, expect } from 'bun:test'
import { classifyBridgeStart, BRIDGE_MCP_SERVER, BRIDGE_CHANNEL_FLAG, describeBridgeAbsence, claimBridgeAbsenceReport, clearBridgeAbsenceReport } from '../bridge-preflight.js'

const STARTUP = '[DEBUG] [STARTUP] Loading MCP configs...'

describe('classifyBridgeStart', () => {
  test('bridge server present in a startup log → started', () => {
    const log = [
      STARTUP,
      `[DEBUG] MCP server "${BRIDGE_MCP_SERVER}": Starting connection with timeout of 30000ms`,
      `[DEBUG] MCP server "${BRIDGE_MCP_SERVER}": Successfully connected (transport: stdio) in 744ms`,
    ].join('\n')
    expect(classifyBridgeStart(log)).toBe('started')
  })

  test('startup log with every other server but not the bridge → never_started', () => {
    const log = [
      STARTUP,
      '[DEBUG] MCP server "plugin:slack:slack": Starting connection with timeout of 30000ms',
      '[DEBUG] MCP server "plugin:playwright:playwright": Starting connection with timeout of 30000ms',
      '[DEBUG] Loaded 2 skills from plugin discord default directory',
    ].join('\n')
    expect(classifyBridgeStart(log)).toBe('never_started')
  })

  test('log trimmed past its startup section → unknown, not never_started', () => {
    // The daemon front-trims spawn logs past 5MB. What survives is the tail of a
    // long-lived session — precisely one whose bridge did start.
    const log = '[DEBUG] MCP server "plugin:slack:slack": Received tools/list_changed notification'
    expect(classifyBridgeStart(log)).toBe('unknown')
  })

  test('unreadable log → unknown', () => {
    expect(classifyBridgeStart(null)).toBe('unknown')
  })

  test('a trimmed log still reports started when the bridge line survived', () => {
    const log = [STARTUP, `[DEBUG] MCP server "${BRIDGE_MCP_SERVER}": Channel notifications registered`].join('\n')
    expect(classifyBridgeStart(log)).toBe('started')
  })
})

describe('bridge identifiers', () => {
  test('channel flag and MCP server name derive from one plugin name', () => {
    expect(BRIDGE_CHANNEL_FLAG).toBe('plugin:discord@claude-plugins-official')
    expect(BRIDGE_MCP_SERVER).toBe('plugin:discord:discord')
  })
})

describe('describeBridgeAbsence', () => {
  test('distinguishes recoverable from terminal', () => {
    expect(describeBridgeAbsence('never_started')).toContain('cannot recover')
    expect(describeBridgeAbsence('started')).toContain('retries')
    expect(describeBridgeAbsence('unknown')).toContain('Could not determine')
  })
})

describe('claimBridgeAbsenceReport', () => {
  test('first caller claims, later callers do not — the thread hears it once', () => {
    const id = 'session-claim-once'
    expect(claimBridgeAbsenceReport(id)).toBe(true)
    expect(claimBridgeAbsenceReport(id)).toBe(false)
    expect(claimBridgeAbsenceReport(id)).toBe(false)
  })

  test('clearing lets a later loss be reported again', () => {
    const id = 'session-claim-reset'
    expect(claimBridgeAbsenceReport(id)).toBe(true)
    clearBridgeAbsenceReport(id)
    expect(claimBridgeAbsenceReport(id)).toBe(true)
  })

  test('claims are per session', () => {
    expect(claimBridgeAbsenceReport('session-a')).toBe(true)
    expect(claimBridgeAbsenceReport('session-b')).toBe(true)
  })
})
