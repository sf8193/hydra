import { test, expect, afterEach } from 'bun:test'
import { engines } from '../engines/instances.js'
import { executeTool } from '../bridge-dispatch.js'
import { registry } from '../sessions.js'
import { _setUsageAlertsIO, _resetUsageAlertsIO } from '../usage-alerts.js'

process.stderr.write = (() => true) as any

const sent: string[] = []
function captureAlerts() {
  sent.length = 0
  _setUsageAlertsIO({ send: t => sent.push(t), log: () => {}, now: () => 0, platform: 'slack', load: () => ({}), save: () => {} })
}
afterEach(() => _resetUsageAlertsIO())

test('main reports usage: the alert owner posts the crossed threshold', async () => {
  captureAlerts()
  const result = await executeTool('report_usage', { rate_limits: [{ kind: 'five_hour', percent_used: 96 }, { kind: 'spend_limit', percent_used: 99 }] }, 'main')
  expect(result.isError).toBeUndefined()
  expect(result.content[0].text).toBe('recorded 1 window(s)')
  expect(sent).toEqual(['> ⚠️ Claude usage at **96%** of 5-hour limit.'])
})

test('malformed input is not an error to the caller', async () => {
  captureAlerts()
  const result = await executeTool('report_usage', { rate_limits: 'garbage' }, 'main')
  expect(result.isError).toBeUndefined()
  expect(result.content[0].text).toBe('recorded 0 window(s)')
  expect(sent).toEqual([])
})

test('a spawned session cannot report usage', async () => {
  captureAlerts()
  const sessionId = 'report-usage-owner'
  registry.set(sessionId, {
    sessionId, tmuxName: 'report-usage-owner', topic: '', threadId: 'ru-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner',
  } as any)
  try {
    const result = await executeTool('report_usage', { rate_limits: [{ kind: 'five_hour', percent_used: 96 }] }, sessionId)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('report_usage is not available to this session')
    expect(sent).toEqual([])
  } finally {
    registry.delete(sessionId)
  }
})
