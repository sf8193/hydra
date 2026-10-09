import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '../bridge-dispatch.js'
import { handoffIO } from '../session-lifecycle.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway, STATE_DIR } from '../config.js'
import { handleHandoffIntercept } from '../commands/thread.js'
import { HANDOFF_TEMPLATE_DIR } from '../handoff-templates.js'

process.stderr.write = (() => true) as any

const mk = (id: string, name: string, threadId: string) => registry.set(id, {
  sessionId: id, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner',
} as any)

test('handoff tool: refuses a missing or empty file; with a file, answers first and then hands off that session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'))
  const orig = { ...handoffIO, send: gateway.send }
  const calls: Array<[string, string]> = []
  const sent: string[] = []
  handoffIO.killSession = (async (i: any) => { registry.delete(i.sessionId) }) as any
  handoffIO.doSpawnSession = (async (_t: string, _c?: string, _m?: string, o?: any) => { calls.push([o.handedOffFrom, o.artifact]); return { name: 'fresh', sessionId: 'ho-1b', threadId: 'ho-thread', url: '' } }) as any
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
    handoffIO.killSession = orig.killSession; handoffIO.doSpawnSession = orig.doSpawnSession
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

// Runs the `handoff` command in a fresh thread and returns the text sent to the live session.
async function requestText(msg: Record<string, unknown> = {}, selection?: { model: string; engine: any }): Promise<string> {
  const origSend = transport.sendOrQueue, origReact = gateway.react
  const delivered: any[] = []
  ;(transport as any).sendOrQueue = (_id: string, m: any) => { delivered.push(m) }
  ;(gateway as any).react = async () => {}
  mk('ho-3', 'pulse', 'ho-thread-3')
  registry.setThread('ho-thread-3', 'ho-3')
  try {
    await handleHandoffIntercept({ channelId: 'ho-thread-3', id: 'msg-1', isThread: true, content: 'handoff', ...msg } as any, selection)
    expect(delivered.length).toBe(1)
    return delivered[0].content
  } finally {
    ;(transport as any).sendOrQueue = origSend
    ;(gateway as any).react = origReact
    registry.delete('ho-3')
    registry.deleteThread('ho-thread-3')
  }
}

test('handoff command: with no template, the built-in request names whoever typed it, or "the user"', async () => {
  const text = await requestText({ authorUsername: 'dan' })
  expect(text).toStartWith('[system] dan asked you to hand off')
  expect(text).toContain('Open questions for dan;')
  expect(text).not.toContain('Sam')
  const anon = await requestText()
  expect(anon).toStartWith('[system] the user asked you to hand off')
  expect(anon).toContain('Open questions for the user;')
})

test('handoff command: departing.md replaces the built-in request, placeholders filled, unknown ones kept', async () => {
  const file = join(HANDOFF_TEMPLATE_DIR, 'departing.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  try {
    writeFileSync(file, '\n  {{requester}} {{session}} {{artifact}} {{model}} {{unknown}}\n\n')
    const text = await requestText({ authorUsername: 'dan' }, { model: 'claude-opus-5-5', engine: 'claude' })
    const [requester, session, artifact, model, unknown] = text.split(' ')
    expect([requester, session, model, unknown]).toEqual(['dan', 'pulse', 'claude-opus-5-5', '{{unknown}}'])
    expect(artifact).toMatch(new RegExp(`^${join(STATE_DIR, 'handoffs', 'pulse-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+\\.md$`))
  } finally {
    rmSync(file, { force: true })
  }
})

test('handoff command: a whitespace-only departing.md falls back to the built-in request', async () => {
  const file = join(HANDOFF_TEMPLATE_DIR, 'departing.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  try {
    writeFileSync(file, '  \n\t\n')
    const text = await requestText({ authorUsername: 'dan' })
    expect(text).toStartWith('[system] dan asked you to hand off')
    expect(text).toContain('Non-goals')
  } finally {
    rmSync(file, { force: true })
  }
})

test('handoff command: departing.md is re-read on every handoff, so an edit applies without a restart', async () => {
  const file = join(HANDOFF_TEMPLATE_DIR, 'departing.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  try {
    writeFileSync(file, 'first {{session}}')
    expect(await requestText()).toBe('first pulse')
    writeFileSync(file, 'second {{session}}')
    expect(await requestText()).toBe('second pulse')
  } finally {
    rmSync(file, { force: true })
  }
})

// Runs the `handoff` command and returns what the thread is told.
async function noticeText(): Promise<string> {
  const origSend = gateway.send
  const sent: string[] = []
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }
  try {
    await requestText({ authorUsername: 'dan' })
    await Bun.sleep(0)
    expect(sent.length).toBe(1)
    return sent[0]
  } finally {
    ;(gateway as any).send = origSend
  }
}

test('handoff command: the built-in thread notice says to peek before killing', async () => {
  const text = await noticeText()
  expect(text).toContain('`pulse`')
  expect(text).toContain('`peek` it before you `kill`')
})

test('handoff command: notice.md replaces the thread notice, re-read each time, placeholders filled', async () => {
  const file = join(HANDOFF_TEMPLATE_DIR, 'notice.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  try {
    writeFileSync(file, '🤝 {{session}} for {{requester}}')
    expect(await noticeText()).toBe('🤝 pulse for dan')
    writeFileSync(file, 'second {{session}}')
    expect(await noticeText()).toBe('second pulse')
    writeFileSync(file, '  \n')
    expect(await noticeText()).toContain('`peek` it before you `kill`')
  } finally {
    rmSync(file, { force: true })
  }
})

test('handoff command: a notice.md longer than one message is chunked, not dropped', async () => {
  const file = join(HANDOFF_TEMPLATE_DIR, 'notice.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  const origSend = gateway.send
  const sent: string[] = []
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }
  try {
    writeFileSync(file, 'word '.repeat(gateway.maxMessageLength))
    await requestText()
    await Bun.sleep(0)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every(t => t.length <= gateway.maxMessageLength)).toBe(true)
  } finally {
    ;(gateway as any).send = origSend
    rmSync(file, { force: true })
  }
})

test('handOff: deliverables, PR watches and the `handoff <model>` choice reach the successor; a second concurrent handoff is refused', async () => {
  const { handOff, handoffIO } = await import('../session-lifecycle.js')
  const { restoreWatches, getWatchesBySession, unwatchBySession } = await import('../pr-watch.js')
  const orig = { ...handoffIO }
  mk('ho-4', 'flint', 'ho-thread-4')
  const info = registry.get('ho-4')!
  Object.assign(info, { artifacts: ['pr#1'], description: 'd', handoffSelection: { model: 'gpt-5.6-sol', engine: 'codex' } })
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
    expect(spawned).toMatchObject({ handedOffFrom: 'flint', carryOver: { artifacts: ['pr#1'], description: 'd' }, model: 'gpt-5.6-sol', engine: 'codex' })
    expect(getWatchesBySession('ho-4')).toEqual([])
    expect(getWatchesBySession('ho-5').map(w => w.prUrl)).toEqual(['https://github.com/o/r/pull/9'])
  } finally {
    Object.assign(handoffIO, orig)
    unwatchBySession('ho-5'); registry.delete('ho-4'); registry.delete('ho-5')
  }
})

test('successor prompt: no arriving.md leaves the prompt as built without one', async () => {
  const { handoffArrival } = await import('../session-lifecycle.js')
  const { buildHandoffPrompt } = await import('../prompts/session.js')
  const p = { sessionId: 's-1', tmuxName: 'fresh', threadId: 'th-1', topic: 't', originFrom: 'flint', artifact: '/h.md' }
  const arrival = handoffArrival({ artifact: '/h.md' }, { from: 'flint', session: 'fresh', cwd: '/w', worktree: '', branch: '' })
  expect(arrival).toBeUndefined()
  expect(buildHandoffPrompt({ ...p, arrival })).toBe(buildHandoffPrompt(p))
  // Pinned to the bytes main produced before arriving.md could replace behavior lines.
  expect(buildHandoffPrompt(p)).toBe("You are fresh, a session created by handoff from flint. Topic: t\n\nYour chat thread chat_id is th-1. Your session_id is s-1.\nRead your handoff context from `/h.md`, then read your memory files.\nAfter reading the artifact, append a \"### Reception (by fresh)\" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.\nSend a greeting to your thread using reply(chat_id=th-1). In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.\nThen call set_description(session_id=\"s-1\", description=\"...\") to name this thread. Lead with the domain if one is clear. 5 words max. Rewrite it whenever your focus shifts — the thread name updates live.\nAfter greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.")
})

test('successor prompt: arriving.md is filled, placed after the context line, and replaces the built-in arrival behavior', async () => {
  const { handoffArrival } = await import('../session-lifecycle.js')
  const { buildHandoffPrompt } = await import('../prompts/session.js')
  const file = join(HANDOFF_TEMPLATE_DIR, 'arriving.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  try {
    writeFileSync(file, 'Arriving {{session}} from {{from}} via {{artifact}} on {{branch}} in {{cwd}}.\n')
    const arrival = handoffArrival({ artifact: '/h.md' }, { from: 'flint', session: 'fresh', cwd: '/w', worktree: '/w', branch: 'feat/x' })
    expect(arrival).toBe('Arriving fresh from flint via /h.md on feat/x in /w.')
    const lines = buildHandoffPrompt({ sessionId: 's-1', tmuxName: 'fresh', threadId: 'th-1', topic: 't', originFrom: 'flint', artifact: '/h.md', arrival }).split('\n')
    const at = lines.indexOf(arrival!)
    expect(lines[at - 1]).toStartWith('Read your handoff context from `/h.md`')
    // Plumbing stays.
    expect(lines[0]).toBe('You are fresh, a session created by handoff from flint. Topic: t')
    expect(lines).toContain('Your chat thread chat_id is th-1. Your session_id is s-1.')
    expect(lines[at + 1]).toBe('Send a greeting to your thread using reply(chat_id=th-1).')
    expect(lines[at + 2]).toStartWith('Then call set_description(session_id="s-1"')
    expect(lines.length).toBe(at + 3)
    // The built-in behavior it replaces does not leak through.
    const prompt = lines.join('\n')
    expect(prompt).not.toContain('### Reception')
    expect(prompt).not.toContain('In your greeting, include')
    expect(prompt).not.toContain('begin executing the Next action')
  } finally {
    rmSync(file, { force: true })
  }
})

test('templates live under <STATE_DIR>/actions/handoff', () => {
  expect(HANDOFF_TEMPLATE_DIR).toBe(join(STATE_DIR, 'actions', 'handoff'))
})

test('handoffSpawnOpts carries the predecessor\'s claude session id, and none for a Codex predecessor', async () => {
  const { handoffSpawnOpts } = await import('../session-lifecycle.js')
  mk('ho-6', 'flint', 'ho-thread-6')
  try {
    const info = registry.get('ho-6')!
    info.claudeSessionId = 'abc-123'
    expect(handoffSpawnOpts(info, '/h.md').handoffFromClaudeSessionId).toBe('abc-123')
    info.engine = 'codex'
    expect(handoffSpawnOpts(info, '/h.md').handoffFromClaudeSessionId).toBeUndefined()
  } finally {
    registry.delete('ho-6')
  }
})

test('arriving {{from_session}}: the predecessor\'s claude session id, empty when there is none (Codex)', async () => {
  const { handoffArrival } = await import('../session-lifecycle.js')
  const file = join(HANDOFF_TEMPLATE_DIR, 'arriving.md')
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  const vars = { from: 'flint', session: 'fresh', cwd: '/w', worktree: '', branch: '' }
  try {
    writeFileSync(file, 'ask-predecessor [{{from_session}}]')
    expect(handoffArrival({ handoffFromClaudeSessionId: 'pred-1' }, vars)).toBe('ask-predecessor [pred-1]')
    expect(handoffArrival({}, vars)).toBe('ask-predecessor []')
  } finally {
    rmSync(file, { force: true })
  }
})

test('arriving {{from_transcript}}: the predecessor\'s transcript path when it exists, empty when the id is unknown', async () => {
  const { handoffArrival } = await import('../session-lifecycle.js')
  const { projectsRoot } = await import('../usage.js')
  const projectDir = join(projectsRoot(), '-tmp-handoff-fixture')
  const transcript = join(projectDir, 'pred-1.jsonl')
  const file = join(HANDOFF_TEMPLATE_DIR, 'arriving.md')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
  const vars = { from: 'flint', session: 'fresh', cwd: '/w', worktree: '', branch: '' }
  try {
    writeFileSync(transcript, '{}\n')
    writeFileSync(file, 'transcript=[{{from_transcript}}]')
    expect(handoffArrival({ handoffFromClaudeSessionId: 'pred-1' }, vars)).toBe(`transcript=[${transcript}]`)
    expect(handoffArrival({ handoffFromClaudeSessionId: 'no-such-id' }, vars)).toBe('transcript=[]')
    expect(handoffArrival({}, vars)).toBe('transcript=[]')
  } finally {
    rmSync(file, { force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('successor prompt: with arriving.md and a predecessor, the fork recipe stays and the built-in behavior is gone', async () => {
  const { buildHandoffPrompt } = await import('../prompts/session.js')
  const p = { sessionId: 's-2', tmuxName: 'fresh', threadId: 'th-2', topic: 't', originFrom: 'flint', artifact: '/h.md', arrival: 'Run /workstream-orient.', hasPredecessor: true }
  const lines = buildHandoffPrompt(p).split('\n')
  const at = lines.indexOf('Run /workstream-orient.')
  expect(lines[at + 1]).toStartWith('If a question comes up that only flint can answer, ask a fork of it: spawn_session(fork_from="predecessor"')
  expect(lines[at + 2]).toBe('Send a greeting to your thread using reply(chat_id=th-2).')
  expect(lines.join('\n')).not.toMatch(/### Reception|In your greeting, include|begin executing the Next action/)
})

test('parseHandoffCommand: a note needs a separator; a chat line that starts with "handoff" is not a command', async () => {
  const { parseHandoffCommand } = await import('../router.js')
  expect(parseHandoffCommand('handoff')).toEqual({})
  expect(parseHandoffCommand('/handoff opus')).toEqual({ model: 'opus' })
  expect(parseHandoffCommand('handoff - So next session can listen to each of these PRs')).toEqual({ note: 'So next session can listen to each of these PRs' })
  expect(parseHandoffCommand('handoff opus: watch CI\nand refine')).toEqual({ model: 'opus', note: 'watch CI\nand refine' })
  expect(parseHandoffCommand('Handoff — x')).toEqual({ note: 'x' })
  expect(parseHandoffCommand('handoff -')).toEqual({})
  expect(parseHandoffCommand('handoff looks broken, why?')).toBeNull()
  expect(parseHandoffCommand('handoffs are slow')).toBeNull()
  expect(parseHandoffCommand('please handoff')).toBeNull()
})

test('handoff command: a note reaches the built-in request and {{note}}; none leaves no trace', async () => {
  const origSend = transport.sendOrQueue, origReact = gateway.react
  const delivered: any[] = []
  ;(transport as any).sendOrQueue = (_id: string, m: any) => { delivered.push(m) }
  ;(gateway as any).react = async () => {}
  mk('ho-6', 'pulse', 'ho-thread-6')
  registry.setThread('ho-thread-6', 'ho-6')
  const file = join(HANDOFF_TEMPLATE_DIR, 'departing.md')
  try {
    const run = (note?: string) => handleHandoffIntercept({ channelId: 'ho-thread-6', id: 'm', isThread: true, content: 'handoff', authorUsername: 'dan' } as any, undefined, note)
    await run('watch the PRs')
    expect(delivered[0].content).toContain('Their note for the next session: "watch the PRs".')
    expect(registry.get('ho-6')!.handoffNote).toBe('watch the PRs')
    await run()
    expect(delivered[1].content).not.toContain('note')
    expect(registry.get('ho-6')!.handoffNote).toBeUndefined()
    mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
    writeFileSync(file, 'note=[{{note}}]')
    await run('x y')
    expect(delivered[2].content).toBe('note=[x y]')
  } finally {
    rmSync(file, { force: true })
    ;(transport as any).sendOrQueue = origSend
    ;(gateway as any).react = origReact
    registry.delete('ho-6'); registry.deleteThread('ho-thread-6')
  }
})

test('handoff note: carried to the successor spawn, quoted in its prompt, and filled into arriving {{note}}', async () => {
  const { handoffSpawnOpts, handoffArrival } = await import('../session-lifecycle.js')
  const { buildHandoffPrompt } = await import('../prompts/session.js')
  mk('ho-7', 'flint', 'ho-thread-7')
  const info = registry.get('ho-7')!
  try {
    expect(handoffSpawnOpts(info, '/h.md').handoffNote).toBeUndefined()
    info.handoffNote = 'watch the PRs'
    const opts = handoffSpawnOpts(info, '/h.md')
    expect(opts.handoffNote).toBe('watch the PRs')
    const p = { sessionId: 's', tmuxName: 'fresh', threadId: 't', topic: 'x', originFrom: 'flint', artifact: '/h.md' }
    expect(buildHandoffPrompt({ ...p, note: opts.handoffNote })).toContain(`in the requester's words: "watch the PRs".`)
    expect(buildHandoffPrompt(p)).not.toContain("requester's words")
    mkdirSync(HANDOFF_TEMPLATE_DIR, { recursive: true })
    writeFileSync(join(HANDOFF_TEMPLATE_DIR, 'arriving.md'), 'n={{note}}')
    expect(handoffArrival(opts, { from: 'flint', session: 'fresh', cwd: '', worktree: '', branch: '' })).toBe('n=watch the PRs')
  } finally {
    rmSync(join(HANDOFF_TEMPLATE_DIR, 'arriving.md'), { force: true })
    registry.delete('ho-7')
  }
})
