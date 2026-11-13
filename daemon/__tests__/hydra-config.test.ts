import { describe, test, expect, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLAUDE_CONFIG, STATE_DIR } from '../config.js'
import { _setHydraConfigForTesting, currentHydraConfig, hydraConfigPath, onHydraConfigLoad, retryHydraConfigAlert, startHydraConfig, stopHydraConfig } from '../hydra-config.js'
import { _resetScrubbedForTesting, capturedSpawnVars, scrubbedSpawnEnv } from '../../shared/spawn-env.js'
import type { LoadEnv } from '../../config/types.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })
// Discord addresses: the suite runs as the discord platform, and an operator with none there is alerted.
const config = (op: string) => `operator = "${op}"\n[people.${op}]\nids = ["discord:${[...op].map(c => c.charCodeAt(0)).join('')}"]\n`

afterEach(() => { _setHydraConfigForTesting(undefined); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true }) })

async function until(cond: () => boolean) {
  const deadline = Date.now() + 3000
  while (!cond() && Date.now() < deadline) await Bun.sleep(20)
}

describe('the daemon\'s live hydra.toml', () => {
  test('before start, and with no file, it is the empty config', () => {
    expect(currentHydraConfig().people).toEqual({})
    expect(startHydraConfig({ env }).ok).toBe(true)
    expect(currentHydraConfig().operator).toBeUndefined()
  })

  test('reads the state dir\'s hydra.toml, tells subscribers about each new load, and alerts on a bad one', async () => {
    writeFileSync(hydraConfigPath(), config('op'))
    const alerts: string[] = []
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(c => seen.push(c.operator))
    startHydraConfig({ env, alert: async t => { alerts.push(t); return true }, intervalMs: 20 })
    expect(currentHydraConfig().operator).toBe('op')
    writeFileSync(hydraConfigPath(), config('next'))
    await until(() => currentHydraConfig().operator === 'next')
    expect(seen).toEqual(['op', 'next'])
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    await until(() => alerts.length > 0)
    expect(currentHydraConfig().operator).toBe('next')
    expect(alerts[0]).toContain('"ghost" is not a person')
    off()
  })

  test('an alert that couldn\'t be delivered at boot is sent once the gateway is up', async () => {
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    let up = false
    const sent: string[] = []
    startHydraConfig({ env, intervalMs: 20, alert: async t => { if (!up) return false; sent.push(t); return true } })
    await Bun.sleep(100) // re-reads of the same bad file don't re-alert
    expect(sent).toEqual([])
    up = true
    await retryHydraConfigAlert()
    await retryHydraConfigAlert()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('"ghost" is not a person')
  })

  test('a retry while the first send is still in flight sends once', async () => {
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    const sent: string[] = []
    startHydraConfig({ env, alert: async t => { await Bun.sleep(50); sent.push(t); return true } })
    await retryHydraConfigAlert()
    await Bun.sleep(80)
    expect(sent).toHaveLength(1)
  })

  test('a good load drops an undelivered alert, so a stale one is never sent', async () => {
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    let up = false
    const sent: string[] = []
    startHydraConfig({ env, intervalMs: 20, alert: async t => { if (!up) return false; sent.push(t); return true } })
    writeFileSync(hydraConfigPath(), config('op'))
    await until(() => currentHydraConfig().operator === 'op')
    up = true
    await retryHydraConfigAlert()
    expect(sent).toEqual([])
  })

  test('a subscriber reading currentHydraConfig() during the first load sees that config, not the empty one', () => {
    writeFileSync(hydraConfigPath(), config('op'))
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(() => seen.push(currentHydraConfig().operator))
    startHydraConfig({ env })
    expect(seen).toEqual(['op'])
    off()
  })

  test('a load whose operator has no address on this platform alerts: nobody is in charge here', async () => {
    writeFileSync(hydraConfigPath(), 'operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n')
    const sent: string[] = []
    startHydraConfig({ env, alert: async t => { sent.push(t); return true } })
    await retryHydraConfigAlert()
    expect(sent.join('\n')).toContain('the operator op has no discord: address')
  })

  test('every good load logs one line: the operator and how many people, specialists and schedules', async () => {
    const lines: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((t: string) => { lines.push(String(t)); return true }) as typeof process.stderr.write
    try {
      writeFileSync(hydraConfigPath(), config('op') + '[people.b]\nids = ["discord:2"]\n')
      startHydraConfig({ env, intervalMs: 20 })
      expect(lines.filter(l => l.includes('hydra.toml loaded:'))).toEqual(['daemon: hydra.toml loaded: operator op, 2 people, 0 specialists, 0 schedules\n'])
      writeFileSync(hydraConfigPath(), config('next'))
      await until(() => currentHydraConfig().operator === 'next')
      expect(lines.filter(l => l.includes('hydra.toml loaded:')).at(-1)).toBe('daemon: hydra.toml loaded: operator next, 1 person, 0 specialists, 0 schedules\n')
    } finally {
      process.stderr.write = write
    }
  })

  test('a good load logs each specialist\'s effective access', () => {
    const lines: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((t: string) => { lines.push(String(t)); return true }) as typeof process.stderr.write
    try {
      writeFileSync(hydraConfigPath(), config('op') + '[specialists.ops]\nworkdir = "/tmp"\nallow = []\n[specialists.desk]\nworkdir = "/tmp"\nallow = []\naccess = "workdir"\n')
      startHydraConfig({ env })
      expect(lines.filter(l => l.includes('access ='))).toEqual(['daemon: hydra.toml: specialist ops access = operator\n', 'daemon: hydra.toml: specialist desk access = workdir (tools Read,Grep,Glob; mcp none)\n'])
    } finally {
      process.stderr.write = write
    }
  })

  test("the daemon's own load knows its state dir: a workdir inside it is refused (no test env passed)", () => {
    mkdirSync(join(STATE_DIR, 'inside'), { recursive: true })
    writeFileSync(hydraConfigPath(), config('op') + `[specialists.ops]\nworkdir = "${join(STATE_DIR, 'inside')}"\nallow = []\naccess = "workdir"\n`)
    const r = startHydraConfig()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.map(e => e.message).join('\n')).toContain(`is inside the state folder ${STATE_DIR}`)
  })

  test("and Claude's config folder, as the daemon's sessions get it, is private too", () => {
    mkdirSync(join(CLAUDE_CONFIG, 'projects-x'), { recursive: true })
    writeFileSync(hydraConfigPath(), config('op') + `[specialists.ops]\nworkdir = "${join(CLAUDE_CONFIG, 'projects-x')}"\nallow = []\naccess = "workdir"\n`)
    const r = startHydraConfig()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.map(e => e.message).join('\n')).toContain('CLAUDE_CONFIG_DIR')
  })

  test('a test can stand in for the file, and subscribers hear it', () => {
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(c => seen.push(c.operator))
    _setHydraConfigForTesting({ operator: 'op', connectors: {}, slackApps: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] })
    expect(currentHydraConfig().operator).toBe('op')
    expect(seen).toEqual(['op'])
    _setHydraConfigForTesting(undefined)
    expect(currentHydraConfig().operator).toBeUndefined()
    off()
  })

  test('a load keeps the token variables its Slack apps name from every session', () => {
    process.env.ACME_LOAD_TEST_BOT = 'xoxb-secret'
    try {
      writeFileSync(hydraConfigPath(), config('op') + '[slack.apps.default]\nbot_token_env = "ACME_LOAD_TEST_BOT"\n')
      startHydraConfig({ env })
      expect(process.env.ACME_LOAD_TEST_BOT).toBeUndefined()
      expect(capturedSpawnVars().ACME_LOAD_TEST_BOT).toBe('xoxb-secret')
      expect(scrubbedSpawnEnv({ ACME_LOAD_TEST_BOT: 'x' }).ACME_LOAD_TEST_BOT).toBeUndefined()
    } finally { delete process.env.ACME_LOAD_TEST_BOT; _resetScrubbedForTesting() }
  })

  test('a file that does not load still keeps the token variables it names from every session', () => {
    process.env.ACME_BAD_FILE_BOT = 'xoxb-secret'
    process.env.ACME_BAD_FILE_APP = 'xapp-secret'
    const write = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      // A validation error elsewhere (an operator that is no one), and a token variable on a Slack app.
      writeFileSync(hydraConfigPath(), 'operator = "ghost"\n[slack.apps.default]\nbot_token_env = "ACME_BAD_FILE_BOT"\n[connectors.slack]\napp_token_env = "ACME_BAD_FILE_APP"\nbot_token_env = "ACME_BAD_FILE_APP"\n')
      expect(startHydraConfig({ env }).ok).toBe(false)
      expect(process.env.ACME_BAD_FILE_BOT).toBeUndefined()
      expect(process.env.ACME_BAD_FILE_APP).toBeUndefined()
      expect(capturedSpawnVars().ACME_BAD_FILE_BOT).toBe('xoxb-secret')
      expect(scrubbedSpawnEnv({ ACME_BAD_FILE_APP: 'x' }).ACME_BAD_FILE_APP).toBeUndefined()
    } finally {
      process.stderr.write = write
      delete process.env.ACME_BAD_FILE_BOT; delete process.env.ACME_BAD_FILE_APP; _resetScrubbedForTesting()
    }
  })

  test('a second start is a no-op that returns the first result', () => {
    writeFileSync(hydraConfigPath(), config('op'))
    const first = startHydraConfig({ env })
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    expect(startHydraConfig({ env })).toBe(first)
  })
})
