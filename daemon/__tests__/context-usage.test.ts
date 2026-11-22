import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { engines } from '../../engines/instances.js'
import { contextWindowOf } from '../../shared/constants.js'
import { lastContextTurn, transcriptContext, projectDirName, projectsRoot } from '../../infra/usage.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import type { SessionInfo } from '../sessions.js'

const turn = (u: Record<string, number>, extra: Record<string, unknown> = {}, model = 'claude-sonnet-5') =>
  JSON.stringify({ ...extra, message: { role: 'assistant', model, usage: u } }) + '\n'

describe('lastContextTurn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const put = (body: string) => { const f = join(dir, 't.jsonl'); writeFileSync(f, body); return f }
  const tokens = (f: string) => lastContextTurn(f)?.tokens

  test('last model turn: input + cache create + cache read, not output, not earlier turns; names its model', () => {
    const f = put(turn({ input_tokens: 1, cache_read_input_tokens: 1000, output_tokens: 5 }) + turn({ input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 999 }))
    expect(lastContextTurn(f)).toEqual({ tokens: 3210, model: 'claude-sonnet-5' })
  })
  test('skips synthetic and sidechain lines and lines without usage', () => {
    const f = put(turn({ input_tokens: 7, cache_read_input_tokens: 100 })
      + turn({ input_tokens: 1, cache_read_input_tokens: 999999 }, {}, '<synthetic>')
      + turn({ input_tokens: 1, cache_read_input_tokens: 888888 }, { isSidechain: true })
      + '{"type":"user","message":{"role":"user"}}\n{not json "usage"\n')
    expect(tokens(f)).toBe(107)
  })
  test('null: missing file, no usage anywhere', () => {
    expect(lastContextTurn(join(dir, 'nope.jsonl'))).toBeNull()
    expect(lastContextTurn(put('{"type":"user"}\n'))).toBeNull()
  })
  test('a real usage shape (Sonnet 5.5, the nested iterations and 1h cache fields) counts the three input fields once', () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 178, cache_read_input_tokens: 149994, output_tokens: 96,
      cache_creation: { ephemeral_1h_input_tokens: 178, ephemeral_5m_input_tokens: 0 },
      iterations: [{ input_tokens: 2, output_tokens: 96, cache_read_input_tokens: 149994, cache_creation_input_tokens: 178 }] }
    expect(tokens(put(turn(usage as any, {}, 'claude-sonnet-5-5')))).toBe(150174)
  })
  test('a latest turn longer than the tail window is still read, never null; a turn older than it too', () => {
    const big = { type: 'assistant', blob: 'x'.repeat(600 * 1024), message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 5, cache_read_input_tokens: 90_000 } } }
    expect(tokens(put(JSON.stringify(big) + '\n'))).toBe(90_005)
    const older = turn({ input_tokens: 3, cache_read_input_tokens: 40_000 }) + ('{"type":"progress","pad":"' + 'y'.repeat(900 * 1024) + '"}\n')
    expect(tokens(put(older))).toBe(40_003)
  })
})

describe('transcriptContext', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const at = (tokens: number, model: string, launch: string | undefined) => {
    const f = join(dir, 't.jsonl'); writeFileSync(f, turn({ input_tokens: tokens }, {}, model))
    return transcriptContext(f, launch)
  }
  test('1M and 200k windows from the launch model: 150k is 15% or 75%', () => {
    expect(at(150_000, 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]')).toMatchObject({ percent: 15, contextWindow: 1_000_000, switched: false })
    expect(at(150_000, 'claude-sonnet-5-5', 'claude-sonnet-5-5')).toMatchObject({ percent: 75, contextWindow: 200_000, switched: false })
  })
  test('a turn on another model is a /model switch: past 200k the window is at least 1M, below it the launch window stands', () => {
    expect(at(300_000, 'claude-opus-4-6', 'claude-sonnet-5-5')).toMatchObject({ switched: true, contextWindow: 1_000_000, percent: 30 })
    expect(at(100_000, 'claude-opus-4-6', 'claude-sonnet-5-5')).toMatchObject({ switched: true, contextWindow: 200_000, percent: 50 })
  })
  test('a dated id of the same model is no switch; 5 and 5-5 are different models', () => {
    expect(at(100_000, 'claude-sonnet-5-20260101', 'claude-sonnet-5[1m]')).toMatchObject({ switched: false, percent: 10 })
    expect(at(100_000, 'claude-sonnet-5-5', 'claude-sonnet-5')).toMatchObject({ switched: true })
  })
  test('more tokens than the launch window holds means the window is not the launch one, even on the same model', () => {
    expect(at(250_000, 'claude-sonnet-5', 'claude-sonnet-5')).toMatchObject({ switched: true, contextWindow: 1_000_000, percent: 25 })
  })
  test('null when the launch model is unknown or the transcript has no model turn', () => {
    expect(at(1000, 'claude-sonnet-5-5', undefined)).toBeNull()
    expect(transcriptContext(join(dir, 'nope.jsonl'), 'claude-sonnet-5-5')).toBeNull()
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
  const footer = (line: string) => `text\n${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  ${line}\n`
  const paneWith = (pct: number) => footer(`cedar ctx:${pct}%`)
  const gsdPaneWith = (pct: number) => footer(`Opus 5.5 │ hydra ${'█'.repeat(Math.floor(pct / 10)).padEnd(10, '░')} ${pct}%`)
  const captures = () => tmux.calls().filter(c => c.startsWith('capture-pane')).length

  test('transcript tokens over the [1m] window; usedTokens and window are reported', () => {
    seed(turn({ input_tokens: 6, cache_read_input_tokens: 597_830 }), paneWith(60))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))).toEqual({ usedTokens: 597_836, contextWindow: 1_000_000, percent: 60 })
  })
  test('the same tokens on a non-[1m] model are a different percent; past 200k the window cannot be 200k', () => {
    seed(turn({ input_tokens: 100, cache_read_input_tokens: 49_900 }))
    expect(engines.claude.usage(info('claude-sonnet-5'))?.percent).toBe(25)
    seed(turn({ input_tokens: 300_000 }))
    expect(engines.claude.usage(info('claude-sonnet-5'))?.percent).toBe(30)   // pane absent: the 1M floor, not 150%
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
  test('a bar footer is never compared (it may be rescaled, as GSD\'s is) but still serves as the fallback', () => {
    const logs: string[] = []
    const orig = process.stderr.write
    process.stderr.write = ((c: any) => { logs.push(String(c)); return true }) as any
    try {
      seed(turn({ input_tokens: 500_000 }), gsdPaneWith(60))   // raw 50% reads ~60% on GSD
      expect(engines.claude.usage(info('claude-sonnet-5[1m]'))?.percent).toBe(50)
      expect(logs.filter(l => l.includes('context %'))).toEqual([])
      expect(engines.claude.usage(info(undefined))?.percent).toBe(60)
    } finally { process.stderr.write = orig }
  })
  test('a transcript line past the 256 KB tail is read, never replaced by the pane number', () => {
    const big = JSON.stringify({ pad: 'z'.repeat(400 * 1024), message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 100_000 } } }) + '\n'
    seed(big, paneWith(77))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))).toMatchObject({ percent: 10, usedTokens: 100_000 })
  })
  test('after a /model switch the pane\'s ctx: number is the reading; a bar footer is not', () => {
    seed(turn({ input_tokens: 100_000 }, {}, 'claude-opus-4-6'), paneWith(42))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))?.percent).toBe(42)
    name = `ctx-${++seq}`; seed(turn({ input_tokens: 100_000 }, {}, 'claude-opus-4-6'), gsdPaneWith(60))
    expect(engines.claude.usage(info('claude-sonnet-5[1m]'))?.percent).toBe(10)
  })
  test('steady state reads the pane once per check window, not once per call', () => {
    seed(turn({ input_tokens: 100_000 }), paneWith(10))
    for (let i = 0; i < 5; i++) engines.claude.usage(info('claude-sonnet-5[1m]'))
    expect(captures()).toBe(1)
  })
})
