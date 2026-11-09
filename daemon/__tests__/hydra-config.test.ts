import { describe, test, expect, afterEach } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { _setHydraConfigForTesting, currentHydraConfig, hydraConfigPath, onHydraConfigLoad, startHydraConfig, stopHydraConfig } from '../hydra-config.js'
import type { LoadEnv } from '../../config/types.js'

const env: LoadEnv = { home: '/home/op', isDir: () => true, isCommand: () => true, sessionNames: [] }
const config = (op: string) => `operator = "${op}"\n[people.${op}]\nids = ["slack:U0${op.toUpperCase()}"]\n`

afterEach(() => { _setHydraConfigForTesting(undefined); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true }) })

async function until(cond: () => boolean) {
  const deadline = Date.now() + 3000
  while (!cond() && Date.now() < deadline) await Bun.sleep(20)
}

describe('the daemon\'s live hydra.toml', () => {
  test('before start, and with no file, it is the empty config', () => {
    expect(currentHydraConfig().people).toEqual({})
    expect(startHydraConfig({ env, alert: () => {} }).ok).toBe(true)
    expect(currentHydraConfig().operator).toBeUndefined()
  })

  test('reads the state dir\'s hydra.toml, tells subscribers about each new load, and alerts on a bad one', async () => {
    writeFileSync(hydraConfigPath(), config('op'))
    const alerts: string[] = []
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(c => seen.push(c.operator))
    startHydraConfig({ env, alert: t => alerts.push(t), intervalMs: 20 })
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

  test('a test can stand in for the file, and subscribers hear it', () => {
    const seen: (string | undefined)[] = []
    const off = onHydraConfigLoad(c => seen.push(c.operator))
    _setHydraConfigForTesting({ operator: 'op', connectors: {}, people: {}, specialists: {}, places: {}, schedules: {}, rules: [] })
    expect(currentHydraConfig().operator).toBe('op')
    expect(seen).toEqual(['op'])
    _setHydraConfigForTesting(undefined)
    expect(currentHydraConfig().operator).toBeUndefined()
    off()
  })

  test('a second start is a no-op that returns the first result', () => {
    writeFileSync(hydraConfigPath(), config('op'))
    const first = startHydraConfig({ env, alert: () => {} })
    writeFileSync(hydraConfigPath(), 'operator = "ghost"\n')
    expect(startHydraConfig({ env, alert: () => {} })).toBe(first)
  })
})
