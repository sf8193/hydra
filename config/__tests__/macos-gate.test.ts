// The macOS version gate for restricted specialists that list servers: which versions are proven (one list, next to the sandbox profile),
// the opt-in key, and what `hydra config check` / the daemon's load say. The launch refusal is daemon/__tests__/restricted-launch.test.ts.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadHydraConfig } from '../load.js'
import type { HydraConfig, LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { PROVEN_MACOS_MAJORS, SANDBOX_EXEC, macosGateIssue, unprovenMacos } from '../server-sandbox.js'

describe('which macOS versions are proven', () => {
  test('the list is one place, and its versions are the ones the sandbox suite was run on by hand', () => {
    expect(PROVEN_MACOS_MAJORS).toEqual([15])
  })
  test.each(['15.7.9', '15.0', '15.0.1', '15'])('%s is proven: compared by major version', v => expect(unprovenMacos(v)).toBe(false))
  test.each(['14.6.1', '13.4', '12.7', '16.0', '26.1'])('%s is unproven', v => expect(unprovenMacos(v)).toBe(true))
  test('not macOS (no version) is not this gate: sandbox-exec being missing is its own refusal', () => expect(unprovenMacos(undefined)).toBe(false))
  test.each(['', 'garbage', '0.0'])('a version that cannot be read (%j) counts as unproven, never as proven', v => expect(unprovenMacos(v)).toBe(true))
  test('the words for an unreadable version say so, not "macOS ,"', () => {
    const w = macosGateIssue('', false)!
    expect(w).toContain('this Mac runs a macOS version hydra could not read, and')
    expect(w).not.toMatch(/macOS ,/)
  })
  test('the words name the version, the proven ones, the key and the other ways out', () => {
    const refused = macosGateIssue('13.4', false)!
    expect(refused).toContain('macOS 13.4')
    expect(refused).toContain('macOS 15')
    expect(refused).toContain('allow_unproven_macos = true')
    expect(refused).toContain('restricted = false')
    expect(macosGateIssue('13.4', true)).toContain('allow_unproven_macos = true')
    expect(macosGateIssue('15.7.9', false)).toBeUndefined()
    expect(macosGateIssue(undefined, false)).toBeUndefined()
  })
})

const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[mcp_servers.datadog]
command = "/usr/local/bin/datadog-mcp"
tools = ["search_logs"]
`
const specialist = (id: string, body: string) => `[specialists.${id}]\nworkdir = "~/agents/${id}"\nreachable_by = []\n${body}\n`
const env = (macosVersion: string | undefined): LoadEnv => testLoadEnv({ macosVersion, isDir: () => true, isCommand: c => c === SANDBOX_EXEC || c === '/usr/local/bin/datadog-mcp' })
const load = (text: string, macosVersion: string | undefined) => {
  const r = loadHydraConfig(text, env(macosVersion))
  if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
  return { config: r.config as HydraConfig, warnings: r.warnings.map(w => `${w.path}: ${w.message}`) }
}
const WITH_SERVER = `${BASE}${specialist('ops', 'restricted = true\nmcp_servers = ["datadog"]')}`
const gateWarnings = (w: string[]) => w.filter(x => x.includes('macOS'))

describe('[restricted] allow_unproven_macos', () => {
  test('is read into the config; absent is false', () => {
    expect(load(`${WITH_SERVER}[restricted]\nallow_unproven_macos = true\n`, '15.7.9').config.allowUnprovenMacos).toBe(true)
    expect(load(WITH_SERVER, '15.7.9').config.allowUnprovenMacos).toBeFalsy()
  })
  test('must be true or false', () => {
    const r = loadHydraConfig(`${WITH_SERVER}[restricted]\nallow_unproven_macos = "yes"\n`, env('15.7.9'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map(e => e.path)).toEqual(['restricted.allow_unproven_macos'])
  })
})

describe('what a load says about restricted servers on a macOS version', () => {
  test('proven version: nothing', () => expect(gateWarnings(load(WITH_SERVER, '15.7.9').warnings)).toEqual([]))
  test('not macOS: nothing', () => expect(gateWarnings(load(WITH_SERVER, undefined).warnings)).toEqual([]))
  test('unproven, no opt-in: a warning that the specialist is refused at launch, naming the way out', () => {
    const w = gateWarnings(load(WITH_SERVER, '13.4').warnings)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/^specialists\.ops\.mcp_servers: .*macOS 13\.4.*refused.*allow_unproven_macos = true/)
  })
  test('unproven with the opt-in: a warning that it runs on an unproven sandbox', () => {
    const w = gateWarnings(load(`${WITH_SERVER}[restricted]\nallow_unproven_macos = true\n`, '13.4').warnings)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/^specialists\.ops\.mcp_servers: .*macOS 13\.4.*unproven/)
    expect(w[0]).not.toMatch(/refused/)
  })
  test('a restricted specialist with no servers has no sandbox to prove, so no warning; nor does an operator one', () => {
    const text = `${BASE}${specialist('ops', 'restricted = true')}${specialist('desk', '')}`
    expect(gateWarnings(load(text, '13.4').warnings)).toEqual([])
  })
})

describe('the docs say what the list says', () => {
  test('docs/specialists.md names exactly the proven versions, and the opt-in key is in the README and the example', () => {
    const root = join(import.meta.dir, '..', '..')
    const slack = readFileSync(join(root, 'docs/specialists.md'), 'utf8')
    expect(slack).toContain(`: **${PROVEN_MACOS_MAJORS.join(', ')}** today.`)
    expect(slack).toContain('PROVEN_MACOS_MAJORS')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('allow_unproven_macos')
    expect(readFileSync(join(root, 'hydra.example.toml'), 'utf8')).toContain('allow_unproven_macos')
  })
})
