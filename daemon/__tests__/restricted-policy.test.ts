// The launch policy's own rules: what differs between two policies (said field by field), what a stored one must be to be
// believed, the one remedy sentence, and the one rate limit behind every notice a thread is sent.
import { describe, expect, test } from 'bun:test'
import { NoticeLimiter } from '../../shared/notice-limit.js'
import { policyDrifted, policyProblem } from '../../app/restricted.js'
import { remedy, type LaunchPolicy, type PolicyServer, type RestrictedPolicy } from '../../shared/launch-policy.js'
import { OPERATOR_POLICY_ID, policyIdFor } from '../../app/restricted.js'

const server = (over: Partial<PolicyServer> = {}) => ({ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['a'], ...over })
const restrictedPolicy = (over: Partial<RestrictedPolicy> = {}): RestrictedPolicy => {
  const base = { specialist: 'ops', restricted: true as const, workdir: '/w/ops', tools: ['Read', 'Grep'], servers: [server()], ...over }
  return { ...base, id: policyIdFor(base.workdir, base.tools, base.servers) }
}
const operatorPolicy: LaunchPolicy = { specialist: 'ops', restricted: false, id: OPERATOR_POLICY_ID }

describe('policyDrifted says what differs, field by field', () => {
  test('nothing differs: empty', () => {
    expect(policyDrifted(restrictedPolicy(), restrictedPolicy())).toEqual([])
    expect(policyDrifted(operatorPolicy, operatorPolicy)).toEqual([])
    expect(policyDrifted(undefined, operatorPolicy)).toEqual([])   // a record from before policies counts as the operator's
  })
  test('adding a tool to a listed server is named, with both lists (the case a names-only message could not tell apart)', () => {
    const diff = policyDrifted(restrictedPolicy(), restrictedPolicy({ servers: [server({ tools: ['a', 'b'] })] }))
    expect(diff).toEqual(['mcp datadog tools: a -> a,b'])
  })
  test.each([
    ['restricted', operatorPolicy, restrictedPolicy(), ['restricted: false -> true']],
    ['restricted back', restrictedPolicy(), operatorPolicy, ['restricted: true -> false']],
    ['folder', restrictedPolicy(), restrictedPolicy({ workdir: '/w/other' }), ['folder: /w/ops -> /w/other']],
    ['tools', restrictedPolicy(), restrictedPolicy({ tools: ['Read'] }), ['tools: Read,Grep -> Read']],
    ['a server command', restrictedPolicy(), restrictedPolicy({ servers: [server({ command: '/opt/dd' })] }), ['mcp datadog command: /usr/local/bin/datadog-mcp -> /opt/dd']],
    ['a server token variable', restrictedPolicy(), restrictedPolicy({ servers: [server({ tokenEnv: ['DD_API_KEY', 'DD_APP_KEY'] })] }), ['mcp datadog token_env: DD_API_KEY -> DD_API_KEY,DD_APP_KEY']],
    ['a server listed', restrictedPolicy(), restrictedPolicy({ servers: [server(), server({ name: 'loki', tools: ['q'] })] }), ['mcp loki: not listed -> listed (tools q)']],
    ['a server unlisted', restrictedPolicy({ servers: [server(), server({ name: 'loki', tools: ['q'] })] }), restrictedPolicy(), ['mcp loki: listed (tools q) -> not listed']],
    ['two at once', restrictedPolicy(), restrictedPolicy({ tools: ['Read'], workdir: '/w/x' }), ['folder: /w/ops -> /w/x', 'tools: Read,Grep -> Read']],
  ])('%s', (_what, a, b, expected) => {
    expect(policyDrifted(a, b)).toEqual(expected)
  })
  test('order of tools or servers is not a difference', () => {
    expect(policyDrifted(restrictedPolicy({ tools: ['Read', 'Grep'] }), restrictedPolicy({ tools: ['Grep', 'Read'] }))).toEqual([])
  })
  test('every difference the id sees is one the diff names (the two never disagree)', () => {
    const cases = [restrictedPolicy({ workdir: '/w/z' }), restrictedPolicy({ tools: ['Glob'] }), restrictedPolicy({ servers: [] }), restrictedPolicy({ servers: [server({ tools: ['b'] })] })]
    for (const c of cases) {
      expect(c.id).not.toBe(restrictedPolicy().id)
      expect(policyDrifted(restrictedPolicy(), c).length).toBeGreaterThan(0)
    }
  })
})

describe('a stored policy is believed only if its id matches its facts', () => {
  test('a policy built from facts is readable', () => {
    expect(policyProblem(restrictedPolicy())).toBeUndefined()
    expect(policyProblem(operatorPolicy)).toBeUndefined()
  })
  test('an id that is not the facts\' own is not (a hand-edited sessions.json, a half-written record)', () => {
    expect(policyProblem({ ...restrictedPolicy(), id: 'workdir:000000000000' })).toMatch(/does not match/)
    expect(policyProblem({ ...restrictedPolicy(), tools: ['Read', 'Bash'] })).toMatch(/does not match/)
    expect(policyProblem({ ...restrictedPolicy(), canOnlyWriteTo: { workdir: '/w', denyCommands: [], cannotRead: [], servers: [] } })).toMatch(/has no can_only_write_to/)
    expect(policyProblem({ ...restrictedPolicy(), workdir: '/somewhere/else' })).toMatch(/does not match/)
  })
  test('an operator policy has the operator id and nothing else', () => {
    expect(policyProblem({ ...operatorPolicy, id: 'workdir:abc' })).toMatch(/does not match/)
  })
  test('a policy names no engine: the engine is the start\'s, not the record\'s', () => {
    expect('engine' in restrictedPolicy()).toBe(false)
  })
})

describe('one remedy sentence', () => {
  test('names the session, says what happens next, and says the file is re-read', () => {
    expect(remedy('ops-eu')).toBe('Run `hydra kill ops-eu`; the next message to the specialist starts a new session that re-reads hydra.toml.')
  })
})

describe('NoticeLimiter: at most once a minute per cause, and bounded', () => {
  test('the same cause inside the window is held back; after it, allowed again', () => {
    let t = 1_000
    const l = new NoticeLimiter({ windowMs: 60_000, max: 10, now: () => t })
    expect(l.allow('a')).toBe(true)
    expect(l.allow('a')).toBe(false)
    t += 59_999; expect(l.allow('a')).toBe(false)
    t += 2; expect(l.allow('a')).toBe(true)
  })
  test('causes are independent', () => {
    const l = new NoticeLimiter({ windowMs: 60_000, max: 10, now: () => 1 })
    expect(l.allow('a')).toBe(true)
    expect(l.allow('b')).toBe(true)
    expect(l.allow('a')).toBe(false)
  })
  test('it never holds more than max causes: the oldest go first, expired ones before that', () => {
    let t = 0
    const l = new NoticeLimiter({ windowMs: 60_000, max: 3, now: () => t })
    for (const k of ['a', 'b', 'c', 'd', 'e']) { t += 10; l.allow(k) }
    expect(l.size).toBeLessThanOrEqual(3)
    expect(l.allow('e')).toBe(false)   // the newest is remembered
    t += 120_000
    l.allow('f')
    expect(l.size).toBe(1)             // everything else had expired
  })
})
