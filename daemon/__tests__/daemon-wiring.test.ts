import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Two lower layers hold a default that does nothing until daemon.ts sets it: specialists/targets.ts `targetDeps.stuckState` (no stuck dialog seen) and the Slack
// gateway's `operators` (nobody is an operator). The daemon is the only runtime entry that sets them, so a dropped line would fail open without an error.
const daemon = readFileSync(join(import.meta.dir, '..', '..', 'daemon.ts'), 'utf8')

test('daemon.ts hands the specialist delivery its stuck-state lookup', () => {
  expect(daemon).toMatch(/^targetDeps\.stuckState = confirmedStuckState$/m)
})

test('daemon.ts hands the Slack gateway its operator ids', () => {
  expect(daemon).toMatch(/\(gateway as any\)\.operators = operatorIds\b/)
})

test('the Slack gateway has the `operators` field daemon.ts assigns, and nobody is an operator until it does', async () => {
  const { SlackGateway } = await import('../../gateways/slack.js')
  const gw = new SlackGateway('xapp-test')
  expect('operators' in gw).toBe(true)
  expect(gw.operators()).toEqual([])
})
