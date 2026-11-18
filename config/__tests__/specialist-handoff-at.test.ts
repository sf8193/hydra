// A specialist's `handoff_at`: the context percent at which its idle sessions are asked to hand off. A whole number 1-99, per specialist
// (never a default), and refused on a specialist whose sessions have no handoff tool (restricted, write-confined). Without it, a config loads as before.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const BASE = `operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[slack.apps.default]\nbot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"\n`
const toml = (body: string, defaults = '') => `${BASE}${defaults}[specialists.ops]\nworkdir = "/home/op/ops"\n${body}\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops"\n`
const load = (body: string, defaults = '') => loadHydraConfig(toml(body, defaults), env)
const errors = (body: string, defaults = '') => { const r = load(body, defaults); return r.ok ? [] : r.errors.map(line) }

describe('handoff_at = a context percent', () => {
  test.each([1, 30, 99])('%i loads', n => {
    const r = load(`handoff_at = ${n}`)
    expect(r.ok && r.config.specialists.ops.handoffAt).toBe(n)
  })

  test.each(['0', '100', '30.5', '-5', '"30"', '"30%"', 'true'])('%s is refused at the key', v => {
    expect(errors(`handoff_at = ${v}`)).toEqual(['specialists.ops.handoff_at: must be a whole number from 1 to 99 (a context percent)'])
  })

  test('a specialist without it loads exactly as before: no key at all', () => {
    const r = load('')
    expect(r.ok && Object.hasOwn(r.config.specialists.ops, 'handoffAt')).toBe(false)
  })

  test('it is per specialist: [defaults.specialist] refuses it', () => {
    expect(errors('', '[defaults.specialist]\nhandoff_at = 30\n')).toEqual(["defaults.specialist.handoff_at: can't be a default: it sets when one specialist's sessions hand off. Set it under [specialists.<id>]"])
  })

  test('a restricted specialist cannot hand off: a load error that says so', () => {
    const e = errors('restricted = true\nhandoff_at = 30')
    expect(e).toContain("specialists.ops.handoff_at: restricted specialists can't hand off: a restricted session has no handoff tool. Remove handoff_at, or set restricted = false")
  })

  test('a write-confined specialist cannot hand off either: it has no handoff tool', () => {
    const e = errors('can_only_write_to = "workdir"\nhandoff_at = 30')
    expect(e).toContain(`specialists.ops.handoff_at: write-confined specialists can't hand off: a write-confined session has no handoff tool. Remove handoff_at, or remove can_only_write_to`)
  })
})
