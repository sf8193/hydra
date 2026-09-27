import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool, handoffDeps } from '../bridge-dispatch.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway, STATE_DIR } from '../config.js'
import { handleHandoffIntercept } from '../commands/thread.js'

process.stderr.write = (() => true) as any

const mk = (id: string, name: string, threadId: string) => registry.set(id, {
  sessionId: id, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner',
} as any)

test('handoff tool: refuses a missing or empty file; with a file, answers first and then hands off that session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'))
  const orig = { handOff: handoffDeps.handOff, send: gateway.send }
  const calls: Array<[string, string]> = []
  const sent: string[] = []
  handoffDeps.handOff = (async (info: any, path: string) => { calls.push([info.tmuxName, path]); return { name: 'fresh' } }) as any
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }
  mk('ho-1', 'flint', 'ho-thread')
  try {
    const empty = join(dir, 'empty.md'); writeFileSync(empty, '')
    expect((await executeTool('handoff', { path: join(dir, 'nope.md') }, 'ho-1')).isError).toBe(true)
    expect((await executeTool('handoff', { path: empty }, 'ho-1')).isError).toBe(true)
    expect(calls).toEqual([])

    const doc = join(dir, 'HANDOFF.md'); writeFileSync(doc, '# Goal\nx\n# Next action\ny\n')
    const res = await executeTool('handoff', { path: doc }, 'ho-1')
    expect(res.isError).toBeFalsy()
    expect(calls).toEqual([])            // not yet: the caller must get its answer before it is killed
    await Bun.sleep(700)
    expect(calls).toEqual([['flint', doc]])
    expect(sent.some(t => t.includes('`flint` handed off to `fresh`'))).toBe(true)
  } finally {
    handoffDeps.handOff = orig.handOff
    ;(gateway as any).send = orig.send
    registry.delete('ho-1')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handoff command: asks the live session to write a handoff file under STATE_DIR/handoffs and call the tool', async () => {
  const origSend = transport.sendOrQueue, origReact = gateway.react
  const delivered: Array<[string, any]> = []
  ;(transport as any).sendOrQueue = (id: string, msg: any) => { delivered.push([id, msg]) }
  ;(gateway as any).react = async () => {}
  mk('ho-2', 'pulse', 'ho-thread-2')
  registry.setThread('ho-thread-2', 'ho-2')
  try {
    await handleHandoffIntercept({ channelId: 'ho-thread-2', id: 'msg-1', isThread: true, content: 'handoff' } as any)
    expect(delivered.length).toBe(1)
    const [id, msg] = delivered[0]
    expect(id).toBe('ho-2')
    const path = msg.content.match(/path="([^"]+)"/)?.[1]
    expect(path?.startsWith(join(STATE_DIR, 'handoffs', 'pulse-'))).toBe(true)
    expect(existsSync(join(STATE_DIR, 'handoffs'))).toBe(true)
    expect(msg.content).toContain('Next action')
    expect(msg.content).toContain('Non-goals')
  } finally {
    ;(transport as any).sendOrQueue = origSend
    ;(gateway as any).react = origReact
    registry.delete('ho-2')
    registry.deleteThread('ho-thread-2')
  }
})

test('successor opts: same thread/label/worktree + carried deliverables; `handoff <model>` switches model+engine', async () => {
  const { handoffSpawnOpts } = await import('../session-lifecycle.js')
  const info = {
    sessionId: 'ho-3', tmuxName: 'flint', threadId: 'ho-thread-3', topic: 't', engine: 'claude', label: 'build',
    sessionMetadata: { model: 'claude-opus-5-5[1m]' }, worktreeRepo: '/r', worktreePath: '/r/wt', worktreeBranch: 'wt/flint',
    artifacts: ['pr#1'], contextLinks: ['l'], description: 'd',
  } as any
  expect(handoffSpawnOpts(info, '/h.md')).toMatchObject({
    existingThreadId: 'ho-thread-3', handedOffFrom: 'flint', artifact: '/h.md', model: 'claude-opus-5-5[1m]', engine: 'claude', inheritedLabel: 'build',
    preserveWorktree: true, reuseWorktree: { repo: '/r', path: '/r/wt', branch: 'wt/flint' },
    carryOver: { artifacts: ['pr#1'], contextLinks: ['l'], description: 'd' },
  })
  info.handoffSelection = { model: 'gpt-5.6-sol', engine: 'codex' }
  expect(handoffSpawnOpts(info, '/h.md')).toMatchObject({ model: 'gpt-5.6-sol', engine: 'codex' })
})

test('handOff: PR watches move to the successor; a second concurrent handoff is refused', async () => {
  const { handOff, handoffIO } = await import('../session-lifecycle.js')
  const { restoreWatches, getWatchesBySession, unwatchBySession } = await import('../pr-watch.js')
  const orig = { ...handoffIO }
  mk('ho-4', 'flint', 'ho-thread-4')
  const info = registry.get('ho-4')!
  restoreWatches([{ prUrl: 'https://github.com/o/r/pull/9', sessionId: 'x', threadId: 'x', createdAt: Date.now() } as any], 'ho-4', 'ho-thread-4')
  let spawned: any
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  handoffIO.killSession = (async (i: any) => { await gate; unwatchBySession(i.sessionId); registry.delete(i.sessionId) }) as any
  handoffIO.doSpawnSession = (async (_t: string, _c?: string, _m?: string, o?: any) => { spawned = o; mk('ho-5', 'fresh', 'ho-thread-4'); return { name: 'fresh', sessionId: 'ho-5', threadId: 'ho-thread-4', url: '' } }) as any
  try {
    const first = handOff(info, '/h.md')
    await expect(handOff(info, '/h.md')).rejects.toThrow('already handing off')
    release()
    expect((await first).name).toBe('fresh')
    expect(spawned.handedOffFrom).toBe('flint')
    expect(getWatchesBySession('ho-4')).toEqual([])
    expect(getWatchesBySession('ho-5').map(w => w.prUrl)).toEqual(['https://github.com/o/r/pull/9'])
  } finally {
    Object.assign(handoffIO, orig)
    unwatchBySession('ho-5'); registry.delete('ho-4'); registry.delete('ho-5')
  }
})
