// The launch policy's own rules: what differs between two policies (said field by field), what a stored one must be to be
// believed, the one remedy sentence, and the one rate limit behind every notice a thread is sent.
import { describe, expect, test } from 'bun:test'
import { NoticeLimiter } from '../notice-limit.js'
import { bornPolicy, OPERATOR_SCOPE, policyDrifted, policyIdFor, policyProblem, remedy, type LaunchPolicy } from '../scope.js'
import type { HydraConfig } from '../../config/types.js'

const server = (over: Partial<LaunchPolicy['servers'] extends (infer S)[] | undefined ? S : never> = {}) => ({ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['a'], ...over })
const confinedPolicy = (over: Partial<LaunchPolicy> = {}): LaunchPolicy => {
  const base = { specialist: 'ops', access: 'workdir' as const, workdir: '/w/ops', tools: ['Read', 'Grep'], servers: [server()], ...over }
  return { ...base, id: policyIdFor(base.workdir!, base.tools!, base.servers!) }
}
const operatorPolicy: LaunchPolicy = { specialist: 'ops', access: 'operator', id: OPERATOR_SCOPE }

describe('policyDrifted says what differs, field by field', () => {
  test('nothing differs: empty', () => {
    expect(policyDrifted(confinedPolicy(), confinedPolicy())).toEqual([])
    expect(policyDrifted(operatorPolicy, operatorPolicy)).toEqual([])
    expect(policyDrifted(undefined, operatorPolicy)).toEqual([])   // a record from before policies counts as the operator's
  })
  test('adding a tool to a listed server is named, with both lists (the case a names-only message could not tell apart)', () => {
    const diff = policyDrifted(confinedPolicy(), confinedPolicy({ servers: [server({ tools: ['a', 'b'] })] }))
    expect(diff).toEqual(['mcp datadog tools: a -> a,b'])
  })
  test.each([
    ['access', operatorPolicy, confinedPolicy(), ['access: operator -> workdir']],
    ['access back', confinedPolicy(), operatorPolicy, ['access: workdir -> operator']],
    ['folder', confinedPolicy(), confinedPolicy({ workdir: '/w/other' }), ['folder: /w/ops -> /w/other']],
    ['tools', confinedPolicy(), confinedPolicy({ tools: ['Read'] }), ['tools: Read,Grep -> Read']],
    ['a server command', confinedPolicy(), confinedPolicy({ servers: [server({ command: '/opt/dd' })] }), ['mcp datadog command: /usr/local/bin/datadog-mcp -> /opt/dd']],
    ['a server token variable', confinedPolicy(), confinedPolicy({ servers: [server({ tokenEnv: ['DD_API_KEY', 'DD_APP_KEY'] })] }), ['mcp datadog token_env: DD_API_KEY -> DD_API_KEY,DD_APP_KEY']],
    ['a server listed', confinedPolicy(), confinedPolicy({ servers: [server(), server({ name: 'loki', tools: ['q'] })] }), ['mcp loki: not listed -> listed (tools q)']],
    ['a server unlisted', confinedPolicy({ servers: [server(), server({ name: 'loki', tools: ['q'] })] }), confinedPolicy(), ['mcp loki: listed (tools q) -> not listed']],
    ['two at once', confinedPolicy(), confinedPolicy({ tools: ['Read'], workdir: '/w/x' }), ['folder: /w/ops -> /w/x', 'tools: Read,Grep -> Read']],
  ])('%s', (_what, a, b, expected) => {
    expect(policyDrifted(a, b)).toEqual(expected)
  })
  test('order of tools or servers is not a difference', () => {
    expect(policyDrifted(confinedPolicy({ tools: ['Read', 'Grep'] }), confinedPolicy({ tools: ['Grep', 'Read'] }))).toEqual([])
  })
  test('every difference the id sees is one the diff names (the two never disagree)', () => {
    const cases = [confinedPolicy({ workdir: '/w/z' }), confinedPolicy({ tools: ['Glob'] }), confinedPolicy({ servers: [] }), confinedPolicy({ servers: [server({ tools: ['b'] })] })]
    for (const c of cases) {
      expect(c.id).not.toBe(confinedPolicy().id)
      expect(policyDrifted(confinedPolicy(), c).length).toBeGreaterThan(0)
    }
  })
})

describe('a stored policy is believed only if its id matches its facts', () => {
  test('a policy built from facts is readable', () => {
    expect(policyProblem(confinedPolicy())).toBeUndefined()
    expect(policyProblem(operatorPolicy)).toBeUndefined()
  })
  test('an id that is not the facts\' own is not (a hand-edited sessions.json, a half-written record)', () => {
    expect(policyProblem({ ...confinedPolicy(), id: 'workdir:000000000000' })).toMatch(/does not match/)
    expect(policyProblem({ ...confinedPolicy(), tools: ['Read', 'Bash'] })).toMatch(/does not match/)
    expect(policyProblem({ ...confinedPolicy(), workdir: '/somewhere/else' })).toMatch(/does not match/)
  })
  test('an operator policy has the operator id and nothing else', () => {
    expect(policyProblem({ ...operatorPolicy, id: 'workdir:abc' })).toMatch(/does not match/)
  })
  test('a policy names no engine: the engine is the start\'s, not the record\'s', () => {
    expect('engine' in confinedPolicy()).toBe(false)
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

describe('bornPolicy from a config that skipped the loader', () => {
  const config = (over: Record<string, unknown>): HydraConfig => ({
    connectors: {}, slackApps: {}, people: {}, places: {}, schedules: {}, rules: [],
    specialists: { ops: { id: 'ops', workdir: '/w/ops', listens: [], allow: [], sessions: 'shared', max: 20, was: [], access: 'workdir', ...over } as any },
  })
  test('a workdir specialist with no tools list gets Read, Grep, Glob: the narrowest set, never every tool', () => {
    expect(bornPolicy('ops', config({}))!.tools).toEqual(['Read', 'Grep', 'Glob'])
  })
  test('a listed server nobody declared refuses, with the remedy', () => {
    expect(() => bornPolicy('ops', config({ mcp: ['nope'] }), 'ops-sess')).toThrow(/lists \[mcp\.nope\].*Run `hydra kill ops-sess`/s)
  })
})
