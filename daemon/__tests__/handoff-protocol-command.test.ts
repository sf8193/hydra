// The `handoff` command follows the session's specialist's handoff_protocol: kill_and_respawn restarts it fresh now (no letter is asked
// for), and a session that cannot write a letter (no handoff tool) is told so, instead of being sent an ask it can only ignore.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { autoHandoffIO } from '../../app/auto-handoff.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { withHandoffThread, waitFor } from './handoff-thread.js'
import { NotReplaced } from '../../specialists/specialist-deliver.js'
import type { HydraConfig, Specialist } from '../../config/types.js'
import type { SessionInfo } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { fakeAdapter } from './test-harness.js'

process.stderr.write = (() => true) as any

const configure = (over: Partial<Specialist> = {}) => _setHydraConfigForTesting({
  specialists: { ops: { id: 'ops', workdir: '/w', reachableBy: [], sessions: 'shared', maxSessions: 20, restricted: false, renamedFrom: [], ...over } },
} as unknown as HydraConfig)
const of = (specialist: string, restricted = false): SessionInfo['policy'] => ({ specialist, restricted, id: restricted ? 'restricted:x' : 'operator' }) as SessionInfo['policy']

/** Its bridge connected, and its turn `live` (idle unless said otherwise): what the idle gate reads. */
const connected: string[] = []
const at = (info: SessionInfo, live = 'idle') => {
  info.adapter = fakeAdapter({ turn: () => ({ activityAt: null, confirmedComplete: false, answer: () => null, live }) } as any)
  transport.bridges.set(info.sessionId, {} as any); connected.push(info.sessionId)
}

let restarted: string[] = []
const realIO = { ...autoHandoffIO }
beforeEach(() => {
  restarted = []
  autoHandoffIO.killAndRespawn = async (info: SessionInfo) => { restarted.push(info.sessionId) }
})
afterEach(() => { Object.assign(autoHandoffIO, realIO); _setHydraConfigForTesting(undefined); for (const id of connected.splice(0)) transport.bridges.delete(id) })

describe('the handoff command', () => {
  test('kill_and_respawn: the session is restarted fresh at once, and is asked for no letter', () => withHandoffThread(async t => {
    configure({ handoffProtocol: 'kill_and_respawn' })
    t.info.policy = of('ops'); at(t.info)
    await t.intercept()
    await waitFor(() => t.sent.length > 0)
    expect(restarted).toEqual([t.info.sessionId])
    expect(t.delivered).toEqual([])
    expect(t.sent).toEqual([expect.stringContaining(`🔄 \`${t.info.tmuxName}\` restarted fresh from its kickoff`)])
  }))

  test('kill_and_respawn on a restricted session, which has no handoff tool: restarted the same way', () => withHandoffThread(async t => {
    configure({ restricted: true, tools: ['Read'], mcpServerNames: [], handoffProtocol: 'kill_and_respawn' } as Partial<Specialist>)
    t.info.policy = of('ops', true); at(t.info)
    await t.intercept()
    expect(restarted).toEqual([t.info.sessionId])
    expect(t.delivered).toEqual([])
  }))

  test.each([
    ['a model', { model: 'claude-opus-5-5', engine: 'claude' }, undefined],
    ['a note', undefined, 'carry this'],
  ] as const)('kill_and_respawn with %s is refused: no letter carries it, and nothing restarts', (_what, selection, note) => withHandoffThread(async t => {
    configure({ handoffProtocol: 'kill_and_respawn' })
    t.info.policy = of('ops'); at(t.info)
    await t.intercept({}, selection as any, note)
    expect(restarted).toEqual([])
    expect(t.delivered).toEqual([])
    expect(t.sent).toEqual([expect.stringContaining('hands off by kill_and_respawn')])
  }))

  test('kill_and_respawn on a busy session is refused: ending it mid-turn would lose that work, and nothing resumes it', () => withHandoffThread(async t => {
    configure({ handoffProtocol: 'kill_and_respawn' })
    t.info.policy = of('ops'); at(t.info, 'working')
    await t.intercept()
    expect(restarted).toEqual([])
    expect(t.sent).toEqual([expect.stringContaining('is busy')])
  }))

  test('a refusal before anything ended says the session was not restarted, without promising a restart', () => withHandoffThread(async t => {
    configure({ handoffProtocol: 'kill_and_respawn' })
    t.info.policy = of('ops'); at(t.info)
    autoHandoffIO.killAndRespawn = async () => { throw new NotReplaced('already being replaced (or gone)', 5) }
    await t.intercept()
    await waitFor(() => t.sent.length > 0)
    expect(t.sent).toEqual([expect.stringContaining('was not restarted: already being replaced')])
    expect(t.sent[0]).not.toContain('starts it again')
  }))

  test('a letter (the default) is asked for, as before: nothing restarts', () => withHandoffThread(async t => {
    configure()
    t.info.policy = of('ops')
    await t.intercept()
    expect(restarted).toEqual([])
    expect(t.delivered).toHaveLength(1)
    expect(t.delivered[0].content).toContain('call the handoff tool')
  }))

  test('a letter asked of a restricted session, which has no handoff tool, is refused with the fix: no ask it can only ignore', () => withHandoffThread(async t => {
    configure({ restricted: true, tools: ['Read'], mcpServerNames: [] } as Partial<Specialist>)
    t.info.policy = of('ops', true)
    await t.intercept()
    expect(restarted).toEqual([])
    expect(t.delivered).toEqual([])
    expect(t.sent).toEqual([expect.stringContaining('has no handoff tool')])
    expect(t.sent[0]).toContain('handoff_protocol = "kill_and_respawn"')
  }))
})
