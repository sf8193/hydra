import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { executeTool, __test as dispatchTest } from '../bridge-dispatch.js'
import { onRunAdvance, __test } from '../protocol-runner.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { _resetForTesting as resetProtocolRegistry, finishPrivateProtocolChildLaunch, markPrivateProtocolChildLaunching, protocolChildRequiresPrivate, protocolSpawnRequiresPrivate, registerProtocolChild } from '../protocol-registry.js'
import { computeToolsForSession } from '../bridge-tools.js'
import reviewProto from '../../protocols/review.js'
import delegatedBuildProto from '../../protocols/delegated-build.js'

const { runs, threadToRun, sessionToRun } = __test!

function sess(sessionId: string, extra: Record<string, unknown> = {}) {
  registry.set(sessionId, {
    sessionId, tmuxName: sessionId, topic: '', threadId: `thread-${sessionId}`,
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner', ...extra,
  } as any)
}

function reviewRun(phase = 'critic_turn') {
  const run = {
    id: 'rh-run', protocol: reviewProto, threadId: 'rh-thread', ownerSessionId: 'rh-owner', phase,
    currentRound: 1, rounds: 3, startedAt: Date.now(), _extensions: 0, _phaseStartedAt: Date.now(),
    // Most helper lifecycle tests are not about the default Ponytail gate.
    // Opt out locally; gate tests explicitly request Ponytail below.
    params: { noPonytail: true }, participants: new Map([['critic', 'rh-critic'], ['owner', 'rh-owner']]),
    sessionToRole: new Map([['rh-critic', 'critic'], ['rh-owner', 'owner']]),
    protocolChildren: new Map(), disconnectTimers: new Map(), decisions: [], messageIds: [], statusHistory: [],
    strike: false, ext: {},
  } as any
  runs.set(run.id, run)
  threadToRun.set(run.threadId, run.id)
  sessionToRun.set('rh-critic', run.id)
  sessionToRun.set('rh-owner', run.id)
  return run
}

const IDS = ['rh-critic', 'rh-owner', 'rh-helper', 'rh-stranger']
let sends: any[]
let gwSends: any[]

beforeEach(() => {
  // other test files wipe the registry's hooks; restore the real runner hooks
  resetProtocolRegistry(); __test!.registerRunnerHooks()
  process.stderr.write = (() => true) as any
  sess('rh-critic', { sessionType: 'thread_guest', initiator: 'rh-owner' })
  sess('rh-owner')
  sess('rh-helper', { initiator: 'rh-critic', headless: true })
  sess('rh-stranger')
  sends = []; gwSends = []
  spyOn(transport, 'sendOrQueue').mockImplementation(((sid: string, msg: any) => { sends.push({ sid, msg }) }) as any)
  spyOn(gateway, 'send').mockImplementation((async (...a: any[]) => { gwSends.push(a); return { id: 'm1' } }) as any)
})

afterEach(() => {
  for (const id of IDS) registry.delete(id)
  for (const [, r] of runs) { if (r.timeout) clearTimeout(r.timeout) }
  runs.clear(); threadToRun.clear(); sessionToRun.clear()
  __test!.resetLifecycle()
  __test!.privateProtocolChildren.clear()
  ;(transport.sendOrQueue as any).mockRestore?.()
  ;(gateway.send as any).mockRestore?.()
})

describe('review critic helper capability', () => {
  test('private phase forces headless quiet spawn while ordinary spawn options stay unchanged', () => {
    reviewRun(); __test!.setRunTools(runs.get('rh-run')!)
    expect(protocolSpawnRequiresPrivate('rh-critic')).toBe(true)
    expect(protocolSpawnRequiresPrivate('rh-owner')).toBe(false)
    expect(dispatchTest!.resolveProtocolSpawnMode('rh-critic', false)).toEqual({ privateSpawn: true, headless: true, quiet: true })
    expect(dispatchTest!.resolveProtocolSpawnMode('rh-owner', false)).toEqual({ privateSpawn: false, headless: false, quiet: false })
  })

  test('privacy is installed before launch and survives a phase-exit race', async () => {
    const run = reviewRun(); __test!.setRunTools(run)
    registry.delete('rh-helper') // the child does not exist until launch returns
    markPrivateProtocolChildLaunching('rh-critic', 'rh-helper')
    expect(registerProtocolChild('rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })).toBe('registered')
    expect(protocolChildRequiresPrivate('rh-helper')).toBe(true)

    await onRunAdvance('rh-critic', 'Critique.', 'request_changes')
    expect(run.protocolChildren.has('rh-helper')).toBe(false)
    expect(protocolChildRequiresPrivate('rh-helper')).toBe(true)

    finishPrivateProtocolChildLaunch('rh-helper')
    expect(protocolChildRequiresPrivate('rh-helper')).toBe(false)
  })

  test('critic gets spawn/peek/kill only in critic_turn; owner never does; removed on exit', async () => {
    const run = reviewRun()
    __test!.setRunTools(run)
    expect(registry.get('rh-critic')?.capabilities).toContain('protocol_spawn')
    expect(registry.get('rh-owner')?.capabilities ?? []).not.toContain('protocol_spawn')
    const names = computeToolsForSession('thread_guest', new Set(['protocol_context', 'protocol_spawn'])).map(t => t.name)
    for (const t of ['spawn_session', 'peek_session', 'kill_session']) expect(names as string[]).toContain(t)

    await onRunAdvance('rh-critic', 'Critique.', 'request_changes')
    expect(run.phase).toBe('owner_turn')
    expect(registry.get('rh-critic')?.capabilities ?? []).not.toContain('protocol_spawn')
    expect(registry.get('rh-owner')?.capabilities ?? []).not.toContain('protocol_spawn')
  })

  test('owner receives the scoped capability only in subagent_review', () => {
    const run = reviewRun('subagent_review')
    __test!.setRunTools(run)
    expect(registry.get('rh-owner')?.capabilities).toContain('protocol_spawn')
    expect(registry.get('rh-critic')?.capabilities ?? []).not.toContain('protocol_spawn')
  })

  test('only the active critic registers helpers; helpers retired on phase exit', async () => {
    const run = reviewRun()
    const killed: string[] = []
    __test!.setLifecycle({ killSession: (async (i: any) => { killed.push(i.sessionId) }) as any })
    const meta = { headless: true, readThread: true, phaseBudgetMs: 60_000 }
    expect(__test!.registerChild(run, 'rh-owner', 'rh-helper', meta)).toBe(false)
    expect(__test!.registerChild(run, 'rh-critic', 'rh-helper', meta)).toBe(true)
    await onRunAdvance('rh-critic', 'Critique.', 'request_changes')
    await Promise.resolve()
    expect(run.protocolChildren.size).toBe(0)
    expect(killed).toEqual(['rh-helper'])
    // late spawn after the phase moved on: registration is refused so dispatch reaps it
    expect(__test!.registerChild(run, 'rh-critic', 'rh-late', meta)).toBe(false)
  })
})

describe('critic controls only its own helpers', () => {
  beforeEach(() => { __test!.setRunTools(reviewRun()) })

  test('peek: own helper allowed past the lineage check, stranger denied', async () => {
    // rh-helper is deliberately not registered as a protocol child here. The
    // initiator lineage is the general spawn ownership rule, not review-only.
    const own = await executeTool('peek_session', { name: 'rh-helper' }, 'rh-critic')
    expect(own.content[0].text).not.toContain('peek denied')
    const other = await executeTool('peek_session', { name: 'rh-stranger' }, 'rh-critic')
    expect(other.content[0].text).toContain('peek denied')
  })

  test('kill: stranger denied; owner cannot kill the critic', async () => {
    const other = await executeTool('kill_session', { session_id: 'rh-stranger' }, 'rh-critic')
    expect(other.content[0].text).toContain('you can only kill sessions you spawned')
    // even with the capability (subagent_review) and spawner lineage, a participant is protected
    registry.get('rh-owner')!.capabilities = ['protocol_spawn'] as any
    const res = await executeTool('kill_session', { session_id: 'rh-critic' }, 'rh-owner')
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('protocol participant')
  })

  test('owner cannot kill the critic even when shared-state tests race capability cleanup', async () => {
    // Tests in this file share the registry; pin the precondition instead of
    // depending on the prior capability-granting case having finished cleanup.
    delete registry.get('rh-owner')!.capabilities
    const res = await executeTool('kill_session', { session_id: 'rh-critic' }, 'rh-owner')
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/not available to this session|protocol participant/)
  })
})

describe('private delivery', () => {
  test('reaches the parent, creates no thread message', async () => {
    const res = await executeTool('send_to_thread', { target: 'rh-critic', type: 'result', text: 'found X', visibility: 'private' }, 'rh-helper')
    expect(res.isError).toBeUndefined()
    expect(gwSends).toHaveLength(0)
    expect(res.sentIds).toBeUndefined()
    expect(sends).toHaveLength(1)
    expect(sends[0].sid).toBe('rh-critic')
    expect(sends[0].msg.content).toContain('found X')
  })

  test('truncates oversized private results before recording or delivery', async () => {
    const run = reviewRun()
    __test!.registerChild(run, 'rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })
    const res = await executeTool('send_to_thread', {
      target: 'rh-critic', type: 'result', text: 'x'.repeat(70_000), visibility: 'private',
    }, 'rh-helper')
    expect(res.isError).toBeUndefined()
    expect(sends[0].msg.content).toContain('[private result truncated at 65536 characters]')
    expect(run.protocolChildren.get('rh-helper').result.length).toBeLessThan(66_000)
  })

  test('denied to arbitrary sessions, files, questions, and non-senders', async () => {
    for (const [target, extra, caller] of [
      ['rh-stranger', {}, 'rh-helper'],
      ['rh-owner', {}, 'rh-helper'],
      ['rh-critic', { files: ['/etc/hosts'] }, 'rh-helper'],
      ['rh-critic', { type: 'question' }, 'rh-helper'],
      ['rh-helper', {}, 'rh-critic'], // parent → child not supported
      ['rh-critic', {}, undefined],
    ] as const) {
      const res = await executeTool('send_to_thread', { target, type: 'result', text: 'x', visibility: 'private', ...extra }, caller)
      expect(res.isError).toBe(true)
    }
    expect(gwSends).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })

  test('invalid visibility rejected', async () => {
    const res = await executeTool('send_to_thread', { target: 'rh-critic', type: 'result', text: 'x', visibility: 'secret' }, 'rh-helper')
    expect(res.isError).toBe(true)
  })

  test('public default is unchanged: posts via the gateway', async () => {
    const res = await executeTool('send_to_thread', { target: 'rh-stranger', type: 'progress', text: 'hi' }, 'rh-owner')
    expect(res.isError).toBeUndefined()
    expect(gwSends).toHaveLength(1)
    expect(res.sentIds).toEqual(['m1'])
    expect(sends[0].msg.content).toContain('[progress from rh-owner] hi')
  })

  test('registered review helpers must use private; public is rejected', async () => {
    const run = reviewRun()
    __test!.registerChild(run, 'rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })
    const pub = await executeTool('send_to_thread', { target: 'rh-critic', type: 'result', text: 'x' }, 'rh-helper')
    expect(pub.isError).toBe(true)
    expect(pub.content[0].text).toContain('visibility="private"')
    expect(gwSends).toHaveLength(0)
    const priv = await executeTool('send_to_thread', { target: 'rh-critic', type: 'result', text: 'x', visibility: 'private' }, 'rh-helper')
    expect(priv.isError).toBeUndefined()
    expect(run.protocolChildren.get('rh-helper').result).toBe('x')
  })

  test('registered private helpers cannot bypass privacy with gateway-mutating tools', async () => {
    const run = reviewRun()
    __test!.registerChild(run, 'rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })
    for (const [name, args] of [
      ['reply', { chat_id: 'rh-thread', text: 'public leak' }],
      ['react', { chat_id: 'rh-thread', message_id: 'm1', emoji: 'x' }],
      ['edit_message', { chat_id: 'rh-thread', message_id: 'm1', text: 'mutate' }],
      ['delete_message', { chat_id: 'rh-thread', message_id: 'm1' }],
      ['watch_pr', { url: 'https://github.com/o/r/pull/1' }],
    ] as const) {
      const res = await executeTool(name, args, 'rh-helper')
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toContain('private protocol helper')
    }
    expect(gwSends).toHaveLength(0)
  })

  test('privacy remains enforced while phase-exit child termination is pending', async () => {
    const run = reviewRun()
    let finishKill!: () => void
    const killPending = new Promise<void>(resolve => { finishKill = resolve })
    __test!.setLifecycle({ killSession: (async () => { await killPending }) as any })
    __test!.registerChild(run, 'rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })

    await onRunAdvance('rh-critic', 'Critique.', 'request_changes')
    expect(run.protocolChildren.has('rh-helper')).toBe(false)
    expect(__test!.privateProtocolChildren.has('rh-helper')).toBe(true)
    const publicSendCount = gwSends.length
    const duringRetirement = await executeTool('send_to_thread', { target: 'rh-critic', type: 'result', text: 'late public leak' }, 'rh-helper')
    expect(duringRetirement.isError).toBe(true)
    expect(gwSends).toHaveLength(publicSendCount)

    finishKill()
    await killPending
    registry.delete('rh-helper')
    __test!.releasePrivateChildWhenGone('rh-helper')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(__test!.privateProtocolChildren.has('rh-helper')).toBe(false)
  })

  test('privacy survives phase exit when another kill already owns the helper', async () => {
    const run = reviewRun()
    __test!.registerChild(run, 'rh-critic', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })
    // Model the already-in-progress branch directly: the child record is gone,
    // but the live registry entry means privacy must remain until disappearance.
    run.protocolChildren.delete('rh-helper')
    __test!.releasePrivateChildWhenGone('rh-helper')
    expect(__test!.privateProtocolChildren.has('rh-helper')).toBe(true)
    const blocked = await executeTool('reply', { chat_id: 'rh-thread', text: 'late leak' }, 'rh-helper')
    expect(blocked.isError).toBe(true)

    registry.delete('rh-helper')
    __test!.releasePrivateChildWhenGone('rh-helper')
    expect(__test!.privateProtocolChildren.has('rh-helper')).toBe(false)
  })
})

describe('critic prompt', () => {
  test('describes lens selection and private synthesis; keeps +lens modifiers', () => {
    const seed = reviewProto.seed('critic', { name: 'c', sessionId: 's', threadId: 't', rounds: 3, autoReviewLenses: true })!
    for (const s of ['native subagent', 'Agent tool', 'spawn_agent', 'do not poll', 'one-line purpose', 'Architecture', 'Correctness', 'Simplify']) {
      expect(seed).toContain(s)
    }
    expect(seed).not.toContain('spawn_session(')
    
    expect(seed).toContain('Stage 3: clean')
    expect(seed).toContain('.claude/commands/review.md')
    expect(seed).toContain('⬆ architectural')
    expect(seed).toContain('Settled')
  })
})

describe('staged review gate', () => {
  const seedMod = (name: string) => ({ type: 'seed', name, aliases: [], target: 'critic', instructions: name })
  const staged = (mods: string[] = []) => {
    const run = reviewRun()
    delete run.params.noPonytail
    run.params.autoReviewLenses = true
    run.params.modifiers = mods.map(seedMod)
    return run
  }

  test('non-approve rounds need no lens sections (lenses run in their stage)', async () => {
    staged(['architecture'])
    expect((await onRunAdvance('rh-critic', 'Stage 1: 2 findings', 'request_changes')).ok).toBe(true)
  })

  test('approve needs every required lens reported in some round; coverage accumulates across rounds', async () => {
    const run = staged(['architecture'])
    const early = await onRunAdvance('rh-critic', 'Stage 3: clean', 'approve')
    expect(early.ok).toBe(false)
    expect((early as any).reason).toContain('+architecture:')
    expect((early as any).reason).toContain('+ponytail:')
    expect((await onRunAdvance('rh-critic', '+architecture: boundary X leaks\nStage 1: 1 findings', 'request_changes')).ok).toBe(true)
    run.phase = 'critic_turn'
    expect((await onRunAdvance('rh-critic', '+ponytail: nothing to cut\nStage 3: 1 findings', 'request_changes')).ok).toBe(true)
    run.phase = 'critic_turn'
    expect(run.params.coveredLenses.sort()).toEqual(['architecture', 'ponytail'])
    expect((await onRunAdvance('rh-critic', 'Fixes verified.\nStage 3: clean', 'approve')).ok).toBe(true)
  })

  test('approve needs a clean stage-3 fresh pass, or a debate-only close', async () => {
    const run = staged()
    run.params.coveredLenses = ['ponytail']
    const denied = await onRunAdvance('rh-critic', 'All fixed, LGTM.', 'approve')
    expect(denied.ok).toBe(false)
    expect((denied as any).reason).toContain('Stage 3: clean')
    expect((await onRunAdvance('rh-critic', 'Owner rebutted both points; conceded.\nNo code changed since last clean pass', 'approve')).ok).toBe(true)
  })

  test('+no-lenses: no lens or stage requirement', async () => {
    const run = staged()
    run.params.noAutoLenses = true
    expect((await onRunAdvance('rh-critic', 'LGTM.', 'approve')).ok).toBe(true)
  })

  test('+subagent single pass: every required lens in the one summary', async () => {
    const run = reviewRun('subagent_review')
    run.params.modifiers = [seedMod('security'), seedMod('architecture')]
    const denied = await onRunAdvance('rh-owner', 'Summary.\n+security: none')
    expect(denied.ok).toBe(false)
    expect((denied as any).reason).toContain('+architecture:')
    expect((await onRunAdvance('rh-owner', 'Summary.\n+security: none\n+architecture: helper returned nothing')).ok).toBe(true)
  })

  test('section forms: common markdown accepted, mid-sentence and longer names rejected', async () => {
    for (const [form, ok] of [
      ['`+security:` none', true], ['- **+security:** none', true], ['1. +security: none', true], ['> +security: none', true],
      ['### +security', true], ['__+security__: none', true], ['### +security-review', false], ['I skipped the +security lens.', false],
    ] as const) {
      const run = reviewRun('subagent_review')
      run.params.modifiers = [seedMod('security')]
      expect([form, (await onRunAdvance('rh-owner', `Summary.\n${form}`)).ok]).toEqual([form, ok])
    }
  })
})

describe('delegated-build reviewer gate via private results', () => {
  test('private result counts only from the PM\'s own current-phase child; step_passed still needs proof', async () => {
    const run: any = {
      id: 'db-run', protocol: delegatedBuildProto, threadId: 'db-thread', ownerSessionId: 'rh-owner', phase: 'verifying',
      currentRound: 1, rounds: 5, startedAt: Date.now(), _extensions: 0, _phaseStartedAt: Date.now(), params: {},
      participants: new Map([['pm', 'rh-owner'], ['builder', 'rh-critic']]),
      sessionToRole: new Map([['rh-owner', 'pm'], ['rh-critic', 'builder']]),
      protocolChildren: new Map(), disconnectTimers: new Map(), decisions: [], messageIds: [], statusHistory: [], strike: false, ext: {},
    }
    runs.set(run.id, run); threadToRun.set(run.threadId, run.id)
    sessionToRun.set('rh-owner', run.id); sessionToRun.set('rh-critic', run.id)
    sess('rh-helper', { initiator: 'rh-owner', headless: true })
    // not registered as a child → result is not recorded, gate stays closed
    await executeTool('send_to_thread', { target: 'rh-owner', type: 'result', text: 'Verdict: PASS\nEvidence: x', visibility: 'private' }, 'rh-helper')
    const proof = 'Mechanical checks: ok\nReviewer: r\nEvidence: e'
    const denied = await onRunAdvance('rh-owner', proof, 'step_passed')
    expect(denied.ok).toBe(false)
    // qualified child, delivered privately → gate opens (same rules as a public result)
    __test!.registerChild(run, 'rh-owner', 'rh-helper', { headless: true, readThread: true, phaseBudgetMs: 1000 })
    await executeTool('send_to_thread', { target: 'rh-owner', type: 'result', text: 'Verdict: PASS\nEvidence: x', visibility: 'private' }, 'rh-helper')
    expect(run.protocolChildren.get('rh-helper').result).toContain('PASS')
    expect((await onRunAdvance('rh-owner', proof, 'step_passed')).ok).toBe(true)
  })
})
