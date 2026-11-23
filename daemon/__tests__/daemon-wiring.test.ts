import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Two lower layers hold a default that does nothing until daemon.ts sets it: app/targets.ts `targetDeps.stuckState` (no stuck dialog seen) and the Slack
// gateway's `operators` (nobody is an operator). The daemon is the only runtime entry that sets them, so a dropped line would fail open without an error.
const daemon = readFileSync(join(import.meta.dir, '..', '..', 'daemon.ts'), 'utf8')

test('daemon.ts hands the specialist delivery its stuck-state lookup', () => {
  expect(daemon).toMatch(/^targetDeps\.stuckState = confirmedStuckState$/m)
})

test('daemon.ts imports the Codex runtime and starts its boot sweep', () => {
  expect(daemon).toMatch(/^import \{ bindCodexRuntime, startCodexRuntime \} from '\.\/app\/codex-runtime\.js'$/m)
  expect(daemon).toMatch(/^bindCodexRuntime\(\)$/m)
  expect(daemon).toMatch(/^void startCodexRuntime\(engineRecords\(engines\.codex\)\)$/m)
})

test('daemon.ts hands the Slack runtime its delivery functions', () => {
  expect(daemon).toMatch(/^bindSlackDelivery\(\{ deliverToTarget, conversationSessionName, conversationSessionRunning, placesFree \}\)$/m)
})

test('daemon.ts arms the delivery gate before the bridge server starts', () => {
  expect(daemon).toMatch(/^setDeliveryGate\(deliveryRefusal\)$/m)
  expect(daemon.search(/^setDeliveryGate\(deliveryRefusal\)$/m)).toBeLessThan(daemon.search(/^startBridgeServer\(\)$/m))
})

test('daemon.ts binds the notice and Codex listeners before any engine starts', () => {
  const at = (re: RegExp) => daemon.search(re)
  const start = at(/^for \(const adapter of Object\.values\(engines\)\) \{$/m)
  expect(start).toBeGreaterThan(0)
  for (const re of [/^bindDeliveryNotice\(\)$/m, /^bindCodexRuntime\(\)$/m]) {
    expect(at(re)).toBeGreaterThan(-1)
    expect(at(re)).toBeLessThan(start)
  }
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

// The engine reads a server's token variable without checking it is set: doSpawnSession refuses a start whose token is missing before it launches (app/session-lifecycle.ts),
// and it is the only caller of `adapter.launch`. A second caller would skip that refusal, so the count is pinned.
test('doSpawnSession is the only production caller of adapter.launch', async () => {
  const { execFileSync } = await import('child_process')
  const root = join(import.meta.dir, '..', '..')
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter(f => f && !/(^|\/)(__tests__|node_modules)\//.test(f) && !f.startsWith('scripts/') && !f.endsWith('.test.ts'))
  const hits = files.filter(f => /\badapter[!?]*\.launch\b|\badapter[!?]*\.?\[\s*['"]launch['"]\s*\]/.test(readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '')))
  expect(hits).toEqual(['app/session-lifecycle.ts'])
})
