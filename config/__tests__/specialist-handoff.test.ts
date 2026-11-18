// A specialist's handoff: `handoff_at_pct`, the context percent at which its idle sessions are replaced (a whole number 1-99, per specialist,
// never a default), and `handoff_protocol`, how: "letter" (the default) or "kill_and_respawn". A letter needs the handoff tool, which a
// restricted or write-confined session lacks, so such a specialist's line comes only with kill_and_respawn. Without either, a config loads as before.
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
const loaded = (body: string) => { const r = load(body); if (!r.ok) throw new Error(r.errors.map(line).join('\n')); return r.config.specialists.ops }

describe('handoff_at_pct = a context percent', () => {
  test.each([1, 30, 99])('%i loads', n => {
    expect(loaded(`handoff_at_pct = ${n}`).handoffAtPct).toBe(n)
  })

  test.each(['0', '100', '30.5', '-5', '"30"', '"30%"', 'true'])('%s is refused at the key', v => {
    expect(errors(`handoff_at_pct = ${v}`)).toEqual(['specialists.ops.handoff_at_pct: must be a whole number from 1 to 99 (a context percent)'])
  })

  test('a specialist without either key loads exactly as before: no key at all, and its protocol is a letter', () => {
    const s = loaded('')
    expect(Object.hasOwn(s, 'handoffAtPct')).toBe(false)
    expect(Object.hasOwn(s, 'handoffProtocol')).toBe(false)
  })

  test('both are per specialist: [defaults.specialist] refuses each', () => {
    expect(errors('', '[defaults.specialist]\nhandoff_at_pct = 30\n')).toEqual(["defaults.specialist.handoff_at_pct: can't be a default: it sets when one specialist's sessions hand off. Set it under [specialists.<id>]"])
    expect(errors('', '[defaults.specialist]\nhandoff_protocol = "kill_and_respawn"\n')).toEqual(["defaults.specialist.handoff_protocol: can't be a default: it sets how one specialist's sessions hand off. Set it under [specialists.<id>]"])
  })
})

describe('handoff_at, its old name', () => {
  test('fails to load at that key, naming the new one: never silently ignored', () => {
    expect(errors('handoff_at = 30')).toEqual(['specialists.ops.handoff_at: handoff_at is now handoff_at_pct: rename it'])
  })

  test('is one error among the file\'s others: every other key is still read and reported', () => {
    expect(errors('handoff_at = 30\nmax_sessions = 0')).toEqual([
      'specialists.ops.handoff_at: handoff_at is now handoff_at_pct: rename it',
      'specialists.ops.max_sessions: must be a whole number above 0',
    ])
  })
})

describe('handoff_protocol', () => {
  test.each(['letter', 'kill_and_respawn'] as const)('"%s" loads', p => {
    expect(loaded(`handoff_protocol = "${p}"`).handoffProtocol).toBe(p)
  })

  test.each(['"fresh"', '"Letter"', 'true', '1'])('%s is refused at the key', v => {
    expect(errors(`handoff_protocol = ${v}`)).toEqual([expect.stringMatching(/^specialists\.ops\.handoff_protocol: /)])
  })

  test('a restricted or write-confined specialist may have a line with kill_and_respawn', () => {
    expect(loaded('restricted = true\nhandoff_at_pct = 25\nhandoff_protocol = "kill_and_respawn"')).toMatchObject({ restricted: true, handoffAtPct: 25, handoffProtocol: 'kill_and_respawn' })
    expect(loaded('can_only_write_to = "workdir"\nhandoff_at_pct = 25\nhandoff_protocol = "kill_and_respawn"')).toMatchObject({ canOnlyWriteTo: 'workdir', handoffAtPct: 25, handoffProtocol: 'kill_and_respawn' })
    expect(loaded('restricted = true\nhandoff_protocol = "kill_and_respawn"')).toMatchObject({ restricted: true, handoffProtocol: 'kill_and_respawn' })
  })

  test.each(['', 'handoff_protocol = "letter"\n'])('a restricted specialist with a line and a letter (%p) fails to load, with the reason and the fix', protocol => {
    expect(errors(`restricted = true\n${protocol}handoff_at_pct = 30`)).toContain(`specialists.ops.handoff_at_pct: a restricted session has no handoff tool, so it can't write a letter. Set handoff_protocol = "kill_and_respawn" (a fresh session from the kickoff at the line), or remove handoff_at_pct`)
  })

  test.each(['', 'handoff_protocol = "letter"\n'])('a write-confined specialist with a line and a letter (%p) fails to load, with the reason and the fix', protocol => {
    expect(errors(`can_only_write_to = "workdir"\n${protocol}handoff_at_pct = 30`)).toContain(`specialists.ops.handoff_at_pct: a write-confined session has no handoff tool, so it can't write a letter. Set handoff_protocol = "kill_and_respawn" (a fresh session from the kickoff at the line), or remove handoff_at_pct`)
  })
})
