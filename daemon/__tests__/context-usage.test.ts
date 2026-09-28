import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { engines } from '../engines/instances.js'
import { contextWindowOf } from '../../shared/constants.js'
import { lastContextTokens, projectDirName, projectsRoot } from '../usage.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import type { SessionInfo } from '../sessions.js'

const turn = (u: Record<string, number>, extra: Record<string, unknown> = {}, model = 'claude-opus-4-6') =>
  JSON.stringify({ ...extra, message: { role: 'assistant', model, usage: u } }) + '\n'

describe('lastContextTokens', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const put = (body: string) => { const f = join(dir, 't.jsonl'); writeFileSync(f, body); return f }

  test('last model turn: input + cache create + cache read, not output, not earlier turns', () => {
    const f = put(turn({ input_tokens: 1, cache_read_input_tokens: 1000, output_tokens: 5 }) + turn({ input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 999 }))
    expect(lastContextTokens(f)).toBe(3210)
  })
  test('skips synthetic and sidechain lines and lines without usage', () => {
    const f = put(turn({ input_tokens: 7, cache_read_input_tokens: 100 })
      + turn({ input_tokens: 1, cache_read_input_tokens: 999999 }, {}, '<synthetic>')
      + turn({ input_tokens: 1, cache_read_input_tokens: 888888 }, { isSidechain: true })
      + '{"type":"user","message":{"role":"user"}}\n{not json "usage"\n')
    expect(lastContextTokens(f)).toBe(107)
  })
  test('null: missing file, no usage anywhere', () => {
    expect(lastContextTokens(join(dir, 'nope.jsonl'))).toBeNull()
    expect(lastContextTokens(put('{"type":"user"}\n'))).toBeNull()
  })
})

test('contextWindowOf: [1m] is 1M, other known models 200k, anything unrecognised is null', () => {
  expect([contextWindowOf('claude-opus-4-6[1m]'), contextWindowOf('claude-sonnet-5'), contextWindowOf('unknown'), contextWindowOf('sonnet'), contextWindowOf('gpt-6-astra[1m]'), contextWindowOf(undefined)])
    .toEqual([1_000_000, 200_000, null, null, null, null])
})

describe('ClaudeEngine.usage', () => {
  let tmux: FakeTmux
  let seq = 0
  let name: string // a fresh tmux name per test: the cross-check throttle is keyed by it
  const SID = 'ctx-usage-0000-4000-8000-000000000001'
  beforeEach(() => { tmux = withFakeTmux(); name = `ctx-${++seq}` })
  afterEach(() => { tmux.restore() })

  const info = (model: string | undefined, claudeSessionId: string | undefined = SID) =>
    ({ sessionId: 's1', tmuxName: name, claudeSessionId, sessionMetadata: model ? { model } : undefined }) as unknown as SessionInfo
  const transcript = (sid: string, body: string, pid = '1') => {
    tmux.seedClaudeSession(pid, sid)
    appendFileSync(join(projectsRoot(), projectDirName('/tmp/hydra-t3-project'), `${sid}.jsonl`), body)
  }
  const seed = (body: string, pane?: string) => { transcript(SID, body); if (pane !== undefined) tmux.pane(name, pane) }
  const paneWith = (pct: number) => `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  cedar ctx:${pct}%\n`
  const captures = () => tmux.calls().filter(c => c.startsWith('capture-pane')).length

  test('transcript tokens over the [1m] window; usedTokens and window are reported', () => {
    seed(turn({ input_tokens: 6, cache_read_input_tokens: 597_830 }), paneWith(60))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))).toEqual({ usedTokens: 597_836, contextWindow: 1_000_000, percent: 60 })
  })
  test('the same tokens on a non-[1m] model are a different percent (capped at 100)', () => {
    seed(turn({ input_tokens: 100, cache_read_input_tokens: 49_900 }))
    expect(engines.claude.usage(info('claude-sonnet-5'))?.percent).toBe(25)
    seed(turn({ input_tokens: 300_000 }))
    expect(engines.claude.usage(info('claude-sonnet-5'))?.percent).toBe(100)
  })
  test('unknown or unrecognised model, or no transcript, falls back to the pane number; nothing anywhere is null', () => {
    seed(turn({ input_tokens: 500_000 }), paneWith(42))
    expect(engines.claude.usage(info(undefined))).toEqual({ usedTokens: 0, contextWindow: 0, percent: 42 })
    expect(engines.claude.usage(info('sonnet'))?.percent).toBe(42) // an alias is not a known model id: no guessed window
    expect(engines.claude.usage(info('claude-sonnet-5[1m]', 'no-such-session'))?.percent).toBe(42)
    tmux.pane(name, 'no footer')
    expect(engines.claude.usage(info(undefined))).toBeNull()
  })
  test('after /clear the status file\'s session id wins over the stale stored one', () => {
    const NEW = 'ctx-usage-0000-4000-8000-000000000002'
    seed(turn({ input_tokens: 700_000 }), paneWith(5))                 // the old, cleared conversation
    transcript(NEW, turn({ input_tokens: 50_000 }), '2')               // the new one
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'sessions'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: NEW, status: 'idle', tmux: `${name}:@1.%1` }))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))?.percent).toBe(5)   // stored id says SID (70%)
  })
  test('a transcript/pane disagreement of 2+ points is logged; agreement is silent', () => {
    const logs: string[] = []
    const orig = process.stderr.write
    process.stderr.write = ((c: any) => { logs.push(String(c)); return true }) as any
    try {
      seed(turn({ input_tokens: 100_000 }), paneWith(10))
      engines.claude.usage(info('claude-sonnet-5[1m]'))
      expect(logs.filter(l => l.includes('context %'))).toEqual([])
      name = `ctx-${++seq}`; seed(turn({ input_tokens: 100_000 }), paneWith(30))
      engines.claude.usage(info('claude-sonnet-5[1m]'))
      expect(logs.join('')).toContain(`context %: ${name} transcript says 10% (100000/1000000), pane says 30%`)
    } finally { process.stderr.write = orig }
  })
  test('steady state reads the pane once per check window, not once per call', () => {
    seed(turn({ input_tokens: 100_000 }), paneWith(10))
    for (let i = 0; i < 5; i++) engines.claude.usage(info('claude-sonnet-5[1m]'))
    expect(captures()).toBe(1)
  })
})
