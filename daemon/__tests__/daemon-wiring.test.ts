import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Two lower layers hold a default that does nothing until daemon.ts sets it: app/targets.ts `targetDeps.stuckState` (no stuck dialog seen) and the Slack
// gateway's `operators` (nobody is an operator). The daemon is the only runtime entry that sets them, so a dropped line would fail open without an error.
const daemon = readFileSync(join(import.meta.dir, '..', '..', 'daemon.ts'), 'utf8')

test('daemon.ts hands the specialist delivery its stuck-state lookup', () => {
  expect(daemon).toMatch(/^  targetDeps\.stuckState = confirmedStuckState$/m)
})

test('daemon.ts starts the Codex boot sweep', () => {
  expect(daemon).toMatch(/^import \{ startCodexRuntime \} from '\.\/app\/codex-runtime\.js'$/m)
  expect(daemon).toMatch(/^  void startCodexRuntime\(engineRecords\(engines\.codex\)\)$/m)
})

test('daemon.ts hands the Slack runtime its delivery functions', () => {
  expect(daemon).toMatch(/^  bindSlackDelivery\(\{ deliverToTarget, conversationSessionName, conversationSessionRunning, placesFree \}\)$/m)
})

test('daemon.ts arms the delivery gate before the bridge server starts', () => {
  expect(daemon).toMatch(/^  setDeliveryGate\(deliveryRefusal\)$/m)
  expect(daemon.search(/^  setDeliveryGate\(deliveryRefusal\)$/m)).toBeLessThan(daemon.search(/^  startBridgeServer\(\)$/m))
})

test('daemon.ts calls bindDaemon() before any engine starts, and bindDaemon() binds every listener module', () => {
  const start = daemon.search(/^  for \(const adapter of Object\.values\(engines\)\) \{$/m)
  expect(start).toBeGreaterThan(0)
  expect(daemon.search(/^  bindDaemon\(\)$/m)).toBeGreaterThan(-1)
  expect(daemon.search(/^  bindDaemon\(\)$/m)).toBeLessThan(start)
  const bind = readFileSync(join(import.meta.dir, '..', '..', 'app', 'bind.ts'), 'utf8')
  for (const name of ['bindPreviewConfig', 'bindSpecialistPointers', 'bindToolSurface', 'bindRestrictedLog', 'bindDeliveryNotice', 'bindPiggybackCleanup', 'bindCodexRuntime', 'bindRouter', 'bindCliIdempotency', 'bindPermissionCleanup', 'bindReplyGuardCleanup', 'bindSpecialistThreadDrop', 'bindTypedDeliveryFlush']) {
    expect(bind).toMatch(new RegExp(`^  ${name}\\(\\)$`, 'm'))
  }
})

test('daemon.ts starts the dashboard timers', () => {
  expect(daemon).toMatch(/^  startDashboardTimers\(\)$/m)
})

test('daemon.ts hands the Home tab its spawn handler', () => {
  expect(daemon).toMatch(/^    gateway\.homeSpawnHandler = runHomeSpawnAction$/m)
})

test('daemon.ts hands the gateway its outage recovery report', () => {
  expect(daemon).toMatch(/^  gateway\.onReconnectAfterOutage = sendRecoveryReport$/m)
})

test('daemon.ts runs the startup backfills in order: reply ids, then artifacts, then the background ones', () => {
  expect(daemon).toMatch(/^    await backfillLastReplyIds\(\)\n    await backfillArtifacts\(tmuxHasSession\)$/m)
  expect(daemon).toMatch(/^  startBackgroundBackfills\(\)$/m)
})

test('daemon.ts exports boot() and guards startup behind import.meta.main with no import-time side effects', async () => {
  expect(daemon).toMatch(/^export async function boot\(\): Promise<void> \{$/m)
  expect(daemon).toMatch(/^if \(import\.meta\.main\) \{\n  boot\(\)\.catch\(err => \{\n    process\.stderr\.write\(.+\)\n    process\.exit\(1\)\n  \}\)\n\}$/m)
  const beforeBoot = daemon.slice(0, daemon.indexOf('export async function boot('))
  const afterBoot = daemon.slice(daemon.indexOf('\nif (import.meta.main)'))
  for (const chunk of [beforeBoot, afterBoot]) {
    expect(chunk).not.toMatch(/^(?:setInterval|process\.on|start[A-Z]\w*)\(/m)
  }
  const { existsSync } = await import('fs')
  const { STATE_DIR } = await import('../../infra/config.js')
  const sigtermBefore = process.listenerCount('SIGTERM')
  const sigintBefore = process.listenerCount('SIGINT')
  const mod = await import('../../daemon.js')
  expect(typeof mod.boot).toBe('function')
  expect(existsSync(join(STATE_DIR, 'daemon.pid'))).toBe(false)
  expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
  expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
})

test('daemon.ts hands the Slack gateway its operator ids', () => {
  expect(daemon).toMatch(/^    gateway\.operators = operatorIds$/m)
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
  expect(hits).toEqual(['app/lifecycle/spawn.ts'])
})
