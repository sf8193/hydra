import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { watchHydraConfig, type HydraConfigWatch } from '../watch.js'
import type { LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: [] })
const GOOD = 'operator = "op"\n[people.op]\nids = ["slack:U0OP"]\n'
const GOOD2 = 'operator = "op2"\n[people.op2]\nids = ["slack:U0OP2"]\n'
const BAD = 'operator = "ghost"\n'

let dir: string
let w: HydraConfigWatch | undefined
afterEach(() => { w?.stop(); w = undefined; if (dir) rmSync(dir, { recursive: true, force: true }) })

function start(initial?: string, intervalMs = 20) {
  dir = mkdtempSync(join(tmpdir(), 'hydra-config-'))
  const path = join(dir, 'hydra.toml')
  if (initial !== undefined) writeFileSync(path, initial)
  const alerts: string[] = []
  const loads: (string | undefined)[] = []
  w = watchHydraConfig({ path, env, intervalMs, onAlert: t => alerts.push(t), onLoad: c => loads.push(c.operator) })
  return { path, alerts, loads, w }
}

describe('watchHydraConfig', () => {
  test('a missing file loads as the empty config', () => {
    const { w, alerts } = start()
    expect(w.initial.ok).toBe(true)
    expect(w.current().people).toEqual({})
    expect(alerts).toEqual([])
  })

  test('a failed load keeps the last good config and alerts once per distinct failure', () => {
    const { path, w, alerts, loads } = start(GOOD)
    expect(w.current().operator).toBe('op')
    writeFileSync(path, BAD)
    w.reload()
    expect(w.current().operator).toBe('op')
    expect(alerts).toEqual(['hydra.toml didn\'t load, so the last good config stays. It is retried every read, so fixing the file or the machine is enough:\nhydra.toml operator: "ghost" is not a person: declare [people.ghost]'])
    writeFileSync(path, `${BAD}# saved again\n`)
    w.reload()
    expect(alerts).toHaveLength(1)
    writeFileSync(path, GOOD2)
    w.reload()
    expect(w.current().operator).toBe('op2')
    expect(loads).toEqual(['op', 'op2'])
  })

  test('alerts again for the same failure after a good load in between', () => {
    const { path, w, alerts } = start(GOOD)
    writeFileSync(path, BAD); w.reload()
    writeFileSync(path, GOOD2); w.reload()
    writeFileSync(path, BAD); w.reload()
    expect(alerts).toHaveLength(2)
  })

  test('a failure the machine caused is retried with the same text, so fixing the machine is enough', () => {
    let exists = false
    dir = mkdtempSync(join(tmpdir(), 'hydra-config-'))
    const path = join(dir, 'hydra.toml')
    writeFileSync(path, `${GOOD}[specialists.ops]\nworkdir = "/srv/ops"\nlistens = ["cli"]\n`)
    const alerts: string[] = []
    w = watchHydraConfig({ path, env: { ...env, isDir: () => exists }, onAlert: t => alerts.push(t) })
    expect(w.initial.ok).toBe(false)
    expect(alerts[0]).toContain('fixing the file or the machine is enough')
    exists = true
    expect(w.reload()?.ok).toBe(true)
    expect(Object.keys(w.current().specialists)).toEqual(['ops'])
  })

  test('after a read error, the next good read loads again even unchanged, so whatever held its alert hears it', () => {
    const { path, w, loads, alerts } = start(GOOD)
    rmSync(path); mkdirSync(path)
    w.reload()
    expect(alerts[0]).toStartWith("hydra.toml couldn't be read")
    rmSync(path, { recursive: true }); writeFileSync(path, GOOD)
    expect(w.reload()?.ok).toBe(true)
    expect(loads).toEqual(['op', 'op'])
  })

  test('a failed first load leaves the empty config and says why', () => {
    const { w, alerts } = start(BAD)
    expect(w.initial.ok).toBe(false)
    expect(w.current().operator).toBeUndefined()
    expect(alerts).toHaveLength(1)
  })

  test('an unreadable file is a failed first load, not undefined', () => {
    dir = mkdtempSync(join(tmpdir(), 'hydra-config-'))
    const path = join(dir, 'hydra.toml')
    mkdirSync(path)
    const alerts: string[] = []
    w = watchHydraConfig({ path, env, onAlert: t => alerts.push(t) })
    expect(w.initial.ok).toBe(false)
    expect(alerts[0]).toStartWith("hydra.toml couldn't be read")
  })

  test('a file caught empty mid-save is read again before it empties the config', async () => {
    const { path, w, loads } = start(GOOD)
    writeFileSync(path, '')
    expect(w.reload()).toBeUndefined()
    expect(w.current().operator).toBe('op')
    writeFileSync(path, GOOD2)
    await Bun.sleep(400)
    expect(loads).toEqual(['op', 'op2'])
  })

  test('a file that stays empty empties the config, and says so', async () => {
    const { path, w, alerts } = start(GOOD)
    writeFileSync(path, '')
    w.reload()
    await Bun.sleep(400)
    expect(w.current().operator).toBeUndefined()
    expect(alerts).toEqual(['hydra.toml is empty or missing now, so the empty config is live: no people, specialists or connectors until it is restored.'])
  })

  test('a file that appears later is loaded', async () => {
    const { path, w } = start()
    writeFileSync(path, GOOD)
    const deadline = Date.now() + 3000
    while (w.current().operator !== 'op' && Date.now() < deadline) await Bun.sleep(20)
    expect(w.current().operator).toBe('op')
  })

  test('re-reads on change, an atomic replace included', async () => {
    const { path, w } = start(GOOD)
    writeFileSync(`${path}.tmp`, GOOD2)
    renameSync(`${path}.tmp`, path)
    const deadline = Date.now() + 3000
    while (w.current().operator !== 'op2' && Date.now() < deadline) await Bun.sleep(20)
    expect(w.current().operator).toBe('op2')
  })
})
